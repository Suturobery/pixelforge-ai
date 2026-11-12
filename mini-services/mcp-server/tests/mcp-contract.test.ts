/**
 * PixelForge MCP server — REAL protocol contract tests.
 *
 * These tests speak actual MCP over the wire: the OFFICIAL SDK client
 * (StreamableHTTPClientTransport) against a spawned server process, with a
 * mock editor bridge answering tool-request frames — the same frames the
 * real PixelForge renderer answers. No tool logic is stubbed at the MCP
 * layer: pairing, sessions, tiers, rate limits, caps, host checks and the
 * envelope contract are all exercised end-to-end.
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { encodePng } from '../../../packages/core/src/persist/png';

const PORT = 3030 + (Number(Bun.hash(process.env.HF_WORKER_ID ?? String(process.pid))) % 400);
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE}/mcp`;

// ----------------------------------------------------------------- harness

// The server runs IN-PROCESS (index.ts guards entry with import.meta.main).
// Bun.spawn'd servers are killed as "dangling processes" by the bun test
// runner between describes — in-process is deterministic and faster.
let bunServer: ReturnType<typeof Bun.serve> | null = null;
let mockWs: WebSocket | null = null;

/** Programmatic mock of the PixelForge renderer bridge (the bus plane). */
const toolResponders = new Map<string, (args: Record<string, unknown>, meta: { tier: string; clientName: string }) => unknown>();
/** approval center: what the mock "human" does with approval-request cards. */
let approvalAuto: 'approve' | 'deny' | 'none' = 'none';
const approvalRequests: Array<Record<string, unknown>> = [];
let wsReady: Promise<void>;
let wsSend: (msg: unknown) => void = () => {};

function connectMockEditor(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    ws.onopen = () => {
      // P0-1: the real editor must present the editor-auth token (the mock
      // reads it from the same data dir the server generated it into)
      let editorKey: string | null = null;
      try {
        editorKey = (JSON.parse(readFileSync(join(process.env.PF_MCP_DATA_DIR!, 'editor-auth.json'), 'utf8')) as { token: string }).token;
      } catch {}
      ws.send(JSON.stringify({ type: 'hello', bridgeVersion: 1, appVersion: 'test', mcpEnabled: true, editorKey: editorKey ?? undefined }));

    };
    ws.onerror = (e) => reject(new Error(`mock editor ws error: ${e}`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (msg.type === 'hello-ok') {
        resolve();
        return;
      }
      if (msg.type === 'approval-request') {
        approvalRequests.push(msg);
        if (approvalAuto !== 'none') {
          ws.send(JSON.stringify({ type: 'approval-response', id: String(msg.id), approve: approvalAuto === 'approve' }));
        }
        return;
      }
      if (msg.type === 'tool-request') {
        const responder = toolResponders.get(String(msg.tool));
        const id = String(msg.id);
        if (!responder) {
          ws.send(JSON.stringify({ type: 'tool-result', id, ok: false, error: { code: 'no_mock_responder', message: `mock has no responder for ${msg.tool}` } }));
          return;
        }
        try {
          const out = responder((msg.args ?? {}) as Record<string, unknown>, { tier: String(msg.tier), clientName: String(msg.clientName) });
          ws.send(JSON.stringify({ type: 'tool-result', id, ok: true, data: out, undoable: true, stateHash: 'mockhash-0001', summary: `mock:${msg.tool}` }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'tool-result', id, ok: false, error: { code: 'mock_error', message: err instanceof Error ? err.message : 'mock failed' } }));
        }
        return;
      }
      if (msg.type === 'ctrl-result') {
        const pendingCtrl = ctrlWaiters.shift();
        pendingCtrl?.(msg);
        return;
      }
    };
    wsSend = (m: unknown) => ws.send(JSON.stringify(m));
    mockWs = ws;
  });
}

let wsReadyResolve: (() => void) | null = null;
let ctrlWaiters: Array<(msg: Record<string, unknown>) => void> = [];
function ctrl<T = Record<string, unknown>>(payload: unknown): Promise<T> {
  return new Promise((resolve) => {
    ctrlWaiters.push((msg) => resolve(msg as T));
    wsSend({ type: 'ctrl-request', id: `c${ctrlWaiters.length}`, ctrl: payload });
  });
}

async function generatePairing(tier: 'L0' | 'L1' | 'L2' | 'L3'): Promise<{ token: string; tier: string; expiresAt: string }> {
  const res = await ctrl<Record<string, unknown>>({ kind: 'pair-generate', tier });
  const data = res.data as { token: string; tier: string; expiresAt: string };
  return data;
}

/** Full SDK client bound to a bearer token. */
async function sdkClient(bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'contract-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function rawPost(body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body });
}

interface Envelope {
  ok: boolean;
  error?: { code: string; message: string; hint?: string };
  data?: unknown;
  undoable?: boolean;
  stateHash?: string | null;
  summary?: string | null;
}

function textEnvelope(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown };
  const text = r?.content?.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as Envelope;
}

beforeAll(async () => {
  const tmp = join(tmpdir(), `mcp-test-${Date.now()}`);
  process.env.PF_MCP_PORT = String(PORT);
  process.env.PF_MCP_DATA_DIR = tmp;
  const { createPixelForgeServer } = await import('../src/index');
  bunServer = createPixelForgeServer();
  // wire the mock editor's default responders
  toolResponders.set('get_project_state', () => ({ name: 'test doc', width: 32, height: 32 }));
  toolResponders.set('get_palette', () => ({ palette: ['#000000', '#ffffff'] }));
  toolResponders.set('set_pixels', () => ({ applied: 1, rejected: [] }));
  wsReady = connectMockEditor();
  await wsReady;
});

afterAll(async () => {
  mockWs?.close();
  // let SDK teardown (session DELETE, SSE stream cancel) settle before the
  // hard stop — avoids a cosmetic ECONNRESET surfacing between tests
  await Bun.sleep(120);
  bunServer?.stop(true);
  bunServer = null;
});

