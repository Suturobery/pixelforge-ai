/** Debug: inspect components/holes for specific frames. */
import { getFixture } from '../src/lib/pixelforge/fixtures'
import { getPresetSet, DEFAULT_PARAMS } from '../src/lib/pixelforge/presets'
import { composeFrame } from '../src/lib/pixelforge/composer'
import { opaqueComponents, countEnclosedTransparent, isOpaque } from '../src/lib/pixelforge/sprite'
import type { PixelGrid } from '../src/lib/pixelforge/types'

const { grid, rig } = getFixture('simple')
const set = getPresetSet('v1')
const attack = set.attack
const plans = attack.buildFrames(rig, { ...DEFAULT_PARAMS })

function destMask(base: PixelGrid, rig: import('../src/lib/pixelforge/types').Rig, offsets: Record<string, { x: number; y: number }>): Uint8Array {
  const mask = new Uint8Array(base.width * base.height)
  for (const part of rig.parts) {
    const o = offsets[part.id] ?? offsets[part.role] ?? { x: 0, y: 0 }
    for (let y = 0; y < part.rect.h; y++)
      for (let x = 0; x < part.rect.w; x++) {
        const sx = part.rect.x + x
        const sy = part.rect.y + y
        if (!isOpaque(base, sx, sy)) continue
        const dx = sx + o.x
        const dy = sy + o.y
        if (dx < 0 || dy < 0 || dx >= base.width || dy >= base.height) continue
        mask[dy * base.width + dx] = 1
      }
  }
  return mask
}

console.log('base holes:', countEnclosedTransparent(grid))
plans.forEach((plan, i) => {
  const { grid: f } = composeFrame(grid, rig, plan.offsets)
  const mask = destMask(grid, rig, plan.offsets)
  const comps = opaqueComponents(f, mask)
  console.log(`attack f${i} offsets=`, JSON.stringify(plan.offsets), 'components:', comps, 'holes:', countEnclosedTransparent(f))
})

// Where are base enclosed holes?
const w = grid.width
for (let y = 0; y < grid.height; y++) {
  for (let x = 0; x < w; x++) {
    // crude: print row map of a region
  }
}
// print crotch region
for (let y = 18; y <= 28; y++) {
  let row = ''
  for (let x = 9; x <= 22; x++) row += isOpaque(grid, x, y) ? '#' : '.'
  console.log(`y${y}: ${row}`)
}
