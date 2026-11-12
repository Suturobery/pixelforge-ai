// Brain memory boundaries: v1→v2 migration, retention caps, and the
// phase-3 lifecycle controls (clear session context / full reset / export).

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  addBrainPreference,
  clearBrainSessionContext,
  exportBrainMemory,
  migrateSecondBrainMemory,
  readBrainMemory,
  recordAgentContextEvent,
  recordBrainFeedback,
  resetBrainMemory,
  writeBrainMemory,
} from '../src/lib/pixelforge/second-brain-intelligence'

const LEGACY_DEFAULTS = [
  'crisp 1px pixel clusters',
  'clear readable silhouette',
  'consistent top-left lighting',
]

describe('migrateSecondBrainMemory', () => {
  test('v1 blob with the exact legacy default set drops the built-in lighting preference', () => {
    const migrated = migrateSecondBrainMemory({ version: 1, prefer: [...LEGACY_DEFAULTS] } as never)
    expect(migrated.version).toBe(2)
    expect(migrated.prefer).not.toContain('consistent top-left lighting')
    expect(migrated.prefer).toContain('crisp 1px pixel clusters')
  })

  test('v2 memory keeps a deliberate top-left lighting preference', () => {
    const migrated = migrateSecondBrainMemory({ version: 2, prefer: [...LEGACY_DEFAULTS] } as never)
    expect(migrated.prefer).toContain('consistent top-left lighting')
  })

  test('caps are enforced (prefer 16, feedback 40, context 25) and junk entries filtered', () => {
    const migrated = migrateSecondBrainMemory({
      prefer: Array.from({ length: 20 }, (_, i) => `cue ${i}`),
      avoid: ['ok', '', 42, null, 'also ok'],
      customAliases: 'nope',
      feedbackHistory: Array.from({ length: 50 }, () => ({ id: 'fb', createdAt: '', prompt: '', enhancedPrompt: '', rating: 'up' })),
      recentContext: Array.from({ length: 30 }, () => ({ id: 'ctx', ts: '', source: 's', toolOrAction: 't', summary: 'x' })),
      autoEnhancePrompts: false,
    } as never)
    expect(migrated.prefer).toHaveLength(16)
    expect(migrated.avoid).toEqual(['ok', 'also ok'])
    expect(migrated.customAliases).toEqual({})
    expect(migrated.feedbackHistory).toHaveLength(40)
    expect(migrated.recentContext).toHaveLength(25)
    expect(migrated.autoEnhancePrompts).toBe(false)
  })

  test('missing autoEnhancePrompts defaults to on', () => {
    expect(migrateSecondBrainMemory({} as never).autoEnhancePrompts).toBe(true)
  })
})

describe('memory lifecycle controls', () => {
  beforeEach(() => {
    resetBrainMemory()
  })

  test('clearBrainSessionContext wipes activity + feedback but keeps preferences', () => {
    addBrainPreference('prefer', 'bold silhouettes')
    recordBrainFeedback({ prompt: 'p', enhancedPrompt: 'e', rating: 'up', note: 'strong shapes' })
    recordAgentContextEvent('agent', 'set_pixels', 'drew something')

    const cleared = clearBrainSessionContext()
    expect(cleared.recentContext).toHaveLength(0)
    expect(cleared.feedbackHistory).toHaveLength(0)
    expect(cleared.prefer).toContain('bold silhouettes')
    expect(cleared.prefer).toContain('strong shapes') // thumbs note became a preference
    expect(readBrainMemory().recentContext).toHaveLength(0)
  })

  test('resetBrainMemory restores factory defaults', () => {
    addBrainPreference('avoid', 'noisy pixels')
    recordAgentContextEvent('agent', 'flip_frame', 'flipped')
    const reset = resetBrainMemory()
    expect(reset.prefer).toEqual(['crisp 1px pixel clusters', 'clear readable silhouette'])
    expect(reset.avoid).toEqual(['pillow shading', 'blurry anti-aliased edges', 'noisy stray single pixels'])
    expect(reset.recentContext).toHaveLength(0)
    expect(reset.autoEnhancePrompts).toBe(true)
    expect(readBrainMemory()).toEqual(reset)
  })

  test('exportBrainMemory is a valid JSON snapshot of current memory', () => {
    addBrainPreference('prefer', 'exported cue')
    const parsed = JSON.parse(exportBrainMemory())
    expect(parsed.version).toBe(2)
    expect(parsed.prefer).toContain('exported cue')
    expect(parsed).toHaveProperty('recentContext')
    expect(parsed).toHaveProperty('autoEnhancePrompts')
  })

  test('writeBrainMemory preserves caps across arbitrary patches', () => {
    writeBrainMemory({
      prefer: Array.from({ length: 30 }, (_, i) => `p${i}`),
    })
    expect(readBrainMemory().prefer).toHaveLength(16)
  })
})
