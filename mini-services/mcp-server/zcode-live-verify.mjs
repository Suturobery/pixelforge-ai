import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const MCP = process.env.PF_MCP_URL ?? 'http://127.0.0.1:3030/mcp';
const code = process.argv[2];
if (!code) { console.error('usage: bun zcode-live-verify.mjs <code>'); process.exit(2); }
function env(result) { const t = result.content?.[0]?.text ?? ''; try { return JSON.parse(t); } catch { return { ok: false, error: { message: t.slice(0, 200) } }; } }
async function withClient(bearer, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
  const client = new Client({ name: 'ZCode', version: '1.0.0' });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close().catch(() => {}); }
}
const results = [];
function check(name, cond, detail = '') { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 120)}` : ''}`); }
const token = await withClient(code, async (c) => {
  const paired = env(await c.callTool({ name: 'pair_client', arguments: { name: 'ZCode' } }));
  check('pair_client as ZCode', paired.ok && typeof paired.data?.token === 'string');
  return paired.data.token;
});
await withClient(token, async (client) => {
  const state = env(await client.callTool({ name: 'get_project_state', arguments: {} }));
  check('get_project_state ok', state.ok === true, `${state.data?.name} ${state.data?.width}x${state.data?.height}`);
  const clip = state.data.clips[0];
  const detail = env(await client.callTool({ name: 'get_clip', arguments: { clipId: clip.id } }));
  const layer = detail.data.layers[0].id;
  const frame = detail.data.frames[0].id;
  check('active clip matches open app', !!layer && !!frame, `${clip.name}`);
  const paint = env(await client.callTool({ name: 'set_pixels', arguments: { clipId: clip.id, frameId: frame, layerId: layer, pixels: [{ x: 4, y: 4, color: '#00ff00' }] } }));
  check('set_pixels (paint) ok', paint.ok === true);
  const png1 = env(await client.callTool({ name: 'get_frame_png', arguments: { clipId: clip.id, frameId: frame } }));
  check('get_frame_png after paint ok', png1.ok === true && typeof png1.data?.png === 'string' && png1.data?.png.startsWith('data:'));
  const undo = env(await client.callTool({ name: 'undo', arguments: {} }));
  check('undo ok', undo.ok === true);
  const png2 = env(await client.callTool({ name: 'get_frame_png', arguments: { clipId: clip.id, frameId: frame } }));
  check('get_frame_png after undo ok', png2.ok === true && typeof png2.data?.png === 'string' && png2.data?.png.startsWith('data:'));
  check('undo restored original frame', png1.data.png !== png2.data.png);
});
const failed = results.filter(r => !r.ok);
console.log(`\nZCode live verification: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
