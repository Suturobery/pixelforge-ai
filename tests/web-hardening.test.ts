// Phase 9c web hardening: optional bearer auth (S1) + server-side reasoning
// key fallback (S2). Both helpers are pure and unit-tested here; their
// enforcement points (api-guard.ts, brain-server.ts) are thin wrappers.

import { afterEach, describe, expect, test } from 'bun:test'
import { checkWebToken } from '../src/lib/pixelforge/agent-headers'
import { resolveBrainApiKey } from '../src/lib/pixelforge/brain-json'

const ENV_KEYS = ['PF_WEB_TOKEN', 'PF_GROQ_KEY'] as const
const savedEnv: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) savedEnv[k] = process.env[k]

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('checkWebToken (S1)', () => {
  test('no configured token → feature off, everything passes', () => {
    expect(checkWebToken(null, undefined)).toBe(true)
    expect(checkWebToken('Bearer whatever', '')).toBe(true)
  })

  test('configured token requires a matching Bearer credential', () => {
    expect(checkWebToken('Bearer secret-1', 'secret-1')).toBe(true)
    expect(checkWebToken('bearer secret-1', 'secret-1')).toBe(true) // case-insensitive scheme
    expect(checkWebToken('Bearer wrong', 'secret-1')).toBe(false)
    expect(checkWebToken(null, 'secret-1')).toBe(false)
    expect(checkWebToken('secret-1', 'secret-1')).toBe(false) // raw header without Bearer
    expect(checkWebToken('Bearer ', 'secret-1')).toBe(false)
  })
})

describe('resolveBrainApiKey (S2)', () => {
  test('inline key (desktop vault injection / browser-saved key) wins', () => {
    process.env.PF_GROQ_KEY = 'env-key'
    expect(resolveBrainApiKey('inline-key')).toBe('inline-key')
    expect(resolveBrainApiKey('  inline-key  ')).toBe('inline-key')
  })

  test('falls back to the server-side PF_GROQ_KEY when the client sends none', () => {
    process.env.PF_GROQ_KEY = 'env-key'
    expect(resolveBrainApiKey('')).toBe('env-key')
    expect(resolveBrainApiKey(undefined)).toBe('env-key')
    expect(resolveBrainApiKey(42)).toBe('env-key')
  })

  test('whitespace-only env values are treated as unset', () => {
    process.env.PF_GROQ_KEY = '   '
    expect(resolveBrainApiKey(undefined)).toBe('')
    delete process.env.PF_GROQ_KEY
    expect(resolveBrainApiKey('   ')).toBe('')
  })
})
