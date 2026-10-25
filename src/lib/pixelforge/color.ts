// PixelForge AI — color utilities (hex conversion, quantization, background removal)

export type RGBA = [number, number, number, number]

/** Parse #rgb, #rgba, #rrggbb or #rrggbbaa into RGBA (alpha 0-255). */
export function hexToRgba(hex: string): RGBA {
  let h = hex.replace('#', '').trim()
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (h.length !== 6 && h.length !== 8) return [0, 0, 0, 255]
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) {
    return [0, 0, 0, 255]
  }
  return [r, g, b, a]
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

export function rgbaToHex8(r: number, g: number, b: number, a: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}${c(a)}`
}

// ---------------------------------------------------------------------------
// HSV space — used by the color picker (SV square + hue slider)
// ---------------------------------------------------------------------------

export interface HSV {
  /** hue, 0–360 */
  h: number
  /** saturation, 0–1 */
  s: number
  /** value (brightness), 0–1 */
  v: number
}

export function hexToHsv(hex: string): HSV {
  const [r, g, b] = hexToRgba(hex)
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s
  const hh = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hh < 1) [r, g, b] = [c, x, 0]
  else if (hh < 2) [r, g, b] = [x, c, 0]
  else if (hh < 3) [r, g, b] = [0, c, x]
  else if (hh < 4) [r, g, b] = [0, x, c]
  else if (hh < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = v - c
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255)
}

// ---------------------------------------------------------------------------
// Color quantization — median-cut over opaque pixels, in place.
// ---------------------------------------------------------------------------

interface QuantColor {
  key: number
  r: number
  g: number
  b: number
  count: number
}

function boxRange(box: QuantColor[]): [number, number, number] {
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0
  for (const p of box) {
    if (p.r < rmin) rmin = p.r
    if (p.r > rmax) rmax = p.r
    if (p.g < gmin) gmin = p.g
    if (p.g > gmax) gmax = p.g
    if (p.b < bmin) bmin = p.b
    if (p.b > bmax) bmax = p.b
  }
  return [rmax - rmin, gmax - gmin, bmax - bmin]
}

export function quantizeBuffer(buf: Uint8ClampedArray, maxColors: number): void {
  const n = buf.length / 4
  const counts = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    if (buf[i * 4 + 3] === 0) continue
    const k = (buf[i * 4] << 16) | (buf[i * 4 + 1] << 8) | buf[i * 4 + 2]
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  if (counts.size <= maxColors) return

  const cols: QuantColor[] = [...counts.entries()].map(([key, count]) => ({
    key,
    r: (key >> 16) & 255,
    g: (key >> 8) & 255,
    b: key & 255,
    count,
  }))

  let boxes: QuantColor[][] = [cols]
  while (boxes.length < maxColors) {
    let bestIdx = -1
    let bestScore = -1
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      if (box.length < 2) continue
      const ranges = boxRange(box)
      const spread = Math.max(ranges[0], ranges[1], ranges[2])
      const weight = box.reduce((s, p) => s + p.count, 0)
      const score = spread * weight
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }
    if (bestIdx < 0) break
    const box = boxes[bestIdx]
    const ranges = boxRange(box)
    const channel = ranges.indexOf(Math.max(ranges[0], ranges[1], ranges[2]))
    box.sort((a, b) =>
      channel === 0 ? a.r - b.r : channel === 1 ? a.g - b.g : a.b - b.b
    )
    const total = box.reduce((s, p) => s + p.count, 0)
    let acc = 0
    let cut = 0
    for (let i = 0; i < box.length; i++) {
      acc += box[i].count
      if (acc >= total / 2) {
        cut = i + 1
        break
      }
    }
    if (cut <= 0 || cut >= box.length) cut = Math.floor(box.length / 2)
    boxes.splice(bestIdx, 1, box.slice(0, cut), box.slice(cut))
  }

  const palette: number[][] = boxes.map((box) => {
    let r = 0, g = 0, b = 0, c = 0
    for (const p of box) {
      r += p.r * p.count
      g += p.g * p.count
      b += p.b * p.count
      c += p.count
    }
    return [Math.round(r / c), Math.round(g / c), Math.round(b / c)]
  })

  const cache = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    if (buf[i * 4 + 3] === 0) continue
    const k = (buf[i * 4] << 16) | (buf[i * 4 + 1] << 8) | buf[i * 4 + 2]
    let p = cache.get(k)
    if (!p) {
      let best = 0
      let bestDist = Infinity
      for (let j = 0; j < palette.length; j++) {
        const [pr, pg, pb] = palette[j]
        const dr = pr - buf[i * 4]
        const dg = pg - buf[i * 4 + 1]
        const db = pb - buf[i * 4 + 2]
        const d = dr * dr + dg * dg + db * db
        if (d < bestDist) {
          bestDist = d
          best = j
        }
      }
      p = palette[best]
      cache.set(k, p)
    }
    buf[i * 4] = p[0]
    buf[i * 4 + 1] = p[1]
    buf[i * 4 + 2] = p[2]
  }
}

// ---------------------------------------------------------------------------
// Background removal — flood from the image edges, clearing pixels similar to
// the sampled corner color. Interior same-colored pixels survive.
// ---------------------------------------------------------------------------

export function removeBackground(buf: Uint8ClampedArray, w: number, h: number, tolerance = 48): number {
  const sample = (x: number, y: number): number[] => {
    const i = (y * w + x) * 4
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
  // Average small corner patches for a stable base color
  const corners: number[][] = []
  for (const [cx, cy] of [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2]] as const) {
    let r = 0, g = 0, b = 0, c = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = Math.min(w - 1, Math.max(0, cx + dx))
        const y = Math.min(h - 1, Math.max(0, cy + dy))
        const [sr, sg, sb] = sample(x, y)
        r += sr; g += sg; b += sb; c++
      }
    }
    corners.push([r / c, g / c, b / c])
  }
  const base = [0, 1, 2].map((ch) => corners.reduce((s, c) => s + c[ch], 0) / corners.length)

  const tol2 = tolerance * tolerance
  const isBg = (i: number): boolean => {
    const dr = buf[i] - base[0]
    const dg = buf[i + 1] - base[1]
    const db = buf[i + 2] - base[2]
    return dr * dr + dg * dg + db * db <= tol2
  }

  const visited = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (x: number, y: number) => {
    const p = y * w + x
    if (visited[p]) return
    visited[p] = 1
    if (isBg(p * 4)) stack.push(p)
  }
  for (let x = 0; x < w; x++) {
    push(x, 0)
    push(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    push(0, y)
    push(w - 1, y)
  }

  let cleared = 0
  while (stack.length > 0) {
    const p = stack.pop() as number
    const i = p * 4
    buf[i + 3] = 0
    cleared++
    const x = p % w
    const y = (p / w) | 0
    if (x > 0) push(x - 1, y)
    if (x < w - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < h - 1) push(x, y + 1)
  }
  return cleared
}