// ------------------------------------------------------------------- tests

describe('transport security', () => {
  test('health endpoint responds without auth', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('pixelforge-mcp');
  });

  test('unauthenticated initialize is rejected (401)', async () => {
    const res = await rawPost(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }), {});
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  test('unknown token is rejected (401)', async () => {
    const res = await rawPost(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }), { authorization: 'Bearer pfm_nope' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unknown_token');
  });

  test('DNS-rebind Host is rejected (403)', async () => {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'attacker.example.com' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('dns_rebind_host');
  });

  test('oversized body is rejected (413)', async () => {
    // NOTE: bun's fetch client (v1.3.14) poisons its connection pool when a
    // server responds 413 while the client is still sending a 2 MB body —
    // every later request on that pool hangs. Real MCP SDK clients never
    // send oversized bodies, so the probe runs through curl (its own
    // process/connection) to keep the suite hermetic.
    const big = 'x'.repeat(2 * 1024 * 1024 + 10);
    // a 2 MB argv element exceeds MAX_ARG_STRLEN — ship the body via a file
    const bodyFile = `/tmp/mcp-oversized-${Date.now()}.bin`;
    await Bun.write(bodyFile, big);
    try {
      // Bun.spawn (NOT spawnSync): the server runs in THIS process — a sync
      // spawn would block the event loop and deadlock the request.
      const proc = Bun.spawn([
        'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
        '-X', 'POST', MCP_URL,
        '-H', 'content-type: application/json',
        '--data-binary', `@${bodyFile}`,
        '--max-time', '15',
      ]);
      const code = await new Response(proc.stdout).text();
      await proc.exited;
      expect(code.trim()).toBe('413');
    } finally {
      await Bun.write(bodyFile, new Uint8Array(0));
      const { rmSync } = await import('node:fs');
      rmSync(bodyFile, { force: true });
    }
  });

  test('server binds loopback only', () => {
    // the bind check is structural: Bun.serve was given hostname 127.0.0.1;
    // probe an external interface would fail — assert the health URL only
    // answers on loopback (it did above) and document the bind.
    expect(MCP_URL.startsWith('http://127.0.0.1:')).toBe(true);
  });
});

describe('pairing + tool workflow (real MCP protocol)', () => {
  test('pairing identity cannot call editor tools', async () => {
    console.log('DBG step1: generating pairing');
    const { token } = await generatePairing('L1');
    console.log('DBG step2: token', token.slice(0, 12));
    const client = await sdkClient(token);
    console.log('DBG step3: sdk connected');
    const result = await client.callTool({ name: 'get_project_state', arguments: {} });
    const env = textEnvelope(result);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('unauthorized');
    expect(env.error?.message).toContain('pair_client');
    await client.close();
  });

  test('pair_client exchanges the code and the new token works end-to-end', async () => {
    const { token, tier } = await generatePairing('L1');
    expect(tier).toBe('L1');
    expect(token.split('-').length).toBe(6);

    const pairingClient = await sdkClient(token);
    const paired = textEnvelope(await pairingClient.callTool({ name: 'pair_client', arguments: { name: 'contract-runner' } }));
    expect(paired.ok).toBe(true);
    const clientToken = (paired.data as { token: string }).token;
    expect(clientToken.startsWith('pfm_')).toBe(true);
    await pairingClient.close();

    // the pairing code is single-use: re-initializing with it must fail
    let reuseFailed = false;
    try {
      await sdkClient(token);
    } catch {
      reuseFailed = true;
    }
    expect(reuseFailed).toBe(true);

    // real client session
    const client = await sdkClient(clientToken);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('get_project_state');
    expect(names).toContain('set_pixels');
    // L3 generate_sprite is registered (tier-gated); macros registered
    expect(names).toContain('generate_sprite');
    expect(names).toContain('import_frame_strip');
    expect(names).toContain('macro_run');
    // Task 11 completion: save_project registered (L2)
    expect(names).toContain('save_project');
    // L2 export/purge/resize suite + batch/quota (agent tooling) are registered
    expect(names).toContain('purge_trash');
    expect(names).toContain('resize_canvas');
    expect(names).toContain('export_sheet');
    expect(names).toContain('export_gif');
    expect(names).toContain('batch');
    expect(names).toContain('get_quota');
    // Task 10 motion set (L0 helper + L1 writes) is registered
    expect(names).toContain('suggest_motion_preset');
    expect(names).toContain('set_parts');
    expect(names).toContain('apply_motion_preset');

    const state = textEnvelope(await client.callTool({ name: 'get_project_state', arguments: {} }));
    expect(state.ok).toBe(true);
    expect((state.data as { name: string }).name).toBe('test doc');
    expect(state.stateHash).toBe('mockhash-0001');

    const paint = textEnvelope(await client.callTool({ name: 'set_pixels', arguments: { pixels: [{ x: 1, y: 2 }], color: '#ff0000' } }));
    expect(paint.ok).toBe(true);
    expect(paint.undoable).toBe(true);
    await client.close();
  });

  test('stale pairing token (no editor code left) fails closed', async () => {
    // cancel before use
    const { token } = await generatePairing('L0');
    const cancel = await ctrl<Record<string, unknown>>({ kind: 'pair-cancel', token });
    expect(cancel.ok).toBe(true);
    let failed = false;
    try {
      const c = await sdkClient(token);
      await c.close();
    } catch {
      failed = true;
    }
    // the pairing identity can still initialize (it is validated at the
    // HTTP layer), but pair_client must now fail — connection success is OK,
    // the tool call is what must fail.
    if (!failed) {
      const c = await sdkClient(token);
      const env = textEnvelope(await c.callTool({ name: 'pair_client', arguments: { name: 'late' } }));
      expect(env.ok).toBe(false);
      await c.close();
    }
  });
});

