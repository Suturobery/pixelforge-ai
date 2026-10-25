/**
 * Task 5a — region transform tests (v3.1 §2.1 "Transform ops"): flip H/V,
 * rotate 90° CW/CCW, region extract/clear/paste. Contract: integer-exact,
 * interpolation-free, alpha-preserving, deterministic, canvas-boundary
 * safe, non-square regions re-anchor at the same top-left.
 */

import { describe, expect, test } from 'bun:test';
import {
  clampRect,
  clearRegionInPlace,
  extractRegion,
  flipRegionHInPlace,
  flipRegionVInPlace,
  pasteRegionInPlace,
  rotateRegionCCWInPlace,
  rotateRegionCWInPlace,
} from '../src/pixels/region';
import { getPixel } from '../src/pixels/ops';

const W = 16;
const H = 16;

function blank(): Uint8ClampedArray {
  return new Uint8ClampedArray(W * H * 4);
}

/** Fill a rect with a unique deterministic color per pixel. */
function paint(buf: Uint8ClampedArray, rect: { x: number; y: number; w: number; h: number }): void {
  for (let j = 0; j < rect.h; j++) {
    for (let i = 0; i < rect.w; i++) {
      const x = rect.x + i;
      const y = rect.y + j;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const k = (y * W + x) * 4;
      buf[k] = (x * 13 + 10) % 256;
      buf[k + 1] = (y * 7 + 20) % 256;
      buf[k + 2] = (x * 3 + y * 5 + 30) % 256;
      buf[k + 3] = ((x + y) % 2 === 0 ? 255 : 128); // mixed transparency
    }
  }
}

function px(buf: Uint8ClampedArray, x: number, y: number): [number, number, number, number] {
  return getPixel(buf, W, x, y);
}

describe('clampRect', () => {
  test('clips to the canvas and drops empty results', () => {
    expect(clampRect({ x: 4, y: 4, w: 6, h: 6 }, W, H)).toEqual({ x: 4, y: 4, w: 6, h: 6 });
    expect(clampRect({ x: -3, y: -3, w: 6, h: 6 }, W, H)).toEqual({ x: 0, y: 0, w: 3, h: 3 });
    expect(clampRect({ x: -10, y: -10, w: 5, h: 5 }, W, H)).toBeNull();
    expect(clampRect({ x: 20, y: 0, w: 4, h: 4 }, W, H)).toBeNull();
  });
});

