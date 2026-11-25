/**
 * PixelForge AI — MCP server host process (v3.1 §5.1/§5.5).
 *
 * ONE Bun.serve bound strictly to 127.0.0.1:
 *   /mcp     — Streamable-HTTP MCP endpoint (real MCP protocol, official SDK)
 *   /        — WebSocket upgrade: the editor bridge (renderer → CommandBus)
 *   /health  — liveness only (no data)
 *
 * Security (§5.5 + DNS-rebinding guidance from the MCP spec):
 *   • loopback bind — the service never listens on a LAN interface;
 *   • Host allowlist on /mcp (127.0.0.1:3030 | localhost:3030) kills
 *     DNS-rebinding (a rebound page keeps its own Host header);
 *   • Origin check on /mcp (loopback app origins only) and on the editor
 *     WebSocket (same-host/loopback/no-Origin — browser drive-by always
 *     sends a cross Origin);
 *   • Bearer auth: paired client tokens (hashed at rest) or one-time
 *     6-word pairing tokens (15 min, single use, ≈49.85 bits, failed auth
 *     attempts throttled — brute-force capped);
 *   • request bodies ≤ 2 MB (§5.5), Content-Length required;
 *   • every security event lands in the audit log.
 *
 * Electron packaging note: createPixelForgeServer(deps) is embed-first —
 * the desktop main process can host the same modules in-process.
 */

import * as path from 'node:path';
import { getOrCreateEditorToken } from './editor-auth';
import { EditorLink, type EditorSocket } from './editor-link';
import { McpStore } from './store';
import { McpHost, type RequestIdentity } from './server';
import { extractBearer, generateClientId, generateClientToken, newPendingPairing, sha256Hex } from './auth';
import {
  type CtrlRequest,
  type EditorInbound,
  type Tier,
} from './types';

const PORT = Number(process.env.PF_MCP_PORT ?? 3030);
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 2 * 1024 * 1024; // §5.5 request cap
const MCP_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

function storeDataDir(): string {
  return process.env.PF_MCP_DATA_DIR ?? path.resolve(import.meta.dir, '../../../db');
}

const store = new McpStore({ dataDir: storeDataDir() });
const link = new EditorLink({ editorToken: getOrCreateEditorToken(storeDataDir()) });
let mcpEnabled = true;
const startedAt = new Date().toISOString();
const endpointUrl = `http://${HOST}:${PORT}/mcp`;

const host = new McpHost({ link, store, isEnabled: () => mcpEnabled, endpointUrl, startedAt });

// ---------------------------------------------------------------------------
// control plane — the Settings UI talks to the server through the editor WS
// ---------------------------------------------------------------------------

