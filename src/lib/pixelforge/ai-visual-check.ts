// PixelForge AI — Auto-Eyes visual & spatial self-critique for AI pixel artists.
//
// Gives MCP agents (GPT, Codex, Claude Code, Cursor, Antigravity) pixel-exact
// spatial awareness after every drawing call:
//   - Sprite bounding box, canvas margins, fill ratio
//   - 4-connected component count & tiny floating fragment coordinates
//   - Horizontal silhouette symmetry %
//   - Palette discipline (unique color count + off-palette count)
//   - Cropped color-indexed ASCII pixel grid with exact row/col coordinates
//   - Plain-English common-sense warnings so agents spot mistakes immediately

import type { InspectionScale } from '@pixelforge/core'

export interface FloatingFragment {
  x: number
  y: number
  size: number
}

export interface AsciiPixelGrid {
  originX: number
  originY: number
  legend: Record<string, string>
  rows: string[]
}

export interface VisualCheckReport {
  canvas: { width: number; height: number }
  opaquePixels: number
  fillPercent: number
  bounds: { x: number; y: number; w: number; h: number } | null
  margins: { top: number; right: number; bottom: number; left: number } | null
  connectedParts: number
  floatingFragments: FloatingFragment[]
  symmetryX: number | null
  colorCount: number
  offPaletteCount: number
  asciiGrid: AsciiPixelGrid | null
  warnings: string[]
}

const ASCII_SYMBOLS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const MAX_ASCII_DIM = 48

function rgbHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

/** Pick an integer zoom scale that brings small sprites up to ~256px for crisp LLM vision. */
export function recommendedInspectionScale(width: number, height: number): InspectionScale {
  const maxDim = Math.max(width, height)
  if (maxDim <= 32) return 8
  if (maxDim <= 64) return 4
  if (maxDim <= 128) return 2
  return 1
}

/**
 * Deterministically analyze a composited RGBA frame so an AI agent immediately
 * sees exact proportions, floating dots, edge clipping, symmetry, and pixel layout.
 */
