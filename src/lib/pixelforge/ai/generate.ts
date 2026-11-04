// PixelForge AI — generation submission (Task 9).
//
// ONE orchestration surface for the AI panel:
//   • DESKTOP (bridge v5): the job runs in the Electron MAIN process via
//     window.pixelforge.ai — credentials resolved in-process from the C13
//     vault, never crossing the bridge. Events arrive via ai.onEvent.
//   • WEB prototype: POST /api/ai/sprite (the legacy request/response path;
//     keys ride per-request from the renderer — documented 13a residual).
//
// Both paths land in the SAME candidate store with full provenance, then
// normalize through the worker client. Cancellation: bridge cancel() on
// desktop, AbortController on web.

import { buildFullPrompt, RECIPE_PRESETS, requestSizeFor, type Normalize2Options } from '@pixelforge/core'

import { isDesktop } from '@/lib/pixelforge/desktop-bridge'
import { describeApiErrorInline } from '@/lib/pixelforge/api-error'
import { AGENT_FETCH_HEADERS } from '@/lib/pixelforge/agent-headers'

import {
  aiCandidateStore,
  newCandidateId,
  type AiCandidate,
} from './candidates'
import { normalizeImage } from './normalize-client'

export interface GenerationParams {
  prompt: string
  recipeId: string
  width: number
  height: number
  count: number
  seed?: number
  providerId: string
  providerLabel: string
  model: string
  /** true when the provider needs a user key (web path: key comes from settings) */
  normalize: Normalize2Options
}

export interface GenerationTicket {
  candidateIds: string[]
  cancel(): void
  done: Promise<void>
}

let webAbort: AbortController | null = null

/** Style tags for a recipe preset (deterministic; 'free' adds nothing). */
export function recipeStyleTags(recipeId: string): string[] {
  return RECIPE_PRESETS.find((r) => r.id === recipeId)?.styleTags ?? []
}

function makeCandidate(params: GenerationParams, originalSrc: string, originalW: number, originalH: number, extras: Partial<AiCandidate>): AiCandidate {
  return {
    id: newCandidateId(),
    prompt: params.prompt,
    providerId: params.providerId,
    providerLabel: params.providerLabel,
    model: params.model,
    seed: params.seed ?? null,
    requestSize: requestSizeFor(params.width, params.height),
    width: params.width,
    height: params.height,
    createdAt: new Date().toISOString(),
    jobDurationMs: null,
    costEstimateUsd: null,
    cacheHit: false,
    recipe: params.recipeId,
    originalSrc,
    originalW,
    originalH,
    normalizeOpts: params.normalize as unknown as Record<string, unknown>,
    normalized: null,
    status: 'normalizing',
    error: null,
    ...extras,
  }
}

async function probeImageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => reject(new Error('generated image could not be decoded'))
    img.src = src
  })
}

/** Run normalize for a candidate and patch the store (worker off-thread). */
export async function normalizeCandidate(candidateId: string, opts: Normalize2Options): Promise<AiCandidate | null> {
  const store = aiCandidateStore
  const candidate = store.getState().get(candidateId)
  if (!candidate) return null
  store.getState().patch(candidateId, { status: 'normalizing', error: null, normalizeOpts: opts as unknown as Record<string, unknown> })
  try {
    const res = await normalizeImage({ src: candidate.originalSrc, opts })
    return store.getState().patch(candidateId, {
      status: 'review',
      normalized: {
        buffer: res.buffer,
        w: res.w,
        h: res.h,
        colors: res.stats.colorsOut,
        stats: res.stats,
      },
      error: null,
    })
  } catch (err) {
    return store.getState().patch(candidateId, {
      status: 'error',
      error: err instanceof Error ? err.message : 'Normalization failed',
    })
  }
}

/** Track in-flight job ids for cancel. */
const activeJobs = new Set<string>()

export function cancelGeneration(): void {
  for (const jobId of activeJobs) {
    void window.pixelforge?.ai.cancel(jobId).catch(() => undefined)
  }
  activeJobs.clear()
  webAbort?.abort()
}

/**
 * Submit a generation. Resolves the ticket immediately (candidates appear
 * as 'normalizing' → 'review'); the returned promise settles when every
 * candidate reached a terminal state. NEVER throws — errors land on the
 * candidates' error fields (and are rethrown via rejected promise only for
 * pre-flight rejections like spend_limit).
 */
