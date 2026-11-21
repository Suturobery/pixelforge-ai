// Brain Core facade contract: the deterministic interpreter re-export.
// Provider readiness, project-context transport and the plan dispatcher were
// removed with the subscription-only migration (no API-key LLM paths).
// Memory lifecycle tests live in brain-memory.test.ts.

import { describe, expect, test } from 'bun:test'
import { interpretAndEnhancePrompt } from '../src/lib/pixelforge/brain-core'
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
})