function handleCtrl(msg: EditorInbound, reply: (id: string, ok: boolean, data?: unknown, error?: { code: string; message: string }) => void): void {
  const ctrl = msg.ctrl as CtrlRequest | undefined;
  const id = msg.id ?? '';
  if (!ctrl) return reply(id, false, undefined, { code: 'bad_request', message: 'Missing ctrl payload' });
  switch (ctrl.kind) {
    case 'status': {
      reply(id, true, {
        mcpEnabled,
        endpoint: endpointUrl,
        editorConnected: link.connected,
        editorAppVersion: link.appVersion,
        bridgeVersion: link.bridgeVersion,
        lastStateHash: link.lastStateHash,
        lastProjectName: link.lastProjectName,
        clientsPaired: store.listClients().filter((c) => !c.revoked).length,
        sessions: host.sessionCount,
        startedAt,
      });
      return;
    }
    case 'pair-generate': {
      const tier: Tier = (['L1', 'L2', 'L3'] as string[]).includes(ctrl.tier as string)
        ? (ctrl.tier as Tier)
        : 'L0';
      const { token, pairing } = newPendingPairing(tier);
      store.addPairing(pairing);
      reply(id, true, {
        token,
        tier,
        expiresAt: new Date(pairing.expiresAt).toISOString(),
        ttlMinutes: 15,
      });
      return;
    }
    case 'pair-cancel': {
      const ok = store.cancelPairing(sha256Hex(ctrl.token));
      reply(id, ok, ok ? { cancelled: true } : undefined, ok ? undefined : { code: 'not_found', message: 'Pairing code not found (or already used)' });
      return;
    }
    case 'client-issue': {
      // Trusted editor control plane (1-click desktop IDE setup): mints a real
      // persistent client token directly so the desktop shell can write a
      // ready-to-use config without a manual pair_client round-trip.
      const name = typeof ctrl.name === 'string' ? ctrl.name.trim().slice(0, 64) : '';
      if (!name) {
        reply(id, false, undefined, { code: 'bad_request', message: 'Client name is required' });
        return;
      }
      const tier: Tier = (['L1', 'L2', 'L3'] as string[]).includes(ctrl.tier as string)
        ? (ctrl.tier as Tier)
        : 'L0';
      const token = generateClientToken();
      const clientId = generateClientId();
      const createdAt = new Date().toISOString();
      store.putClient({
        clientId,
        name,
        tier,
        tokenHash: sha256Hex(token),
        createdAt,
        lastSeen: null,
        revoked: false,
      });
      store.audit({
        kind: 'pair',
        clientId,
        clientName: name,
        tool: 'client_issue',
        tier,
        argsHash: null,
        ok: true,
        errorCode: null,
        durationMs: 0,
        summary: `1-click setup issued ${tier} token for ${name}`,
      });
      reply(id, true, { clientId, name, tier, token, createdAt });
      return;
    }
    case 'clients-list': {
      const clients = store.listClients().map((c) => ({
        clientId: c.clientId,
        name: c.name,
        tier: c.tier,
        createdAt: c.createdAt,
        lastSeen: c.lastSeen,
        revoked: c.revoked,
      }));
      reply(id, true, { clients });
      return;
    }
    case 'client-revoke': {
      const revoked = store.revokeClient(ctrl.clientId);
      reply(id, !!revoked, revoked ? { revoked: true, clientId: revoked.clientId } : undefined, revoked ? undefined : { code: 'not_found', message: 'Unknown client id' });
      return;
    }
    case 'client-remove': {
      const result = store.removeRevokedClient(ctrl.clientId);
      if (result === 'removed') {
        reply(id, true, { removed: true, clientId: ctrl.clientId });
      } else if (result === 'active') {
        reply(id, false, undefined, { code: 'client_active', message: 'Revoke this client before removing it from the list.' });
      } else {
        reply(id, false, undefined, { code: 'not_found', message: 'Unknown client id' });
      }
      return;
    }
    case 'ops-recent': {
      const limit = Math.max(1, Math.min(ctrl.limit ?? 12, 100));
      reply(id, true, { ops: store.recentOps(limit) });
      return;
    }
    // second-brain orchestration: the editor (AI panel) queues a plan for
    // IDE agents to claim, and reads board state for the UI
    case 'brain-push': {
      const tasks = Array.isArray(ctrl.tasks) ? ctrl.tasks : [];
      // Stamp the pushing editor's current project on tasks that omit a target
      // (claim gating needs an identity; legacy senders never provided one).
      const stamped = tasks.map((t) => ({
        ...t,
        targetProject:
          t.targetProject ??
          (link.currentProjectKey
            ? { key: link.currentProjectKey, name: link.currentProjectName ?? '' }
            : null),
      }));
      reply(id, true, {
        tasks: store.brainPush(stamped, {
          replacePending: ctrl.replacePending === true,
          planId: typeof ctrl.planId === 'string' ? ctrl.planId : undefined,
        }),
      });
      return;
    }
    case 'brain-tasks': {
      reply(id, true, { tasks: store.brainList() });
      return;
    }
    case 'brain-clear': {
      reply(id, true, { tasks: store.brainClearFinished() });
      return;
    }
    case 'brain-retry': {
      reply(id, true, { tasks: store.brainRetryFailed(typeof ctrl.id === 'string' ? ctrl.id : undefined) });
      return;
    }
    case 'brain-review': {
      const reviewed =
        typeof ctrl.id === 'string' &&
        (ctrl.verdict === 'approved' || ctrl.verdict === 'needs_changes') &&
        typeof ctrl.clipId === 'string' &&
        typeof ctrl.frameIndex === 'number'
          ? store.brainReview(ctrl.id, ctrl.verdict, ctrl.clipId, ctrl.frameIndex, link.currentProjectKey, link.lastStateHash)
          : null;
      reply(id, !!reviewed, reviewed ? { task: reviewed } : undefined, reviewed ? undefined : {
        code: 'review_unavailable',
        message: 'Open the task’s project and review a completed task before trying again.',
      });
      return;
    }
    case 'brain-cancel': {
      // no requesterClient: the editor speaks for the human, who outranks agents
      const cancelled = typeof ctrl.id === 'string' ? store.brainCancel(ctrl.id) : null;
      reply(id, !!cancelled, cancelled ? { task: cancelled } : undefined, cancelled ? undefined : { code: 'not_found', message: 'Task not cancellable (unknown id or already finished)' });
      return;
    }
    case 'tools-changed': {
      host.broadcastToolsChanged();
      reply(id, true, { broadcast: true });
      return;
    }
    default:
      reply(id, false, undefined, { code: 'bad_request', message: 'Unknown ctrl kind' });
  }
}

