// PixelForge AI — MCP tool executor (editor side, v3.1 §5.3 P0: L0 + L1).
//
// This module is the SINGLE execution plane for MCP tools: the server relays
// every tool call here (over the editor WebSocket), and this file executes it
// on the REAL CommandBus — the same bus, validation, history and undo/redo as
// manual editing. Nothing mutates a document buffer directly: pixel writes go
// through `pixels.applyOp` (tile-diff history), structural edits through the
// builtin commands with origin 'mcp', and whole-document replacement only via
// the store's load path.
//
// DEFERRED (not implemented here, per v3.1 dependencies):
//   L2/L3 tools → P1 approval center (Task 11) — structurally unregistered.
// Task 9 adds get_candidates (L0) + accept_candidate / reject_candidate /
// apply_normalize (L1) over the shared AI candidate store — the paid
// generation itself stays OFF the MCP surface until the Task 11 approval
// center (v3.1 §5.2: generate_sprite is L3).
// Task 10 adds the motion set: suggest_motion_preset (L0 helper, pure),
// set_parts (L1, clip parts = regions never cuts) and apply_motion_preset
// (L1, deterministic composer through the SAME bus command as the UI).

import {
  CommandError,
  buildPlaybackCycle,
  composeFrameRgba,
  crc32,
  createProject as coreCreateProject,
  decodePng,
  encodePng,
  sha256Hex,
  type Clip,
  type Frame,
  type Layer,
  type LoopMode,
  type Project,
  type RGBA,
} from '@pixelforge/core'
import { getBus, useEditor } from './store'
import { hexToRgba } from './color'
import { importLegacyProjectJson, isSerializedProject } from './project-io'
import { AGENT_FETCH_HEADERS } from './agent-headers'

export interface ToolExecResult {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string; hint?: string }
  undoable?: boolean
  stateHash?: string | null
  summary?: string | null
}

export interface ToolExecContext {
  clientId: string
  clientName: string
  tier: 'L0' | 'L1'
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const MAX_SET_PIXELS = 2000 // §5.3: prototype cap kept
const MAX_PREVIEW_FRAMES = 32
const MAX_PREVIEW_BYTES = 6 * 1024 * 1024

// ---------------------------------------------------------------------------
// state hash — deterministic document fingerprint for staleness detection
// ---------------------------------------------------------------------------

export async function computeStateHash(): Promise<string> {
  const p = getBus().getProject()
  const parts: unknown[] = [p.id, p.name, p.width, p.height, p.palette, p.settings]
  for (const clip of p.clips) {
    const celCrcs: Record<string, number> = {}
    for (const frame of clip.frames) {
      for (const [layerId, cel] of Object.entries(frame.cels)) {
        celCrcs[`${frame.id}:${layerId}`] = crc32(cel.buffer as unknown as Uint8Array)
      }
    }
    parts.push({
      id: clip.id,
      name: clip.name,
      fps: clip.fps,
      loop: clip.loop,
      loopMode: clip.loopMode,
      layers: clip.layers,
      parts: clip.parts.length,
      frames: clip.frames.map((f) => ({ id: f.id, durationMs: f.durationMs })),
      cels: celCrcs,
      tags: clip.tags,
    })
  }
  parts.push(p.trash.map((t) => t.id))
  const bytes = new TextEncoder().encode(JSON.stringify(parts))
  return (await sha256Hex(bytes)).slice(0, 32)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fail(code: string, message: string, hint?: string): ToolExecResult {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asInt(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max) {
    throw new CommandError('VALIDATION_FAILED', `${what} must be an integer in [${min}, ${max}]`)
  }
  return v
}

function optInt(v: unknown, what: string, min: number, max: number): number | undefined {
  return v === undefined ? undefined : asInt(v, what, min, max)
}

function asHex(v: unknown, what: string): string {
  if (typeof v !== 'string' || !HEX_RE.test(v)) {
    throw new CommandError('VALIDATION_FAILED', `${what} must be a hex color like #rrggbb`)
  }
  return v.toLowerCase()
}

function asString(v: unknown, what: string, max: number, min = 1): string {
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) {
    throw new CommandError('VALIDATION_FAILED', `${what} must be a string of ${min}–${max} chars`)
  }
  return v.trim()
}

function asRgba(hex: string): RGBA {
  return hexToRgba(hex)
}

function resolveClipRef(project: Project, args: Record<string, unknown>): Clip {
  const clipId = typeof args.clipId === 'string' ? args.clipId : undefined
  const clipName = typeof args.clipName === 'string' ? args.clipName : undefined
  if (clipId) {
    const clip = project.clips.find((c) => c.id === clipId)
    if (!clip) throw new CommandError('NOT_FOUND', `clip "${clipId}" not found`)
    return clip
  }
  if (clipName) {
    const clip = project.clips.find((c) => c.name === clipName)
    if (!clip) throw new CommandError('NOT_FOUND', `clip named "${clipName}" not found`)
    return clip
  }
  const state = useEditor.getState()
  const active = project.clips.find((c) => c.id === state.activeClipId) ?? project.clips[0]
  if (!active) throw new CommandError('INVALID_STATE', 'project has no clips')
  return active
}

function resolveFrameRef(clip: Clip, args: Record<string, unknown>): { frame: Frame; index: number } {
  const frameId = typeof args.frameId === 'string' ? args.frameId : undefined
  if (frameId) {
    const index = clip.frames.findIndex((f) => f.id === frameId)
    if (index < 0) throw new CommandError('NOT_FOUND', `frame "${frameId}" not found in clip "${clip.name}"`)
    return { frame: clip.frames[index]!, index }
  }
  const raw = args.frameIndex
  if (raw !== undefined) {
    const index = asInt(raw, 'frameIndex', 0, Math.max(0, clip.frames.length - 1))
    return { frame: clip.frames[index]!, index }
  }
  const state = useEditor.getState()
  const index = Math.min(Math.max(0, state.activeFrameIndex), clip.frames.length - 1)
  return { frame: clip.frames[index]!, index }
}

function resolveLayerRef(clip: Clip, args: Record<string, unknown>): Layer {
  const layerId = typeof args.layerId === 'string' ? args.layerId : undefined
  if (layerId) {
    const layer = clip.layers.find((l) => l.id === layerId)
    if (!layer) throw new CommandError('NOT_FOUND', `layer "${layerId}" not found in clip "${clip.name}"`)
    return layer
  }
  const layerName = typeof args.layerName === 'string' ? args.layerName : undefined
  if (layerName) {
    const layer = clip.layers.find((l) => l.name === layerName)
    if (!layer) throw new CommandError('NOT_FOUND', `layer named "${layerName}" not found in clip "${clip.name}"`)
    return layer
  }
  const state = useEditor.getState()
  const active = clip.layers.find((l) => l.id === state.activeLayerId) ?? clip.layers[clip.layers.length - 1]
  if (!active) throw new CommandError('INVALID_STATE', `clip "${clip.name}" has no layers`)
  return active
}

/** Execute one bus command with MCP origin. Returns the new project. */
function execCommand(type: string, payload: unknown, label?: string): Project {
  const outcome = getBus().execute(type, payload, 'mcp', label ? { label } : {})
  return outcome.project
}

/** Run several bus commands as ONE undoable transaction step. */
function execTransaction(label: string, fn: () => void): void {
  getBus().transaction(label, 'mcp', fn)
}

function envelope(data: unknown, opts: { undoable?: boolean; stateHash?: string; summary?: string } = {}): ToolExecResult {
  return { ok: true, data, undoable: opts.undoable ?? false, stateHash: opts.stateHash ?? null, summary: opts.summary ?? null }
}

function base64FromBytes(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

async function pngDataUrl(width: number, height: number, rgba: Uint8ClampedArray): Promise<string> {
  const png = await encodePng(width, height, rgba)
  return `data:image/png;base64,${base64FromBytes(png)}`
}

/** Nearest-neighbor downscale (deterministic, interpolation-free). */
function nnScale(rgba: Uint8ClampedArray, w: number, h: number, scale: 0.25 | 0.5 | 1): { rgba: Uint8ClampedArray; w: number; h: number } {
  if (scale === 1) return { rgba, w, h }
  const ow = Math.max(1, Math.floor(w * scale))
  const oh = Math.max(1, Math.floor(h * scale))
  const out = new Uint8ClampedArray(ow * oh * 4)
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale))
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale))
      const si = (sy * w + sx) * 4
      const di = (y * ow + x) * 4
      out[di] = rgba[si]!
      out[di + 1] = rgba[si + 1]!
      out[di + 2] = rgba[si + 2]!
      out[di + 3] = rgba[si + 3]!
    }
  }
  return { rgba: out, w: ow, h: oh }
}

