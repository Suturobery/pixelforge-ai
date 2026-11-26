import { describe, expect, test } from 'bun:test'
import { createProject } from '@pixelforge/core'
import { buildVisualCheck, recommendedInspectionScale } from '@/lib/pixelforge/ai-visual-check'
import { executeMcpTool } from '@/lib/pixelforge/mcp-tools'
import { resetAiActivityForTests } from '@/lib/pixelforge/ai-live-activity'
import { useEditor } from '@/lib/pixelforge/store'

describe('Auto-Eyes Visual & Spatial Self-Critique', () => {
  test('recommendedInspectionScale zooms small sprites up to crisp inspection size', () => {
    expect(recommendedInspectionScale(16, 16)).toBe(8)
    expect(recommendedInspectionScale(32, 32)).toBe(8)
    expect(recommendedInspectionScale(64, 64)).toBe(4)
    expect(recommendedInspectionScale(96, 96)).toBe(2)
    expect(recommendedInspectionScale(256, 256)).toBe(1)
  })

  test('buildVisualCheck detects bounds, floating fragments, symmetry, off-palette colors, and cropped asciiGrid', () => {
    const w = 16
    const h = 16
    const rgba = new Uint8ClampedArray(w * h * 4)
    const paint = (x: number, y: number, r: number, g: number, b: number) => {
      const i = (y * w + x) * 4
      rgba[i] = r
      rgba[i + 1] = g
      rgba[i + 2] = b
      rgba[i + 3] = 255
    }
    // Draw a symmetric 4x4 torso centered at x=6..9, y=5..8 using palette colors
    for (let y = 5; y <= 8; y++) {
      for (let x = 6; x <= 9; x++) {
        paint(x, y, 26, 28, 44) // #1a1c2c
      }
    }
    // Add two symmetric eyes inside
    paint(7, 6, 244, 244, 244) // #f4f4f4
    paint(8, 6, 244, 244, 244)
    // Add one stray disconnected floating pixel off to the side + off-palette color
    paint(2, 2, 255, 0, 255) // #ff00ff (not in palette)

    const report = buildVisualCheck(rgba, w, h, ['#1a1c2c', '#f4f4f4'])
    expect(report.opaquePixels).toBe(17)
    expect(report.bounds).toEqual({ x: 2, y: 2, w: 8, h: 7 })
    expect(report.connectedParts).toBe(2)
    expect(report.floatingFragments).toEqual([{ x: 2, y: 2, size: 1 }])
    expect(report.offPaletteCount).toBe(1)
    expect(report.asciiGrid).not.toBeNull()
    expect(report.asciiGrid!.originX).toBe(1)
    expect(report.asciiGrid!.originY).toBe(1)
    expect(report.asciiGrid!.rows.some((r) => r.startsWith('y06:'))).toBe(true)
    expect(report.warnings.some((wMsg) => wMsg.includes('floating fragment'))).toBe(true)
    expect(report.warnings.some((wMsg) => wMsg.includes('outside the project palette'))).toBe(true)
  })

  test('executeMcpTool attaches visualCheck + zoomed autoPreviewPng for external MCP agents (and skips autoPreviewPng for local console)', async () => {
    resetAiActivityForTests()
    useEditor.getState().newProject(createProject({ name: 'AutoEyesTest', width: 16, height: 16 }))

    const externalRes = await executeMcpTool(
      'fill_rect',
      { from: { x: 4, y: 4 }, to: { x: 11, y: 11 }, color: '#14b8a6', filled: true },
      { clientId: 'codex-live', clientName: 'Codex', tier: 'L1' },
    )
    expect(externalRes.ok).toBe(true)
    const extData = externalRes.data as {
      visualCheck?: { opaquePixels: number; symmetryX: number; asciiGrid: { rows: string[] } | null }
      autoPreviewPng?: string
    }
    expect(extData.visualCheck?.opaquePixels).toBe(64)
    expect(extData.visualCheck?.symmetryX).toBe(100)
    expect(extData.visualCheck?.asciiGrid?.rows.length).toBeGreaterThan(0)
    expect(extData.autoPreviewPng?.startsWith('data:image/png;base64,')).toBe(true)

    // Local in-app Agent Console keeps JSON clean (no giant base64) while still receiving visualCheck
    const consoleRes = await executeMcpTool(
      'fill_rect',
      { from: { x: 5, y: 5 }, to: { x: 10, y: 10 }, color: '#f59e0b', filled: true },
      { clientId: 'agent-console', clientName: 'agent-console', tier: 'L1' },
    )
    expect(consoleRes.ok).toBe(true)
    const consoleData = consoleRes.data as { visualCheck?: unknown; autoPreviewPng?: string }
    expect(consoleData.visualCheck).toBeDefined()
    expect(consoleData.autoPreviewPng).toBeUndefined()

    // get_frame_png also includes visualCheck alongside the PNG
    const inspect = await executeMcpTool(
      'get_frame_png',
      { scale: 8, showGrid: true },
      { clientId: 'codex-live', clientName: 'Codex', tier: 'L0' },
    )
    expect(inspect.ok).toBe(true)
    const inspectData = inspect.data as { visualCheck?: { opaquePixels: number }; png?: string }
    expect(inspectData.png?.startsWith('data:image/png;base64,')).toBe(true)
    expect(inspectData.visualCheck?.opaquePixels).toBe(64)

    resetAiActivityForTests()
  })
})
