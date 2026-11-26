import { describe, expect, test } from 'bun:test'
import { createProject, getSkinPreset } from '@pixelforge/core'
import { materializeSkinVariants } from '@/lib/pixelforge/skin-variants'
import { executeMcpTool } from '@/lib/pixelforge/mcp-tools'
import { getBus, useEditor } from '@/lib/pixelforge/store'

const ctx = { clientId: 'codex-1', clientName: 'Codex', tier: 'L1' as const }

function px(buf: Uint8ClampedArray, w: number, x: number, y: number): number[] {
  const i = (y * w + x) * 4
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!, buf[i + 3]!]
}

describe('Skin variants materialize onto the CommandBus', () => {
  test('clones a multi-layer, multi-frame, non-default-loop clip with timing, blend and lock intact', () => {
    useEditor.getState().newProject(createProject({ name: 'SkinMat', width: 16, height: 16 }))
    const bus = getBus()
    const srcId = bus.getProject().clips[0]!.id
    bus.execute('frame.add', { clipId: srcId }, 'mcp')
    bus.execute('clip.setProps', { clipId: srcId, patch: { loop: false, loopMode: 'pingpong', fps: 12 } }, 'mcp')
    bus.execute('layer.add', { clipId: srcId, name: 'Glow' }, 'mcp')

    let src = bus.getProject().clips[0]!
    bus.execute('layer.setProps', { clipId: srcId, layerId: src.layers[1]!.id, patch: { blend: 'screen', opacity: 0.5 } }, 'mcp')
    bus.execute('frame.setDuration', { clipId: srcId, frameId: src.frames[1]!.id, durationMs: 240 }, 'mcp')

    src = bus.getProject().clips[0]!
    for (const [fi, hex] of [[0, '#3b82f6'], [1, '#22c55e']] as const) {
      const rgb = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255]
      const buf = new Uint8ClampedArray(16 * 16 * 4)
      for (let y = 4; y < 9; y++) for (let x = 4; x < 9; x++) buf.set(rgb, (y * 16 + x) * 4)
      bus.execute(
        'pixels.applyOp',
        { clipId: srcId, frameId: src.frames[fi]!.id, layerId: src.layers[0]!.id, ops: [{ op: 'setBuffer', buffer: buf }] },
        'mcp',
      )
    }
    bus.execute('layer.setProps', { clipId: srcId, layerId: src.layers[1]!.id, patch: { locked: true } }, 'mcp')

    const fire = getSkinPreset('fire')!
    const created = materializeSkinVariants(
      bus,
      bus.getProject().clips[0]!,
      [{ name: 'hero_fire', palette: fire.palette }],
      'mcp',
    )

    expect(created.length).toBe(1)
    const clips = bus.getProject().clips
    expect(clips.length).toBe(2)
    const skin = clips[1]!
    const orig = clips[0]!

    expect(skin.name).toBe('hero_fire')
    expect(skin.fps).toBe(orig.fps)
    expect(skin.loop).toBe(false)
    expect(skin.loopMode).toBe('pingpong')
    expect(skin.frames.length).toBe(2)
    expect(skin.frames[1]!.durationMs).toBe(240)
    expect(skin.layers.length).toBe(2)
    expect(skin.layers[1]!.name).toBe('Glow')
    expect(skin.layers[1]!.blend).toBe('screen')
    expect(skin.layers[1]!.opacity).toBe(0.5)
    expect(skin.layers[1]!.locked).toBe(true)

    // remapped pixels are inside the fire palette; the original clip is untouched
    const fireRgb = new Set(fire.palette.map((h) => [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16)).join(',')))
    const skinPx = px(skin.frames[0]!.cels[skin.layers[0]!.id]!.buffer, 16, 6, 6)
    expect(skinPx[3]).toBe(255)
    expect(fireRgb.has(skinPx.slice(0, 3).join(','))).toBe(true)
    expect(px(orig.frames[0]!.cels[orig.layers[0]!.id]!.buffer, 16, 6, 6)).toEqual([59, 130, 246, 255])

    // one undo removes the whole variant atomically
    useEditor.getState().undo()
    expect(bus.getProject().clips.length).toBe(1)
  })

  test('create_skin_variants MCP tool generates every requested preset', async () => {
    useEditor.getState().newProject(createProject({ name: 'SkinMcp', width: 16, height: 16 }))
    await executeMcpTool('fill_rect', { from: { x: 3, y: 3 }, to: { x: 8, y: 8 }, color: '#3b82f6', filled: true }, ctx)
    const res = await executeMcpTool('create_skin_variants', { presets: ['fire', 'ice', 'gold'] }, ctx)
    expect(res.ok).toBe(true)
    const names = getBus().getProject().clips.map((c) => c.name)
    expect(names.length).toBe(4)
    expect(names).toEqual(expect.arrayContaining([expect.stringMatching(/_fire$/), expect.stringMatching(/_ice$/), expect.stringMatching(/_gold$/)]))
  })
})
