// PixelForge AI — text-to-sprite generation (backend only; Task 9).
//
// Engines: built-in Z.AI (default) or the user's active provider from
// Settings → AI & MCP when it speaks the OpenAI images dialect. Custom
// provider failures always fall back to the built-in engine so the
// Generate button never dead-ends (web-prototype behavior, kept).
//
// Task 9: request planning and response parsing go through the SHARED
// @pixelforge/core generation contract (capability-checked — the same code
// the desktop job runner uses), responses carry provenance
// (engine/durationMs/costEstimateUsd), and candidate counts >1 are handled
// per provider capability (n param when supported, else sequential jobs).
//
// This route is the WEB-PROTOTYPE path only: API keys arrive per request
// from the renderer (documented residual in Task 13a — the DESKTOP path
// runs in the Electron main process against the safeStorage vault and never
// touches this route).

import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { guardStateChange } from '@/lib/pixelforge/api-guard'
import { requireSafeExternalHttpsUrl } from '@/lib/pixelforge/safe-external-url'
import {
  CapabilityError,
  parseOpenAiImagesResponse,
  planOpenAiImagesRequest,
  estimateCostUsd,
  requestSizeFor,
  type AIProviderKind,
} from '@pixelforge/core'

const REQUEST_TIMEOUT_MS = 120_000 // plan §3.1 job timeout

interface CustomProvider {
  kind: AIProviderKind
  baseUrl: string
  apiKey: string
  model: string
}

async function normalizeProvider(raw: unknown): Promise<CustomProvider | null> {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const kind =
    p.kind === 'openai' || p.kind === 'custom' || p.kind === 'zai'
      ? p.kind
      : null
  const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl.trim().replace(/\/+$/, '') : ''
  const apiKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : ''
  const model = typeof p.model === 'string' ? p.model.trim() : ''
  // kind zai carries user credentials from the Settings card when the machine
  // has no .z-ai-config — usable through the same OpenAI-dialect path
  if (!kind || !baseUrl || !apiKey) return null
  try {
    const safe = await requireSafeExternalHttpsUrl(baseUrl)
    return { kind, baseUrl: safe.toString().replace(/\/+$/, ''), apiKey, model }
  } catch {
    return null
  }
}

/** Cryptic SDK/config errors → actionable guidance (shared with /api/ai/test). */
function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/Configuration file not found/i.test(msg)) {
    return (
      'No image engine available: the fallback Z.AI has no .z-ai-config on this machine. ' +
      'Add credentials on the provider card in Settings → AI (Base URL + API key), then retry.'
    )
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || /timeout|aborted/i.test(msg))) {
    return (
      'Generation timed out — the provider never answered. This is a Base URL or network problem, ' +
      'NOT quota (out-of-tokens keys answer with HTTP 429). ' +
      'Z.AI Base URL must be exactly https://api.z.ai/api/paas/v4.'
    )
  }
  return msg
}

