// Live verify: export_sheet + export_gif + purge_trash on Donutt.
import { writeFileSync } from 'node:fs';
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

// 1) sprite sheet from donut-bounce (4 frames)
let r = await call('export_sheet', { clipName: 'donut-bounce', padding: 1 });
const d = r.data ?? {};
console.log(`[sheet] ok=${r.ok} frames=${d.frameCount} ${d.width}×${d.height} bytes=${(d.png ?? '').length}`);
if (d.png?.startsWith('data:image/png')) {
  writeFileSync(String(process.env.PF_SHEET_OUT), Buffer.from(d.png.split(',')[1], 'base64'));
  console.log('[sheet] saved ' + process.env.PF_SHEET_OUT);
}

// 2) gif from donut-bounce
r = await call('export_gif', { clipName: 'donut-bounce', scale: 2 });
console.log(`[gif] ok=${r.ok} frames=${r.data?.frameCount} ${r.data?.width}×${r.data?.height} bytes=${(r.data?.gif ?? '').length}`);

// 3) purge trash (had test debris), verify count, undo restores
const before = (await call('get_project_state', {})).data;
console.log(`[trash before] ${before.trash.length} entr(ies)`);
r = await call('purge_trash', {});
console.log(`[purge] ok=${r.ok} purged=${r.data?.purged} — ${r.summary}`);
const mid = (await call('get_project_state', {})).data;
console.log(`[trash after] ${mid.trash.length}`);
r = await call('undo', {});
console.log(`[undo purge] undid="${r.data?.label}"`);
const after = (await call('get_project_state', {})).data;
console.log(`[trash restored] ${after.trash.length}`);