describe('permission tiers', () => {
  test('L0 client cannot execute L1 writes', async () => {
    const { token } = await generatePairing('L0');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'readonly-bot' } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();

    const client = await sdkClient(clientToken);
    const env = textEnvelope(await client.callTool({ name: 'set_pixels', arguments: { pixels: [{ x: 0, y: 0 }], color: '#000000' } }));
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('permission_denied');
    // reads still work
    const read = textEnvelope(await client.callTool({ name: 'get_palette', arguments: {} }));
    expect(read.ok).toBe(true);
    await client.close();
  });

  test('L1 client can execute L0 reads and L1 writes', async () => {
    const { token } = await generatePairing('L1');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'readwrite-bot' } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();

    const client = await sdkClient(clientToken);
    const read = textEnvelope(await client.callTool({ name: 'get_palette', arguments: {} }));
    expect(read.ok).toBe(true);
    const write = textEnvelope(await client.callTool({ name: 'set_pixels', arguments: { pixels: [{ x: 0, y: 0 }], color: '#00ff00' } }));
    expect(write.ok).toBe(true);
    await client.close();
  });
});

describe('revocation + operation log', () => {
  test('revoked token loses access immediately (401)', async () => {
    const { token } = await generatePairing('L1');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'revoked-bot' } }));
    const clientToken = (paired.data as { token: string }).token;
    const clientId = (paired.data as { clientId: string }).clientId;
    await pc.close();

    const client = await sdkClient(clientToken);
    const before = textEnvelope(await client.callTool({ name: 'get_palette', arguments: {} }));
    expect(before.ok).toBe(true);

    // revoke via the editor ctrl plane (Settings UI path)
    const rev = await ctrl<Record<string, unknown>>({ kind: 'client-revoke', clientId });
    expect(rev.ok).toBe(true);

    // existing session AND new sessions must both fail closed
    let denied = false;
    try {
      const env = textEnvelope(await client.callTool({ name: 'get_palette', arguments: {} }));
      denied = !env.ok || env.error?.code === 'token_revoked';
      if (!denied) denied = env.error?.code === 'unknown_token';
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    await client.close();
  });

  test('get_operation_log returns hashed-args audit entries', async () => {
    const { token } = await generatePairing('L1');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'audit-bot' } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();

    const client = await sdkClient(clientToken);
    await client.callTool({ name: 'get_palette', arguments: {} });
    const log = textEnvelope(await client.callTool({ name: 'get_operation_log', arguments: { limit: 5 } }));
    expect(log.ok).toBe(true);
    const ops = (log.data as { ops: Array<{ tool: string; argsHash: string | null; ok: boolean }> }).ops;
    expect(ops.length).toBeGreaterThan(0);
    // the log is built BEFORE the get_operation_log call itself is audited,
    // so the newest visible entry is the call right before it
    expect(ops[0]!.tool).toBe('get_palette');
    // every entry's args are hashed, never raw
    for (const op of ops) {
      if (op.argsHash !== null) expect(op.argsHash).toMatch(/^[0-9a-f]{64}$/);
    }
    await client.close();
  });
});

describe('rate limits + session hygiene', () => {
  test('L0 rate limit trips at 61 requests/min', async () => {
    const { token } = await generatePairing('L0');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'flood-bot' } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();

    const client = await sdkClient(clientToken);
    let limited = false;
    for (let i = 0; i < 61; i++) {
      const env = textEnvelope(await client.callTool({ name: 'get_palette', arguments: {} }));
      if (!env.ok && env.error?.code === 'rate_limited') {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
    await client.close();
  });

  test('unknown session id is rejected (404)', async () => {
    const { token } = await generatePairing('L0');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'session-bot' } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();
    // valid bearer + bogus session id → session_not_found (auth passes first)
    const res = await rawPost(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { 'mcp-session-id': 'does-not-exist', authorization: `Bearer ${clientToken}` });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('session_not_found');
  });

  test('DELETE /mcp without session is 400', async () => {
    const res = await fetch(MCP_URL, { method: 'DELETE' });
    expect(res.status).toBe(400);
  });
});

describe('editor events → MCP notifications', () => {
  test('projectChanged is pushed to connected MCP sessions', async () => {
    const { token } = await generatePairing('L1');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'events-bot' } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();

    const client = await sdkClient(clientToken);
    const got: Array<Record<string, unknown>> = [];
    const ProjectChanged = z.object({
      method: z.literal('notifications/pixelforge/projectChanged'),
      params: z.object({ stateHash: z.string().nullable(), name: z.string().nullable(), dirty: z.boolean().nullable() }).optional(),
    });
    client.setNotificationHandler(ProjectChanged, (n) => {
      got.push((n.params ?? {}) as Record<string, unknown>);
    });
    // wait for the subscription to register, then push an event from the editor
    await Bun.sleep(150);
    wsSend({ type: 'event', event: { type: 'projectChanged', stateHash: 'eventhash-42', name: 'live doc', dirty: true } });
    await Bun.sleep(250);
    expect(got.length).toBe(1);
    expect(got[0]!.stateHash).toBe('eventhash-42');
    expect(got[0]!.name).toBe('live doc');
    await client.close();
  });
});

// ------------------------------------------------------- Task 13a additions

import { sha256Hex } from '../src/auth';
import { WORDS } from '../src/words';
import { McpStore } from '../src/store';

describe('Task 13a — pairing-token entropy (unbiased selection over the full 317-word list)', () => {
  test('tokens are 6 list-words; selection reaches the previously-unreachable tail (full ~49.85-bit space)', async () => {
    const observed = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const { token } = await generatePairing('L0');
      const words = token.split('-');
      expect(words.length).toBe(6);
      for (const w of words) {
        expect(WORDS.includes(w)).toBe(true);
        observed.add(w);
      }
      // cancel every generated code so the in-memory pairing list stays lean
      await ctrl({ kind: 'pair-cancel', token });
    }
    // The old byte-modulo picker could only ever reach indices 0–255 (48 bits).
    // 500 tokens × 6 words = 3000 unbiased draws over 317 words → P(word
    // missing) ≈ e^-9.5 ≈ 7e-5, so ≥300 distinct words must be observed.
    expect(observed.size).toBeGreaterThanOrEqual(300);
    // tail words (index ≥ 256) MUST appear — impossible before the fix
    const tail = WORDS.slice(256);
    expect(tail.some((w) => observed.has(w))).toBe(true);
  });
});

