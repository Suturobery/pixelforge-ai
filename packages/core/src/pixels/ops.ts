/**
 * Deterministic pixel operations — ported verbatim from the working web
 * prototype (src/lib/pixelforge/pixels.ts). All operations write into a
 * caller-provided RGBA buffer so the editor keeps copy-on-write semantics
 * (snapshot before stroke, commit after). Kept API-identical so the Task 4
 * renderer port and Task 5a tools reuse them unchanged.
 *
 * Pure TypeScript: no DOM canvas involved.
 */

import type { RGBA } from '../types/document';

export function inBounds(w: number, h: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h;
}

export function getPixel(buf: Uint8ClampedArray, w: number, x: number, y: number): RGBA {
  const i = (y * w + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

function setPixel(
  buf: Uint8ClampedArray, w: number, h: number, x: number, y: number, c: RGBA
): void {
  if (!inBounds(w, h, x, y)) return;
  const i = (y * w + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = c[3];
}

/** Plot a pixel, optionally mirrored across the vertical axis. */
function plot(
  buf: Uint8ClampedArray, w: number, h: number, x: number, y: number, c: RGBA, mirrorX: boolean
): void {
  setPixel(buf, w, h, x, y, c);
  if (mirrorX) setPixel(buf, w, h, w - 1 - x, y, c);
}

/** Brush footprint: square (default) or Aseprite-style circle disc. */
export type BrushShape = 'square' | 'circle';

/** True when the offset (dx,dy) from the brush center is inside the disc.
 *  Radius s/2 minus a hair for odd sizes: size 3 paints the classic plus,
 *  size 5 the 21-px circle, even sizes full rounded squares. */
export function inBrushDisc(dx: number, dy: number, size: number): boolean {
  const c = (size - 1) / 2;
  const r2 = (size / 2) * (size / 2) - (size % 2);
  const ddx = dx - c;
  const ddy = dy - c;
  return ddx * ddx + ddy * ddy <= r2;
}

/** Brush stamp centered as closely as possible on (cx, cy). */
export function stampBrush(
  buf: Uint8ClampedArray, w: number, h: number,
  cx: number, cy: number, size: number, c: RGBA, mirrorX = false,
  shape: BrushShape = 'square'
): void {
  const s = Math.max(1, size);
  const off = Math.floor((s - 1) / 2);
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      if (shape === 'circle' && !inBrushDisc(dx, dy, s)) continue;
      plot(buf, w, h, cx + dx - off, cy + dy - off, c, mirrorX);
    }
  }
}

/** A captured RGBA stamp (selection → brush). */
export interface CustomBrush {
  w: number;
  h: number;
  /** RGBA, length = w*h*4 */
  data: Uint8ClampedArray;
}

/** Stamp a custom brush so its CENTER lands on (cx, cy).
 *  paint=false → ERASE every pixel under the brush's opaque footprint. */
export function stampCustomBuffer(
  buf: Uint8ClampedArray, w: number, h: number,
  cx: number, cy: number, brush: CustomBrush, mirrorX = false,
  erase = false
): void {
  const offX = Math.floor(brush.w / 2);
  const offY = Math.floor(brush.h / 2);
  for (let dy = 0; dy < brush.h; dy++) {
    for (let dx = 0; dx < brush.w; dx++) {
      const src = (dy * brush.w + dx) * 4;
      if (brush.data[src + 3] === 0) continue;
      const x = cx + dx - offX;
      const y = cy + dy - offY;
      if (erase) {
        setPixel(buf, w, h, x, y, [0, 0, 0, 0]);
        if (mirrorX) setPixel(buf, w, h, w - 1 - x, y, [0, 0, 0, 0]);
      } else {
        plot(buf, w, h, x, y, [brush.data[src], brush.data[src + 1], brush.data[src + 2], brush.data[src + 3]], mirrorX);
      }
    }
  }
}

/** Bresenham line stamped with the brush. */
export function drawLinePixels(
  buf: Uint8ClampedArray, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number,
  size: number, c: RGBA, mirrorX = false,
  shape: BrushShape = 'square'
): void {
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    stampBrush(buf, w, h, x, y, size, c, mirrorX, shape);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

export function drawRectPixels(
  buf: Uint8ClampedArray, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number,
  size: number, c: RGBA, filled: boolean, mirrorX = false,
  shape: BrushShape = 'square'
): void {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  if (filled) {
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        stampBrush(buf, w, h, x, y, 1, c, false);
      }
    }
    if (mirrorX) {
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          setPixel(buf, w, h, w - 1 - x, y, c);
        }
      }
    }
    return;
  }
  drawLinePixels(buf, w, h, left, top, right, top, size, c, mirrorX, shape);
  drawLinePixels(buf, w, h, left, bottom, right, bottom, size, c, mirrorX, shape);
  drawLinePixels(buf, w, h, left, top, left, bottom, size, c, mirrorX, shape);
  drawLinePixels(buf, w, h, right, top, right, bottom, size, c, mirrorX, shape);
}

