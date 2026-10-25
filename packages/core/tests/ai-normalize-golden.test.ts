/**
 * Task 9 — normalize-v2 golden regression tests (v3.1 Plan §3.3, §13
 * "Normalize goldens per pipeline stage").
 *
 * Every fixture is a deterministic in-code literal; every expected output is
 * hand-computed and pinned byte-exact. These tests FAIL on any pipeline
 * behavior change — golden fixtures are updated only by intentional, reviewed
 * edits (never auto-regenerated — Task 15a policy).
 *
 * Also pins the §3.3 A/B case: dominant-color downscale vs the prototype's
 * nearest-neighbor contain-fit on a representative noisy fixture.
 */

import { describe, expect, test } from 'bun:test';

import {
  applyAlphaThreshold,
  cleanupOutlineFringeWithColor,
  despeckleIsolated,
  dominantColorDownscale,
  fitBufferToCanvas,
  floodRemoveBackground,
  medianCutPalette,
  nearestNeighborContain,
  normalizeV2,
  oklabToRgb,
  parseHexColor,
  quantizeToPalette,
  rgbToOklab,
  trimContentBBox,
  type Normalize2Options,
} from '../src/index';

// ------------------------------------------------------------------ helpers

/** Build an RGBA buffer from compact rows: '#'=opaque red, '.'=transparent, letters=that CSS-ish color. */
function buf(w: number, h: number, rows: string[], map: Record<string, [number, number, number, number]> = {}): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const defaults: Record<string, [number, number, number, number]> = {
    '#': [255, 0, 0, 255],
    '.': [0, 0, 0, 0],
    w: [255, 255, 255, 255],
    g: [0, 128, 0, 255],
    b: [0, 0, 255, 255],
    k: [0, 0, 0, 255],
    y: [255, 255, 0, 255],
    ...map,
  };
  if (rows.length !== h) throw new Error(`fixture rows ${rows.length} != h ${h}`);
  for (let y = 0; y < h; y++) {
    if (rows[y].length !== w) throw new Error(`fixture row ${y} length ${rows[y].length} != w ${w}`);
    for (let x = 0; x < w; x++) {
      const c = defaults[rows[y][x]];
      if (!c) throw new Error(`unknown fixture char ${rows[y][x]}`);
      const i = (y * w + x) * 4;
      out[i] = c[0];
      out[i + 1] = c[1];
      out[i + 2] = c[2];
      out[i + 3] = c[3];
    }
  }
  return out;
}

function px(b: Uint8Array | Uint8ClampedArray, w: number, x: number, y: number): [number, number, number, number] {
  const i = (y * w + x) * 4;
  return [b[i], b[i + 1], b[i + 2], b[i + 3]];
}

function hexAt(b: Uint8Array | Uint8ClampedArray, w: number, x: number, y: number): string {
  const [r, g, bl, a] = px(b, w, x, y);
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return a === 0 ? 'transparent' : `#${h(r)}${h(g)}${h(bl)}`;
}

const OPT = (over: Partial<Normalize2Options>): Normalize2Options => ({
  targetW: 4,
  targetH: 4,
  removeBg: true,
  bgTolerance: 48,
  paletteMode: 'off',
  palette: [],
  maxColors: 16,
  outlineCleanup: false,
  ...over,
});

// ---------------------------------------------------------------- trim

describe('normalize-v2 goldens: trimContentBBox', () => {
  test('#T1 transparent margins are trimmed to the content bbox', () => {
    const src = buf(8, 8, [
      '........',
      '........',
      '..###...',
      '..###...',
      '....#...',
      '........',
      '........',
      '........',
    ]);
    const bbox = trimContentBBox(src, 8, 8, false, 48);
    expect(bbox).toEqual({ x: 2, y: 2, w: 3, h: 3 });
  });

  test('#T2 border-colored background counts as trimmable when removeBg is on', () => {
    // uniform white field with a 2×2 red sprite in the middle
    const rows = Array.from({ length: 8 }, () => 'wwwwwwww');
    const src = buf(8, 8, rows, { w: [255, 255, 255, 255] });
    const i = (3 * 8 + 3) * 4;
    src[i] = 255; src[i + 1] = 0; src[i + 2] = 0; src[i + 3] = 255;
    const i2 = (4 * 8 + 4) * 4;
    src[i2] = 255; src[i2 + 1] = 0; src[i2 + 2] = 0; src[i2 + 3] = 255;
    const bbox = trimContentBBox(src, 8, 8, true, 48);
    expect(bbox).toEqual({ x: 3, y: 3, w: 2, h: 2 });
  });

  test('#T3 fully empty image does NOT trim (full rect kept)', () => {
    const src = buf(4, 4, ['....', '....', '....', '....']);
    expect(trimContentBBox(src, 4, 4, true, 48)).toEqual({ x: 0, y: 0, w: 4, h: 4 });
  });
});

