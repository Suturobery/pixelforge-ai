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

import { mkdirSync, readFileSync, renameSync, appendFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { AuditEntry, PairedClient, PendingPairing, Tier } from './types';

export interface StoreOptions {
  dataDir?: string;
  auditFile?: string;
}

const MAX_AUDIT_MEMORY = 500;

export class McpStore {
  readonly dataDir: string;
  private readonly clientsFile: string;
  private readonly auditPath: string;
  private clients: Map<string, PairedClient> = new Map();
  private pairings: PendingPairing[] = [];
  private auditMemory: AuditEntry[] = [];
  private auditSeq = 0;

  constructor(opts: StoreOptions = {}) {
    this.dataDir = opts.dataDir ?? process.env.PF_MCP_DATA_DIR ?? path.resolve(import.meta.dir, '../../../db');
    mkdirSync(this.dataDir, { recursive: true });
    this.clientsFile = path.join(this.dataDir, 'mcp-clients.json');
    this.auditPath = opts.auditFile ?? path.join(this.dataDir, 'mcp-ops.jsonl');
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
    } catch (err) {
      // best-effort: never break a tool call because the audit file failed
      console.error('[mcp] audit append failed:', err instanceof Error ? err.message : err);
    }
  }

  recentOps(limit = 20): AuditEntry[] {
    return this.auditMemory.slice(-Math.max(1, Math.min(limit, MAX_AUDIT_MEMORY))).reverse();
  }
}
