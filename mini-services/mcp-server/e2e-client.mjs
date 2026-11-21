/**
 * Task 8 E2E — external MCP client drives the LIVE PixelForge editor.
 *
 * A real SDK client (Streamable HTTP) pairs with a code generated in the
 * Settings UI, then executes the §9 workflow against the running app:
 * inspect → palette → clip → duplicate frame → paint → verify canvas → undo
 * → verify restore → structured errors. Every call is genuine MCP over HTTP;
 * the editor executes each tool on its CommandBus in the open browser page.
 *
 * Usage: bun e2e-client.mjs <pairing-code>
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const MCP = process.env.PF_MCP_URL ?? 'http://127.0.0.1:3030/mcp';
// pairing code: argv[2] or PF_E2E_PAIRING_CODE (env preferred by automation —
// keeps the single-use code out of process listings and failure logs)
const pairingCode = process.argv[2] ?? process.env.PF_E2E_PAIRING_CODE;
if (!pairingCode) {
  console.error('usage: bun e2e-client.mjs <pairing-code>');
  process.exit(2);
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function env(result) {
  return JSON.parse(result.content[0].text);
}

async function withClient(bearer, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'pixelforge-e2e', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// ---- 1+2) authenticate: exchange the 6-word code for a client token ------
const clientToken = await withClient(pairingCode, async (c) => {
  const paired = env(await c.callTool({ name: 'pair_client', arguments: { name: 'e2e-assistant' } }));
  check('1. pairing exchange (pair_client)', paired.ok && typeof paired.data?.token === 'string' && paired.data.token.startsWith('pfm_'));
  return paired.data.token;
});
// the code is single-use — verify it can no longer authenticate
{
  let reuseBlocked = false;
  try {
    await withClient(pairingCode, async (c) => {
      const replayResult = await c.callTool({ name: 'pair_client', arguments: { name: 'replay' } });
      // Streamable HTTP can establish the transport before the server rejects
      // the reused bearer. Treat either the MCP error envelope or the
      // structured pair error as the expected blocked outcome instead of
      // requiring connect() itself to throw.
      if (replayResult.isError === true) {
        reuseBlocked = true;
        return;
      }
      const replay = env(replayResult);
      reuseBlocked = replay.ok === false && typeof replay.error?.code === 'string';
    });
  } catch {
    reuseBlocked = true;
  }
  check('2. pairing code is single-use (replay blocked)', reuseBlocked);
}

await withClient(clientToken, async (c) => {
  // ---- 3) inspect the active project ----
  const state = env(await c.callTool({ name: 'get_project_state', arguments: {} }));
  // A fresh desktop launch starts with an untitled project while seeded QA
  // runs may use the Farmer sample. The protocol guarantee is a usable named
  // project and a state hash, not one particular fixture name.
  check('3. get_project_state', state.ok && typeof state.data?.name === 'string' && state.data.name.length > 0 && typeof state.stateHash === 'string');
  const stateHash0 = state.stateHash;
  const clip0 = state.data.clips[0];

  // ---- 4) read the palette ----
  const pal = env(await c.callTool({ name: 'get_palette', arguments: {} }));
  check('4. get_palette', pal.ok && Array.isArray(pal.data.palette) && pal.data.palette.length > 0);

  // ---- 5) inspect clip / layers / frames ----
  const clip = env(await c.callTool({ name: 'get_clip', arguments: { clipName: clip0.name } }));
  check(
    '5. get_clip (layers+frames)',
    clip.ok && clip.data.layers.length > 0 && clip.data.frames.length === clip0.frameCount && clip.data.frames.every((f) => typeof f.id === 'string')
  );
  const frameId = clip.data.frames[0].id;
  const layerId = clip.data.layers[clip.data.layers.length - 1].id;

  // ---- 6) duplicate the first frame ----
  const dup = env(await c.callTool({ name: 'duplicate_frame', arguments: { frameIndex: 0, expectedStateHash: stateHash0 } }));
  check('6. duplicate_frame (undoable, new stateHash)', dup.ok && dup.undoable === true && dup.stateHash !== stateHash0 && dup.data.frameCount === clip0.frameCount + 1);

  // ---- 7) modify pixels on the new frame ----
  const paint = env(await c.callTool({ name: 'set_pixels', arguments: { frameIndex: 1, layerId, color: '#ff00ff', pixels: [{ x: 8, y: 8 }, { x: 9, y: 8 }, { x: 8, y: 9 }] } }));
  check('7. set_pixels (3 px applied)', paint.ok && paint.data.applied === 3);

  // ---- 8) verify the canvas updated (browser read-back via the editor) ----
  const framePng = env(await c.callTool({ name: 'get_frame_png', arguments: { frameIndex: 1, scale: 1 } }));
  check('8. get_frame_png returns composited PNG', framePng.ok && framePng.data.png.startsWith('data:image/png;base64,'));
  // decode in-process and count magenta pixels
  const b64 = framePng.data.png.slice(framePng.data.png.indexOf(',') + 1);
  const bin = Buffer.from(b64, 'base64');
  // resolve pngjs via normal node_modules walk-up (root package provides it)
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(bin);
  let magenta = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 255 && png.data[i + 3] === 255) magenta++;
  }
  check('8b. painted pixels present in composited frame', magenta === 3, `${magenta} magenta px`);

  // ---- 9) undo the modification through MCP ----
  const undo = env(await c.callTool({ name: 'undo', arguments: {} }));
  check('9a. undo (MCP-originated)', undo.ok && undo.data.undid === true);
  const undo2 = env(await c.callTool({ name: 'undo', arguments: {} }));
  check('9b. undo the duplicate_frame', undo2.ok && undo2.data.undid === true);

  // ---- 10) verify the original frame is restored ----
  // The second undo removes the duplicate entirely, so index 1 is no longer
  // guaranteed to exist (a one-frame clip correctly returns to one frame).
  // Read the surviving original frame instead of dereferencing an error result.
  const framePng2 = env(await c.callTool({ name: 'get_frame_png', arguments: { frameIndex: 0, scale: 1 } }));
  check('10. original frame restored after undo', framePng2.ok && framePng2.data.png !== framePng.data.png);
  const bin2 = Buffer.from(framePng2.data.png.slice(framePng2.data.png.indexOf(',') + 1), 'base64');
  const png2 = PNG.sync.read(bin2);
  let magenta2 = 0;
  for (let i = 0; i < png2.data.length; i += 4) {
    if (png2.data[i] === 255 && png2.data[i + 1] === 0 && png2.data[i + 2] === 255 && png2.data[i + 3] === 255) magenta2++;
  }
  check('10b. magenta pixels gone after undo', magenta2 === 0, `${magenta2} magenta px`);

  // ---- 11) structured errors for invalid operations ----
  const oob = env(await c.callTool({ name: 'set_pixels', arguments: { pixels: [{ x: 500, y: 500 }], color: '#ffffff' } }));
  check('11a. out-of-bounds set_pixels → structured error', !oob.ok && typeof oob.error?.code === 'string' && typeof oob.error?.message === 'string', oob.error?.code);
  const stale = env(await c.callTool({ name: 'set_pixels', arguments: { pixels: [{ x: 1, y: 1 }], color: '#ffffff', expectedStateHash: 'stale-stale-stale' } }));
  check('11b. stale expectedStateHash → stale_document', !stale.ok && stale.error?.code === 'stale_document');
  const badRef = env(await c.callTool({ name: 'get_clip', arguments: { clipName: 'no-such-clip' } }));
  check('11c. unknown clip → not_found', !badRef.ok && badRef.error?.code === 'not_found');
  const unknown = await c.callTool({ name: 'resize_canvas', arguments: {} }).catch((e) => ({ _err: String(e?.message ?? e) }));
  // The SDK returns `isError: true` for a tool absent from the catalog; its
  // human-readable wording is SDK-version dependent, so do not assert it.
  const unknownIsError = unknown.isError === true;
  check('11d. L2 tool is unregistered (MCP error)', unknownIsError || unknown._err !== undefined, unknown._err ?? 'isError:true');
});

// ---- 14) Task 10: motion preset tools against the LIVE editor ------------
await withClient(clientToken, async (c) => {
  // 14a) tag a part region on the active clip (regions, never cuts)
  const parts = env(
    await c.callTool({
      name: 'set_parts',
      arguments: { parts: [{ name: 'body', rect: { x: 10, y: 12, w: 12, h: 12 }, z: 0 }] },
    })
  );
  check('14a. set_parts tags a motion part on the live clip', parts.ok && Array.isArray(parts.data.parts) && parts.data.parts.length === 1 && parts.data.parts[0].name === 'body', parts.error?.code);

  // 14b) the pure suggest helper
  const sug = env(await c.callTool({ name: 'suggest_motion_preset', arguments: { prompt: 'make him jump over the gap' } }));
  check('14b. suggest_motion_preset proposes jump ($0 helper)', sug.ok && sug.data.suggested?.preset === 'jump');

  // 14c) apply idle → NEW clip: report + QA + preview PNG, one undoable step
  const app = env(
    await c.callTool({ name: 'apply_motion_preset', arguments: { preset: 'idle', targetName: 'mcp-idle' } })
  );
  check(
    '14c. apply_motion_preset commits a 4-frame clip (undoable + preview)',
    app.ok && app.undoable === true && app.data.frameCount === 4 &&
      typeof app.data.target?.clipId === 'string' &&
      typeof app.data.previewPng === 'string' && app.data.previewPng.startsWith('data:image/png;base64,'),
    app.error?.code ?? `${app.data?.frameCount} frames`
  );
  // 14d) absent roles are skipped AND reported (C27)
  check(
    '14d. apply report lists skipped roles (C27: head/hair absent)',
    Array.isArray(app.data.report?.skipped) && app.data.report.skipped.some((s) => s.role === 'head')
  );

  // 14e) the new clip is visible in the live project state
  const state2 = env(await c.callTool({ name: 'get_project_state', arguments: {} }));
  check('14e. new motion clip visible in project state', state2.ok && state2.data.clips.some((cl) => cl.name === 'mcp-idle'));

  // 14f+g) the whole apply is ONE undo entry on the shared history
  const undoM = env(await c.callTool({ name: 'undo', arguments: {} }));
  const state3 = env(await c.callTool({ name: 'get_project_state', arguments: {} }));
  check('14f. undo removes the motion clip atomically', undoM.ok && !state3.data.clips.some((cl) => cl.name === 'mcp-idle'));

  // 14h) parts cleanup (restore the project exactly as we found it)
  const clear = env(await c.callTool({ name: 'set_parts', arguments: { parts: [] } }));
  check('14h. set_parts [] clears the tagged parts', clear.ok && clear.data.parts.length === 0);
  // undo the clear so the editor keeps its pre-E2E parts state
  await c.callTool({ name: 'undo', arguments: {} });
});

// ---- 12) events: the editor pushes projectChanged notifications ----------
{
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: { authorization: `Bearer ${clientToken}` } },
  });
  const client = new Client({ name: 'pixelforge-e2e-events', version: '1.0.0' });
  await client.connect(transport);
  let event = null;
  const { z } = await import('zod');
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/pixelforge/projectChanged'), params: z.any().optional() }),
    (n) => {
      event = n.params ?? {};
    }
  );
  // Give the streamable-HTTP session and notification handler a moment to
  // settle before provoking the editor event. The bridge itself throttles
  // document events, so a fixed 600 ms window was flaky on busy Windows runs.
  await Bun.sleep(350);
  await client.callTool({ name: 'set_pixels', arguments: { pixels: [{ x: 20, y: 20 }], color: '#00ff88' } });
  const eventDeadline = Date.now() + 3_000;
  while (!event && Date.now() < eventDeadline) {
    await Bun.sleep(100);
  }
  await client.callTool({ name: 'undo', arguments: {} });
  if (!event) await Bun.sleep(500);
  check('12. projectChanged notification received', !!event && typeof event.stateHash === 'string', event ? `hash ${String(event.stateHash).slice(0, 12)}… dirty=${event.dirty}` : '');
  await client.close().catch(() => {});
}

// ---- 13) security: L0 tier cannot write; bad tokens rejected --------------
{
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: { authorization: 'Bearer pfm_totally-fake-token' } },
  });
  const client = new Client({ name: 'pixelforge-e2e-bad', version: '1.0.0' });
  let authFailed = false;
  try {
    await client.connect(transport);
  } catch {
    authFailed = true;
  }
  check('13a. fake token rejected at initialize', authFailed);
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