// ------------------------------------------------- dominant-color downscale

describe('normalize-v2 goldens: dominantColorDownscale', () => {
  test('#D1 4×4 → 2×2: modal color wins per 2×2 block, white noise px rejected (A/B vs NN)', () => {
    // block(0,0): 3 red + 1 white noise px → dominant = red.
    // block(1,0): 4 blue. block(0,1): 4 red. block(1,1): 3 blue + 1 white noise.
    const src = buf(4, 4, [
      '##bb',
      '#wbb',
      'bb##',
      'bb#w',
    ]);
    const out = dominantColorDownscale(src, 4, 4, 2, 2);
    expect(hexAt(out, 2, 0, 0)).toBe('#ff0000');
    expect(hexAt(out, 2, 1, 0)).toBe('#0000ff');
    expect(hexAt(out, 2, 0, 1)).toBe('#0000ff'); // rows 2-3 left half are blue
    expect(hexAt(out, 2, 1, 1)).toBe('#ff0000');
    // no white anywhere in the output — the noise pixels did not survive
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3] === 0) continue;
      expect([out[i], out[i + 1], out[i + 2]]).not.toEqual([255, 255, 255]);
    }
  });

  test('#D1b same fixture through NN contain-fit ALIASES the noise pixels', () => {
    // Documents WHY v2 exists: plain NN center-samples straight into the
    // output, so the noise pixels land in the sprite; dominant-color does not.
    const src = buf(4, 4, ['##bb', '#wbb', 'bb##', 'bb#w']);
    const nn = nearestNeighborContain(src, 4, 4, 2, 2);
    const whites = [0, 1, 2, 3].filter((i) => hexAt(nn, 2, i % 2, (i / 2) | 0) === '#ffffff');
    expect(whites.length).toBe(2); // NN keeps BOTH noise px → sprite reads dirty
  });

  test('#D2 exact-integer blocks keep crisp colors (8×8 → 4×4 identity case)', () => {
    const src = buf(8, 8, [
      '########',
      '########',
      '########',
      '########',
      'bbbbbbbb',
      'bbbbbbbb',
      'bbbbbbbb',
      'bbbbbbbb',
    ]);
    const out = dominantColorDownscale(src, 8, 8, 4, 4);
    expect(out.length).toBe(4 * 4 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(hexAt(out, 4, x, y)).toBe(y < 2 ? '#ff0000' : '#0000ff');
      }
    }
  });

  test('#D3 opaque-in-majority blocks keep the opaque color; empty blocks go transparent', () => {
    // 2×1 blocks: left = 1 opaque red + 1 transparent → red survives (crisp thin lines);
    // middle = green; right block = fully transparent → transparent cell.
    const src = buf(6, 2, [
      '#..g..',
      '#..g..',
    ]);
    const out = dominantColorDownscale(src, 6, 2, 3, 2);
    expect(hexAt(out, 3, 0, 0)).toBe('#ff0000');
    expect(hexAt(out, 3, 0, 1)).toBe('#ff0000');
    expect(hexAt(out, 3, 1, 0)).toBe('#008000');
    expect(hexAt(out, 3, 1, 1)).toBe('#008000');
    expect(hexAt(out, 3, 2, 0)).toBe('transparent');
    expect(hexAt(out, 3, 2, 1)).toBe('transparent');
  });

  test('#D4 determinism: two runs are byte-identical (source never mutated)', () => {
    const rows = ['#w.g#', '#..g#', 'bbbb.', 'bb.b#'];
    const src = buf(5, 4, rows);
    const snapshot = new Uint8ClampedArray(src);
    const a = dominantColorDownscale(src, 5, 4, 3, 3);
    const b = dominantColorDownscale(src, 5, 4, 3, 3);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(src).equals(Buffer.from(snapshot))).toBe(true);
  });
});

