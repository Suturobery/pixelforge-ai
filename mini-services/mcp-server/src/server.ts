/**
 * PixelForge AI — MCP server host (v3.1 §5, Task 8).
 *
 * Real Model Context Protocol over the OFFICIAL TypeScript SDK:
 *   • McpServer + Streamable HTTP transport (web-standard Request/Response,
 *     runs on Bun.serve bound to 127.0.0.1) with server-managed sessions;
 *   • one McpServer + transport PER SESSION (the stateful pattern) so
 *     projectChanged events can be pushed to exactly the connected clients;
 *   • typed tool registration from the Task 8 catalog with structured
 *     results ({ok, error?, data?, undoable?, stateHash?}).
 *
 * Enforcement lives HERE (before anything reaches the editor):
 *   identity → tier grant → rate budget → then relay. The pairing exchange
 *   (pair_client) is the only call a pairing-token identity can make.
 */

import { randomUUID } from 'node:crypto';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { sha256Hex, generateClientId, generateClientToken, hashesMatch, RateLimiter } from './auth';
import { PAIRING_ALLOWED_TOOLS, TOOL_CATALOG, type ToolDef } from './tools-catalog';
import { TIER_RATE_LIMITS, tierGrants, type AuditEntry, type EditorEvent, type PairedClient, type Tier, type ToolEnvelope } from './types';
import type { EditorLink } from './editor-link';
import { getKnowledge, loadPalettes, studyReference } from './knowledge';
import type { McpStore } from './store';

export interface HostDeps {
  link: EditorLink;
  store: McpStore;
  /** Master switch mirrored from the editor UI (Settings → MCP). */
  isEnabled: () => boolean;
  endpointUrl: string;
  startedAt: string;
}

/** The editor already encodes previews as PNGs. Expose those same bytes to vision clients. */
function previewImages(tool: string, data: unknown) {
  if (!data || typeof data !== 'object') return [];
  const urls = tool === 'get_frame_png' && 'png' in data ? [data.png]
    : tool === 'preview_animation' && 'frames' in data && Array.isArray(data.frames) ? data.frames : [];
  const prefix = 'data:image/png;base64,';
  return urls.flatMap((url: unknown) =>
    typeof url === 'string' && url.startsWith(prefix) && url.length > prefix.length
      ? [{ type: 'image' as const, mimeType: 'image/png', data: url.slice(prefix.length) }]
      : []);
}

interface SessionIdentity {
  kind: 'client';
  clientId: string;
  name: string;
  tier: Tier;
}

interface PairingIdentity {
  kind: 'pairing';
  tier: Tier;
  tokenHash: string;
}

export type RequestIdentity = SessionIdentity | PairingIdentity;

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  identity: RequestIdentity | null;
}

export const ERROR_CODES = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN_TIER: 'permission_denied',
  DISABLED: 'mcp_disabled',
  RATE_LIMITED: 'rate_limited',
  BAD_REQUEST: 'bad_request',
  INTERNAL: 'internal_error',
  STALE: 'stale_document',
} as const;

export class McpHost {
  readonly link: EditorLink;
  readonly store: McpStore;
  private readonly deps: HostDeps;
  private readonly sessions = new Map<string, SessionEntry>();
  /** identity resolved from the CURRENTLY-processed HTTP request. */
  private initializing: RequestIdentity | null = null;
  private unsubEvents: (() => void) | null = null;
  private readonly rate = new RateLimiter();

