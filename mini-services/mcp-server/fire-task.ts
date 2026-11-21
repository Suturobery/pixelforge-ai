// Live art task: 4-frame fire animation via PixelForge's local procedural
// VFX tool — no image generation, no API keys. Runs as an external MCP
// client against the running app:
//   PF_PAIR_CODE=<6-word code> bun fire-task.ts
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const MCP_URL = 'http://127.0.0.1:3030/mcp';
const code = process.env.PF_PAIR_CODE;
if (!code) {
  console.error('PF_PAIR_CODE env required');
  process.exit(2);
}

const results: Array<[string, boolean, string]> = [];
const record = (name: string, ok: boolean, note = '') => {
  results.push([name, ok, note]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  — ' + note : ''}`);
};

function envelope(result: unknown): { ok: boolean; data?: any; error?: any; summary?: string; stateHash?: string } {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r?.content?.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}

async function withClient(bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'zcode-art-task', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function main() {
  // 0. pair
  const pairing = await withClient(code!);
  const paired = envelope(await pairing.callTool({ name: 'pair_client', arguments: { name: 'zcode-art-task' } }));
  if (!paired.ok) {
    console.log('pairing failed:', JSON.stringify(paired.error));
    process.exit(1);
  }
  const token = (paired.data as { token: string }).token;
  console.log('paired — persistent token', token.slice(0, 8) + '… (masked)');
  await pairing.close();
  const client = await withClient(token);

  // 1. inspect active project + palette
  const state = envelope(await client.callTool({ name: 'get_project_state', arguments: {} }));
  const proj = state.data as { name: string; width: number; height: number; clips?: Array<{ id: string; name: string; frames?: unknown[] }> };
  record('get_project_state', state.ok, state.ok ? `project "${proj.name}" · ${proj.width}×${proj.height}` : JSON.stringify(state.error));

  const palette = envelope(await client.callTool({ name: 'get_palette', arguments: {} }));
  const palData = palette.data as { palette?: string[] };
  record('get_palette', palette.ok, palette.ok ? `${palData.palette?.length ?? 0} colors` : JSON.stringify(palette.error));

  // 2. pick the fire effect from the real catalog
  const vfxList = envelope(await client.callTool({ name: 'list_vfx', arguments: { category: 'fire' } }));
  const fireEffects = (vfxList.data as { effects?: Array<{ id: string }> })?.effects?.map((e) => e.id) ?? [];
  const effect = fireEffects.find((id) => id.includes('campfire')) ?? fireEffects[0];
  record('list_vfx', vfxList.ok && Boolean(effect), vfxList.ok ? `effect: ${effect}` : JSON.stringify(vfxList.error));
  if (!effect) {
    console.log('SUMMARY: stopped — no fire effect in catalog');
    process.exit(1);
  }

  // 3. generate the 4-frame fire animation (procedural, seeded, project palette)
  const gen = envelope(
    await client.callTool({
      name: 'generate_vfx',
      arguments: { effect, frames: 4, fps: 8, light: 0.6, palette: 'project', name: 'fire-4f' },
    }),
  );
  const genData = gen.data as { clipId?: string; clipName?: string; frames?: number; resolvedEffect?: string; paletteApplied?: boolean };
  record(
    'generate_vfx',
    gen.ok && genData?.clipId != null,
    gen.ok ? `clip "${genData.clipName}" · ${genData.frames}f · resolved=${genData.resolvedEffect} · projectPalette=${genData.paletteApplied}` : JSON.stringify(gen.error),
  );
  if (!gen.ok) {
    console.log(`SUMMARY: ${results.filter(([, ok]) => ok).length}/${results.length} PASS`);
    process.exit(1);
  }

  // 4. preview the new clip (frames + invariants)
  const preview = envelope(await client.callTool({ name: 'preview_animation', arguments: { clipId: genData.clipId } }));
  const prevData = preview.data as { frames?: Array<unknown>; invariants?: { emptyFrames?: unknown[]; uniformTiming?: boolean }; fps?: number };
  record(
    'preview_animation',
    preview.ok && (prevData.frames?.length ?? 0) > 0,
    preview.ok
      ? `${prevData.frames?.length}f @ ${prevData.fps}fps · invariants: emptyFrames=${JSON.stringify(prevData.invariants?.emptyFrames ?? 'ok')} uniformTiming=${prevData.invariants?.uniformTiming}`
      : JSON.stringify(preview.error),
  );

  // 5. validate style on frame 1 (VFX often touches edges → allowEdgeTouch)
  const state2 = envelope(await client.callTool({ name: 'get_project_state', arguments: {} }));
  const proj2 = state2.data as { clips?: Array<{ id: string; name: string; frames: Array<{ id: string }> }> };
  const clip2 = proj2.clips?.find((c) => c.id === genData.clipId);
  const firstFrameId = clip2?.frames?.[0]?.id;
  const validate = envelope(
    await client.callTool({
      name: 'validate_style',
      arguments: { clipId: genData.clipId, frameId: firstFrameId, allowEdgeTouch: true },
    }),
  );
  const valData = validate.data as { ok?: boolean; warnings?: string[] };
  record(
    'validate_style',
    validate.ok,
    validate.ok ? `passes=${valData.ok} warnings=${valData.warnings?.length ?? 0}${valData.warnings?.length ? ' — ' + valData.warnings[0] : ''}` : JSON.stringify(validate.error),
  );

  await client.close();

  // 6. what changed
  console.log('\n--- WHAT CHANGED (active document) ---');
  console.log(`+ new clip "${genData.clipName}" (${genData.frames} frames @ ${prevData.fps ?? 8}fps) — fire effect "${genData.resolvedEffect ?? effect}", rendered with the project palette`);
  console.log(`+ ${genData.frames} painted VFX frames via the deterministic local renderer (seeded, one undo transaction)`);
  console.log(`+ style validation: ${valData.ok ? 'passes' : 'warnings'} (${valData.warnings?.length ?? 0} warning(s))`);

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('client error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
