// Brain Core facade contract: provider readiness + context assembly.
// Transport (callBrain) is browser/Electron glue — exercised in-app, not here.

import { describe, expect, test } from 'bun:test'
import {
  buildBrainProjectContext,
  checkPlanFreshness,
  interpretAndEnhancePrompt,
  planStepToToolCall,
  resolveBrainProvider,
  type PlanStep,
} from '../src/lib/pixelforge/brain-core'
import type { AIProviderConfig } from '../src/lib/pixelforge/settings'
import type { AgentContextEvent, SecondBrainMemory } from '../src/lib/pixelforge/second-brain-intelligence'

const provider = (patch: Partial<AIProviderConfig> = {}): AIProviderConfig => ({
  id: 'groq',
  label: 'Groq (second brain)',
  kind: 'openai',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  model: 'llama-3.3-70b-versatile',
  enabled: false,
  ...patch,
})

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

describe('resolveBrainProvider', () => {
  test('no groq profile → nothing usable', () => {
    expect(resolveBrainProvider([], false, {})).toEqual({ provider: null, hasKey: false })
  })

  test('inline key counts even when provider disabled (panel badge semantics)', () => {
    const { provider: p, hasKey } = resolveBrainProvider([provider({ apiKey: 'gsk_x' })], false, {})
    expect(hasKey).toBe(true)
    expect(p?.enabled).toBe(false)
  })

  test('vault key counts only in secure mode', () => {
    const vault = { groq: { hasKey: true } }
    expect(resolveBrainProvider([provider()], true, vault).hasKey).toBe(true)
    expect(resolveBrainProvider([provider()], false, vault).hasKey).toBe(false)
  })

  test('blank/whitespace key is not a key', () => {
    expect(resolveBrainProvider([provider({ apiKey: '   ' })], false, {}).hasKey).toBe(false)
  })
})

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

describe('buildBrainProjectContext', () => {
  test('payload matches the long-standing route contract', () => {
    const ctx = buildBrainProjectContext(project, memory(2)) as Record<string, unknown>
    expect(ctx).toMatchObject({
      name: 'Mimic',
      width: 32,
      height: 32,
      paletteSize: 3,
      clips: [
        { name: 'idle', frames: 2 },
        { name: 'walk', frames: 1 },
      ],
      clipsSummary: 'idle(2f), walk(1f)',
      styleLock: true,
      styleDirection: 'dark fantasy',
      prefer: ['crisp 1px pixel clusters'],
      avoid: ['pillow shading'],
    })
  })

  test('recent context is capped at 6 and formatted source:tool (summary)', () => {
    const ctx = buildBrainProjectContext(project, memory(8)) as { recentContext: string[] }
    expect(ctx.recentContext).toHaveLength(6)
    expect(ctx.recentContext[0]).toBe('test-agent:set_pixels (edit 0)')
    expect(ctx.recentContext[5]).toBe('test-agent:set_pixels (edit 5)')
  })

  test('disabled/missing Style Lock degrades to off without throwing', () => {
    const bare = { ...project, settings: {} }
    const ctx = buildBrainProjectContext(bare, memory(0)) as Record<string, unknown>
    expect(ctx.styleLock).toBe(false)
    expect(ctx.styleDirection).toBe('')
  })

  test('identity (projectId/revision) is included only when passed', () => {
    const without = buildBrainProjectContext(project, memory(0)) as Record<string, unknown>
    expect('projectId' in without).toBe(false)
    expect('revision' in without).toBe(false)

    const withId = buildBrainProjectContext(project, memory(0), {
      projectId: 'proj_1',
      revision: 'abc123',
    }) as Record<string, unknown>
    expect(withId.projectId).toBe('proj_1')
    expect(withId.revision).toBe('abc123')

    const unsaved = buildBrainProjectContext(project, memory(0), { projectId: null, revision: 'abc123' }) as Record<string, unknown>
    expect(unsaved.projectId).toBeNull()
  })
})

describe('checkPlanFreshness', () => {
  test('matching revisions are fresh', () => {
    expect(checkPlanFreshness('abc', 'abc')).toEqual({ stale: false })
  })

  test('changed document revision is stale with a re-plan reason', () => {
    const result = checkPlanFreshness('abc', 'def')
    expect(result.stale).toBe(true)
    expect(result.reason).toContain('re-plan')
  })

  test('plan without recorded revision is tolerated (legacy plans)', () => {
    expect(checkPlanFreshness(null, 'def')).toEqual({ stale: false })
    expect(checkPlanFreshness(undefined, 'def')).toEqual({ stale: false })
  })

  test('unreadable current revision blocks execution', () => {
    const result = checkPlanFreshness('abc', null)
    expect(result.stale).toBe(true)
    expect(result.reason).toContain('revision')
  })
})

describe('facade re-exports the shared interpreter', () => {
  test('interpretAndEnhancePrompt corrects typos through the facade', () => {
    const result = interpretAndEnhancePrompt('make knigth wlak', project, undefined, memory(0))
    expect(result.detectedIntent).toBe('animation-motion')
    expect(result.correctedPrompt).toContain('knight')
    expect(result.correctedPrompt).toContain('walk')
  })
})

describe('planStepToToolCall (shared dispatcher mapping)', () => {
  test('app-vfx maps to generate_vfx with catalog-facing args and a bounded name', () => {
    const call = planStepToToolCall({
      kind: 'app-vfx',
      title: 'Warm campfire glow'.repeat(20),
      effect: 'fire/campfire',
      seed: 42,
      light: 0.6,
    })
    expect(call).not.toBeNull()
    expect(call!.tool).toBe('generate_vfx')
    expect(call!.args.effect).toBe('fire/campfire')
    expect(call!.args.seed).toBe(42)
    expect(call!.args.light).toBe(0.6)
    expect(call!.args.palette).toBe('project')
    expect((call!.args.name as string).length).toBeLessThanOrEqual(120)
  })

  test('app-vfx without an effect falls back to the title', () => {
    const call = planStepToToolCall({ kind: 'app-vfx', title: 'explosion burst' })
    expect(call!.args.effect).toBe('explosion burst')
    expect(call!.args.seed).toBeUndefined()
    expect(call!.args.light).toBeUndefined()
  })

  test('app-palette maps to set_palette with colors capped at 256', () => {
    const many = Array.from({ length: 300 }, (_, i) => `#${String(i % 16).padStart(2, '0')}aa00`)
    const call = planStepToToolCall({ kind: 'app-palette', title: 'Set palette', colors: many })
    expect(call!.tool).toBe('set_palette')
    expect(call!.args.colors).toHaveLength(256)
  })

  test('agent steps and palette steps without colors never dispatch locally', () => {
    expect(planStepToToolCall({ kind: 'agent', title: 'Draw it', detail: 'hand-drawn work' })).toBeNull()
    expect(planStepToToolCall({ kind: 'app-palette', title: 'No colors' })).toBeNull()
  })
})