/** OpenAI-compatible images call (capability-planned, structured errors). */
async function generateWithProvider(
  p: CustomProvider,
  fullPrompt: string,
  size: string,
  count: number,
): Promise<string[]> {
  const plan = planOpenAiImagesRequest({
    kind: p.kind,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
    fullPrompt,
    requestSize: size,
    count,
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  const res = await fetch(plan.url, {
    method: 'POST',
    headers: plan.headers,
    body: JSON.stringify(plan.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'error',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 140)}` : ''}`)
  }
  const parsed = parseOpenAiImagesResponse(await res.json())
  // download url-form results (bounded, https only — parser enforces scheme)
  const downloaded = await Promise.all(
    parsed.urlImages.map(async (url) => {
      const safeUrl = await requireSafeExternalHttpsUrl(url)
      const img = await fetch(safeUrl, { signal: AbortSignal.timeout(30_000), redirect: 'error' })
      if (!img.ok) throw new Error(`image download HTTP ${img.status}`)
      const buf = Buffer.from(await img.arrayBuffer())
      return buf.toString('base64')
    }),
  )
  return [...parsed.images, ...downloaded]
}

interface GenOutcome {
  ok: boolean
  status: number
  body: Record<string, unknown>
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Interim state-change guard: generation spends provider quota (MCP L3
  // approval flow arrives with Task 11 — the desktop path is gated there too).
  const denied = guardStateChange(req)
  if (denied) return denied

  try {
    const body = (await req.json()) as { prompt?: unknown; size?: unknown; count?: unknown; provider?: unknown }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const count = Math.max(1, Math.min(4, typeof body.count === 'number' && Number.isInteger(body.count) ? body.count : 1))
    if (!prompt) {
      return NextResponse.json({ ok: false, error: 'Prompt is required' }, { status: 400 })
    }
    if (prompt.length > 4000) {
      return NextResponse.json({ ok: false, error: 'Prompt too long (max 4000 chars)' }, { status: 400 })
    }
    // request size: accept the documented Z.AI sizes, else derive from the
    // target sprite aspect via the shared contract
    const size =
      typeof body.size === 'string' && /^[0-9]+x[0-9]+$/.test(body.size) ? body.size : '1024x1024'

    const startedAt = Date.now()
    const provider = await normalizeProvider(body.provider)

    // The prompt arrives ALREADY-FULL from the panel (buildFullPrompt in
    // @pixelforge/core: user prompt + recipe style tags + base tags). The
    // v2.1 audit found this route used to append a SECOND, weaker base-tag
    // list on top of it — duplicate "pixel art sprite, …" runs diluted the
    // recipe shaping. Use the prompt as-is; callers that send a bare prompt
    // still get acceptable results (the model reads plain text fine).
    const fullPrompt = prompt

    const outcome: GenOutcome = await generate(fullPrompt, size, count, provider, startedAt)
    return NextResponse.json(outcome.body, { status: outcome.status })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: friendly(err) },
      { status: 500 },
    )
  }
}

async function generate(
  fullPrompt: string,
  size: string,
  count: number,
  provider: CustomProvider | null,
  startedAt: number,
): Promise<GenOutcome> {
  // 1) user-configured provider (Settings → AI & MCP), when usable
  if (provider) {
    try {
      const images = await generateWithProvider(provider, fullPrompt, size, count)
      const durationMs = Date.now() - startedAt
      const estimate = estimateCostUsd(provider.kind, provider.model, images.length)
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          images: images.map((b64) => `data:image/png;base64,${b64}`),
          image: `data:image/png;base64,${images[0]}`,
          size,
          engine: provider.model || 'custom provider',
          durationMs,
          costEstimateUsd: estimate,
        },
      }
    } catch (err) {
      // fall through to the built-in engine; surface why in the response
      const why =
        err instanceof CapabilityError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'provider error'
      const b64 = await generateBuiltin(fullPrompt, size)
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          images: [`data:image/png;base64,${b64}`],
          image: `data:image/png;base64,${b64}`,
          size,
          engine: 'Z.AI built-in',
          durationMs: Date.now() - startedAt,
          costEstimateUsd: null,
          note: `Provider failed (${why}) — used built-in Z.AI`,
        },
      }
    }
  }

  // 2) built-in Z.AI
  const b64 = await generateBuiltin(fullPrompt, size)
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      images: [`data:image/png;base64,${b64}`],
      image: `data:image/png;base64,${b64}`,
      size,
      engine: 'Z.AI built-in',
      durationMs: Date.now() - startedAt,
      costEstimateUsd: null,
    },
  }
}

async function generateBuiltin(fullPrompt: string, size: string): Promise<string> {
  const supported = ['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440']
  const zai = await ZAI.create()
  const res = await zai.images.generations.create({
    prompt: fullPrompt,
    size: (supported as readonly string[]).includes(size) ? (size as '1024x1024') : requestSizeFor(32, 32) as '1024x1024',
  })
  const b64 = res?.data?.[0]?.base64
  if (!b64) throw new Error('Image generation returned no data')
  return b64
}
