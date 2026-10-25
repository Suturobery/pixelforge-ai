import type { Offset, PixelGrid, Rect, Rig, SpritePart } from './types'
import { cloneGrid, idx, isOpaque, setPixel } from './sprite'

export interface ComposeResult {
  grid: PixelGrid
  /** part pixels dropped because their destination is outside the canvas */
  oobPixels: number
  /** part pixels stamped on top of static (non-rig) opaque pixels */
  staticCovered: number
}

function offsetFor(offsets: Record<string, Offset>, part: SpritePart): Offset {
  return offsets[part.id] ?? offsets[part.role] ?? { x: 0, y: 0 }
}

/**
 * Compose one animation frame from the base sprite using per-part translations.
 *
 * Deterministic (R3). Static pixels outside every part rect are preserved (R4).
 * All part rects are cleared first, then parts are stamped back in z-order (R2)
 * with their translation applied. Pixels pushed out of the canvas are dropped
 * and counted (R5).
 */
export function composeFrame(
  base: PixelGrid,
  rig: Rig,
  offsets: Record<string, Offset>
): ComposeResult {
  const out = cloneGrid(base)
  const { width, height } = base

  // Static-pixel mask: opaque pixels not owned by any part rect (R4).
  const staticMask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isOpaque(base, x, y)) staticMask[y * width + x] = 1
    }
  }
  for (const part of rig.parts) {
    const r = part.rect
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue
        staticMask[y * width + x] = 0
      }
    }
  }

  // 1. Clear every part rect.
  for (const part of rig.parts) {
    const r = part.rect
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue
        out.data[idx(out, x, y)] = 0
        out.data[idx(out, x, y) + 1] = 0
        out.data[idx(out, x, y) + 2] = 0
        out.data[idx(out, x, y) + 3] = 0
      }
    }
  }

  // 2. Stamp parts in z-order with translation applied.
  const sorted = [...rig.parts].sort((a, b) => a.zOrder - b.zOrder)
  let oob = 0
  let staticCovered = 0
  for (const part of sorted) {
    const off = offsetFor(offsets, part)
    const r: Rect = part.rect
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const sx = r.x + x
        const sy = r.y + y
        if (!isOpaque(base, sx, sy)) continue
        const dx = sx + off.x
        const dy = sy + off.y
        if (dx < 0 || dy < 0 || dx >= width || dy >= height) {
          oob++
          continue
        }
        if (staticMask[dy * width + dx]) staticCovered++
        const i = idx(base, sx, sy)
        setPixel(out, dx, dy, {
          r: base.data[i],
          g: base.data[i + 1],
          b: base.data[i + 2],
          a: base.data[i + 3],
        })
      }
    }
  }

  return { grid: out, oobPixels: oob, staticCovered }
}

/** Convenience: pixels owned by moving parts, for connectivity QA. */
export function movingPartMask(base: PixelGrid, rig: Rig): Uint8Array {
  const mask = new Uint8Array(base.width * base.height)
  for (const part of rig.parts) {
    const r = part.rect
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x < 0 || y < 0 || x >= base.width || y >= base.height) continue
        mask[y * base.width + x] = 1
      }
    }
  }
  return mask
}
