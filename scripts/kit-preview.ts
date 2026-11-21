// Dev tool: render the character kit presets to PNGs for visual review.
// Usage: bun scripts/kit-preview.ts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng, DEFAULT_PALETTE } from '@pixelforge/core'
import {
  KIT_CANVAS,
  KIT_DEFAULT_SELECTION,
  KIT_HEADS,
  KIT_ITEMS,
  KIT_OUTFITS,
  KIT_PRESETS,
  composeKitBuffers,
  composeKitPreviewRgba,
  kitSelectionFromPreset,
} from '../packages/core/src/character/kit'

// Forge-16 default palette comes from the app; re-declare here to keep the kit module pure.
const PALETTE = DEFAULT_PALETTE

function checkGrid(name: string, grid: string[]): void {
  if (grid.length !== KIT_CANVAS) throw new Error(`${name}: ${grid.length} rows (want ${KIT_CANVAS})`)
  grid.forEach((row, y) => {
    if (row.length !== KIT_CANVAS) throw new Error(`${name} row ${y}: ${row.length} chars (want ${KIT_CANVAS}): "${row}"`)
    for (const ch of row) {
      if (ch !== '.' && !'OSsEMmdrRPYBbgGLCAW'.includes(ch)) throw new Error(`${name} row ${y}: unknown char "${ch}"`)
    }
  })
}

function scaleRgba(rgba: Uint8ClampedArray, w: number, h: number, factor: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * factor * h * factor * 4)
  for (let y = 0; y < h * factor; y++) {
    for (let x = 0; x < w * factor; x++) {
      const s = ((Math.floor(y / factor) * w) + Math.floor(x / factor)) * 4
      const d = (y * w * factor + x) * 4
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3]
    }
  }
  return out
}

function checkerRgba(rgba: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (out[i + 3] === 0) {
        const v = ((x >> 3) + (y >> 3)) % 2 === 0 ? 40 : 28
        out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255
      }
    }
  }
  return out
}

const outDir = process.argv[2] ?? 'artifacts/kit-preview'
mkdirSync(outDir, { recursive: true })

for (const [kind, list] of [['head', KIT_HEADS], ['outfit', KIT_OUTFITS], ['item', KIT_ITEMS]] as const) {
  for (const part of list) checkGrid(`${kind}:${part.id}`, part.grid)
}
console.log('grid shapes OK')

// per-preset composites at 8×
for (const preset of KIT_PRESETS) {
  const sel = kitSelectionFromPreset(preset.id)
  if (!sel) throw new Error(`preset ${preset.id} missing`)
  const rgba = composeKitPreviewRgba(sel, PALETTE)
  const png = await encodePng(KIT_CANVAS * 8, KIT_CANVAS * 8, scaleRgba(checkerRgba(rgba, KIT_CANVAS, KIT_CANVAS), KIT_CANVAS, KIT_CANVAS, 8))
  writeFileSync(join(outDir, `${preset.id}-8x.png`), png)
  console.log(`wrote ${outDir}/${preset.id}-8x.png`)
}

// layer sheets for the default selection at 4× (per-layer review)
{
  const buffers = composeKitBuffers(KIT_DEFAULT_SELECTION, PALETTE)
  const names = ['body', 'outfit', 'head', 'item'] as const
  const sheetW = KIT_CANVAS * 4 * 4 + 30
  const sheet = new Uint8ClampedArray(sheetW * (KIT_CANVAS * 4 + 10) * 4)
  names.forEach((n, i) => {
    const scaled = scaleRgba(checkerRgba(buffers[n], KIT_CANVAS, KIT_CANVAS), KIT_CANVAS, KIT_CANVAS, 4)
    const ox = i * (KIT_CANVAS * 4 + 10) + 5
    for (let y = 0; y < KIT_CANVAS * 4; y++) {
      for (let x = 0; x < KIT_CANVAS * 4; x++) {
        const s = (y * KIT_CANVAS * 4 + x) * 4
        const d = (y * sheetW + ox + x) * 4
        sheet[d] = scaled[s]; sheet[d + 1] = scaled[s + 1]; sheet[d + 2] = scaled[s + 2]; sheet[d + 3] = scaled[s + 3]
      }
    }
  })
  writeFileSync(join(outDir, 'layers-4x.png'), await encodePng(sheetW, KIT_CANVAS * 4 + 10, sheet))
  console.log(`wrote ${outDir}/layers-4x.png`)
}
