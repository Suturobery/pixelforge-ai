/**
 * Region-scoped pixel transforms (v3.1 §2.1 "Transform ops — flip H/V +
 * rotate 90° on layer/cel/selection"). All operations are integer-exact,
 * interpolation-free, alpha-preserving, and deterministic.
 *
 * Rect convention: {x, y, w, h} in canvas coordinates, inclusive-negative
 * (a rect covers w×h pixels starting at (x, y)). Every helper clamps the
 * rect to the canvas; empty/fully-outside rects are no-ops.
 *
 * Rotation anchoring: a w×h region rotated 90° occupies an h×w footprint
 * anchored at the SAME top-left corner (deterministic; for square regions —
 * the common case — this is the familiar in-place rotation). Content that
 * lands outside the canvas is dropped, content left behind by the new
 * footprint is cleared. Whole-cel transforms pass the full-canvas rect.
 */

import { inBounds } from './ops';

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Clamp a rect to the canvas; returns null when nothing remains. */
export function clampRect(rect: PixelRect, W: number, H: number): PixelRect | null {
  const x0 = Math.max(0, Math.min(rect.x, W));
  const y0 = Math.max(0, Math.min(rect.y, H));
  const x1 = Math.max(0, Math.min(rect.x + rect.w, W));
  const y1 = Math.max(0, Math.min(rect.y + rect.h, H));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Mirror a rect region horizontally, in place. */
export function flipRegionHInPlace(buf: Uint8ClampedArray, W: number, H: number, rect: PixelRect): void {
  const r = clampRect(rect, W, H);
  if (!r) return;
  for (let y = r.y; y < r.y + r.h; y++) {
    const row = y * W;
    for (let x = 0; x < Math.floor(r.w / 2); x++) {
      const ia = (row + r.x + x) * 4;
      const ib = (row + r.x + (r.w - 1 - x)) * 4;
      for (let k = 0; k < 4; k++) {
        const tmp = buf[ia + k];
        buf[ia + k] = buf[ib + k];
        buf[ib + k] = tmp;
      }
    }
  }
}

/** Mirror a rect region vertically, in place. */
export function flipRegionVInPlace(buf: Uint8ClampedArray, W: number, H: number, rect: PixelRect): void {
  const r = clampRect(rect, W, H);
  if (!r) return;
  for (let y = 0; y < Math.floor(r.h / 2); y++) {
    const ya = (r.y + y) * W;
    const yb = (r.y + r.h - 1 - y) * W;
    for (let x = r.x; x < r.x + r.w; x++) {
      const ia = (ya + x) * 4;
      const ib = (yb + x) * 4;
      for (let k = 0; k < 4; k++) {
        const tmp = buf[ia + k];
        buf[ia + k] = buf[ib + k];
        buf[ib + k] = tmp;
      }
    }
  }
}

/**
 * Rotate the rect region 90° clockwise, in place. The content occupies an
 * h×w footprint anchored at the same top-left corner; pixels rotated outside
 * the canvas are dropped. Returns the destination footprint (clipped).
 */
export function rotateRegionCWInPlace(buf: Uint8ClampedArray, W: number, H: number, rect: PixelRect): PixelRect {
  return rotateRegion(buf, W, H, rect, true);
}

/** Rotate the rect region 90° counter-clockwise, in place. Same anchoring. */
export function rotateRegionCCWInPlace(buf: Uint8ClampedArray, W: number, H: number, rect: PixelRect): PixelRect {
  return rotateRegion(buf, W, H, rect, false);
}

function rotateRegion(
  buf: Uint8ClampedArray,
  W: number,
  H: number,
  rect: PixelRect,
  cw: boolean
): PixelRect {
  const r = clampRect(rect, W, H);
  if (!r) return { x: rect.x, y: rect.y, w: 0, h: 0 };
  const { x, y, w, h } = r;
  const temp = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const si = ((y + j) * W + (x + i)) * 4;
      const di = (j * w + i) * 4;
      temp[di] = buf[si];
      temp[di + 1] = buf[si + 1];
      temp[di + 2] = buf[si + 2];
      temp[di + 3] = buf[si + 3];
    }
  }
  // clear the old footprint
  for (let j = 0; j < h; j++) {
    buf.fill(0, (y + j) * W * 4 + x * 4, (y + j) * W * 4 + (x + w) * 4);
  }
  // write rotated content: CW maps (i, j) → (h-1-j, i); CCW maps (i, j) → (j, w-1-i)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const si = (j * w + i) * 4;
      const diRel = cw ? { x: h - 1 - j, y: i } : { x: j, y: w - 1 - i };
      const dx = x + diRel.x;
      const dy = y + diRel.y;
      if (!inBounds(W, H, dx, dy)) continue; // respect canvas boundaries
      const di = (dy * W + dx) * 4;
      buf[di] = temp[si];
      buf[di + 1] = temp[si + 1];
      buf[di + 2] = temp[si + 2];
      buf[di + 3] = temp[si + 3];
    }
  }
  // destination footprint anchored at the same top-left (clipped);
  // a 90° rotation in EITHER direction swaps the footprint dimensions
  const fw = h;
  const fh = w;
  const cx = Math.max(0, Math.min(x, W));
  const cy = Math.max(0, Math.min(y, H));
  return {
    x: cx,
    y: cy,
    w: Math.max(0, Math.min(x + fw, W) - cx),
    h: Math.max(0, Math.min(y + fh, H) - cy),
  };
}

