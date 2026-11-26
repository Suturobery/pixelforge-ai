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
// DEFERRED (not implemented here, per v3.1 dependencies): approval
// persistence stays in-memory v1 until the desktop job queue integration.
// Task 11 landed the L2/L3 set + approval center; Task 8b/8c added the
// knowledge skill set (get_knowledge / study_reference served by the MCP
// server itself, no editor round-trip).
// Task 9 adds get_candidates (L0) + accept_candidate / reject_candidate /
// apply_normalize (L1) over the shared AI candidate store — the paid
// generation itself stays OFF the MCP surface until the Task 11 approval
// center (v3.1 §5.2: generate_sprite is L3).
// Task 10 adds the motion set: suggest_motion_preset (L0 helper, pure),
// set_parts (L1, clip parts = regions never cuts) and apply_motion_preset
// (L1, deterministic composer through the SAME bus command as the UI).

import {
  analyzePixelCraft,
  beautifyLayer,
  buildAsepriteJson,
  buildAtlasAsepriteJson,
  CommandError,
  buildPlaybackCycle,
  collectUniqueOpaqueColors,
  composeAtlasRgba,
  composeFrameRgba,
  composeSheetRgba,
  computeCenterShift,
  computeTrimBounds,
  crc32,
  createProject as coreCreateProject,
  defaultStyleProfile,
  isSpriteTemplateId,
  listSpriteTemplates,
  measureStyleAnchor,
  parseStyleProfile,
  polishLayerPixelArt,
  getSkinPreset,
  remapBufferToPalette,
  renderInspectionRgba,
  renderSpriteTemplate,
  slugify,
  styleProfilePromptTags,
  upscaleRgbaNearest,
  decodePng,
  encodePng,
  harvestPalette,
  uid,
  validateStyleCandidate,
  type AtlasLayout,
  type InspectionScale,
  type StyleCheck,
  type BlendMode,
  type SheetLayout,
  sha256Hex,
  type Clip,
  type ClipTag,
  type Frame,
  type Layer,
  type LoopMode,
  type Project,
  type RGBA,
} from '@pixelforge/core'
import { generateGodot4AtlasTres, type ExportScale } from './export'
import { reviewAssetSet } from './asset-set-review'
import { materializeSkinVariants, type SkinVariantRequest } from './skin-variants'
import {
  beginAiToolActivity,
  describeAiTool,
  diffChangedPixels,
  emitAiDrawPulse,
  emitAiNotice,
  endAiToolActivity,
  isAiAutoFollow,
  isAiPaused,
  recordAiActivityEntry,
} from './ai-live-activity'
import { buildVisualCheck, recommendedInspectionScale } from './ai-visual-check'
import { getBus, useEditor } from './store'
import { MCP_TOOLS } from './mcp-tool-catalog'
import { hexToRgba } from './color'
import { importLegacyProjectJson, isSerializedProject } from './project-io'
import { saveProjectFile } from './project-files'
import { describeApiErrorInline } from './api-error'
import { rememberLastProject } from './last-session'
import { followCommandTarget } from './mcp-follow'
import { importFrameStrip } from './mcp-strip'
import { AGENT_FETCH_HEADERS } from './agent-headers'
import {
  fuzzyFindByName,
  interpretAndEnhancePrompt,
  readBrainMemory,
  recordAgentContextEvent,
  resolveMotionPresetSynonym,
} from './second-brain-intelligence'

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
  tier: 'L0' | 'L1' | 'L2' | 'L3'
  expectedProjectKey?: string
  expectedLoadEpoch?: number
  onReview?: (review: ToolReview) => void
}

interface ReviewFrame {
  buffer: Uint8ClampedArray
  width: number
  height: number
}

export interface ToolReview {
  loadEpoch: number
  clipId: string
  clipName: string
  frameId: string
  frameNumber: number
  layerId?: string
  layerName?: string
  before: ReviewFrame
  after: ReviewFrame
  checks: StyleCheck[]
}

const editorSessionId = uid('editor')

export function currentProjectIdentity(): { key: string; name: string } {
  const { project, projectId, filePath, loadEpoch } = useEditor.getState()
  const key = projectId ? `db:${projectId}` : filePath ? `file:${filePath}` : `unsaved:${editorSessionId}:${loadEpoch}`
  return { key, name: project.name }
}

class TaskProjectMismatch extends Error {
  constructor() {
    super('The active project changed. Open the task’s target project before retrying.')
  }
}

function assertTaskProject(ctx: ToolExecContext): void {
  if (ctx.expectedProjectKey !== undefined && (
    currentProjectIdentity().key !== ctx.expectedProjectKey ||
    useEditor.getState().loadEpoch !== ctx.expectedLoadEpoch
  )) {
    throw new TaskProjectMismatch()
  }
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const MAX_SET_PIXELS = 2000 // §5.3: prototype cap kept
const MAX_PREVIEW_FRAMES = 32
const MAX_PREVIEW_BYTES = 6 * 1024 * 1024
const MAX_EXPORT_PIXELS = 1 << 24 // 2^24 px ≈ 64 MB RGBA (same guard as core sheets)
const MAX_EXPORT_BYTES = 12 * 1024 * 1024 // base64 data-URL response cap

// ---------------------------------------------------------------------------
// state hash — deterministic document fingerprint for staleness detection
// Cached per immutable Project reference and per copy-on-write cel buffer so
// reads are O(1) and writes only CRC the single modified cel buffer.
// ---------------------------------------------------------------------------

const celCrcCache = new WeakMap<Uint8ClampedArray, number>()
const projectHashCache = new WeakMap<Project, string>()

function cachedCelCrc(buf: Uint8ClampedArray): number {
  const hit = celCrcCache.get(buf)
  if (hit !== undefined) return hit
  const crc = crc32(buf as unknown as Uint8Array)
  celCrcCache.set(buf, crc)
  return crc
}

export async function computeStateHash(): Promise<string> {
  const p = getBus().getProject()
  const cached = projectHashCache.get(p)
  if (cached) return cached
  const parts: unknown[] = [p.id, p.name, p.width, p.height, p.palette, p.settings]
  for (const clip of p.clips) {
    const celCrcs: Record<string, number> = {}
    for (const frame of clip.frames) {
      for (const [layerId, cel] of Object.entries(frame.cels)) {
        celCrcs[`${frame.id}:${layerId}`] = cachedCelCrc(cel.buffer)
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
  const hash = (await sha256Hex(bytes)).slice(0, 32)
  projectHashCache.set(p, hash)
  return hash
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fail(code: string, message: string, hint?: string): ToolExecResult {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } }
}

/** Real editor tool names — registry-lite source for interpreter recommendations. */
const MCP_TOOL_NAMES = MCP_TOOLS.map((t) => t.name)
const MCP_TOOL_TIERS = new Map(MCP_TOOLS.map((t) => [t.name, t.tier]))

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asInt(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max) {
    throw new CommandError('VALIDATION_FAILED', `${what} must be an integer in [${min}, ${max}]`)
  }
  return v
}

function parseClipTags(value: unknown, clip: Clip): ClipTag[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new CommandError('VALIDATION_FAILED', 'tags must be an array of at most 128 frame-range tags')
  }
  const maxIndex = Math.max(0, clip.frames.length - 1)
  return value.map((raw, index) => {
    if (!isRecord(raw)) throw new CommandError('VALIDATION_FAILED', `tags[${index}] must be an object`)
    const name = asString(raw.name, `tags[${index}].name`, 64).trim()
    if (!name) throw new CommandError('VALIDATION_FAILED', `tags[${index}].name cannot be empty`)
    const from = asInt(raw.from, `tags[${index}].from`, 0, maxIndex)
    const to = asInt(raw.to, `tags[${index}].to`, from, maxIndex)
    return { name, from, to }
  })
}

/**
 * Pixel-coordinate validator for model-generated calls. LLMs frequently slip
 * two harmless forms into big batches: numeric strings ("16") and fractional
 * arithmetic results (12.5). Strings are unambiguous — parsed. Fractions are
 * REJECTED (rounding would silently move pixels) but the error prints the
 * received value and the fix so the model corrects itself in one retry.
 */
function asCoord(v: unknown, what: string, min: number, max: number): number {
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    v = Number(v)
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (Number.isInteger(v) && v >= min && v <= max) return v
    if (Number.isInteger(v)) {
      throw new CommandError('VALIDATION_FAILED', `${what} is ${v} — outside the allowed range [${min}, ${max}]. Use coordinates inside the canvas.`)
    }
    throw new CommandError(
      'VALIDATION_FAILED',
      `${what} must be an INTEGER pixel coordinate — you sent ${v}. Round it (e.g. Math.round) and retry; pixel centers are whole numbers.`,
    )
  }
  throw new CommandError('VALIDATION_FAILED', `${what} must be an integer in [${min}, ${max}] (received: ${JSON.stringify(v) ?? 'undefined'})`)
}

function optInt(v: unknown, what: string, min: number, max: number): number | undefined {
  return v === undefined ? undefined : asInt(v, what, min, max)
}

function asHex(v: unknown, what: string): string {
  if (typeof v === 'string') {
    const trimmed = v.trim()
    const normalized = !trimmed.startsWith('#') && /^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed)
      ? `#${trimmed}`
      : trimmed
    if (HEX_RE.test(normalized)) {
      return normalized.toLowerCase()
    }
  }
  throw new CommandError('VALIDATION_FAILED', `${what} must be a hex color like #rrggbb`)
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
    const clip = project.clips.find((c) => c.id === clipId) ?? fuzzyFindByName(project.clips, clipId)?.item
    if (!clip) throw new CommandError('NOT_FOUND', `clip "${clipId}" not found`)
    return clip
  }
  if (clipName) {
    const clip = project.clips.find((c) => c.name === clipName) ?? fuzzyFindByName(project.clips, clipName)?.item
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
    const layer = clip.layers.find((l) => l.id === layerId) ?? fuzzyFindByName(clip.layers, layerId)?.item
    if (!layer) throw new CommandError('NOT_FOUND', `layer "${layerId}" not found in clip "${clip.name}"`)
    return layer
  }
  const layerName = typeof args.layerName === 'string' ? args.layerName : undefined
  if (layerName) {
    const layer = clip.layers.find((l) => l.name === layerName) ?? fuzzyFindByName(clip.layers, layerName)?.item
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
  followCommandTarget(payload) // the user watches MCP edits land live
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

// Frame PNGs are keyed by the immutable project instance — copy-on-write
// means the same project object always renders the same pixels, so cache
// entries die automatically on the next edit (no explicit invalidation).
const framePngCache = new WeakMap<Project, Map<string, string>>()

async function framePng(
  project: Project,
  clip: Clip,
  frame: Frame,
  scale: InspectionScale,
  showGrid = false,
): Promise<string> {
  let cache = framePngCache.get(project)
  if (!cache) {
    cache = new Map()
    framePngCache.set(project, cache)
  }
  const key = `${clip.id}:${frame.id}:${scale}:${showGrid ? 1 : 0}`
  const hit = cache.get(key)
  if (hit) return hit
  const composed = composeFrameRgba(project, clip, frame)
  const scaled = renderInspectionRgba(composed, project.width, project.height, scale, showGrid)
  const url = await pngDataUrl(scaled.w, scaled.h, scaled.rgba)
  if (cache.size > 256) cache.clear()
  cache.set(key, url)
  return url
}

async function withStateHash(data: unknown, opts: { undoable?: boolean; summary?: string } = {}): Promise<ToolExecResult> {
  return envelope(data, { undoable: opts.undoable, summary: opts.summary, stateHash: await computeStateHash() })
}

// ---------------------------------------------------------------------------
// per-tool implementations
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>, ctx: ToolExecContext) => Promise<ToolExecResult>;

