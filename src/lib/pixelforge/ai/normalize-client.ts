// PixelForge AI — normalize worker client (Task 9).
//
// Runs normalize-v2 OFF the main thread through a Web Worker when the
// bundler supports it (same-directory worker entry), with a transparent
// same-thread fallback (the pipeline
// is the same pure core function either way — determinism is unaffected).
//
// The MAIN thread decodes the source image (Image element handles PNG /
// JPEG / WebP data URLs and works in every browser context), hands the RGBA
// buffer to the worker, and receives back the normalized buffer + a
// preview PNG (base64) encoded by the core's deterministic PNG codec.

import { normalizeV2, type Normalize2Options, type Normalize2Stats } from '@pixelforge/core'

export interface NormalizeRequest {
  /** data URL or object URL of the source image */
  src: string
  opts: Normalize2Options
}

export interface NormalizeOutcome {
  buffer: Uint8ClampedArray
  w: number
  h: number
  /** preview PNG as a data URL (normalized result) */
  pngDataUrl: string
  stats: Normalize2Stats
}

let worker: Worker | null = null
let workerBroken = false
let seq = 0
const pending = new Map<number, { resolve: (v: NormalizeWorkerResponse) => void; reject: (e: Error) => void }>()

interface NormalizeWorkerResponse {
  id: number
  ok: boolean
  buffer?: ArrayBuffer
  pngBase64?: string
  stats?: Normalize2Stats
  error?: string
}

function getWorker(): Worker | null {
  if (workerBroken || typeof window === 'undefined') return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./ai-normalize.worker.ts', import.meta.url))
    worker.onmessage = (event: MessageEvent<NormalizeWorkerResponse>) => {
      const p = pending.get(event.data.id)
      if (!p) return
      pending.delete(event.data.id)
      if (event.data.ok) p.resolve(event.data)
      else p.reject(new Error(event.data.error ?? 'normalize failed'))
    }
    worker.onerror = () => {
      // module load failure (bundler/CDP quirks) → permanent fallback
      workerBroken = true
      for (const [, p] of pending) p.reject(new Error('normalize worker unavailable'))
      pending.clear()
      worker?.terminate()
      worker = null
    }
    return worker
  } catch {
    workerBroken = true
    return null
  }
}

async function decodeToRgba(src: string): Promise<{ rgba: Uint8ClampedArray; w: number; h: number }> {
  const img = new Image()
  img.decoding = 'async'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Could not decode the image (unsupported or corrupt data)'))
    img.src = src
  })
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h) throw new Error('Image has no pixels')
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D context unavailable')
  ctx.drawImage(img, 0, 0)
  return { rgba: new Uint8ClampedArray(ctx.getImageData(0, 0, w, h).data), w, h }
}

function rgbaToDataUrl(buffer: Uint8ClampedArray, w: number, h: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D context unavailable')
  ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), w, h), 0, 0)
  return canvas.toDataURL('image/png')
}

/**
 * Normalize an image through the worker (fallback: same thread). Same
 * pure core pipeline in both paths — output identical, determinism pinned
 * by the core golden tests.
 */
export async function normalizeImage(req: NormalizeRequest): Promise<NormalizeOutcome> {
  const { rgba, w, h } = await decodeToRgba(req.src)

  const wk = getWorker()
  if (wk) {
    seq += 1
    const id = seq
    try {
      const result = await new Promise<NormalizeWorkerResponse>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        // copy (not transfer) the source — candidates keep the original for re-normalize
        const copy = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)
        wk.postMessage({ id, kind: 'normalize', rgba: copy, w, h, opts: req.opts }, [copy])
      })
      if (!result.ok || !result.buffer || !result.stats || result.pngBase64 === undefined) {
        throw new Error(result.error ?? 'normalize failed')
      }
      const buffer = new Uint8ClampedArray(result.buffer)
      return {
        buffer,
        w: req.opts.targetW,
        h: req.opts.targetH,
        pngDataUrl: `data:image/png;base64,${result.pngBase64}`,
        stats: result.stats,
      }
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('unavailable'))) {
        // worker ran but the pipeline failed — real error
        throw err
      }
      // fall through to the same-thread path
    }
  }

  // same-thread fallback (identical pure function)
  const res = normalizeV2(rgba, w, h, req.opts)
  return {
    buffer: res.buffer,
    w: res.width,
    h: res.height,
    pngDataUrl: rgbaToDataUrl(res.buffer, res.width, res.height),
    stats: res.stats,
  }
}