const sameColor = (buf: Uint8ClampedArray, i: number, c: RGBA): boolean =>
  buf[i] === c[0] && buf[i + 1] === c[1] && buf[i + 2] === c[2] && buf[i + 3] === c[3];

function fillAt(
  buf: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, c: RGBA
): boolean {
  if (!inBounds(w, h, sx, sy)) return false;
  const start = (sy * w + sx) * 4;
  if (sameColor(buf, start, c)) return false;
  const target: RGBA = [buf[start], buf[start + 1], buf[start + 2], buf[start + 3]];
  const stack: number[] = [sy * w + sx];
  while (stack.length > 0) {
    const p = stack.pop() as number;
    let left = p % w;
    let right = left;
    const y = (p / w) | 0;
    const row = y * w;
    while (left > 0 && sameColor(buf, (row + left - 1) * 4, target)) left--;
    while (right < w - 1 && sameColor(buf, (row + right + 1) * 4, target)) right++;
    for (let x = left; x <= right; x++) {
      setPixel(buf, w, h, x, y, c);
      if (y > 0 && sameColor(buf, ((y - 1) * w + x) * 4, target)) stack.push((y - 1) * w + x);
      if (y < h - 1 && sameColor(buf, ((y + 1) * w + x) * 4, target)) stack.push((y + 1) * w + x);
    }
  }
  return true;
}

/** Scanline flood fill. Returns true when any pixel changed. */
export function floodFill(
  buf: Uint8ClampedArray, w: number, h: number,
  sx: number, sy: number, c: RGBA, mirrorX = false
): boolean {
  const changed = fillAt(buf, w, h, sx, sy, c);
  if (mirrorX) fillAt(buf, w, h, w - 1 - sx, sy, c);
  return changed;
}

/** Collect the scanline-flood region touching (sx, sy) WITHOUT painting. */
function collectRegion(
  buf: Uint8ClampedArray, w: number, h: number, sx: number, sy: number
): number[] {
  const out: number[] = [];
  if (!inBounds(w, h, sx, sy)) return out;
  const start = (sy * w + sx) * 4;
  const target: RGBA = [buf[start], buf[start + 1], buf[start + 2], buf[start + 3]];
  const seen = new Uint8Array(w * h);
  const stack: number[] = [sy * w + sx];
  seen[sy * w + sx] = 1;
  while (stack.length > 0) {
    const p = stack.pop() as number;
    out.push(p);
    let left = p % w;
    let right = left;
    const y = (p / w) | 0;
    const row = y * w;
    const push = (q: number) => {
      if (!seen[q] && sameColor(buf, q * 4, target)) { seen[q] = 1; stack.push(q); }
    };
    while (left > 0 && sameColor(buf, (row + left - 1) * 4, target)) left--;
    while (right < w - 1 && sameColor(buf, (row + right + 1) * 4, target)) right++;
    for (let x = left; x <= right; x++) {
      if (y > 0) push((y - 1) * w + x);
      if (y < h - 1) push((y + 1) * w + x);
    }
  }
  return out;
}

