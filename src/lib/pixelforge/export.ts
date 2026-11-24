// PixelForge AI — export transport (Task 7).
//
// ALL export intelligence lives in @pixelforge/core (deterministic compose +
// PNG encode + metadata + atomic writes). This module only delivers bytes:
//   web prototype  → browser downloads (unchanged UX from Task 4),
//   desktop        → native dialogs + the session-allowlisted bridge fs.
//
// The canvas renderer is NOT part of the export path anymore — artifacts are
// composed from the document buffers in core, so web, desktop and the golden
// tests produce byte-identical output.

import {
  ExportError,
  buildAllArtifacts,
  decodePng,
  encodeExportPng,
  planExport,
  writeExportPlan,
  type ExportRequest,
  type Project,
} from '@pixelforge/core'
import { getBridge, isDesktop, makeBridgeFs } from './desktop-bridge'

export type { ExportRequest } from '@pixelforge/core'
export type ExportScale = 1 | 2 | 4 | 8

/** Result of a user-facing export run (dialog maps these to toasts). */
export type ExportOutcome =
  | { status: 'saved'; filenames: string[]; destination: string }
  | { status: 'canceled' }
  | { status: 'conflicts'; conflicts: string[] }

export interface ExportRunOptions extends ExportRequest {
  /** Desktop only: replace existing files in the chosen destination. */
  overwrite?: boolean
  /** Nearest-neighbor integer export scale factor (default 1 = native resolution). */
  scale?: ExportScale
}

function upscaleRgbaNearest(src: Uint8ClampedArray, w: number, h: number, scale: number): Uint8ClampedArray {
  const sw = w * scale
  const sh = h * scale
  const out = new Uint8ClampedArray(sw * sh * 4)
  for (let y = 0; y < sh; y++) {
    const sy = Math.floor(y / scale)
    for (let x = 0; x < sw; x++) {
      const sx = Math.floor(x / scale)
      const si = (sy * w + sx) * 4
      const di = (y * sw + x) * 4
      out[di] = src[si]
      out[di + 1] = src[si + 1]
      out[di + 2] = src[si + 2]
      out[di + 3] = src[si + 3]
    }
  }
  return out
}

const PNG_FILTERS = [{ name: 'PNG image', extensions: ['png'] }]
const JSON_FILTERS = [{ name: 'JSON metadata', extensions: ['json'] }]

function toBlob(kind: 'png' | 'json', bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart], { type: kind === 'png' ? 'image/png' : 'application/json' })
}

function dirnameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : path
}

/**
 * Build the artifact bytes (all-or-nothing) — exposed for the dev probe and
 * reused by the transport below so validation errors surface identically.
 */
export async function buildExportArtifacts(
  project: Project,
  request: ExportRequest,
  scale: ExportScale = 1,
): Promise<{ filename: string; kind: 'png' | 'json'; bytes: Uint8Array }[]> {
  const plan = planExport(project, request)
  const artifacts = await buildAllArtifacts(plan)
  if (!scale || scale === 1) return artifacts
  return Promise.all(
    artifacts.map(async (f) => {
      if (f.kind === 'png') {
        const decoded = await decodePng(f.bytes)
        const scaled = upscaleRgbaNearest(decoded.rgba, decoded.width, decoded.height, scale)
        const pngBytes = await encodeExportPng(decoded.width * scale, decoded.height * scale, scaled)
        return { ...f, bytes: pngBytes }
      }
      try {
        const meta = JSON.parse(new TextDecoder().decode(f.bytes)) as Record<string, unknown>
        if (typeof meta.frameWidth === 'number') meta.frameWidth *= scale
        if (typeof meta.frameHeight === 'number') meta.frameHeight *= scale
        if (typeof meta.sheetWidth === 'number') meta.sheetWidth *= scale
        if (typeof meta.sheetHeight === 'number') meta.sheetHeight *= scale
        if (Array.isArray(meta.frames)) {
          meta.frames = meta.frames.map((fr: Record<string, unknown>) => ({
            ...fr,
            ...(typeof fr.x === 'number' ? { x: fr.x * scale } : {}),
            ...(typeof fr.y === 'number' ? { y: fr.y * scale } : {}),
            ...(typeof fr.w === 'number' ? { w: fr.w * scale } : {}),
            ...(typeof fr.h === 'number' ? { h: fr.h * scale } : {}),
          }))
        }
        return { ...f, bytes: new TextEncoder().encode(JSON.stringify(meta, null, 2) + '\n') }
      } catch {
        return f
      }
    }),
  )
}

/**
 * Run a full export: validate → build every artifact in memory → deliver.
 * Throws ExportError for invalid input (caller shows a friendly toast);
 * never mutates the project.
 */
