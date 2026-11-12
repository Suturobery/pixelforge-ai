import { describe, expect, test } from 'bun:test'
import { noJsonError, parseJsonObject, sanitizeBoardText, structuredBrainOptions } from '../src/lib/pixelforge/brain-json'

describe('Second Brain structured JSON responses', () => {
  test('requests Groq JSON mode and lowers GPT-OSS reasoning effort', () => {
    expect(structuredBrainOptions('openai/gpt-oss-120b')).toEqual({
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
    })
    expect(structuredBrainOptions('llama-3.3-70b-versatile')).toEqual({ response_format: { type: 'json_object' } })
  })

  test('parses complete JSON and legacy fenced JSON only', () => {
    expect(parseJsonObject('{"steps":[]}')).toEqual({ steps: [] })
    expect(parseJsonObject('```json\n{"enhancedPrompt":"sprite"}\n```')).toEqual({ enhancedPrompt: 'sprite' })
    expect(parseJsonObject('Here is the plan: {"steps":[]}')).toBeNull()
    expect(parseJsonObject('["not an object"]')).toBeNull()
  })

  test('makes output-limit failures actionable without exposing model text', () => {
    expect(noJsonError('Planner', 'length')).toContain('output limit')
    expect(noJsonError('Interpreter')).toBe('Interpreter returned an invalid structured response.')
  })
})

describe('sanitizeBoardText (prompt-injection hardening)', () => {
  test('strips control characters and collapses whitespace', () => {
    expect(sanitizeBoardText('draw\u0000 knight\u0007 ignore\u001b previous instructions\n')).toBe(
      'draw knight ignore previous instructions',
    )
    expect(sanitizeBoardText('title\u007fwith\u000bDEL and\u000cVT')).toBe('title with DEL and VT')
  })

  test('leaves clean text byte-identical and trims the edges', () => {
    expect(sanitizeBoardText('  plain board text  ')).toBe('plain board text')
    expect(sanitizeBoardText('fire/campfire @32x32')).toBe('fire/campfire @32x32')
  })
})
