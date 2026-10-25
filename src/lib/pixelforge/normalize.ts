/**
 * PixelForge AI — Normalize pipeline v2.1.
 *
 * Converts a high-resolution AI image (typically 1024×1024) into a crisp,
 * animation-ready PixelGrid:
 *
 *   1. Background keying  — detect the dominant border color and key it out
 *                           (AI output is requested on a plain background).
 *   2. Alpha-weighted box downscale — 1024→N with per-cell weighted average,
 *                           keeping hard edges honest (no ghost pixels).
 *   3. Median-cut quantization — reduce to a limited palette (default 16)
 *                           for the flat retro-sprite look.
 *   4. Alpha threshold    — binary transparency at 50%; soft AI edges become
 *                           clean pixel-art holes.
 *   5. Despeckle          — drop isolated single opaque pixels surrounded by
 *                           transparency (denoise AI artifacts).
 *
 * Pure & deterministic: same ImageData + options => identical PixelGrid (R3).
 */

import type { PixelGrid, RGBA } from './types'
import { createGrid } from './sprite'

export interface NormalizeOptions {
  /** target sprite size in px (square); 16..96 */
  size: number
  /** median-cut palette size (4..32), default 16 */
  paletteSize?: number
  /** pixels with alpha below this (0-255) become transparent, default 128 */
  alphaThreshold?: number
  /** remove isolated opaque specks, default true */
  despeckle?: boolean
}

interface Cell {
  r: number
  g: number
  b: number
  n: number
}

/** Detect the flat background color from the image border (most common edge color). */
function detectBackground(img: ImageData): RGBA | null {
  const { width: w, height: h, data } = img
  const counts = new Map<number, number>()
  const sample = (x: number, y: number) => {
    const i = (y * w + x) * 4
    const a = data[i + 3]
    if (a < 250) return // already transparent — nothing to key
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (let x = 0; x < w; x += 4) { sample(x, 0); sample(x, h - 1) }
  for (let y = 0; y < h; y += 4) { sample(0, y); sample(w - 1, y) }

  let bestKey = -1
  let bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount) { bestCount = count; bestKey = key }
  }
  // Only treat as background if the border is overwhelmingly uniform
  const totalSamples = counts.size > 0 ? Array.from(counts.values()).reduce((a, b) => a + b, 0) : 0
  if (bestKey < 0 || bestCount < totalSamples * 0.6) return null
  return {
    r: (bestKey >> 16) & 255,
    g: (bestKey >> 8) & 255,
    b: bestKey & 255,
    a: 255,
  }
}

/** Color distance squared (weighted for perceptual-ish comparison). */
function dist2(a: RGBA, b: RGBA): number {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db
}

/** Median-cut quantization: build a palette from opaque samples. */
function medianCut(samples: RGBA[], paletteSize: number): RGBA[] {
  if (samples.length === 0) return []
  let buckets: RGBA[][] = [samples]
  while (buckets.length < paletteSize) {
    // pick bucket with the largest channel range
    let bi = -1
    let bestRange = -1
    let bestChannel: 'r' | 'g' | 'b' = 'r'
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]
      if (b.length < 2) continue
      let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0
      for (const p of b) {
        if (p.r < minR) minR = p.r; if (p.r > maxR) maxR = p.r
        if (p.g < minG) minG = p.g; if (p.g > maxG) maxG = p.g
        if (p.b < minB) minB = p.b; if (p.b > maxB) maxB = p.b
      }
      const rR = (maxR - minR) * 2, rG = (maxG - minG) * 4, rB = (maxB - minB) * 3
      const range = Math.max(rR, rG, rB)
      if (range > bestRange) {
        bestRange = range
        bi = i
        bestChannel = range === rR ? 'r' : range === rG ? 'g' : 'b'
      }
    }
    if (bi < 0) break
    const bucket = buckets[bi]
    bucket.sort((p, q) => p[bestChannel] - q[bestChannel])
    const mid = Math.floor(bucket.length / 2)
    buckets = [
      ...buckets.slice(0, bi),
      bucket.slice(0, mid),
      bucket.slice(mid),
      ...buckets.slice(bi + 1),
    ]
  }
  return buckets
    .filter((b) => b.length > 0)
    .map((b) => {
      let r = 0, g = 0, bl = 0
      for (const p of b) { r += p.r; g += p.g; bl += p.b }
      return { r: Math.round(r / b.length), g: Math.round(g / b.length), b: Math.round(bl / b.length), a: 255 }
    })
}

