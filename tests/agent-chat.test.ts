// Agent message → OpenAI conversion: harmony (gpt-oss) needs every tool
// result correlated to its call by id. Providers sometimes omit ids — the
// converter must backfill matching ids for turn-2+ history or Groq 400s
// with harmony "Tools should have a name!".

import { describe, expect, test } from 'bun:test'
import { toOpenAIMessages } from '../src/lib/pixelforge/ai/agent-chat'
import type { AgentMsg } from '../src/lib/pixelforge/ai/agent-chat'

describe('toOpenAIMessages — tool_call id backfill', () => {
  test('ids from the provider pass through untouched', () => {
    const msgs: AgentMsg[] = [
      { role: 'user', text: 'draw a slime' },
      { role: 'assistant', toolCalls: [{ id: 'call_real', name: 'get_project_state', args: {} }] },
      { role: 'user', toolResults: [{ id: 'call_real', name: 'get_project_state', ok: true, content: '{"name":"untitled"}' }] },
    ]
    const out = toOpenAIMessages('sys', msgs)
    const assistant = out.find((m) => m.role === 'assistant')!
    expect(assistant.tool_calls?.[0]?.id).toBe('call_real')
    const tool = out.find((m) => m.role === 'tool')!
    expect(tool.tool_call_id).toBe('call_real')
  })

  test('missing ids on BOTH sides are backfilled with matching values', () => {
    const msgs: AgentMsg[] = [
      { role: 'user', text: 'draw a slime' },
      { role: 'assistant', toolCalls: [{ name: 'get_project_state', args: {} }] }, // no id (gpt-oss quirk)
      { role: 'user', toolResults: [{ name: 'get_project_state', ok: true, content: 'ok' }] }, // no id either
      { role: 'assistant', text: 'done' },
    ]
    const out = toOpenAIMessages('sys', msgs)
    const assistant = out.find((m) => m.role === 'assistant')!
    expect(assistant.tool_calls).toHaveLength(1)
    const callId = assistant.tool_calls![0]!.id
    expect(callId).toMatch(/^call_/)
    const tool = out.find((m) => m.role === 'tool')!
    expect(tool.tool_call_id).toBe(callId)
  })

  test('multiple calls pair with results by order', () => {
    const msgs: AgentMsg[] = [
      { role: 'user', text: 'draw two things' },
      {
        role: 'assistant',
        toolCalls: [
          { name: 'get_palette', args: {} },
          { name: 'get_project_state', args: {} },
        ],
      },
      {
        role: 'user',
        toolResults: [
          { name: 'get_palette', ok: true, content: 'palette' },
          { name: 'get_project_state', ok: true, content: 'state' },
        ],
      },
    ]
    const out = toOpenAIMessages('sys', msgs)
    const assistant = out.find((m) => m.role === 'assistant')!
    const ids = assistant.tool_calls!.map((c) => c.id)
    const toolMsgs = out.filter((m) => m.role === 'tool')!
    expect(toolMsgs.map((t) => t.tool_call_id)).toEqual(ids)
  })

  test('nameless tool calls are dropped instead of breaking harmony', () => {
    const msgs: AgentMsg[] = [
      { role: 'assistant', toolCalls: [{ id: 'x', name: '', args: {} }] },
      { role: 'assistant', text: 'ok' },
    ]
    const out = toOpenAIMessages('sys', msgs)
    expect(out.filter((m) => m.role === 'assistant' && m.tool_calls).length).toBe(0)
  })
})