describe('flipRegionHInPlace', () => {
  test('mirrors the region horizontally, leaving the rest untouched', () => {
    const buf = blank();
    paint(buf, { x: 2, y: 3, w: 4, h: 3 });
    const beforeLeft = px(buf, 2, 3);
    const beforeRight = px(buf, 5, 3);
    flipRegionHInPlace(buf, W, H, { x: 2, y: 3, w: 4, h: 3 });
    expect(px(buf, 5, 3)).toEqual(beforeLeft); // left column ↔ right column
    expect(px(buf, 2, 3)).toEqual(beforeRight);
    // outside the region: untouched
    expect(px(buf, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  test('preserves alpha bytes exactly', () => {
    const buf = blank();
    paint(buf, { x: 0, y: 0, w: 5, h: 5 });
    const original = new Uint8ClampedArray(buf);
    flipRegionHInPlace(buf, W, H, { x: 0, y: 0, w: 5, h: 5 });
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        // post (x, y) must equal PRE (4-x, y) — the mirrored source pixel
        expect(px(buf, x, y)).toEqual(getPixel(original, W, 4 - x, y));
      }
    }
  });

  test('clamps rects that extend past the canvas', () => {
    const buf = blank();
    paint(buf, { x: 12, y: 0, w: 8, h: 2 }); // extends to x=20 (past W=16)
    const preEdge = px(buf, 15, 0);
    const preInner = px(buf, 12, 0);
    flipRegionHInPlace(buf, W, H, { x: 12, y: 0, w: 8, h: 2 });
    // no throw; the clamped region [12..15] is mirrored
    expect(px(buf, 12, 0)).toEqual(preEdge);
    expect(px(buf, 15, 0)).toEqual(preInner);
  });
});

describe('flipRegionVInPlace', () => {
  test('mirrors the region vertically', () => {
    const buf = blank();
    paint(buf, { x: 1, y: 2, w: 3, h: 4 });
    const before = px(buf, 1, 2);
    flipRegionVInPlace(buf, W, H, { x: 1, y: 2, w: 3, h: 4 });
    expect(px(buf, 1, 5)).toEqual(before);
    expect(px(buf, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('rotateRegionCWInPlace / CCW (square region = in-place)', () => {
  test('4× CW round-trips a square region bit-exactly', () => {
    const buf = blank();
    paint(buf, { x: 3, y: 3, w: 4, h: 4 });
    const original = new Uint8ClampedArray(buf);
    for (let i = 0; i < 4; i++) rotateRegionCWInPlace(buf, W, H, { x: 3, y: 3, w: 4, h: 4 });
    expect(Array.from(buf)).toEqual(Array.from(original));
  });

  test('CW maps top-left → top-right (square)', () => {
    const buf = blank();
    paint(buf, { x: 2, y: 2, w: 3, h: 3 });
    const tl = px(buf, 2, 2);
    rotateRegionCWInPlace(buf, W, H, { x: 2, y: 2, w: 3, h: 3 });
    expect(px(buf, 4, 2)).toEqual(tl);
  });

  test('CCW maps top-left → bottom-left (square)', () => {
    const buf = blank();
    paint(buf, { x: 2, y: 2, w: 3, h: 3 });
    const tl = px(buf, 2, 2);
    rotateRegionCCWInPlace(buf, W, H, { x: 2, y: 2, w: 3, h: 3 });
    expect(px(buf, 2, 4)).toEqual(tl);
  });

  test('CW + CCW round-trips exactly (square)', () => {
    const buf = blank();
    paint(buf, { x: 5, y: 5, w: 3, h: 3 });
    const original = new Uint8ClampedArray(buf);
    rotateRegionCWInPlace(buf, W, H, { x: 5, y: 5, w: 3, h: 3 });
    rotateRegionCCWInPlace(buf, W, H, { x: 5, y: 5, w: 3, h: 3 });
    expect(Array.from(buf)).toEqual(Array.from(original));
  });
});

describe('rotation of NON-SQUARE regions', () => {
  test('2×3 region re-anchors to a 3×2 footprint at the same top-left', () => {
    const buf = blank();
    paint(buf, { x: 4, y: 4, w: 2, h: 3 });
    const tl = px(buf, 4, 4); // top-left source pixel
    const bl = px(buf, 4, 6); // bottom-left source pixel
    const footprint = rotateRegionCWInPlace(buf, W, H, { x: 4, y: 4, w: 2, h: 3 });
    expect({ x: footprint.x, y: footprint.y, w: footprint.w, h: footprint.h }).toEqual({
      x: 4,
      y: 4,
      w: 3,
      h: 2,
    });
    // CW: source (i, j) → dest (h-1-j, i): top-left (0,0) → (2,0) top-right
    expect(px(buf, 6, 4)).toEqual(tl);
    // bottom-left (0,2) → (0,0) new top-left
    expect(px(buf, 4, 4)).toEqual(bl);
    // old footprint fully cleared where the new one does not reach:
    // old region covered (4..5, 4..6); new covers (4..6, 4..5) → (4,6),(5,6) cleared
    expect(px(buf, 4, 6)).toEqual([0, 0, 0, 0]);
    expect(px(buf, 5, 6)).toEqual([0, 0, 0, 0]);
  });

  test('3×2 CCW → 2×3 footprint', () => {
    const buf = blank();
    paint(buf, { x: 2, y: 2, w: 3, h: 2 });
    const tr = px(buf, 4, 2); // top-right source pixel
    const footprint = rotateRegionCCWInPlace(buf, W, H, { x: 2, y: 2, w: 3, h: 2 });
    expect(footprint.w).toBe(2);
    expect(footprint.h).toBe(3);
    // CCW: (i, j) → (j, w-1-i): top-right (2,0) → (0,0) top-left of new footprint
    expect(px(buf, 2, 2)).toEqual(tr);
  });

  test('4× CW round-trips a non-square region (footprint returns)', () => {
    const buf = blank();
    paint(buf, { x: 3, y: 3, w: 2, h: 5 });
    const original = new Uint8ClampedArray(buf);
    const r = { x: 3, y: 3, w: 2, h: 5 };
    rotateRegionCWInPlace(buf, W, H, r); // → 5×2 at (3,3)
    rotateRegionCWInPlace(buf, W, H, { x: 3, y: 3, w: 5, h: 2 }); // → 2×5 at (3,3)
    rotateRegionCWInPlace(buf, W, H, { x: 3, y: 3, w: 2, h: 5 }); // → 5×2
    rotateRegionCWInPlace(buf, W, H, { x: 3, y: 3, w: 5, h: 2 }); // → 2×5 (original orientation)
    // 4× CW = identity for the CONTENT when the footprint returns to 2×5
    // NOTE: the intermediate footprints clear/set different pixels, so compare
    // only the final footprint content against the original footprint content.
    const orig = extractRegion(original, W, H, r);
    const now = extractRegion(buf, W, H, r);
    expect(Array.from(now)).toEqual(Array.from(orig));
  });

  test('rotation drops content that lands outside the canvas (boundary)', () => {
    const buf = blank();
    // region touches the right edge: rotating CW pushes the left column past it
    paint(buf, { x: 12, y: 2, w: 4, h: 3 });
    expect(() => rotateRegionCWInPlace(buf, W, H, { x: 12, y: 2, w: 4, h: 3 })).not.toThrow();
    // nothing exists past the canvas edge
    expect(clampRect({ x: 12, y: 2, w: 3, h: 4 }, W, H)).toEqual({ x: 12, y: 2, w: 3, h: 4 });
  });
});

describe('extractRegion / clearRegionInPlace / pasteRegionInPlace', () => {
  test('extract copies pixels verbatim including alpha', () => {
    const buf = blank();
    paint(buf, { x: 1, y: 1, w: 4, h: 4 });
    const reg = extractRegion(buf, W, H, { x: 1, y: 1, w: 4, h: 4 });
    expect(reg.length).toBe(4 * 4 * 4);
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const k = (j * 4 + i) * 4;
        expect(Array.from(reg.slice(k, k + 4))).toEqual(px(buf, 1 + i, 1 + j));
      }
    }
  });

  test('clear zeroes the region and only the region', () => {
    const buf = blank();
    paint(buf, { x: 2, y: 2, w: 4, h: 4 });
    clearRegionInPlace(buf, W, H, { x: 2, y: 2, w: 4, h: 4 });
    for (let y = 2; y < 6; y++) {
      for (let x = 2; x < 6; x++) expect(px(buf, x, y)).toEqual([0, 0, 0, 0]);
    }
    expect(px(buf, 1, 1)).toEqual([0, 0, 0, 0]); // never painted
    expect(px(buf, 7, 7)).toEqual([0, 0, 0, 0]);
  });

  test('paste overwrites alpha (transparent pixels punch through)', () => {
    const buf = blank();
    paint(buf, { x: 0, y: 0, w: 4, h: 4 }); // opaque base
    const src = new Uint8ClampedArray(2 * 2 * 4);
    src[3] = 0; // fully transparent source pixel
    pasteRegionInPlace(buf, W, H, src, 2, 2, 0, 0);
    expect(px(buf, 0, 0)).toEqual([0, 0, 0, 0]); // transparency preserved through paste
  });

  test('paste clips at canvas boundaries', () => {
    const buf = blank();
    const src = new Uint8ClampedArray(4 * 4 * 4).fill(200);
    for (let i = 3; i < src.length; i += 4) src[i] = 255;
    expect(() => pasteRegionInPlace(buf, W, H, src, 4, 4, 14, 14)).not.toThrow();
    expect(px(buf, 15, 15)[0]).toBe(200);
    expect(px(buf, 13, 13)).toEqual([0, 0, 0, 0]); // outside the paste area
  });

  test('selection move composition: extract + clear + paste at offset', () => {
    const buf = blank();
    paint(buf, { x: 2, y: 2, w: 3, h: 3 });
    const snapshot = new Uint8ClampedArray(buf);
    const rect = { x: 2, y: 2, w: 3, h: 3 };
    const content = extractRegion(snapshot, W, H, rect);
    clearRegionInPlace(buf, W, H, rect);
    pasteRegionInPlace(buf, W, H, content, rect.w, rect.h, rect.x + 2, rect.y + 1);
    // old area cleared, content landed at (4,3)
    expect(px(buf, 2, 2)).toEqual([0, 0, 0, 0]);
    const expectMoved = extractRegion(snapshot, W, H, rect);
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        const k = (j * 3 + i) * 4;
        expect(Array.from(expectMoved.slice(k, k + 4))).toEqual(px(buf, 4 + i, 3 + j));
      }
    }
  });
});
