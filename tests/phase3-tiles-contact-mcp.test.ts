import { beforeEach, describe, expect, it } from 'bun:test'
import { composeFrameRgba, createProject, decodePng } from '@pixelforge/core'
import { executeMcpTool } from '../src/lib/pixelforge/mcp-tools'
import { useEditor } from '../src/lib/pixelforge/store'

const L1_CTX = {
  clientId: 'test-client',
  clientName: 'Test IDE',
  tier: 'L1' as const,
}

describe('Phase 3 MCP + Store integration (Tileset Stamp Picker & Clips Contact Sheet)', () => {
  beforeEach(() => {
    const project = createProject({
      name: 'phase3-test',
      width: 32,
      height: 16,
      palette: ['#1a1c2c', '#38b764', '#41a6f6', '#ffcd75'],
    })
    useEditor.getState().newProject(project)
  })

  it('stamp_tiles slices source tileset, applies 90deg rotation, stamps onto target cell, and undoes cleanly', async () => {
    // Draw a marker pixel at (1, 0) inside tile 0 (0..15, 0..15)
    const draw = await executeMcpTool(
      'set_pixels',
      { pixels: [{ x: 1, y: 0 }], color: '#38b764' },
      L1_CTX,
    )
    expect(draw.ok).toBe(true)

    // Stamp tile 0 rotated 90° CW into destination column 1 (x: 16..31, y: 0..15)
    const stamp = await executeMcpTool(
      'stamp_tiles',
      {
        tileSize: 16,
        stamps: [{ tileIndex: 0, destCol: 1, destRow: 0, rotation: 90, flipH: false }],
      },
      L1_CTX,
    )
    expect(stamp.ok).toBe(true)
    const data = stamp.data as { stampedCount: number; tileSize: number }
    expect(data.stampedCount).toBe(1)
    expect(data.tileSize).toBe(16)

    // In 16×16 tile, (1, 0) rotated 90° CW lands at local (15, 1) -> canvas (31, 1)!
    const proj = useEditor.getState().project
    const composed = composeFrameRgba(proj, proj.clips[0]!, proj.clips[0]!.frames[0]!)
    const idx = (1 * 32 + 31) * 4
    expect(composed[idx]).toBe(0x38)
    expect(composed[idx + 1]).toBe(0xb7)
    expect(composed[idx + 2]).toBe(0x64)
    expect(composed[idx + 3]).toBe(255)

    // Single undo clears the stamped tile cleanly
    useEditor.getState().undo()
    const afterUndo = composeFrameRgba(
      useEditor.getState().project,
      useEditor.getState().project.clips[0]!,
      useEditor.getState().project.clips[0]!.frames[0]!,
    )
    expect(afterUndo[idx + 3]).toBe(0)
  })

  it('get_contact_sheet renders a valid decodable PNG with metrics for every clip', async () => {
    useEditor.getState().addClip('run')
    const res = await executeMcpTool(
      'get_contact_sheet',
      { scale: 2, showGroundLine: true, showBounds: true, background: 'checker' },
      L1_CTX,
    )
    expect(res.ok).toBe(true)
    const data = res.data as {
      png: string
      width: number
      height: number
      clips: Array<{ clipName: string }>
    }
    expect(data.clips.length).toBe(2)
    expect(data.png.startsWith('data:image/png;base64,')).toBe(true)

    const raw = Buffer.from(data.png.slice('data:image/png;base64,'.length), 'base64')
    const decoded = await decodePng(new Uint8Array(raw))
    expect(decoded.width).toBe(data.width)
    expect(decoded.height).toBe(data.height)
  })
})
