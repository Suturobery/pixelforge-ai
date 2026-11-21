// E2E art task: 4-frame chibi slime fire attack, drawn with local editor
// tools only (no image generation, no API keys). One batch = one undoable
// transaction. Then preview + validate.
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFileSync, writeFileSync } from 'node:fs';

const MCP_URL = 'http://127.0.0.1:3030/mcp';
const code = process.env.PF_PAIR_CODE!;
const tokenFile = 'C:/Users/Client/AppData/Local/Temp/pf-mcp-token.txt';

function envelope(result: unknown): { ok: boolean; data?: any; error?: any; summary?: string } {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r?.content?.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}

async function withClient(bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'zcode-ide-agent', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

// pair first (single-use code), save the persistent token for reuse
function envelope0(result: unknown): { ok: boolean; data?: any } {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const text = r?.content?.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}
const pairTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: { headers: { authorization: `Bearer ${code}` } },
});
const pairClient = new Client({ name: 'zcode-ide-agent', version: '1.0.0' });
await pairClient.connect(pairTransport);
const paired = envelope0(await pairClient.callTool({ name: 'pair_client', arguments: { name: 'zcode-ide-agent' } }));
if (!paired.ok) {
  console.log('PAIRING FAILED:', JSON.stringify(paired.error));
  process.exit(1);
}
const token = (paired.data as { token: string }).token;
writeFileSync(tokenFile, token, 'utf8');
console.log('paired — token', token.slice(0, 8) + '… (masked), saved for reuse');
await pairClient.close();

const client = await withClient(token);

const results: Array<[string, boolean, string]> = [];
const record = (name: string, ok: boolean, note = '') => {
  results.push([name, ok, note]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  — ' + note : ''}`);
};

// context: real palette
const palette = envelope(await client.callTool({ name: 'get_palette', arguments: {} }));
const colors: string[] = (palette.data as { palette?: string[] })?.palette ?? [];

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const lum = (c: string) => { const [r, g, b] = rgb(c); return 0.299 * r + 0.587 * g + 0.114 * b; };
const sat = (c: string) => { const [r, g, b] = rgb(c); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };

// palette picks for the art (Style Lock: dark-1px outline, top-left light)
let body = colors[0], dark = colors[0], belly = colors[0], shine = colors[0], eyeW = colors[0];
let fireO = '', fireY = '', fireR = '';
let bestGreen = -1, bestDark = 999, bestBelly = -1, bestShine = -1, bestEyeW = 999;
let bestFireO = -1, bestFireY = -1, bestFireR = -1;
for (const c of colors) {
  const [r, g, b] = rgb(c);
  const L = lum(c), S = sat(c);
  if (g > r && g > b && S > 0.25 && g > bestGreen) { bestGreen = g; body = c; }
  if (L < bestDark) { bestDark = L; dark = c; }
  if (g > 100 && L > 110 && L > bestBelly && S <= 0.45) { bestBelly = L; belly = c; }
  if (L > bestShine && S < 0.25) { bestShine = L; shine = c; }
  if (L > 170 && S < 0.12 && bestEyeW > L) { /* near-white */ }
  if (r > 150 && r > b * 1.6 && g > 90 && g < r && S > 0.45) { const o = r + g - b; if (o > bestFireO) { bestFireO = o; fireO = c; } }
  if (r > 180 && g > 150 && b < 120) { const y = r + g - b; if (y > bestFireY) { bestFireY = y; fireY = c; } }
  if (r > 140 && r > g * 1.5 && r > b * 1.5 && S > 0.5) { if (r > bestFireR) { bestFireR = r; fireR = c; } }
}
if (!fireO) fireO = colors[Math.min(6, colors.length - 1)];
if (!fireY) fireY = colors[Math.min(10, colors.length - 1)];
if (!fireR) fireR = colors[Math.min(2, colors.length - 1)];
// eye white: brightest low-sat
let bestEyeWLum = -1;
for (const c of colors) { const [r, g, b] = rgb(c); const L = lum(c), S = sat(c); if (S < 0.2 && L > bestEyeWLum) { bestEyeWLum = L; eyeW = c; } }
console.log('palette picks — body:', body, '| dark:', dark, '| belly:', belly, '| eyeW:', eyeW, '| fireO:', fireO, '| fireY:', fireY, '| fireR:', fireR);

// slime geometry per frame: [frameIndex, cx, cy, rx, ry, mouthOpen, fire]
const frames = [
  { fi: 0, cx: 13, cy: 22, rx: 7, ry: 5, mouth: false, fire: false }, // crouch (anticipation)
  { fi: 1, cx: 15, cy: 21, rx: 7, ry: 6, mouth: true, fire: false },  // lunge
  { fi: 2, cx: 16, cy: 20, rx: 7, ry: 6, mouth: true, fire: true },   // attack + fire burst
  { fi: 3, cx: 14, cy: 22, rx: 7, ry: 6, mouth: false, fire: false }, // recover
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
  return { pts, ring };
}

function framePixels(f: (typeof frames)[number]): Array<{ x: number; y: number; color: string }> {
  const out: Array<{ x: number; y: number; color: string }> = [];
  const { pts, ring } = ellipse(f.cx, f.cy, f.rx, f.ry);
  for (const p of ring) out.push({ x: p.x, y: p.y, color: dark });
  for (const p of pts) if (!ring.some((r) => r.x === p.x && r.y === p.y)) out.push({ x: p.x, y: p.y, color: body });
  // belly (bottom-front patch)
  for (const p of pts) {
    if (p.y >= f.cy + 2 && p.x >= f.cx - 2 && !ring.some((r) => r.x === p.x && r.y === p.y)) {
      const hit = out.find((o) => o.x === p.x && o.y === p.y);
      if (hit) hit.color = belly;
    }
  }
  // top-left light: lighten two interior px at upper-left
  for (const p of pts) {
    if (p.x === f.cx - 3 && p.y === f.cy - 2) {
      const hit = out.find((o) => o.x === p.x && o.y === p.y);
      if (hit) hit.color = shine;
    }
  }
  // eyes (chibi: white + dark pupil)
  const eyeY = f.cy - 2;
  out.push({ x: f.cx + 1, y: eyeY, color: eyeW }, { x: f.cx + 1, y: eyeY + 1, color: dark });
  out.push({ x: f.cx + 4, y: eyeY, color: eyeW }, { x: f.cx + 4, y: eyeY + 1, color: dark });
  // mouth
  if (f.mouth) {
    out.push({ x: f.cx + 2, y: f.cy + 1, color: dark });
    out.push({ x: f.cx + 3, y: f.cy + 1, color: dark });
  }
  // fire burst (attack frame): cone to the right of the mouth
  if (f.fire) {
    for (let x = f.cx + 6; x <= f.cx + 11; x++) {
      const spread = Math.min(3, x - (f.cx + 5));
      for (let dy = -spread; dy <= spread; dy++) {
        const y = f.cy - 1 + dy;
        const dist = x - (f.cx + 5);
        const c = dist <= 1 ? fireY : dist <= 3 ? fireO : fireR;
        out.push({ x, y, color: c });
      }
    }
  }
  return out;
}

// build the batch: add clip with 4 frames, paint each frame
const steps: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'add_clip', args: { name: 'slime-fire-attack', fps: 8, frameCount: 4 } },
];
for (const f of frames) {
  steps.push({
    tool: 'set_pixels',
    args: { clipName: 'slime-fire-attack', frameIndex: f.fi, pixels: framePixels(f) },
  });
}
console.log('batch steps:', steps.length, '| total stamps:', steps.slice(1).reduce((n, s) => n + ((s.args as any).pixels as any[]).length, 0));

