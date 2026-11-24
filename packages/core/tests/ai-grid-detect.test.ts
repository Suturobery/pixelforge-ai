/**
 * Pixel-grid detection, snapping, and whole-number scaling tests (AI slop fix #1).
 *
 * Covers:
 *   • exact integer block grids (2×, 4×, 8×, 12×) — byte-exact recovery
 *   • fractional non-integer grids (e.g. 12.5px pitch, non-zero offset + AA halo)
 *   • noisy AI-like faux-pixel art (diffusion grain + blended seams)
 *   • whole-number scaling (1× native, k× integer up, div× integer down + oversized)
 *   • negative tests: native 1:1 Character Kit sprites, smooth gradients, smooth circles
 *   • quality & style-validation oversized warnings + normalizeV2 determinism
 */

import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_PALETTE,
  analyzeSpriteQuality,
  buildReferenceCandidate,
  defaultStyleProfile,
  detectPixelGrid,
  encodePng,
  normalizeV2,
  scaleSpriteWholeNumber,
  snapToDetectedGrid,
  validateStyleCandidate,
  type Normalize2Options,
} from '../src/index';

// ------------------------------------------------------------------ helpers

const PAL: Record<string, [number, number, number, number]> = {
  '.': [0, 0, 0, 0],
  k: [24, 20, 37, 255],
  g: [56, 183, 100, 255],
  d: [37, 113, 121, 255],
  s: [255, 205, 117, 255],
  b: [177, 62, 83, 255],
  e: [59, 93, 201, 255],
  w: [244, 244, 244, 255],
};

/** 12×14 hand-crafted pixel-art mini mage sprite (native 1:1, full 12px brim). */
const MINI_MAGE_ROWS = [
  '.....kk.....',
  '....kggk....',
  '...kggdgk...',
  '..kggggggk..',
  'kkddddddddkk',
  '..kskkksk...',
  '..kseksek...',
  '..ksssssk...',
  '...kbbbk....',
  '..kbbwbbk...',
  '..kbgggbk...',
  '..kbgggbk...',
  '...kbbbk....',
  '...kk.kk....',
];

function spriteFromRows(rows: string[]): { buffer: Uint8ClampedArray; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const buffer = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = PAL[rows[y][x]];
      const i = (y * w + x) * 4;
      buffer[i] = c[0];
      buffer[i + 1] = c[1];
      buffer[i + 2] = c[2];
      buffer[i + 3] = c[3];
    }
  }
  return { buffer, w, h };
}

/**
 * Render a native sprite onto a faux-pixel canvas with arbitrary (possibly
 * fractional) block pitch, optional white matte background, optional phase
 * margin, deterministic diffusion noise, and 1px blended block seams.
 */
