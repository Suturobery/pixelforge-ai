import { describe, expect, test } from 'bun:test'
import { createProject } from '@pixelforge/core'
import { executeMcpTool } from '@/lib/pixelforge/mcp-tools'
import { getBus, useEditor } from '@/lib/pixelforge/store'
import { MCP_TOOLS } from '@/lib/pixelforge/mcp-tool-catalog'

const ctx = { clientId: 'test-v040', clientName: 'v0.4.0 Test Agent', tier: 'L1' as const }

describe('v0.4.0 AI-Proof Consistency Pack (Store + MCP)', () => {
  test('store applySpriteTemplate inserts palette-locked layer + Motion parts and undoes atomically', () => {
    useEditor.getState().newProject(createProject({ name: 'Hero', width: 32, height: 32 }))
    const clipBefore = getBus().getProject().clips[0]!
    const initialLayerCount = clipBefore.layers.length

    const inserted = useEditor.getState().applySpriteTemplate('chibi-humanoid', { autoTagParts: true })
    expect(inserted).not.toBeNull()
    expect(inserted!.name).toBe('Chibi Hero')
    expect(inserted!.partsCount).toBe(6)
    expect(inserted!.craftScore).toBeGreaterThanOrEqual(50)

    const clipAfter = getBus().getProject().clips[0]!
    expect(clipAfter.layers.length).toBe(initialLayerCount + 1)
    expect(clipAfter.parts?.length).toBe(6)

    // Single undo removes both layer and tagged Motion parts atomically
    useEditor.getState().undo()
    const clipUndone = getBus().getProject().clips[0]!
    expect(clipUndone.layers.length).toBe(initialLayerCount)
    expect(clipUndone.parts?.length ?? 0).toBe(0)
  })

  test('store pinStyleAnchor + clearStyleAnchor persist Hero metrics on Style Lock', () => {
    useEditor.getState().newProject(createProject({ name: 'AnchorTest', width: 32, height: 32 }))
    // Empty frame returns null
    expect(useEditor.getState().pinStyleAnchor('Empty')).toBeNull()

    useEditor.getState().applySpriteTemplate('slime', { autoTagParts: false })
    const pinned = useEditor.getState().pinStyleAnchor('Forest Slime')
    expect(pinned).not.toBeNull()
    expect(pinned!.label).toBe('Forest Slime')
    expect(pinned!.spriteWidth).toBeGreaterThan(4)
    expect(pinned!.spriteHeight).toBeGreaterThan(4)
    expect(getBus().getProject().settings.styleProfile?.anchor?.label).toBe('Forest Slime')

    useEditor.getState().clearStyleAnchor()
    expect(getBus().getProject().settings.styleProfile?.anchor).toBeUndefined()
  })

  test('MCP list_templates, generate_template, pin_style_anchor, and get_project_state work end-to-end', async () => {
    useEditor.getState().newProject(createProject({ name: 'McpV040', width: 32, height: 32 }))

    const listed = await executeMcpTool('list_templates', {}, ctx)
    expect(listed.ok).toBe(true)
    const listData = listed.data as { count: number; templates: Array<{ id: string }> }
    expect(listData.count).toBe(8)

    const gen = await executeMcpTool(
      'generate_template',
      { template: 'chibi-humanoid', autoTagParts: true, name: 'Knight Base' },
      ctx,
    )
    expect(gen.ok).toBe(true)
    const genData = gen.data as {
      layerId: string
      name: string
      partsCount: number
      craftGate: { score: number; grade: string; counts: Record<string, number> } | null
    }
    expect(genData.name).toBe('Knight Base')
    expect(genData.partsCount).toBe(6)
    expect(genData.craftGate).not.toBeNull()
    expect(genData.craftGate!.score).toBeGreaterThanOrEqual(50)

    const pin = await executeMcpTool('pin_style_anchor', { label: 'Hero Knight' }, ctx)
    expect(pin.ok).toBe(true)
    const pinData = pin.data as { styleAnchor: { label: string; spriteHeight: number }; promptTags: string[] }
    expect(pinData.styleAnchor.label).toBe('Hero Knight')
    expect(pinData.promptTags.some((t) => t.includes('Hero Knight'))).toBe(true)

    const stateRes = await executeMcpTool('get_project_state', {}, ctx)
    expect(stateRes.ok).toBe(true)
    const stateData = stateRes.data as { settings: { styleAnchor: { label: string } | null } }
    expect(stateData.settings.styleAnchor?.label).toBe('Hero Knight')

    const cleared = await executeMcpTool('pin_style_anchor', { clear: true }, ctx)
    expect(cleared.ok).toBe(true)
    const stateAfter = (await executeMcpTool('get_project_state', {}, ctx)).data as {
      settings: { styleAnchor: null }
    }
    expect(stateAfter.settings.styleAnchor).toBeNull()
  })

  test('MCP pixel writes automatically return craftGate with score, grade, counts, and defect coords', async () => {
    useEditor.getState().newProject(createProject({ name: 'CraftGateTest', width: 16, height: 16 }))

    // Paint a clean 6x6 block plus one isolated orphan speckle at (14, 14)
    const block = await executeMcpTool(
      'fill_rect',
      { from: { x: 2, y: 2 }, to: { x: 7, y: 7 }, color: '#3b82f6', filled: true },
      ctx,
    )
    expect(block.ok).toBe(true)
    const blockData = block.data as { craftGate: { score: number; grade: string; counts: { orphans: number } } }
    expect(blockData.craftGate).toBeDefined()
    expect(blockData.craftGate.score).toBeGreaterThan(0)
    expect(['clean', 'polish', 'needs_fix']).toContain(blockData.craftGate.grade)

    const speckle = await executeMcpTool(
      'set_pixels',
      { pixels: [{ x: 14, y: 14 }], color: '#ffffff' },
      ctx,
    )
    expect(speckle.ok).toBe(true)
    const speckleData = speckle.data as {
      craftGate: {
        counts: { orphans: number }
        topDefects: Array<{ kind: string; x: number; y: number }>
        hint: string
      }
    }
    expect(speckleData.craftGate.counts.orphans).toBeGreaterThanOrEqual(1)
    expect(speckleData.craftGate.topDefects.some((d) => d.kind === 'orphans' && d.x === 14 && d.y === 14)).toBe(true)
    expect(speckleData.craftGate.hint.length).toBeGreaterThan(0)

    // Ensure catalog exposes all three new tools
    const toolNames = new Set(MCP_TOOLS.map((t) => t.name))
    expect(toolNames.has('list_templates')).toBe(true)
    expect(toolNames.has('generate_template')).toBe(true)
    expect(toolNames.has('pin_style_anchor')).toBe(true)
  })
})