const batch = envelope(await client.callTool({ name: 'batch', arguments: { steps, stopOnError: true } }));
const batchOut = batch.data as { results?: Array<{ ok: boolean; error?: any; tool?: string }> };
for (const r of batchOut?.results ?? []) if (!r.ok) console.log('  failed step:', r.tool ?? '?', JSON.stringify(r.error));
const bad = (batchOut?.results ?? []).filter((r) => !r.ok);
record('batch (clip + 4 painted frames)', batch.ok && bad.length === 0, batch.ok ? `steps ok: ${(batchOut.results ?? []).length - bad.length}/${batchOut.results.length}` : JSON.stringify(batch.error ?? bad));

// preview + validate
const preview = envelope(await client.callTool({ name: 'preview_animation', arguments: { clipName: 'slime-fire-attack' } }));
const prevData = preview.data as { frames?: unknown[]; invariants?: any; fps?: number };
record('preview_animation', preview.ok && (prevData.frames?.length ?? 0) === 4, preview.ok ? `${prevData.frames?.length}f @ ${prevData.fps}fps · emptyFrames=${JSON.stringify(prevData.invariants?.emptyFrames ?? 'ok')}` : JSON.stringify(preview.error));

const validate = envelope(await client.callTool({ name: 'validate_style', arguments: { clipName: 'slime-fire-attack', allowEdgeTouch: true } }));
const valData = validate.data as { warnings?: string[] };
record('validate_style', validate.ok, validate.ok ? `warnings=${valData.warnings?.length ?? 0}${valData.warnings?.length ? ' — ' + valData.warnings[0] : ''}` : JSON.stringify(validate.error));

// grab the attack frame (frameIndex 2) as evidence
const png = envelope(await client.callTool({ name: 'get_frame_png', arguments: { clipName: 'slime-fire-attack', frameIndex: 2 } }));
const b64: string = ((png.data as any)?.png ?? '').replace(/^data:image\/png;base64,/, '');
writeFileSync('C:/Users/Client/AppData/Local/Temp/slime-attack-frame.png', Buffer.from(b64, 'base64'));
console.log('attack frame saved:', b64.length, 'bytes');

await client.close();

const failed = results.filter(([, ok]) => !ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