function renderFauxPixelArt(
  sprite: { buffer: Uint8ClampedArray; w: number; h: number },
  opts: {
    stepX: number;
    stepY?: number;
    marginPx?: number;
    whiteBg?: boolean;
    noiseAmp?: number;
    blendSeams?: boolean;
    haloPx?: number;
  },
): { buffer: Uint8ClampedArray; w: number; h: number } {
  const stepX = opts.stepX;
  const stepY = opts.stepY ?? stepX;
  const margin = opts.marginPx ?? 0;
  const halo = opts.haloPx ?? 0;
  const innerW = Math.round(sprite.w * stepX) + halo * 2;
  const innerH = Math.round(sprite.h * stepY) + halo * 2;
  const w = innerW + margin * 2;
  const h = innerH + margin * 2;
  const buf = new Uint8ClampedArray(w * h * 4);

  // Fill background
  if (opts.whiteBg) {
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = 255;
      buf[i + 1] = 255;
      buf[i + 2] = 255;
      buf[i + 3] = 255;
    }
  }

  // Deterministic LCG noise
  let seed = 1337;
  const nextRand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

  const noiseAmp = opts.noiseAmp ?? 0;
  for (let y = 0; y < innerH; y++) {
    const syFloat = (y - halo) / stepY;
    const sy = Math.floor(syFloat);
    for (let x = 0; x < innerW; x++) {
      const sxFloat = (x - halo) / stepX;
      const sx = Math.floor(sxFloat);
      if (sx < 0 || sy < 0 || sx >= sprite.w || sy >= sprite.h) continue;
      const si = (sy * sprite.w + sx) * 4;
      if (sprite.buffer[si + 3] < 128) continue;

      let r = sprite.buffer[si];
      let g = sprite.buffer[si + 1];
      let b = sprite.buffer[si + 2];

      // Optional 1px seam anti-aliasing with neighbor block
      if (opts.blendSeams) {
        const fx = (x - halo) - sx * stepX;
        const fy = (y - halo) - sy * stepY;
        const nearLeft = fx < 1 && sx > 0;
        const nearTop = fy < 1 && sy > 0;
        if (nearLeft || nearTop) {
          const nx = nearLeft ? sx - 1 : sx;
          const ny = nearTop ? sy - 1 : sy;
          const ni = (ny * sprite.w + nx) * 4;
          const nr = sprite.buffer[ni + 3] >= 128 ? sprite.buffer[ni] : 255;
          const ng = sprite.buffer[ni + 3] >= 128 ? sprite.buffer[ni + 1] : 255;
          const nb = sprite.buffer[ni + 3] >= 128 ? sprite.buffer[ni + 2] : 255;
          r = Math.round(r * 0.65 + nr * 0.35);
          g = Math.round(g * 0.65 + ng * 0.35);
          b = Math.round(b * 0.65 + nb * 0.35);
        }
      }

      if (noiseAmp > 0) {
        r = clamp(r + nextRand() * noiseAmp);
        g = clamp(g + nextRand() * noiseAmp);
        b = clamp(b + nextRand() * noiseAmp);
      }

      const oi = ((margin + y) * w + (margin + x)) * 4;
      buf[oi] = r;
      buf[oi + 1] = g;
      buf[oi + 2] = b;
      buf[oi + 3] = 255;
    }
  }

  return { buffer: buf, w, h };
}

const OPT = (over: Partial<Normalize2Options>): Normalize2Options => ({
  targetW: 32,
  targetH: 32,
  removeBg: true,
  bgTolerance: 48,
  paletteMode: 'off',
  palette: [],
  maxColors: 16,
  outlineCleanup: false,
  ...over,
});

// ------------------------------------------------------------ grid detection

