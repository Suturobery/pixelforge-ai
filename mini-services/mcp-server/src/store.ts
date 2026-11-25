/**
 * PixelForge AI — persistent allowlist store + audit log (v3.1 §5.5).
 *
 * Files (under PF_MCP_DATA_DIR, default <repo>/db):
 *   mcp-clients.json  — the client allowlist. Bearer tokens are stored ONLY
 *                       as SHA-256 hashes; plaintext never touches disk and
 *                       is never written to any log.
 *   mcp-ops.jsonl     — append-only audit log: who/when/tool/args-hash/
 *                       result/duration (§5.5), plus security events
 *                       (bad tokens, expired pairings, rate-limit trips).
 *
 * Writes are atomic (tmp + rename) so a crash never corrupts the allowlist.
 */

import { mkdirSync, readFileSync, renameSync, appendFileSync, existsSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AuditEntry, PairedClient, PendingPairing, Tier } from './types';

export interface StoreOptions {
  dataDir?: string;
  auditFile?: string;
}

const MAX_AUDIT_MEMORY = 500;
const MAX_AUDIT_FILE_BYTES = 2 * 1024 * 1024;
const RETAIN_AUDIT_FILE_BYTES = 1024 * 1024;

export type BrainTaskStatus = 'pending' | 'claimed' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BrainTask {
  id: string;
  title: string;
  detail: string;
  status: BrainTaskStatus;
  claimedBy: string | null;
  /** stable owner identity — display names are NOT unique across agents */
  claimedByClient: string | null;
  /** lease anchor: refreshed by progress updates so silent agents get requeued */
  claimedAt: number | null;
  result: string | null;
  /** bounded progress note from the owning agent (claimed/running) */
  progress: string | null;
  /** groups tasks queued by one plan (replace/append semantics + UI) */
  planId: string | null;
  /** dedupe key — re-pushing the same plan step never duplicates work */
  idempotencyKey: string | null;
  /** editor stateHash at claim time — completion-verification anchor */
  stateHashAtClaim: string | null;
  /** editor stateHash at finish time */
  stateHashAtFinish: string | null;
  /** true when the document actually changed between claim and successful finish */
  verified: boolean | null;
  /** project the task targets (queued from the Brain panel) — claim/continue
   *  is gated against the editor's ACTIVE project so work stays in place. */
  targetProjectKey: string | null;
  targetProjectName: string | null;
  /** Human review of a completed task. The selected frame is a live project
   * view; reviewStateHash records which document state was approved. */
  reviewStatus: 'approved' | 'needs_changes' | null;
  reviewClipId: string | null;
  reviewFrameIndex: number | null;
  reviewStateHash: string | null;
  reviewedAt: number | null;
}

const BRAIN_STATUSES: readonly BrainTaskStatus[] = ['pending', 'claimed', 'running', 'done', 'failed', 'cancelled'];

/** Normalize a persisted task: fill v2 fields and coerce unknown statuses so
 * pre-phase-4 board files load cleanly (fail-open to pending). */
