// PixelForge AI — MCP tool: import_frame_strip.
//
// The professional sprite pipeline in ONE call: a sprite-sheet PNG
// (columns × rows of canvas-sized cells) becomes an animated clip with one
// layer per frame — single undo step, single rate-limit budget. This is the
// bulk counterpart of import_image_as_layer (which handles one frame).

import { decodePng } from '@pixelforge/core'
import { getBus, useEditor } from './store'
import { followCommandTarget } from './mcp-follow'

function fail(code: string, message: string, hint?: string) {
  return { ok: false as const, error: { code, message, ...(hint ? { hint } : {}) } }
}

export async function importFrameStrip(args: Record<string, unknown>) {
  const project = getBus().getProject()
  const columns = typeof args.columns === 'number' ? Math.floor(args.columns) : 0
  const rows = typeof args.rows === 'number' ? Math.floor(args.rows) : 0
  if (columns < 1 || columns > 32 || rows < 1 || rows > 32) {
    return fail('validation_failed', 'columns and rows must be integers in [1, 32]')
  }
  const count = columns * rows
  if (count > 64) return fail('validation_failed', `a strip of ${columns}×${rows} is ${count} frames — max 64`)

  const raw = typeof args.pngBase64 === 'string' ? args.pngBase64 : ''
  const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
  if (!b64) return fail('validation_failed', 'pngBase64 is required')
  let binary: Uint8Array
  try {
    const bin = atob(b64)
    binary = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) binary[i] = bin.charCodeAt(i)
  } catch {
    return fail('validation_failed', 'pngBase64 is not valid base64')
  }
  let decoded
  try {
    decoded = await decodePng(binary)
  } catch (err) {
    return fail('validation_failed', `pngBase64 is not a decodable PNG (${err instanceof Error ? err.message : 'decode failed'})`)
  }

  const cellW = project.width, cellH = project.height
  if (decoded.width !== cellW * columns || decoded.height !== cellH * rows) {
    return fail(
      'dimension_mismatch',
      `Sheet is ${decoded.width}×${decoded.height}; for a ${columns}×${rows} grid on a ${cellW}×${cellH} canvas it must be ${cellW * columns}×${cellH * rows}.`,
      'import_frame_strip never resizes — build the sheet from canvas-sized cells.',
    )
  }

  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 120) : 'strip'
  const fps = typeof args.fps === 'number' && args.fps >= 1 && args.fps <= 60 ? Math.floor(args.fps) : 12

  // extract each cell up-front so validation completes before any mutation
  const cells: Uint8ClampedArray[] = []
  for (let idx = 0; idx < count; idx++) {
    const col = idx % columns, row = Math.floor(idx / columns)
    const cell = new Uint8ClampedArray(cellW * cellH * 4)
    for (let y = 0; y < cellH; y++) {
      const srcStart = ((row * cellH + y) * decoded.width + col * cellW) * 4
      cell.set(decoded.rgba.subarray(srcStart, srcStart + cellW * 4), y * cellW * 4)
    }
    cells.push(cell)
  }

  const createdClipId = getBus().transaction(`Import strip "${name}" (${columns}×${rows})`, 'mcp', () => {
    getBus().execute('clip.add', { name, fps }, 'mcp') // clip.add creates exactly ONE frame
    let clip = getBus().getProject().clips[getBus().getProject().clips.length - 1]!
    for (let f = 1; f < count; f++) {
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

  followCommandTarget({ clipId: createdClipId }) // the user watches the strip land
  // hmr-touch: ensures background tabs receive the latest executor bundle

  const after = getBus().getProject().clips.find((c) => c.id === createdClipId)!
  return {
    ok: true as const,
    data: {
      clipId: after.id,
      clipName: after.name,
      frames: after.frames.length,
      grid: { columns, rows, cellW, cellH },
      fps,
    },
    undoable: true,
    stateHash: null,
    summary: `Imported ${count}-frame strip "${name}" (${columns}×${rows} grid @ ${fps}fps) — one undo step`,
  }
}