/** Bayer 2×2 thresholds — classic pixel-art dither between two colors. */
const BAYER2 = [[0, 2], [3, 1]];

/**
 * Flood fill with a 2×2 Bayer dither between colors a and b (checker pattern).
 * Returns true when any pixel changed.
 */
export function floodFillDither(
  buf: Uint8ClampedArray, w: number, h: number,
  sx: number, sy: number, a: RGBA, b: RGBA, mirrorX = false
): boolean {
  const run = (cx: number, cy: number): boolean => {
    const region = collectRegion(buf, w, h, cx, cy);
    if (region.length === 0) return false;
    for (const p of region) {
      const x = p % w, y = (p / w) | 0;
      setPixel(buf, w, h, x, y, BAYER2[y % 2][x % 2] < 2 ? a : b);
    }
    return true;
  };
  const changed = run(sx, sy);
  if (mirrorX) run(w - 1 - sx, sy);
  return changed;
}

// ---------------------------------------------------------------------------
// pixel-perfect freehand (Aseprite-style): replaces diagonal corners with a
// straight connection so hand-drawn lines carry no doubled pixels.
// ---------------------------------------------------------------------------

export interface PixelPerfectState {
  p2: { x: number; y: number } | null;
  p1: { x: number; y: number };
  /** pre-stroke colors of every pixel this stroke touched */
  patch: Map<string, RGBA>;
}

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function ppCapture(pp: PixelPerfectState, x: number, y: number, buf: Uint8ClampedArray, w: number): void {
  const k = `${x},${y}`;
  if (pp.patch.has(k)) return;
  const i = (y * w + x) * 4;
  pp.patch.set(k, [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]);
}

function ppRestore(pp: PixelPerfectState, p: { x: number; y: number }, buf: Uint8ClampedArray, w: number): void {
  const old = pp.patch.get(`${p.x},${p.y}`);
  if (!old) return;
  const i = (p.y * w + p.x) * 4;
  buf[i] = old[0]; buf[i + 1] = old[1]; buf[i + 2] = old[2]; buf[i + 3] = old[3];
}

function ppStamp(pp: PixelPerfectState, p: { x: number; y: number }, buf: Uint8ClampedArray,
  w: number, h: number, c: RGBA, shape: BrushShape): void {
  ppCapture(pp, p.x, p.y, buf, w);
  stampBrush(buf, w, h, p.x, p.y, 1, c, false, shape);
}

function ppLine(pp: PixelPerfectState, a: { x: number; y: number }, b: { x: number; y: number },
  buf: Uint8ClampedArray, w: number, h: number, c: RGBA, shape: BrushShape): void {
  // own bresenham only to capture pre-stroke colors; drawing goes through stampBrush
  let x = a.x, y = a.y;
  const dx = Math.abs(b.x - x), dy = Math.abs(b.y - y);
  const sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
  let err = dx - dy;
  const cap = dx + dy + 1;
  for (let i = 0; i <= cap; i++) {
    ppStamp(pp, { x, y }, buf, w, h, c, shape);
    if (x === b.x && y === b.y) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx }
    if (e2 < dx) { err += dx; y += sy }
  }
}

/**
 * Feed one pointermove point. Caller owns state (new PixelPerfectState at
 * stroke start) and the 1px guarantee — mirrors/custom brushes stay on the
 * plain path.
 */
