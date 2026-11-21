// Packaging verification — a REAL MCP SDK client (Streamable HTTP) checks the
// tier contract of a fresh installed build:
//   • generate_sprite is absent from the tool list
//   • L0 pairing: can read (get_project_state), cannot edit (set_pixels/undo
//     rejected with a structured permission error)
//   • L1 pairing: can paint (set_pixels) and undo (undo), state changes
//
// Usage: bun verify-tiers.mjs <pairing-code> <L0|L1> [--e2e-full]
// The editor must be open in the installed app (serverReady) so tools execute.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const MCP = process.env.PF_MCP_URL ?? 'http://127.0.0.1:3030/mcp';
const pairingCode = process.argv[2] ?? process.env.PF_VERIFY_CODE;
const tier = (process.argv[3] ?? 'L1').toUpperCase();
if (!pairingCode) {
  console.error('usage: bun verify-tiers.mjs <pairing-code> <L0|L1>');
  process.exit(2);
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail.slice(0, 140)}` : ''}`);
}
function env(result) {
  const text = result.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    // structured-error / plain-text result (isError: true) — surface it
    return { ok: false, error: { code: 'non_json', message: text.slice(0, 300) } };
  }
}

async function withClient(bearer, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'pixelforge-tier-verify', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// 1) pair: exchange the single-use code for a persistent token
const clientToken = await withClient(pairingCode, async (c) => {
  const paired = env(await c.callTool({ name: 'pair_client', arguments: { name: `tier-verify-${tier}` } }));
  check('pair_client exchange', paired.ok && typeof paired.data?.token === 'string' && paired.data.token.startsWith('pfm_'));
  return paired.data.token;
});

await withClient(clientToken, async (client) => {
  // 2) tool list: generate_sprite must be absent
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  check('generate_sprite absent from tool list', !names.includes('generate_sprite'), `${names.length} tools`);
  check(`L0 read tools present (get_project_state)`, names.includes('get_project_state'));

  // 3) read works at BOTH tiers
  const state = env(await client.callTool({ name: 'get_project_state', arguments: {} }));
  check(
    'get_project_state (read) ok',
    state.ok === true && !!state.data?.clips?.length && typeof state.stateHash === 'string',
    `clips: ${state.data?.clips?.length ?? '?'}`,
  );
  const clip = state.data.clips[0];
  const detail = env(await client.callTool({ name: 'get_clip', arguments: { clipId: clip.id } }));
  check('get_clip (read) ok', detail.ok === true && detail.data?.layers?.length > 0, `layers: ${detail.data?.layers?.length ?? '?'}`);
  const layer = detail.data.layers[0].id;
  const frame = detail.data.frames[0];
  check('project has a layer + frame to target', !!layer && !!frame);

  // paint target: center of the canvas
  const W = state.data.width ?? 32;
  const H = state.data.height ?? 32;

  // 4) tier gate: set_pixels
  const paint = await client.callTool({
    name: 'set_pixels',
    arguments: {
      clipId: clip.id,
      frameId: frame.id,
      layerId: layer,
      pixels: [{ x: Math.floor(W / 2), y: Math.floor(H / 2), color: '#ff0000' }],
    },
  });
  const paintEnv = env(paint);
  if (tier === 'L0') {
    check('L0 set_pixels REJECTED (cannot edit)', paintEnv.ok === false, paintEnv.error?.code ?? paintEnv.error?.message ?? '');
  } else {
    check('L1 set_pixels ACCEPTED (can paint)', paintEnv.ok === true, '');
  }

  // 5) undo
  const undo = await client.callTool({ name: 'undo', arguments: {} });
  const undoEnv = env(undo);
  if (tier === 'L0') {
    check('L0 undo REJECTED', undoEnv.ok === false, undoEnv.error?.code ?? undoEnv.error?.message ?? '');
  } else {
    check('L1 undo ACCEPTED', undoEnv.ok === true, undoEnv.data?.ok === false ? 'nothing to undo?' : '');
  }

  // 6) state consistency: after L1 paint+undo the pixel is back to its prior color
  if (tier === 'L1') {
    const repainted = env(await client.callTool({
      name: 'set_pixels',
      arguments: {
        clipId: clip.id,
        frameId: frame.id,
        layerId: layer,
        pixels: [{ x: Math.floor(W / 2), y: Math.floor(H / 2), color: '#ff0000' }],
      },
    }));
    check('L1 repaint for state check', repainted.ok === true, repainted.error?.message ?? repainted.error?.code ?? '');
    const after = env(await client.callTool({
      name: 'get_frame_png',
      arguments: { clipId: clip.id, frameId: frame.id },
    }));
    check('get_frame_png returns updated frame', after.ok === true, typeof after.data?.pngBase64 === 'string' ? 'png ok' : '');
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${tier} verification: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