function buildCraftGate(clipId: string, frameId: string, layerId?: string) {
  const project = getBus().getProject()
  const clip = project.clips.find((c) => c.id === clipId)
  const frame = clip?.frames.find((f) => f.id === frameId)
  if (!clip || !frame) return null
  const cel = layerId ? frame.cels[layerId] : undefined
  const buffer = cel ? cel.buffer : composeFrameRgba(project, clip, frame)
  const report = analyzePixelCraft({
    buffer,
    width: project.width,
    height: project.height,
    lighting: project.settings.styleProfile?.lighting ?? 'top-left',
  })
  const pillowDefect = report.defects.find((d) => d.kind === 'pillow_shading')
  const counts = {
    doubles: report.metrics.doublesCount,
    orphans: report.metrics.orphansCount,
    jaggies: report.metrics.jaggiesCount,
    pillow: pillowDefect?.count ?? 0,
  }
  const topDefects: Array<{ kind: string; x: number; y: number }> = []
  for (const defect of report.defects) {
    if (defect.kind === 'empty') continue
    for (const pt of defect.locations) {
      topDefects.push({ kind: defect.kind, x: pt.x, y: pt.y })
      if (topDefects.length >= 6) break
    }
    if (topDefects.length >= 6) break
  }
  const grade: 'clean' | 'polish' | 'needs_fix' =
    report.score >= 90 ? 'clean' : report.score >= 70 ? 'polish' : 'needs_fix'
  const hint =
    grade === 'clean'
      ? 'Craft looks clean.'
      : counts.doubles > 0
        ? 'Call beautify_layer(cleanDoubles:true) or thin L-corner doubles at topDefects.'
        : counts.orphans > 0
          ? 'Remove stray 1px orphan speckles at topDefects.'
          : counts.jaggies > 0
            ? 'Smooth uneven staircase jaggies at topDefects.'
            : 'Shift highlights toward the light source to fix pillow shading.'
  return {
    score: report.score,
    grade,
    opaquePixels: report.metrics.opaquePixels,
    counts,
    topDefects,
    hint,
  }
}

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
      settings: {
        paletteEnforce: project.settings.paletteEnforce,
        // never display a phantom enabled profile: docs saved before style
        // profiles have none — show it as what it is (disabled until the
        // artist enables it), not as the enabled default
        styleProfile: project.settings.styleProfile ?? { ...defaultStyleProfile(), enabled: false },
        styleAnchor: project.settings.styleProfile?.anchor ?? null,
        onion: { ...project.settings.onion },
      },
      trash: project.trash.map((t) => ({ id: t.id, label: t.label, kind: t.item.kind, deletedAt: t.deletedAt })),
      clips: project.clips.map(clipSummary),
      activePointers: {
        clipId: state.activeClipId,
        frameIndex: state.activeFrameIndex,
        layerId: state.activeLayerId,
      },
      artistContext: {
        selection: state.selection ? { ...state.selection } : null,
        primaryColor: state.primary,
        secondaryColor: state.secondary,
        tool: state.tool,
        mirrorX: state.mirrorX,
        mirrorY: state.mirrorY,
        tiledWrap: state.tiledWrap,
        aiPaused: isAiPaused(),
      },
      history: { canUndo: bus.canUndo(), canRedo: bus.canRedo() },
    }
    return withStateHash(data)
  },

  async list_projects() {
    try {
      const res = await fetch('/api/projects', { headers: AGENT_FETCH_HEADERS })
      const json = (await res.json()) as { ok: boolean; projects?: Array<{ id: string; name: string; width: number; height: number; updatedAt: string }>; error?: unknown }
      if (!json.ok) return fail('persistence_error', describeApiErrorInline(json.error, 'Failed to list projects'))
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
    const ALLOWED_SCALES: ReadonlySet<number> = new Set([0.25, 0.5, 1, 2, 4, 8])
    const scale: InspectionScale =
      raw === undefined
        ? 1
        : typeof raw === 'number' && ALLOWED_SCALES.has(raw)
          ? (raw as InspectionScale)
          : (() => {
              throw new CommandError('VALIDATION_FAILED', 'scale must be one of 0.25, 0.5, 1, 2, 4, 8')
            })()
    const showGrid = args.showGrid === true
    const dataUrl = await framePng(project, clip, frame, scale, showGrid)
    const composed = composeFrameRgba(project, clip, frame)
    const visualCheck = buildVisualCheck(composed, project.width, project.height, project.palette)
    return withStateHash({
      clipId: clip.id,
      frameId: frame.id,
      width: Math.max(1, Math.floor(project.width * scale)),
      height: Math.max(1, Math.floor(project.height * scale)),
      scale,
      showGrid,
      png: dataUrl,
      visualCheck,
    })
  },

  async get_palette() {
    const project = getBus().getProject()
    const profile = project.settings.styleProfile
    return withStateHash({
      palette: [...project.palette],
      // single source of truth: when a Style Lock profile exists it owns the
      // palette decision — the legacy settings flag only applies without one.
      // (Two flags once made validate_style and this read disagree.)
      paletteEnforce: profile?.enabled ? profile.paletteMode === 'enforce' : project.settings.paletteEnforce,
      styleProfile: profile ?? { ...defaultStyleProfile(), enabled: false },
    })
  },

  async validate_style(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const { validateStyleCandidate } = await import('@pixelforge/core')
    const checks = validateStyleCandidate({
      buffer: composeFrameRgba(project, clip, frame),
      width: project.width,
      height: project.height,
      targetWidth: project.width,
      targetHeight: project.height,
      palette: [...project.palette],
      profile: project.settings.styleProfile ?? undefined,
      allowEdgeTouch: args.allowEdgeTouch === true,
    })
    const warnings = checks.filter((c) => c.status === 'warning').length
    return withStateHash(
      {
        clipId: clip.id,
        frameId: frame.id,
        pass: warnings === 0,
        // objective/deterministic only — readability critique stays human
        checks,
      },
      {
        summary: warnings === 0
          ? `Style checks pass for "${clip.name}" frame ${frame.id}`
          : `${warnings} style warning(s) on "${clip.name}" frame ${frame.id} — fix before candidate review`,
      },
    )
  },

  async analyze_pixel_craft(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const report = analyzePixelCraft({
      buffer: composeFrameRgba(project, clip, frame),
      width: project.width,
      height: project.height,
      lighting: project.settings.styleProfile?.lighting ?? 'top-left',
    })
    return withStateHash(
      {
        clipId: clip.id,
        frameId: frame.id,
        ...report,
      },
      { summary: report.summary },
    )
  },

  async validate_asset_set(args) {
    const project = getBus().getProject()
    const raw = args.actorClipIds
    if (raw !== undefined && (!Array.isArray(raw) || raw.length > 64 || raw.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 120 || !project.clips.some((clip) => clip.id === id)))) {
      throw new CommandError('VALIDATION_FAILED', 'actorClipIds must be an array of up to 64 clip ids from the active project')
    }
    const rows = reviewAssetSet(project, (raw as string[] | undefined) ?? [])
    const attention = rows.filter((row) => row.issues.length > 0).length
    return withStateHash({
      anchor: project.settings.styleProfile?.anchor ?? null,
      rows,
      attention,
      scope: 'representative frame of each clip; actor comparisons only for actorClipIds',
    }, { summary: `${rows.length} clips checked; ${attention} need attention` })
  },

  async list_templates() {
    const templates = listSpriteTemplates()
    return withStateHash(
      { count: templates.length, templates },
      { summary: `${templates.length} starter sprite template(s) available — insert with generate_template (free, L1)` },
    )
  },

  async generate_template(args, ctx) {
    assertTaskProject(ctx)
    const templateId = asString(args.template, 'template', 48)
    if (!isSpriteTemplateId(templateId)) {
      const valid = listSpriteTemplates().map((t) => t.id).join(', ')
      throw new CommandError('VALIDATION_FAILED', `unknown template "${templateId}" — choose one of: ${valid}`)
    }
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const autoTagParts = args.autoTagParts !== false
    const customName = args.name !== undefined ? asString(args.name, 'name', 120) : undefined
    const rendered = renderSpriteTemplate(templateId, project.width, project.height, project.palette)
    const layerName = customName || rendered.name
    let newLayerId = ''
    let partsCount = 0
    execTransaction(`Starter template: ${layerName}`, () => {
      getBus().execute('layer.add', { clipId: clip.id, name: layerName }, 'mcp')
      const created = getBus().getProject().clips.find((c) => c.id === clip.id)?.layers.at(-1)
      if (!created) throw new CommandError('INVALID_STATE', 'layer add produced no layer')
      newLayerId = created.id
      getBus().execute(
        'pixels.applyOp',
        {
          clipId: clip.id,
          frameId: frame.id,
          layerId: newLayerId,
          ops: [{ op: 'setBuffer' as const, buffer: new Uint8ClampedArray(rendered.buffer) }],
        },
        'mcp',
      )
      if (autoTagParts && rendered.parts.length > 0) {
        getBus().execute(
          'part.set',
          {
            clipId: clip.id,
            parts: rendered.parts.map((p, z) => ({
              name: p.name,
              layerId: newLayerId,
              rect: p.rect,
              anchorFrameId: frame.id,
              z,
            })),
          },
          'mcp',
        )
        partsCount = rendered.parts.length
      }
    })
    const craftGate = buildCraftGate(clip.id, frame.id, newLayerId)
    return withStateHash(
      {
        clipId: clip.id,
        frameId: frame.id,
        layerId: newLayerId,
        template: rendered.id,
        name: layerName,
        bounds: rendered.bounds,
        partsCount,
        craftGate,
      },
      {
        undoable: true,
        summary: `Inserted "${layerName}" template on "${clip.name}"${partsCount > 0 ? ` (${partsCount} Motion parts tagged)` : ''} · craft ${rendered.craftScore}/100`,
      },
    )
  },

  async list_vfx(args) {
    const { listVfx } = await import('./vfx')
    const category = typeof args.category === 'string' ? args.category : undefined
    const effects = await listVfx(category)
    return withStateHash(
      { count: effects.length, effects },
      { summary: `${effects.length} procedural VFX effect(s) available — render with generate_vfx (free, L1)` },
    )
  },

  async generate_vfx(args, ctx) {
    const { generateVfx } = await import('./vfx')
    const target = args.target === 'current_clip' ? 'current_clip' : 'new_clip'
    const depth =
      args.depth === 'split' || args.depth === 'front' || args.depth === 'back' || args.depth === 'combined'
        ? args.depth
        : undefined
    const warmup =
      typeof args.warmup === 'number'
        ? Math.max(0, Math.min(64, Math.round(args.warmup)))
        : args.warmup === 'auto'
          ? 'auto'
          : undefined
    const res = await generateVfx({
      effect: asString(args.effect, 'effect', 80),
      seed: typeof args.seed === 'number' ? args.seed : undefined,
      frames: optInt(args.frames, 'frames', 1, 64) ?? undefined,
      fps: optInt(args.fps, 'fps', 1, 60) ?? undefined,
      light: typeof args.light === 'number' ? args.light : undefined,
      fit: args.fit === 'crop' ? 'crop' : 'fit',
      x: typeof args.x === 'number' ? args.x : undefined,
      y: typeof args.y === 'number' ? args.y : undefined,
      palette: args.palette === 'project' ? 'project' : Array.isArray(args.palette) ? (args.palette as string[]) : undefined,
      name: typeof args.name === 'string' ? args.name : undefined,
      target,
      clipId: typeof args.clipId === 'string' ? args.clipId : undefined,
      depth,
      crispPixelArt: typeof args.crispPixelArt === 'boolean' ? args.crispPixelArt : undefined,
      alphaThreshold: optInt(args.alphaThreshold, 'alphaThreshold', 1, 254) ?? undefined,
      warmup,
      origin: 'mcp',
    }, () => assertTaskProject(ctx))
    if (!res.ok) {
      return fail('vfx_failed', res.error?.message ?? 'VFX render failed.', res.error?.hint)
    }
    const targetDesc =
      res.target === 'current_clip'
        ? `overlaid onto clip "${res.clipName}" (${res.createdLayerIds?.length ?? 1} ${res.depth} layer(s))`
        : `rendered into new clip "${res.clipName}"`
    return withStateHash(
      {
        clipId: res.clipId,
        clipName: res.clipName,
        target: res.target ?? target,
        depth: res.depth ?? depth ?? 'combined',
        createdLayerIds: res.createdLayerIds ?? [],
        frames: res.frames,
        fps: res.fps,
        previewPng: res.previewPng ?? null,
        resolvedEffect: res.resolvedEffect ?? null,
        paletteApplied: res.paletteApplied ?? null,
        crispPixelArt: res.crispPixelArt ?? true,
        warmupUsed: res.warmupUsed ?? 0,
      },
      {
        summary: `VFX "${res.resolvedEffect ?? args.effect}" ${targetDesc} (${res.frames}f @ ${res.fps}fps) — verify with preview_animation invariants, then validate_style`,
      },
    )
  },

  async preview_animation(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const maxFrames = optInt(args.maxFrames, 'maxFrames', 1, 64) ?? MAX_PREVIEW_FRAMES
    if (clip.frames.length === 0) return fail('not_found', `clip "${clip.name}" has no frames`)
    const cycle = buildPlaybackCycle(clip)
    const count = Math.min(clip.frames.length, maxFrames)
    const frames: string[] = []
    const emptyFrames: number[] = []
    let minDuration = Number.POSITIVE_INFINITY
    let maxDuration = 0
    let bytes = 0
    for (let i = 0; i < count; i++) {
      const frame = clip.frames[i]!
      // deterministic animation invariant (audit #6): a fully transparent
      // in-between means the pose was never drawn — surface it, don't guess
      const rgba = composeFrameRgba(project, clip, frame)
      let opaque = false
      for (let o = 3; o < rgba.length; o += 4) {
        if (rgba[o] !== 0) { opaque = true; break }
      }
      if (!opaque) emptyFrames.push(i)
      minDuration = Math.min(minDuration, frame.durationMs)
      maxDuration = Math.max(maxDuration, frame.durationMs)
      const dataUrl = await framePng(project, clip, frame, 1)
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
      invariants: {
        emptyFrames,
        allFramesHaveContent: emptyFrames.length === 0,
        uniformTiming: minDuration === maxDuration,
      },
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
    if (args.confirm !== true) {
      return fail(
        'confirm_required',
        'create_project replaces the ACTIVE document — pass confirm:true to replace it deliberately.',
        'The current project stays in the saved project list; reopen it with open_project if needed.'
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

  async open_project(args, ctx) {
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
      const json = (await res.json()) as { ok: boolean; project?: unknown; error?: unknown }
      if (!json.ok || !json.project) return fail('not_found', describeApiErrorInline(json.error, `project "${projectId}" not found`))
      if (!isSerializedProject(json.project)) return fail('persistence_error', 'Stored project failed schema validation')
      const { project } = await importLegacyProjectJson(json.project, projectId)
      assertTaskProject(ctx)
      useEditor.getState().loadProject(project, { projectId })
      rememberLastProject(projectId) // agent-opened projects survive refresh too
      return withStateHash(
        { opened: true, projectId, name: project.name, width: project.width, height: project.height, clipCount: project.clips.length },
        { summary: `Opened project "${project.name}"` }
      )
    } catch (err) {
      if (err instanceof TaskProjectMismatch) throw err
      return fail('persistence_error', err instanceof Error ? err.message : 'Failed to open project')
    }
  },

  async rename_project(args) {
    const name = asString(args.name, 'name', 120).trim()
    if (!name) throw new CommandError('VALIDATION_FAILED', 'name cannot be empty')
    execCommand('project.rename', { name })
    return withStateHash({ name }, { undoable: true, summary: `Renamed project to "${name}"` })
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

  async reverse_clip(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const n = clip.frames.length
    if (n <= 1) {
      return withStateHash({ clipId: clip.id, reversed: false, frameCount: n }, { undoable: false, summary: `Clip "${clip.name}" has fewer than 2 frames` })
    }
    execTransaction(`Reverse clip "${clip.name}"`, () => {
      for (let i = 0; i < n - 1; i++) {
        getBus().execute('frame.move', { clipId: clip.id, from: n - 1, to: i }, 'mcp')
      }
    })
    return withStateHash(
      { clipId: clip.id, reversed: true, frameCount: n },
      { undoable: true, summary: `Reversed ${n} frames in "${clip.name}"` },
    )
  },

  async bake_pingpong(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const n = clip.frames.length
    if (n < 3) {
      return fail('validation_failed', `Clip "${clip.name}" needs at least 3 frames to bake a ping-pong cycle (has ${n})`)
    }
    if (n + (n - 2) > 64) {
      return fail('validation_failed', `Baking ping-pong on ${n} frames would exceed the 64-frame limit`)
    }
    execTransaction(`Bake ping-pong "${clip.name}"`, () => {
      for (let srcIdx = n - 2; srcIdx >= 1; srcIdx--) {
        getBus().execute('frame.add', { clipId: clip.id, afterIndex: srcIdx, copy: true }, 'mcp')
        const curLen = getBus().getProject().clips.find((c) => c.id === clip.id)?.frames.length ?? 0
        if (curLen > srcIdx + 2) {
          getBus().execute('frame.move', { clipId: clip.id, from: srcIdx + 1, to: curLen - 1 }, 'mcp')
        }
      }
      getBus().execute('clip.setProps', { clipId: clip.id, patch: { loopMode: 'forward' } }, 'mcp')
    })
    const finalCount = getBus().getProject().clips.find((c) => c.id === clip.id)?.frames.length ?? n
    return withStateHash(
      { clipId: clip.id, originalFrames: n, frameCount: finalCount, loopMode: 'forward' },
      { undoable: true, summary: `Baked ping-pong in "${clip.name}" (${n} → ${finalCount} forward frames)` },
    )
  },

  async set_frame_duration(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame, index } = resolveFrameRef(clip, args)
    const durationMs = asInt(args.durationMs, 'durationMs', 0, 60_000)
    execCommand('frame.setDuration', { clipId: clip.id, frameId: frame.id, durationMs })
    return withStateHash(
      { clipId: clip.id, frameId: frame.id, frameIndex: index, durationMs },
      { undoable: true, summary: `Set frame ${index + 1} duration to ${durationMs === 0 ? 'clip FPS' : `${durationMs} ms`}` },
    )
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

  async purge_trash(args) {
    const bus = getBus()
    const project = bus.getProject()
    const ids = project.trash.map((t) => t.id)
    if (ids.length === 0) {
      return withStateHash({ purged: 0 }, { undoable: false, summary: 'Trash is already empty' })
    }
    const entryId = args.entryId !== undefined ? asString(args.entryId, 'entryId', 128) : null
    const targets = entryId ? ids.filter((id) => id === entryId) : ids
    if (entryId && targets.length === 0) {
      return fail('not_found', `Trash entry "${entryId}" not found`, 'Read get_project_state for current trash entries.')
    }
    execTransaction(`Purge ${targets.length} trash entr${targets.length === 1 ? 'y' : 'ies'}`, () => {
      for (const id of targets) bus.execute('trash.purge', { entryId: id }, 'mcp')
    })
    return withStateHash(
      { purged: targets.length, entryIds: targets },
      { undoable: true, summary: `Purged ${targets.length} trash entr${targets.length === 1 ? 'y' : 'ies'} (one undo entry)` }
    )
  },

  async resize_canvas(args) {
    const bus = getBus()
    const width = asInt(args.width, 'width', 16, 256)
    const height = asInt(args.height, 'height', 16, 256)
    let anchor: 'top-left' | 'center' | undefined
    if (args.anchor === 'center' || args.anchor === 'top-left') anchor = args.anchor
    else if (args.anchor !== undefined) {
      return fail('validation_failed', 'anchor must be "top-left" or "center"')
    }
    execCommand('canvas.resize', { width, height, ...(anchor ? { anchor } : {}) })
    const p = bus.getProject()
    return withStateHash(
      { width: p.width, height: p.height, anchor: anchor ?? 'top-left' },
      { undoable: true, summary: `Canvas resized to ${p.width}×${p.height} (${anchor ?? 'top-left'}) — content shifted, nothing rescaled` }
    )
  },

  async auto_trim(args) {
    const bus = getBus()
    const project = bus.getProject()
    const padding = optInt(args.padding, 'padding', 0, 16) ?? 1
    const seenCels = new Set<Uint8ClampedArray>()
    const celRefs: Array<{ clipId: string; frameId: string; layerId: string; buffer: Uint8ClampedArray }> = []
    for (const clip of project.clips) {
      for (const frame of clip.frames) {
        for (const layer of clip.layers) {
          const cel = frame.cels[layer.id]
          if (!cel || seenCels.has(cel.buffer)) continue
          seenCels.add(cel.buffer)
          celRefs.push({ clipId: clip.id, frameId: frame.id, layerId: layer.id, buffer: cel.buffer })
        }
      }
    }
    const trim = computeTrimBounds(
      celRefs.map((c) => c.buffer),
      project.width,
      project.height,
      padding,
    )
    if (!trim) {
      return withStateHash(
        { trimmed: false, width: project.width, height: project.height, dx: 0, dy: 0, bbox: null },
        { undoable: false, summary: 'Canvas has no visible pixels to trim' },
      )
    }
    if (
      trim.width === project.width &&
      trim.height === project.height &&
      trim.dx === 0 &&
      trim.dy === 0
    ) {
      return withStateHash(
        { trimmed: false, width: project.width, height: project.height, dx: 0, dy: 0, bbox: trim.bbox },
        { undoable: false, summary: `Canvas is already trimmed at ${project.width}×${project.height}` },
      )
    }
    execTransaction('Auto-trim canvas', () => {
      const growW = Math.max(project.width, trim.width)
      const growH = Math.max(project.height, trim.height)
      if (growW > project.width || growH > project.height) {
        bus.execute('canvas.resize', { width: growW, height: growH, anchor: 'top-left' }, 'mcp')
      }
      if (trim.dx !== 0 || trim.dy !== 0) {
        for (const ref of celRefs) {
          bus.execute(
            'pixels.applyOp',
            {
              clipId: ref.clipId,
              frameId: ref.frameId,
              layerId: ref.layerId,
              ops: [{ op: 'shift' as const, dx: trim.dx, dy: trim.dy }],
            },
            'mcp',
          )
        }
      }
      const cur = bus.getProject()
      if (cur.width !== trim.width || cur.height !== trim.height) {
        bus.execute('canvas.resize', { width: trim.width, height: trim.height, anchor: 'top-left' }, 'mcp')
      }
    })
    const p = bus.getProject()
    return withStateHash(
      { trimmed: true, width: p.width, height: p.height, dx: trim.dx, dy: trim.dy, padding, bbox: trim.bbox },
      { undoable: true, summary: `Auto-trimmed canvas to ${p.width}×${p.height} (padding ${padding}px)` },
    )
  },

  async export_sheet(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    if (clip.frames.length === 0) return fail('not_found', `clip "${clip.name}" has no frames`)
    const scale: ExportScale = args.scale === 2 || args.scale === 4 || args.scale === 8 ? args.scale : 1
    const padding = optInt(args.padding, 'padding', 0, 64) ?? 0
    const spacing = optInt(args.spacing, 'spacing', 0, 64) ?? undefined
    const sheetOpts = { columns: 0, padding, spacing }
    let composed: { rgba: Uint8ClampedArray; layout: SheetLayout }
    try {
      composed = composeSheetRgba(project, clip, sheetOpts)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return fail('validation_failed', msg)
    }
    const { rgba, layout } = composed
    const outW = layout.width * scale
    const outH = layout.height * scale
    const outRgba = scale > 1 ? upscaleRgbaNearest(rgba, layout.width, layout.height, scale) : rgba
    const png = await pngDataUrl(outW, outH, outRgba)
    if (png.length > MAX_EXPORT_BYTES) {
      return fail('response_too_large', `Encoded sheet is ${(png.length / 1e6).toFixed(1)} MB — reduce scale, frames, or canvas size.`)
    }
    const imageFilename = `${slugify(project.name)}_${slugify(clip.name)}_sheet.png`
    const asepriteJson =
      args.jsonFormat === 'aseprite'
        ? buildAsepriteJson(project, clip, sheetOpts, imageFilename, scale)
        : undefined
    return withStateHash(
      {
        clipId: clip.id,
        clipName: clip.name,
        frameCount: clip.frames.length,
        scale,
        width: outW,
        height: outH,
        padding: layout.padding * scale,
        spacing: layout.spacing * scale,
        png,
        ...(asepriteJson ? { asepriteJson } : {}),
      },
      { summary: `Exported sprite sheet "${clip.name}" (${clip.frames.length} frames, ${outW}×${outH}, ${scale}×)` }
    )
  },

  async export_atlas(args) {
    const project = getBus().getProject()
    if (project.clips.length === 0) return fail('not_found', 'project has no clips')
    const scale: ExportScale = args.scale === 2 || args.scale === 4 || args.scale === 8 ? args.scale : 1
    const columns = optInt(args.columns, 'columns', 0, 64) ?? 0
    const padding = optInt(args.padding, 'padding', 0, 64) ?? 0
    const spacing = optInt(args.spacing, 'spacing', 0, 64) ?? padding
    const includeTres = args.includeTres === true
    const atlasOpts = { columns, padding, spacing }
    let composed: { rgba: Uint8ClampedArray; layout: AtlasLayout }
    try {
      composed = composeAtlasRgba(project, atlasOpts)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return fail('validation_failed', msg)
    }
    const { rgba, layout } = composed
    const outW = layout.width * scale
    const outH = layout.height * scale
    const outRgba = scale > 1 ? upscaleRgbaNearest(rgba, layout.width, layout.height, scale) : rgba
    const png = await pngDataUrl(outW, outH, outRgba)
    if (png.length > MAX_EXPORT_BYTES) {
      return fail('response_too_large', `Encoded atlas is ${(png.length / 1e6).toFixed(1)} MB — reduce scale or frames.`)
    }
    const imageFilename = `${slugify(project.name)}_atlas.png`
    const asepriteJson = buildAtlasAsepriteJson(project, atlasOpts, imageFilename, scale)
    const tres = includeTres ? generateGodot4AtlasTres(imageFilename, layout, scale) : undefined
    return withStateHash(
      {
        clipCount: layout.clips.length,
        frameCount: layout.frames.length,
        scale,
        width: outW,
        height: outH,
        columns: layout.columns,
        rows: layout.rows,
        png,
        asepriteJson,
        ...(tres ? { tres } : {}),
      },
      { summary: `Exported master atlas (${layout.clips.length} clips, ${layout.frames.length} frames, ${outW}×${outH}, ${scale}×)` }
    )
  },

  async export_gif(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    if (clip.frames.length === 0) return fail('not_found', `clip "${clip.name}" has no frames`)
    if (clip.frames.length > 64) return fail('validation_failed', 'max 64 frames per GIF')
    const scale = args.scale === 2 || args.scale === 4 || args.scale === 8 ? args.scale : 1
    const bg = args.bg !== undefined ? asHex(args.bg, 'bg') : '#101014'
    const bgRgb = [parseInt(bg.slice(1, 3), 16), parseInt(bg.slice(3, 5), 16), parseInt(bg.slice(5, 7), 16)]
    const fw = project.width * scale
    const fh = project.height * scale
    if (fw * fh * clip.frames.length > MAX_EXPORT_PIXELS) {
      return fail('response_too_large', `GIF would be ${fw}×${fh} × ${clip.frames.length} frames — reduce scale.`)
    }
    const { GIFEncoder, quantize, applyPalette } = await import('gifenc')
    const gif = GIFEncoder()
    let palette: number[][] | null = null
    for (const frame of clip.frames) {
      const fr = composeFrameRgba(project, clip, frame)
      const flat = new Uint8ClampedArray(fw * fh * 4)
      for (let y = 0; y < fh; y++) {
        const sy = Math.floor(y / scale)
        for (let x = 0; x < fw; x++) {
          const sx = Math.floor(x / scale)
          const di = (y * fw + x) * 4
          const si = (sy * project.width + sx) * 4
          const a = fr[si + 3] / 255
          flat[di] = Math.round(fr[si] * a + bgRgb[0] * (1 - a))
          flat[di + 1] = Math.round(fr[si + 1] * a + bgRgb[1] * (1 - a))
          flat[di + 2] = Math.round(fr[si + 2] * a + bgRgb[2] * (1 - a))
          flat[di + 3] = 255
        }
      }
      if (!palette) palette = quantize(flat, 64)
      gif.writeFrame(applyPalette(flat, palette), fw, fh, {
        palette,
        delay: Math.max(20, frame.durationMs),
        dispose: 2,
      })
    }
    gif.finish()
    const dataUrl = `data:image/gif;base64,${base64FromBytes(gif.bytes() as Uint8Array)}`
    if (dataUrl.length > MAX_EXPORT_BYTES) {
      return fail('response_too_large', `Encoded GIF is ${(dataUrl.length / 1e6).toFixed(1)} MB — reduce scale or frame count.`)
    }
    return withStateHash(
      { clipId: clip.id, clipName: clip.name, frameCount: clip.frames.length, width: fw, height: fh, scale, bg, gif: dataUrl },
      { summary: `Exported GIF "${clip.name}" (${clip.frames.length} frames, ${fw}×${fh})` }
    )
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
    const ops = pixels.map((p, i) => {
      if (!isRecord(p)) throw new CommandError('VALIDATION_FAILED', `pixels[${i}] must be an object`)
      const x = asCoord(p.x, `pixels[${i}].x`, -100000, 100000)
      const y = asCoord(p.y, `pixels[${i}].y`, -100000, 100000)
      if (x < 0 || y < 0 || x >= project.width || y >= project.height) {
        throw new CommandError('VALIDATION_FAILED', `pixels[${i}] (${x},${y}) is outside the canvas (${project.width}×${project.height})`)
      }
      const hex = p.color !== undefined ? asHex(p.color, `pixels[${i}].color`) : fallback
      if (!hex) throw new CommandError('VALIDATION_FAILED', `pixels[${i}] has no color and no top-level "color" was given`)
      return { op: 'stamp' as const, x, y, color: asRgba(hex) }
    })
    execCommand('pixels.applyOp', { clipId: clip.id, frameId: frame.id, layerId: layer.id, ops })
    return withStateHash(
      { applied: ops.length, clipId: clip.id, frameId: frame.id, layerId: layer.id, craftGate: buildCraftGate(clip.id, frame.id, layer.id) },
      { undoable: true, summary: `Painted ${ops.length} pixel(s) on "${clip.name}" / "${layer.name}"` }
    )
  },

  async fill_rect(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const layer = resolveLayerRef(clip, args)
    if (!isRecord(args.from) || !isRecord(args.to)) throw new CommandError('VALIDATION_FAILED', 'from/to must be {x, y} points')
    const from = { x: asCoord(args.from.x, 'from.x', -100000, 100000), y: asCoord(args.from.y, 'from.y', -100000, 100000) }
    const to = { x: asCoord(args.to.x, 'to.x', -100000, 100000), y: asCoord(args.to.y, 'to.y', -100000, 100000) }
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
      { clipId: clip.id, frameId: frame.id, layerId: layer.id, from, to, filled, craftGate: buildCraftGate(clip.id, frame.id, layer.id) },
      { undoable: true, summary: `${filled ? 'Filled' : 'Outlined'} rect in "${clip.name}" / "${layer.name}"` }
    )
  },

  async draw_line(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const layer = resolveLayerRef(clip, args)
    if (!isRecord(args.from) || !isRecord(args.to)) throw new CommandError('VALIDATION_FAILED', 'from/to must be {x, y} points')
    const from = { x: asCoord(args.from.x, 'from.x', -100000, 100000), y: asCoord(args.from.y, 'from.y', -100000, 100000) }
    const to = { x: asCoord(args.to.x, 'to.x', -100000, 100000), y: asCoord(args.to.y, 'to.y', -100000, 100000) }
    const hex = asHex(args.color, 'color')
    const size = args.size === undefined ? 1 : asInt(args.size, 'size', 1, 8)
    const mirrorX = args.mirrorX === true
    execCommand('pixels.applyOp', {
      clipId: clip.id,
      frameId: frame.id,
      layerId: layer.id,
      color: asRgba(hex),
      ops: [{ op: 'line' as const, from, to, size, mirrorX }],
    })
    return withStateHash(
      { clipId: clip.id, frameId: frame.id, layerId: layer.id, from, to, size, mirrorX, craftGate: buildCraftGate(clip.id, frame.id, layer.id) },
      { undoable: true, summary: `Drew line in "${clip.name}" / "${layer.name}"` }
    )
  },

  async draw_ellipse(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const layer = resolveLayerRef(clip, args)
    if (!isRecord(args.from) || !isRecord(args.to)) throw new CommandError('VALIDATION_FAILED', 'from/to must be {x, y} points')
    const from = { x: asCoord(args.from.x, 'from.x', -100000, 100000), y: asCoord(args.from.y, 'from.y', -100000, 100000) }
    const to = { x: asCoord(args.to.x, 'to.x', -100000, 100000), y: asCoord(args.to.y, 'to.y', -100000, 100000) }
    const hex = asHex(args.color, 'color')
    const filled = args.filled === undefined ? true : args.filled === true
    const size = args.size === undefined ? 1 : asInt(args.size, 'size', 1, 8)
    const mirrorX = args.mirrorX === true
    execCommand('pixels.applyOp', {
      clipId: clip.id,
      frameId: frame.id,
      layerId: layer.id,
      color: asRgba(hex),
      ops: [{ op: 'ellipse' as const, from, to, filled, size, mirrorX }],
    })
    return withStateHash(
      { clipId: clip.id, frameId: frame.id, layerId: layer.id, from, to, filled, size, mirrorX, craftGate: buildCraftGate(clip.id, frame.id, layer.id) },
      { undoable: true, summary: `${filled ? 'Filled' : 'Outlined'} ellipse in "${clip.name}" / "${layer.name}"` }
    )
  },

  async draw_polygon(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const layer = resolveLayerRef(clip, args)
    if (!Array.isArray(args.points) || args.points.length < 2 || args.points.length > 64) {
      throw new CommandError('VALIDATION_FAILED', 'points must be an array of 2–64 {x, y} vertices')
    }
    const points = args.points.map((pt, i) => {
      if (!isRecord(pt)) throw new CommandError('VALIDATION_FAILED', `points[${i}] must be {x, y}`)
      return {
        x: asCoord(pt.x, `points[${i}].x`, -100000, 100000),
        y: asCoord(pt.y, `points[${i}].y`, -100000, 100000),
      }
    })
    const hex = asHex(args.color, 'color')
    const filled = args.filled === undefined ? true : args.filled === true
    const mirrorX = args.mirrorX === true
    execCommand('pixels.applyOp', {
      clipId: clip.id,
      frameId: frame.id,
      layerId: layer.id,
      color: asRgba(hex),
      ops: [{ op: 'polygon' as const, points, filled, mirrorX }],
    })
    return withStateHash(
      { clipId: clip.id, frameId: frame.id, layerId: layer.id, vertexCount: points.length, filled, mirrorX, craftGate: buildCraftGate(clip.id, frame.id, layer.id) },
      { undoable: true, summary: `${filled ? 'Filled' : 'Outlined'} ${points.length}-pt polygon in "${clip.name}" / "${layer.name}"` }
    )
  },

  async flood_fill(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const layer = resolveLayerRef(clip, args)
    const x = asCoord(args.x, 'x', 0, project.width - 1)
    const y = asCoord(args.y, 'y', 0, project.height - 1)
    const hex = asHex(args.color, 'color')
    const mirrorX = args.mirrorX === true
    execCommand('pixels.applyOp', {
      clipId: clip.id,
      frameId: frame.id,
      layerId: layer.id,
      color: asRgba(hex),
      ops: [{ op: 'fill' as const, x, y, mirrorX }],
    })
    return withStateHash(
      { clipId: clip.id, frameId: frame.id, layerId: layer.id, x, y, mirrorX, craftGate: buildCraftGate(clip.id, frame.id, layer.id) },
      { undoable: true, summary: `Flood-filled at (${x}, ${y}) in "${clip.name}" / "${layer.name}"` }
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

  async center_content(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const allLayers = args.allLayers === true

    if (allLayers) {
      const targets = clip.layers
        .filter((l) => l.visible && !l.locked && frame.cels[l.id])
        .map((l) => ({ layerId: l.id, buffer: frame.cels[l.id]!.buffer }))
      if (targets.length === 0) {
        return withStateHash(
          { clipId: clip.id, frameId: frame.id, allLayers: true, centered: false, dx: 0, dy: 0, bbox: null },
          { undoable: false, summary: `No visible pixels to center in "${clip.name}"` },
        )
      }
      const res = computeCenterShift(targets.map((t) => t.buffer), project.width, project.height)
      if (!res || (res.dx === 0 && res.dy === 0)) {
        return withStateHash(
          { clipId: clip.id, frameId: frame.id, allLayers: true, centered: false, dx: 0, dy: 0, bbox: res?.bbox ?? null },
          { undoable: false, summary: `Frame in "${clip.name}" is already centered` },
        )
      }
      execTransaction('Center frame', () => {
        for (const t of targets) {
          getBus().execute(
            'pixels.applyOp',
            { clipId: clip.id, frameId: frame.id, layerId: t.layerId, ops: [{ op: 'shift' as const, dx: res.dx, dy: res.dy }] },
            'mcp',
          )
        }
      })
      return withStateHash(
        {
          clipId: clip.id,
          frameId: frame.id,
          allLayers: true,
          layerIds: targets.map((t) => t.layerId),
          centered: true,
          dx: res.dx,
          dy: res.dy,
          bbox: res.bbox,
        },
        { undoable: true, summary: `Centered ${targets.length} layer(s) by (${res.dx}, ${res.dy}) in "${clip.name}"` },
      )
    }

    const layer = resolveLayerRef(clip, args)
    const cel = frame.cels[layer.id]
    const res = cel ? computeCenterShift(cel.buffer, project.width, project.height) : null
    if (!res) {
      return withStateHash(
        { clipId: clip.id, frameId: frame.id, layerId: layer.id, centered: false, dx: 0, dy: 0, bbox: null },
        { undoable: false, summary: `Layer "${layer.name}" is empty` },
      )
    }
    if (res.dx === 0 && res.dy === 0) {
      return withStateHash(
        { clipId: clip.id, frameId: frame.id, layerId: layer.id, centered: false, dx: 0, dy: 0, bbox: res.bbox },
        { undoable: false, summary: `Layer "${layer.name}" is already centered` },
      )
    }
    execCommand('pixels.applyOp', {
      clipId: clip.id,
      frameId: frame.id,
      layerId: layer.id,
      ops: [{ op: 'shift' as const, dx: res.dx, dy: res.dy }],
    })
    return withStateHash(
      { clipId: clip.id, frameId: frame.id, layerId: layer.id, centered: true, dx: res.dx, dy: res.dy, bbox: res.bbox },
      { undoable: true, summary: `Centered "${layer.name}" by (${res.dx}, ${res.dy}) in "${clip.name}"` },
    )
  },

  async remap_palette(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const scope = args.scope === 'layer' || args.scope === 'frame' || args.scope === 'clip' ? args.scope : 'clip'
    const mode = args.mode === 'nearest' ? 'nearest' : 'ramp'
    let targetPalette: string[]
    if (args.palette !== undefined) {
      if (!Array.isArray(args.palette) || args.palette.length === 0 || args.palette.length > 256) {
        throw new CommandError('VALIDATION_FAILED', 'palette must be a 1–256 hex color array')
      }
      targetPalette = args.palette.map((c) => asHex(c, 'palette color'))
    } else {
      targetPalette = [...project.palette]
    }
    const updateProjectPalette =
      args.updateProjectPalette !== undefined ? args.updateProjectPalette === true : args.palette !== undefined

    const frames = scope === 'clip' ? clip.frames : [frame]
    const singleLayer = scope === 'layer' ? resolveLayerRef(clip, args) : null
    const seen = new Set<Uint8ClampedArray>()
    const celList: Array<{ frameId: string; layerId: string; buffer: Uint8ClampedArray }> = []
    for (const f of frames) {
      const layers = singleLayer ? [singleLayer] : clip.layers.filter((l) => l.visible && !l.locked)
      for (const l of layers) {
        if (l.locked) continue
        const cel = f.cels[l.id]
        if (!cel || seen.has(cel.buffer)) continue
        seen.add(cel.buffer)
        celList.push({ frameId: f.id, layerId: l.id, buffer: cel.buffer })
      }
    }

    const sourceColors = collectUniqueOpaqueColors(celList.map((c) => c.buffer))
    const updates: Array<{ frameId: string; layerId: string; working: Uint8ClampedArray; count: number }> = []
    for (const c of celList) {
      const working = new Uint8ClampedArray(c.buffer)
      const count = remapBufferToPalette(working, targetPalette, { mode, sourceColors })
      if (count > 0) updates.push({ frameId: c.frameId, layerId: c.layerId, working, count })
    }
    const remappedPixels = updates.reduce((sum, u) => sum + u.count, 0)
    if (remappedPixels === 0 && !updateProjectPalette) {
      return withStateHash(
        { clipId: clip.id, scope, mode, remappedPixels: 0, updatedCels: 0, updatedPalette: false },
        { undoable: false, summary: `No pixels changed when remapping "${clip.name}"` },
      )
    }
    execTransaction(`Remap palette (${scope})`, () => {
      if (updateProjectPalette) {
        getBus().execute('palette.replaceAll', { colors: targetPalette }, 'mcp')
      }
      for (const u of updates) {
        getBus().execute(
          'pixels.applyOp',
          { clipId: clip.id, frameId: u.frameId, layerId: u.layerId, ops: [{ op: 'setBuffer' as const, buffer: u.working }] },
          'mcp',
        )
      }
    })
    return withStateHash(
      {
        clipId: clip.id,
        scope,
        mode,
        remappedPixels,
        updatedCels: updates.length,
        updatedPalette: updateProjectPalette,
        paletteSize: targetPalette.length,
      },
      { undoable: true, summary: `Remapped ${remappedPixels} px across ${updates.length} cel(s) in "${clip.name}" via OKLab ${mode}` },
    )
  },

  async create_skin_variants(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const mode = args.mode === 'nearest' ? 'nearest' : 'ramp'
    const requests: SkinVariantRequest[] = []

    if (Array.isArray(args.presets)) {
      for (const raw of args.presets) {
        if (typeof raw !== 'string') continue
        const preset = getSkinPreset(raw)
        if (!preset) {
          throw new CommandError('VALIDATION_FAILED', `Unknown skin preset "${raw}"`)
        }
        requests.push({ name: `${clip.name}_${preset.suffix}`, palette: preset.palette })
      }
    }
    if (Array.isArray(args.variants)) {
      for (const item of args.variants as Array<{ name?: unknown; palette?: unknown }>) {
        if (!item || typeof item.name !== 'string' || !item.name.trim()) {
          throw new CommandError('VALIDATION_FAILED', 'Each custom variant requires a non-empty name')
        }
        if (!Array.isArray(item.palette) || item.palette.length === 0 || item.palette.length > 256) {
          throw new CommandError('VALIDATION_FAILED', `Variant "${item.name}" palette must be 1–256 hex colors`)
        }
        requests.push({
          name: item.name.trim().slice(0, 60),
          palette: item.palette.map((c) => asHex(c, 'variant palette color')),
        })
      }
    }
    if (requests.length === 0 || requests.length > 8) {
      throw new CommandError('VALIDATION_FAILED', 'Supply 1–8 skin presets or custom variants')
    }

    const created = materializeSkinVariants(getBus(), clip, requests, 'mcp', { mode })
    return withStateHash(
      { sourceClipId: clip.id, mode, created },
      { undoable: true, summary: `Created ${created.length} skin variant clip(s) from "${clip.name}"` },
    )
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

  async set_clip_tags(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const tags = parseClipTags(args.tags, clip)
    execCommand('clip.setTags', { clipId: clip.id, tags })
    return withStateHash({ clipId: clip.id, tags }, { undoable: true, summary: `Set ${tags.length} animation tag${tags.length === 1 ? '' : 's'} on "${clip.name}"` })
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
    if (args.locked !== undefined) {
      if (typeof args.locked !== 'boolean') throw new CommandError('VALIDATION_FAILED', 'locked must be boolean')
      patch.locked = args.locked
    }
    if (args.blend !== undefined) {
      const blendModes: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten']
      if (typeof args.blend !== 'string' || !blendModes.includes(args.blend as BlendMode)) {
        throw new CommandError('VALIDATION_FAILED', 'blend must be normal | multiply | screen | overlay | darken | lighten')
      }
      patch.blend = args.blend
    }
    if (Object.keys(patch).length === 0) throw new CommandError('VALIDATION_FAILED', 'provide at least one of name/visible/opacity/locked/blend')
    execCommand('layer.setProps', { clipId: clip.id, layerId: layer.id, patch })
    return withStateHash({ clipId: clip.id, layerId: layer.id, patch }, { undoable: true, summary: `Updated layer "${layer.name}"` })
  },

  async set_layer_linked(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const layer = resolveLayerRef(clip, args)
    if (typeof args.linked !== 'boolean') throw new CommandError('VALIDATION_FAILED', 'linked must be boolean')
    execCommand('layer.setLinked', { clipId: clip.id, layerId: layer.id, linked: args.linked })
    return withStateHash(
      { clipId: clip.id, layerId: layer.id, linked: args.linked },
      { undoable: true, summary: `${args.linked ? 'Linked' : 'Unlinked'} layer "${layer.name}" across frames` },
    )
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

  async remove_palette_color(args) {
    const hex = asHex(args.hex, 'hex')
    execCommand('palette.removeColor', { hex })
    return withStateHash({ removed: hex, palette: [...getBus().getProject().palette] }, { undoable: true, summary: `Removed ${hex} from the palette` })
  },

  async set_palette(args) {
    if (!Array.isArray(args.colors) || args.colors.length === 0 || args.colors.length > 256) {
      throw new CommandError('VALIDATION_FAILED', 'colors must be a 1–256 hex color array')
    }
    const colors = args.colors.map((c) => asHex(c, 'colors[]'))
    execCommand('palette.replaceAll', { colors })
    return withStateHash({ palette: colors }, { undoable: true, summary: `Replaced the palette (${colors.length} colors)` })
  },

  async set_style_profile(args) {
    const profile = parseStyleProfile(args.profile)
    if (!profile) {
      throw new CommandError('VALIDATION_FAILED', 'profile must contain a valid bounded PixelForge style profile')
    }
    execCommand('settings.setStyleProfile', { profile })
    return withStateHash(
      { styleProfile: profile },
      { undoable: true, summary: `Updated style profile "${profile.name}"` },
    )
  },

  async pin_style_anchor(args) {
    const project = getBus().getProject()
    if (args.clear === true) {
      const existing = project.settings.styleProfile
      if (!existing?.anchor) {
        return withStateHash(
          { styleAnchor: null, cleared: false },
          { undoable: false, summary: 'No Hero Style Anchor was pinned' },
        )
      }
      const rest = { ...existing }
      delete rest.anchor
      execCommand('settings.setStyleProfile', { profile: rest })
      return withStateHash(
        { styleAnchor: null, cleared: true },
        { undoable: true, summary: 'Cleared Hero Style Anchor' },
      )
    }
    const clip = resolveClipRef(project, args)
    const { frame, index: frameIndex } = resolveFrameRef(clip, args)
    const label =
      args.label !== undefined
        ? asString(args.label, 'label', 64)
        : `${clip.name} · F${frameIndex + 1}`
    const rgba = composeFrameRgba(project, clip, frame)
    const anchor = measureStyleAnchor(rgba, project.width, project.height, {
      label,
      clipId: clip.id,
      frameIndex,
    })
    if (!anchor) {
      throw new CommandError('VALIDATION_FAILED', 'cannot pin an empty frame — draw a sprite first')
    }
    const base = project.settings.styleProfile ?? defaultStyleProfile()
    execCommand('settings.setStyleProfile', { profile: { ...base, enabled: true, anchor } })
    return withStateHash(
      { styleAnchor: anchor, promptTags: styleProfilePromptTags({ ...base, enabled: true, anchor }) },
      {
        undoable: true,
        summary: `Pinned Hero Style Anchor "${anchor.label}" (${anchor.spriteWidth}×${anchor.spriteHeight}px, ground ${anchor.bottomMargin}px, ${anchor.outlineStyle}, craft ${anchor.craftScore}/100)`,
      },
    )
  },

  async import_image_as_layer(args, ctx) {
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
    assertTaskProject(ctx)
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

  async import_frame_strip(args, ctx) {
    return importFrameStrip(args, () => assertTaskProject(ctx))
  },

  async macro_save(args) {
    const { macroSave } = await import('./mcp-macros')
    const name = asString(args.name, 'name', 60)
    if (!Array.isArray(args.steps) || args.steps.length === 0 || args.steps.length > 50) {
      return fail('validation_failed', 'steps must be an array of 1–50 { tool, args } objects')
    }
    const steps: { tool: string; args: Record<string, unknown> }[] = []
    for (let i = 0; i < args.steps.length; i++) {
      const s = args.steps[i] as Record<string, unknown>
      if (!s || typeof s.tool !== 'string') {
        return fail('validation_failed', `steps[${i}].tool is required`)
      }
      steps.push({
        tool: s.tool,
        args: (s.args && typeof s.args === 'object' ? s.args : {}) as Record<string, unknown>,
      })
    }
    const macro = macroSave(name, steps)
    return withStateHash(
      { name: macro.name, steps: macro.steps.length },
      { summary: `Macro "${macro.name}" saved (${macro.steps.length} steps)` },
    )
  },

  async macro_list() {
    const { macroList } = await import('./mcp-macros')
    const macros = macroList()
    return withStateHash(
      { macros: macros.map((m) => ({ name: m.name, steps: m.steps.length, savedAt: m.savedAt })) },
      { summary: `${macros.length} macro(s) saved` },
    )
  },

  async macro_run(args, ctx) {
    const { macroRun } = await import('./mcp-macros')
    assertTaskProject(ctx)
    const name = asString(args.name, 'name', 60)
    const out = await macroRun(name, (tool, runArgs) => executeMcpTool(tool, runArgs, {
      clientId: 'macro',
      clientName: 'macro',
      tier: 'L1',
      expectedProjectKey: ctx.expectedProjectKey,
      expectedLoadEpoch: ctx.expectedLoadEpoch,
    }), args.stopOnError === false)
    const bad = out.results.find((r) => !r.ok)
    return withStateHash(
      { name, completed: out.completed, ok: out.ok, rolledBack: out.rolledBack ?? false, results: out.results },
      {
        summary: out.rolledBack
          ? `Macro "${name}" rolled back — step ${bad?.step ?? '?'} failed: ${bad?.error?.message ?? ''} (document unchanged)`
          : out.ok
            ? `Macro "${name}" completed (${out.completed}/${out.results.length} steps, ONE undo entry)`
            : `Macro "${name}" failed at step ${bad?.step ?? '?'} — ${bad?.error?.message ?? ''}`,
      },
    )
  },

  async batch(args, ctx) {
    const { runStepsInTransaction } = await import('./mcp-macros')
    assertTaskProject(ctx)
    const raw = args.steps
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) {
      return fail('validation_failed', 'steps must be an array of 1–50 {tool, args} entries')
    }
    const steps = raw.map((s, i) => {
      if (!s || typeof s !== 'object' || typeof (s as Record<string, unknown>).tool !== 'string' || !(s as Record<string, unknown>).tool) {
        throw new CommandError('VALIDATION_FAILED', `steps[${i}].tool must be a non-empty string`)
      }
      const { tool, args: stepArgs } = s as { tool: string; args?: Record<string, unknown> }
      return { tool, args: stepArgs && typeof stepArgs === 'object' ? stepArgs : {} }
    })
    const out = await runStepsInTransaction(`Batch (${steps.length} steps)`, steps, (tool, runArgs) => executeMcpTool(tool, runArgs, {
      clientId: 'macro',
      clientName: 'macro',
      tier: 'L1',
      expectedProjectKey: ctx.expectedProjectKey,
      expectedLoadEpoch: ctx.expectedLoadEpoch,
    }), args.stopOnError === false)
    const bad = out.results.find((r) => !r.ok)
    return withStateHash(
      { completed: out.completed, ok: out.ok, rolledBack: out.rolledBack ?? false, results: out.results },
      {
        summary: out.rolledBack
          ? `Batch rolled back — step ${bad?.step ?? '?'} failed: ${bad?.error?.message ?? ''} (document unchanged)`
          : out.ok
            ? `Batch completed (${out.completed}/${out.results.length} steps, ONE undo entry)`
            : `Batch failed at step ${bad?.step ?? '?'} — ${bad?.error?.message ?? ''}`,
      },
    )
  },

  async macro_delete(args) {
    const { macroDelete } = await import('./mcp-macros')
    const name = asString(args.name, 'name', 60)
    if (!macroDelete(name)) return fail('not_found', `Macro "${name}" not found`)
    return withStateHash({ deleted: name }, { summary: `Macro "${name}" deleted` })
  },

  async beautify_layer(args) {
    const project = getBus().getProject()
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    const layer = resolveLayerRef(clip, args)
    const existingCel = frame.cels[layer.id]
    if (!existingCel) throw new CommandError('VALIDATION_FAILED', 'nothing to beautify — the layer is empty')
    const outline =
      args.outline === null ? null
      : args.outline !== undefined ? hexToRgba(asString(args.outline, 'outline', 9))
      : ([26, 28, 44, 255] as RGBA)
    const selOut = args.selOut === true
    const shade = args.shade !== false
    const highlight = args.highlight === true
    const cleanDoubles = args.cleanDoubles !== false
    const paletteLock = args.paletteLock !== false
    const working = new Uint8ClampedArray(existingCel.buffer)
    const changed = paletteLock || selOut || highlight || cleanDoubles
      ? polishLayerPixelArt(working, project.width, project.height, {
          palette: paletteLock ? project.palette : undefined,
          outline,
          selOut,
          shade,
          highlight,
          cleanDoubles,
        })
      : beautifyLayer(working, project.width, project.height, { outline, shade })
    if (!changed) throw new CommandError('VALIDATION_FAILED', 'nothing to beautify — the layer is empty or unchanged')
    execCommand(
      'pixels.applyOp',
      { clipId: clip.id, frameId: frame.id, layerId: layer.id, ops: [{ op: 'setBuffer', buffer: working }] },
      `Beautify layer "${layer.name}"`,
    )
    return withStateHash(
      { clipId: clip.id, frameId: frame.id, layerId: layer.id, selOut, shade, highlight, cleanDoubles, paletteLock, craftGate: buildCraftGate(clip.id, frame.id, layer.id) },
      {
        undoable: true,
        summary: `Polished "${layer.name}" — ${selOut ? 'sel-out' : outline ? 'outline' : 'no outline'}, shade ${shade ? 'on' : 'off'}${highlight ? ', highlight on' : ''}${cleanDoubles ? ', doubles cleaned' : ''}`,
      },
    )
  },

  async harvest_palette(args) {
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
    const decoded = await decodePng(binary).catch(() => null)
    if (!decoded) return fail('validation_failed', 'pngBase64 is not a decodable PNG')
    const maxColors = typeof args.maxColors === 'number' ? Math.max(2, Math.min(32, Math.floor(args.maxColors))) : 16
    const colors = harvestPalette(decoded.rgba, maxColors)
    return withStateHash(
      { colors, count: colors.length },
      { summary: `Harvested ${colors.length} colors (dark → light) — apply with set_palette` },
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

  async set_parts(args, ctx) {
    const { rectsIntersect } = await import('@pixelforge/core')
    assertTaskProject(ctx)
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

  async apply_motion_preset(args, ctx) {
    const { analyzeMotionPlan, composeFrameRgba, getPreset, planMotion, PRESET_IDS } = await import('@pixelforge/core')
    assertTaskProject(ctx)
    const project = getBus().getProject()
    const source = resolveClipRef(project, {
      clipId: typeof args.sourceClipId === 'string' ? args.sourceClipId : undefined,
      clipName: typeof args.sourceClipName === 'string' ? args.sourceClipName : undefined,
    })
    const rawPreset = typeof args.preset === 'string' ? args.preset.trim() : ''
    const presetId = (PRESET_IDS as readonly string[]).includes(rawPreset)
      ? rawPreset
      : (resolveMotionPresetSynonym(rawPreset) ?? rawPreset)
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

  async save_project() {
    const saved = await saveProjectFile()
    if (!saved) {
      return fail('save_canceled', 'Save did not complete — no file chosen (dialog dismissed) or running on web.', 'Call again and pick a destination in the Save As dialog.')
    }
    return withStateHash({}, { undoable: false, summary: 'Project saved to its .pixelforgeproj file' })
  },

  async brain_interpret_prompt(args) {
    const prompt = asString(args.prompt, 'prompt', 2000)
    const project = getBus().getProject()
    const st = useEditor.getState()
    const mem = readBrainMemory()
    // recommendations filtered against the real editor catalog (registry-lite)
    const interpreted = interpretAndEnhancePrompt(
      prompt,
      project,
      {
        clipId: st.activeClipId,
        layerId: st.activeLayerId,
        frameIndex: st.activeFrameIndex,
      },
      mem,
      MCP_TOOL_NAMES,
    )
    return withStateHash(
      {
        interpreted,
        learnedPreferences: { prefer: mem.prefer, avoid: mem.avoid },
      },
      {
        undoable: false,
        summary: `Second Brain interpreted "${prompt.slice(0, 48)}" → intent=${interpreted.detectedIntent} (${interpreted.corrections.length} correction(s))`,
      },
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

// These handlers apply their edit synchronously before computing the result hash.
const REVIEW_TOOLS = new Set([
  'set_pixels',
  'fill_rect',
  'draw_line',
  'draw_ellipse',
  'draw_polygon',
  'flood_fill',
  'replace_color',
  'flip_frame',
  'rotate_frame',
  'shift_frame',
  'center_content',
  'remap_palette',
  'beautify_layer',
  'resize_canvas',
  'auto_trim',
])

function reviewFrame(project: Project, clip: Clip, frame: Frame, layerId?: string): ReviewFrame {
  const { width, height } = project
  if (layerId === undefined) return { buffer: composeFrameRgba(project, clip, frame), width, height }
  const pixels = frame.cels[layerId]?.buffer
  const buffer = pixels ? new Uint8ClampedArray(pixels) : new Uint8ClampedArray(width * height * 4)
  return { buffer, width, height }
}

function captureToolReview(tool: string, args: Record<string, unknown>) {
  const project = getBus().getProject()
  const { loadEpoch } = useEditor.getState()
  const isCanvasOp = tool === 'resize_canvas' || tool === 'auto_trim'
  const targetArgs = isCanvasOp ? {} : args
  const clip = resolveClipRef(project, targetArgs)
  const { frame, index } = resolveFrameRef(clip, targetArgs)
  const layer =
    isCanvasOp ||
    (tool === 'center_content' && args.allLayers === true) ||
    (tool === 'remap_palette' && args.scope !== 'layer')
      ? undefined
      : resolveLayerRef(clip, targetArgs)
  return {
    loadEpoch,
    clipId: clip.id,
    clipName: clip.name,
    frameId: frame.id,
    frameNumber: index + 1,
    layerId: layer?.id,
    layerName: layer?.name,
    before: reviewFrame(project, clip, frame, layer?.id),
  }
}

function finishToolReview(before: ReturnType<typeof captureToolReview>): ToolReview | null {
  const project = getBus().getProject()
  if (before.loadEpoch !== useEditor.getState().loadEpoch) return null
  const clip = project.clips.find((item) => item.id === before.clipId)
  const frame = clip?.frames.find((item) => item.id === before.frameId)
  if (!clip || !frame) return null
  const after = reviewFrame(project, clip, frame, before.layerId)
  return {
    ...before,
    after,
    checks: validateStyleCandidate({
      buffer: after.buffer,
      width: project.width,
      height: project.height,
      targetWidth: project.width,
      targetHeight: project.height,
      palette: project.palette,
      profile: project.settings.styleProfile,
    }),
  }
}

const VISUAL_DRAW_TOOLS = new Set([
  'set_pixels',
  'fill_rect',
  'draw_line',
  'draw_ellipse',
  'draw_polygon',
  'flood_fill',
  'replace_color',
  'flip_frame',
  'rotate_frame',
  'shift_frame',
  'center_content',
  'remap_palette',
  'beautify_layer',
  'generate_template',
  'generate_vfx',
  'apply_motion_preset',
  'import_image_as_layer',
  'import_frame_strip',
  'create_skin_variants',
  'batch',
])

interface VisualBefore {
  clipIds: Set<string>
  width: number
  height: number
  target: { clipId: string; frameId: string; buffer: Uint8ClampedArray } | null
}

/** Snapshot the frame the tool will actually edit (from its clip/frame args), not just the active one. */
function snapshotToolTarget(args: Record<string, unknown>): VisualBefore {
  const project = getBus().getProject()
  const base = { clipIds: new Set(project.clips.map((c) => c.id)), width: project.width, height: project.height }
  try {
    const clip = resolveClipRef(project, args)
    const { frame } = resolveFrameRef(clip, args)
    return { ...base, target: { clipId: clip.id, frameId: frame.id, buffer: composeFrameRgba(project, clip, frame) } }
  } catch {
    return { ...base, target: null }
  }
}

/** Diff what the tool changed: a brand-new clip (VFX / strips / skins) sweeps in from empty; otherwise the edited frame. */
function collectVisualDiff(before: VisualBefore): {
  clipId: string
  frameId: string
  clipName: string
  frameNumber: number
  width: number
  height: number
  beforeBuffer: Uint8ClampedArray
  afterBuffer: Uint8ClampedArray
  diff: ReturnType<typeof diffChangedPixels>
} | null {
  const project = getBus().getProject()
  const created = project.clips.filter((c) => !before.clipIds.has(c.id))
  if (created.length > 0) {
    const activeId = useEditor.getState().activeClipId
    const clip = created.find((c) => c.id === activeId) ?? created[created.length - 1]!
    const frame = clip.frames[0]
    if (frame) {
      const afterBuffer = composeFrameRgba(project, clip, frame)
      const beforeBuffer = new Uint8ClampedArray(afterBuffer.length)
      const diff = diffChangedPixels(beforeBuffer, afterBuffer, project.width, project.height)
      if (diff.totalChanged > 0) {
        return {
          clipId: clip.id,
          frameId: frame.id,
          clipName: clip.name,
          frameNumber: 1,
          width: project.width,
          height: project.height,
          beforeBuffer,
          afterBuffer,
          diff,
        }
      }
    }
  }
  if (before.target && before.width === project.width && before.height === project.height) {
    const clip = project.clips.find((c) => c.id === before.target!.clipId)
    const frameIdx = clip?.frames.findIndex((f) => f.id === before.target!.frameId) ?? -1
    const frame = clip && frameIdx >= 0 ? clip.frames[frameIdx] : undefined
    if (clip && frame) {
      const afterBuffer = composeFrameRgba(project, clip, frame)
      const beforeBuffer = before.target.buffer
      const diff = diffChangedPixels(beforeBuffer, afterBuffer, project.width, project.height)
      if (diff.totalChanged > 0) {
        return {
          clipId: clip.id,
          frameId: frame.id,
          clipName: clip.name,
          frameNumber: frameIdx + 1,
          width: project.width,
          height: project.height,
          beforeBuffer,
          afterBuffer,
          diff,
        }
      }
    }
  }
  return null
}

export async function executeMcpTool(tool: string, args: unknown, ctx: ToolExecContext): Promise<ToolExecResult> {
  const handler = handlers[tool]
  if (!handler) {
    return fail('unknown_tool', `Tool "${tool}" is not implemented by this editor (it may be deferred to a later phase).`)
  }
  const agentName = ctx.clientName || 'AI Agent'
  const showLive = ctx.clientId !== 'macro' && tool !== 'get_quota' && tool !== 'get_operation_log'
  const isWriteTool = (MCP_TOOL_TIERS.get(tool) ?? ctx.tier) !== 'L0'

  // Artist Priority Pause: let read-only inspection continue, hold mutations until resumed
  if (showLive && isWriteTool && isAiPaused()) {
    emitAiNotice(agentName, tool, 'Paused — artist holds canvas', 'waiting')
    recordAiActivityEntry({
      clientName: agentName,
      tool,
      label: `Held: ${describeAiTool(tool)}`,
      ok: false,
      status: 'paused',
    })
    return fail(
      'artist_paused',
      'The artist paused live AI edits — wait until they resume before modifying the canvas.',
      'Check with the artist and retry once they click Resume on the live AI HUD.',
    )
  }

  const bus = getBus()
  if (bus.activeStroke) {
    if (showLive) {
      emitAiNotice(agentName, tool, 'Waiting — you are painting', 'waiting')
    }
    return fail('editor_busy', 'A manual stroke is in progress — retry in a moment.', 'The tool will run as soon as the pointer interaction ends.')
  }
  if (ctx.expectedProjectKey !== undefined && ctx.expectedLoadEpoch === undefined) {
    ctx = { ...ctx, expectedLoadEpoch: useEditor.getState().loadEpoch }
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
  if (showLive) beginAiToolActivity(agentName, tool)
  const undoDepthBefore = bus.historyStats().undoDepth
  const beforeVisual = VISUAL_DRAW_TOOLS.has(tool) ? snapshotToolTarget(safeArgs) : null
  try {
    assertTaskProject(ctx)
    if (ctx.expectedProjectKey && (tool === 'create_project' || tool === 'open_project')) {
      return fail('task_project_mismatch', 'Finish or cancel the claimed task before replacing its project.')
    }
    const before = ctx.onReview && REVIEW_TOOLS.has(tool) ? captureToolReview(tool, safeArgs) : null
    const pending = handler(safeArgs, ctx)
    const review = before ? finishToolReview(before) : null
    const res = await pending

    const undoDepthAfter = bus.historyStats().undoDepth
    const loadEpoch = useEditor.getState().loadEpoch
    const hit = res.ok && beforeVisual ? collectVisualDiff(beforeVisual) : null
    let offView = false

    if (hit) {
      if (isAiAutoFollow()) {
        // make sure the artist is looking at the clip/frame the agent just painted
        followCommandTarget({ clipId: hit.clipId, frameId: hit.frameId })
      } else {
        const stNow = useEditor.getState()
        const curClip = stNow.project.clips.find((c) => c.id === stNow.activeClipId) ?? stNow.project.clips[0]
        const curFrame = curClip?.frames[Math.min(stNow.activeFrameIndex, (curClip.frames.length || 1) - 1)]
        offView = stNow.activeClipId !== hit.clipId || curFrame?.id !== hit.frameId
      }
      emitAiDrawPulse({
        clientName: agentName,
        tool,
        label: res.summary ?? `Updated ${hit.diff.totalChanged} px`,
        clipId: hit.clipId,
        frameId: hit.frameId,
        pixels: hit.diff.pixels,
        totalChanged: hit.diff.totalChanged,
        bbox: hit.diff.bbox,
        reveal: {
          clipId: hit.clipId,
          frameId: hit.frameId,
          width: hit.width,
          height: hit.height,
          before: hit.beforeBuffer,
          after: hit.afterBuffer,
          orderedIndices: hit.diff.orderedIndices,
        },
      })

      // Auto-Eyes: attach deterministic spatial self-critique (`visualCheck`)
      // plus a crisp zoomed gridded PNG (`autoPreviewPng`) for external MCP
      // vision agents so they immediately SEE what they just drew and spot
      // crooked details, floating dots, or bad proportions without going blind.
      if (res.data && isRecord(res.data)) {
        const projNow = bus.getProject()
        const visualCheck = buildVisualCheck(hit.afterBuffer, hit.width, hit.height, projNow.palette)
        let autoPreviewPng: string | undefined
        if (ctx.clientId !== 'macro' && ctx.clientId !== 'agent-console' && ctx.clientId !== 'second-brain') {
          const targetClip = projNow.clips.find((c) => c.id === hit.clipId)
          const targetFrame = targetClip?.frames.find((f) => f.id === hit.frameId)
          if (targetClip && targetFrame) {
            const zoomScale = recommendedInspectionScale(projNow.width, projNow.height)
            autoPreviewPng = await framePng(projNow, targetClip, targetFrame, zoomScale, zoomScale >= 4)
          }
        }
        res.data = {
          ...res.data,
          visualCheck,
          ...(autoPreviewPng ? { autoPreviewPng } : {}),
        }
      }
    }

    let entryId: number | undefined
    if (showLive && (isWriteTool || !res.ok || hit)) {
      const undoableStep = res.ok && res.undoable !== false && undoDepthAfter > undoDepthBefore
      entryId = recordAiActivityEntry({
        clientName: agentName,
        tool,
        label: res.ok ? (res.summary ?? describeAiTool(tool)) : (res.error?.message ?? 'Tool error'),
        ok: res.ok,
        status: res.ok ? 'ok' : 'error',
        totalChanged: hit?.diff.totalChanged ?? 0,
        clipId: hit?.clipId,
        frameId: hit?.frameId,
        clipName: hit?.clipName,
        frameNumber: hit?.frameNumber,
        bbox: hit?.diff.bbox ?? null,
        undoDepthAfter: undoableStep ? undoDepthAfter : undefined,
        loadEpoch,
        compare: hit
          ? {
              clipId: hit.clipId,
              frameId: hit.frameId,
              width: hit.width,
              height: hit.height,
              before: hit.beforeBuffer,
            }
          : undefined,
      })
    }

    if (showLive) {
      endAiToolActivity(agentName, tool, res.ok ? res.summary : res.error?.message, {
        tone: res.ok ? 'live' : 'error',
        totalChanged: hit?.diff.totalChanged,
        clipId: hit?.clipId,
        frameId: hit?.frameId,
        clipName: hit?.clipName,
        frameNumber: hit?.frameNumber,
        offView,
        entryId,
      })
    }
    if (res.ok && review) ctx.onReview?.(review)
    if (res.ok && tool !== 'get_project_state' && tool !== 'get_clip' && tool !== 'get_palette' && tool !== 'get_frame_png') {
      recordAgentContextEvent(ctx.clientName || 'mcp-agent', tool, res.summary ?? `Executed ${tool}`)
    }
    return res
  } catch (err) {
    if (showLive) {
      const msg = err instanceof Error ? err.message : 'Tool error'
      const entryId = recordAiActivityEntry({
        clientName: agentName,
        tool,
        label: msg,
        ok: false,
        status: 'error',
      })
      endAiToolActivity(agentName, tool, msg, { tone: 'error', entryId })
    }
    if (err instanceof TaskProjectMismatch) return fail('task_project_mismatch', err.message)
    if (err instanceof CommandError) {
      return fail(err.code.toLowerCase(), err.message)
    }
    return fail('internal_error', err instanceof Error ? err.message : 'Tool execution failed')
  }
}
