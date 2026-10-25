/**
 * Export golden tests (Task 7, v3.1 §7 + §13 "Export goldens: dimensions /
 * alpha / rect math").
 *
 * Mandate: tests compare ACTUAL DECODED IMAGE PIXELS (core decodePng), never
 * file existence or raw PNG bytes — the zlib stream may vary across
 * runtimes, decoded pixels must not.
 *
 * Fixtures are deterministic (explicit ids, no uid(), no clock): reviewed
 * literal byte expectations for every blending case. Any intentional
 * golden update must be explained in the worklog + Task 7 report.
 */

import { describe, expect, test } from 'bun:test';
import {
  EXPORT_METADATA_VERSION,
  ExportError,
  MemoryFs,
  SCHEMA_VERSION,
  buildAllArtifacts,
  buildClipMetadata,
  composeFrameRgba,
  composeSheetRgba,
  decodePng,
  planExport,
  resolveSheetLayout,
  sheetFrameOrigin,
  writeExportPlan,
  type Cel,
  type Clip,
  type Frame,
  type Layer,
  type Project,
} from '../src';
import type { FileFs } from '../src/persist/store';

// ---------------------------------------------------------------------------
// deterministic fixtures (reviewed; tiny 8×8 canvases)
// ---------------------------------------------------------------------------

const W = 8;
const H = 8;

function buffer(paint: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const [r, g, b, a] = paint(x, y);
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return buf;
}

function cel(paint: (x: number, y: number) => [number, number, number, number], linked = false): Cel {
  return { buffer: buffer(paint), linked };
}

function layer(id: string, name: string, opts?: Partial<Layer>): Layer {
  return { id, name, visible: true, opacity: 1, linked: false, ...opts };
}

function frame(id: string, cels: Record<string, Cel>, durationMs = 0): Frame {
  return { id, durationMs, cels };
}

const BG_BLUE: [number, number, number, number] = [20, 40, 220, 255];
const FG_RED: [number, number, number, number] = [235, 30, 30, 255];
const MARKER: [number, number, number, number] = [255, 214, 10, 255];

/** Clip A "idle": 4 frames, 2 layers — bg linked (shared buffer), fg animated. */
function mkIdleClip(): { clip: Clip; bgCel: Cel } {
  // Linked bg: ONE buffer object shared by every frame (C2/C19).
  const bgCel = cel(() => BG_BLUE, true);
  const clip: Clip = {
    id: 'clip_idle',
    name: 'idle',
    fps: 8,
    loop: true,
    loopMode: 'forward',
    layers: [layer('lay_bg', 'bg', { linked: true }), layer('lay_fg', 'fg')],
    parts: [],
    tags: [{ name: 'breathe', from: 1, to: 2 }],
    frames: [
      frame('f0', { lay_bg: bgCel, lay_fg: cel((x, y) => (x < 4 ? FG_RED : [0, 0, 0, 0])) }),
      frame('f1', { lay_bg: bgCel, lay_fg: cel((x, y) => (x >= 4 ? FG_RED : [0, 0, 0, 0])) }),
      // f2: per-frame duration overrides (golden #13)
      frame('f2', { lay_bg: bgCel, lay_fg: cel(() => [0, 0, 0, 0]) }, 500),
      // f3: EMPTY frame — no fg cel at all (golden #11); bg still linked.
      frame('f3', { lay_bg: bgCel }, 250),
    ],
  };
  return { clip, bgCel };
}

/** Clip B "walk": reverse, 2 frames, one 50%-opacity layer with alpha variety. */
function mkWalkClip(): Clip {
  return {
    id: 'clip_walk',
    name: 'walk',
    fps: 12,
    loop: true,
    loopMode: 'reverse',
    layers: [layer('lay_walk', 'walk', { opacity: 0.5 })],
    parts: [],
    tags: [],
    frames: [
      // alpha triplet: 0 / 128 / 255 (golden #6), plus semi pixel at (5,5)
      frame('w0', {
        lay_walk: cel((x, y) => {
          if (x === 0 && y === 0) return [0, 0, 0, 0];
          if (x === 1 && y === 0) return [255, 0, 0, 128];
          if (x === 2 && y === 0) return [0, 255, 0, 255];
          if (x === 5 && y === 5) return [255, 0, 0, 128];
          return [10, 10, 10, 255];
        }),
      }),
      frame('w1', {
        lay_walk: cel((x, y) => (x === 0 && y === 7 ? MARKER : [200, 200, 200, 255])),
      }),
    ],
  };
}

