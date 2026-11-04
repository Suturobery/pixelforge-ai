// PixelForge AI — PNG sequence import: N individual PNG files (one per
// frame, sorted by filename) become ONE animated clip — single undo
// transaction, same bus path as import_frame_strip. Frames must match the
// canvas size exactly (no silent rescaling — pixel art integrity).

import { decodePng } from '@pixelforge/core'
import { getBus } from './store'
import { followCommandTarget } from './mcp-follow'

export interface PngSequenceResult {
  ok: boolean
  error?: { code: string; message: string; hint?: string }
  clipId?: string
  clipName?: string
  frames?: number
  fps?: number
}

const MAX_FILES = 64

export async function importPngSequence(
  files: File[],
  opts: { name: string; fps?: number },
): Promise<PngSequenceResult> {
  const project = getBus().getProject()
  if (files.length < 1) {
    return { ok: false, error: { code: 'validation_failed', message: 'No PNG files selected.' } }
  }
  if (files.length > MAX_FILES) {
    return {
      ok: false,
      error: { code: 'validation_failed', message: `${files.length} files selected — max ${MAX_FILES} frames.`, hint: 'Split the sequence or drop frames first.' },
    }
  }

  // decode ALL up-front so validation completes before any mutation
  const cells: Uint8ClampedArray[] = []
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const img = await decodePng(bytes)
      if (img.width !== project.width || img.height !== project.height) {
        return {
          ok: false,
          error: {
            code: 'dimension_mismatch',
            message: `"${file.name}" is ${img.width}×${img.height}; the canvas is ${project.width}×${project.height}.`,
            hint: 'PNG-sequence import never resizes — export the frames at canvas size.',
          },
        }
      }
      cells.push(img.rgba)
    } catch (err) {
      return {
        ok: false,
        error: { code: 'validation_failed', message: `"${file.name}" is not a decodable PNG (${err instanceof Error ? err.message : 'decode failed'}).` },
      }
    }
  }

  const name = opts.name.trim().slice(0, 120) || 'sequence'
  const fps = opts.fps ?? 12

  const createdClipId = getBus().transaction(`Import PNG sequence "${name}" (${files.length} frames)`, 'mcp', () => {
    getBus().execute('clip.add', { name, fps }, 'mcp') // clip.add creates exactly ONE frame
    let clip = getBus().getProject().clips[getBus().getProject().clips.length - 1]!
    for (let f = 1; f < files.length; f++) {
      getBus().execute('frame.add', { clipId: clip.id }, 'mcp')
      clip = getBus().getProject().clips[getBus().getProject().clips.length - 1]!
    }
    cells.forEach((buffer, idx) => {
      clip = getBus().getProject().clips.find((c) => c.id === clip.id)!
      getBus().execute('layer.add', { clipId: clip.id, name: `frame-${idx + 1}` }, 'mcp')
      const layer = getBus().getProject().clips.find((c) => c.id === clip.id)!.layers.slice(-1)[0]!
      const frame = getBus().getProject().clips.find((c) => c.id === clip.id)!.frames[idx]!
      getBus().execute(
        'pixels.applyOp',
        { clipId: clip.id, frameId: frame.id, layerId: layer.id, ops: [{ op: 'setBuffer', buffer }] },
        'mcp',
      )
    })
    return clip.id
  })

  followCommandTarget({ clipId: createdClipId })
  const after = getBus().getProject().clips.find((c) => c.id === createdClipId)!
  return { ok: true, clipId: after.id, clipName: after.name, frames: after.frames.length, fps }
}
