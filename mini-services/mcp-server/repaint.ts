// Repaint the slime-fire-attack frames with correct multi-color pixel art.
// The executor paints one color per set_pixels call, so stamps are grouped
// by color and emitted as separate calls within a batch.
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

async function withClient(bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'zcode-ide-agent', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

const client = await withClient(token);

// read the real palette
const palette = envelope(await client.callTool({ name: 'get_palette', arguments: {} }));
const colors: string[] = (palette.data as { palette?: string[] })?.palette ?? [];

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const lum = (c: string) => { const [r, g, b] = rgb(c); return 0.299 * r + 0.587 * g + 0.114 * b; };
const sat = (c: string) => { const [r, g, b] = rgb(c); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };

// pick colors from the project palette
let body = colors[0], dark = colors[0], belly = colors[0], shine = colors[0], eyeW = colors[0];
let fireO = colors[Math.min(6, colors.length - 1)], fireY = colors[Math.min(10, colors.length - 1)], fireR = colors[Math.min(2, colors.length - 1)];
let bestGreen = -1, bestDark = 999, bestBelly = -1, bestShine = -1, bestEyeW = 999;
let bestFireO = -1, bestFireY = -1, bestFireR = -1;
for (const c of colors) {
  const [r, g, b] = rgb(c);
  const L = lum(c), S = sat(c);
  if (g > r && g > b && S > 0.25 && g > bestGreen) { bestGreen = g; body = c; }
  if (L < bestDark) { bestDark = L; dark = c; }
  if (g > 100 && L > 110 && L > bestBelly && S <= 0.45) { bestBelly = L; belly = c; }
  if (L > bestShine && S < 0.25) { bestShine = L; shine = c; }
  if (r > 150 && r > b * 1.6 && g > 90 && g < r && S > 0.45) { const o = r + g - b; if (o > bestFireO) { bestFireO = o; fireO = c; } }
  if (r > 180 && g > 150 && b < 120) { const y = r + g - b; if (y > bestFireY) { bestFireY = y; fireY = c; } }
  if (r > 140 && r > g * 1.5 && r > b * 1.5 && S > 0.5) { if (r > bestFireR) { bestFireR = r; fireR = c; } }
}
let bestEyeWLum = -1;
for (const c of colors) { const [r, g, b] = rgb(c); const L = lum(c), S = sat(c); if (S < 0.2 && L > bestEyeWLum) { bestEyeWLum = L; eyeW = c; } }
console.log('palette picks — body:', body, '| dark:', dark, '| belly:', belly, '| eyeW:', eyeW, '| fireO:', fireO, '| fireY:', fireY, '| fireR:', fireR);

// slime frames: geometry + features
const frames = [
  { fi: 0, cx: 13, cy: 22, rx: 7, ry: 5, mouth: false, fire: false },
  { fi: 1, cx: 15, cy: 21, rx: 7, ry: 6, mouth: true, fire: false },
  { fi: 2, cx: 16, cy: 20, rx: 7, ry: 6, mouth: true, fire: true },
  { fi: 3, cx: 14, cy: 22, rx: 7, ry: 6, mouth: false, fire: false },
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
  return { pts, ring: ring.map((p) => ({ x: p.x, y: p.y })) };
}

// build color-grouped stamps per frame
type Stamp = { x: number; y: number };
type ColorGroup = { color: string; stamps: Stamp[] };

function frameStampGroups(f: (typeof frames)[number]): ColorGroup[] {
  const { pts, ring } = ellipse(f.cx, f.cy, f.rx, f.ry);
  const groups: Record<string, Stamp[]> = {};
  const add = (color: string, x: number, y: number) => {
    if (!groups[color]) groups[color] = [];
    groups[color].push({ x, y });
  };
  for (const p of ring) add(dark, p.x, p.y);
  for (const p of pts) {
    if (ring.some((r) => r.x === p.x && r.y === p.y)) continue;
    // belly for lower-front, body for the rest
    if (p.y >= f.cy + 2 && p.x >= f.cx - 2) add(belly, p.x, p.y);
    else add(body, p.x, p.y);
  }
  // top-left shine
  const shineP = pts.find((p) => p.x === f.cx - 3 && p.y === f.cy - 2);
  if (shineP) { groups[shine] = groups[shine] ?? []; groups[shine].push({ x: shineP.x, y: shineP.y }); }
  // eyes
  const eyeY = f.cy - 2;
  add(eyeW, f.cx + 1, eyeY);
  add(dark, f.cx + 1, eyeY + 1);
  add(eyeW, f.cx + 4, eyeY);
  add(dark, f.cx + 4, eyeY + 1);
  // mouth
  if (f.mouth) { add(dark, f.cx + 2, f.cy + 1); add(dark, f.cx + 3, f.cy + 1); }
  // fire burst (attack frame only)
  if (f.fire) {
    for (let x = f.cx + 6; x <= f.cx + 11; x++) {
      const spread = Math.min(3, x - (f.cx + 5));
      for (let dy = -spread; dy <= spread; dy++) {
        const y = f.cy - 1 + dy;
        const dist = x - (f.cx + 5);
        const c = dist <= 1 ? fireY : dist <= 3 ? fireO : fireR;
        add(c, x, y);
      }
    }
  }
  return Object.entries(groups).map(([color, stamps]) => ({ color, stamps }));
}

// build batch steps: add_clip + color-grouped set_pixels calls
const steps: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'delete_clip', args: { clipName: 'slime-fire-attack' } },
  { tool: 'add_clip', args: { name: 'slime-fire-attack', fps: 8, frameCount: 4 } },
];