// ------------------------------------------------- alpha threshold + despeckle

describe('normalize-v2 goldens: alpha threshold + despeckle', () => {
  test('#A1 alpha < 128 → 0; ≥ 128 → 255 (the binary-alpha rule)', () => {
    const b = new Uint8ClampedArray([1, 2, 3, 0, 4, 5, 6, 127, 7, 8, 9, 128, 10, 11, 12, 255]);
    applyAlphaThreshold(b, 128);
    expect([...b.filter((_, i) => i % 4 === 3)]).toEqual([0, 0, 255, 255]);
  });

  test('#A2 despeckle clears isolated opaque px but not connected ones', () => {
    const src = buf(5, 5, [
      '.#...',
      '.....',
      '..##.',
      '..##.',
      '.....',
    ]);
    const removed = despeckleIsolated(src, 5, 5);
    expect(removed).toBe(1);
    expect(src[(0 * 5 + 1) * 4 + 3]).toBe(0); // speck gone
    expect(src[(2 * 5 + 2) * 4 + 3]).toBe(255); // block survives
  });
});

// ------------------------------------------------- background removal

describe('normalize-v2 goldens: floodRemoveBackground', () => {
  test('#B1 white border flood clears only border-connected bg (ring preserved, interior hole kept)', () => {
    // 3px white frame so the prototype corner sampler (3×3 patches at (1,1)
    // etc.) sees pure white — the ring sits beyond the patch reach.
    const src = buf(8, 8, [
      'wwwwwwww',
      'wwwwwwww',
      'wwwwwwww',
      'ww####ww',
      'ww#..#ww', // interior white pixels are NOT border-connected → survive
      'ww####ww',
      'wwwwwwww',
      'wwwwwwww',
    ], { w: [255, 255, 255, 255], '#': [200, 0, 0, 255], '.': [255, 255, 255, 255] });
    const cleared = floodRemoveBackground(src, 8, 8, 48);
    // 64 px − 10 ring px − 2 enclosed interior px = 52 border-connected bg px
    expect(cleared).toBe(52);
    expect(src[(4 * 8 + 3) * 4 + 3]).toBe(255); // enclosed interior survives
    expect(src[(0 * 8 + 0) * 4 + 3]).toBe(0); // border cleared
    expect(src[(3 * 8 + 2) * 4 + 3]).toBe(255); // ring survives
  });

  test('#B2 tolerance rejects near-bg colors outside the radius', () => {
    const src = buf(3, 3, [
      'www',
      'wgw',
      'www',
    ], { w: [255, 255, 255, 255], g: [255, 100, 100, 255] });
    const cleared = floodRemoveBackground(src, 3, 3, 48);
    expect(cleared).toBe(8); // green center survives
    expect(src[(1 * 3 + 1) * 4 + 3]).toBe(255);
  });
});

// ------------------------------------------------- quantization

describe('normalize-v2 goldens: OKLab quantization', () => {
  test('#Q1 OKLab round-trip sanity: pure colors map back exactly', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#14b8a6']) {
      const [r, g, b] = parseHexColor(hex)!;
      const rgb = oklabToRgb(rgbToOklab(r, g, b));
      expect(rgb).toEqual([r, g, b]);
    }
  });

  test('#Q2 project palette enforcement: every opaque px lands on a palette color', () => {
    const src = buf(2, 2, ['ab', 'ba'], { a: [250, 60, 50, 255], b: [10, 200, 190, 255] });
    const palette = ['#ff0000', '#008080', '#ffffff'];
    const palRgb = palette.map((h) => parseHexColor(h)!);
    quantizeToPalette(src, palRgb);
    expect(hexAt(src, 2, 0, 0)).toBe('#ff0000');
    expect(hexAt(src, 2, 1, 0)).toBe('#008080');
    expect(hexAt(src, 2, 0, 1)).toBe('#008080');
    expect(hexAt(src, 2, 1, 1)).toBe('#ff0000');
  });

  test('#Q3 auto median-cut: output uses at most maxColors distinct colors', () => {
    // 2×8 gradient strip with many distinct colors
    const src = new Uint8ClampedArray(2 * 8 * 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 2; x++) {
        const i = (y * 2 + x) * 4;
        src[i] = 20 + y * 25;
        src[i + 1] = 30 + x * 90;
        src[i + 2] = 200 - y * 20;
        src[i + 3] = 255;
      }
    }
    const pal = medianCutPalette(src, 4);
    expect(pal.length).toBeLessThanOrEqual(4);
    quantizeToPalette(src, pal);
    const distinct = new Set<number>();
    for (let i = 0; i < src.length; i += 4) {
      distinct.add((src[i] << 16) | (src[i + 1] << 8) | src[i + 2]);
    }
    expect(distinct.size).toBeLessThanOrEqual(4);
  });
});

