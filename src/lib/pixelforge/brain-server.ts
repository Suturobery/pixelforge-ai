// PixelForge AI — "Second brain" server service (shared-Brain evolution,
// Phase 1). Execution logic moved VERBATIM from the /api/ai/brain route so
// web, desktop (via the route) and future MCP adapters share one Brain
// service. The route keeps only transport concerns: state-change guard and
// body parsing.
//
// The plan branch enforces a STRICT schema on everything Groq returns (P0-2):
// unknown kinds, unsupported effects, malformed hex, and hallucinated fields
// are rejected — nothing unvalidated reaches the task board, and invalid
// plans never execute.

import { NextResponse } from 'next/server'
import { noJsonError, parseJsonObject, resolveBrainApiKey, sanitizeBoardText, structuredBrainOptions } from '@/lib/pixelforge/brain-json'
import { catalogPromptText, resolveVfxEffect } from '@/lib/pixelforge/vfx-catalog'
import { brainPlanSchema, type BrainPlanStep } from '@pixelforge/core'

const REQUEST_TIMEOUT_MS = 60_000
const MAX_QUESTION = 2000
const MAX_GOAL = 800

/** Per-kind semantic validation beyond the base schema. Returns a REWRITTEN
 * step (the app owns accuracy — e.g. fuzzy effect names are resolved here,
 * server-side, before anything reaches a task board or the executor). */
async function validateStep(step: BrainPlanStep, index: number): Promise<BrainPlanStep> {
  if (step.kind === 'app-vfx') {
    if (!step.effect) throw new Error(`step ${index + 1} (app-vfx): "effect" is required.`)
    const resolved = await resolveVfxEffect(step.effect)
    if (!resolved.id) {
      throw new Error(
        `step ${index + 1} (app-vfx): no VFX matches "${step.effect}". Closest: ${resolved.suggestions?.join(', ') ?? 'call list_vfx'}.`,
      )
    }
    return { ...step, effect: resolved.id, palette: 'project' }
  }
  if (step.kind === 'app-palette') {
    if (!Array.isArray(step.colors) || step.colors.length < 2) {
      throw new Error(`step ${index + 1} (app-palette): "colors" (2–64 hex, dark→bright) is required.`)
    }
    return { ...step, colors: step.colors }
  }
  // agent: creative work MUST be described well enough for an agent to act
  if (!step.detail || step.detail.length < 10) {
    throw new Error(`step ${index + 1} (agent): "detail" must describe the work (min 10 chars).`)
  }
  return step
}

export interface BrainBody {
  question?: unknown
  action?: unknown
  goal?: unknown
  prompt?: unknown
  provider?: { baseUrl?: unknown; apiKey?: unknown; model?: unknown }
  project?: {
    name?: unknown
    width?: unknown
    height?: unknown
    clips?: unknown
    paletteSize?: unknown
    styleLock?: unknown
    styleDirection?: unknown
    clipsSummary?: unknown
    prefer?: unknown
    avoid?: unknown
    recentContext?: unknown
    projectId?: unknown
    revision?: unknown
  }
}

function formatLearnedMemory(p: NonNullable<BrainBody['project']>): string {
  const prefer = Array.isArray(p.prefer) ? (p.prefer as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 8) : []
  const avoid = Array.isArray(p.avoid) ? (p.avoid as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 8) : []
  const recent = Array.isArray(p.recentContext) ? (p.recentContext as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 6) : []
  const parts: string[] = []
  if (prefer.length > 0) parts.push(`Learned user preferences (MUST honor): ${prefer.join(', ')}.`)
  if (avoid.length > 0) parts.push(`Learned things to avoid: ${avoid.join(', ')}.`)
  if (recent.length > 0) parts.push(`Recent studio/IDE agent context: ${recent.join(' | ')}.`)
  return parts.join(' ')
}

/** Full Brain service handler: interpret, plan, advisory. Body shape matches
 * the long-standing route contract; responses are unchanged. */