/** Clip C "bounce": ping-pong, play-once, 3 frames, empty + hidden layers. */
function mkBounceClip(hidden?: Layer[]): Clip {
  return {
    id: 'clip_bounce',
    name: 'bounce',
    fps: 10,
    loop: false,
    loopMode: 'pingpong',
    layers: hidden ?? [layer('lay_b', 'b')],
    parts: [],
    tags: [],
    frames: [
      frame('b0', { lay_b: cel(() => [1, 2, 3, 255]) }),
      frame('b1', { lay_b: cel(() => [4, 5, 6, 255]) }),
      frame('b2', { lay_b: cel(() => [7, 8, 9, 255]) }),
    ],
  };
}

function mkProject(): Project {
  return {
    id: null,
    schemaVersion: SCHEMA_VERSION,
    name: 'Golden Forge',
    width: W,
    height: H,
    palette: ['#1428dc', '#eb1e1e', '#ffd60a'],
    settings: { paletteEnforce: false, onion: { prev: 0, next: 0 } },
    clips: [mkIdleClip().clip, mkWalkClip(), mkBounceClip()],
    trash: [],
  };
}

async function decodeArtifact(bytes: Uint8Array) {
  return decodePng(bytes);
}

function expectBuffersEqual(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray, ctx?: string) {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      throw new Error(`byte mismatch at ${i} (${ctx ?? ''}): ${a[i]} !== ${b[i]}`);
    }
  }
}

