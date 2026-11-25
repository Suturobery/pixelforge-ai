import { expect, test } from 'bun:test'
import { createProject, measureStyleAnchor } from '@pixelforge/core'
import { reviewAssetSet } from '@/lib/pixelforge/asset-set-review'

function block(buffer: Uint8ClampedArray, width: number, x0: number, y0: number, w: number, h: number, color: [number, number, number]) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * width + x) * 4
    buffer.set([...color, 255], i)
  }
}

test('asset set checks palette for every clip and actor proportions only when selected', () => {
  const project = createProject({ width: 16, height: 16 })
  project.palette = ['#000000', '#ffffff']
  const hero = project.clips[0]!
  const layer = hero.layers[0]!
  const heroBuffer = new Uint8ClampedArray(16 * 16 * 4)
  block(heroBuffer, 16, 2, 2, 4, 4, [0, 0, 0])
  hero.frames[0]!.cels[layer.id] = { buffer: heroBuffer, linked: false }
  const anchor = measureStyleAnchor(heroBuffer, 16, 16, { label: 'Hero', clipId: hero.id, frameIndex: 0 })!
  project.settings.styleProfile = { ...project.settings.styleProfile!, anchor }

  const enemyBuffer = new Uint8ClampedArray(16 * 16 * 4)
  block(enemyBuffer, 16, 2, 2, 4, 9, [0, 0, 0])
  block(enemyBuffer, 16, 3, 3, 1, 1, [255, 0, 0])
  const enemy = {
    ...hero,
    id: 'enemy-clip',
    name: 'Enemy',
    frames: [{ ...hero.frames[0]!, id: 'enemy-frame', cels: { [layer.id]: { buffer: enemyBuffer, linked: false } } }],
  }
  project.clips.push(enemy)

  const general = reviewAssetSet(project, [])
  expect(general[1]?.issues).toContain('1 color outside project palette')
  expect(general[1]?.issues.some((issue) => issue.startsWith('Sprite height'))).toBe(false)
  const actors = reviewAssetSet(project, [enemy.id])
  expect(actors[1]?.issues.some((issue) => issue.startsWith('Sprite height'))).toBe(true)
  expect(actors[1]?.issues.some((issue) => issue.startsWith('Ground line'))).toBe(true)
})
