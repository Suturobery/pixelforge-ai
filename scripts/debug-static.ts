/** Debug: find static-covered destinations and separation on detailed fixture. */
import { getFixture } from '../src/lib/pixelforge/fixtures'
import { getPresetSet, DEFAULT_PARAMS } from '../src/lib/pixelforge/presets'
import { composeFrame } from '../src/lib/pixelforge/composer'
import { isOpaque } from '../src/lib/pixelforge/sprite'
import type { PixelGrid, Rig } from '../src/lib/pixelforge/types'

const { grid, rig } = getFixture('detailed')
const set = getPresetSet('v2')

function staticMask(base: PixelGrid, rig: Rig): Uint8Array {
  const m = new Uint8Array(base.width * base.height)
  for (let y = 0; y < base.height; y++)
    for (let x = 0; x < base.width; x++)
      if (isOpaque(base, x, y)) m[y * base.width + x] = 1
  for (const p of rig.parts)
    for (let y = p.rect.y; y < p.rect.y + p.rect.h; y++)
      for (let x = p.rect.x; x < p.rect.x + p.rect.w; x++)
        if (x >= 0 && y >= 0 && x < base.width && y < base.height) m[y * base.width + x] = 0
  return m
}

for (const presetId of ['walk', 'run', 'attack'] as const) {
  const preset = set[presetId]
  const plans = preset.buildFrames(rig, { ...DEFAULT_PARAMS })
  const sm = staticMask(grid, rig)
  plans.forEach((plan, i) => {
    const { staticCovered, oobPixels } = composeFrame(grid, rig, plan.offsets)
    if (staticCovered > 0 || oobPixels > 0) {
      // find covered destinations
      const spots: string[] = []
      for (const part of rig.parts) {
        const o = plan.offsets[part.id] ?? plan.offsets[part.role] ?? { x: 0, y: 0 }
        for (let y = 0; y < part.rect.h; y++)
          for (let x = 0; x < part.rect.w; x++) {
            const sx = part.rect.x + x
            const sy = part.rect.y + y
            if (!isOpaque(grid, sx, sy)) continue
            const dx = sx + o.x
            const dy = sy + o.y
            if (dx < 0 || dy < 0 || dx >= grid.width || dy >= grid.height) continue
            if (sm[dy * grid.width + dx]) spots.push(`${part.label}:(${sx},${sy})->(${dx},${dy})`)
          }
      }
      console.log(`${presetId} f${i} staticCovered=${staticCovered} oob=${oobPixels}`, spots.slice(0, 8))
    }
  })
}