// ---------------------------------------------------------------------------
// HTTP security middleware
// ---------------------------------------------------------------------------

interface AuthFailure {
  status: number;
  code: string;
  message: string;
  hint?: string;
}

function resolveIdentity(req: Request): RequestIdentity | AuthFailure {
  const bearer = extractBearer(req.headers.get('authorization'));
  if (!bearer) {
    return { status: 401, code: 'unauthorized', message: 'Missing bearer token.', hint: 'Pair via Settings → MCP → Connect AI Assistant (pair_client).' };
  }
  const hash = sha256Hex(bearer);
  const client = store.findClientByTokenHash(hash);
  if (client) {
    if (client.revoked) {
      return { status: 401, code: 'token_revoked', message: 'This client token has been revoked.' };
    }
    return { kind: 'client', clientId: client.clientId, name: client.name, tier: client.tier };
  }
  const pairing = store.findPairingByHash(hash);
  if (pairing) {
    if (pairing.used) return { status: 401, code: 'pairing_used', message: 'This pairing code was already used.' };
    if (Date.now() >= pairing.expiresAt) return { status: 401, code: 'pairing_expired', message: 'This pairing code has expired — generate a new one in Settings → MCP.' };
    return { kind: 'pairing', tier: pairing.tier, tokenHash: pairing.tokenHash };
  }
  return { status: 401, code: 'unknown_token', message: 'Unknown token.' };
}

/**
 * Failed-auth throttle (Task 13a) — implements the "brute-force capped" claim:
 * 30 failed authentication attempts within 60 s trip a 429 for the rest of
 * the sliding window. Global bucket (single-user desktop server); the window
 * slides over timestamps so memory stays bounded. Successful auths do NOT
 * clear the window (conservative — cannot be used to interleave brute force).
 */
export const AUTH_FAIL_WINDOW_MS = 60_000;
export const AUTH_FAIL_MAX = 30;

const authFailures: number[] = [];

function pruneAuthFailures(now: number): void {
  while (authFailures.length > 0 && now - authFailures[0] >= AUTH_FAIL_WINDOW_MS) {
    authFailures.shift();
  }
}

export const authThrottle = {
  isThrottled(): boolean {
    pruneAuthFailures(Date.now());
    return authFailures.length >= AUTH_FAIL_MAX;
  },
  recordFailure(): void {
    pruneAuthFailures(Date.now());
    authFailures.push(Date.now());
  },
  /** Test/ops hook: clear the sliding window. */
  reset(): void {
    authFailures.length = 0;
  },
};