export async function handleBrainPost(rawBody: unknown): Promise<NextResponse> {
  const body = (rawBody ?? {}) as BrainBody

  try {
    // =========================================================== INTERPRET
    if (body.action === 'interpret') {
      const rawPrompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, MAX_QUESTION) : ''
      const baseUrl = typeof body.provider?.baseUrl === 'string' ? body.provider.baseUrl.trim().replace(/\/+$/, '') : ''
      const apiKey = resolveBrainApiKey(body.provider?.apiKey)
      const model =
        typeof body.provider?.model === 'string' && body.provider.model.trim() ? body.provider.model.trim() : 'llama-3.3-70b-versatile'
      if (!rawPrompt || !baseUrl || !apiKey) {
        return NextResponse.json({ ok: false, error: 'Prompt and Groq credentials are required.' }, { status: 400 })
      }
      const p = body.project ?? {}
      const memText = formatLearnedMemory(p)
      const systemPrompt =
        `You are the PixelForge AI Second Brain — an intelligent reasoning layer that interprets short, incomplete, misspelled, or rough prompts from artists and connected IDE agents.\n` +
        `Active project: "${String(p.name ?? 'untitled')}", canvas ${String(p.width ?? 32)}×${String(p.height ?? 32)}, ` +
        `palette ${String(p.paletteSize ?? 16)} colors, Style Lock ${p.styleLock ? 'ON' : 'off'}` +
        (typeof p.styleDirection === 'string' && p.styleDirection ? ` (${p.styleDirection})` : '') +
        `, clips: ${String(p.clipsSummary ?? 'idle(1f)')}.\n` +
        (memText ? `${memText}\n` : '') +
        `Analyze the user's raw prompt, fix any typos or inconsistencies, infer missing pixel-art/animation details from the active project context, and return one JSON object only (no Markdown) matching:\n` +
        `{"correctedPrompt":string,"enhancedPrompt":string,"reasoningSummary":string,"corrections":[{"from":string,"to":string,"reason":string}],"pixelArtGuidance":[string]}`

      const startedAt = Date.now()
      const res = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Raw prompt: ${rawPrompt}` },
          ],
          max_completion_tokens: 900,
          temperature: 0.2,
          ...structuredBrainOptions(model),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const payload = (await res
        .json()
        .catch(() => null)) as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
        error?: { message?: string }
      } | null
      if (!res.ok || !payload) {
        return NextResponse.json({ ok: false, error: 'Groq error: ' + (payload?.error?.message ?? `HTTP ${res.status}`) }, { status: 502 })
      }
      const choice = payload.choices?.[0]
      const parsed = parseJsonObject(choice?.message?.content ?? '')
      if (!parsed) return NextResponse.json({ ok: false, error: noJsonError('Interpreter', choice?.finish_reason) }, { status: 502 })
      return NextResponse.json({
        ok: true,
        correctedPrompt: typeof parsed.correctedPrompt === 'string' ? sanitizeBoardText(parsed.correctedPrompt) : rawPrompt,
        enhancedPrompt: typeof parsed.enhancedPrompt === 'string' ? sanitizeBoardText(parsed.enhancedPrompt) : rawPrompt,
        reasoningSummary: typeof parsed.reasoningSummary === 'string' ? sanitizeBoardText(parsed.reasoningSummary) : '',
        corrections: Array.isArray(parsed.corrections) ? parsed.corrections.slice(0, 8) : [],
        pixelArtGuidance: Array.isArray(parsed.pixelArtGuidance)
          ? (parsed.pixelArtGuidance as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 6)
          : [],
        usage: {
          tokensIn: payload.usage?.prompt_tokens ?? 0,
          tokensOut: payload.usage?.completion_tokens ?? 0,
        },
        durationMs: Date.now() - startedAt,
        model,
      })
    }

    // ================================================================ PLAN
    if (body.action === 'plan') {
      const goal = typeof body.goal === 'string' ? body.goal.trim().slice(0, MAX_GOAL) : ''
      const baseUrl = typeof body.provider?.baseUrl === 'string' ? body.provider.baseUrl.trim().replace(/\/+$/, '') : ''
      const apiKey = resolveBrainApiKey(body.provider?.apiKey)
      const model =
        typeof body.provider?.model === 'string' && body.provider.model.trim() ? body.provider.model.trim() : 'llama-3.3-70b-versatile'
      if (!goal || !baseUrl || !apiKey) {
        return NextResponse.json({ ok: false, error: 'Goal and Groq credentials are required.' }, { status: 400 })
      }
      const p = body.project ?? {}
      const catalog = await catalogPromptText()
      const memText = formatLearnedMemory(p)
      const context =
        'PixelForge project "' +
        String(p.name ?? 'untitled') +
        '" — canvas ' +
        String(p.width ?? '?') +
        'x' +
        String(p.height ?? '?') +
        ', palette ' +
        String(p.paletteSize ?? '?') +
        ' colors, Style Lock ' +
        (p.styleLock ? 'ON (project palette is auto-applied to VFX steps)' : 'off') +
        (typeof p.styleDirection === 'string' && p.styleDirection ? ` (${p.styleDirection})` : '') +
        '. Existing clips: ' +
        String(p.clipsSummary ?? 'unknown') +
        '.' +
        (memText ? '\n' + memText : '') +
        '\n\nSUPPORTED VFX EFFECTS (kind app-vfx may ONLY use these ids):\n' +
        catalog +
        '\n\nYou are the Second Brain ORCHESTRATOR. Even if the Goal is short, incomplete, or contains typos/shorthand, infer the user\'s true intent from the project context above and fill in reasonable missing pixel-art and animation details. Return one JSON object only, with no prose or Markdown:' +
        ' {"steps":[{"kind":"app-vfx"|"app-palette"|"agent","title":string,' +
        ' "effect":string?,"seed":number?,"light":number?,"palette":"project"?,"colors":string[]?,"detail":string?}]}.' +
        ' Rules: app-vfx for procedural effects (one step per effect; include light 0.4-0.7 for small canvases; palette:"project" to stay on-style);' +
        ' app-palette to set colors (colors = dark-to-bright hex array, 2-64, max 32 recommended);' +
        ' agent ONLY for hand-drawn pixel art or animation steps the effects library cannot cover (detail must describe exact pixel-art instructions, canvas size, silhouette, lighting, and target clip/layer so any connected IDE agent can execute it without asking repetitive questions);' +
        ' 2-6 steps total, ordered.'
      const res = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Goal: ' + goal + '\n\n' + context }],
          max_completion_tokens: 1400,
          temperature: 0,
          ...structuredBrainOptions(model),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const payload = (await res
        .json()
      .catch(() => null)) as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }>; error?: { message?: string } } | null
      if (!res.ok || !payload) {
        return NextResponse.json({ ok: false, error: 'Groq error: ' + (payload?.error?.message ?? `HTTP ${res.status}`) }, { status: 502 })
      }
      const choice = payload.choices?.[0]
      const parsedJson = parseJsonObject(choice?.message?.content ?? '')
      if (!parsedJson) return NextResponse.json({ ok: false, error: noJsonError('Planner', choice?.finish_reason) }, { status: 502 })
      // STRICT SCHEMA VALIDATION — the load-bearing boundary before anything
      // is executed or queued. Invalid plans are rejected whole.
      const parsed = brainPlanSchema.safeParse(parsedJson)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        return NextResponse.json(
          { ok: false, error: `Plan rejected: ${first.path.join('.') || 'plan'} — ${first.message}. Nothing was executed or queued.` },
          { status: 422 },
        )
      }
      const validated: BrainPlanStep[] = []
      try {
        for (let i = 0; i < parsed.data.steps.length; i++) {
          validated.push(await validateStep(parsed.data.steps[i]!, i))
        }
      } catch (err) {
        return NextResponse.json(
          { ok: false, error: `${err instanceof Error ? err.message : 'Plan invalid'} Nothing was executed or queued.` },
          { status: 422 },
        )
      }
      // agent-step text is board-bound: strip control characters
      for (const step of validated) {
        if (step.kind === 'agent') {
          step.title = sanitizeBoardText(step.title)
          step.detail = sanitizeBoardText(step.detail ?? '')
        }
      }
      return NextResponse.json({
        ok: true,
        steps: validated,
        // plan carries the project identity it was made against so executors
        // can re-check freshness before dispatching
        projectId: typeof p.projectId === 'string' ? p.projectId : null,
        revision: typeof p.revision === 'string' ? p.revision : null,
      })
    }

    // ============================================================ ADVISORY
    const question = typeof body.question === 'string' ? body.question.trim().slice(0, MAX_QUESTION) : ''
    const baseUrl = typeof body.provider?.baseUrl === 'string' ? body.provider.baseUrl.trim().replace(/\/+$/, '') : ''
    const apiKey = resolveBrainApiKey(body.provider?.apiKey)
    const model =
      typeof body.provider?.model === 'string' && body.provider.model.trim() ? body.provider.model.trim() : 'llama-3.3-70b-versatile'
    if (!question) return NextResponse.json({ ok: false, error: 'Question is required.' }, { status: 400 })
    if (!baseUrl || !apiKey) {
      return NextResponse.json(
        { ok: false, error: 'Groq Base URL and API key are required (Settings → AI, or set PF_GROQ_KEY server-side).' },
        { status: 400 },
      )
    }

    const p = body.project ?? {}
    const memText = formatLearnedMemory(p)
    const context =
      `Project "${String(p.name ?? 'untitled')}" — canvas ${String(p.width ?? '?')}×${String(p.height ?? '?')}, ` +
      `palette ${String(p.paletteSize ?? '?')} colors, Style Lock ${p.styleLock ? 'ON' : 'off'}` +
      (typeof p.styleDirection === 'string' && p.styleDirection ? ` (${p.styleDirection})` : '') +
      `. Clips: ${Array.isArray(p.clips) ? (p.clips as Array<{ name?: string; frames?: number }>).slice(0, 24).map((k) => `${String(k.name ?? '?')}(${Number(k.frames ?? 0)}f)`).join(', ') : 'unknown'}. ` +
      (memText ? `${memText} ` : '') +
      `You are the PixelForge Second Brain: interpret even short, incomplete, or misspelled questions using the project context above; advise on pixel-art craft, character proportions, palette ramps, what to build next, which free VFX/effects or motion presets to use, and export choices. Never claim to have edited anything directly — you are the reasoning layer; keep answers concise and actionable (under 160 words).`

    const startedAt = Date.now()
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: context },
          { role: 'user', content: question },
        ],
        max_tokens: 400,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const payload = (await res
      .json()
      .catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } }
      | null
    if (!res.ok || !payload) {
      const msg = payload?.error?.message ?? `HTTP ${res.status}`
      return NextResponse.json({ ok: false, error: `Groq error: ${msg}` }, { status: 502 })
    }
    const answer = payload.choices?.[0]?.message?.content?.trim() ?? ''
    if (!answer) return NextResponse.json({ ok: false, error: 'Groq returned an empty answer.' }, { status: 502 })
    return NextResponse.json({
      ok: true,
      answer,
      usage: {
        tokensIn: payload.usage?.prompt_tokens ?? 0,
        tokensOut: payload.usage?.completion_tokens ?? 0,
      },
      durationMs: Date.now() - startedAt,
      model,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'brain request failed'
    return NextResponse.json({ ok: false, error: /timeout|abort/i.test(msg) ? 'Groq timed out — try again.' : msg }, { status: 500 })
  }
}
