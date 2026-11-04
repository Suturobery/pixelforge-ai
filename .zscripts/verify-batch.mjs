// Live verify: batch (success + rollback), create_project confirm, get_quota, agent knowledge.
const BASE = 'http://127.0.0.1:3030/mcp';
const TOK = process.env.PF_TOKEN;
let sid = null, id = 0;

async function rpc(method, params) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOK}`,
      ...(sid ? { 'Mcp-Session-Id': sid } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const newSid = res.headers.get('mcp-session-id');
  if (newSid) sid = newSid;
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) throw new Error(`no data line: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(dataLine.slice(5).trim());
}
async function call(tool, args) {
  const r = await rpc('tools/call', { name: tool, arguments: args });
  const c = r.result?.content?.[0]?.text;
  return c ? JSON.parse(c) : r.result;
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'zcode-test', version: '1.0.0' } });
await rpc('notifications/initialized', {});

// 1) batch success: paint + beautify on empty clip 6 → ONE undo entry
let r = await call('batch', {
  steps: [
    { tool: 'set_pixels', args: { clipName: 'clip 6', frameIndex: 0, color: '#38b764', pixels: [{ x: 8, y: 8 }, { x: 9, y: 8 }, { x: 8, y: 9 }, { x: 9, y: 9 }] } },
    { tool: 'beautify_layer', args: { clipName: 'clip 6', frameIndex: 0, outline: '#151111', shade: true } },
  ],
});
console.log(`[batch ok] ok=${r.ok} completed=${r.data.completed} rolledBack=${r.data.rolledBack} — ${r.summary}`);

// 2) batch rollback: failing second step → document untouched, ONE undo undoes everything
const hashBefore = (await call('get_project_state', {})).data.stateHash;
r = await call('batch', {
  steps: [
    { tool: 'set_pixels', args: { clipName: 'clip 6', frameIndex: 0, color: '#41a6f6', pixels: [{ x: 20, y: 20 }] } },
    { tool: 'set_pixels', args: { clipName: 'no-such-clip', frameIndex: 0, pixels: [{ x: 1, y: 1 }] } },
  ],
});
const hashAfter = (await call('get_project_state', {})).data.stateHash;
console.log(`[batch rollback] ok=${r.ok} rolledBack=${r.data.rolledBack} — ${r.summary}`);
console.log(`[rollback proof] hash unchanged=${hashBefore === hashAfter}`);

// undo #1 must revert the whole successful batch (paint+beautify) at once
r = await call('undo', {});
console.log(`[one undo] undid="${r.data.label}" docCleanHashMatch=${(await call('get_project_state', {})).data.stateHash === hashBefore}`);

// 3) create_project without confirm → rejected
r = await call('create_project', { name: 'nope3', width: 32, height: 32 });
console.log(`[confirm guard] ok=${r.ok} code=${r.error?.code}`);

// 4) get_quota
r = await call('get_quota', {});
console.log(`[quota] ${r.data.tiers.map((t) => `${t.tier}:${t.remaining}/${t.limitPerMin}`).join(' ')}`);

// 5) agent knowledge topic
r = await call('get_knowledge', { topic: 'agent' });
console.log(`[knowledge agent] ok=${r.ok} bytes=${(r.data?.markdown ?? '').length}`);