for (const f of frames) {
  for (const group of frameStampGroups(f)) {
    steps.push({
      tool: 'set_pixels',
      args: { clipName: 'slime-fire-attack', frameIndex: f.fi, pixels: group.stamps.map((s) => ({ x: s.x, y: s.y })), color: group.color },
    });
  }
}

// fire details on frames 2 (attack pose fire burst)
for (const f of frames) {
  if (!f.fire) continue;
  steps.push({
    tool: 'set_pixels',
    args: {
      clipName: 'slime-fire-attack',
      frameIndex: f.fi,
      pixels: (function () {
        const px: Array<{ x: number; y: number }> = [];
        for (let x = f.cx + 6; x <= f.cx + 11; x++) {
          const spread = Math.min(3, x - (f.cx + 5));
          for (let dy = -spread; dy <= spread; dy++) {
            const y = f.cy - 1 + dy;
            const dist = x - (f.cx + 5);
            if (dist <= 1) px.push({ x, y });
            else if (dist <= 3) px.push({ x, y });
          }
        }
        return px;
      })(),
    },
  });
  break; // only frame 2 has fire
}

console.log('batch steps:', steps.length);

const batch = envelope(await client.callTool({ name: 'batch', arguments: { steps, stopOnError: true } }));
const batchOut = batch.data as { results?: Array<{ ok: boolean; error?: any }> };
const bad = (batchOut?.results ?? []).filter((r) => !r.ok);
record('batch repaint (delete + recreate + color-grouped paint)', batch.ok && bad.length === 0, batch.ok ? `steps ok: ${(batchOut.results ?? []).length - bad.length}/${batchOut.results.length}` : JSON.stringify(batch.error ?? bad));

// preview + validate
const preview = envelope(await client.callTool({ name: 'preview_animation', arguments: { clipName: 'slime-fire-attack' } }));
const prevData = preview.data as { frames?: unknown[]; invariants?: any; fps?: number };
record('preview_animation', preview.ok && (prevData.frames?.length ?? 0) === 4, preview.ok ? `${prevData.frames?.length}f @ ${prevData.fps}fps · emptyFrames=${JSON.stringify(prevData.invariants?.emptyFrames ?? 'ok')}` : JSON.stringify(preview.error));

const validate = envelope(await client.callTool({ name: 'validate_style', arguments: { clipName: 'slime-fire-attack', allowEdgeTouch: true } }));
const valData = validate.data as { warnings?: string[] };
record('validate_style', validate.ok, validate.ok ? `warnings=${valData.warnings?.length ?? 0}${valData.warnings?.length ? ' — ' + valData.warnings[0] : ''}` : JSON.stringify(validate.error));

await client.close();

const failed = results.filter(([, ok]) => !ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