/**
 * Nearest-neighbor scale of a rect region about its top-left corner, in
 * place. Integer factors ≥ 2 duplicate pixels (crisp upscale); 0.5 samples
 * every other source pixel (downscale). Content is extracted first, the
 * source area cleared, then the scaled footprint is written back clipped to
 * the canvas — pixels pushed outside are dropped (same contract as the
 * rotate helpers). Returns the destination footprint (clipped) so callers
 * can keep selections in sync. Deterministic, interpolation-free.
 */
export function scaleRegionInPlace(
  buf: Uint8ClampedArray,
  W: number,
  H: number,
  rect: PixelRect,
  factor: number
): PixelRect {
  const r = clampRect(rect, W, H);
  if (!r) return { x: rect.x, y: rect.y, w: 0, h: 0 };
  const down = factor < 1;
  const fw = down ? Math.max(1, Math.ceil(r.w / 2)) : r.w * factor;
  const fh = down ? Math.max(1, Math.ceil(r.h / 2)) : r.h * factor;
  const src = extractRegion(buf, W, H, r);
  clearRegionInPlace(buf, W, H, r);
  for (let j = 0; j < fh; j++) {
    const dy = r.y + j;
    if (dy >= H) break; // footprint clipped by the canvas bottom
    const sy = down ? j * 2 : Math.floor(j / factor);
    for (let i = 0; i < fw; i++) {
      const dx = r.x + i;
      if (dx >= W) break; // footprint clipped by the canvas right edge
      const sx = down ? i * 2 : Math.floor(i / factor);
      const si = (sy * r.w + sx) * 4;
      const di = (dy * W + dx) * 4;
      buf[di] = src[si];
      buf[di + 1] = src[si + 1];
      buf[di + 2] = src[si + 2];
      buf[di + 3] = src[si + 3];
    }
  }
  // destination footprint anchored at the same top-left (clipped to canvas)
  const cx = Math.max(0, Math.min(r.x, W));
  const cy = Math.max(0, Math.min(r.y, H));
  return {
    x: cx,
    y: cy,
    w: Math.max(0, Math.min(r.x + fw, W) - cx),
    h: Math.max(0, Math.min(r.y + fh, H) - cy),
  };
}

/**
 * Arbitrary nearest-neighbor resample of a rect region into a destination
 * footprint (free scaling). The source content is extracted, its area
 * cleared, then written into `dst` (clipped to the canvas) with independent
 * per-axis NN sampling — uniform or non-uniform, upscale or downscale.
 * Content pushed outside the canvas is dropped. Deterministic.
 */
export function scaleRegionToInPlace(
  buf: Uint8ClampedArray,
  W: number,
  H: number,
  src: PixelRect,
  dst: PixelRect
): void {
  const s = clampRect(src, W, H);
  if (!s) return;
  const data = extractRegion(buf, W, H, s);
  clearRegionInPlace(buf, W, H, s);
  const d = clampRect(dst, W, H);
  if (!d) return;
  for (let j = 0; j < d.h; j++) {
    const relY = d.y + j - dst.y;
    const sy = Math.min(s.h - 1, Math.floor((relY * s.h) / dst.h));
    for (let i = 0; i < d.w; i++) {
      const relX = d.x + i - dst.x;
      const sx = Math.min(s.w - 1, Math.floor((relX * s.w) / dst.w));
      const si = (sy * s.w + sx) * 4;
      const di = ((d.y + j) * W + (d.x + i)) * 4;
      buf[di] = data[si];
      buf[di + 1] = data[si + 1];
      buf[di + 2] = data[si + 2];
      buf[di + 3] = data[si + 3];
    }
  }
}

/** Copy a rect region out (alpha verbatim — transparency preserved). */
export function extractRegion(buf: Uint8ClampedArray, W: number, H: number, rect: PixelRect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let j = 0; j < rect.h; j++) {
    const sy = rect.y + j;
    if (sy < 0 || sy >= H) continue;
    for (let i = 0; i < rect.w; i++) {
      const sx = rect.x + i;
      if (sx < 0 || sx >= W) continue;
      const di = (j * rect.w + i) * 4;
      const si = (sy * W + sx) * 4;
      out[di] = buf[si];
      out[di + 1] = buf[si + 1];
      out[di + 2] = buf[si + 2];
      out[di + 3] = buf[si + 3];
    }
  }
  return out;
}

/** Zero a rect region in place (transparent). */
export function clearRegionInPlace(buf: Uint8ClampedArray, W: number, H: number, rect: PixelRect): void {
  const r = clampRect(rect, W, H);
  if (!r) return;
  for (let j = 0; j < r.h; j++) {
    buf.fill(0, (r.y + j) * W * 4 + r.x * 4, (r.y + j) * W * 4 + (r.x + r.w) * 4);
  }
}

/**
 * Overwrite `buf` with `src` (rw×rh RGBA) anchored at (dx, dy). Pixels
 * outside the canvas are clipped; alpha is copied verbatim (pasting
 * transparent pixels punches transparency — Aseprite paste semantics).
 */
export function pasteRegionInPlace(
  buf: Uint8ClampedArray,
  W: number,
  H: number,
  src: Uint8ClampedArray,
  rw: number,
  rh: number,
  dx: number,
  dy: number
): void {
  for (let j = 0; j < rh; j++) {
    const y = dy + j;
    if (y < 0 || y >= H) continue;
    for (let i = 0; i < rw; i++) {
      const x = dx + i;
      if (x < 0 || x >= W) continue;
      const si = (j * rw + i) * 4;
      const di = (y * W + x) * 4;
      buf[di] = src[si];
      buf[di + 1] = src[si + 1];
      buf[di + 2] = src[si + 2];
      buf[di + 3] = src[si + 3];
    }
  }
}
