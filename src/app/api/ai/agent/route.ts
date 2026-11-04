/**
 * Server-side proxy for the Agent panel's AI chat-with-tools loop.
 * The provider config travels with the request (same pattern as
 * /api/ai/sprite) — the route adds nothing and stores nothing.
 */

import { NextRequest, NextResponse } from 'next/server'
import { callProvider, type AgentMsg, type AgentProviderConfig } from '@/lib/pixelforge/ai/agent-chat'
import { guardStateChange } from '@/lib/pixelforge/api-guard'
import { requireSafeExternalHttpsUrl } from '@/lib/pixelforge/safe-external-url'

const MAX_TEXT = 16_000

async function normalizeProvider(raw: unknown): Promise<AgentProviderConfig | null> {
  if (!raw || typeof raw !== 'object') return null
  const cfg = raw as Record<string, unknown>
  if (!['zai', 'openai', 'custom'].includes(String(cfg.kind))) return null
  if (typeof cfg.baseUrl !== 'string' || typeof cfg.apiKey !== 'string' || typeof cfg.model !== 'string') return null
  if (cfg.apiKey.length === 0 || cfg.apiKey.length > 4096 || cfg.model.length > 256) return null
  try {
    const url = await requireSafeExternalHttpsUrl(cfg.baseUrl)
    return { kind: String(cfg.kind), baseUrl: url.toString().replace(/\/+$/, ''), apiKey: cfg.apiKey, model: cfg.model }
  } catch {
    return null
  }
}

function validMessages(raw: unknown): raw is AgentMsg[] {
  return Array.isArray(raw) && raw.length > 0 && raw.length <= 30 && raw.every((m) =>
    m && typeof m === 'object' && ((m as AgentMsg).role === 'user' || (m as AgentMsg).role === 'assistant')
  )
}

export async function POST(req: NextRequest) {
  const denied = guardStateChange(req)
  if (denied) return denied
  try {
    const body = (await req.json()) as {
      cfg?: AgentProviderConfig
      system?: string
      messages?: AgentMsg[]
    }
    const cfg = await normalizeProvider(body.cfg)
    if (!cfg) {
      return NextResponse.json({ error: 'Invalid provider configuration.' }, { status: 400 })
    }
    if (!validMessages(body.messages) || (body.system?.length ?? 0) > MAX_TEXT) {
      return NextResponse.json({ error: 'Invalid or oversized agent request.' }, { status: 400 })
    }
    const out = await callProvider(cfg, body.system ?? '', body.messages)
    return NextResponse.json(out)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}