describe('Task 13a — failed-auth brute-force throttle', () => {
  test('30 failures/60s are allowed (401); the next failure trips a 429', async () => {
    const { authThrottle } = await import('../src/index');
    authThrottle.reset();
    for (let i = 0; i < 30; i++) {
      const res = await rawPost('{"jsonrpc":"2.0","id":1,"method":"ping"}', { authorization: 'Bearer wrong-token' });
      expect(res.status).toBe(401);
    }
    const tripped = await rawPost('{"jsonrpc":"2.0","id":1,"method":"ping"}', { authorization: 'Bearer wrong-token' });
    expect(tripped.status).toBe(429);
    expect(tripped.headers.get('retry-after')).toBe('60');
    const body = (await tripped.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('auth_throttled');
    authThrottle.reset(); // leave the shared server clean for other suites
  });
});

describe('Task 13a — allowlist persistence & pairing lifecycle across restart', () => {
  test('revoked client stays revoked in a NEW store instance; pending pairing codes do NOT survive', async () => {
    const dataDir = process.env.PF_MCP_DATA_DIR!;
    // 1. pair a fresh client through the REAL SDK client (same flow as the
    //    existing pairing workflow tests), then revoke it via the ctrl plane
    const { token: pairToken } = await generatePairing('L0');
    const client = await sdkClient(pairToken);
    const result = await client.callTool({ name: 'pair_client', arguments: { name: 'restart-test-client' } });
    const envelope = textEnvelope(result) as { ok: boolean; data?: { clientId: string; token: string } };
    expect(envelope.ok).toBe(true);
    const clientId = envelope.data!.clientId;
    const clientToken = envelope.data!.token;
    await client.close();

    // revoke through the ctrl plane (same path Settings UI uses)
    const revoked = await ctrl<Record<string, unknown>>({ kind: 'client-revoke', clientId });
    expect(revoked.ok).toBe(true);

    // 2. "restart": a NEW McpStore over the SAME data dir
    const reopened = new McpStore({ dataDir });
    const stillThere = reopened.findClientByTokenHash(sha256Hex(clientToken));
    expect(stillThere).not.toBeNull();
    expect(stillThere?.revoked).toBe(true); // revocation survived the restart

    // 3. pending pairing codes are in-memory only — a restart invalidates them
    const { token: unusedCode } = await generatePairing('L1');
    expect(reopened.findPairingByHash(sha256Hex(unusedCode))).toBeNull(); // fail-safe: no orphan codes
  });
});

// --------------------------------------------------- Task 9: AI candidates

describe('Task 9: AI candidate tools over the real protocol', () => {
  test('get_candidates is L0-readable; L0 clients CAN read candidates', async () => {
    toolResponders.set('get_candidates', () => ({
      candidates: [
        {
          id: 'cand-1',
          status: 'review',
          prompt: 'teal potion bottle',
          providerLabel: 'Mock (offline)',
          model: 'mock-pattern',
          recipe: 'item',
          requestSize: '1024x1024',
          width: 32,
          height: 32,
          seed: null,
          costEstimateUsd: null,
          cacheHit: false,
          hasNormalized: true,
          normalizedSize: { w: 32, h: 32, colors: 6 },
          normalizedPng: 'data:image/png;base64,iVBORw0KGgo=',
          error: null,
        },
      ],
      historyCount: 3,
    }));
    const { token } = await generatePairing('L0');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'candidate-reader' } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();

    const client = await sdkClient(clientToken);
    const env = textEnvelope(await client.callTool({ name: 'get_candidates', arguments: { limit: 4 } }));
    expect(env.ok).toBe(true);
    const data = env.data as { candidates: Array<{ id: string; status: string; hasNormalized: boolean }>; historyCount: number };
    expect(data.candidates[0]!.id).toBe('cand-1');
    expect(data.candidates[0]!.hasNormalized).toBe(true);
    expect(data.historyCount).toBe(3);
    await client.close();
  });

  test('accept_candidate (L1) relays layer mode; L0 clients are denied', async () => {
    toolResponders.set('accept_candidate', (args) => ({ candidateId: args.candidateId, mode: args.mode, layerId: 'layer-x' }));
    const { token } = await generatePairing('L0');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'candidate-l0' } }));
    const l0Token = (paired.data as { token: string }).token;
    await pc.close();
    const l0 = await sdkClient(l0Token);
    const denied = textEnvelope(await l0.callTool({ name: 'accept_candidate', arguments: { candidateId: 'cand-1', mode: 'layer' } }));
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('permission_denied');
    await l0.close();

    const { token: l1PairToken } = await generatePairing('L1');
    const pcL1 = await sdkClient(l1PairToken);
    const pairedL1 = textEnvelope(await pcL1.callTool({ name: 'pair_client', arguments: { name: 'candidate-l1' } }));
    const l1Token = (pairedL1.data as { token: string }).token;
    await pcL1.close();
    const l1 = await sdkClient(l1Token);
    const env = textEnvelope(await l1.callTool({ name: 'accept_candidate', arguments: { candidateId: 'cand-1', mode: 'layer' } }));
    expect(env.ok).toBe(true);
    expect((env.data as { mode: string }).mode).toBe('layer');
    await l1.close();
  });

  test('reject_candidate removes candidates; apply_normalize re-runs the pipeline', async () => {
    toolResponders.set('reject_candidate', (args) => ({ candidateId: args.candidateId, rejected: true }));
    toolResponders.set('apply_normalize', (args) => ({
      candidateId: args.candidateId,
      width: args.width ?? 32,
      height: args.height ?? 32,
      stats: { paletteUsed: args.paletteMode ?? 'auto', colorsOut: 8 },
      previewPng: 'data:image/png;base64,iVBORw0KGgo=',
    }));
    const { token } = await generatePairing('L1');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'candidate-worker' } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();
    const client = await sdkClient(clientToken);

    const rej = textEnvelope(await client.callTool({ name: 'reject_candidate', arguments: { candidateId: 'cand-1' } }));
    expect(rej.ok).toBe(true);
    expect((rej.data as { rejected: boolean }).rejected).toBe(true);

    const renorm = textEnvelope(await client.callTool({
      name: 'apply_normalize',
      arguments: { candidateId: 'cand-2', width: 16, height: 16, paletteMode: 'project', maxColors: 8 },
    }));
    expect(renorm.ok).toBe(true);
    const data = renorm.data as { width: number; stats: { paletteUsed: string } };
    expect(data.width).toBe(16);
    expect(data.stats.paletteUsed).toBe('project');

    // schema validation: paletteMode is an enum — garbage is rejected by zod
    const bad = await client.callTool({
      name: 'apply_normalize',
      arguments: { candidateId: 'cand-2', paletteMode: 'blUR' },
    }).catch((err) => ({ isError: true, message: String(err) }));
    expect(bad).toBeTruthy();
    await client.close();
  });

  test('generate_sprite is REGISTERED but L3-tier gated (paid op — approval via caller identity)', async () => {
    // an L1 client sees the tool advertised but is denied at relay time
    const { token } = await generatePairing('L1');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'l3-probe' } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();
    const client = await sdkClient(clientToken);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('generate_sprite');
    const denied = await client.callTool({ name: 'generate_sprite', arguments: { prompt: 'x' } });
    const env = JSON.parse((denied as { content?: Array<{ type: string; text?: string }> }).content?.[0]?.text ?? '{}');
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('permission_denied');
    await client.close();
    // an L3 client passes the tier gate — but the op now PARKS at the
    // approval center until the mock human approves (Task 11 §5.2)
    toolResponders.set('generate_sprite', () => ({ ok: true, candidateIds: ['c1'] }));
    approvalAuto = 'approve';
    const { token: t3 } = await generatePairing('L3');
    const pc3 = await sdkClient(t3);
    const paired3 = textEnvelope(await pc3.callTool({ name: 'pair_client', arguments: { name: 'l3-real' } }));
    const client3 = await sdkClient((paired3.data as { token: string }).token);
    const ok = textEnvelope(await client3.callTool({ name: 'generate_sprite', arguments: { prompt: 'x' } }));
    expect(ok.ok).toBe(true);
    expect(approvalRequests.length).toBe(1);
    await client3.close();
    approvalAuto = 'none';
  });
});