export function buildVisualCheck(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  palette: readonly string[],
): VisualCheckReport {
  const totalPixels = Math.max(1, width * height)
  const paletteSet = new Set(palette.map((c) => c.toLowerCase()))

  let opaquePixels = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  const colorCounts = new Map<string, number>()

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      if ((rgba[idx + 3] ?? 0) === 0) continue
      opaquePixels += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      const hex = rgbHex(rgba[idx]!, rgba[idx + 1]!, rgba[idx + 2]!)
      colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1)
    }
  }

  if (opaquePixels === 0) {
    return {
      canvas: { width, height },
      opaquePixels: 0,
      fillPercent: 0,
      bounds: null,
      margins: null,
      connectedParts: 0,
      floatingFragments: [],
      symmetryX: null,
      colorCount: 0,
      offPaletteCount: 0,
      asciiGrid: null,
      warnings: ['Frame is completely empty (0 opaque pixels).'],
    }
  }

  const bounds = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
  const margins = {
    top: minY,
    right: Math.max(0, width - 1 - maxX),
    bottom: Math.max(0, height - 1 - maxY),
    left: minX,
  }
  const fillPercent = Math.round((opaquePixels / totalPixels) * 1000) / 10

  let offPaletteCount = 0
  for (const hex of colorCounts.keys()) {
    if (!paletteSet.has(hex)) offPaletteCount += 1
  }

  // 4-connected components BFS to detect detached limbs or stray floating pixels
  const visited = new Uint8Array(width * height)
  const queue = new Int32Array(opaquePixels)
  const components: Array<{ x: number; y: number; size: number }> = []

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const start = y * width + x
      if (visited[start] || (rgba[start * 4 + 3] ?? 0) === 0) continue
      visited[start] = 1
      let head = 0
      let tail = 0
      queue[tail++] = start
      while (head < tail) {
        const cur = queue[head++]!
        const cx = cur % width
        const cy = (cur - cx) / width
        if (cx > 0) {
          const n = cur - 1
          if (!visited[n] && (rgba[n * 4 + 3] ?? 0) > 0) {
            visited[n] = 1
            queue[tail++] = n
          }
        }
        if (cx + 1 < width) {
          const n = cur + 1
          if (!visited[n] && (rgba[n * 4 + 3] ?? 0) > 0) {
            visited[n] = 1
            queue[tail++] = n
          }
        }
        if (cy > 0) {
          const n = cur - width
          if (!visited[n] && (rgba[n * 4 + 3] ?? 0) > 0) {
            visited[n] = 1
            queue[tail++] = n
          }
        }
        if (cy + 1 < height) {
          const n = cur + width
          if (!visited[n] && (rgba[n * 4 + 3] ?? 0) > 0) {
            visited[n] = 1
            queue[tail++] = n
          }
        }
      }
      components.push({ x, y, size: tail })
    }
  }

  const connectedParts = components.length
  const floatingFragments: FloatingFragment[] =
    connectedParts > 1
      ? components
          .filter((c) => c.size <= 3 && c.size < opaquePixels * 0.15)
          .sort((a, b) => a.size - b.size)
          .slice(0, 6)
      : []

  // Horizontal silhouette symmetry relative to the sprite's own bounding-box center
  let symMatches = 0
  let symUnion = 0
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const mx = minX + maxX - x
      const a = (rgba[(y * width + x) * 4 + 3] ?? 0) > 0
      const b = (rgba[(y * width + mx) * 4 + 3] ?? 0) > 0
      if (a || b) {
        symUnion += 1
        if (a && b) symMatches += 1
      }
    }
  }
  const symmetryX = symUnion > 0 ? Math.round((symMatches / symUnion) * 100) : null

  // Compact cropped ASCII color map so the agent has 100% pixel-exact spatial truth
  let asciiGrid: AsciiPixelGrid | null = null
  if (bounds.w <= MAX_ASCII_DIM && bounds.h <= MAX_ASCII_DIM) {
    const x0 = Math.max(0, minX - 1)
    const y0 = Math.max(0, minY - 1)
    const x1 = Math.min(width - 1, maxX + 1)
    const y1 = Math.min(height - 1, maxY + 1)

    const sortedColors = [...colorCounts.entries()].sort((a, b) => b[1] - a[1])
    const hexToSym = new Map<string, string>()
    const legend: Record<string, string> = {}
    sortedColors.forEach(([hex], i) => {
      const sym = i < ASCII_SYMBOLS.length ? ASCII_SYMBOLS[i]! : '+'
      hexToSym.set(hex, sym)
      if (sym !== '+' || !legend['+']) legend[sym] = hex
    })

    const rows: string[] = []
    for (let y = y0; y <= y1; y++) {
      let line = ''
      for (let x = x0; x <= x1; x++) {
        const idx = (y * width + x) * 4
        if ((rgba[idx + 3] ?? 0) === 0) {
          line += '.'
        } else {
          const hex = rgbHex(rgba[idx]!, rgba[idx + 1]!, rgba[idx + 2]!)
          line += hexToSym.get(hex) ?? '+'
        }
      }
      rows.push(`y${String(y).padStart(2, '0')}: ${line}`)
    }
    asciiGrid = { originX: x0, originY: y0, legend, rows }
  }

  // Actionable common-sense warnings
  const warnings: string[] = []
  if (floatingFragments.length > 0) {
    const sample = floatingFragments
      .slice(0, 3)
      .map((f) => `(${f.x},${f.y}) ${f.size}px`)
      .join(', ')
    warnings.push(
      `Found ${floatingFragments.length} tiny floating fragment(s) at ${sample} — remove stray dots or connect them cleanly.`,
    )
  }
  const majorParts = connectedParts - floatingFragments.length
  if (majorParts >= 4) {
    warnings.push(
      `Sprite has ${majorParts} separate major regions — check for unintended gaps or detached limbs/weapon.`,
    )
  }
  const touchedEdges: string[] = []
  if (margins.top === 0) touchedEdges.push('top')
  if (margins.right === 0) touchedEdges.push('right')
  if (margins.bottom === 0) touchedEdges.push('bottom')
  if (margins.left === 0) touchedEdges.push('left')
  if (touchedEdges.length > 0) {
    warnings.push(
      `Sprite touches canvas edge (${touchedEdges.join(', ')}) — leave 1–2px padding unless intentionally full-bleed.`,
    )
  }
  if (opaquePixels >= 40 && colorCounts.size <= 2) {
    warnings.push(
      `Only ${colorCounts.size} color(s) used across ${opaquePixels}px — add shadow and highlight ramp tones from the palette.`,
    )
  }
  if (offPaletteCount > 0) {
    warnings.push(
      `${offPaletteCount} color(s) are outside the project palette — keep all pixels inside the palette.`,
    )
  }
  if (fillPercent < 3 && opaquePixels < 24) {
    warnings.push(
      `Sprite covers only ${fillPercent}% of the canvas (${opaquePixels}px) — check if scale/proportions are too tiny.`,
    )
  }

  return {
    canvas: { width, height },
    opaquePixels,
    fillPercent,
    bounds,
    margins,
    connectedParts,
    floatingFragments,
    symmetryX,
    colorCount: colorCounts.size,
    offPaletteCount,
    asciiGrid,
    warnings,
  }
}
