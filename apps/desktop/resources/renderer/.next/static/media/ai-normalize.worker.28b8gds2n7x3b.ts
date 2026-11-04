// PixelForge AI — normalize worker (Task 9, plan §3.3 "off the main thread").
//
// Runs @pixelforge/core's normalize-v2 (pure) inside a Web Worker. The MAIN
// thread decodes the image (Image element — workers cannot decode JPEG/WebP
// without createImageBitmap gymnastics) and transfers the RGBA buffer here;
// the CPU-heavy pipeline (trim → downscale → despeckle → bg removal →
// OKLab quantize → fringe cleanup) runs off-thread and a preview PNG comes
// back (encoded by the core's own PNG codec — deterministic, no canvas).

import { decodePng, encodePng, normalizeV2, type Normalize2Options } from '@pixelforge/core'

export interface NormalizeWorkerRequest {
  id: number
  kind: 'normalize'
  /** RGBA source (transferred) */
  rgba: ArrayBuffer
  w: number
  h: number
  opts: Normalize2Options
}

export interface NormalizeWorkerResponse {
  id: number
  ok: boolean
  buffer?: ArrayBuffer
  pngBase64?: string
  stats?: {
    trim: { x: number; y: number; w: number; h: number }
    bgRemoved: number
    specklesRemoved: number
    colorsOut: number
    fringeRemoved: number
    paletteUsed: 'project' | 'auto' | 'off'
  }
  error?: string
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

self.onmessage = async (event: MessageEvent<NormalizeWorkerRequest>) => {
  const req = event.data
  try {
    const rgba = new Uint8ClampedArray(req.rgba)
    const res = normalizeV2(rgba, req.w, req.h, req.opts)
    const png = await encodePng(res.width, res.height, res.buffer)
    const response: NormalizeWorkerResponse = {
      id: req.id,
      ok: true,
      buffer: res.buffer.buffer.slice(
        res.buffer.byteOffset,
        res.buffer.byteOffset + res.buffer.byteLength,
      ) as ArrayBuffer,
      pngBase64: bytesToBase64(png),
      stats: res.stats,
    }
    ;(self as unknown as Worker).postMessage(response, [response.buffer!])
  } catch (err) {
    const response: NormalizeWorkerResponse = {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : 'normalize failed',
    }
    ;(self as unknown as Worker).postMessage(response)
  }
}