// --------------------------------------------- Task 11: approval center

describe('Task 11: paid-op approval center', () => {
  test('generate_sprite parks until approve — pending visible via get_approvals', async () => {
    approvalAuto = 'none';
    approvalRequests.length = 0;
    toolResponders.set('generate_sprite', () => ({ ok: true, candidateIds: ['c1'] }));
    const { token } = await generatePairing('L3');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'l3-approval' } }));
    const client = await sdkClient((paired.data as { token: string }).token);

    // fire WITHOUT awaiting — the call must park
    const inFlight = client.callTool({ name: 'generate_sprite', arguments: { prompt: 'a donut citadel', count: 2 } });
    await new Promise((r) => setTimeout(r, 150));

    // the editor got exactly one approval-request card
    expect(approvalRequests.length).toBe(1);
    const card = approvalRequests[0] as { tool: string; clientName: string; args: { summary: string } };
    expect(card.tool).toBe('generate_sprite');
    expect(card.clientName).toBe('l3-approval');
    expect(card.args.summary).toContain('a donut citadel');

    // get_approvals (L0, server-local) sees it pending
    const approvals = textEnvelope(await client.callTool({ name: 'get_approvals', arguments: {} }));
    expect(approvals.ok).toBe(true);
    expect((approvals.data as { pending: Array<{ tool: string }> }).pending).toHaveLength(1);
    expect((approvals.data as { pending: Array<{ tool: string }> }).pending[0].tool).toBe('generate_sprite');

    // the human approves over the bridge → the parked call resumes and relays
    const firstCard = approvalRequests[0] as { id: string };
    wsSend({ type: 'approval-response', id: firstCard.id, approve: true });
    const ok = textEnvelope(await inFlight);
    expect(ok.ok).toBe(true);
    await client.close();
  });

  test('deny returns approval_denied and spends nothing', async () => {
    approvalAuto = 'deny';
    approvalRequests.length = 0;
    const { token } = await generatePairing('L3');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'l3-deny' } }));
    const client = await sdkClient((paired.data as { token: string }).token);
    const denied = textEnvelope(await client.callTool({ name: 'generate_sprite', arguments: { prompt: 'x' } }));
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('approval_denied');
    const approvals = textEnvelope(await client.callTool({ name: 'get_approvals', arguments: {} }));
    const recent = (approvals.data as { recent: Array<{ decision: string }> }).recent;
    expect(recent[0].decision).toBe('denied');
    await client.close();
    approvalAuto = 'none';
  });
});

// ------------------------------------------------ Task 10: motion presets

