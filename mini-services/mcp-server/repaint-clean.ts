// Clean repaint: delete old clip, add new, paint with color-grouped calls.
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFileSync } from 'node:fs';

const MCP_URL = 'http://127.0.0.1:3030/mcp';
const token = readFileSync('C:/Users/Client/AppData/Local/Temp/pf-mcp-token.txt', 'utf8').trim();

function envelope(result: unknown): { ok: boolean; data?: any; error?: any } {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r?.content?.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}

const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'zcode-ide-agent', version: '1.0.0' });
await client.connect(transport);

const results: Array<[string, boolean, string]> = [];
const record = (name: string, ok: boolean, note = '') => {
  results.push([name, ok, note]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  — ' + note : ''}`);
};

// read palette + pick colors
const palette = envelope(await client.callTool({ name: 'get_palette', arguments: {} }));
const colors: string[] = (palette.data as { palette?: string[] })?.palette ?? [];
function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const lum = (c: string) => { const [r, g, b] = rgb(c); return 0.299 * r + 0.587 * g + 0.114 * b; };
const sat = (c: string) => { const [r, g, b] = rgb(c); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };
let body = colors[0], dark = colors[0], belly = colors[0], shine = colors[0], eyeW = colors[0];
let bestGreen = -1, bestDark = 999, bestBelly = -1, bestShine = -1;
for (const c of colors) {
  const [r, g, b] = rgb(c);
  const L = lum(c), S = sat(c);
  if (g > r && g > b && S > 0.25 && g > bestGreen) { bestGreen = g; body = c; }
  if (L < bestDark) { bestDark = L; dark = c; }
  if (g > 100 && L > 110 && L > bestBelly && S <= 0.45) { bestBelly = L; belly = c; }
  if (L > bestShine && S < 0.25) { bestShine = L; shine = c; }
  if (S < 0.15 && L > 160) { if (L > 160) { eyeW = c; } }
}
record('palette picks', true, `body=${body} dark=${dark} belly=${belly} shine=${shine}`);

// delete the old clip (already exists from previous run)
const del = envelope(await client.callTool({ name: 'delete_clip', arguments: { clipName: 'slime-fire-attack' } }));
record('delete_clip', del.ok, del.ok ? 'old clip removed' : JSON.stringify(del.error));

// add new clip with 4 frames
const add = envelope(await client.callTool({ name: 'add_clip', arguments: { name: 'slime-fire-attack', fps: 8, frameCount: 4 } }));
const clipData = add.data as { clipId?: string };
const clipId = clipData?.clipId;
record('add_clip', add.ok && Boolean(clipId), add.ok ? `clip ${clipId} created` : JSON.stringify(add.error));

if (!add.ok || !clipId) {
  console.log('SUMMARY: add_clip failed, stopping');
  process.exit(1);
}

// get the project state to find the frame ids
const state = envelope(await client.callTool({ name: 'get_project_state', arguments: {} }));
const proj = state.data as { clips?: Array<{ id: string; name: string; frames?: Array<{ id: string }> }> };
const targetClip = (proj.clips ?? []).find((c: any) => c.id === clipId) ?? (proj.clips ?? []).find((c: any) => c.name === 'slime-fire-attack');
if (!targetClip) {
  console.log('SUMMARY: FAIL — target clip not found after creation');
  process.exit(1);
}
const frameIds = (targetClip.frames ?? []).map((f: any) => f.id);
record('get_project_state', true, `clip has ${frameIds.length} frames`);

// paint each frame with color-grouped set_pixels calls
// slime design: chibi blob facing right, dark outline, top-left light
const slimeFrames = [
  { cx: 13, cy: 22, rx: 7, ry: 5, mouth: false },
  { cx: 15, cy: 21, rx: 7, ry: 6, mouth: true },
  { cx: 16, cy: 20, rx: 7, ry: 6, mouth: true, fire: true },
  { cx: 14, cy: 22, rx: 7, ry: 6, mouth: false },
];

function ellipse(cx: number, cy: number, rx: number, ry: number) {
  const inside = new Set<string>();
  const pts: Array<{ x: number; y: number }> = [];
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -rx; dx <= rx; dx++) {
      if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1) {
        pts.push({ x: cx + dx, y: cy + dy });
        inside.add(`${cx + dx},${cy + dy}`);
      }
    }
  }
  const ring = pts.filter((p) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !inside.has(`${p.x + dx},${p.y + dy}`)));
  return { pts: pts.filter((p) => !ring.includes(p)), ring: ring.map((p) => ({ x: p.x, y: p.y })) };
}

for (let fi = 0; fi < slimeFrames.length; fi++) {
  const f = slimeFrames[fi];
  const { pts, ring } = ellipse(f.cx, f.cy, f.rx, f.ry);
  const frameId = frameIds[fi];

  // group stamps by color
  const colorGroups: Record<string, Stamp[]> = {};
  const add = (color: string, x: number, y: number) => {
    if (!colorGroups[color]) colorGroups[color] = [];
    colorGroups[color].push({ x, y });
  };

  // dark outline ring
  for (const p of ring) add(dark, p.x, p.y);
  // interior body
  for (const p of pts) {
    if (ring.some((r) => r.x === p.x && r.y === p.y)) continue;
    add(body, p.x, p.y);
  }
  // belly (bottom-front patch)
  for (const p of pts) {
    if (p.y >= f.cy + 2 && p.x >= f.cx - 2) add(belly, p.x, p.y);
  }
  // top-left shine
  const shineP = pts.find((p) => p.x === f.cx - 3 && p.y === f.cy - 2);
  if (shineP) add(shine, shineP.x, shineP.y);
  // eyes (white + dark)
  const eyeY = f.cy - 2;
  add(eyeW, f.cx + 1, eyeY);
  add(dark, f.cx + 1, eyeY + 1);
  add(eyeW, f.cx + 4, eyeY);
  add(dark, f.cx + 4, eyeY + 1);
  // mouth
  if (f.mouth) { add(dark, f.cx + 2, f.cy + 1); add(dark, f.cx + 3, f.cy + 1); }

  // emit one set_pixels call per color group
  let painted = 0;
  for (const [color, stamps] of Object.entries(colorGroups)) {
    const res = envelope(
      await client.callTool({
        name: 'set_pixels',
        arguments: { clipId: clipId, frameId: frameId, pixels: stamps.map((s) => ({ x: s.x, y: s.y })), color },
      }),
    );
    if (res.ok) painted += stamps.length;
  }
  console.log(`  frame ${fi}: ${painted} px painted`);
}

// validate
const validate = envelope(await client.callTool({ name: 'validate_style', arguments: { clipName: 'slime-fire-attack' } }));
const valData = validate.data as { warnings?: string[] };
record('validate_style', validate.ok, validate.ok ? `warnings=${valData.warnings?.length ?? 0}` : JSON.stringify(validate.error));

// preview
const preview = envelope(await client.callTool({ name: 'preview_animation', arguments: { clipName: 'slime-fire-attack' } }));
const prevData = preview.data as { frames?: unknown[] };
record('preview_animation', preview.ok && (prevData.frames?.length ?? 0) === 4, preview.ok ? `${prevData.frames?.length}f` : JSON.stringify(preview.error));

await client.close();

const failed = results.filter(([, ok]) => !ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