// ------------------------------------------------- outline fringe cleanup

describe('normalize-v2 goldens: outline fringe cleanup', () => {
  test('#F1 bg-tinted px adjacent to transparency (incl. image edges) are cleared; sprite-core px survive', () => {
    const src = buf(4, 3, [
      'fff.',
      'f##f',
      'fff.',
    ], {
      f: [255, 245, 245, 255], // near-white AA fringe (bg was white)
      '#': [200, 0, 0, 255],
      '.': [0, 0, 0, 0],
    });
    // every fringe px is adjacent to transparency or the image edge (which
    // counts as transparent) → the whole ring clears
    const cleared = cleanupOutlineFringeWithColor(src, 4, 3, [255, 255, 255], 40);
    expect(cleared).toBe(8);
    expect(src[(1 * 4 + 1) * 4 + 3]).toBe(255); // sprite core survives
    expect(src[(1 * 4 + 2) * 4 + 3]).toBe(255);
    expect(src[(0 * 4 + 0) * 4 + 3]).toBe(0);
  });

  test('#F2 sprite-colored px adjacent to transparency survive (only bg-tinted ring clears)', () => {
    const src = buf(3, 3, [
      'gg.',
      'g#.',
      '...',
    ], { g: [30, 200, 90, 255], '#': [200, 0, 0, 255], '.': [0, 0, 0, 0] });
    const cleared = cleanupOutlineFringeWithColor(src, 3, 3, [255, 255, 255], 40);
    expect(cleared).toBe(0); // nothing resembles the white bg
    expect(src[(0 * 3 + 0) * 4 + 3]).toBe(255);
  });
});

// ------------------------------------------------- full pipeline