function clipSummary(clip: Clip): Record<string, unknown> {
  return {
    id: clip.id,
    name: clip.name,
    fps: clip.fps,
    loop: clip.loop,
    loopMode: clip.loopMode,
    tags: clip.tags,
    layerCount: clip.layers.length,
    frameCount: clip.frames.length,
  }
}

function clipDetail(clip: Clip): Record<string, unknown> {
  return {
    ...clipSummary(clip),
    layers: clip.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, linked: l.linked })),
    parts: clip.parts.map((p) => ({ id: p.id, name: p.name, layerId: p.layerId, rect: p.rect ?? null, z: p.z })),
    frames: clip.frames.map((f, i) => ({
      id: f.id,
      index: i,
      durationMs: f.durationMs,
      cels: Object.fromEntries(
        Object.entries(f.cels).map(([layerId, cel]) => [
          layerId,
          { linked: cel.linked, hasPixels: !cel.buffer.every((v) => v === 0) },
        ])
      ),
    })),
  }
}

async function framePng(project: Project, clip: Clip, frame: Frame, scale: 0.25 | 0.5 | 1): Promise<string> {
  const composed = composeFrameRgba(project, clip, frame)
  const scaled = nnScale(composed, project.width, project.height, scale)
  return pngDataUrl(scaled.w, scaled.h, scaled.rgba)
}

async function withStateHash(data: unknown, opts: { undoable?: boolean; summary?: string } = {}): Promise<ToolExecResult> {
  return envelope(data, { undoable: opts.undoable, summary: opts.summary, stateHash: await computeStateHash() })
}

// ---------------------------------------------------------------------------
// per-tool implementations
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>, ctx: ToolExecContext) => Promise<ToolExecResult>;