describe('pixel-grid detection & snapping', () => {
  test('#G1 exact integer grids (2×, 4×, 8×, 12×) recover byte-identical native sprite', () => {
    const native = spriteFromRows(MINI_MAGE_ROWS);
    for (const step of [2, 4, 8, 12]) {
      const upscaled = renderFauxPixelArt(native, { stepX: step });
      const grid = detectPixelGrid(upscaled.buffer, upscaled.w, upscaled.h);
      expect(grid.detected).toBe(true);
      expect(Math.abs(grid.stepX - step)).toBeLessThan(0.05);
      expect(Math.abs(grid.stepY - step)).toBeLessThan(0.05);
      expect(grid.confidence).toBeGreaterThan(0.7);

      const snapped = snapToDetectedGrid(upscaled.buffer, upscaled.w, upscaled.h, grid);
      expect(snapped.width).toBe(native.w);
      expect(snapped.height).toBe(native.h);
      expect(Buffer.from(snapped.buffer).equals(Buffer.from(native.buffer))).toBe(true);
    }
  });

  test('#G2 fractional non-integer grid (12.5px pitch + 1px offset halo) recovers exact 12×14 sprite', () => {
    const native = spriteFromRows(MINI_MAGE_ROWS);
    const faux = renderFauxPixelArt(native, { stepX: 12.5, haloPx: 1 });
    const grid = detectPixelGrid(faux.buffer, faux.w, faux.h);
    expect(grid.detected).toBe(true);
    expect(Math.abs(grid.stepX - 12.5)).toBeLessThan(0.15);
    expect(Math.abs(grid.stepY - 12.5)).toBeLessThan(0.15);
    expect(grid.confidence).toBeGreaterThan(0.7);

    const snapped = snapToDetectedGrid(faux.buffer, faux.w, faux.h, grid);
    expect(snapped.width).toBe(native.w);
    expect(snapped.height).toBe(native.h);
    expect(Buffer.from(snapped.buffer).equals(Buffer.from(native.buffer))).toBe(true);
  });

  test('#G3 noisy + AA-seamed AI faux-pixel sprite (10.25px blocks, ±10 noise) denoises cleanly', () => {
    const native = spriteFromRows(MINI_MAGE_ROWS);
    const faux = renderFauxPixelArt(native, {
      stepX: 10.25,
      noiseAmp: 10,
      blendSeams: true,
      whiteBg: true,
      marginPx: 32,
    });

    const res = normalizeV2(
      faux.buffer,
      faux.w,
      faux.h,
      OPT({ targetW: 16, targetH: 16, paletteMode: 'auto', maxColors: 12, outlineCleanup: true }),
    );
    expect(res.stats.grid.detected).toBe(true);
    expect(Math.abs(res.stats.grid.stepX - 10.25)).toBeLessThan(0.2);
    expect(res.stats.grid.trueW).toBe(native.w);
    expect(res.stats.grid.trueH).toBe(native.h);
    expect(res.stats.grid.scaleMode).toBe('native-1x');
    expect(res.stats.grid.scaleFactor).toBe(1);
    expect(res.stats.grid.oversized).toBe(false);

    // Every opaque pixel of the 12×14 sprite landed 1:1 centered at (2, 1) on the 16×16 canvas
    let nativeOpaque = 0;
    let outOpaque = 0;
    for (let i = 3; i < native.buffer.length; i += 4) if (native.buffer[i] >= 128) nativeOpaque++;
    for (let i = 3; i < res.buffer.length; i += 4) if (res.buffer[i] >= 128) outOpaque++;
    expect(outOpaque).toBe(nativeOpaque);
  });

  test('#G4 negative tests: native 1:1 32×32 pixel-art sprites are NOT falsely snapped', () => {
    // Build 3 distinct native 1:1 32×32 pixel-art sprites (asymmetric outlines,
    // 1px shading bands, irregular silhouette — like hand-drawn RPG sprites)
    const palette: Array<[number, number, number]> = [
      [24, 20, 37],
      [56, 183, 100],
      [37, 113, 121],
      [255, 205, 117],
      [177, 62, 83],
      [59, 93, 201],
    ];
    for (let seed = 1; seed <= 3; seed++) {
      const rgba = new Uint8ClampedArray(32 * 32 * 4);
      let s = seed * 9973;
      const rnd = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
      };
      for (let y = 3; y < 29; y++) {
        const halfW = Math.max(3, Math.round(9 - Math.abs(y - 16) * 0.45 + (seed % 2)));
        for (let x = 16 - halfW; x <= 16 + halfW; x++) {
          const i = (y * 32 + x) * 4;
          const isEdge = x === 16 - halfW || x === 16 + halfW || y === 3 || y === 28;
          const col = isEdge ? palette[0] : palette[1 + Math.floor(rnd() * (palette.length - 1))];
          rgba[i] = col[0];
          rgba[i + 1] = col[1];
          rgba[i + 2] = col[2];
          rgba[i + 3] = 255;
        }
      }
      const grid = detectPixelGrid(rgba, 32, 32);
      expect(grid.detected).toBe(false);
    }
  });

  test('#G5 negative tests: smooth gradients, smooth circles, and tiny buffers return detected=false', () => {
    const w = 128;
    const h = 128;
    const grad = new Uint8ClampedArray(w * h * 4);
    const circle = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        grad[i] = x * 2;
        grad[i + 1] = y * 2;
        grad[i + 2] = x + y;
        grad[i + 3] = 255;

        const d = Math.hypot(x - 64, y - 64);
        if (d < 45) {
          circle[i] = Math.round(120 + (45 - d) * 2);
          circle[i + 1] = 80;
          circle[i + 2] = 60;
          circle[i + 3] = 255;
        }
      }
    }
    expect(detectPixelGrid(grad, w, h).detected).toBe(false);
    expect(detectPixelGrid(circle, w, h).detected).toBe(false);
    expect(detectPixelGrid(new Uint8ClampedArray(8 * 8 * 4), 8, 8).detected).toBe(false);
  });
});