function loopbackOriginAllowed(origin: string | null): boolean {
  if (!origin) return true; // non-browser clients (SDK, curl, stdio proxy)
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

function editorOriginAllowed(origin: string | null, requestHost: string | null): boolean {
  if (!origin) return true; // Electron/node bridges may omit Origin
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return false;
    const h = u.hostname;
    if (h === '127.0.0.1' || h === 'localhost' || h === '::1') return true;
    // gateway-forwarded same-origin: the preview page talks through the
    // Caddy gateway, so Origin host == the Host we received.
    if (requestHost) {
      const hostName = requestHost.split(':')[0].toLowerCase();
      if (hostName && h === hostName) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

interface WsData {
  pendingHello: boolean;
  editorSocket: EditorSocket | null;
}

export function createPixelForgeServer() {
  return Bun.serve<WsData>({
    port: PORT,
    hostname: HOST,
    idleTimeout: 90, // WS keepalive via editor pings (15 s interval)
    async fetch(request, server): Promise<Response> {
      const url = new URL(request.url);

      // ---- editor bridge WebSocket ------------------------------------
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (!editorOriginAllowed(request.headers.get('origin'), request.headers.get('host'))) {
          return new Response('forbidden origin', { status: 403 });
        }
        console.error(`[pf-mcp] ws upgrade from origin=${request.headers.get('origin') ?? 'none'} ua=${(request.headers.get('user-agent') ?? 'unknown').slice(0, 80)}`);
        const ok = server.upgrade(request, {
          data: { pendingHello: true, editorSocket: null },
        });
        if (ok) return undefined as unknown as Response;
        return new Response('upgrade failed', { status: 400 });
      }

      // ---- MCP over Streamable HTTP -----------------------------------
      if (url.pathname === '/mcp') {
        // Body cap FIRST (§5.5) so every later drain is bounded.
        if (request.method === 'POST' || request.method === 'PUT') {
          const len = Number(request.headers.get('content-length') ?? '-1');
          if (!Number.isFinite(len) || len < 0) {
            // request body was NOT read → close the connection so the next
            // request on a keep-alive socket cannot be poisoned by leftovers
            return json(411, { ok: false, error: { code: 'length_required', message: 'Content-Length is required.' } }, { close: true });
          }
          if (len > MAX_BODY_BYTES) {
            store.audit({ kind: 'security', clientId: null, clientName: 'anonymous', tool: 'oversized_body', tier: null, argsHash: null, ok: false, errorCode: 'payload_too_large', durationMs: 0, summary: `${len} bytes` });
            // drain the oversized body (bounded) so the client's pending write
            // completes and keep-alive sockets stay usable; close only when
            // the discard budget is exceeded
            const drained = await discardBody(request, 64 * 1024 * 1024);
            return json(413, { ok: false, error: { code: 'payload_too_large', message: 'Request body exceeds the 2 MB cap (§5.5).' } }, { close: !drained });
          }
        }
        // Host allowlist (DNS rebinding): rebound pages keep their Host.
        const reqHost = (request.headers.get('host') ?? '').toLowerCase();
        if (!MCP_HOSTS.has(reqHost)) {
          await drainBody(request);
          store.audit({ kind: 'security', clientId: null, clientName: 'anonymous', tool: 'host_rejected', tier: null, argsHash: null, ok: false, errorCode: 'dns_rebind_host', durationMs: 0, summary: `Host "${reqHost}"` });
          return json(403, { ok: false, error: { code: 'dns_rebind_host', message: 'MCP is bound to 127.0.0.1 — connect directly to the loopback endpoint.' } });
        }
        // Origin check (browser defense in depth; auth is the real gate).
        if (!loopbackOriginAllowed(request.headers.get('origin'))) {
          await drainBody(request);
          store.audit({ kind: 'security', clientId: null, clientName: 'anonymous', tool: 'origin_rejected', tier: null, argsHash: null, ok: false, errorCode: 'untrusted_origin', durationMs: 0, summary: null });
          return json(403, { ok: false, error: { code: 'untrusted_origin', message: 'Cross-origin MCP access is rejected.' } });
        }

        if (request.method === 'DELETE') {
          // session teardown — the SDK checks the session itself
          return host.handleDelete(request);
        }
        if (request.method !== 'POST' && request.method !== 'GET') {
          await drainBody(request);
          return json(405, { ok: false, error: { code: 'method_not_allowed', message: 'Use POST/GET/DELETE.' } });
        }

        const auth = resolveIdentity(request);
        if ('status' in auth) {
          await drainBody(request);
          // check BEFORE recording: exactly AUTH_FAIL_MAX failures are answered
          // 401; the failure AFTER the cap trips the 429 (no off-by-one).
          if (authThrottle.isThrottled()) {
            store.audit({ kind: 'security', clientId: null, clientName: 'anonymous', tool: 'auth_throttled', tier: null, argsHash: null, ok: false, errorCode: 'brute_force_cap', durationMs: 0, summary: null });
            return new Response(
              JSON.stringify({ ok: false, error: { code: 'auth_throttled', message: 'Too many failed authentication attempts — retry in a minute.' } }),
              { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } },
            );
          }
          authThrottle.recordFailure();
          store.audit({ kind: 'security', clientId: null, clientName: 'anonymous', tool: 'auth_failed', tier: null, argsHash: null, ok: false, errorCode: auth.code, durationMs: 0, summary: null });
          return json(auth.status, { ok: false, error: { code: auth.code, message: auth.message, hint: auth.hint } });
        }
        try {
          return await host.handleHttp(request, auth);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'MCP transport failure';
          return json(500, { ok: false, error: { code: 'mcp_transport', message } });
        }
      }

      // ---- health -------------------------------------------------------
      if (url.pathname === '/health') {
        return json(200, { ok: true, service: 'pixelforge-mcp', protocol: 1, endpoint: endpointUrl });
      }

      return json(404, { ok: false, error: { code: 'not_found', message: 'Unknown path' } });
    },

    websocket: {
      open(ws) {
        // hello timeout is enforced by EditorLink.attach after the first
        // message — a silent socket is dropped there.
        void ws;
      },
      message(ws, raw) {
        let msg: EditorInbound;
        try {
          msg = JSON.parse(String(raw)) as EditorInbound;
        } catch {
          ws.close(4002, 'malformed json');
          return;
        }
        const data = ws.data;
        if (msg.type === 'hello') {
          if (!data.pendingHello) return;
          const adapter: EditorSocket = {
            send: (json: string) => ws.send(json),
            close: (code: number, reason: string) => ws.close(code, reason),
          };
          const res = link.attach(adapter);
          if (!res.ok) {
            ws.close(4000, res.reason === 'editor_already_connected' ? 'another editor is connected' : 'rejected');
            return;
          }
          data.pendingHello = false;
          data.editorSocket = adapter;
          // hello arbitration: takeover flips ownership, plain hello from a
          // second connection is rejected inside handleInbound
          link.handleInbound(msg, adapter);
          if (typeof msg.mcpEnabled === 'boolean') mcpEnabled = msg.mcpEnabled;
          if (!link.isEditor(adapter)) return; // candidate was rejected — no hello-ok to a dead socket
          link.send({
            type: 'hello-ok',
            server: {
              mcpEnabled,
              endpoint: endpointUrl,
              clientsPaired: store.listClients().filter((c) => !c.revoked).length,
              clientsConnected: host.sessionCount,
              editorConnected: true,
              lastStateHash: link.lastStateHash,
              startedAt,
            },
          });
          return;
        }
        if (data.pendingHello) {
          ws.close(4003, 'hello required');
          return;
        }
        switch (msg.type) {
          case 'ping':
          case 'tool-result':
          case 'event':
            link.handleInbound(msg, data.editorSocket ?? undefined);
            return;
          case 'status-update':
            if (typeof msg.mcpEnabled === 'boolean') mcpEnabled = msg.mcpEnabled;
            link.send({
              type: 'status',
              server: {
                mcpEnabled,
                endpoint: endpointUrl,
                clientsPaired: store.listClients().filter((c) => !c.revoked).length,
                clientsConnected: host.sessionCount,
                editorConnected: link.connected,
                lastStateHash: link.lastStateHash,
                startedAt,
              },
            });
            return;
          case 'ctrl-request':
            if (!data.editorSocket || !link.isEditor(data.editorSocket)) return; // only the owner drives the ctrl plane
            handleCtrl(msg, (id, ok, payload, error) => {
              link.send({ type: 'ctrl-result', id, ok, data: payload, error });
            });
            return;
          default:
            return;
        }
      },
      close(ws) {
        const data = ws.data;
        if (data.editorSocket) link.detach(data.editorSocket);
      },
    },
  });
}

/** Drain an already-capped request body so keep-alive sockets stay sane. */
async function drainBody(request: Request): Promise<void> {
  try {
    await request.text();
  } catch {
    /* already aborted — nothing to drain */
  }
}

/**
 * Discard an oversized body chunk-by-chunk (no buffering) up to maxDiscard
 * bytes. Returns true when fully drained (connection reusable), false when
 * the budget was exceeded (caller should close the connection).
 */
async function discardBody(request: Request, maxDiscard: number): Promise<boolean> {
  try {
    const body = request.body;
    if (!body) return true;
    const reader = body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      total += value?.byteLength ?? 0;
      if (total > maxDiscard) {
        await reader.cancel().catch(() => {});
        return false;
      }
    }
  } catch {
    return false;
  }
}

function json(status: number, body: unknown, opts: { close?: boolean } = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(opts.close ? { connection: 'close' } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

if (import.meta.main) {
  // Long-lived local server: transient stream cancellations (SSE teardown,
  // reader release races inside the SDK transport) must never take the
  // process down — log and continue.
  process.on('unhandledRejection', (reason) => {
    console.error('[mcp] unhandled rejection:', reason instanceof Error ? `${reason.message}` : String(reason));
  });
  process.on('uncaughtException', (err) => {
    console.error('[mcp] uncaught exception:', err instanceof Error ? err.stack : String(err));
  });

  const server = createPixelForgeServer();
  console.log(`[mcp] PixelForge MCP server on ${endpointUrl} (pid ${process.pid})`);
  console.log(`[mcp] data dir: ${store.dataDir}`);
  const shutdown = () => {
    console.log('[mcp] shutting down…');
    void host.shutdown();
    server.stop(true);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