const handlers: Record<string, ToolHandler> = {
  // ---------------------------------------------------------------- L0 read
  async get_project_state() {
    const bus = getBus()
    const project = bus.getProject()
    const state = useEditor.getState()
    const data = {
      name: project.name,
      projectId: project.id,
      width: project.width,
      height: project.height,
      dirty: bus.isDirty(),
      palette: [...project.palette],
      settings: { paletteEnforce: project.settings.paletteEnforce, onion: { ...project.settings.onion } },
      trash: project.trash.map((t) => ({ id: t.id, label: t.label, kind: t.item.kind, deletedAt: t.deletedAt })),
      clips: project.clips.map(clipSummary),
      activePointers: {
        clipId: state.activeClipId,
        frameIndex: state.activeFrameIndex,
        layerId: state.activeLayerId,
      },
      history: { canUndo: bus.canUndo(), canRedo: bus.canRedo() },
    }
    return withStateHash(data)
  },

  async list_projects() {
    try {
      const res = await fetch('/api/projects', { headers: AGENT_FETCH_HEADERS })
      const json = (await res.json()) as { ok: boolean; projects?: Array<{ id: string; name: string; width: number; height: number; updatedAt: string }>; error?: string }
      if (!json.ok) return fail('persistence_error', json.error ?? 'Failed to list projects')
      return withStateHash({ count: json.projects?.length ?? 0, projects: json.projects ?? [] })
    } catch (err) {
      return fail('persistence_error', err instanceof Error ? err.message : 'Failed to list projects')
    }
  },

  async get_clip(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    return withStateHash(clipDetail(clip))
  },

  async get_frame_png(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const raw = args.scale
    const scale = raw === undefined ? 1 : (raw === 0.5 || raw === 0.25 ? raw : asInt(raw, 'scale', 0.25, 1))
    const dataUrl = await framePng(project, clip, frame, scale as 0.25 | 0.5 | 1)
    return withStateHash({
      clipId: clip.id,
      frameId: frame.id,
      width: Math.max(1, Math.floor(project.width * (scale as number))),
      height: Math.max(1, Math.floor(project.height * (scale as number))),
      scale,
      png: dataUrl,
    })
  },

  async get_palette() {
    const project = getBus().getProject()
    return withStateHash({
      palette: [...project.palette],
      paletteEnforce: project.settings.paletteEnforce,
    })
  },

  async preview_animation(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const maxFrames = optInt(args.maxFrames, 'maxFrames', 1, 64) ?? MAX_PREVIEW_FRAMES
    if (clip.frames.length === 0) return fail('not_found', `clip "${clip.name}" has no frames`)
    const cycle = buildPlaybackCycle(clip)
    const count = Math.min(clip.frames.length, maxFrames)
    const frames: string[] = []
    let bytes = 0
    for (let i = 0; i < count; i++) {
      const dataUrl = await framePng(project, clip, clip.frames[i]!, 1)
      bytes += dataUrl.length
      if (bytes > MAX_PREVIEW_BYTES) {
        return fail('response_too_large', `Preview exceeded ${MAX_PREVIEW_BYTES} bytes after ${i} frames — use get_frame_png per frame or a smaller canvas.`)
      }
      frames.push(dataUrl)
    }
    return withStateHash({
      clipId: clip.id,
      name: clip.name,
      width: project.width,
      height: project.height,
      fps: clip.fps,
      loop: clip.loop,
      loopMode: clip.loopMode,
      cycleMs: cycle.totalMs,
      schedule: cycle.entries,
      renderedFrames: frames.length,
      totalFrames: clip.frames.length,
      frames,
    })
  },

  async subscribe_events() {
    return withStateHash({
      stateHash: await computeStateHash(),
      notification: {
        method: 'notifications/pixelforge/projectChanged',
        params: { stateHash: 'string | null', name: 'string | null', dirty: 'boolean | null' },
      },
      note: 'The server pushes this MCP notification whenever the document changes (manual or agent edits). Keep the MCP session open to receive it.',
    })
  },

  // ------------------------------------------------------------- L1 writes
  async create_project(args) {
    const bus = getBus()
    if (bus.isDirty()) {
      return fail(
        'dirty_project',
        'The current project has unsaved changes — creating a new project would discard them.',
        'Ask the user to save (Ctrl+S / Save button), then retry create_project. PixelForge never discards work silently.'
      )
    }
    const name = asString(args.name, 'name', 120)
    const width = asInt(args.width, 'width', 16, 256)
    const height = asInt(args.height, 'height', 16, 256)
    const fps = optInt(args.fps, 'fps', 1, 60) ?? 8
    let palette: string[] | undefined
    if (args.palette !== undefined) {
      if (!Array.isArray(args.palette) || args.palette.length === 0 || args.palette.length > 256) {
        throw new CommandError('VALIDATION_FAILED', 'palette must be a 1–256 hex color array')
      }
      palette = args.palette.map((c) => asHex(c, 'palette color'))
    }
    const project = coreCreateProject({
      name,
      width,
      height,
      fps,
      ...(palette ? { palette } : {}),
    })
    useEditor.getState().loadProject(project, { projectId: null })
    return withStateHash(
      { created: true, name, width, height, fps, clipCount: project.clips.length, frameCount: project.clips[0]?.frames.length ?? 0 },
      { summary: `Created project "${name}" (${width}×${height})` }
    )
  },

  async open_project(args) {
    const bus = getBus()
    if (bus.isDirty()) {
      return fail(
        'dirty_project',
        'The current project has unsaved changes — opening another project would discard them.',
        'Ask the user to save (Ctrl+S / Save button), then retry open_project. PixelForge never discards work silently.'
      )
    }
    const projectId = asString(args.projectId, 'projectId', 128)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { headers: AGENT_FETCH_HEADERS })
      const json = (await res.json()) as { ok: boolean; project?: unknown; error?: string }
      if (!json.ok || !json.project) return fail('not_found', json.error ?? `project "${projectId}" not found`)
      if (!isSerializedProject(json.project)) return fail('persistence_error', 'Stored project failed schema validation')
      const { project } = await importLegacyProjectJson(json.project, projectId)
      useEditor.getState().loadProject(project, { projectId })
      return withStateHash(
        { opened: true, projectId, name: project.name, width: project.width, height: project.height, clipCount: project.clips.length },
        { summary: `Opened project "${project.name}"` }
      )
    } catch (err) {
      return fail('persistence_error', err instanceof Error ? err.message : 'Failed to open project')
    }
  },

  async add_frame(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const afterIndex = optInt(args.afterIndex, 'afterIndex', -1, Math.max(0, clip.frames.length - 1))
    const copy = args.copyContent === true
    execCommand('frame.add', { clipId: clip.id, ...(afterIndex !== undefined ? { afterIndex } : {}), ...(copy ? { copy: true } : {}) })
    const after = getBus().getProject().clips.find((c) => c.id === clip.id)!
    const newIndex = (afterIndex !== undefined ? afterIndex + 1 : after.frames.length - 1)
    return withStateHash(
      { clipId: clip.id, frameId: after.frames[newIndex]?.id ?? null, frameIndex: newIndex, frameCount: after.frames.length },
      { undoable: true, summary: `${copy ? 'Duplicated' : 'Added'} frame ${newIndex} in "${clip.name}"` }
    )
  },

  async duplicate_frame(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { index } = resolveFrameRef(clip, args)
    execCommand('frame.add', { clipId: clip.id, afterIndex: index, copy: true })
    return withStateHash(
      { clipId: clip.id, frameIndex: index + 1, frameCount: clip.frames.length + 1 },
      { undoable: true, summary: `Duplicated frame ${index} in "${clip.name}"` }
    )
  },

  async reorder_frames(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const from = asInt(args.from, 'from', 0, Math.max(0, clip.frames.length - 1))
    const to = asInt(args.to, 'to', 0, Math.max(0, clip.frames.length - 1))
    execCommand('frame.move', { clipId: clip.id, from, to })
    return withStateHash({ clipId: clip.id, from, to, frameCount: clip.frames.length }, { undoable: true, summary: `Moved frame ${from} → ${to} in "${clip.name}"` })
  },

  async delete_frame(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { index } = resolveFrameRef(clip, args)
    execCommand('frame.delete', { clipId: clip.id, frameIndex: index })
    const trash = getBus().getProject().trash
    return withStateHash(
      { clipId: clip.id, deletedFrameIndex: index, trashEntry: trash[trash.length - 1]?.id ?? null },
      { undoable: true, summary: `Deleted frame ${index} from "${clip.name}" (trash-backed)` }
    )
  },

  async restore_from_trash(args) {
    const entryId = asString(args.entryId, 'entryId', 128)
    execCommand('trash.restore', { entryId })
    return withStateHash({ restored: entryId }, { undoable: true, summary: `Restored trash entry ${entryId}` })
  },

  async set_pixels(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const layer = resolveLayerRef(clip, args)
    const pixels = args.pixels
    if (!Array.isArray(pixels) || pixels.length === 0) throw new CommandError('VALIDATION_FAILED', 'pixels must be a non-empty array (max 2000)')
    if (pixels.length > MAX_SET_PIXELS) throw new CommandError('VALIDATION_FAILED', `max ${MAX_SET_PIXELS} pixels per call`)
    const fallback = args.color !== undefined ? asHex(args.color, 'color') : null
    let color: RGBA | null = null
    const ops = pixels.map((p, i) => {
      if (!isRecord(p)) throw new CommandError('VALIDATION_FAILED', `pixels[${i}] must be an object`)
      const x = asInt(p.x, `pixels[${i}].x`, -100000, 100000)
      const y = asInt(p.y, `pixels[${i}].y`, -100000, 100000)
      if (x < 0 || y < 0 || x >= project.width || y >= project.height) {
        throw new CommandError('VALIDATION_FAILED', `pixels[${i}] (${x},${y}) is outside the canvas (${project.width}×${project.height})`)
      }
      const hex = p.color !== undefined ? asHex(p.color, `pixels[${i}].color`) : fallback
      if (!hex) throw new CommandError('VALIDATION_FAILED', `pixels[${i}] has no color and no top-level "color" was given`)
      if (!color) color = asRgba(hex)
      return { op: 'stamp' as const, x, y }
    })
    execCommand('pixels.applyOp', { clipId: clip.id, frameId: frame.id, layerId: layer.id, color, ops })
    return withStateHash(
      { applied: ops.length, clipId: clip.id, frameId: frame.id, layerId: layer.id },
      { undoable: true, summary: `Painted ${ops.length} pixel(s) on "${clip.name}" / "${layer.name}"` }
    )
  },

  async fill_rect(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const layer = resolveLayerRef(clip, args)
    if (!isRecord(args.from) || !isRecord(args.to)) throw new CommandError('VALIDATION_FAILED', 'from/to must be {x, y} points')
    const from = { x: asInt(args.from.x, 'from.x', -100000, 100000), y: asInt(args.from.y, 'from.y', -100000, 100000) }
    const to = { x: asInt(args.to.x, 'to.x', -100000, 100000), y: asInt(args.to.y, 'to.y', -100000, 100000) }
    const hex = asHex(args.color, 'color')
    const filled = args.filled === undefined ? true : args.filled === true
    execCommand('pixels.applyOp', {
      clipId: clip.id,
      frameId: frame.id,
      layerId: layer.id,
      color: asRgba(hex),
      ops: [{ op: 'rect' as const, from, to, filled }],
    })
    return withStateHash(
      { clipId: clip.id, frameId: frame.id, layerId: layer.id, from, to, filled },
      { undoable: true, summary: `${filled ? 'Filled' : 'Outlined'} rect in "${clip.name}" / "${layer.name}"` }
    )
  },

  async replace_color(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const layer = resolveLayerRef(clip, args)
    const fromHex = asHex(args.from, 'from')
    const toHex = asHex(args.to, 'to')
    const cel = frame.cels[layer.id]
    if (!cel) return fail('not_found', `layer "${layer.name}" has no cel on frame ${frame.id}`)
    const from = asRgba(fromHex)
    const to = asRgba(toHex)
    const src = cel.buffer
    let replaced = 0
    const out = new Uint8ClampedArray(src)
    const exact = fromHex.length > 4 // #rrggbb(+aa) matches alpha too
    for (let i = 0; i < src.length; i += 4) {
      const match = exact
        ? src[i] === from[0] && src[i + 1] === from[1] && src[i + 2] === from[2] && src[i + 3] === from[3]
        : src[i] === from[0] && src[i + 1] === from[1] && src[i + 2] === from[2] && (from[3] === 255 ? src[i + 3] === 255 : true)
      if (match) {
        out[i] = to[0]
        out[i + 1] = to[1]
        out[i + 2] = to[2]
        out[i + 3] = to[3]
        replaced++
      }
    }
    if (replaced > 0) {
      execCommand('pixels.applyOp', { clipId: clip.id, frameId: frame.id, layerId: layer.id, ops: [{ op: 'setBuffer' as const, buffer: out }] })
    }
    return withStateHash(
      { replaced, clipId: clip.id, frameId: frame.id, layerId: layer.id },
      { undoable: replaced > 0, summary: `Replaced ${replaced} px of ${fromHex} with ${toHex} on "${clip.name}" / "${layer.name}"` }
    )
  },

  async flip_frame(args) {
    return runCelTransform(args, (op) => ({
      op: args.axis === 'vertical' ? ('flipV' as const) : ('flipH' as const),
      ...(op ? { rect: op } : {}),
    }), 'Flip')
  },

  async rotate_frame(args) {
    return runCelTransform(args, (op) => ({
      op: args.direction === 'ccw' ? ('rotateCCW' as const) : ('rotateCW' as const),
      ...(op ? { rect: op } : {}),
    }), 'Rotate')
  },

  async shift_frame(args) {
    const dx = asInt(args.dx, 'dx', -4096, 4096)
    const dy = asInt(args.dy, 'dy', -4096, 4096)
    return runCelTransform(args, () => ({ op: 'shift' as const, dx, dy }), 'Shift')
  },

  async add_clip(args) {
    const name = asString(args.name, 'name', 60)
    const project = getBus().getProject()
    if (project.clips.some((c) => c.name === name)) return fail('already_exists', `clip "${name}" already exists`)
    const fps = optInt(args.fps, 'fps', 1, 60) ?? 8
    const frameCount = optInt(args.frameCount, 'frameCount', 1, 64) ?? 1
    execCommand('clip.add', { name, fps })
    const created = getBus().getProject().clips.find((c) => c.name === name)
    if (!created) return fail('internal_error', 'clip vanished after creation')
    if (frameCount > 1) {
      execTransaction(`Add clip "${name}"`, () => {
        for (let i = 1; i < frameCount; i++) {
          getBus().execute('frame.add', { clipId: created.id }, 'mcp')
        }
      })
    }
    return withStateHash(
      { clipId: created.id, name, fps, frameCount: getBus().getProject().clips.find((c) => c.id === created.id)?.frames.length ?? 1 },
      { undoable: true, summary: `Created clip "${name}" (${frameCount} frame(s) @ ${fps} fps)` }
    )
  },

  async set_clip_props(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const patch: Record<string, unknown> = {}
    if (args.name !== undefined) patch.name = asString(args.name, 'name', 120)
    if (args.fps !== undefined) patch.fps = asInt(args.fps, 'fps', 1, 60)
    if (args.loop !== undefined) patch.loop = args.loop === true
    if (args.loopMode !== undefined) {
      const mode = args.loopMode
      if (mode !== 'forward' && mode !== 'reverse' && mode !== 'pingpong') {
        throw new CommandError('VALIDATION_FAILED', 'loopMode must be forward | reverse | pingpong')
      }
      patch.loopMode = mode as LoopMode
    }
    if (Object.keys(patch).length === 0) throw new CommandError('VALIDATION_FAILED', 'provide at least one of name/fps/loop/loopMode')
    execCommand('clip.setProps', { clipId: clip.id, patch })
    return withStateHash({ clipId: clip.id, patch }, { undoable: true, summary: `Updated clip "${clip.name}"` })
  },

  async delete_clip(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    execCommand('clip.delete', { clipId: clip.id })
    const trash = getBus().getProject().trash
    return withStateHash(
      { deletedClipId: clip.id, trashEntry: trash[trash.length - 1]?.id ?? null },
      { undoable: true, summary: `Deleted clip "${clip.name}" (trash-backed)` }
    )
  },

  async add_layer(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const name = args.name !== undefined ? asString(args.name, 'name', 120) : undefined
    execCommand('layer.add', { clipId: clip.id, ...(name ? { name } : {}) })
    const after = getBus().getProject().clips.find((c) => c.id === clip.id)!
    const created = after.layers[after.layers.length - 1]!
    return withStateHash(
      { clipId: clip.id, layerId: created.id, layerName: created.name, layerCount: after.layers.length },
      { undoable: true, summary: `Added layer "${created.name}" to "${clip.name}"` }
    )
  },

  async duplicate_layer(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const layer = resolveLayerRef(clip, args)
    execCommand('layer.duplicate', { clipId: clip.id, layerId: layer.id })
    const after = getBus().getProject().clips.find((c) => c.id === clip.id)!
    const index = after.layers.findIndex((l) => l.id === layer.id)
    const created = after.layers[index + 1] ?? null
    return withStateHash(
      { clipId: clip.id, sourceLayerId: layer.id, newLayerId: created?.id ?? null, newLayerName: created?.name ?? null },
      { undoable: true, summary: `Duplicated layer "${layer.name}" in "${clip.name}"` }
    )
  },

  async delete_layer(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const layer = resolveLayerRef(clip, args)
    execCommand('layer.delete', { clipId: clip.id, layerId: layer.id })
    const trash = getBus().getProject().trash
    return withStateHash(
      { deletedLayerId: layer.id, trashEntry: trash[trash.length - 1]?.id ?? null },
      { undoable: true, summary: `Deleted layer "${layer.name}" (trash-backed)` }
    )
  },

  async set_layer_props(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const layer = resolveLayerRef(clip, args)
    const patch: Record<string, unknown> = {}
    if (args.name !== undefined) patch.name = asString(args.name, 'name', 120)
    if (args.visible !== undefined) patch.visible = args.visible === true
    if (args.opacity !== undefined) {
      if (typeof args.opacity !== 'number' || args.opacity < 0 || args.opacity > 1) {
        throw new CommandError('VALIDATION_FAILED', 'opacity must be a number 0..1')
      }
      patch.opacity = args.opacity
    }
    if (Object.keys(patch).length === 0) throw new CommandError('VALIDATION_FAILED', 'provide at least one of name/visible/opacity')
    execCommand('layer.setProps', { clipId: clip.id, layerId: layer.id, patch })
    return withStateHash({ clipId: clip.id, layerId: layer.id, patch }, { undoable: true, summary: `Updated layer "${layer.name}"` })
  },

  async reorder_layers(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const layer = resolveLayerRef(clip, args)
    const dir = args.direction === 'up' ? 1 : args.direction === 'down' ? -1 : null
    if (dir === null) throw new CommandError('VALIDATION_FAILED', 'direction must be "up" or "down"')
    execCommand('layer.move', { clipId: clip.id, layerId: layer.id, dir })
    return withStateHash({ clipId: clip.id, layerId: layer.id, direction: args.direction }, { undoable: true, summary: `Moved layer "${layer.name}" ${args.direction}` })
  },

  async merge_down(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const layer = resolveLayerRef(clip, args)
    execCommand('layer.mergeDown', { clipId: clip.id, layerId: layer.id })
    return withStateHash({ clipId: clip.id, mergedLayerId: layer.id }, { undoable: true, summary: `Merged "${layer.name}" down in "${clip.name}"` })
  },

  async add_palette_color(args) {
    const hex = asHex(args.hex, 'hex')
    execCommand('palette.addColor', { hex })
    return withStateHash({ added: hex, palette: [...getBus().getProject().palette] }, { undoable: true, summary: `Added ${hex} to the palette` })
  },

  async set_palette(args) {
    if (!Array.isArray(args.colors) || args.colors.length === 0 || args.colors.length > 256) {
      throw new CommandError('VALIDATION_FAILED', 'colors must be a 1–256 hex color array')
    }
    const colors = args.colors.map((c) => asHex(c, 'colors[]'))
    execCommand('palette.replaceAll', { colors })
    return withStateHash({ palette: colors }, { undoable: true, summary: `Replaced the palette (${colors.length} colors)` })
  },

  async import_image_as_layer(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const name = args.name !== undefined ? asString(args.name, 'name', 120) : undefined
    const raw = asString(args.pngBase64, 'pngBase64', 2_800_000)
    const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
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
    if (decoded.width !== project.width || decoded.height !== project.height) {
      return fail(
        'dimension_mismatch',
        `PNG is ${decoded.width}×${decoded.height} but the canvas is ${project.width}×${project.height} — resize externally first.`,
        'import_image_as_layer never resizes: import the exact canvas size.'
      )
    }
    execTransaction(`Import image layer${name ? ` "${name}"` : ''}`, () => {
      getBus().execute('layer.add', { clipId: clip.id, ...(name ? { name } : {}) }, 'mcp')
      const created = getBus().getProject().clips.find((c) => c.id === clip.id)!.layers.slice(-1)[0]!
      getBus().execute(
        'pixels.applyOp',
        { clipId: clip.id, frameId: frame.id, layerId: created.id, ops: [{ op: 'setBuffer', buffer: decoded.rgba }] },
        'mcp'
      )
    })
    const after = getBus().getProject().clips.find((c) => c.id === clip.id)!
    const created = after.layers[after.layers.length - 1]!
    return withStateHash(
      { clipId: clip.id, frameId: frame.id, layerId: created.id, layerName: created.name },
      { undoable: true, summary: `Imported image as layer "${created.name}" on "${clip.name}"` }
    )
  },

  // ------------------------------------------------- AI candidates (Task 9)

  async get_candidates(args) {
    const { aiCandidateStore } = await import('./ai/candidates')
    const state = aiCandidateStore.getState()
    const limit = optInt(args.limit, 'limit', 1, 8) ?? 8
    const includeImages = args.includeImages === true
    const candidates = state.candidates.slice(0, limit)
    const out: Record<string, unknown>[] = []
    for (const c of candidates) {
      const item: Record<string, unknown> = {
        id: c.id,
        status: c.status,
        prompt: c.prompt,
        providerId: c.providerId,
        providerLabel: c.providerLabel,
        model: c.model,
        recipe: c.recipe,
        requestSize: c.requestSize,
        width: c.width,
        height: c.height,
        seed: c.seed,
        createdAt: c.createdAt,
        jobDurationMs: c.jobDurationMs,
        costEstimateUsd: c.costEstimateUsd,
        cacheHit: c.cacheHit,
        hasNormalized: !!c.normalized,
        normalizedSize: c.normalized ? { w: c.normalized.w, h: c.normalized.h, colors: c.normalized.colors } : null,
        error: c.error,
      }
      if (c.normalized) {
        // bounded preview: the normalized buffer at 1:1 (≤512² by pipeline rule)
        item.normalizedPng = await pngDataUrl(c.normalized.w, c.normalized.h, c.normalized.buffer)
      }
      if (includeImages && c.originalSrc && c.originalSrc.length <= 2_600_000) {
        item.originalSrc = c.originalSrc
      }
      out.push(item)
    }
    return withStateHash(
      { candidates: out, historyCount: state.history.length },
      { summary: `${out.length} AI candidate(s) in review cache` },
    )
  },

  async accept_candidate(args) {
    const { aiCandidateStore, registerAcceptedTarget } = await import('./ai/candidates')
    const { fitBufferToCanvas } = await import('@pixelforge/core')
    const id = asString(args.candidateId, 'candidateId', 128)
    const mode = args.mode === 'frame' ? 'frame' : args.mode === 'layer' ? 'layer' : null
    if (!mode) throw new CommandError('VALIDATION_FAILED', "mode must be 'layer' or 'frame'")
    const candidate = aiCandidateStore.getState().get(id)
    if (!candidate) {
      return fail('not_found', `Candidate "${id}" is not in the review cache.`, 'Call get_candidates for the current ids.')
    }
    if (!candidate.normalized) {
      return fail('not_ready', 'Candidate has no normalized buffer yet — wait for normalization or call apply_normalize.')
    }
    const project = getBus().getProject()
    // candidates may be normalized at any sprite size — center 1:1 onto the cel
    let buffer: Uint8ClampedArray
    try {
      buffer = fitBufferToCanvas(candidate.normalized.buffer, candidate.normalized.w, candidate.normalized.h, project.width, project.height)
    } catch {
      return fail(
        'dimension_mismatch',
        `Normalized candidate is ${candidate.normalized.w}×${candidate.normalized.h} but the canvas is ${project.width}×${project.height} — re-normalize with apply_normalize first.`,
      )
    }
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const name = `AI: ${candidate.prompt.slice(0, 24)}`

    if (mode === 'layer') {
      execTransaction(`Import AI candidate as layer (${id})`, () => {
        getBus().execute('layer.add', { clipId: clip.id, name }, 'mcp')
        const created = getBus().getProject().clips.find((c) => c.id === clip.id)!.layers.slice(-1)[0]!
        getBus().execute(
          'pixels.applyOp',
          { clipId: clip.id, frameId: frame.id, layerId: created.id, ops: [{ op: 'setBuffer', buffer }] },
          'mcp',
        )
      })
      const after = getBus().getProject().clips.find((c) => c.id === clip.id)!
      const created = after.layers[after.layers.length - 1]!
      // undo/delete of this layer unlocks the candidate again (reconcile)
      registerAcceptedTarget(id, { kind: 'layer', clipId: clip.id, targetId: created.id })
      aiCandidateStore.getState().patch(id, { status: 'accepted' })
      return withStateHash(
        { candidateId: id, mode, clipId: clip.id, frameId: frame.id, layerId: created.id, layerName: created.name },
        { undoable: true, summary: `Accepted AI candidate "${id}" as layer "${created.name}"` },
      )
    }

    // frame mode: new empty frame right after the target + buffer on the frame's top layer
    const frameIndex = clip.frames.findIndex((f) => f.id === frame.id)
    let newFrameId: string | null = null
    execTransaction(`Import AI candidate as frame (${id})`, () => {
      getBus().execute('frame.add', { clipId: clip.id, afterIndex: frameIndex, copy: false }, 'mcp')
      const after = getBus().getProject().clips.find((c) => c.id === clip.id)!
      const newFrame = after.frames[frameIndex + 1]
      if (!newFrame) throw new CommandError('INVALID_STATE', 'frame add produced no frame')
      newFrameId = newFrame.id
      const layer = resolveLayerRef(after, { ...args, layerId: undefined, layerName: undefined })
      getBus().execute(
        'pixels.applyOp',
        { clipId: clip.id, frameId: newFrame.id, layerId: layer.id, ops: [{ op: 'setBuffer', buffer }] },
        'mcp',
      )
    })
    if (newFrameId) {
      // undo/delete of this frame unlocks the candidate again (reconcile)
      registerAcceptedTarget(id, { kind: 'frame', clipId: clip.id, targetId: newFrameId })
    }
    aiCandidateStore.getState().patch(id, { status: 'accepted' })
    return withStateHash(
      { candidateId: id, mode, clipId: clip.id, frameId: newFrameId, frameIndex: frameIndex + 1 },
      { undoable: true, summary: `Accepted AI candidate "${id}" as frame ${frameIndex + 2} in "${clip.name}"` },
    )
  },

  async reject_candidate(args) {
    const { aiCandidateStore } = await import('./ai/candidates')
    const id = asString(args.candidateId, 'candidateId', 128)
    const candidate = aiCandidateStore.getState().get(id)
    if (!candidate) {
      return fail('not_found', `Candidate "${id}" is not in the review cache.`)
    }
    aiCandidateStore.getState().patch(id, { status: 'rejected' })
    aiCandidateStore.getState().remove(id)
    return withStateHash(
      { candidateId: id, rejected: true },
      { undoable: false, summary: `Rejected AI candidate "${id}" (review cache only — document untouched)` },
    )
  },

  // ------------------------------------------------- motion presets (Task 10)

  async suggest_motion_preset(args) {
    const { suggestMotionPreset } = await import('@pixelforge/core')
    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    if (!prompt.trim()) {
      throw new CommandError('VALIDATION_FAILED', 'prompt must be a non-empty string')
    }
    const suggestion = suggestMotionPreset(prompt.slice(0, 500))
    return withStateHash(
      {
        suggested: suggestion
          ? {
              preset: suggestion.preset,
              label: suggestion.label,
              params: suggestion.params,
              matched: suggestion.matched,
              reason: suggestion.reason,
            }
          : null,
      },
      {
        undoable: false,
        summary: suggestion
          ? `Suggested motion preset "${suggestion.preset}" (matched "${suggestion.matched}")`
          : 'No motion preset matched the prompt',
      },
    )
  },

  async set_parts(args) {
    const { rectsIntersect } = await import('@pixelforge/core')
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    if (!Array.isArray(args.parts)) {
      throw new CommandError('VALIDATION_FAILED', 'parts must be an array of {name, layerId|layerName, rect?, anchorFrameIndex?, z?}')
    }
    if (args.parts.length > 32) {
      throw new CommandError('VALIDATION_FAILED', 'at most 32 parts per clip')
    }
    const parts = args.parts.map((raw: unknown, i: number) => {
      if (!isRecord(raw)) throw new CommandError('VALIDATION_FAILED', `parts[${i}] must be an object`)
      const name = asString(raw.name, `parts[${i}].name`, 40)
      const layer = resolveLayerRef(clip, {
        layerId: typeof raw.layerId === 'string' ? raw.layerId : undefined,
        layerName: typeof raw.layerName === 'string' ? raw.layerName : undefined,
      })
      let rect: { x: number; y: number; w: number; h: number } | undefined
      if (raw.rect !== undefined) {
        if (!isRecord(raw.rect)) throw new CommandError('VALIDATION_FAILED', `parts[${i}].rect must be {x, y, w, h}`)
        rect = {
          x: asInt(raw.rect.x, `parts[${i}].rect.x`, 0, project.width - 1),
          y: asInt(raw.rect.y, `parts[${i}].rect.y`, 0, project.height - 1),
          w: asInt(raw.rect.w, `parts[${i}].rect.w`, 1, project.width),
          h: asInt(raw.rect.h, `parts[${i}].rect.h`, 1, project.height),
        }
        if (rect.x + rect.w > project.width || rect.y + rect.h > project.height) {
          throw new CommandError('VALIDATION_FAILED', `parts[${i}].rect extends past the ${project.width}×${project.height} canvas`)
        }
      }
      const anchorFrameIndex =
        raw.anchorFrameIndex !== undefined
          ? asInt(raw.anchorFrameIndex, `parts[${i}].anchorFrameIndex`, 0, Math.max(0, clip.frames.length - 1))
          : undefined
      const z = raw.z !== undefined ? asInt(raw.z, `parts[${i}].z`, -99, 99) : undefined
      return {
        name,
        layerId: layer.id,
        ...(rect ? { rect } : {}),
        ...(anchorFrameIndex !== undefined ? { anchorFrameId: clip.frames[anchorFrameIndex]!.id } : {}),
        ...(z !== undefined ? { z } : {}),
      }
    })
    execCommand('part.set', { clipId: clip.id, parts })
    const after = getBus().getProject().clips.find((c) => c.id === clip.id)
    // overlap report (R2: highest z wins — allowed, but always surfaced)
    const overlaps: Array<{ a: string; b: string; owner: string }> = []
    const list = after?.parts ?? []
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        if (a.layerId !== b.layerId || !a.rect || !b.rect) continue
        if (rectsIntersect(a.rect, b.rect)) {
          overlaps.push({ a: a.name, b: b.name, owner: a.z >= b.z ? a.name : b.name })
        }
      }
    }
    return withStateHash(
      {
        clipId: clip.id,
        clipName: clip.name,
        parts: (after?.parts ?? []).map((p) => ({ id: p.id, name: p.name, layerId: p.layerId, rect: p.rect ?? null, z: p.z })),
        overlaps,
      },
      {
        undoable: true,
        summary: `Set ${parts.length} motion part${parts.length === 1 ? '' : 's'} on "${clip.name}"${overlaps.length > 0 ? ` (${overlaps.length} overlap${overlaps.length === 1 ? '' : 's'} — highest z owns shared pixels)` : ''}`,
      },
    )
  },

  async apply_motion_preset(args) {
    const { analyzeMotionPlan, composeFrameRgba, getPreset, planMotion, PRESET_IDS } = await import('@pixelforge/core')
    const project = getBus().getProject()
    const source = resolveClipRef(project, {
      clipId: typeof args.sourceClipId === 'string' ? args.sourceClipId : undefined,
      clipName: typeof args.sourceClipName === 'string' ? args.sourceClipName : undefined,
    })
    const presetId = typeof args.preset === 'string' ? args.preset : ''
    const preset = getPreset(presetId)
    if (!preset || !(PRESET_IDS as readonly string[]).includes(presetId)) {
      throw new CommandError('VALIDATION_FAILED', `preset must be one of ${PRESET_IDS.join(' | ')}`)
    }
    const params: { amplitude?: number; frameCount?: number; gapFill?: 'none' | 'edge-extend'; smear?: boolean } = {}
    if (args.amplitude !== undefined) {
      const a = args.amplitude
      if (typeof a !== 'number' || !Number.isFinite(a) || a < 0.25 || a > 3) {
        throw new CommandError('VALIDATION_FAILED', 'amplitude must be a number in [0.25, 3]')
      }
      params.amplitude = a
    }
    if (args.frameCount !== undefined) params.frameCount = asInt(args.frameCount, 'frameCount', 1, 64)
    if (args.gapFill !== undefined) {
      if (args.gapFill !== 'none' && args.gapFill !== 'edge-extend') {
        throw new CommandError('VALIDATION_FAILED', 'gapFill must be "none" | "edge-extend"')
      }
      params.gapFill = args.gapFill
    }
    if (args.smear !== undefined) {
      if (typeof args.smear !== 'boolean') throw new CommandError('VALIDATION_FAILED', 'smear must be a boolean')
      params.smear = args.smear
    }
    const anchorFrameIndex =
      args.anchorFrameIndex !== undefined
        ? asInt(args.anchorFrameIndex, 'anchorFrameIndex', 0, Math.max(0, source.frames.length - 1))
        : undefined

    // target (R6): overwrite:true on an existing clip, or a new clip
    let target: { kind: 'new'; name: string; fps?: number } | { kind: 'existing'; clipId: string; overwrite: true }
    if (args.overwrite === true) {
      const targetClip = args.targetClipId ? resolveClipRef(project, { clipId: args.targetClipId }) : source
      target = { kind: 'existing', clipId: targetClip.id, overwrite: true }
    } else {
      const name =
        typeof args.targetName === 'string' && args.targetName.trim()
          ? args.targetName.trim().slice(0, 120)
          : `${presetId}-${project.clips.length}`
      target = { kind: 'new', name, fps: source.fps }
    }

    // the plan is computed by the SAME pure composer the bus command runs —
    // the report is exactly what gets committed (deterministic, $0)
    const plan = planMotion(project, source, { preset: presetId as Parameters<typeof planMotion>[2]['preset'], params, anchorFrameIndex })
    execCommand('motion.apply', { sourceClipId: source.id, preset: presetId, params, anchorFrameIndex, target })
    const issues = analyzeMotionPlan(project, source, plan)

    let previewPng: string | null = null
    if (plan.frames.length > 0 && Object.keys(plan.frames[0].cels).length > 0) {
      const anchor = source.frames[plan.report.anchorFrameIndex]
      const cels = { ...anchor.cels }
      for (const [layerId, buf] of Object.entries(plan.frames[0].cels)) {
        cels[layerId] = { buffer: buf, linked: false }
      }
      previewPng = await pngDataUrl(project.width, project.height, composeFrameRgba(project, source, { id: anchor.id, durationMs: 0, cels }))
    }

    const targetLabel =
      target.kind === 'new' ? `new clip "${target.name}"` : `clip "${getBus().getProject().clips.find((c) => c.id === target.clipId)?.name ?? target.clipId}"`
    const createdClipId =
      target.kind === 'new'
        ? getBus().getProject().clips.find((c) => c.name === target.name)?.id ?? null
        : target.clipId
    return withStateHash(
      {
        preset: presetId,
        frameCount: plan.report.frameCount,
        target: { kind: target.kind, clipId: createdClipId },
        report: plan.report,
        issues,
        previewPng,
      },
      {
        undoable: true,
        summary: `Applied "${presetId}" (${plan.report.frameCount} frames) → ${targetLabel}`,
      },
    )
  },

  async apply_normalize(args) {
    const { aiCandidateStore } = await import('./ai/candidates')
    const { normalizeV2, parseHexColor } = await import('@pixelforge/core')
    const id = asString(args.candidateId, 'candidateId', 128)
    const candidate = aiCandidateStore.getState().get(id)
    if (!candidate) {
      return fail('not_found', `Candidate "${id}" is not in the review cache.`)
    }
    if (!candidate.originalSrc) {
      return fail('not_ready', 'Candidate has no source image to normalize.')
    }
    const project = getBus().getProject()
    // options (all optional; defaults mirror the AI panel)
    const width = optInt(args.width, 'width', 8, 512) ?? project.width
    const height = optInt(args.height, 'height', 8, 512) ?? project.height
    const removeBg = args.removeBg !== false
    const bgTolerance = optInt(args.bgTolerance, 'bgTolerance', 0, 255) ?? 48
    const modeRaw = args.paletteMode
    const paletteMode = modeRaw === 'project' || modeRaw === 'auto' || modeRaw === 'off' ? modeRaw : 'auto'
    const maxColors = optInt(args.maxColors, 'maxColors', 2, 64) ?? 16
    const outlineCleanup = args.outlineCleanup !== false
    let palette: string[] = project.palette
    if (Array.isArray(args.palette)) {
      palette = (args.palette as unknown[]).filter((x): x is string => typeof x === 'string' && parseHexColor(x) !== null)
    }
    // decode the ORIGINAL image (PNG data URL) — the executor runs in the
    // renderer, same process as the store; the pipeline is the deterministic
    // core function (identical output to the panel's worker path)
    const raw = candidate.originalSrc
    const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
    let binary: Uint8Array
    try {
      const bin = atob(b64)
      binary = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) binary[i] = bin.charCodeAt(i)
    } catch {
      return fail('validation_failed', 'candidate source is not valid base64')
    }
    let decoded
    try {
      decoded = await decodePng(binary)
    } catch {
      return fail('validation_failed', 'candidate source is not a decodable PNG (use a PNG candidate or normalize from the AI panel)')
    }
    const res = normalizeV2(decoded.rgba, decoded.width, decoded.height, {
      targetW: width,
      targetH: height,
      removeBg,
      bgTolerance,
      paletteMode,
      palette,
      maxColors,
      outlineCleanup,
    })
    const updated = aiCandidateStore.getState().patch(id, {
      normalized: { buffer: res.buffer, w: res.width, h: res.height, colors: res.stats.colorsOut },
      status: 'review',
      error: null,
    })
    return withStateHash(
      {
        candidateId: id,
        width: res.width,
        height: res.height,
        stats: res.stats,
        previewPng: await pngDataUrl(res.width, res.height, res.buffer),
        ok: !!updated,
      },
      { undoable: false, summary: `Re-normalized candidate "${id}" → ${res.width}×${res.height} (${res.stats.paletteUsed} palette, ${res.stats.colorsOut} colors)` },
    )
  },

  async undo() {
    const result = getBus().undo()
    return withStateHash(
      { undid: result.ok, label: result.label ?? null, skipped: result.skipped ?? 0, canUndo: getBus().canUndo(), canRedo: getBus().canRedo() },
      { summary: result.ok ? `Undid: ${result.label ?? 'change'}` : 'Nothing to undo' }
    )
  },

  async redo() {
    const result = getBus().redo()
    return withStateHash(
      { redid: result.ok, label: result.label ?? null, skipped: result.skipped ?? 0, canUndo: getBus().canUndo(), canRedo: getBus().canRedo() },
      { summary: result.ok ? `Redid: ${result.label ?? 'change'}` : 'Nothing to redo' }
    )
  },
}