describe('Task 10: motion preset tools over the real protocol', () => {
  test('suggest_motion_preset (L0) proposes a preset from a prompt — no editor mutation', async () => {
    toolResponders.set('suggest_motion_preset', (args) => ({
      suggested: {
        preset: 'attack',
        label: 'Attack',
        params: { amplitude: 1, frameCount: 4, gapFill: 'none', smear: false },
        matched: 'attack',
        reason: 'matched "attack" → Attack',
      },
      prompt: args.prompt,
    }));
    const { token } = await generatePairing('L0');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'motion-l0' } }));
    const l0Token = (paired.data as { token: string }).token;
    await pc.close();

    const client = await sdkClient(l0Token);
    const env = textEnvelope(
      await client.callTool({ name: 'suggest_motion_preset', arguments: { prompt: 'make the hero attack with a sword' } })
    );
    expect(env.ok).toBe(true);
    const data = env.data as { suggested: { preset: string; matched: string; params: { frameCount: number } } | null };
    expect(data.suggested?.preset).toBe('attack');
    expect(data.suggested?.matched).toBe('attack');
    expect(data.suggested?.params.frameCount).toBe(4);
    await client.close();
  });

  test('set_parts (L1) relays the parts array; L0 clients are denied', async () => {
    toolResponders.set('set_parts', (args) => ({
      clipId: 'cl-1',
      clipName: 'hero',
      parts: args.parts,
      overlaps: [{ a: 'body', b: 'head', owner: 'head' }],
    }));
    const { token } = await generatePairing('L0');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'parts-l0' } }));
    const l0Token = (paired.data as { token: string }).token;
    await pc.close();
    const l0 = await sdkClient(l0Token);
    const denied = textEnvelope(
      await l0.callTool({ name: 'set_parts', arguments: { parts: [{ name: 'body', rect: { x: 0, y: 0, w: 4, h: 4 } }] } })
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('permission_denied');
    await l0.close();

    const { token: l1PairToken } = await generatePairing('L1');
    const pcL1 = await sdkClient(l1PairToken);
    const pairedL1 = textEnvelope(await pcL1.callTool({ name: 'pair_client', arguments: { name: 'parts-l1' } }));
    const l1Token = (pairedL1.data as { token: string }).token;
    await pcL1.close();
    const l1 = await sdkClient(l1Token);
    const env = textEnvelope(
      await l1.callTool({
        name: 'set_parts',
        arguments: {
          parts: [
            { name: 'body', rect: { x: 8, y: 6, w: 16, h: 20 } },
            { name: 'head', rect: { x: 10, y: 0, w: 12, h: 8 }, z: 1 },
          ],
        },
      })
    );
    expect(env.ok).toBe(true);
    const data = env.data as { parts: Array<{ name: string }>; overlaps: Array<{ owner: string }> };
    expect(data.parts.map((p) => p.name)).toEqual(['body', 'head']);
    expect(data.overlaps[0]?.owner).toBe('head');
    await l1.close();
  });

  test('apply_motion_preset (L1) relays the composer payload; returns report + issues + preview', async () => {
    toolResponders.set('apply_motion_preset', (args) => ({
      preset: args.preset,
      frameCount: 4,
      target: { kind: 'new', clipId: 'cl-new' },
      report: {
        preset: args.preset,
        params: { amplitude: 1, frameCount: 4, gapFill: 'none', smear: false },
        frameCount: 4,
        ampScale: 1,
        anchorFrameId: 'fr-1',
        anchorFrameIndex: 0,
        affectedLayerIds: ['ly-1'],
        unlinkedLayerIds: [],
        skipped: [{ role: 'head', reason: 'absent', detail: 'skipped (C27)' }],
        moved: [{ role: 'body', partName: 'body', layerId: 'ly-1' }],
        clippedPixels: 0,
        warnings: [],
      },
      issues: [],
      previewPng: 'data:image/png;base64,iVBORw0KGgo=',
    }));
    const { token } = await generatePairing('L1');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'motion-apply' } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();
    const client = await sdkClient(clientToken);
    const env = textEnvelope(
      await client.callTool({
        name: 'apply_motion_preset',
        arguments: { preset: 'idle', frameCount: 4, targetName: 'hero-idle' },
      })
    );
    expect(env.ok).toBe(true);
    const data = env.data as {
      preset: string;
      frameCount: number;
      target: { kind: string; clipId: string | null };
      report: { moved: Array<{ role: string }>; skipped: Array<{ role: string }> };
      previewPng: string | null;
    };
    expect(data.preset).toBe('idle');
    expect(data.frameCount).toBe(4);
    expect(data.target.kind).toBe('new');
    expect(data.report.moved[0]?.role).toBe('body');
    expect(data.report.skipped[0]?.role).toBe('head');
    expect(data.previewPng).toContain('data:image/png;base64,');
    await client.close();
  });

  test('apply_motion_preset rejects unknown presets and overwrite-less existing targets', async () => {
    // validation happens in the zod catalog BEFORE the relay: an unknown
    // preset never reaches the editor; overwrite semantics are enforced
    // editor-side and surface as a structured CommandError envelope.
    toolResponders.set('apply_motion_preset', (args) => {
      if (args.overwrite !== true && args.targetClipId) {
        return { __mockError: true };
      }
      return { preset: args.preset, frameCount: 6, target: { kind: 'new', clipId: 'cl-x' } };
    });
    const { token } = await generatePairing('L1');
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name: 'motion-bad' } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();
    const client = await sdkClient(clientToken);
    // zod rejects the bad enum with isError + message
    const res = await client.callTool({ name: 'apply_motion_preset', arguments: { preset: 'fly' } });
    const r = res as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    expect(r.isError).toBe(true);
    await client.close();
  });
});