function normalizeBrainTask(raw: Partial<BrainTask>): BrainTask {
  const status = BRAIN_STATUSES.includes(raw.status as BrainTaskStatus) ? (raw.status as BrainTaskStatus) : 'pending';
  return {
    id: String(raw.id ?? ''),
    title: String(raw.title ?? '').slice(0, 200),
    detail: String(raw.detail ?? '').slice(0, 2000),
    status,
    claimedBy: typeof raw.claimedBy === 'string' ? raw.claimedBy.slice(0, 80) : null,
    claimedByClient: typeof raw.claimedByClient === 'string' ? raw.claimedByClient.slice(0, 80) : null,
    claimedAt: typeof raw.claimedAt === 'number' ? raw.claimedAt : null,
    result: typeof raw.result === 'string' ? raw.result.slice(0, 2000) : null,
    progress: typeof raw.progress === 'string' ? raw.progress.slice(0, 200) : null,
    planId: typeof raw.planId === 'string' ? raw.planId.slice(0, 80) : null,
    idempotencyKey: typeof raw.idempotencyKey === 'string' ? raw.idempotencyKey.slice(0, 120) : null,
    stateHashAtClaim: typeof raw.stateHashAtClaim === 'string' ? raw.stateHashAtClaim.slice(0, 64) : null,
    stateHashAtFinish: typeof raw.stateHashAtFinish === 'string' ? raw.stateHashAtFinish.slice(0, 64) : null,
    targetProjectKey: typeof raw.targetProjectKey === 'string' ? raw.targetProjectKey.slice(0, 160) : null,
    targetProjectName: typeof raw.targetProjectName === 'string' ? raw.targetProjectName.slice(0, 120) : null,
    verified: typeof raw.verified === 'boolean' ? raw.verified : null,
    reviewStatus: raw.reviewStatus === 'approved' || raw.reviewStatus === 'needs_changes' ? raw.reviewStatus : null,
    reviewClipId: typeof raw.reviewClipId === 'string' ? raw.reviewClipId.slice(0, 120) : null,
    reviewFrameIndex: typeof raw.reviewFrameIndex === 'number' && Number.isInteger(raw.reviewFrameIndex) && raw.reviewFrameIndex >= 0 && raw.reviewFrameIndex < 4096 ? raw.reviewFrameIndex : null,
    reviewStateHash: typeof raw.reviewStateHash === 'string' ? raw.reviewStateHash.slice(0, 64) : null,
    reviewedAt: typeof raw.reviewedAt === 'number' && Number.isFinite(raw.reviewedAt) ? raw.reviewedAt : null,
  };
}

export class McpStore {
  /** claimed tasks older than this are requeued (crashed-agent recovery) */
  readonly claimTimeoutMs: number;

  readonly dataDir: string;
  private readonly clientsFile: string;
  private readonly auditPath: string;
  private clients: Map<string, PairedClient> = new Map();
  private pairings: PendingPairing[] = [];
  private auditMemory: AuditEntry[] = [];
  private auditSeq = 0;

  constructor(opts: StoreOptions & { claimTimeoutMs?: number } = {}) {
    this.claimTimeoutMs = opts.claimTimeoutMs ?? Number(process.env.PF_BRAIN_CLAIM_TIMEOUT_MS ?? 600_000);
    this.dataDir = opts.dataDir ?? process.env.PF_MCP_DATA_DIR ?? path.resolve(import.meta.dir, '../../../db');
    mkdirSync(this.dataDir, { recursive: true });
    this.clientsFile = path.join(this.dataDir, 'mcp-clients.json');
    this.auditPath = opts.auditFile ?? path.join(this.dataDir, 'mcp-ops.jsonl');
    this.loadBrainTasks();
    this.loadClients();
    // Task 13a: token-hash allowlist + audit log are sensitive — restrict to
    // the owner (best-effort; no-op on Windows where DPAPI/ACLs apply).
    this.restrict(this.clientsFile);
    this.restrict(this.auditPath);
  }

  private restrict(file: string): void {
    if (process.platform === 'win32') return;
    try {
      chmodSync(file, 0o600);
    } catch {
      /* file may not exist yet — restricted again on every write */
    }
  }

  // ---------------------------------------------------------------- clients

  private loadClients(): void {
    try {
      if (!existsSync(this.clientsFile)) return;
      const raw = JSON.parse(readFileSync(this.clientsFile, 'utf8')) as { clients?: PairedClient[] };
      for (const c of raw.clients ?? []) {
        if (typeof c?.clientId === 'string' && typeof c?.tokenHash === 'string') {
          this.clients.set(c.clientId, c);
        }
      }
    } catch (err) {
      // A corrupt allowlist must not fail the server open — start empty and
      // overwrite on the next mutation (tokens are re-pairable).
      console.error('[mcp] allowlist load failed, starting empty:', err instanceof Error ? err.message : err);
      this.clients = new Map();
    }
  }

