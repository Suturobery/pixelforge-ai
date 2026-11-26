// Brain Core facade contract: the deterministic interpreter re-export.
// Provider readiness, project-context transport and the plan dispatcher were
// removed with the subscription-only migration (no API-key LLM paths).
// Memory lifecycle tests live in brain-memory.test.ts.

import { describe, expect, test } from 'bun:test'
import {
  buildIdeAgentHandoffPrompt,
  detectStarterTemplateHint,
  interpretAndEnhancePrompt,
} from '../src/lib/pixelforge/brain-core'
import type { AgentContextEvent, SecondBrainMemory } from '../src/lib/pixelforge/second-brain-intelligence'

const project = {
  name: 'Mimic',
  width: 32,
  height: 32,
  palette: ['#000000', '#ffffff', '#888888'],
  clips: [
    { id: 'clip_idle', name: 'idle', layers: [{ id: 'l1', name: 'layer 1' }], frames: [{}, {}] },
    { id: 'clip_walk', name: 'walk', layers: [{ id: 'l1', name: 'layer 1' }], frames: [{}] },
  ],
  settings: { styleProfile: { enabled: true, artDirection: 'dark fantasy' } },
}

const memoryEvent = (i: number): AgentContextEvent => ({
  id: `ctx_${i}`,
  ts: '2026-01-01T00:00:00.000Z',
  source: 'test-agent',
  toolOrAction: 'set_pixels',
  summary: `edit ${i}`,
})

const memory = (recentCount = 2): SecondBrainMemory => ({
  version: 2,
  prefer: ['crisp 1px pixel clusters'],
  avoid: ['pillow shading'],
  customAliases: {},
  feedbackHistory: [],
  recentContext: Array.from({ length: recentCount }, (_, i) => memoryEvent(i)),
  autoEnhancePrompts: true,
})

describe('facade re-exports the shared interpreter', () => {
  test('interpretAndEnhancePrompt corrects typos through the facade', () => {
    const result = interpretAndEnhancePrompt('make knigth wlak', project, undefined, memory(0))
    expect(result.detectedIntent).toBe('animation-motion')
    expect(result.correctedPrompt).toContain('knight')
    expect(result.correctedPrompt).toContain('walk')
  })

  test('recommendations derive from the real editor catalog when one is passed', () => {
    // sprite-generation intent: generation tools were removed (subscription-only)
    const only = ['set_pixels', 'beautify_layer', 'validate_style']
    const result = interpretAndEnhancePrompt('draw a red potion sprite', project, undefined, memory(0), only)
    expect(result.detectedIntent).toBe('sprite-generation')
    for (const t of result.inferredContext.recommendedTools) expect(only).toContain(t)
  })

  test('detects valid pixelfx VFX IDs, starter templates, and builds IDE handoff prompt with selection', () => {
    const lightning = interpretAndEnhancePrompt('add lightning effect to it', project, undefined, memory(0))
    expect(lightning.inferredContext.vfxEffect).toBe('lightning/lightning-strike')

    const boom = interpretAndEnhancePrompt('big explosion vfx', project, undefined, memory(0))
    expect(boom.inferredContext.vfxEffect).toBe('explosions/big-explosion')

    expect(detectStarterTemplateHint('chibi knight warrior')?.id).toBe('chibi-humanoid')
    expect(detectStarterTemplateHint('green slime monster')?.id).toBe('slime')
    expect(detectStarterTemplateHint('iron rpg sword')?.id).toBe('rpg-sword')
    expect(detectStarterTemplateHint('abstract geometry')).toBeNull()

    const handoff = buildIdeAgentHandoffPrompt({
      enhancedPrompt: 'Chibi knight with silver armor',
      projectName: 'Mimic',
      width: 32,
      height: 32,
      clipName: 'idle',
      frameNumber: 2,
      selection: { x: 8, y: 4, w: 16, h: 12 },
      paletteCount: 16,
      recommendedTools: ['set_pixels', 'beautify_layer'],
    })
    expect(handoff).toContain('32x32px')
    expect(handoff).toContain('x:8 y:4 (16x12)')
    expect(handoff).toContain('get_project_state')
    expect(handoff).toContain('set_pixels -> beautify_layer')
  })
})