/** Shared executor for flip/rotate/shift (single-cel transforms). */
async function runCelTransform(
  args: Record<string, unknown>,
  makeOp: (rect: { x: number; y: number; w: number; h: number } | undefined) => Record<string, unknown>,
  verb: string
): Promise<ToolExecResult> {
  const project = getBus().getProject()
  const clip = resolveClipRef(project, args)
  const { frame } = resolveFrameRef(clip, args)
  const layer = resolveLayerRef(clip, args)
  let rect: { x: number; y: number; w: number; h: number } | undefined
  if (args.rect !== undefined) {
    if (!isRecord(args.rect)) throw new CommandError('VALIDATION_FAILED', 'rect must be {x, y, w, h}')
    rect = {
      x: asInt(args.rect.x, 'rect.x', 0, 1e6),
      y: asInt(args.rect.y, 'rect.y', 0, 1e6),
      w: asInt(args.rect.w, 'rect.w', 1, 4096),
      h: asInt(args.rect.h, 'rect.h', 1, 4096),
    }
  }
  execCommand('pixels.applyOp', { clipId: clip.id, frameId: frame.id, layerId: layer.id, ops: [makeOp(rect)] })
  return withStateHash(
    { clipId: clip.id, frameId: frame.id, layerId: layer.id },
    { undoable: true, summary: `${verb} on "${clip.name}" / "${layer.name}"` }
  )
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export const EXECUTOR_TOOL_NAMES = Object.keys(handlers).sort()

export async function executeMcpTool(tool: string, args: unknown, ctx: ToolExecContext): Promise<ToolExecResult> {
  const handler = handlers[tool]
  if (!handler) {
    return fail('unknown_tool', `Tool "${tool}" is not implemented by this editor (it may be deferred to a later phase).`)
  }
  const bus = getBus()
  if (bus.activeStroke) {
    return fail('editor_busy', 'A manual stroke is in progress — retry in a moment.', 'The tool will run as soon as the pointer interaction ends.')
  }
  const safeArgs = isRecord(args) ? args : {}
  // optimistic staleness guard on every L1 mutation
  const expected = typeof safeArgs.expectedStateHash === 'string' ? safeArgs.expectedStateHash : null
  if (expected) {
    const current = await computeStateHash()
    if (current !== expected) {
      return fail('stale_document', 'The document changed since you read it (expectedStateHash mismatch).', 'Re-read get_project_state and retry with the fresh stateHash.')
    }
  }
  try {
    return await handler(safeArgs, ctx)
  } catch (err) {
    if (err instanceof CommandError) {
      return fail(err.code.toLowerCase(), err.message)
    }
    return fail('internal_error', err instanceof Error ? err.message : 'Tool execution failed')
  }
}