export async function submitGeneration(params: GenerationParams, opts: { webApiKey?: string; webBaseUrl?: string; webProviderKind?: string }): Promise<void> {
  const fullPrompt = buildFullPrompt(params.prompt, recipeStyleTags(params.recipeId))
  const desktop = typeof window !== 'undefined' && isDesktop()
  const bridgeAi = desktop ? window.pixelforge?.ai : undefined

  if (bridgeAi) {
    // ---------------- desktop path: main-process job runner ----------------
    let jobIds: string[] = []
    try {
      // one job per candidate; the manager fans out to n>1 internally per
      // capability — we submit ONE job with count and split the results
      const { jobId } = await bridgeAi.submit({
        prompt: fullPrompt,
        providerId: params.providerId,
        width: params.width,
        height: params.height,
        count: params.count,
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        clientId: 'ai-panel',
      })
      jobIds = [jobId]
      activeJobs.add(jobId)
    } catch (err) {
      throw new Error(describeApiErrorInline(err, 'Generation rejected'))
    }

    await new Promise<void>((resolve) => {
      const unsub = bridgeAi.onEvent((event) => {
        if (event.type !== 'job' || !jobIds.includes(event.job.jobId)) return
        const job = event.job
        if (job.status === 'done') {
          activeJobs.delete(job.jobId)
          void ingestDesktopJob(job, params)
          unsub()
          resolve()
        } else if (job.status === 'error' || job.status === 'cancelled') {
          activeJobs.delete(job.jobId)
          const candidate = makeCandidate(params, '', params.width, params.height, {
            status: 'error',
            error: job.error ? `${job.error.code}: ${job.error.message}` : 'generation failed',
            jobDurationMs: job.durationMs,
            costEstimateUsd: job.costEstimateUsd,
          })
          aiCandidateStore.getState().upsert(candidate)
          unsub()
          resolve()
        }
      })
    })
    return
  }

  // ------------------------- web prototype path ---------------------------
  webAbort = new AbortController()
  try {
    const res = await fetch('/api/ai/sprite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AGENT_FETCH_HEADERS },
      signal: webAbort.signal,
      body: JSON.stringify({
        prompt: fullPrompt,
        count: params.count,
        provider:
          opts.webProviderKind && opts.webApiKey
            ? { kind: opts.webProviderKind, baseUrl: opts.webBaseUrl ?? '', apiKey: opts.webApiKey, model: params.model }
            : undefined,
      }),
    })
    const json = (await res.json()) as {
      ok: boolean
      images?: string[]
      image?: string
      engine?: string
      durationMs?: number
      costEstimateUsd?: number | null
      error?: unknown
      note?: string
    }
    if (!json.ok) {
      throw new Error(describeApiErrorInline(json.error, `Generation failed (HTTP ${res.status})`))
    }
    const images = json.images && json.images.length > 0 ? json.images : json.image ? [json.image] : []
    if (images.length === 0) throw new Error('Generation returned no images')
    const duration = json.durationMs ?? null
    await Promise.all(
      images.map(async (src, i) => {
        try {
          const { w, h } = await probeImageSize(src)
          const candidate = makeCandidate(params, src, w, h, {
            jobDurationMs: duration ? Math.round(duration / images.length) : null,
            costEstimateUsd: json.costEstimateUsd ?? null,
            model: json.engine ?? params.model,
            seed: params.seed ?? null,
          })
          if (json.note && i === 0) candidate.error = json.note
          aiCandidateStore.getState().upsert(candidate)
          await normalizeCandidate(candidate.id, params.normalize)
        } catch (err) {
          const candidate = makeCandidate(params, src, params.width, params.height, {
            status: 'error',
            error: err instanceof Error ? err.message : 'candidate failed',
          })
          aiCandidateStore.getState().upsert(candidate)
        }
      }),
    )
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return // user cancelled — silent
    throw err
  } finally {
    webAbort = null
  }
}

async function ingestDesktopJob(job: { images: Array<{ base64: string }>; durationMs: number | null; costEstimateUsd: number | null; model: string; cacheHit: boolean }, params: GenerationParams): Promise<void> {
  const images = job.images
  if (images.length === 0) return
  await Promise.all(
    images.map(async (img, i) => {
      const src = `data:image/png;base64,${img.base64}`
      try {
        const { w, h } = await probeImageSize(src)
        const candidate = makeCandidate(params, src, w, h, {
          jobDurationMs: job.durationMs ? Math.round(job.durationMs / images.length) : null,
          costEstimateUsd: job.cacheHit ? 0 : job.costEstimateUsd,
          cacheHit: job.cacheHit,
          model: job.model || params.model,
          seed: params.seed ?? null,
        })
        if (i === 0 && job.cacheHit) candidate.error = 'cache hit — no provider call, $0'
        aiCandidateStore.getState().upsert(candidate)
        await normalizeCandidate(candidate.id, params.normalize)
      } catch (err) {
        const candidate = makeCandidate(params, src, params.width, params.height, {
          status: 'error',
          error: err instanceof Error ? err.message : 'candidate failed',
        })
        aiCandidateStore.getState().upsert(candidate)
      }
    }),
  )
}
