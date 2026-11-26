import { beforeEach, describe, expect, it } from 'bun:test'
import { composeFrameRgba, createProject } from '@pixelforge/core'
import { executeMcpTool } from '../src/lib/pixelforge/mcp-tools'
import { useEditor } from '../src/lib/pixelforge/store'

const L1_CTX = {
  clientId: 'test-client',
  clientName: 'Test IDE',
  tier: 'L1' as const,
}

describe('Phase 1 & 2 MCP + Store integration (Hue Shifter & Live Modifiers)', () => {
  beforeEach(() => {
    const project = createProject({ name: 'phase12-test', width: 16, height: 16, palette: ['#1a1c2c', '#38b764'] })
    useEditor.getState().newProject(project)
  })

  it('generate_hue_ramp generates a cool/warm ramp and adds new colors to palette in 1 undoable step', async () => {
    const res = await executeMcpTool(
      'generate_hue_ramp',
      { baseColor: '#38b764', steps: 5, autoShift: true, addToPalette: true },
      L1_CTX,
    )
    expect(res.ok).toBe(true)
    const data = res.data as { ramp: string[]; addedCount: number; palette: string[] }
    expect(data.ramp).toHaveLength(5)
    expect(data.ramp[2]).toBe('#38b764')
    // 4 new shades added (base #38b764 was already in palette)
    expect(data.addedCount).toBe(4)
    expect(useEditor.getState().project.palette).toHaveLength(6)

    // Single undo reverts all 4 added swatches
    useEditor.getState().undo()
    expect(useEditor.getState().project.palette).toHaveLength(2)
  })

  it('set_layer_props attaches non-destructive Live FX, triggers Auto-Eyes visualCheck, and bakeLayerModifiers commits pixels', async () => {
    // Draw a single pixel at (8, 8)
    const draw = await executeMcpTool(
      'set_pixels',
      { pixels: [{ x: 8, y: 8 }], color: '#38b764' },
      L1_CTX,
    )
    expect(draw.ok).toBe(true)

    // Attach non-destructive outline via MCP
    const fx = await executeMcpTool(
      'set_layer_props',
      {
        modifiers: {
          outline: { enabled: true, mode: 'solid', color: '#1a1c2c', connectivity: 4 },
        },
      },
      L1_CTX,
    )
    expect(fx.ok).toBe(true)
    const fxData = fx.data as { visualCheck?: { opaquePixels: number }; autoPreviewPng?: string }
    // 1 center pixel + 4 live outline pixels = 5 opaque pixels in Auto-Eyes visualCheck!
    expect(fxData.visualCheck?.opaquePixels).toBe(5)
    expect(fxData.autoPreviewPng).toBeTruthy()

    // Raw cel buffer still has ONLY 1 opaque pixel (non-destructive!)
    const proj = useEditor.getState().project
    const layer = proj.clips[0]!.layers[0]!
    const rawBuf = proj.clips[0]!.frames[0]!.cels[layer.id]!.buffer
    let rawOpaque = 0
    for (let i = 3; i < rawBuf.length; i += 4) if (rawBuf[i]! > 0) rawOpaque++
    expect(rawOpaque).toBe(1)

    // Bake to pixels commits the 5 pixels into the raw cel buffer and clears modifiers
    const baked = useEditor.getState().bakeLayerModifiers(layer.id)
    expect(baked).toBe(true)
    const afterBake = useEditor.getState().project
    expect(afterBake.clips[0]!.layers[0]!.modifiers).toBeUndefined()
    const bakedBuf = afterBake.clips[0]!.frames[0]!.cels[layer.id]!.buffer
    let bakedOpaque = 0
    for (let i = 3; i < bakedBuf.length; i += 4) if (bakedBuf[i]! > 0) bakedOpaque++
    expect(bakedOpaque).toBe(5)

    // Composited output stays identical before & after bake
    const composed = composeFrameRgba(afterBake, afterBake.clips[0]!, afterBake.clips[0]!.frames[0]!)
    expect(composed[(7 * 16 + 8) * 4 + 3]).toBe(255)
  })

  it('set_vectors creates editable pixel-perfect curves with Auto-Eyes and bake_vectors commits them cleanly', async () => {
    const setRes = await executeMcpTool(
      'set_vectors',
      {
        vectors: [
          {
            id: 'blade',
            kind: 'curve',
            points: [
              { x: 2, y: 13 },
              { x: 8, y: 2 },
              { x: 14, y: 13 },
            ],
            stroke: '#38b764',
            strokeWidth: 1,
          },
        ],
      },
      L1_CTX,
    )
    expect(setRes.ok).toBe(true)
    const setData = setRes.data as { vectorCount: number; visualCheck?: { opaquePixels: number }; autoPreviewPng?: string }
    expect(setData.vectorCount).toBe(1)
    expect((setData.visualCheck?.opaquePixels ?? 0) > 10).toBe(true)
    expect(setData.autoPreviewPng).toBeTruthy()

    // Raw cel buffer is still untouched while vector stays live
    const proj = useEditor.getState().project
    const layer = proj.clips[0]!.layers[0]!
    expect(proj.clips[0]!.frames[0]!.cels[layer.id]!.buffer.every((v) => v === 0)).toBe(true)

    // Bake via MCP
    const bakeRes = await executeMcpTool('bake_vectors', {}, L1_CTX)
    expect(bakeRes.ok).toBe(true)
    const afterBake = useEditor.getState().project
    const bakedCel = afterBake.clips[0]!.frames[0]!.cels[layer.id]!
    expect(bakedCel.vectors).toBeUndefined()
    expect(bakedCel.buffer.some((v) => v > 0)).toBe(true)
  })
})
