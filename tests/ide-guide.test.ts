// PixelForge AI — Copy IDE guide regression tests.
//
// The copied guide must describe the tier the pairing code was generated for
// (a hardcoded "full control" guide misrepresented read-only pairings) and
// must note that generate_sprite does not exist.

import { describe, expect, test } from 'bun:test'
import { buildIdeGuide, tierSummary, TIER_PERMISSIONS } from '../src/lib/pixelforge/ide-guide'

const ENDPOINT = 'http://127.0.0.1:3030/mcp'

describe('Copy IDE guide (tier-accurate)', () => {
  test('every tier names itself and its own permission scope', () => {
    const expectations: Record<string, string[]> = {
      L0: ['read-only', 'Tools that modify anything are unavailable'],
      L1: ['undoable edits', 'set_pixels', 'undo/redo', 'reversible'],
      L2: ['destructive', 'export to disk', 'canvas resize'],
      L3: ['full project control'],
    }
    for (const tier of ['L0', 'L1', 'L2', 'L3'] as const) {
      const guide = buildIdeGuide({ tier, endpoint: ENDPOINT, token: 'pfm_test' })
      expect(guide).toContain(`pairing tier ${tier}`)
      expect(guide).toContain('Endpoint: ' + ENDPOINT)
      expect(guide).toContain('Bearer pfm_test')
      expect(guide).toContain('pair_client')
      for (const needle of expectations[tier]) {
        expect(guide).toContain(needle)
      }
    }
  })

  test('L1 guide explicitly grants paint + undo; L0 does not mention paint as available', () => {
    const l1 = buildIdeGuide({ tier: 'L1', endpoint: ENDPOINT, token: 'pfm_1' })
    expect(l1).toContain('L1 — read + undoable edits')
    expect(l1).toContain('set_pixels')
    expect(l1).toContain('undo/redo')
    const l0 = buildIdeGuide({ tier: 'L0', endpoint: ENDPOINT, token: 'pfm_0' })
    expect(l0).toContain('L0 — read-only')
    expect(l0).not.toContain('plus painting')
  })

  test('generate_sprite absence is stated honestly in every tier', () => {
    for (const tier of ['L0', 'L1', 'L2', 'L3'] as const) {
      expect(buildIdeGuide({ tier, endpoint: ENDPOINT, token: 'pfm_x' })).toContain(
        'generate_sprite is not registered',
      )
    }
  })

  test('tier summaries match the pairing-card labels', () => {
    expect(tierSummary('L0')).toBe('L0 — read-only')
    expect(tierSummary('L1')).toBe('L1 — read + undoable edits')
    expect(tierSummary('L2')).toBe('L2 — edits + destructive ops')
    expect(tierSummary('L3')).toBe('L3 — full project control')
    expect(Object.keys(TIER_PERMISSIONS).sort()).toEqual(['L0', 'L1', 'L2', 'L3'])
  })

  test('deterministic for the same pairing', () => {
    const a = buildIdeGuide({ tier: 'L1', endpoint: ENDPOINT, token: 'pfm_abc' })
    const b = buildIdeGuide({ tier: 'L1', endpoint: ENDPOINT, token: 'pfm_abc' })
    expect(a).toBe(b)
  })
})