export function pixelPerfectStroke(
  pp: PixelPerfectState, p: { x: number; y: number }, buf: Uint8ClampedArray,
  w: number, h: number, c: RGBA, shape: BrushShape = 'square'
): void {
  const { p2, p1 } = pp;
  const d = cheb(p, p1);
  if (d === 0) return;
  if (d === 1 && p2) {
    // corner-fix: last segment diagonal, new segment turns 90° — drop the
    // stair pixel p1 and connect p2→p directly (3-pixel L, p1 = diagonal mid)
    const dx = Math.abs(p.x - p2.x), dy = Math.abs(p.y - p2.y);
    const sx2 = Math.sign(p.x - p2.x), sy2 = Math.sign(p.y - p2.y);
    const cornerBetween =
      cheb(p2, p) === 2 && dx + dy === 3 &&
      p1.x === p2.x + sx2 && p1.y === p2.y + sy2;
    if (cornerBetween) {
      ppRestore(pp, p1, buf, w);
      ppLine(pp, p2, p, buf, w, h, c, shape);
      pp.p2 = p; pp.p1 = p;
      return;
    }
  }
  if (d === 1) {
    ppStamp(pp, p, buf, w, h, c, shape);
    pp.p2 = p1; pp.p1 = p;
    return;
  }
  ppLine(pp, p1, p, buf, w, h, c, shape);
  pp.p2 = p1; pp.p1 = p;
}

// ---------------------------------------------------------------------------
// beautify: 1px outline + directional shading — the "make it look finished"
// one-call pass. Pure; palette enforcement stays with the caller.
// ---------------------------------------------------------------------------

export interface BeautifyOptions {
  /** outline color; null skips the outline pass */
  outline?: RGBA | null;
  /** shade pixels whose down/right neighbor was empty before the pass */
  shade?: boolean;
}

/**
 * Auto-outline + auto-shade in one pass (light from top-left).
 * Outline: every empty pixel touching the shape's 4-neighbors gets the
 * outline color. Shade: original opaque pixels on the bottom/right inner
 * edge darken by 28% — measured against the PRE-outline snapshot so outline
 * pixels never shade themselves.
 */
export function beautifyLayer(
  buf: Uint8ClampedArray, w: number, h: number, opts: BeautifyOptions = {}
): boolean {
  const outline = opts.outline === undefined ? ([26, 28, 44, 255] as RGBA) : opts.outline;
  const doShade = opts.shade !== false;
  const snapshot = Uint8ClampedArray.from(buf);
  const alphaAt = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : snapshot[(y * w + x) * 4 + 3];
  let changed = false;

  if (outline && outline[3] > 0) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alphaAt(x, y) > 0) continue;
        if (alphaAt(x - 1, y) > 0 || alphaAt(x + 1, y) > 0 || alphaAt(x, y - 1) > 0 || alphaAt(x, y + 1) > 0) {
          setPixel(buf, w, h, x, y, outline);
          changed = true;
        }
      }
    }
  }
  if (doShade) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alphaAt(x, y) === 0) continue; // empty in original
        const i = (y * w + x) * 4;
        if (buf[i + 3] === 0) continue; // covered by outline pass
        const edgeDown = alphaAt(x, y + 1) === 0;
        const edgeRight = alphaAt(x + 1, y) === 0;
        if (edgeDown || edgeRight) {
          buf[i] = Math.round(buf[i] * 0.72);
          buf[i + 1] = Math.round(buf[i + 1] * 0.72);
          buf[i + 2] = Math.round(buf[i + 2] * 0.72);
          changed = true;
        }
      }
    }
  }
  return changed;
}

/** Shift layer content by (dx, dy); returns a NEW buffer. */
export function moveBuffer(
  buf: Uint8ClampedArray, w: number, h: number, dx: number, dy: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(buf.length);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= w) continue;
      const si = (sy * w + sx) * 4;
      const di = (y * w + x) * 4;
      out[di] = buf[si];
      out[di + 1] = buf[si + 1];
      out[di + 2] = buf[si + 2];
      out[di + 3] = buf[si + 3];
    }
  }
  return out;
}

/** Zero every byte of the buffer in place (used by the "clear" op). */
export function clearBufferInPlace(buf: Uint8ClampedArray): void {
  buf.fill(0);
}