  private persistClients(): void {
    const tmp = this.clientsFile + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: 1, clients: [...this.clients.values()] }, null, 2));
    renameSync(tmp, this.clientsFile);
    this.restrict(this.clientsFile);
  }

  listClients(): PairedClient[] {
    return [...this.clients.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  findClientByTokenHash(tokenHash: string): PairedClient | null {
    for (const c of this.clients.values()) {
      if (c.tokenHash === tokenHash) return c;
    }
    return null;
  }

  putClient(client: PairedClient): void {
    this.clients.set(client.clientId, client);
    this.persistClients();
  }

  revokeClient(clientId: string): PairedClient | null {
    const c = this.clients.get(clientId);
    if (!c) return null;
    c.revoked = true;
    this.persistClients();
    return c;
  }

  /**
   * Forget a revoked pairing from the allowlist. Active clients must be
   * revoked first, so the UI cannot accidentally turn a live credential into
   * an invisible credential.
   */
  removeRevokedClient(clientId: string): 'removed' | 'active' | 'not_found' {
    const c = this.clients.get(clientId);
    if (!c) return 'not_found';
    if (!c.revoked) return 'active';
    this.clients.delete(clientId);
    this.persistClients();
    return 'removed';
  }

  touchClient(clientId: string): void {
    const c = this.clients.get(clientId);
    if (c && !c.revoked) {
      c.lastSeen = new Date().toISOString();
      this.persistClients();
    }
  }

  // --------------------------------------------------------------- pairing

  addPairing(p: PendingPairing): void {
    this.pairings.push(p);
    // opportunistic GC of dead pairings
    const now = Date.now();
    this.pairings = this.pairings.filter((x) => !x.used && now < x.expiresAt).concat(p);
  }

  /**
   * Atomically consume a pairing token: returns the tier when the token is
   * valid, unused and unexpired; null otherwise. Marking `used` first makes
   * replay impossible even under concurrent calls.
   */
  consumePairing(tokenHash: string): { tier: Tier } | null {
    const now = Date.now();
    const p = this.pairings.find((x) => x.tokenHash === tokenHash);
    if (!p || p.used || now >= p.expiresAt) return null;
    p.used = true;
    return { tier: p.tier };
  }

  cancelPairing(tokenHash: string): boolean {
    const before = this.pairings.length;
    this.pairings = this.pairings.filter((x) => x.tokenHash !== tokenHash);
    return this.pairings.length < before;
  }

  findPairingByHash(tokenHash: string): PendingPairing | null {
    return this.pairings.find((x) => x.tokenHash === tokenHash) ?? null;
  }

  // ------------------------------------------------------------------ audit

  audit(entry: Omit<AuditEntry, 'ts'> & { ts?: string }): void {
    const full: AuditEntry = { ts: new Date().toISOString(), ...entry } as AuditEntry;
    this.auditMemory.push(full);
    if (this.auditMemory.length > MAX_AUDIT_MEMORY) {
      this.auditMemory.splice(0, this.auditMemory.length - MAX_AUDIT_MEMORY);
    }
    try {
      appendFileSync(this.auditPath, JSON.stringify(full) + '\n');
      this.trimAuditFile();
    } catch (err) {
      // best-effort: never break a tool call because the audit file failed
      console.error('[mcp] audit append failed:', err instanceof Error ? err.message : err);
    }
  }

  // ---- second-brain task board -------------------------------------------
  // Agent-executable work items queued by the Groq orchestrator. In-memory
  // ring with best-effort JSON persistence in the data dir (survives
  // restarts; on conflict the newest file wins).

  brainTasks: BrainTask[] = [];
  private get brainFile(): string { return path.join(this.dataDir, 'brain-tasks.json'); }

  private loadBrainTasks(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.brainFile, 'utf8')) as BrainTask[];
      this.brainTasks = Array.isArray(parsed) ? parsed.map(normalizeBrainTask) : [];
    } catch (err) {
      if (existsSync(this.brainFile)) {
        // never silently destroy a corrupted board — quarantine it
        const quarantine = this.brainFile.replace('.json', '.corrupt-' + Date.now() + '.json');
        try {
          renameSync(this.brainFile, quarantine);
          console.error('[pf-mcp] brain-tasks.json was CORRUPT — quarantined to', quarantine, String(err).slice(0, 120));
        } catch {
          console.error('[pf-mcp] brain-tasks.json unreadable AND quarantine failed — starting empty');
        }
      }
      this.brainTasks = [];
    }
  }

  private saveBrainTasks(): void {
    try {
      // atomic write (tmp + rename) — a crash must never corrupt the board
      const tmp = this.brainFile + '.tmp-' + Date.now();
      writeFileSync(tmp, JSON.stringify(this.brainTasks, null, 2));
      renameSync(tmp, this.brainFile);
    } catch {
      // best-effort: the board is advisory state, never blocks tool calls
    }
  }

  /** requeue claimed/running tasks whose agent went silent past the lease */
  private sweepStaleClaims(): number {
    const now = Date.now();
    let recovered = 0;
    for (const t of this.brainTasks) {
      if (
        (t.status === 'claimed' || t.status === 'running') &&
        typeof t.claimedAt === 'number' &&
        now - t.claimedAt > this.claimTimeoutMs
      ) {
        t.status = 'pending';
        t.claimedBy = null;
        t.claimedByClient = null;
        t.claimedAt = null;
        t.progress = null;
        recovered++;
      }
    }
    if (recovered > 0) this.saveBrainTasks();
    return recovered;
  }

  /**
   * Queue tasks for IDE agents (shared-Brain phase 4).
   * `replacePending` is EXPLICIT: without it, a new plan APPENDS and never
   * destroys unrelated pending work. `idempotencyKey` dedupes re-pushed plan
   * steps against still-active/completed tasks (failed/cancelled re-create).
   */
  brainPush(
    tasks: Array<{ title: string; detail: string; idempotencyKey?: string; targetProject?: { key: string; name: string } | null }>,
    opts: { replacePending?: boolean; planId?: string | null } = {},
  ): BrainTask[] {
    if (!Array.isArray(this.brainTasks)) this.loadBrainTasks();
    this.sweepStaleClaims();
    const planId = typeof opts.planId === 'string' && opts.planId.trim() ? opts.planId.slice(0, 80) : null;
    const incoming = (tasks ?? []).slice(0, 20);
    const created: BrainTask[] = [];
    for (const t of incoming) {
      const key = typeof t.idempotencyKey === 'string' && t.idempotencyKey.trim() ? t.idempotencyKey.trim().slice(0, 120) : null;
      if (key && this.brainTasks.some((x) => x.idempotencyKey === key && x.status !== 'failed' && x.status !== 'cancelled')) {
        continue; // duplicate of a still-active/completed task — skip
      }
      created.push({
        id: 'bt_' + Date.now().toString(36) + '_' + created.length + '_' + Math.random().toString(36).slice(2, 8),
        title: String(t.title ?? '').slice(0, 200),
        detail: String(t.detail ?? '').slice(0, 2000),
        status: 'pending',
        claimedBy: null,
        claimedByClient: null,
        claimedAt: null,
        result: null,
        progress: null,
        planId,
        idempotencyKey: key,
        stateHashAtClaim: null,
        stateHashAtFinish: null,
        verified: null,
        targetProjectKey:
          t.targetProject && typeof t.targetProject.key === 'string' && t.targetProject.key.trim()
            ? t.targetProject.key.slice(0, 160)
            : null,
        targetProjectName:
          t.targetProject && typeof t.targetProject.name === 'string'
            ? t.targetProject.name.slice(0, 120)
            : null,
        reviewStatus: null,
        reviewClipId: null,
        reviewFrameIndex: null,
        reviewStateHash: null,
        reviewedAt: null,
      });
    }
    // replace mode: a new plan supersedes ALL still-pending items (history stays);
    // append mode (default): existing tasks are untouched
    const rest = this.brainTasks.filter((t) => (opts.replacePending ? t.status !== 'pending' : true));
    this.brainTasks = [...created, ...rest].slice(0, 100);
    this.saveBrainTasks();
    return created;
  }

  brainList(): BrainTask[] {
    this.sweepStaleClaims();
    return this.brainTasks;
  }

  /** Only the editor control plane can record a human verdict. The server
   * checks the task and active project before persisting the review. */
  brainReview(
    id: string,
    verdict: 'approved' | 'needs_changes',
    clipId: string,
    frameIndex: number,
    currentProjectKey: string | null,
    stateHash: string | null,
  ): BrainTask | null {
    const task = this.brainTasks.find((item) => item.id === id && item.status === 'done');
    if (!task || !task.targetProjectKey || task.targetProjectKey !== currentProjectKey) return null;
    if (!clipId || clipId.length > 120 || !Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= 4096) return null;
    task.reviewStatus = verdict;
    task.reviewClipId = clipId;
    task.reviewFrameIndex = frameIndex;
    task.reviewStateHash = typeof stateHash === 'string' ? stateHash.slice(0, 64) : null;
    task.reviewedAt = Date.now();
    this.saveBrainTasks();
    return task;
  }

  /** Project-gated claim result: `task` when claimed, `blockedBy` when the
   *  task targets a DIFFERENT project than the one currently active in the
   *  editor (work must stay in its queued project). */
  brainClaim(
    id: string,
    claimedBy: string,
    claimedByClient: string,
    stateHash?: string | null,
    currentProject?: { key: string; name: string } | null,
  ): { task: BrainTask | null; blockedBy: BrainTask | null } {
    if (!Array.isArray(this.brainTasks)) this.loadBrainTasks();
    this.sweepStaleClaims();
    const t = this.brainTasks.find((x) => x.id === id && x.status === 'pending');
    if (!t) return { task: null, blockedBy: null };
    if (
      t.targetProjectKey &&
      currentProject?.key !== t.targetProjectKey
    ) {
      return { task: null, blockedBy: t };
    }
    t.status = 'claimed';
    t.claimedBy = claimedBy.slice(0, 80);
    t.claimedByClient = claimedByClient.slice(0, 80);
    t.claimedAt = Date.now();
    t.progress = null;
    // completion-verification anchor: the document fingerprint at claim time
    t.stateHashAtClaim = typeof stateHash === 'string' ? stateHash.slice(0, 64) : null;
    t.stateHashAtFinish = null;
    t.verified = null;
    this.saveBrainTasks();
    return { task: t, blockedBy: null };
  }

  /** Active project targets for edits made by this task's authenticated client. */
  brainClaimedTargets(clientId: string): Array<{ key: string; name: string }> {
    return this.brainList().flatMap((task) =>
      (task.status === 'claimed' || task.status === 'running') &&
      task.claimedByClient === clientId && task.targetProjectKey
        ? [{ key: task.targetProjectKey, name: task.targetProjectName ?? 'target project' }]
        : [],
    );
  }

  /** Artist confirmation for LEGACY tasks (queued before project targeting
   *  existed): binds the task to the editor's current project. */
  brainSetTarget(id: string, project: { key: string; name: string } | null): BrainTask | null {
    if (!Array.isArray(this.brainTasks)) this.loadBrainTasks();
    const t = this.brainTasks.find((x) => x.id === id);
    if (!t || t.targetProjectKey) return t && t.targetProjectKey ? t : null;
    t.targetProjectKey = project && typeof project.key === 'string' && project.key.trim() ? project.key.slice(0, 160) : null;
    t.targetProjectName = project && typeof project.name === 'string' ? project.name.slice(0, 120) : null;
    this.saveBrainTasks();
    return t;
  }

  /** Owner-only bounded progress note; first update moves claimed → running
   * and refreshes the claim lease (progress doubles as a heartbeat). */
  brainProgress(
    id: string,
    claimedByClient: string,
    progress: string,
    currentProject?: { key: string; name: string } | null,
  ): { task: BrainTask | null; blockedBy: BrainTask | null } {
    if (!Array.isArray(this.brainTasks)) this.loadBrainTasks();
    this.sweepStaleClaims();
    const t = this.brainTasks.find(
      (x) => x.id === id && (x.status === 'claimed' || x.status === 'running') && x.claimedByClient === claimedByClient,
    );
    if (!t) return { task: null, blockedBy: null };
    if (t.targetProjectKey && currentProject?.key !== t.targetProjectKey) {
      return { task: null, blockedBy: t };
    }
    t.status = 'running';
    t.progress = String(progress ?? '').slice(0, 200);
    t.claimedAt = Date.now();
    this.saveBrainTasks();
    return { task: t, blockedBy: null };
  }

  /**
   * Cancel a task. With `requesterClient` (an MCP agent) only the OWNER may
   * cancel its claimed/running work. Without one (editor ctrl = the human)
   * any unfinished task may be cancelled — human authority outranks agents.
   * Finished tasks are immutable.
   */
  brainCancel(id: string, requesterClient?: string): BrainTask | null {
    if (!Array.isArray(this.brainTasks)) this.loadBrainTasks();
    this.sweepStaleClaims();
    const t = this.brainTasks.find((x) => x.id === id);
    if (!t || t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') return null;
    if (requesterClient) {
      const owned = (t.status === 'claimed' || t.status === 'running') && t.claimedByClient === requesterClient;
      if (!owned) return null;
    }
    t.status = 'cancelled';
    t.progress = null;
    t.claimedBy = null;
    t.claimedByClient = null;
    t.claimedAt = null;
    this.saveBrainTasks();
    return t;
  }

  brainFinish(
    id: string,
    claimedByClient: string,
    ok: boolean,
    result: string,
    stateHash?: string | null,
    currentProject?: { key: string; name: string } | null,
  ): { task: BrainTask | null; blockedBy: BrainTask | null } {
    if (!Array.isArray(this.brainTasks)) this.loadBrainTasks();
    this.sweepStaleClaims();
    const t = this.brainTasks.find(
      (x) =>
        (x.status === 'claimed' || x.status === 'running') &&
        x.claimedByClient === claimedByClient &&
        x.id === id,
    );
    if (!t) return { task: null, blockedBy: null };
    if (t.targetProjectKey && currentProject?.key !== t.targetProjectKey) {
      // continuation gate: the claim lease is RELEASED so the task returns to
      // the board for the correct project context to claim it again
      t.status = 'pending';
      t.claimedBy = null;
      t.claimedByClient = null;
      t.claimedAt = null;
      t.progress = null;
      this.saveBrainTasks();
      return { task: null, blockedBy: t };
    }
    t.status = ok ? 'done' : 'failed';
    t.result = String(result ?? '').slice(0, 2000);
    // verify against the claim anchor when both fingerprints are known:
    // a successful task that left the document unchanged is reported UNVERIFIED
    if (typeof stateHash === 'string') t.stateHashAtFinish = stateHash.slice(0, 64);
    t.verified =
      ok && t.stateHashAtClaim !== null && t.stateHashAtFinish !== null
        ? t.stateHashAtFinish !== t.stateHashAtClaim
        : null;
    this.saveBrainTasks();
    return { task: t, blockedBy: null };
  }

  /** Remove finished (`done` / `failed` / `cancelled`) tasks while preserving active ones. */
  brainClearFinished(): BrainTask[] {
    if (!Array.isArray(this.brainTasks)) this.loadBrainTasks();
    this.sweepStaleClaims();
    this.brainTasks = this.brainTasks.filter((t) => t.status === 'pending' || t.status === 'claimed' || t.status === 'running');
    this.saveBrainTasks();
    return this.brainTasks;
  }

  /** Re-queue failed tasks (all failed tasks, or a specific failed task by `id`) back to `pending`. */
  brainRetryFailed(id?: string): BrainTask[] {
    if (!Array.isArray(this.brainTasks)) this.loadBrainTasks();
    this.sweepStaleClaims();
    let changed = false;
    for (const t of this.brainTasks) {
      if (t.status === 'failed' && (!id || t.id === id)) {
        t.status = 'pending';
        t.claimedBy = null;
        t.claimedByClient = null;
        t.claimedAt = null;
        t.result = null;
        t.progress = null;
        changed = true;
      }
    }
    if (changed) this.saveBrainTasks();
    return this.brainTasks;
  }

    recentOps(limit = 20): AuditEntry[] {
    return this.auditMemory.slice(-Math.max(1, Math.min(limit, MAX_AUDIT_MEMORY))).reverse();
  }

  /** Keep the on-disk audit useful without letting a busy IDE grow forever. */
  private trimAuditFile(): void {
    try {
      const size = statSync(this.auditPath).size;
      if (size <= MAX_AUDIT_FILE_BYTES) return;
      const start = Math.max(0, size - RETAIN_AUDIT_FILE_BYTES);
      const tail = readFileSync(this.auditPath).subarray(start);
      // Drop a partial JSONL line when the retained window starts mid-entry.
      const firstNewline = tail.indexOf(0x0a);
      const completeLines = firstNewline >= 0 ? tail.subarray(firstNewline + 1) : tail;
      writeFileSync(this.auditPath, completeLines);
      this.restrict(this.auditPath);
    } catch {
      // Audit retention must never interrupt an MCP tool call.
    }
  }
}
