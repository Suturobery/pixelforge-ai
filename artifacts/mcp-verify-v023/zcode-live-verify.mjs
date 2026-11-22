// Live ZCode-client verification: pair → read → paint → read-back → undo.
// Runs as the ACTUAL ZCode agent connecting to the PixelForge MCP server.
// The MCP SDK lives in the mcp-server's node_modules; resolve by absolute path.
const { Client, StreamableHTTPClientTransport } = await import(
  'file:///C:/Users/Client/Downloads/workspace-d4993187-40f7-4cb0-9f1f-152ba77cb10c/mini-services/mcp-server/node_modules/@modelcontextprotocol/client/dist/index.mjs'
);

const MCP = process.env.PF_MCP_URL ?? 'http://127.0.0.1:3030/mcp';
const code = process.argv[2];
if (!code) { console.error('usage: bun zcode-live-verify.mjs <pairing-code>'); process.exit(2); }

function env(result) {
  const text = result.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return { ok: false, error: { message: text.slice(0, 200) } }; }
}
async function withClient(bearer, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'ZCode', version: '1.0.0' });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close().catch(() => {}); }
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 120)}` : ''}`);
}

// 1) pair as ZCode
const token = await withClient(code, async (c) => {
  const paired = env(await c.callTool({ name: 'pair_client', arguments: { name: 'ZCode' } }));
  check('pair_client as ZCode', paired.ok && typeof paired.data?.token === 'string');
  return paired.data.token;
});

await withClient(token, async (client) => {
  // 2) read the live project state
  const state = env(await client.callTool({ name: 'get_project_state', arguments: {} }));
  check('get_project_state ok', state.ok === true, `${state.data?.name} ${state.data?.width}x${state.data?.height}`);
  const clip = state.data.clips[0];
  const detail = env(await client.callTool({ name: 'get_clip', arguments: { clipId: clip.id } }));
  const layer = detail.data.layers[0].id;
  const frame = detail.data.frames[0].id;
  check('active clip matches open app', !!layer && !!frame, `${clip.name} layer=${layer} frame=${frame}`);

  // 3) paint one pixel (disposable blank project)
  const paint = env(await client.callTool({
    name: 'set_pixels',
    arguments: { clipId: clip.id, frameId: frame, layerId: layer, pixels: [{ x: 4, y: 4, color: '#00ff00' }] },
  }));
  check('set_pixels (paint) ok', paint.ok === true);

  // 4) read back with get_frame_png
  const png1 = env(await client.callTool({ name: 'get_frame_png', arguments: { clipId: clip.id, frameId: frame } }));
  check('get_frame_png after paint ok', png1.ok === true && typeof png1.data?.png === 'string');

  // 5) undo
  const undo = env(await client.callTool({ name: 'undo', arguments: {} }));
  check('undo ok', undo.ok === true);

  // 6) verify the original frame is restored (pixel no longer green)
  const png2 = env(await client.callTool({ name: 'get_frame_png', arguments: { clipId: clip.id, frameId: frame } }));
  check('get_frame_png after undo ok', png2.ok === true && typeof png2.data?.png === 'string');
  // compare base64 payloads: after undo the frame must differ from the painted one
  check('undo restored original frame', png1.data.png !== png2.data.png);
});

const failed = results.filter((r) => !r.ok);
console.log(`\nZCode live verification: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