/** True if the opaque pixel at (x,y) has no opaque 4-neighbour. */
function isIsolated(grid: PixelGrid, x: number, y: number): boolean {
  const at = (px: number, py: number) => {
    if (px < 0 || py < 0 || px >= grid.width || py >= grid.height) return false
    return grid.data[(py * grid.width + px) * 4 + 3] > 0
  }
  return !at(x - 1, y) && !at(x + 1, y) && !at(x, y - 1) && !at(x, y + 1)
}

export function normalizeToGrid(img: ImageData, opts: NormalizeOptions): PixelGrid {
  const size = Math.min(96, Math.max(16, Math.round(opts.size)))
  const paletteSize = Math.min(32, Math.max(4, opts.paletteSize ?? 16))
  const alphaThreshold = opts.alphaThreshold ?? 128
  const despeckle = opts.despeckle ?? true

  const bg = detectBackground(img)
  const { width: sw, height: sh, data: sd } = img

  // 1+2: alpha-weighted box downscale with background keying
  const cells: Cell[] = new Array(size * size).fill(null).map(() => ({ r: 0, g: 0, b: 0, n: 0 }))
  const fgCounts = new Int32Array(size * size)
  for (let y = 0; y < sh; y++) {
    const cy = Math.min(size - 1, Math.floor((y * size) / sh))
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4
      const a = sd[i + 3]
      const cx = Math.min(size - 1, Math.floor((x * size) / sw))
      const ci = cy * size + cx
      // background keying: treat dominant border color as transparent
      if (a < 32) continue
      if (bg && a > 200 && dist2(
        { r: sd[i], g: sd[i + 1], b: sd[i + 2], a: 255 },
        bg
      ) < 900) {
        continue
      }
      cells[ci].r += sd[i]
      cells[ci].g += sd[i + 1]
      cells[ci].b += sd[i + 2]
      cells[ci].n += 1
      if (a > 200) fgCounts[ci] += 1
    }
  }

  // Collect opaque-enough cells as quantization samples
  const samples: RGBA[] = []
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]
    if (c.n >= 4 && fgCounts[i] > 0) {
      samples.push({ r: c.r / c.n, g: c.g / c.n, b: c.b / c.n, a: 255 })
    }
  }
  const palette = medianCut(samples, paletteSize)

  // 3+4: map to palette, apply alpha threshold
  const grid = createGrid(size, size)
  for (let cy = 0; cy < size; cy++) {
    for (let cx = 0; cx < size; cx++) {
      const ci = cy * size + cx
      const c = cells[ci]
      // Binary alpha: cell is opaque only if a meaningful foreground portion exists
      const coverage = c.n > 0 ? fgCounts[ci] / c.n : 0
      if (c.n < 4 || coverage < 0.45) continue
      const avg: RGBA = { r: c.r / c.n, g: c.g / c.n, b: c.b / c.n, a: 255 }
      let best = palette[0] ?? avg
      let bestD = Infinity
      for (const p of palette) {
        const d = dist2(avg, p)
        if (d < bestD) { bestD = d; best = p }
      }
      const gi = (cy * size + cx) * 4
      grid.data[gi] = best.r
      grid.data[gi + 1] = best.g
      grid.data[gi + 2] = best.b
      grid.data[gi + 3] = 255
    }
  }

  // 5: despeckle — clear isolated opaque pixels (two passes max)
  if (despeckle) {
    for (let pass = 0; pass < 2; pass++) {
      const toClear: Array<[number, number]> = []
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (grid.data[(y * size + x) * 4 + 3] > 0 && isIsolated(grid, x, y)) {
            toClear.push([x, y])
          }
        }
      }
      if (toClear.length === 0) break
      for (const [x, y] of toClear) {
        const gi = (y * size + x) * 4
        grid.data[gi] = 0; grid.data[gi + 1] = 0; grid.data[gi + 2] = 0; grid.data[gi + 3] = 0
      }
    }
  }

  return grid
}

/** Convert a base64 PNG (AI output) into ImageData using an offscreen canvas. */
export async function base64ToImageData(base64: string): Promise<ImageData> {
  const resp = await fetch(`data:image/png;base64,${base64}`)
  const blob = await resp.blob()
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.drawImage(bitmap, 0, 0)
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  bitmap.close()
  return imageData
}
