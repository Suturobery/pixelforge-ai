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

/** Square brush stamp centered as closely as possible on (cx, cy). */
export function stampBrush(
  buf: Uint8ClampedArray, w: number, h: number,
  cx: number, cy: number, size: number, c: RGBA, mirrorX = false
): void {
  const s = Math.max(1, size);
  const off = Math.floor((s - 1) / 2);
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      plot(buf, w, h, cx + dx - off, cy + dy - off, c, mirrorX);
    }
  }
}

/** Bresenham line stamped with the brush. */
export function drawLinePixels(
  buf: Uint8ClampedArray, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number,
  size: number, c: RGBA, mirrorX = false
): void {
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    stampBrush(buf, w, h, x, y, size, c, mirrorX);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

export function drawRectPixels(
  buf: Uint8ClampedArray, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number,
  size: number, c: RGBA, filled: boolean, mirrorX = false
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
  drawLinePixels(buf, w, h, left, top, right, top, size, c, mirrorX);
  drawLinePixels(buf, w, h, left, bottom, right, bottom, size, c, mirrorX);
  drawLinePixels(buf, w, h, left, top, left, bottom, size, c, mirrorX);
  drawLinePixels(buf, w, h, right, top, right, bottom, size, c, mirrorX);
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