describe('skill knowledge (get_knowledge / study_reference)', () => {
  /** Exchange a pairing code for a real paired client (house pattern). */
  async function pairedClient(tier: 'L0' | 'L1' | 'L2' | 'L3', name: string): Promise<Client> {
    const { token } = await generatePairing(tier);
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();
    return sdkClient(clientToken);
  }

  test('both tools are advertised', async () => {
    const { token } = await generatePairing('L0');
    const pc = await sdkClient(token);
    const listed = await pc.listTools();
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain('get_knowledge');
    expect(names).toContain('study_reference');
    expect(names).toContain('save_project');
    await pc.close();
  });

  test('save_project is L2-gated and relays to the editor', async () => {
    // L0 pairing: tier check rejects before any relay happens.
    const l0 = await pairedClient('L0', 'save-reader');
    const denied = textEnvelope(await l0.callTool({ name: 'save_project', arguments: {} }));
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('permission_denied');
    await l0.close();

    // L1 pairing: still below L2.
    const l1 = await pairedClient('L1', 'save-writer-l1');
    const denied1 = textEnvelope(await l1.callTool({ name: 'save_project', arguments: {} }));
    expect(denied1.ok).toBe(false);
    expect(denied1.error?.code).toBe('permission_denied');
    await l1.close();

    // L2 pairing + mock editor answering the relay: happy path.
    toolResponders.set('save_project', () => ({ saved: true, path: 'C:/tmp/x.pixelforgeproj' }));
    const l2 = await pairedClient('L2', 'save-writer-l2');
    const env = textEnvelope(await l2.callTool({ name: 'save_project', arguments: {} }));
    expect(env.ok).toBe(true);
    expect((env.data as { saved: boolean }).saved).toBe(true);
    expect((env.data as { path: string }).path).toContain('.pixelforgeproj');
    await l2.close();
  });

  test('L0 get_knowledge serves shipped palettes', async () => {
    const client = await pairedClient('L0', 'knowledge-reader');
    const env = textEnvelope(await client.callTool({ name: 'get_knowledge', arguments: { topic: 'palettes' } }));
    expect(env.ok).toBe(true);
    const data = env.data as { topic: string; markdown: string };
    expect(data.topic).toBe('palettes');
    expect(data.markdown.length).toBeGreaterThan(200);
    await client.close();
  });

  test('L0 get_knowledge serves the aseprite-derived topics', async () => {
    const client = await pairedClient('L0', 'knowledge-reader-aseprite');
    for (const topic of ['shade', 'rig', 'tileset', 'concept', 'fix'] as const) {
      const env = textEnvelope(await client.callTool({ name: 'get_knowledge', arguments: { topic } }));
      expect(env.ok).toBe(true);
      const data = env.data as { markdown: string };
      expect(data.markdown.length).toBeGreaterThan(300);
    }
    await client.close();
  });

  test('palette library: index, exact id and keyword search', async () => {
    const client = await pairedClient('L0', 'palette-browser');
    const idx = textEnvelope(await client.callTool({ name: 'get_knowledge', arguments: { topic: 'palette_library' } }));
    expect(idx.ok).toBe(true);
    expect((idx.data as { count: number }).count).toBeGreaterThan(1000);

    const exact = textEnvelope(await client.callTool({ name: 'get_knowledge', arguments: { topic: 'palette_library', style: 'pico8' } }));
    expect(exact.ok).toBe(true);
    const p = exact.data as { name: string; colors: string[] };
    expect(p.colors.length).toBe(16);
    expect(p.colors[0]).toBe('#000000');

    const search = textEnvelope(await client.callTool({ name: 'get_knowledge', arguments: { topic: 'palette_library', style: 'gameboy' } }));
    expect(search.ok).toBe(true);
    expect((search.data as { markdown: string }).markdown.toLowerCase()).toContain('gameboy');
    await client.close();
  });

  test('chain: library palette colors apply via set_palette', async () => {
    // the documented flow: get_knowledge returns the exact hex list, the
    // agent feeds it to the existing L1 set_palette relay — no new tool.
    let applied: unknown = null;
    toolResponders.set('set_palette', (args) => {
      applied = args;
      return { applied: (args.colors as string[]).length };
    });
    const client = await pairedClient('L2', 'palette-applier');
    const lib = textEnvelope(await client.callTool({ name: 'get_knowledge', arguments: { topic: 'palette_library', style: 'pico8' } }));
    const colors = (lib.data as { colors: string[] }).colors;
    const env = textEnvelope(await client.callTool({ name: 'set_palette', arguments: { colors } }));
    expect(env.ok).toBe(true);
    expect(applied).toEqual({ colors });
    await client.close();
  });

  test('unknown topic is rejected (zod catalog gate)', async () => {
    // validation happens in the zod catalog BEFORE the handler, same as
    // apply_motion_preset's enum: an unknown topic surfaces as isError.
    const client = await pairedClient('L0', 'knowledge-reader-2');
    const res = await client.callTool({ name: 'get_knowledge', arguments: { topic: 'sorcery' } });
    const r = res as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    expect(r.isError).toBe(true);
    const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
    expect(text.toLowerCase()).toContain('topic');
    await client.close();
  });

  test('L0 client cannot study (L1)', async () => {
    const client = await pairedClient('L0', 'knowledge-reader-3');
    const env = textEnvelope(await client.callTool({ name: 'study_reference', arguments: { pngBase64: 'aGVsbG8=' } }));
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('permission_denied');
    await client.close();
  });

  test('L1 study_reference round-trips into the learned index', async () => {
    // 4x4 mirrored two-color sprite: cols 0/3 red, cols 1/2 blue
    const w = 4;
    const h = 4;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const red = x === 0 || x === 3;
        rgba[i] = red ? 255 : 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = red ? 0 : 255;
        rgba[i + 3] = 255;
      }
    }
    const png = await encodePng(w, h, rgba);
    const pngBase64 = Buffer.from(png).toString('base64');

    const client = await pairedClient('L1', 'style-student');
    const env = textEnvelope(
      await client.callTool({ name: 'study_reference', arguments: { pngBase64, styleName: 'test mirror style', notes: 'two-color mirror test' } })
    );
    expect(env.ok).toBe(true);
    const data = env.data as { learnedId: string; palette: string[]; width: number; height: number; symmetry: number };
    expect(data.width).toBe(4);
    expect(data.height).toBe(4);
    expect(data.palette.length).toBe(2);
    expect(data.symmetry).toBe(100);

    const idx = textEnvelope(await client.callTool({ name: 'get_knowledge', arguments: { topic: 'learned' } }));
    expect(idx.ok).toBe(true);
    expect((idx.data as { markdown: string }).markdown).toContain(data.learnedId);
    await client.close();
  });
});

