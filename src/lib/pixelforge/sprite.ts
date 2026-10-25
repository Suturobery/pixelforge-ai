import type { PixelGrid, RGBA, Rect } from './types'

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 }

export function createGrid(width: number, height: number): PixelGrid {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

export function cloneGrid(grid: PixelGrid): PixelGrid {
  return { width: grid.width, height: grid.height, data: new Uint8ClampedArray(grid.data) }
}

export function idx(grid: PixelGrid, x: number, y: number): number {
  return (y * grid.width + x) * 4
}

export function inBounds(grid: PixelGrid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height
}

export function getPixel(grid: PixelGrid, x: number, y: number): RGBA {
  if (!inBounds(grid, x, y)) return { ...TRANSPARENT }
  const i = idx(grid, x, y)
  return { r: grid.data[i], g: grid.data[i + 1], b: grid.data[i + 2], a: grid.data[i + 3] }
}

export function setPixel(grid: PixelGrid, x: number, y: number, c: RGBA): void {
  if (!inBounds(grid, x, y)) return
  const i = idx(grid, x, y)
  grid.data[i] = c.r
  grid.data[i + 1] = c.g
  grid.data[i + 2] = c.b
  grid.data[i + 3] = c.a
}

export function isOpaque(grid: PixelGrid, x: number, y: number): boolean {
  if (!inBounds(grid, x, y)) return false
  return grid.data[idx(grid, x, y) + 3] > 0
}

export function hexToRgba(hex: string, alpha = 255): RGBA {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: alpha }
}

export function rgbaToHex(c: RGBA): string {
  const to2 = (v: number) => v.toString(16).padStart(2, '0')
  return `#${to2(c.r)}${to2(c.g)}${to2(c.b)}`
}

export function fillRect(grid: PixelGrid, rect: Rect, color: RGBA): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      setPixel(grid, x, y, color)
    }
  }
}

export function gridsEqual(a: PixelGrid, b: PixelGrid): boolean {
  if (a.width !== b.width || a.height !== b.height) return false
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) return false
  }
  return true
}

/** Count pixels that differ (any channel) between two same-size grids. */
export function diffCount(a: PixelGrid, b: PixelGrid): number {
  if (a.width !== b.width || a.height !== b.height) return -1
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2] ||
      a.data[i + 3] !== b.data[i + 3]
    ) {
      n++
    }
  }
  return n
}

export function boundsOfOpaque(grid: PixelGrid): Rect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (isOpaque(grid, x, y)) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** Lowest opaque row within a rect (or whole grid when rect omitted). */
export function lowestOpaqueRow(grid: PixelGrid, rect?: Rect): number | null {
  const x0 = rect ? rect.x : 0
  const x1 = rect ? rect.x + rect.w - 1 : grid.width - 1
  const y0 = rect ? rect.y : 0
  const y1 = rect ? rect.y + rect.h - 1 : grid.height - 1
  for (let y = y1; y >= y0; y--) {
    for (let x = x0; x <= x1; x++) {
      if (isOpaque(grid, x, y)) return y
    }
  }
  return null
}

/** 4-connected components over opaque pixels. Returns component sizes desc. */
export function opaqueComponents(grid: PixelGrid, mask?: Uint8Array): number[] {
  const total = grid.width * grid.height
  const visited = new Uint8Array(total)
  const sizes: number[] = []
  const stack: number[] = []
  for (let start = 0; start < total; start++) {
    if (visited[start]) continue
    const x = start % grid.width
    const y = (start - x) / grid.width
    if (!isOpaque(grid, x, y)) continue
    if (mask && !mask[start]) continue
    let size = 0
    stack.push(start)
    visited[start] = 1
    while (stack.length > 0) {
      const cur = stack.pop() as number
      size++
      const cx = cur % grid.width
      const cy = (cur - cx) / grid.width
      const neighbors = [
        [cx - 1, cy],
        [cx + 1, cy],
        [cx, cy - 1],
        [cx, cy + 1],
      ]
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue
        const ni = ny * grid.width + nx
        if (visited[ni]) continue
        if (!isOpaque(grid, nx, ny)) continue
        if (mask && !mask[ni]) continue
        visited[ni] = 1
        stack.push(ni)
      }
    }
    sizes.push(size)
  }
  return sizes.sort((a, b) => b - a)
}

/**
 * Fully-enclosed transparent pixels (holes): flood transparent pixels from the
 * canvas border; unreached transparent pixels are enclosed.
 */
export function countEnclosedTransparent(grid: PixelGrid): number {
  const total = grid.width * grid.height
  const reached = new Uint8Array(total)
  const stack: number[] = []
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return
    const i = y * grid.width + x
    if (reached[i]) return
    if (isOpaque(grid, x, y)) return
    reached[i] = 1
    stack.push(i)
  }
  for (let x = 0; x < grid.width; x++) {
    push(x, 0)
    push(x, grid.height - 1)
  }
  for (let y = 0; y < grid.height; y++) {
    push(0, y)
    push(grid.width - 1, y)
  }
  while (stack.length > 0) {
    const cur = stack.pop() as number
    const x = cur % grid.width
    const y = (cur - x) / grid.width
    push(x - 1, y)
    push(x + 1, y)
    push(x, y - 1)
    push(x, y + 1)
  }
  let holes = 0
  for (let i = 0; i < total; i++) {
    if (reached[i]) continue
    const x = i % grid.width
    const y = (i - x) / grid.width
    if (!isOpaque(grid, x, y)) holes++
  }
  return holes
}

/** Union mask of all part rects (source space). */
export function partMask(grid: PixelGrid, rects: Rect[]): Uint8Array {
  const mask = new Uint8Array(grid.width * grid.height)
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (inBounds(grid, x, y)) mask[y * grid.width + x] = 1
      }
    }
  }
  return mask
}

/** Scale a grid by an integer factor using nearest neighbor. */
export function scaleNearest(grid: PixelGrid, factor: number): PixelGrid {
  const out = createGrid(grid.width * factor, grid.height * factor)
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const sx = Math.floor(x / factor)
      const sy = Math.floor(y / factor)
      const c = getPixel(grid, sx, sy)
      setPixel(out, x, y, c)
    }
  }
  return out
}