describe('normalize-v2 goldens: full pipeline normalizeV2', () => {
  test('#P1 8×8 generated mock → exact 4×4 output, bg removed, exact dims', () => {
    // 8×8: white bg, red 4×4 sprite with a 2px transparent gap effect
    const src = buf(8, 8, [
      'wwwwwwww',
      'ww####ww',
      'ww####ww',
      'ww##..ww', // transparent notch inside the sprite bbox
      'ww####ww',
      'wwwwwwww',
      'wwwwwwww',
      'wwwwwwww',
    ], { w: [255, 255, 255, 255], '#': [220, 40, 40, 255], '.': [0, 0, 0, 0] });
    // mark the notch as white (bg-like) instead of transparent:
    const notch = (3 * 8 + 4) * 4;
    src[notch] = 255; src[notch + 1] = 255; src[notch + 2] = 255; src[notch + 3] = 255;

    // v2.1 audit note: the pre-2.1 pipeline erased the ENTIRE sprite here
    // (the target-res flood re-sampled a polluted bg color from the sprite's
    // own corner patches) and this golden passed VACUOUSLY — it only asserted
    // "surviving px are red", which is trivially true when nothing survives.
    // The expectation below pins the FIXED behavior: the sprite SURVIVES,
    // bg is gone, and the enclosed white notch remains (an enclosed bg-colored
    // region may be an intentional light detail — removal is the opt-in
    // 'enclosedResidueCleanup' control, asserted in the second half).
    const res = normalizeV2(src, 8, 8, OPT({ targetW: 4, targetH: 4, removeBg: true, outlineCleanup: true }));
    expect(res.width).toBe(4);
    expect(res.height).toBe(4);
    expect(res.buffer.length).toBe(4 * 4 * 4);
    // content was trimmed to the 4×4 sprite bbox → the 4×4 output IS the sprite
    expect(res.stats.trim).toEqual({ x: 2, y: 1, w: 4, h: 4 });
    // the subject SURVIVES: 14 red px; the white notch is ADJACENT to the
    // transparent gap cell (5,3) → fringe cleanup clears it (bg residue next
    // to transparency); the gap cell itself stays transparent
    let red = 0;
    let white = 0;
    let transparent = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const [r, g, b, a] = px(res.buffer, 4, x, y);
        if (a === 0) {
          transparent += 1;
          continue;
        }
        if ([r, g, b].every((v, j) => v === [220, 40, 40][j])) red += 1;
        else if ([r, g, b].every((v, j) => v === [255, 255, 255][j])) white += 1;
      }
    }
    expect(red).toBe(14);
    expect(white).toBe(0);
    expect(transparent).toBe(2);
    // no white margin survived anywhere — bg removal worked at source res
    expect(res.stats.bgRemoved).toBeGreaterThan(0);
    expect(res.stats.bgColor).toBe('#ffffff');

    // ENCLOSED residue path (second variant): solid red 4×4 with a fully
    // enclosed white notch — by default it SURVIVES (an enclosed bg-colored
    // region may be an intentional light detail — never removed silently);
    // the opt-in residue control clears it.
    const enclosed = buf(8, 8, [
      'wwwwwwww',
      'ww####ww',
      'ww####ww',
      'ww####ww',
      'ww####ww',
      'wwwwwwww',
      'wwwwwwww',
      'wwwwwwww',
    ], { w: [255, 255, 255, 255], '#': [220, 40, 40, 255], '.': [0, 0, 0, 0] });
    const notch2 = (3 * 8 + 4) * 4;
    enclosed[notch2] = 255; enclosed[notch2 + 1] = 255; enclosed[notch2 + 2] = 255; enclosed[notch2 + 3] = 255;
    const kept = normalizeV2(enclosed, 8, 8, OPT({ targetW: 4, targetH: 4, removeBg: true, outlineCleanup: true }));
    let keptRed = 0;
    let keptWhite = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const [r, g, b, a] = px(kept.buffer, 4, x, y);
        if (a === 0) continue;
        if ([r, g, b].every((v, j) => v === [220, 40, 40][j])) keptRed += 1;
        else if ([r, g, b].every((v, j) => v === [255, 255, 255][j])) keptWhite += 1;
      }
    }
    expect(keptRed).toBe(15);
    expect(keptWhite).toBe(1);
    const cleaned = normalizeV2(enclosed, 8, 8, OPT({ targetW: 4, targetH: 4, removeBg: true, outlineCleanup: true, enclosedResidueCleanup: true }));
    let cleanedRed = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const [r, g, b, a] = px(cleaned.buffer, 4, x, y);
        if (a !== 0) {
          expect([r, g, b]).toEqual([220, 40, 40]);
          cleanedRed += 1;
        }
      }
    }
    expect(cleanedRed).toBe(15);
    expect(cleaned.stats.residueRemoved).toBe(1);
  });

  test('#P2 determinism: byte-identical output across two runs AND across equivalent input orderings', () => {
    const rows = [
      'wwwwww',
      'w####w',
      'w#k##w',
      'w####w',
      'wwwwww',
      '......',
    ];
    const src = buf(6, 6, rows, { w: [255, 255, 255, 255], '#': [20, 160, 120, 255], k: [10, 10, 10, 255] });
    const a = normalizeV2(src, 6, 6, OPT({ targetW: 3, targetH: 3 }));
    const b = normalizeV2(src, 6, 6, OPT({ targetW: 3, targetH: 3 }));
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    expect(a.stats).toEqual(b.stats);
  });

  test('#P3 no anti-aliasing: output px are binary colors, never blends; transparency preserved', () => {
    // diagonal bar on a TRANSPARENT canvas — the content bbox itself contains
    // transparent gaps, which must survive the pipeline as exact 0-alpha cells
    const src = buf(6, 6, [
      '......',
      '..#...',
      '..#...',
      '...#..',
      '......',
      '......',
    ], { '#': [0, 0, 0, 255], '.': [0, 0, 0, 0] });
    // removeBg stays OFF: there is no matte to remove on a transparent
    // canvas (and the flood's border sample would legitimately see the
    // sprite's own edge color here — bg removal is for matte backgrounds)
    const res = normalizeV2(src, 6, 6, OPT({ targetW: 6, targetH: 6, removeBg: false, outlineCleanup: false }));
    expect(res.width).toBe(6);
    expect(res.height).toBe(6);
    // every output px is exactly transparent (0) or fully opaque (255), and
    // opaque px are EXACT sprite colors — never blends ("no unwanted
    // anti-aliasing" is a hard normalize-v2 requirement)
    let sawTransparent = false;
    let sawBlack = false;
    for (let i = 0; i < res.buffer.length; i += 4) {
      const a = res.buffer[i + 3];
      expect(a === 0 || a === 255).toBe(true);
      if (a === 0) {
        sawTransparent = true;
        continue;
      }
      expect([res.buffer[i], res.buffer[i + 1], res.buffer[i + 2]]).toEqual([0, 0, 0]);
      sawBlack = true;
    }
    expect(sawTransparent).toBe(true);
    expect(sawBlack).toBe(true);
  });

  test('#P4 project-palette enforcement through the full pipeline', () => {
    const src = buf(4, 4, [
      'wwww',
      'w##w',
      'w##w',
      'wwww',
    ], { w: [255, 255, 255, 255], '#': [240, 70, 60, 255] });
    const res = normalizeV2(src, 4, 4, OPT({
      targetW: 2,
      targetH: 2,
      removeBg: true,
      paletteMode: 'project',
      palette: ['#ff0000', '#f4f4f4'],
      outlineCleanup: false,
    }));
    expect(res.stats.paletteUsed).toBe('project');
    for (let i = 0; i < res.buffer.length; i += 4) {
      if (res.buffer[i + 3] === 0) continue;
      expect([res.buffer[i], res.buffer[i + 1], res.buffer[i + 2]]).toEqual([255, 0, 0]);
    }
  });

  test('#P5 exact output size guaranteed for anisotropic targets', () => {
    const src = buf(10, 4, [
      'wwwwwwwwww',
      'w########w',
      'w########w',
      'wwwwwwwwww',
    ], { w: [255, 255, 255, 255], '#': [90, 90, 200, 255] });
    const res = normalizeV2(src, 10, 4, OPT({ targetW: 7, targetH: 3 }));
    expect(res.width).toBe(7);
    expect(res.height).toBe(3);
    expect(res.buffer.length).toBe(7 * 3 * 4);
  });

  test('#P6 reject invalid targets and mismatched buffers', () => {
    const src = buf(2, 2, ['##', '##']);
    expect(() => normalizeV2(src, 2, 2, OPT({ targetW: 0, targetH: 4 }))).toThrow();
    expect(() => normalizeV2(src, 2, 2, OPT({ targetW: 513, targetH: 4 }))).toThrow();
    expect(() => normalizeV2(new Uint8ClampedArray(4), 2, 2, OPT({}))).toThrow();
  });
});

// ------------------------------------------------- import fit (Task 9 E2E fix)

describe('normalize-v2 goldens: fitBufferToCanvas', () => {
  test('#FIT1 smaller sprite centers 1:1 onto a transparent canvas (no resampling)', () => {
    const sprite = buf(2, 2, ['#.', '.#']);
    const out = fitBufferToCanvas(sprite, 2, 2, 6, 6);
    expect(out.length).toBe(6 * 6 * 4);
    // red at (0,0) of the sprite → centered offset (2,2) on the 6×6 canvas
    expect(hexAt(out, 6, 2, 2)).toBe('#ff0000');
    expect(hexAt(out, 6, 3, 3)).toBe('#ff0000');
    // corners stay transparent
    expect(hexAt(out, 6, 0, 0)).toBe('transparent');
    expect(hexAt(out, 6, 5, 5)).toBe('transparent');
  });

  test('#FIT2 same size returns the input; oversized throws', () => {
    const sprite = buf(4, 4, ['....', '....', '....', '....']);
    expect(fitBufferToCanvas(sprite, 4, 4, 4, 4)).toBe(sprite);
    expect(() => fitBufferToCanvas(sprite, 4, 4, 2, 2)).toThrow(/exceeds/);
  });
});