function pixel(buf: Uint8Array | Uint8ClampedArray, w: number, x: number, y: number): [number, number, number, number] {
  const i = (y * w + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

/** Error-code helper: run fn, assert ExportError code. */
async function expectExportError(fn: () => unknown, code: ExportError['code']) {
  try {
    await fn();
    throw new Error(`expected ExportError ${code}, but nothing was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(ExportError);
    expect((err as ExportError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// golden #1 + #2 — frame PNGs
// ---------------------------------------------------------------------------

describe('golden: frame PNG exports', () => {
  test('#1 single-frame export: exact 8×8 RGBA, transparency preserved', async () => {
    const project = mkProject();
    const plan = planExport(project, { scope: 'frame', frameIndex: 0, format: 'png-frames' });
    expect(plan.artifacts).toHaveLength(1);
    expect(plan.artifacts[0].filename).toBe('golden-forge_idle_frame00.png');

    const [bytes] = await buildAllArtifacts(plan);
    const decoded = await decodeArtifact(bytes.bytes);
    expect(decoded.width).toBe(W);
    expect(decoded.height).toBe(H);

    const expected = composeFrameRgba(project, project.clips[0], project.clips[0].frames[0]);
    expectBuffersEqual(decoded.rgba, expected, 'frame0');
    // spot pixels: linked bg under fg / fg-only / transparent corner
    expect(pixel(decoded.rgba, W, 1, 0)).toEqual([FG_RED[0], FG_RED[1], FG_RED[2], 255]);
    expect(pixel(decoded.rgba, W, 5, 0)).toEqual(BG_BLUE); // fg absent here → bg
    expect(pixel(decoded.rgba, W, 7, 7)).toEqual(BG_BLUE); // linked bg everywhere
  });

  test('#2 multi-frame export: every frame decodes pixel-exact, names zero-padded', async () => {
    const project = mkProject();
    const plan = planExport(project, { scope: 'clip', format: 'png-frames' });
    expect(plan.artifacts.map((a) => a.filename)).toEqual([
      'golden-forge_idle_frame00.png',
      'golden-forge_idle_frame01.png',
      'golden-forge_idle_frame02.png',
      'golden-forge_idle_frame03.png',
    ]);
    const built = await buildAllArtifacts(plan);
    const clip = project.clips[0];
    for (let i = 0; i < clip.frames.length; i++) {
      const decoded = await decodeArtifact(built[i].bytes);
      expect(decoded.width).toBe(W);
      expect(decoded.height).toBe(H);
      expectBuffersEqual(decoded.rgba, composeFrameRgba(project, clip, clip.frames[i]), `frame${i}`);
    }
  });

  test('#2b zero-pad option off → legacy frame0 names', async () => {
    const project = mkProject();
    const plan = planExport(project, { scope: 'frame', frameIndex: 2, format: 'png-frames', zeroPadFrames: 0 });
    expect(plan.artifacts[0].filename).toBe('golden-forge_idle_frame2.png');
  });
});

// ---------------------------------------------------------------------------
// golden #3–#5 — sheet layouts + padding/spacing
// ---------------------------------------------------------------------------

describe('golden: sprite-sheet layouts', () => {
  test('#3 horizontal strip: single row, rect math + gap transparency', async () => {
    const project = mkProject();
    const clip = project.clips[0];
    const { rgba, layout } = composeSheetRgba(project, clip, { columns: 0, padding: 1 });
    expect(layout.layout).toBe('horizontal');
    expect(layout.columns).toBe(4);
    expect(layout.rows).toBe(1);
    expect(layout.width).toBe(2 * 1 + 4 * W + 3 * 1); // 2·pad + cols·w + (cols−1)·spacing (= legacy (cols+1)·pad when spacing defaults to padding)
    expect(layout.height).toBe(2 * 1 + H);

    // x of frame i = pad + i*(w+spacing) = 1 + i*9; rows start at pad (outer margin)
    for (let i = 0; i < 4; i++) {
      const x = 1 + i * (W + 1);
      const expected = composeFrameRgba(project, clip, clip.frames[i]);
      for (let y = 0; y < H; y++) {
        const si = ((y + layout.padding) * layout.width + x) * 4;
        expectBuffersEqual(
          rgba.subarray(si, si + W * 4),
          expected.subarray(y * W * 4, y * W * 4 + W * 4),
          `hstrip f${i} row${y}`,
        );
      }
      // gap column before frame i is fully transparent
      if (i > 0) {
        for (let y = 0; y < layout.height; y++) {
          expect(pixel(rgba, layout.width, x - 1, y)[3]).toBe(0);
        }
      }
    }
  });

  test('#4 grid layout: 2 columns → 2×2, row/col origin math', async () => {
    const project = mkProject();
    const clip = project.clips[0];
    const { layout } = composeSheetRgba(project, clip, { columns: 2, padding: 1, spacing: 1 });
    expect(layout.layout).toBe('grid');
    expect(layout.columns).toBe(2);
    expect(layout.rows).toBe(2);
    expect(layout.width).toBe(2 * 1 + 2 * W + 1 * 1); // 2·pad + cols·w + (cols−1)·spacing
    expect(layout.height).toBe(2 * 1 + 2 * H + 1 * 1);

    const built = await buildAllArtifacts(planExport(project, { scope: 'clip', format: 'sheet', sheet: { columns: 2, padding: 1, spacing: 1 } }));
    const decoded = await decodeArtifact(built[0].bytes);
    expect(decoded.width).toBe(layout.width);
    expect(decoded.height).toBe(layout.height);
    for (let i = 0; i < 4; i++) {
      const { x, y } = sheetFrameOrigin(layout, i);
      expect(x).toBe(1 + (i % 2) * (W + 1)); // pitch = w + spacing
      expect(y).toBe(1 + Math.floor(i / 2) * (H + 1));
      const expected = composeFrameRgba(project, clip, clip.frames[i]);
      for (let yy = 0; yy < H; yy++) {
        const si = ((y + yy) * layout.width + x) * 4;
        expectBuffersEqual(decoded.rgba.subarray(si, si + W * 4), expected.subarray(yy * W * 4, yy * W * 4 + W * 4), `grid f${i} r${yy}`);
      }
    }
  });

  test('#5 padding values 0/2/3 and spacing default = padding (legacy single-knob)', async () => {
    const project = mkProject();
    const clip = project.clips[0];
    for (const pad of [0, 2, 3]) {
      const legacy = resolveSheetLayout(project, clip, { columns: 2, padding: pad });
      // spacing omitted → defaults to padding (old `(cols+1)*pad` geometry)
      expect(legacy.width).toBe(2 * W + 3 * pad);
      expect(legacy.height).toBe(2 * H + 3 * pad);
      const explicit = resolveSheetLayout(project, clip, { columns: 2, padding: pad, spacing: 0 });
      expect(explicit.width).toBe(2 * W + 2 * pad); // outer margin only, no gaps
    }
    // decoded sheet honors padding=2 outer margin: border rows fully transparent
    const { rgba, layout } = composeSheetRgba(project, clip, { columns: 2, padding: 2 });
    for (let x = 0; x < layout.width; x++) {
      expect(pixel(rgba, layout.width, x, 0)[3]).toBe(0);
      expect(pixel(rgba, layout.width, x, layout.height - 1)[3]).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// golden #6–#9 — alpha, layers, opacity
// ---------------------------------------------------------------------------

describe('golden: alpha + layer compositing', () => {
  test('#6 transparent + partially transparent pixels survive encode→decode byte-exact', async () => {
    // dedicated full-opacity fixture: alpha triplet 0 / 128 / 255 per row 0
    const project = mkProject();
    const clip: Clip = {
      id: 'clip_alpha',
      name: 'alpha',
      fps: 8,
      loop: true,
      loopMode: 'forward',
      layers: [layer('lay_a', 'a')],
      parts: [],
      tags: [],
      frames: [
        frame('a0', {
          lay_a: cel((x, y) => {
            if (x === 0 && y === 0) return [0, 0, 0, 0];
            if (x === 1 && y === 0) return [255, 0, 0, 128];
            if (x === 2 && y === 0) return [0, 255, 0, 255];
            return [10, 10, 10, 255];
          }),
        }),
      ],
    };
    project.clips = [clip];
    const plan = planExport(project, { scope: 'clip', clipId: 'clip_alpha', format: 'png-frames' });
    const decoded = await decodeArtifact((await buildAllArtifacts(plan))[0].bytes);
    expect(pixel(decoded.rgba, W, 0, 0)).toEqual([0, 0, 0, 0]);
    // straight passthrough: semi pixel alone keeps its exact color + alpha 128
    expect(pixel(decoded.rgba, W, 1, 0)).toEqual([255, 0, 0, 128]);
    expect(pixel(decoded.rgba, W, 2, 0)).toEqual([0, 255, 0, 255]);
  });

  test('#7 multiple visible layers composite bottom→top', () => {
    const project = mkProject();
    const clip = project.clips[0];
    const frame0 = clip.frames[0];
    // fg covers x<4 opaque red, bg linked blue everywhere → left red, right blue
    const out = composeFrameRgba(project, clip, frame0);
    expect(pixel(out, W, 0, 0)).toEqual([FG_RED[0], FG_RED[1], FG_RED[2], 255]);
    expect(pixel(out, W, 6, 3)).toEqual(BG_BLUE);
  });

  test('#8 hidden layers are excluded from exports', () => {
    const project = mkProject();
    const hidden = [layer('lay_b', 'b', { visible: false }), layer('lay_top', 'top')];
    const clip = mkBounceClip([hidden[0], hidden[1]]);
    clip.frames = [
      frame('b0', { lay_b: cel(() => [1, 2, 3, 255]), lay_top: cel(() => [250, 250, 250, 255]) }),
    ];
    project.clips = [clip];
    const out = composeFrameRgba(project, clip, clip.frames[0]);
    // hidden layer's (0,0) must NOT appear; visible top layer does
    expect(pixel(out, W, 0, 0)).toEqual([250, 250, 250, 255]);
    expect(pixel(out, W, 7, 7)).toEqual([250, 250, 250, 255]);
  });

  test('#9 layer opacity blends with hand-computed literal bytes', () => {
    const project = mkProject();
    const walk = project.clips[1]; // lay_walk opacity 0.5
    const out = composeFrameRgba(project, walk, walk.frames[0]);
    // src alpha 0 → untouched
    expect(pixel(out, W, 0, 0)).toEqual([0, 0, 0, 0]);
    // src (255,0,0,128) @0.5 over transparent → sa=(128/255)*0.5; a=round(sa*255)=64, color (255,0,0)
    expect(pixel(out, W, 1, 0)).toEqual([255, 0, 0, 64]);
    // opaque dark (10,10,10,255) @0.5 over transparent → (10,10,10,128)
    expect(pixel(out, W, 3, 3)).toEqual([10, 10, 10, 128]);

    // hand-computed over an opaque dst (FG_RED 235,30,30 @0.5 over BG_BLUE 20,40,220):
    //   sa=.5, oa=1 → r=(235·.5+20·.5)=127.5→128, g=(30·.5+40·.5)=35, b=(30·.5+220·.5)=125, a=255
    const p2 = mkProject();
    const c2: Clip = {
      id: 'c',
      name: 'op',
      fps: 8,
      loop: true,
      loopMode: 'forward',
      layers: [layer('bg', 'bg'), layer('fg', 'fg', { opacity: 0.5 })],
      parts: [],
      tags: [],
      frames: [frame('x', { bg: cel(() => BG_BLUE), fg: cel((x, y) => (x === 0 && y === 0 ? FG_RED : [0, 0, 0, 0])) })],
    };
    p2.clips = [c2];
    const out2 = composeFrameRgba(p2, c2, c2.frames[0]);
    expect(pixel(out2, W, 0, 0)).toEqual([128, 35, 125, 255]); // red@50% over blue
    expect(pixel(out2, W, 1, 1)).toEqual(BG_BLUE); // fg transparent → bg untouched

    // semi src over semi dst (no opacity modifier):
    //   (255,0,0,128) over (0,0,255,128) → a=192, r=170, b=85 (hand-derived)
    const p3 = mkProject();
    const c3: Clip = {
      id: 'c3',
      name: 'semi',
      fps: 8,
      loop: true,
      loopMode: 'forward',
      layers: [layer('bg', 'bg'), layer('fg', 'fg')],
      parts: [],
      tags: [],
      frames: [
        frame(
          'y',
          {
            bg: cel((x, y) => (x === 0 && y === 0 ? [0, 0, 255, 128] : [0, 0, 0, 0])),
            fg: cel((x, y) => (x === 0 && y === 0 ? [255, 0, 0, 128] : [0, 0, 0, 0])),
          },
        ),
      ],
    };
    p3.clips = [c3];
    const out3 = composeFrameRgba(p3, c3, c3.frames[0]);
    expect(pixel(out3, W, 0, 0)).toEqual([170, 0, 85, 192]);
  });
});

// ---------------------------------------------------------------------------
// golden #10–#12 — linked cels, empty frames, multiple clips
// ---------------------------------------------------------------------------

describe('golden: linked cels, empty frames, multi-clip', () => {
  test('#10 linked cel: shared buffer appears identically on every exported frame', async () => {
    const project = mkProject();
    const clip = project.clips[0];
    const bgCel = clip.frames[0].cels['lay_bg'];
    // model invariant: every frame references the SAME buffer object
    for (const f of clip.frames) expect(f.cels['lay_bg']!.buffer).toBe(bgCel!.buffer);
    const built = await buildAllArtifacts(planExport(project, { scope: 'clip', format: 'png-frames' }));
    // per-frame probe spots: bg is visible where that frame's fg is transparent
    const bgSpot: [number, number][] = [
      [7, 0], // f0: fg covers x<4 → (7,0) shows linked bg
      [0, 0], // f1: fg covers x≥4 → (0,0) shows linked bg
      [0, 0], // f2: fg fully transparent
      [0, 0], // f3: bare linked bg
    ];
    for (let i = 0; i < clip.frames.length; i++) {
      const decoded = await decodeArtifact(built[i].bytes);
      expect(pixel(decoded.rgba, W, bgSpot[i][0], bgSpot[i][1])).toEqual(BG_BLUE);
    }
    // fg animation differs per frame while bg stays shared
    const f0 = await decodeArtifact(built[0].bytes);
    const f1 = await decodeArtifact(built[1].bytes);
    expect(pixel(f0.rgba, W, 0, 0)).toEqual([FG_RED[0], FG_RED[1], FG_RED[2], 255]);
    expect(pixel(f1.rgba, W, 7, 0)).toEqual([FG_RED[0], FG_RED[1], FG_RED[2], 255]);
  });

  test('#11 empty frame exports as fully transparent PNG of exact canvas size', async () => {
    const project = mkProject();
    const clip = project.clips[0];
    clip.frames[3] = { id: 'bare', durationMs: 0, cels: {} }; // no cels at all
    const plan = planExport(project, { scope: 'frame', frameIndex: 3, format: 'png-frames' });
    const [artifact] = await buildAllArtifacts(plan);
    const decoded = await decodeArtifact(artifact.bytes);
    expect(decoded.width).toBe(W);
    expect(decoded.height).toBe(H);
    let nonZero = 0;
    for (let i = 3; i < decoded.rgba.length; i += 4) if (decoded.rgba[i] !== 0) nonZero++;
    expect(nonZero).toBe(0);
  });

  test('#12 multiple clips: one deterministic artifact set per clip', async () => {
    const project = mkProject();
    const plan = planExport(project, { scope: 'all-clips', format: 'sheet', sheet: { columns: 0, padding: 1 }, includeJson: true });
    expect(plan.clipCount).toBe(3);
    expect(plan.artifacts.map((a) => a.filename)).toEqual([
      'golden-forge_idle_sheet.png',
      'golden-forge_idle.json',
      'golden-forge_walk_sheet.png',
      'golden-forge_walk.json',
      'golden-forge_bounce_sheet.png',
      'golden-forge_bounce.json',
    ]);
    const built = await buildAllArtifacts(plan);
    for (const a of plan.artifacts.filter((a) => a.kind === 'png')) {
      const bytes = built.find((b) => b.filename === a.filename)!.bytes;
      const decoded = await decodeArtifact(bytes);
      expect(decoded.width).toBeGreaterThan(0);
      expect(decoded.height).toBeGreaterThan(0);
    }
  });

  test('#12b duplicate clip names are rejected (no silent overwrite)', async () => {
    const project = mkProject();
    project.clips.push({ ...project.clips[1], name: 'walk' });
    await expectExportError(
      () => planExport(project, { scope: 'all-clips', format: 'sheet', sheet: { columns: 0, padding: 0 } }),
      'DUPLICATE_FILENAME',
    );
  });
});

// ---------------------------------------------------------------------------
// golden #13–#14 — metadata: durations, loop modes, tags
// ---------------------------------------------------------------------------

describe('golden: animation metadata', () => {
  test('#13 per-frame effective durations (override + fps fallback, ≥1ms clamp)', () => {
    const project = mkProject();
    const clip = project.clips[0]; // fps 8 → fallback 125ms; overrides 500 / 250
    const meta = buildClipMetadata(project, clip, { columns: 2, padding: 1 }, 'golden-forge_idle_sheet.png');
    const durations = meta.frames.map((f) => f.durationMs);
    expect(durations).toEqual([125, 125, 500, 250]); // f0,f1 inherit; f2,f3 override
    expect(meta.clip.fps).toBe(8);
    expect(meta.clip.frameCount).toBe(4);
    expect(meta.clip.tags).toEqual([{ name: 'breathe', from: 1, to: 2 }]);
    expect(meta.version).toBe(EXPORT_METADATA_VERSION);
  });

  test('#14 reverse + ping-pong playback metadata (sequence = one full cycle)', () => {
    const project = mkProject();
    const walk = buildClipMetadata(project, project.clips[1], { columns: 0, padding: 0 }, 'w.png');
    expect(walk.playback.mode).toBe('reverse');
    expect(walk.playback.loop).toBe(true);
    expect(walk.playback.sequence).toEqual([1, 0]);
    expect(walk.godot.loop).toBe(true);

    const bounce = buildClipMetadata(project, project.clips[2], { columns: 0, padding: 0 }, 'b.png');
    expect(bounce.playback.mode).toBe('pingpong');
    expect(bounce.playback.loop).toBe(false);
    expect(bounce.playback.sequence).toEqual([0, 1, 2, 1, 0]); // once: returns to frame 0
    expect(bounce.playback.frameDurationsMs).toEqual([100, 100, 100, 100, 100]);
    expect(bounce.playback.cycleMs).toBe(500);
    expect(bounce.playback.interpretation).toContain('stops on the final entry');
  });
});

// ---------------------------------------------------------------------------
// golden #15–#16 — exact rects; export→extract→pixel-compare round-trip
// ---------------------------------------------------------------------------

describe('golden: rect math + extraction round-trip', () => {
  test('#15 metadata rect origins match decoded sheet marker positions exactly', async () => {
    const project = mkProject();
    // Give every idle frame a unique marker pixel at a known in-frame spot.
    const clip = project.clips[0];
    clip.frames.forEach((f) => {
      const celRef = f.cels['lay_fg'] ?? f.cels['lay_bg'];
      const idx = (5 * W + 3) * 4; // (3,5)
      celRef.buffer[idx] = MARKER[0];
      celRef.buffer[idx + 1] = MARKER[1];
      celRef.buffer[idx + 2] = MARKER[2];
      celRef.buffer[idx + 3] = MARKER[3];
    });
    const opts = { columns: 2, padding: 2, spacing: 3 };
    const meta = buildClipMetadata(project, clip, opts, 'golden-forge_idle_sheet.png');
    const [sheet] = await buildAllArtifacts(planExport(project, { scope: 'clip', format: 'sheet', sheet: opts }));
    const decoded = await decodeArtifact(sheet.bytes);
    for (const rect of meta.frames) {
      expect(rect.x).toBe(sheetFrameOrigin(resolveSheetLayout(project, clip, opts), rect.index).x);
      expect(rect.w).toBe(W);
      expect(rect.h).toBe(H);
      // the marker must sit at rect.x+3, rect.y+5 in the decoded sheet
      expect(pixel(decoded.rgba, decoded.width, rect.x + 3, rect.y + 5)).toEqual(MARKER);
    }
  });

  test('#16 export sheet → extract frames by metadata rects → pixel-compare vs frame PNGs', async () => {
    const project = mkProject();
    const clip = project.clips[1]; // walk: alpha variety incl. semi pixels
    const opts = { columns: 2, padding: 1, spacing: 1 };
    const framePngs = await buildAllArtifacts(
      planExport(project, { scope: 'clip', clipId: 'clip_walk', format: 'png-frames' }),
    );
    const [sheet] = await buildAllArtifacts(
      planExport(project, { scope: 'clip', clipId: 'clip_walk', format: 'sheet', sheet: opts }),
    );
    const sheetDecoded = await decodeArtifact(sheet.bytes);
    const meta = buildClipMetadata(project, clip, opts, 'golden-forge_walk_sheet.png');

    expect(framePngs).toHaveLength(2);
    for (let i = 0; i < clip.frames.length; i++) {
      const frameDecoded = await decodeArtifact(framePngs[i].bytes);
      const rect = meta.frames[i];
      for (let y = 0; y < rect.h; y++) {
        const si = ((rect.y + y) * sheetDecoded.width + rect.x) * 4;
        const sliced = sheetDecoded.rgba.subarray(si, si + rect.w * 4);
        const fi = y * rect.w * 4;
        expectBuffersEqual(sliced, frameDecoded.rgba.subarray(fi, fi + rect.w * 4), `extract f${i} y${y}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// reliability §7 — invalid input, guards, no-mutation, atomic writes
// ---------------------------------------------------------------------------

describe('export reliability', () => {
  test('error codes: EMPTY_PROJECT / EMPTY_CLIP / INVALID_OPTIONS / SHEET_TOO_LARGE / BAD_CEL_BUFFER', async () => {
    const project = mkProject();
    await expectExportError(() => planExport({ ...project, clips: [] }, { scope: 'clip', format: 'png-frames' }), 'EMPTY_PROJECT');
    const noFrames = mkProject();
    noFrames.clips = [{ ...noFrames.clips[0], frames: [] }];
    await expectExportError(() => planExport(noFrames, { scope: 'clip', format: 'png-frames' }), 'EMPTY_CLIP');
    await expectExportError(() => planExport(project, { scope: 'clip', format: 'sheet', sheet: { columns: -1, padding: 0 } }), 'INVALID_OPTIONS');
    await expectExportError(() => planExport(project, { scope: 'clip', format: 'sheet', sheet: { columns: 1.5, padding: 0 } }), 'INVALID_OPTIONS');
    await expectExportError(() => planExport(project, { scope: 'clip', format: 'sheet', sheet: { columns: 2, padding: -3 } }), 'INVALID_OPTIONS');
    await expectExportError(() => planExport(project, { scope: 'frame', frameIndex: 99, format: 'png-frames' }), 'INVALID_OPTIONS');
    await expectExportError(
      () => planExport(project, { scope: 'clip', format: 'sheet', sheet: { columns: 0, padding: 0 }, zeroPadFrames: 9 }),
      'INVALID_OPTIONS',
    );
    // 256×256 × 100 frames horizontal → 25600px wide, over the 16384 side guard
    const big = mkProject();
    const bigClip: Clip = { ...big.clips[0], frames: Array.from({ length: 100 }, (_, i) => frame(`bf${i}`, {})) };
    big.clips = [{ ...bigClip, layers: [layer('l', 'l')] }];
    big.width = 256;
    big.height = 256;
    await expectExportError(() => planExport(big, { scope: 'clip', format: 'sheet', sheet: { columns: 0, padding: 0 } }), 'SHEET_TOO_LARGE');
    // corrupt cel buffer (wrong byte length) surfaces with code + context
    const corrupt = mkProject();
    corrupt.clips = [
      {
        ...corrupt.clips[2],
        frames: [frame('cb', { lay_b: { buffer: new Uint8ClampedArray(10), linked: false } })],
      },
    ];
    await expectExportError(() => composeFrameRgba(corrupt, corrupt.clips[0], corrupt.clips[0].frames[0]), 'BAD_CEL_BUFFER');
  });

  test('source document is never mutated by planning + building', async () => {
    const project = mkProject();
    const before = structuredClone(project);
    const plan = planExport(project, { scope: 'all-clips', format: 'sheet', sheet: { columns: 2, padding: 2 }, includeJson: true });
    await buildAllArtifacts(plan);
    expect(project).toEqual(before);
    // linked cel buffer identity survives (no buffer swapping)
    expect(project.clips[0].frames[0].cels['lay_bg']!.buffer).toBe(project.clips[0].frames[3].cels['lay_bg']!.buffer);
  });

  test('identical requests produce byte-identical artifacts (determinism)', async () => {
    const project = mkProject();
    const opts = { scope: 'clip' as const, format: 'sheet' as const, sheet: { columns: 2, padding: 1 }, includeJson: true };
    const a = await buildAllArtifacts(planExport(project, opts));
    const b = await buildAllArtifacts(planExport(project, opts));
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].filename).toBe(b[i].filename);
      expectBuffersEqual(a[i].bytes, b[i].bytes, `determinism ${a[i].filename}`);
    }
  });

  test('writeExportPlan over MemoryFs: writes, conflict preflight, overwrite, atomicity', async () => {
    const project = mkProject();
    const files = await buildAllArtifacts(
      planExport(project, { scope: 'clip', format: 'sheet', sheet: { columns: 2, padding: 0 }, includeJson: true }),
    );
    const fs = new MemoryFs();

    const ok = await writeExportPlan(fs, '/dest', files);
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') throw new Error('unreachable'); // narrows for TS
    expect(ok.written).toHaveLength(2);
    for (const f of files) {
      const back = await fs.readFile(`/dest/${f.filename}`);
      expectBuffersEqual(back, f.bytes, `roundtrip ${f.filename}`);
    }

    // re-write without overwrite → conflict, nothing touched
    const again = await writeExportPlan(fs, '/dest', files);
    expect(again.status).toBe('conflicts');
    expect((again as { conflicts: string[] }).conflicts).toEqual(files.map((f) => f.filename));
    const unchanged = await fs.readFile(`/dest/${files[0].filename}`);
    expectBuffersEqual(unchanged, files[0].bytes, 'conflict leaves original');

    // overwrite: true → ok again
    expect((await writeExportPlan(fs, '/dest', files, { overwrite: true })).status).toBe('ok');

    // no `.tmp` leftovers after any path
    const listing = await fs.listDir('/dest');
    expect(listing.every((n) => !n.endsWith('.tmp'))).toBe(true);
  });

  test('writeExportPlan partial failure: completed files stay, failed target uncorrupted, tmp cleaned', async () => {
    const project = mkProject();
    const files = await buildAllArtifacts(planExport(project, { scope: 'clip', format: 'png-frames' }));
    expect(files.length).toBeGreaterThanOrEqual(2);
    const fs = new MemoryFs();
    const failOn = files[1].filename;
    // pre-seed the failing target with OLD content (must survive the failure)
    const oldBytes = new TextEncoder().encode('OLD-CONTENT');
    await fs.writeFile(`/dest/${failOn}`, oldBytes);

    const flaky: FileFs = {
      readFile: (p) => fs.readFile(p),
      writeFile: async (p, data) => {
        if (p.endsWith(`${failOn}.tmp`)) throw new Error('E_DISK_FULL (injected)');
        await fs.writeFile(p, data);
      },
      rename: (a, b) => fs.rename(a, b),
      unlink: (p) => fs.unlink(p),
      exists: (p) => fs.exists(p),
      mkdir: (p) => fs.mkdir(p),
      listDir: (p) => fs.listDir(p),
      stat: async () => null,
    };

    const result = await writeExportPlan(flaky, '/dest', files, { overwrite: true });
    expect(result.status).toBe('partial');
    if (result.status === 'partial') {
      expect(result.written).toContain(`/dest/${files[0].filename}`);
      expect(result.failures.map((f) => f.filename)).toEqual([failOn]);
      expect(result.failures[0].message).toContain('E_DISK_FULL');
    }
    // old file intact (atomic rename never corrupted it)
    expectBuffersEqual(await fs.readFile(`/dest/${failOn}`), oldBytes, 'failed target uncorrupted');
    // no tmp leftovers
    const listing = await fs.listDir('/dest');
    expect(listing.every((n) => !n.endsWith('.tmp'))).toBe(true);
  });

  test('writeExportPlan rejects unsafe filenames before touching the filesystem', async () => {
    const fs = new MemoryFs();
    const evil = [{ filename: '../evil.png', bytes: new Uint8Array([1, 2, 3]) }];
    await expectExportError(() => writeExportPlan(fs, '/dest', evil, { overwrite: true }), 'INVALID_FILENAME');
    await expectExportError(() => writeExportPlan(fs, '/dest', [{ filename: 'a/b.png', bytes: new Uint8Array([1]) }], { overwrite: true }), 'INVALID_FILENAME');
  });

  test('metadata JSON parses and references its image artifact exactly', async () => {
    const project = mkProject();
    const plan = planExport(project, { scope: 'clip', format: 'sheet', sheet: { columns: 2, padding: 1 }, includeJson: true });
    const built = await buildAllArtifacts(plan);
    const jsonArtifact = built.find((b) => b.kind === 'json')!;
    const meta = JSON.parse(new TextDecoder().decode(jsonArtifact.bytes));
    expect(meta.image).toBe('golden-forge_idle_sheet.png');
    expect(meta.godot.sheet).toBe('golden-forge_idle_sheet.png');
    expect(meta.layout).toBe('grid');
    expect(meta.frames).toHaveLength(4);
    expect(meta.playback.sequence.length).toBeGreaterThanOrEqual(4);
  });
});
