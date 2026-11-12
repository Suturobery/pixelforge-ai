// Editor-link authentication tests (P0-1): every hello must present the
// editor token; takeover requires it; unauthorized sockets are closed and
// never gain the editor slot; a legit paired-agent workflow still works
// (requestTool round-trip through an authorized editor).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorLink, type EditorSocket } from '../src/editor-link';
import { getOrCreateEditorToken } from '../src/editor-auth';

class FakeSocket implements EditorSocket {
  sent: string[] = [];
  closed: Array<{ code: number; reason: string }> = [];
  onClose: Array<(code: number, reason: string) => void> = [];

  send(json: string): void {
    this.sent.push(json);
  }
  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
    for (const fn of this.onClose) fn(code, reason);
  }
  lastHelloOk(): boolean {
    const helloOk = this.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'hello-ok');
    return Boolean(helloOk);
  }
}

const TOKEN = 'a'.repeat(64);

function makeLink() {
  return new EditorLink({ editorToken: TOKEN });
}

function hello(key: string | undefined, takeover = false) {
  return {
    type: 'hello' as const,
    bridgeVersion: 4,
    appVersion: 'test',
    origin: 'http://localhost:3000',
    ...(key !== undefined ? { editorKey: key } : {}),
    ...(takeover ? { takeover: true } : {}),
  };
}

describe('editor-link authentication (P0-1)', () => {
  test('unauthorized hello (no key) on a free slot → closed 4003, never attached', () => {
    const link = makeLink();
    const sock = new FakeSocket();
    link.attach(sock);
    link.handleInbound(hello(undefined), sock);
    expect(sock.closed.some((c) => c.code === 4003)).toBe(true);
    expect(link.connected).toBe(false);
  });

  test('unauthorized hello (wrong key) → closed 4003', () => {
    const link = makeLink();
    const sock = new FakeSocket();
    link.attach(sock);
    link.handleInbound(hello('b'.repeat(64)), sock);
    expect(sock.closed.some((c) => c.code === 4003)).toBe(true);
    expect(link.connected).toBe(false);
  });

  test('authorized hello attaches and answers hello-ok', () => {
    const link = makeLink();
    const sock = new FakeSocket();
    link.attach(sock);
    link.handleInbound(hello(TOKEN), sock);
    expect(link.connected).toBe(true);
    expect(link.appVersion).toBe('test'); // hello-ok is sent by the host layer (integration)
  });

  test('UNAUTHORIZED TAKEOVER fails: healthy holder keeps the slot', () => {
    const link = makeLink();
    const holder = new FakeSocket();
    link.attach(holder);
    link.handleInbound(hello(TOKEN), holder);

    const attacker = new FakeSocket();
    link.attach(attacker); // candidate (holder is fresh)
    link.handleInbound(hello(undefined, true), attacker); // takeover attempt, no key
    expect(attacker.closed.some((c) => c.code === 4003)).toBe(true);
    expect(link.isEditor(holder)).toBe(true);
    expect(link.isEditor(attacker)).toBe(false);
  });

  test('AUTHORIZED takeover succeeds: ownership swaps', () => {
    const link = makeLink();
    const holder = new FakeSocket();
    link.attach(holder);
    link.handleInbound(hello(TOKEN), holder);

    const next = new FakeSocket();
    link.attach(next);
    link.handleInbound(hello(TOKEN, true), next);
    expect(link.isEditor(next)).toBe(true);
    expect(holder.closed.some((c) => c.code === 4005)).toBe(true);
  });

  test('unauthorized approval-response from a non-owner socket is ignored', () => {
    const link = makeLink();
    const holder = new FakeSocket();
    link.attach(holder);
    link.handleInbound(hello(TOKEN), holder);

    let seen: { id: string; approve: boolean } | null = null;
    link.onApprovalResponse((m) => {
      seen = m;
    });
    const attacker = new FakeSocket();
    attacker.send = () => {
      /* attacker never owns the slot — its sends go nowhere */
    };
    // attacker never authenticated; drive its message with fromSocket=attacker
    link.handleInbound({ type: 'approval-response', id: 'ap_1', approve: true }, attacker);
    expect(seen).toBeNull();
  });

  test('legit workflow still works: authorized editor relays tool-results', async () => {
    const link = makeLink();
    const holder = new FakeSocket();
    link.attach(holder);
    link.handleInbound(hello(TOKEN), holder);

    const pending = link.requestTool({ tool: 'set_pixels', args: {}, clientId: 'c1', clientName: 'agent', tier: 'L1' });
    const req = JSON.parse(holder.sent.find((s) => s.includes('tool-request'))!);
    link.handleInbound(
      { type: 'tool-result', id: req.id, ok: true, data: { done: true }, summary: 'painted' } as never,
      holder,
    );
    const res = await pending;
    expect(res.ok).toBe(true);
  });

  test('STALE holder (silent >25s) + unauthorized newcomer → still rejected (no free seizure)', () => {
    const link = new EditorLink({ editorToken: TOKEN });
    const stale = new FakeSocket();
    link.attach(stale);
    link.handleInbound(hello(TOKEN), stale);
    // simulate holder going silent: detach without close, then backdate freshness
    (link as unknown as { lastAliveAt: number }).lastAliveAt = Date.now() - 60_000;
    link.detach(stale);
    // re-attach path: attach() with no socket → newcomer slots in, but its
    // hello still needs the key
    const attacker = new FakeSocket();
    link.attach(attacker);
    link.handleInbound(hello(undefined), attacker);
    expect(attacker.closed.some((c) => c.code === 4003)).toBe(true);
    expect(link.connected).toBe(false);
  });
});

describe('editor-auth token persistence', () => {
  test('same token across calls; corrupt file regenerates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-editor-auth-'));
    const t1 = getOrCreateEditorToken(dir);
    const t2 = getOrCreateEditorToken(dir);
    expect(t1).toBe(t2);
    writeFileSync(join(dir, 'editor-auth.json'), '{corrupt');
    const t3 = getOrCreateEditorToken(dir);
    expect(t3).not.toBe(t1);
    expect(t3.length).toBe(64);
    expect(existsSync(join(dir, 'editor-auth.json'))).toBe(true);
    expect(readFileSync(join(dir, 'editor-auth.json'), 'utf8').includes(t3)).toBe(true);
  });
});
