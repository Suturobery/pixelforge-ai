import { describe, expect, test } from 'bun:test'
import { createProject } from '@pixelforge/core'
import { getBus, useEditor } from '@/lib/pixelforge/store'
import {
  alphaOverRgba,
  generateVfx,
  listVfx,
  listVfxCategories,
  previewVfxFrames,
} from '@/lib/pixelforge/vfx'

const PALETTE = ['#1a1c2c', '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4']

function resetDoc(width = 32, height = 32, paintCenter = true) {
  const proj = createProject({ name: 'vfx-test', width, height, palette: PALETTE, fps: 12 })
  if (paintCenter) {
    const layer = proj.clips[0]!.layers[0]!
    const cel = proj.clips[0]!.frames[0]!.cels[layer.id]!
    // Paint a distinctive solid pixel at (16, 16) representing the sprite
    const idx = (16 * width + 16) * 4
    cel.buffer[idx] = 56
    cel.buffer[idx + 1] = 183
    cel.buffer[idx + 2] = 100
    cel.buffer[idx + 3] = 255
  }
  useEditor.getState().loadProject(proj)
  return proj
}

describe('VFX Studio engine (pixelfx)', () => {
  test('catalog exposes 200+ effects with loop & origin metadata and categories', async () => {
    const all = await listVfx()
    expect(all.length).toBeGreaterThanOrEqual(200)
    const rune = all.find((e) => e.id === 'arcane/rune-circle')
    expect(rune).toBeDefined()
    expect(rune!.loop).toBe(true)
    expect(rune!.origin.length).toBe(2)

    const cats = await listVfxCategories()
    expect(cats.some((c) => c.id === 'arcane' && c.count > 0)).toBe(true)
    expect(cats.some((c) => c.id === 'fire' && c.count > 0)).toBe(true)
  })

  test('previewVfxFrames produces crisp binary-alpha palette-locked pixels & auto-warmup for loops', async () => {
    const seq = await previewVfxFrames(
      {
        effect: 'arcane/rune-circle',
        seed: 7,
        frames: 6,
        fps: 12,
        palette: 'project',
        crispPixelArt: true,
        alphaThreshold: 96,
        warmup: 'auto',
      },
      32,
      32,
      PALETTE,
      true,
    )

    expect(seq.resolvedEffect).toBe('arcane/rune-circle')
    expect(seq.loop).toBe(true)
    expect(seq.warmupUsed).toBe(12)
    expect(seq.paletteApplied).toBe('project')
    expect(seq.combinedFrames.length).toBe(6)
    expect(seq.backFrames.length).toBe(6)
    expect(seq.frontFrames.length).toBe(6)

    // Verify crisp binary alpha (only 0 or 255) and palette-locked RGB values!
    const allowedRgb = new Set(
      PALETTE.map((hex) => {
        const n = parseInt(hex.slice(1), 16)
        return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
      }),
    )
    let opaqueCount = 0
    for (const buf of seq.combinedFrames) {
      for (let i = 0; i < buf.length; i += 4) {
        const a = buf[i + 3]!
        expect(a === 0 || a === 255).toBe(true)
        if (a === 255) {
          opaqueCount++
          expect(allowedRgb.has(`${buf[i]},${buf[i + 1]},${buf[i + 2]}`)).toBe(true)
        }
      }
    }
    expect(opaqueCount).toBeGreaterThan(20)
  })

  test('one-shot effects default to warmupUsed = 0', async () => {
    const seq = await previewVfxFrames(
      { effect: 'explosions/small-explosion', frames: 4, fps: 12, warmup: 'auto' },
      32,
      32,
      PALETTE,
      false,
    )
    expect(seq.loop).toBe(false)
    expect(seq.warmupUsed).toBe(0)
  })

  test('generateVfx overlays split Back + Front layers onto current_clip, preserves sprite, and undoes in 1 step', async () => {
    resetDoc(32, 32, true)
    const bus = getBus()
    const beforeClip = bus.getProject().clips[0]!
    const originalSpriteLayerId = beforeClip.layers[0]!.id
    expect(beforeClip.frames.length).toBe(1)
    expect(beforeClip.layers.length).toBe(1)

    const res = await generateVfx({
      effect: 'arcane/rune-circle',
      target: 'current_clip',
      depth: 'split',
      frames: 6,
      seed: 7,
      palette: 'project',
      crispPixelArt: true,
      origin: 'ui',
    })

    expect(res.ok).toBe(true)
    expect(res.target).toBe('current_clip')
    expect(res.depth).toBe('split')
    expect(res.clipId).toBe(beforeClip.id)
    expect(res.frames).toBe(6)
    expect(res.createdLayerIds!.length).toBeGreaterThanOrEqual(1)

    const afterClip = bus.getProject().clips[0]!
    expect(afterClip.frames.length).toBe(6)
    // Back layer sits at index 0 behind the sprite; sprite sits in the middle; Front sits on top
    expect(afterClip.layers[0]!.name).toContain('(Back)')
    const spriteIdx = afterClip.layers.findIndex((l) => l.id === originalSpriteLayerId)
    expect(spriteIdx).toBeGreaterThan(0)
    if (res.createdLayerIds!.length === 2) {
      expect(afterClip.layers.at(-1)!.name).toContain('(Front)')
      expect(spriteIdx).toBeLessThan(afterClip.layers.length - 1)
    }

    // Sprite pixel at (16,16) must still be intact on EVERY duplicated frame!
    for (const frame of afterClip.frames) {
      const buf = frame.cels[originalSpriteLayerId]!.buffer
      const idx = (16 * 32 + 16) * 4
      expect(buf[idx]).toBe(56)
      expect(buf[idx + 1]).toBe(183)
      expect(buf[idx + 2]).toBe(100)
      expect(buf[idx + 3]).toBe(255)
    }

    // Single undo reverts BOTH the expanded frames and all created VFX layers!
    bus.undo()
    const undoneClip = bus.getProject().clips[0]!
    expect(undoneClip.frames.length).toBe(1)
    expect(undoneClip.layers.length).toBe(1)
    expect(undoneClip.layers[0]!.id).toBe(originalSpriteLayerId)
  })

  test('generateVfx target=new_clip remains backward-compatible and creates standalone clip', async () => {
    resetDoc(32, 32, false)
    const bus = getBus()
    expect(bus.getProject().clips.length).toBe(1)

    const res = await generateVfx({
      effect: 'campfire',
      target: 'new_clip',
      frames: 4,
      fps: 12,
      seed: 3,
      crispPixelArt: false,
    })

    expect(res.ok).toBe(true)
    expect(res.resolvedEffect).toBe('fire/campfire')
    expect(res.target).toBe('new_clip')
    expect(res.frames).toBe(4)
    expect(res.crispPixelArt).toBe(false)
    expect(bus.getProject().clips.length).toBe(2)
  })

  test('alphaOverRgba composites opaque top over bottom cleanly', () => {
    const bottom = new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 0])
    const top = new Uint8ClampedArray([200, 100, 50, 255, 0, 0, 0, 0])
    const out = alphaOverRgba(bottom, top)
    expect(Array.from(out)).toEqual([200, 100, 50, 255, 0, 0, 0, 0])
  })
})