// ----------------------------------------------------- whole-number scaling

describe('whole-number scaling & oversized warnings', () => {
  test('#S1 integer upscale: 12×14 sprite on 32×32 canvas scales 2× (exact 24×28 blocks, no mixels)', () => {
    const native = spriteFromRows(MINI_MAGE_ROWS);
    const scaled = scaleSpriteWholeNumber(native.buffer, native.w, native.h, 32, 32, 0.04);
    expect(scaled.scaleMode).toBe('integer-up');
    expect(scaled.scaleFactor).toBe(2);
    expect(scaled.oversized).toBe(false);

    // Every 2×2 block in the centered 24×28 region is uniform
    const dx = Math.floor((32 - 24) / 2);
    const dy = Math.floor((32 - 28) / 2);
    for (let sy = 0; sy < native.h; sy++) {
      for (let sx = 0; sx < native.w; sx++) {
        const si = (sy * native.w + sx) * 4;
        for (let py = 0; py < 2; py++) {
          for (let px = 0; px < 2; px++) {
            const oi = ((dy + sy * 2 + py) * 32 + (dx + sx * 2 + px)) * 4;
            expect(scaled.buffer[oi]).toBe(native.buffer[si]);
            expect(scaled.buffer[oi + 1]).toBe(native.buffer[si + 1]);
            expect(scaled.buffer[oi + 2]).toBe(native.buffer[si + 2]);
            expect(scaled.buffer[oi + 3]).toBe(native.buffer[si + 3]);
          }
        }
      }
    }
  });

  test('#S2 native 1:1 preserved when sprite fits target (no fractional stretch to fill padding)', () => {
    // 24×28 sprite on 32×32 canvas: integer max scale is 1× (must NOT stretch 1.07× to 26×30)
    const buf = new Uint8ClampedArray(24 * 28 * 4);
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = 40;
      buf[i + 1] = 160;
      buf[i + 2] = 90;
      buf[i + 3] = 255;
    }
    const scaled = scaleSpriteWholeNumber(buf, 24, 28, 32, 32, 0.04);
    expect(scaled.scaleMode).toBe('native-1x');
    expect(scaled.scaleFactor).toBe(1);
    expect(scaled.oversized).toBe(false);
    let opaque = 0;
    for (let i = 3; i < scaled.buffer.length; i += 4) if (scaled.buffer[i] === 255) opaque++;
    expect(opaque).toBe(24 * 28);
  });

  test('#S3 oversized true sprite (20×26 detailed sprite on 16×16) downscales by integer factor and triggers warnings', async () => {
    // Build a genuine 20×26 native pixel-art sprite (1px outlines + multi-color
    // features at every column/row), then render it as noisy 10.5px faux-pixel AI output.
    const trueW = 20;
    const trueH = 26;
    const palette: Array<[number, number, number]> = [
      [24, 20, 37],
      [56, 183, 100],
      [37, 113, 121],
      [255, 205, 117],
      [177, 62, 83],
      [59, 93, 201],
    ];
    const detailed = new Uint8ClampedArray(trueW * trueH * 4);
    for (let y = 0; y < trueH; y++) {
      for (let x = 0; x < trueW; x++) {
        // Tapered silhouette spanning full 20×26 bbox
        const dx = Math.abs(x - 9.5);
        const maxDx = y < 6 ? 3 + y * 1.1 : y < 14 ? 9.5 : y < 22 ? 7.5 : 5.5;
        if (dx > maxDx) continue;
        const i = (y * trueW + x) * 4;
        const isBorder = y === 0 || y === trueH - 1 || dx + 1 > maxDx;
        const col = isBorder ? palette[0] : palette[1 + ((x * 3 + y * 5) % (palette.length - 1))];
        detailed[i] = col[0];
        detailed[i + 1] = col[1];
        detailed[i + 2] = col[2];
        detailed[i + 3] = 255;
      }
    }

    const faux = renderFauxPixelArt(
      { buffer: detailed, w: trueW, h: trueH },
      { stepX: 10.5, whiteBg: true, marginPx: 32, noiseAmp: 6, blendSeams: true },
    );

    const opts = OPT({ targetW: 16, targetH: 16, paletteMode: 'auto', maxColors: 16, outlineCleanup: true });
    const res = normalizeV2(faux.buffer, faux.w, faux.h, opts);
    expect(res.stats.grid.detected).toBe(true);
    expect(Math.abs(res.stats.grid.stepX - 10.5)).toBeLessThan(0.2);
    expect(res.stats.grid.trueW).toBe(trueW);
    expect(res.stats.grid.trueH).toBe(trueH);
    expect(res.stats.grid.oversized).toBe(true);
    expect(res.stats.grid.scaleMode).toBe('integer-down');
    expect(res.stats.grid.scaleFactor).toBe(Math.ceil(Math.max(trueW / 16, trueH / 16)));

    // analyzeSpriteQuality emits 'grid-oversized' warning
    const quality = analyzeSpriteQuality({
      buffer: res.buffer,
      w: 16,
      h: 16,
      stats: res.stats,
      opts,
      source: { w: faux.w, h: faux.h },
    });
    const gridWarn = quality.find((f) => f.code === 'grid-oversized');
    expect(gridWarn?.severity).toBe('warning');
    expect(gridWarn?.message).toContain(`${trueW}×${trueH}`);
    expect(gridWarn?.message).toContain('16×16');

    // validateStyleCandidate emits 'grid' warning
    const checks = validateStyleCandidate({
      buffer: res.buffer,
      width: 16,
      height: 16,
      targetWidth: 16,
      targetHeight: 16,
      palette: DEFAULT_PALETTE,
      profile: defaultStyleProfile(),
      grid: res.stats.grid,
    });
    const gridCheck = checks.find((c) => c.id === 'grid');
    expect(gridCheck?.status).toBe('warning');
    expect(gridCheck?.detail).toContain(`${trueW}×${trueH}`);

    // buildReferenceCandidate surfaces the same 'grid' check end-to-end
    const png = await encodePng(faux.w, faux.h, faux.buffer);
    const cand = await buildReferenceCandidate({
      brief: 'detailed sprite',
      providerId: 'import',
      model: 'test',
      providerPng: png,
      reference: { buffer: new Uint8ClampedArray(16 * 16 * 4), width: 16, height: 16 },
      palette: DEFAULT_PALETTE,
      profile: defaultStyleProfile(),
      targetSize: 16,
    });
    expect(cand.stats.grid.oversized).toBe(true);
    expect(cand.checks.find((c) => c.id === 'grid')?.status).toBe('warning');
  });

  test('#S4 gridSnap="off" bypasses detection; gridSnap="auto" is 100% deterministic', () => {
    const native = spriteFromRows(MINI_MAGE_ROWS);
    const faux = renderFauxPixelArt(native, { stepX: 10.5, whiteBg: true, marginPx: 16, noiseAmp: 6 });
    const snapshot = new Uint8ClampedArray(faux.buffer);

    const off = normalizeV2(faux.buffer, faux.w, faux.h, OPT({ targetW: 16, targetH: 16, gridSnap: 'off' }));
    expect(off.stats.grid.detected).toBe(false);
    expect(off.stats.grid.scaleMode).toBe('none');

    const a = normalizeV2(faux.buffer, faux.w, faux.h, OPT({ targetW: 16, targetH: 16, gridSnap: 'auto' }));
    const b = normalizeV2(faux.buffer, faux.w, faux.h, OPT({ targetW: 16, targetH: 16, gridSnap: 'auto' }));
    expect(a.stats.grid.detected).toBe(true);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    expect(a.stats).toEqual(b.stats);
    expect(Buffer.from(faux.buffer).equals(Buffer.from(snapshot))).toBe(true);
  });
});