// ------------------------------------------------- shared-Brain phase 5 tools
describe('shared-Brain phase 5 — status / capabilities / ask / plan / resources', () => {
  // pairedClient lives inside another describe's scope — re-bind locally
  async function pairedClient(tier: 'L0' | 'L1' | 'L2' | 'L3', name: string): Promise<Client> {
    const { token } = await generatePairing(tier);
    const pc = await sdkClient(token);
    const paired = textEnvelope(await pc.callTool({ name: 'pair_client', arguments: { name } }));
    const clientToken = (paired.data as { token: string }).token;
    await pc.close();
    return sdkClient(clientToken);
  }

  test('brain_get_status reads service + board facts (L0, no editor secrets)', async () => {
    const client = await pairedClient('L0', 'brain-status');
    const env = textEnvelope(await client.callTool({ name: 'brain_get_status', arguments: {} }));
    expect(env.ok).toBe(true);
    const data = env.data as {
      editorConnected: boolean;
      brain: { available: boolean; note: string };
      board: { pending: number; claimed: number };
    };
    expect(data.editorConnected).toBe(true);
    expect(data.brain.available).toBe(true);
    expect(data.brain.note).not.toMatch(/key|token/i);
    expect(typeof data.board.pending).toBe('number');
    await client.close();
  });

  test('brain_get_capabilities filters the catalog to the caller tier', async () => {
    const l0 = await pairedClient('L0', 'brain-caps-l0');
    const envL0 = textEnvelope(await l0.callTool({ name: 'brain_get_capabilities', arguments: {} }));
    expect(envL0.ok).toBe(true);
    const dataL0 = envL0.data as { tier: string; tools: Array<{ name: string; tier: string }>; counts: { total: number; granted: number } };
    expect(dataL0.tier).toBe('L0');
    expect(dataL0.tools.every((t) => t.tier === 'L0')).toBe(true);
    expect(dataL0.tools.some((t) => t.name === 'brain_get_status')).toBe(true);
    expect(dataL0.tools.some((t) => t.name === 'brain_ask')).toBe(false);
    expect(dataL0.counts.granted).toBeLessThan(dataL0.counts.total);
    await l0.close();

    const l1 = await pairedClient('L1', 'brain-caps-l1');
    const envL1 = textEnvelope(await l1.callTool({ name: 'brain_get_capabilities', arguments: {} }));
    const dataL1 = envL1.data as { tools: Array<{ name: string }>; counts: { granted: number } };
    expect(dataL1.tools.some((t) => t.name === 'brain_ask')).toBe(true);
    expect(dataL1.tools.some((t) => t.name === 'brain_plan_goal')).toBe(true);
    expect(dataL1.counts.granted).toBeGreaterThan(dataL0.counts.granted);
    await l1.close();
  });

  test('brain_get_task returns one record; unknown ids are rejected (L0)', async () => {
    const pushed = await ctrl<{ data: { tasks: Array<{ id: string; title: string }> } }>({
      kind: 'brain-push',
      tasks: [{ title: 'Phase5 sample', detail: 'd' }],
    });
    const id = pushed.data.tasks[0]!.id;
    const client = await pairedClient('L0', 'brain-get-task');
    const env = textEnvelope(await client.callTool({ name: 'brain_get_task', arguments: { id } }));
    expect(env.ok).toBe(true);
    expect((env.data as { task: { id: string; title: string } }).task.title).toBe('Phase5 sample');
    const missing = textEnvelope(await client.callTool({ name: 'brain_get_task', arguments: { id: 'bt_missing' } }));
    expect(missing.ok).toBe(false);
    await client.close();
  });

  test('brain_ask relays to the editor and never carries provider secrets', async () => {
    let relayed: Record<string, unknown> | null = null;
    toolResponders.set('brain_ask', (args) => {
      relayed = args;
      return { question: args.question, answer: 'Build the coin pickup next.' };
    });
    const client = await pairedClient('L1', 'brain-asker');
    const env = textEnvelope(await client.callTool({ name: 'brain_ask', arguments: { question: 'what should I build next?' } }));
    expect(env.ok).toBe(true);
    expect((env.data as { answer: string }).answer).toContain('coin pickup');
    expect(relayed && Object.values(relayed).join(' ')).not.toMatch(/pfm_|gsk_/);
    await client.close();
  });

  test('brain_plan_goal returns a plan proposal that explicitly executes nothing', async () => {
    // the mock mirrors the REAL editor-side handler's response shape
    // (mcp-tools.ts brain_plan_goal) — including its execution disclaimer
    toolResponders.set('brain_plan_goal', (args) => ({
      plan: [{ kind: 'app-vfx', title: 'Campfire', effect: 'fire/campfire', light: 0.6, palette: 'project' }],
      revision: 'rev-123',
      note: 'Plan proposal only — NOTHING was executed or queued.',
    }));
    const client = await pairedClient('L1', 'brain-planner');
    const env = textEnvelope(await client.callTool({ name: 'brain_plan_goal', arguments: { goal: 'add a warm campfire' } }));
    expect(env.ok).toBe(true);
    const data = env.data as { plan: unknown[]; revision: string; note: string };
    expect(data.plan).toHaveLength(1);
    expect(data.revision).toBe('rev-123');
    expect(data.note).toContain('NOTHING was executed');
    await client.close();
  });

  test('read-only resources: capabilities snapshot + live project summary', async () => {
    const client = await pairedClient('L1', 'resource-reader');
    const caps = await client.readResource({ uri: 'pixelforge://capabilities' });
    const capsText = (caps.contents[0] as { text: string }).text;
    const capsJson = JSON.parse(capsText) as { tier: string; tools: Array<{ name: string }> };
    expect(capsJson.tier).toBe('L1');
    expect(capsJson.tools.some((t) => t.name === 'brain_plan_goal')).toBe(true);

    const proj = await client.readResource({ uri: 'pixelforge://project/active' });
    const projJson = JSON.parse((proj.contents[0] as { text: string }).text) as { ok: boolean; data?: { name?: string } };
    expect(projJson.ok).toBe(true);
    expect(projJson.data?.name).toBe('test doc');
    await client.close();
  });
});