export async function runExport(project: Project, options: ExportRunOptions): Promise<ExportOutcome> {
  const { overwrite, scale = 1, ...request } = options
  const files = await buildExportArtifacts(project, request, scale)

  // --- web prototype: browser downloads (browser names/conflict UI its own) ---
  if (!isDesktop()) {
    for (const f of files) {
      downloadData(toBlob(f.kind, f.bytes), f.filename)
    }
    return { status: 'saved', filenames: files.map((f) => f.filename), destination: 'browser downloads' }
  }

  // --- desktop: native dialogs + allowlisted fs (main performs I/O) ---
  const bridge = getBridge()
  if (!bridge) throw new ExportError('WRITE_FAILED', 'desktop bridge is unavailable')

  let written: { filename: string; bytes: Uint8Array }[]
  let destination: string

  if (files.length === 1) {
    const file = files[0]
    const save = await bridge.project.pickSave({
      defaultPath: file.filename,
      filters: file.kind === 'png' ? PNG_FILTERS : JSON_FILTERS,
    })
    if (save.canceled || !save.path) return { status: 'canceled' }
    written = [{ filename: file.filename, bytes: file.bytes }]
    destination = save.path
    // Core atomic write (tmp + rename) straight to the user-picked file.
    const result = await writeExportPlan(makeBridgeFs(), dirnameOf(save.path), written, { overwrite: true })
    // overwrite: the native save dialog already confirmed replacement.
    if (result.status === 'partial') {
      throw new ExportError('WRITE_FAILED', `could not write ${result.failures[0].filename}: ${result.failures[0].message}`)
    }
    return { status: 'saved', filenames: [save.path], destination: dirnameOf(save.path) }
  }

  const picked = await bridge.exports.pickDir()
  if (picked.canceled || !picked.dir) return { status: 'canceled' }
  destination = picked.dir
  const result = await writeExportPlan(makeBridgeFs(), picked.dir, files, { overwrite })
  if (result.status === 'conflicts') {
    return { status: 'conflicts', conflicts: result.conflicts }
  }
  if (result.status === 'partial') {
    const first = result.failures[0]
    throw new ExportError(
      'WRITE_FAILED',
      `export partially failed — ${result.written.length} file(s) written, then ${first.filename}: ${first.message}`,
      { failures: result.failures },
    )
  }
  return { status: 'saved', filenames: files.map((f) => f.filename), destination }
}

// keep the original helper name/behavior (web downloads)
export function downloadData(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/**
 * Animated GIF export via gifenc.
 * Frames are composited RGBA byte arrays (e.g. from composeFrameRgba).
 */
export async function exportGif(
  frames: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }[],
  durations: number[],
  filename: string,
  opts: { scale?: number; checker?: boolean; bg?: string } = {}
): Promise<void> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc')
  const scale = opts.scale ?? 1
  const bgHex = opts.bg && opts.bg !== 'transparent' ? opts.bg : '#101014'
  const bgR = parseInt(bgHex.slice(1, 3), 16) || 16
  const bgG = parseInt(bgHex.slice(3, 5), 16) || 16
  const bgB = parseInt(bgHex.slice(5, 7), 16) || 20
  const transparent = opts.bg === 'transparent'

  const gif = GIFEncoder()
  const BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ]

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const fw = f.width * scale
    const fh = f.height * scale
    const rgba = new Uint8Array(fw * fh * 4)

    for (let y = 0; y < fh; y++) {
      const sy = Math.floor(y / scale)
      for (let x = 0; x < fw; x++) {
        const sx = Math.floor(x / scale)
        const si = (sy * f.width + sx) * 4
        const di = (y * fw + x) * 4
        const a = f.data[si + 3] / 255

        if (transparent) {
          const t = Math.max((BAYER[y & 3][x & 3] + 0.5) / 16, 0.04)
          rgba[di] = f.data[si]
          rgba[di + 1] = f.data[si + 1]
          rgba[di + 2] = f.data[si + 2]
          rgba[di + 3] = a > t ? 255 : 0
        } else {
          rgba[di] = Math.round(f.data[si] * a + bgR * (1 - a))
          rgba[di + 1] = Math.round(f.data[si + 1] * a + bgG * (1 - a))
          rgba[di + 2] = Math.round(f.data[si + 2] * a + bgB * (1 - a))
          rgba[di + 3] = 255
        }
      }
    }

    const palette = quantize(rgba, transparent ? 255 : 256, { format: 'rgb565' })
    const indexed = applyPalette(rgba, palette, 'rgb565')
    const frameOpts: {
      palette: number[][]
      delay: number
      dispose: number
      transparent?: boolean
      transparentIndex?: number
    } = { palette, delay: durations[i] || 125, dispose: 2 }

    if (transparent) {
      palette.push([0, 0, 0])
      const ti = palette.length - 1
      for (let p = 0; p < rgba.length; p += 4) {
        if (rgba[p + 3] === 0) indexed[p / 4] = ti
      }
      frameOpts.transparent = true
      frameOpts.transparentIndex = ti
    }

    gif.writeFrame(indexed, fw, fh, frameOpts)
  }

  gif.finish()
  const blob = new Blob([gif.bytes() as unknown as BlobPart], { type: 'image/gif' })
  downloadData(blob, filename)
}

/**
 * Decode export PNG bytes to pixels for previews — thin re-export so the
 * dialog (and the dev probe) can verify artifacts without another import.
 */
export function decodeExportPng(bytes: Uint8Array) {
  return decodePng(bytes)
}