  constructor(deps: HostDeps) {
    this.deps = deps;
    this.link = deps.link;
    this.store = deps.store;
    this.unsubEvents = this.link.onEvent((evt) => this.broadcastEvent(evt));
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  // ------------------------------------------------------------------ events

  private broadcastEvent(evt: EditorEvent): void {
    if (evt.type !== 'projectChanged') return;
    const params = { stateHash: evt.stateHash ?? null, name: evt.name ?? null, dirty: evt.dirty ?? null };
    for (const entry of this.sessions.values()) {
      try {
        void entry.server.server.notification({
          method: 'notifications/pixelforge/projectChanged',
          params,
        });
      } catch {
        /* a dead session is cleaned up by its transport */
      }
    }
  }

  /**
   * Standard `notifications/tools/list_changed` to every live session. The
   * tool catalog is static per process today, so this is currently dormant —
   * call it (ctrl 'tools-changed') whenever the catalog ever becomes dynamic
   * (per-client tool shaping, feature flags, plugins).
   */
  broadcastToolsChanged(): void {
    for (const entry of this.sessions.values()) {
      try {
        void entry.server.server.notification({ method: 'notifications/tools/list_changed' });
      } catch {
        /* a dead session is cleaned up by its transport */
      }
    }
  }

  // ------------------------------------------------------------- transport

  /**
   * Handle one HTTP request against the session-mapped transports.
   * `identity` is the authenticated caller for THIS request (Bearer).
   */
  async handleHttp(request: Request, identity: RequestIdentity): Promise<Response> {
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      const entry = this.sessions.get(sessionId);
      if (!entry) {
        return this.jsonError(404, 'session_not_found', 'Unknown MCP session — re-initialize.');
      }
      // A session is bound to its first identity; the bearer must still
      // resolve to the SAME identity (catches token swaps + revoked reuse).
      if (!identitiesMatch(entry.identity, identity)) {
        this.auditSecurity('session_identity_mismatch', identity);
        return this.jsonError(401, ERROR_CODES.UNAUTHORIZED, 'Session/token mismatch — re-initialize with the current token.');
      }
      return entry.transport.handleRequest(request);
    }

    // No session id → initialize (or a malformed call the SDK will reject).
    this.initializing = identity;
    let createdSid: string | null = null;
    try {
      // Stateful pattern: one transport + one McpServer PER SESSION so
      // projectChanged notifications reach exactly the connected clients.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          if (this.initializing) {
            createdSid = sid;
            this.sessions.set(sid, { transport, server, identity: this.initializing });
          }
        },
      });
      const server = this.buildServer();
      await server.connect(transport);
      const res = await transport.handleRequest(request);
      if (!createdSid) {
        // not an initialize (or it failed) → nothing registered, clean up
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }
      return res;
    } finally {
      // clear the per-request identity binding
      queueMicrotask(() => (this.initializing = null));
    }
  }

  /** DELETE /mcp → client-driven session teardown. */
  async handleDelete(request: Request): Promise<Response> {
    const sessionId = request.headers.get('mcp-session-id');
    if (!sessionId) return this.jsonError(400, 'bad_request', 'mcp-session-id header required');
    const entry = this.sessions.get(sessionId);
    if (!entry) return this.jsonError(404, 'session_not_found', 'Unknown MCP session');
    this.sessions.delete(sessionId);
    await entry.transport.close().catch(() => {});
    await entry.server.close().catch(() => {});
    return new Response(null, { status: 204 });
  }

  async shutdown(): Promise<void> {
    this.unsubEvents?.();
    for (const [, entry] of this.sessions) {
      await entry.transport.close().catch(() => {});
      await entry.server.close().catch(() => {});
    }
    this.sessions.clear();
  }

  // ----------------------------------------------------------------- server

  private buildServer(): McpServer {
    const server = new McpServer(
      { name: 'pixelforge-ai', version: '1.0.0' },
      {
        instructions:
          'PixelForge AI pixel art & animation editor. Read get_project_state first; ids and stateHash from it ' +
          'feed the other tools. Follow the project palette and Style Lock. For drawing, read get_knowledge ' +
          'on methodology, shade, and the matching subject topic (characters, tileset, vfx). Block organic silhouettes ' +
          'with draw_ellipse, draw_polygon, draw_line, flood_fill, and set_pixels (avoid boxy rectangles). Inspect ' +
          'get_frame_png at scale=8 with showGrid=true plus native scale=1, run analyze_pixel_craft to catch doubles, ' +
          'orphans, jaggies, and pillow shading, and polish with beautify_layer (selOut=true, cleanDoubles=true, paletteLock=true). ' +
          'For animation read the animation topic, inspect preview_animation frames, and check timing and emptyFrames. ' +
          'Run validate_style for technical checks. If your client cannot display images, report that visual review is pending. ' +
          'Respect dirty_project when replacing a document.',
      }
    );

    for (const def of TOOL_CATALOG) {
      server.registerTool(
        def.name,
        {
          title: def.title,
          description: def.description,
          inputSchema: def.inputSchema,
        },
        async (args: Record<string, unknown>, ctx) => {
          const started = Date.now();
          const sid = ctx.sessionId;
          const entry = sid ? this.sessions.get(sid) : undefined;
          const identity = entry?.identity ?? this.initializing;
          const envelope = await this.runTool(def, args, identity);
          const text = JSON.stringify(envelope, null, 2);
          this.auditTool(def, args, identity, envelope, Date.now() - started);
          if (!envelope.ok) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text }],
            };
          }
          return {
            content: [{ type: 'text' as const, text }, ...previewImages(def.name, envelope.data)],
            structuredContent: envelope as unknown as Record<string, unknown>,
          };
        }
      );
    }
    // ---- read-only resources (shared-Brain phase 5) ------------------------
    // Contents are plain JSON snapshots; both sit behind the same HTTP bearer
    // auth as tools, and the catalog is filtered to the session's tier.
    server.registerResource(
      'capabilities',
      'pixelforge://capabilities',
      { title: 'PixelForge capability catalog', description: 'Every MCP tool PixelForge exposes, filtered to the reader tier', mimeType: 'application/json' },
      async (uri, ctx) => {
        const entry = ctx.sessionId ? this.sessions.get(ctx.sessionId) : undefined;
        const tier: Tier = entry?.identity && entry.identity.kind === 'client' ? entry.identity.tier : 'L0';
        const granted = TOOL_CATALOG.filter((d) => tierGrants(tier, d.tier) && d.name !== 'pair_client');
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: 'application/json',
              text: JSON.stringify(
                {
                  tier,
                  tools: granted.map((d) => ({ name: d.name, title: d.title, tier: d.tier, relay: d.relay, paid: Boolean(d.paid) })),
                  counts: { total: TOOL_CATALOG.length, granted: granted.length },
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    );
    server.registerResource(
      'project-active',
      'pixelforge://project/active',
      { title: 'Active project summary', description: 'Live summary of the open PixelForge project (get_project_state relay)', mimeType: 'application/json' },
      async (uri, ctx) => {
        const entry = ctx.sessionId ? this.sessions.get(ctx.sessionId) : undefined;
        const identity = entry?.identity && entry.identity.kind === 'client' ? entry.identity : null;
        const envelope = await this.link.requestTool({
          tool: 'get_project_state',
          args: {},
          clientId: identity?.clientId ?? 'resource-reader',
          clientName: identity?.name ?? 'resource-reader',
          tier: identity?.tier ?? 'L0',
        });
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: 'application/json',
              text: JSON.stringify(envelope, null, 2),
            },
          ],
        };
      }
    );
    return server;
  }

  // ------------------------------------------------------------- execution

  /** Active project identity from the editor link (task-board gating). */
  private get currentProject(): { key: string; name: string } | null {
    const key = this.link.connected ? this.link.currentProjectKey : null;
    if (!key) return null;
    return { key, name: this.link.currentProjectName ?? 'active project' };
  }

  private async runTool(def: ToolDef, args: Record<string, unknown>, identity: RequestIdentity | null): Promise<ToolEnvelope> {
    if (!identity) {
      return fail(ERROR_CODES.UNAUTHORIZED, 'No authenticated identity for this call.');
    }

    // master switch (Settings → MCP toggle)
    if (def.name !== 'pair_client' && !this.deps.isEnabled()) {
      return fail(ERROR_CODES.DISABLED, 'MCP access is disabled in the PixelForge settings.');
    }

    if (identity.kind === 'pairing') {
      if (def.name !== 'pair_client' || !PAIRING_ALLOWED_TOOLS.has(def.name)) {
        this.auditSecurity('pairing_tool_rejected', identity, def.name);
        return fail(ERROR_CODES.UNAUTHORIZED, 'This pairing code may only be used with the pair_client tool.', 'Call pair_client {name} to become a paired client.');
      }
      const name = typeof args?.name === 'string' ? args.name.trim().slice(0, 60) : '';
      if (!name) return fail(ERROR_CODES.BAD_REQUEST, '"name" must be a 1–60 char client name.');
      // atomic single-use consumption (replay impossible even if two
      // sessions race the same code)
      const consumed = this.store.consumePairing(identity.tokenHash);
      if (!consumed) {
        this.auditSecurity('pairing_used_or_expired', identity, def.name);
        return fail(ERROR_CODES.UNAUTHORIZED, 'This pairing code was already used or has expired.', 'Ask the user for a fresh code.');
      }
      const token = generateClientToken();
      const client: PairedClient = {
        clientId: generateClientId(),
        name,
        tier: identity.tier,
        tokenHash: sha256Hex(token),
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        revoked: false,
      };
      this.store.putClient(client);
      this.store.audit({
        kind: 'pair',
        clientId: client.clientId,
        clientName: client.name,
        tool: 'pair_client',
        tier: client.tier,
        argsHash: null,
        ok: true,
        errorCode: null,
        durationMs: 0,
        summary: `Paired client "${client.name}" (tier ${client.tier})`,
      });
      return {
        ok: true,
        data: {
          clientId: client.clientId,
          clientName: client.name,
          tier: client.tier,
          token,
          expiresInDays: null,
          note: 'Store this token now — it is not shown again. Send it as "Authorization: Bearer <token>". Revoke any time in Settings → MCP.',
        },
        summary: `Paired "${client.name}"`,
      };
    }

    // client identity — permission tier + rate budget (§5.2/§5.5)
    if (!tierGrants(identity.tier, def.tier)) {
      this.auditSecurity('tier_denied', identity, def.name);
      return fail(
        ERROR_CODES.FORBIDDEN_TIER,
        `Your permission tier (${identity.tier}) does not grant this tool (${def.tier}).`,
        'Ask the user to pair you with a higher tier in Settings → MCP.'
      );
    }
    // Per-tool-tier budget: free reads/writes get full speed at any client
    // tier; paid L3 stays hard-capped regardless of client tier (§5.5).
    const rateKey = `${identity.clientId}:${def.tier}`;
    if (!this.rate.allow(rateKey, def.tier)) {
      this.auditSecurity('rate_limited', identity, def.name);
      const resetInSec = this.rate.usage(rateKey)?.resetInSec ?? 60;
      return fail(
        ERROR_CODES.RATE_LIMITED,
        `Rate limit exceeded for ${def.tier} tools (${TIER_RATE_LIMITS[def.tier]}/min).`,
        `Slow down and retry in ${resetInSec}s (Retry-After).`
      );
    }

    this.store.touchClient(identity.clientId);

    // A client with a claimed task can edit only its confirmed project.
    // Carry that identity through the relay because the editor may switch
    // documents before its next projectChanged notification reaches us.
    const taskTargets = def.tier !== 'L0' && (def.relay || def.name === 'apply_library_palette')
      ? this.store.brainClaimedTargets(identity.clientId)
      : [];
    const blockedTarget = taskTargets.find((target) => target.key !== this.currentProject?.key);
    if (blockedTarget) {
      return fail(
        'task_project_mismatch',
        `Task edits require project "${blockedTarget.name}". Active project: "${this.currentProject?.name ?? 'not confirmed'}".`,
        'Open the target project and wait for the editor to report it, then retry.',
      );
    }
    const expectedProjectKey = taskTargets[0]?.key;

    if (!def.relay) {
      if (def.name === 'get_operation_log') {
        const limit = typeof args?.limit === 'number' ? args.limit : 20;
        const ops = this.store.recentOps(limit).map((o: AuditEntry) => ({
          ts: o.ts,
          clientId: o.clientId,
          clientName: o.clientName,
          tool: o.tool,
          tier: o.tier,
          argsHash: o.argsHash,
          ok: o.ok,
          errorCode: o.errorCode,
          durationMs: o.durationMs,
          summary: o.summary,
        }));
        return { ok: true, data: { count: ops.length, ops } };
      }
      if (def.name === 'get_quota') {
        return this.quotaSnapshot(identity.clientId);
      }
      if (def.name === 'get_knowledge') {
        return getKnowledge(String(args?.topic ?? ''), typeof args?.style === 'string' ? args.style : undefined);
      }
      if (def.name === 'brain_get_tasks') {
        const tasks = this.store.brainList();
        return {
          ok: true,
          data: {
            pending: tasks.filter((t) => t.status === 'pending'),
            claimed: tasks.filter((t) => t.status === 'claimed' || t.status === 'running'),
            finished: tasks.filter((t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled').slice(0, 10),
          },
          summary: 'task board: ' + tasks.filter((t) => t.status === 'pending').length + ' pending',
        };
      }
      if (def.name === 'brain_get_task') {
        const task = this.store.brainList().find((t) => t.id === String(args?.id ?? ''));
        if (!task) return fail(ERROR_CODES.BAD_REQUEST, `No task "${String(args?.id ?? '')}" on the board.`, 'List with brain_get_tasks.');
        return { ok: true, data: { task }, summary: 'task: ' + task.title };
      }
      if (def.name === 'brain_get_status') {
        const tasks = this.store.brainList();
        return {
          ok: true,
          data: {
            mcpEnabled: this.deps.isEnabled(),
            editorConnected: this.link.connected,
            lastProjectName: this.link.lastProjectName,
            lastStateHash: this.link.lastStateHash,
            sessions: this.sessionCount,
            clientsPaired: this.store.listClients().filter((c) => !c.revoked).length,
            board: {
              pending: tasks.filter((t) => t.status === 'pending').length,
              claimed: tasks.filter((t) => t.status === 'claimed' || t.status === 'running').length,
            },
            brain: {
              available: true,
              note: 'brain_ask / brain_plan_goal run editor-side with the artist\'s configured reasoning provider; interpretation (brain_interpret_prompt) is deterministic and free.',
            },
          },
          summary: 'brain status: editor ' + (this.link.connected ? 'connected' : 'offline'),
        };
      }
      if (def.name === 'brain_get_capabilities') {
        // deterministic catalog, filtered to the caller's tier (doc §7: keep
        // lists deterministic and filter by permission)
        const granted = TOOL_CATALOG.filter((d) => tierGrants(identity.tier, d.tier) && d.name !== 'pair_client');
        return {
          ok: true,
          data: {
            tier: identity.tier,
            tools: granted.map((d) => ({
              name: d.name,
              title: d.title,
              tier: d.tier,
              relay: d.relay,
              paid: Boolean(d.paid),
              description: d.description,
            })),
            counts: { total: TOOL_CATALOG.length, granted: granted.length },
          },
          summary: `capabilities: ${granted.length}/${TOOL_CATALOG.length} tools at tier ${identity.tier}`,
        };
      }
      if (def.name === 'brain_claim_task') {
        // anchor the claim to the CURRENT document fingerprint so completion
        // can later be verified against actual state change; the claim is also
        // GATED on the task's target project (queued from the Brain panel)
        const { task: claimed, blockedBy } = this.store.brainClaim(
          String(args?.id ?? ''),
          identity.name,
          identity.clientId,
          this.link.lastStateHash,
          this.currentProject,
        );
        if (blockedBy) {
          return fail(
            ERROR_CODES.BAD_REQUEST,
            `Task "${blockedBy.title}" targets project "${blockedBy.targetProjectName ?? blockedBy.targetProjectKey}" - project "${this.currentProject?.name ?? 'unknown'}" is active. Switch the editor to the target project and retry.`,
          );
        }
        if (!claimed) return fail(ERROR_CODES.BAD_REQUEST, 'Task not claimable (unknown id or not pending).');
        const legacyNote = claimed.targetProjectKey
          ? ''
          : ' (legacy task without a target project - the artist should confirm the target on the board)';
        return { ok: true, data: { task: claimed, needsTargetConfirm: !claimed.targetProjectKey }, summary: 'claimed: ' + claimed.title + legacyNote };
      }
      if (def.name === 'brain_complete_task') {
        const { task: done, blockedBy } = this.store.brainFinish(
          String(args?.id ?? ''),
          identity.clientId,
          true,
          String(args?.result ?? ''),
          this.link.lastStateHash,
          this.currentProject,
        );
        if (blockedBy) {
          return fail(
            ERROR_CODES.BAD_REQUEST,
            `Continuation blocked: task "${blockedBy.title}" targets project "${blockedBy.targetProjectName ?? blockedBy.targetProjectKey}" but project "${this.currentProject?.name ?? 'unknown'}" is active. The task returned to the board - switch projects and claim again.`,
          );
        }
        if (!done) return fail(ERROR_CODES.BAD_REQUEST, 'Task not completable (unknown id, not claimed, or claimed by another agent).');
        const verification = done.verified === true ? ' (changes detected)' : done.verified === false ? ' (UNVERIFIED - no changes detected since claim)' : '';
        return { ok: true, data: { task: done }, summary: 'done: ' + done.title + verification };
      }
      if (def.name === 'brain_fail_task') {
        const { task: failed, blockedBy } = this.store.brainFinish(
          String(args?.id ?? ''),
          identity.clientId,
          false,
          String(args?.reason ?? ''),
          this.link.lastStateHash,
          this.currentProject,
        );
        if (blockedBy) {
          return fail(
            ERROR_CODES.BAD_REQUEST,
            `Continuation blocked: task "${blockedBy.title}" targets project "${blockedBy.targetProjectName ?? blockedBy.targetProjectKey}" but project "${this.currentProject?.name ?? 'unknown'}" is active. The task returned to the board.`,
          );
        }
        if (!failed) return fail(ERROR_CODES.BAD_REQUEST, 'Task not failable (unknown id, not claimed, or claimed by another agent).');
        return { ok: true, data: { task: failed }, summary: 'failed: ' + failed.title };
      }
      if (def.name === 'brain_update_task_progress') {
        const { task: updated, blockedBy } = this.store.brainProgress(
          String(args?.id ?? ''),
          identity.clientId,
          String(args?.progress ?? ''),
          this.currentProject,
        );
        if (blockedBy) {
          return fail(
            ERROR_CODES.BAD_REQUEST,
            `Continuation blocked: task "${blockedBy.title}" targets project "${blockedBy.targetProjectName ?? blockedBy.targetProjectKey}" but project "${this.currentProject?.name ?? 'unknown'}" is active. The task returned to the board.`,
          );
        }
        if (!updated) return fail(ERROR_CODES.BAD_REQUEST, 'Task not updatable (unknown id, not claimed/running, or claimed by another agent).');
        return { ok: true, data: { task: updated }, summary: 'progress: ' + updated.title };
      }
      if (def.name === 'brain_cancel_task') {
        // requesterClient set: agents may cancel ONLY their own claimed/running work
        const cancelled = this.store.brainCancel(String(args?.id ?? ''), identity.clientId);
        if (!cancelled) return fail(ERROR_CODES.BAD_REQUEST, 'Task not cancellable (unknown id, not yours, or already finished).');
        return { ok: true, data: { task: cancelled }, summary: 'cancelled: ' + cancelled.title };
      }
      if (def.name === 'apply_library_palette') {
        // server-side composite: resolve the library id here (the JSON lives
        // on the server), then perform the SAME undoable set_palette on the
        // editor — one agent call instead of search → copy → set_palette.
        const id = String(args?.id ?? '').trim();
        const preset = loadPalettes().presets?.[id];
        if (!preset) {
          return fail(ERROR_CODES.BAD_REQUEST, `Unknown library palette "${id}".`, "Browse with get_knowledge {topic:'palette_library', style:'<keyword>'}.");
        }
        const relayed = await this.link.requestTool({
          tool: 'set_palette',
          args: { colors: preset.colors },
          clientId: identity.clientId,
          clientName: identity.name,
          tier: identity.tier,
          expectedProjectKey,
        });
        if (!relayed.ok) return relayed;
        return {
          ok: true,
          data: { applied: id, name: preset.name, size: preset.size, colors: preset.colors },
          summary: `Library palette "${preset.name}" applied (${preset.size} colors)`,
        };
      }
      if (def.name === 'study_reference') {
        return studyReference({
          pngBase64: String(args?.pngBase64 ?? ''),
          styleName: typeof args?.styleName === 'string' ? args.styleName : undefined,
          notes: typeof args?.notes === 'string' ? args.notes : undefined,
        });
      }
      return fail(ERROR_CODES.INTERNAL, `Tool "${def.name}" has no local handler.`);
    }

    // relay to the editor (the plane that owns the CommandBus)
    const envelope = await this.link.requestTool({
      tool: def.name,
      args,
      clientId: identity.clientId,
      clientName: identity.name,
      tier: identity.tier,
      expectedProjectKey,
    });
    return envelope;
  }

  // ------------------------------------------------------------------ audit

  /** Per-tier rate budget for one client (keyed clientId:tier, §5.5). */
  private quotaSnapshot(clientId: string): { ok: true; data: unknown } {
    const tiers = Object.entries(TIER_RATE_LIMITS).map(([tier, limit]) => {
      const usage = this.rate.usage(`${clientId}:${tier}`);
      return {
        tier,
        limitPerMin: limit,
        used: usage?.used ?? 0,
        remaining: usage ? Math.max(0, limit - usage.used) : limit,
        resetInSec: usage?.resetInSec ?? 0,
      };
    });
    return { ok: true, data: { clientId, tiers } };
  }

  private auditTool(def: ToolDef, args: unknown, identity: RequestIdentity | null, envelope: ToolEnvelope, durationMs: number): void {
    this.store.audit({
      kind: 'tool',
      clientId: identity && identity.kind === 'client' ? identity.clientId : null,
      clientName: identity ? identityName(identity) : 'anonymous',
      tool: def.name,
      tier: identity ? identity.tier : null,
      argsHash: sha256Hex(JSON.stringify(args ?? {})),
      ok: envelope.ok,
      errorCode: envelope.error?.code ?? null,
      durationMs,
      summary: envelope.summary ?? null,
    });
  }

  private auditSecurity(code: string, identity: RequestIdentity | null, tool?: string): void {
    this.store.audit({
      kind: 'security',
      clientId: identity && identity.kind === 'client' ? identity.clientId : null,
      clientName: identity ? identityName(identity) : 'anonymous',
      tool: tool ?? code,
      tier: identity ? identity.tier : null,
      argsHash: null,
      ok: false,
      errorCode: code,
      durationMs: 0,
      summary: null,
    });
  }

  private jsonError(status: number, code: string, message: string): Response {
    return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
}

function identityName(i: RequestIdentity): string {
  return i.kind === 'client' ? i.name : `pairing:${i.tier}`;
}

function identitiesMatch(a: RequestIdentity | null, b: RequestIdentity): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'pairing' && b.kind === 'pairing') return hashesMatch(a.tokenHash, b.tokenHash);
  if (a.kind === 'client' && b.kind === 'client') return a.clientId === b.clientId;
  return false;
}

function fail(code: string, message: string, hint?: string): ToolEnvelope {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
}

/** The pairing identity is resolved by the HTTP layer (auth.ts in index). */
export interface AuthResult {
  ok: boolean;
  status?: number;
  code?: string;
  message?: string;
  identity?: RequestIdentity;
}
