// PixelForge AI — editor state store (Zustand) — Task 4 core-backed shim.
//
// Architecture (v3.1 §12 Task 4 "Port renderer onto core"):
//   • @pixelforge/core owns the DOCUMENT: model v2 (per-clip layer stacks +
//     per-frame cels, linked cels, trash), the CommandBus (the single
//     mutation path — UI/AI all execute commands), tile-diff history with a
//     memory budget, and the command journal (crash recovery source).
//   • Zustand keeps UI + VIEW state (tool, zoom, pan, panels, playback,
//     active pointers) and mirrors bus-derived values (project reference,
//     dirty, undo/redo availability) so components stay plain subscribers.
//   • Action names from the prototype store are PRESERVED — components call
//     the same API; each action now maps onto a bus command instead of
//     mutating a v1 document by hand.
//
// The bus lives OUTSIDE React. Every bus change event re-syncs the mirrored
// slice; mid-stroke painting bumps `renderTick` only (no bus traffic).

import { create } from 'zustand'
import { makeBridgeFs } from './desktop-bridge'
import {
  CommandBus,
  JournalRecorder,
  CommandError,
  clearRegionInPlace,
  clampRect,
  collectUniqueOpaqueColors,
  composeFrameRgba,
  computeCenterShift,
  computeTrimBounds,
  createProject as coreCreateProject,
  locateCel,
  pasteRegionInPlace,
  polishLayerPixelArt,
  remapBufferToPalette,
  replaceColorInBuffer,
  sortPaletteColors,
  writeExportPlan,
  type CommandOrigin,
  type CustomBrush,
  type ClipTag,
  type MotionApplyPayload,
  type PaletteRemapMode,
  type PaletteSortBy,
  type PartRect,
  type PolishPixelArtOptions,
  type Project,
  type QAIssue,
  type StyleProfile,
  type StrokeHandle as CoreStrokeHandle,
} from '@pixelforge/core'
import { hexToRgba } from './color'
import { DEFAULT_PALETTE } from './palettes'
import { useAppSettings } from './settings'

import { toast } from '@/hooks/use-toast'
import { friendlyError } from '@/lib/utils'
import {
  composeSelectionMove,
  extractClipboard,
  shiftRectClamped,
} from './selection-ops'
import type {
  ClipboardContent,
  SelectionRect,
  ToolId,
  TransformKind,
} from './types'

export type { SelectionRect, ClipboardContent, TransformKind }

export const MIN_ZOOM = 0.25 // 25% — lets big canvases fit small screens
export const MAX_ZOOM = 64 // 6400% — 1 canvas px = 64 screen px

export type RightTab = 'layers' | 'reference' | 'brain' | 'motion' | 'agent'

/** Draft motion part (Motion Composer panel → part.set command). */
export interface MotionPartDraft {
  name: string
  layerId: string
  rect?: PartRect
}

/** Same shape as the core StrokeHandle (re-exported for components). */
export type StrokeHandle = CoreStrokeHandle

const ORIGIN: CommandOrigin = 'ui'

// ---------------------------------------------------------------------------
// core singletons (document + journal live outside React/zustand)
// ---------------------------------------------------------------------------

const initialDoc = coreCreateProject({ name: 'untitled', width: 32, height: 32, palette: DEFAULT_PALETTE })
const bus = new CommandBus(initialDoc)

/**
 * Journal sidecar flush hook — project-files.ts installs a throttled writer
 * once a .pixelforgeproj path is active, so commands issued after the last
 * save remain recoverable (crash window ≈ flush interval, not "next save").
 */
let journalFlushHook: ((records: { seq: number }[]) => void) | null = null
export function setJournalFlushHook(fn: ((records: unknown[]) => void) | null): void {
  journalFlushHook = fn as ((records: { seq: number }[]) => void) | null
}

const recorder = new JournalRecorder(bus, {
  onFlush: (records) => {
    try {
      journalFlushHook?.(records)
    } catch {
      /* sidecar flush is best-effort — never break the command path */
    }
  },
})

/** Test/infra access to the bus (project-files.ts, dev diagnostics). */
export function getBus(): CommandBus {
  return bus
}

/** Journal recorder attached to the bus (.pixelforgeproj sidecar/embedded ring). */
export function getRecorder(): JournalRecorder {
  return recorder
}

/** Settings `historyLimit` presets map onto v3.1 byte budgets (§2.5). */
function historyBudgetBytes(limit: number): number {
  switch (limit) {
    case 8: return 8 * 1024 * 1024
    case 20: return 16 * 1024 * 1024
    case 40: return 32 * 1024 * 1024
    case 100: return 64 * 1024 * 1024
    case 200: return 128 * 1024 * 1024
    case 500: return 256 * 1024 * 1024
    default: return 32 * 1024 * 1024
  }
}
bus.setHistoryBudget(historyBudgetBytes(useAppSettings.getState().historyLimit))
useAppSettings.subscribe((s, prev) => {
  if (s.historyLimit !== prev.historyLimit) {
    bus.setHistoryBudget(historyBudgetBytes(s.historyLimit))
  }
})

// NOTE: `palette.replaceAll` (preset apply, one undoable step) now ships as a
// core builtin — the old shim registration here was removed (it crashed with
// "already registered" after the command moved into packages/core).

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

interface ActiveRefs {
  clipId: string
  frameId: string
  frameIndex: number
  layerId: string
}

/** Resolve the active pointers against the LIVE document (safe fallbacks). */
function activeRefs(s: Pick<EditorState, 'activeClipId' | 'activeFrameIndex' | 'activeLayerId'>): ActiveRefs | null {
  const project = bus.getProject()
  const clip = project.clips.find((c) => c.id === s.activeClipId) ?? project.clips[0]
  if (!clip) return null
  const frameIndex = Math.min(Math.max(0, s.activeFrameIndex), clip.frames.length - 1)
  const frame = clip.frames[frameIndex]
  if (!frame) return null
  const layer = clip.layers.find((l) => l.id === s.activeLayerId) ?? clip.layers[clip.layers.length - 1]
  if (!layer) return null
  return { clipId: clip.id, frameId: frame.id, frameIndex, layerId: layer.id }
}

/** Paint-lock check: pixel tools refuse to touch a locked layer. */
function layerIsLocked(clipId: string, layerId: string): boolean {
  const clip = bus.getProject().clips.find((c) => c.id === clipId)
  return !!clip?.layers.find((l) => l.id === layerId)?.locked
}

function findNewLayerId(before: Set<string>, project: Project, clipId: string): string | null {
  const clip = project.clips.find((c) => c.id === clipId)
  if (!clip) return null
  for (let i = clip.layers.length - 1; i >= 0; i--) {
    const l = clip.layers[i]
    if (!before.has(l.id)) return l.id
  }
  return null
}

function layerIds(project: Project, clipId: string): Set<string> {
  const clip = project.clips.find((c) => c.id === clipId)
  return new Set(clip?.layers.map((l) => l.id) ?? [])
}

/**
 * Stroke-flow helper for one-shot selection edits (cut/delete/paste):
 * begin → mutate the working buffer → end as ONE tile-diff history entry.
 * Any failure cancels the stroke — the document is never half-mutated.
 */
function withStroke(
  label: string,
  refs: ActiveRefs,
  fn: (handle: CoreStrokeHandle) => boolean
): boolean {
  if (layerIsLocked(refs.clipId, refs.layerId)) {
    toast({ title: 'Layer is locked', description: 'Unlock it in the Layers panel to edit.', variant: 'destructive' })
    return false
  }
  let changed = false
  try {
    const handle = bus.beginStroke({ clipId: refs.clipId, frameId: refs.frameId, layerId: refs.layerId })
    changed = fn(handle)
    bus.endStroke(label, changed, ORIGIN)
    return changed
  } catch {
    if (bus.activeStroke) {
      try {
        bus.cancelStroke(ORIGIN)
      } catch {
        /* ignore */
      }
    }
    return false
  }
}

/**
 * Structural sanity for documents entering the editor (Task 4 §5 data-loss
 * protection): at least one clip, and every clip needs a frame to draw on
 * and a layer to draw with. The core v1 shape guard is deliberately loose
 * (serialization format check); THIS is the editor-entry gate. Degenerate
 * rows/files are refused with a toast instead of limping or crashing.
 */
export function isUsableProject(p: unknown): p is Project {
  if (!p || typeof p !== 'object') return false
  const doc = p as Project
  if (!Array.isArray(doc.clips) || doc.clips.length === 0) return false
  return doc.clips.every(
    (c) =>
      c &&
      Array.isArray(c.layers) &&
      c.layers.length > 0 &&
      Array.isArray(c.frames) &&
      c.frames.length > 0
  )
}

export interface EditorState {
  // document mirror (reference from the bus; v2 model)
  project: Project
  docVersion: number
  /** Bumped on every document replacement (new/load) — view-reset hooks. */
  loadEpoch: number
  // web-testbed persistence id (NOT part of the core document)
  projectId: string | null
  // active pointers (view state — v2 layer ids are clip-wide, so layer
  // context survives frame/clip switches without name matching)
  activeClipId: string
  activeFrameIndex: number
  activeLayerId: string
  // tool state
  tool: ToolId
  primary: string
  secondary: string
  brushSize: number
  brushShape: 'square' | 'circle'
  mirrorX: boolean
  mirrorY: boolean
  /** fill tool: 2×2 Bayer dither between primary and secondary */
  dither: boolean
  ellipseFilled: boolean
  // marquee selection — VIEW state only (v3.1 §2.8: excluded from history
  // until an op commits; cleared on frame/layer/clip switches)
  selection: SelectionRect | null
  // session clipboard (persists across frames/clips — pixels are pixels)
  clipboard: ClipboardContent | null
  // view state
  zoom: number
  panX: number
  panY: number
  showGrid: boolean
  /** Task 10b — tilemap mode: tile size in px (8/16/32), snap toggle, and
   *  stamp mode (a click fills the whole tile with the primary color). */
  tileSize: 8 | 16 | 32
  tileSnap: boolean
  tileStamp: boolean
  /** 3×3 live seamless tile preview + toroidal wrap painting (W shortcut) */
  tiledWrap: boolean
  /** value-preview: render the whole document desaturated */
  grayscale: boolean
  onionSkin: boolean
  hover: { x: number; y: number } | null
  // playback
  playing: boolean
  // history / persistence (mirrored from the bus)
  canUndo: boolean
  canRedo: boolean
  historyUndoDepth: number
  historyRedoDepth: number
  historyBytes: number
  dirty: boolean
  savedAt: number | null
  autosave: boolean
  // ui
  rightTab: RightTab
  /** Phase-1 Task 10 QA: live plan-preview issues from the Motion Composer
   *  panel (frame-scoped) — the timeline badges these frames while a motion
   *  preview is active. Cleared by the panel on unmount / accept. */
  motionPreviewIssues: QAIssue[]
  /** Live draft parts from MotionPanel so CanvasStage renders part overlays in real time. */
  motionDraftParts: MotionPartDraft[]
  /** Live Craft Check defect pins rendered directly over the canvas stage. */
  craftPins: Array<{ kind: 'doubles' | 'orphans' | 'jaggies'; x: number; y: number }>
  paletteOpen: boolean
  rightOpen: boolean
  rightWidth: number
  timelineOpen: boolean
  renderTick: number
  // desktop file state (set by project-files.ts)
  filePath: string | null
  savingFile: boolean

  // --- document actions ---
  newProject: (p: Project) => void
  loadProject: (p: Project, opts?: { projectId?: string | null; filePath?: string | null }) => void
  setName: (name: string) => void
  resizeCanvas: (w: number, h: number) => void

  // --- pixel stroke flow ---
  beginStroke: () => StrokeHandle | null
  endStroke: (label: string, changed: boolean) => void
  cancelStroke: () => void
  bump: () => void

  // --- undo/redo ---
  undo: () => void
  redo: () => void

  // --- structural commands (names preserved; each maps to a bus command) ---
  addFrame: (copyContent: boolean) => void
  deleteFrame: (index: number) => void
  moveFrame: (from: number, to: number) => void
  /** Drag-and-drop: reorder within a clip, or copy a frame into another
   *  clip (composited snapshot of the source frame onto the target's
   *  active layer, inserted before targetIndex). One undo entry. */
  dragFrame: (srcClipId: string, srcIndex: number, dstClipId: string, dstIndex: number) => void
  /** Per-frame duration override (Task 6): 0 = inherit the clip fps. */
  setFrameDuration: (frameIndex: number, durationMs: number) => void
  /** Document onion-skin range (Task 6): undoable via settings.setOnion. */
  setOnionRange: (patch: { prev?: number; next?: number }) => void
  /** Shared project contract for AI panel and future MCP clients. */
  setStyleProfile: (profile: StyleProfile) => void
  addLayer: () => void
  deleteLayer: (layerId: string) => void
  duplicateLayer: (layerId: string) => void
  mergeDown: (layerId: string) => void
  moveLayer: (layerId: string, dir: -1 | 1) => void
  reorderLayer: (layerId: string, toIndex: number) => void
  setLayerProp: (layerId: string, patch: Partial<Pick<{ name: string; visible: boolean; opacity: number; locked: boolean; blend: string }, 'name' | 'visible' | 'opacity' | 'locked' | 'blend'>>) => void
  setLayerLinked: (layerId: string, linked: boolean) => void
  polishLayer: (
    layerId: string,
    opts?: Omit<PolishPixelArtOptions, 'palette'> & { paletteLock?: boolean }
  ) => boolean
  /** Center opaque artwork on the canvas (active layer or all visible unlocked layers on active frame). */
  centerContent: (scope?: 'layer' | 'frame') => boolean
  /** Auto-trim empty canvas margins across the project with optional padding (0–16px). */
  autoTrimCanvas: (padding?: number) => { width: number; height: number; dx: number; dy: number } | null
  /** Sort document palette in OKLab space (undoable). */
  sortPalette: (by: PaletteSortBy) => void
  /** Replace exact RGBA pixels matching fromHex with toHex across layer/frame/clip (undoable). */
  replaceColor: (fromHex: string, toHex: string, scope?: 'layer' | 'frame' | 'clip') => number
  /** Remap artwork onto a target palette (OKLab luminance ramp or nearest) in one undoable transaction. */
  remapToPalette: (
    targetPalette: string[],
    opts?: { scope?: 'layer' | 'frame' | 'clip'; mode?: PaletteRemapMode; updatePalette?: boolean; label?: string }
  ) => number
  addClip: (name: string) => void
  deleteClip: (clipId: string) => void
  setClipTags: (tags: ClipTag[]) => void
  setClipProp: (
    clipId: string,
    patch: Partial<Pick<{ name: string; fps: number; loop: boolean; loopMode: 'forward' | 'reverse' | 'pingpong' }, 'name' | 'fps' | 'loop' | 'loopMode'>>
  ) => void
  addPaletteColor: (hex: string) => void
  removePaletteColor: (hex: string) => void
  // --- image / frame import (drop-to-canvas, frame clipboard) — returns where
  // the import landed. Formerly AI-candidate reconciliation; the generation
  // review cache was removed (subscription-only), the import path stays. ---
  importCandidateAsLayer: (buffer: Uint8ClampedArray, name: string) => { kind: 'layer'; clipId: string; targetId: string } | null
  importCandidateAsFrame: (buffer: Uint8ClampedArray, name: string) => { kind: 'frame'; clipId: string; targetId: string } | null
  /** Replace the whole palette in one undoable step (palette presets). */
  setPalette: (colors: string[], label: string) => void

  // --- motion composer (Task 10: part.set / motion.apply) ---
  /** Replace a clip's whole parts array in ONE undoable step. False = rejected. */
  setClipParts: (clipId: string, parts: MotionPartDraft[]) => boolean
  /** Run a motion preset through the composer; returns the created/target clip id. */
  applyMotionPreset: (payload: MotionApplyPayload) => string | null

  // --- Reference import hand-off (Brain → Reference panel) ---
  /** Brief text handed to the Reference panel (adopted once, then cleared). */
  referenceDraft: string | null
  setReferenceDraft: (brief: string | null) => void
  /** Mobile slide-over drawer for the panels dock (desktop uses rightOpen). */
  rightDrawerOpen: boolean
  setRightDrawerOpen: (v: boolean) => void
  /** Focus a right-dock tab from outside the dock (header, Brain, etc.).
   *  Event-handler context only — opens the dock/drawer with the tab. */
  requestRightTab: (tab: RightTab) => void

  // --- selection & ui ---
  selectClip: (id: string) => void
  selectFrame: (index: number) => void
  /** Playhead write (Task 6): the shared playback engine steps the frame
   * WITHOUT pausing, clearing the selection or bumping history. */
  setPlayhead: (index: number) => void
  selectLayer: (id: string) => void
  setTool: (t: EditorState['tool']) => void
  setPrimary: (hex: string) => void
  setSecondary: (hex: string) => void
  swapColors: () => void
  setBrushSize: (n: number) => void
  setBrushShape: (s: 'square' | 'circle') => void
  customBrush: CustomBrush | null
  setCustomBrush: (b: CustomBrush | null) => void
  /** Agent panel: auto-approve L1 tool calls (survives tab switches) */
  agentAutoL1: boolean
  setAgentAutoL1: (v: boolean) => void
  /** AI Agent conversation memory — survives panel tab switches */
  agentChat: import('./ai/agent-chat').AgentMsg[]
  setAgentChat: (m: import('./ai/agent-chat').AgentMsg[]) => void
  /** A one-shot request from another in-app surface (for example, Brain) to
   * start the built-in Agent.  Keeping it in the editor store means the
   * request survives the tab switch that mounts AgentPanel. */
  setMirrorX: (v: boolean) => void
  setMirrorY: (v: boolean) => void
  setDither: (v: boolean) => void
  setEllipseFilled: (v: boolean) => void
  // --- selection ops (Task 5a) ---
  setSelection: (rect: SelectionRect | null) => void
  deselect: () => void
  selectionCopy: () => void
  /** capture the active selection as a reusable brush stamp (Aseprite-style) */
  saveSelectionAsBrush: () => void
  selectionCut: () => void
  selectionPaste: () => void
  selectionDelete: () => void
  selectionNudge: (dx: number, dy: number) => void
  /** Commit a finished interactive selection drag (canvas calls this). */
  commitSelectionShift: (rect: SelectionRect, dx: number, dy: number, label: string) => boolean
  selectionTransform: (kind: TransformKind) => void
  celTransform: (kind: TransformKind) => void
  /** Free NN resample of the selection content into an explicit footprint. */
  selectionScaleTo: (target: SelectionRect) => void
  /** NN ×2/×3 upscale / ÷2 downsample of the selection (anchored top-left). */
  selectionScale: (factor: number) => void
  /** NN scale of the WHOLE active cel (factor 0.5 or integer 2–8). */
  celScale: (factor: number) => void
  setZoom: (z: number) => void
  setPan: (x: number, y: number) => void
  setShowGrid: (v: boolean) => void
  setTileSize: (v: 8 | 16 | 32) => void
  setTileSnap: (v: boolean) => void
  setTileStamp: (v: boolean) => void
  setTiledWrap: (v: boolean) => void
  setGrayscale: (v: boolean) => void
  setOnionSkin: (v: boolean) => void
  setHover: (h: { x: number; y: number } | null) => void
  setPlaying: (v: boolean) => void
  setRightTab: (t: RightTab) => void
  setMotionPreviewIssues: (issues: QAIssue[]) => void
  setMotionDraftParts: (parts: MotionPartDraft[]) => void
  setCraftPins: (pins: EditorState['craftPins']) => void
  setPaletteOpen: (v: boolean) => void
  setRightOpen: (v: boolean) => void
  setRightWidth: (w: number) => void
  setTimelineOpen: (v: boolean) => void
  setAutosave: (v: boolean) => void

  // --- persistence ---
  setProjectId: (id: string | null) => void
  setFilePath: (path: string | null) => void
  setSavingFile: (v: boolean) => void
  markSaved: () => void
  markDirty: () => void
}

// ---------------------------------------------------------------------------
// bus → zustand mirror
// ---------------------------------------------------------------------------

let docVersionCounter = 0
let loadEpochCounter = 0

function syncFromBus(extra: Partial<EditorState> = {}): void {
  docVersionCounter += 1
  const stats = bus.historyStats()
  useEditor.setState({
    project: bus.getProject(),
    docVersion: docVersionCounter,
    renderTick: docVersionCounter,
    dirty: bus.isDirty(),
    canUndo: bus.canUndo(),
    canRedo: bus.canRedo(),
    historyUndoDepth: stats.undoDepth,
    historyRedoDepth: stats.redoDepth,
    historyBytes: stats.bytes,
    ...extra,
  })
  revalidatePointers()
}

/** Keep the active pointers resolvable after undo/load/structural edits. */
function revalidatePointers(): void {
  const s = useEditor.getState()
  const project = bus.getProject()
  let clip = project.clips.find((c) => c.id === s.activeClipId)
  let patch: Partial<EditorState> | null = null
  if (!clip) {
    clip = project.clips[0]
    if (!clip) return
    patch = { activeClipId: clip.id }
  }
  const frameIndex = Math.min(Math.max(0, s.activeFrameIndex), clip.frames.length - 1)
  const frame = clip.frames[frameIndex]
  const layerExists = clip.layers.some((l) => l.id === s.activeLayerId)
  const nextLayerId = layerExists ? s.activeLayerId : (clip.layers[clip.layers.length - 1]?.id ?? '')
  if (frameIndex !== s.activeFrameIndex || !layerExists || patch) {
    patch = { ...(patch ?? {}), activeFrameIndex: frameIndex, activeLayerId: nextLayerId }
  }
  if (patch && (patch.activeFrameIndex !== s.activeFrameIndex || patch.activeLayerId !== s.activeLayerId || patch.activeClipId !== s.activeClipId)) {
    useEditor.setState(patch)
  }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export const useEditor = create<EditorState>()((set, get) => ({
  project: bus.getProject(),
  docVersion: 0,
  loadEpoch: 0,
  projectId: null,
  motionPreviewIssues: [],
  motionDraftParts: [],
  craftPins: [],
  activeClipId: initialDoc.clips[0]?.id ?? '',
  activeFrameIndex: 0,
  activeLayerId: initialDoc.clips[0]?.layers[0]?.id ?? '',
  tool: 'pencil',
  primary: '#2ce8f5',
  secondary: '#1a1c2c',
  brushSize: 1,
  brushShape: 'square' as 'square' | 'circle',
  customBrush: null,
  agentAutoL1: false,
  agentChat: [],
  mirrorX: false,
  mirrorY: false,
  dither: false,
  ellipseFilled: false,
  selection: null,
  clipboard: null,
  zoom: 12,
  panX: 0,
  panY: 0,
  showGrid: true,
  tileSize: 16,
  tileSnap: false,
  tileStamp: false,
  tiledWrap: false,
  grayscale: false,
  onionSkin: true,
  hover: null,
  playing: false,
  canUndo: false,
  canRedo: false,
  historyUndoDepth: 0,
  historyRedoDepth: 0,
  historyBytes: 0,
  dirty: false,
  savedAt: null,
  autosave: true,
  rightTab: 'layers',
  paletteOpen: true,
  rightOpen: true,
  rightWidth: 320,
  timelineOpen: true,
  renderTick: 0,
  filePath: null,
  savingFile: false,

  newProject: (p) => {
    if (!isUsableProject(p)) {
      toast({ title: 'Invalid project', description: 'The document has no usable clips, frames or layers.', variant: 'destructive' })
      return
    }
    bus.setProject(p, { dirty: true })
    loadEpochCounter += 1
    set({
      projectId: null,
      filePath: null,
      activeClipId: p.clips[0]?.id ?? '',
      activeFrameIndex: 0,
      activeLayerId: p.clips[0]?.layers.at(-1)?.id ?? p.clips[0]?.layers[0]?.id ?? '',
      savedAt: null,
      playing: false,
      zoom: 12,
      panX: 0,
      panY: 0,
      selection: null,
      loadEpoch: loadEpochCounter,
    })
    syncFromBus()
  },

  loadProject: (p, opts) => {
    if (!isUsableProject(p)) {
      toast({
        title: 'Project could not be opened',
        description: 'It contains no usable clips, frames or layers.',
        variant: 'destructive',
      })
      return
    }
    bus.setProject(p, { dirty: false })
    loadEpochCounter += 1
    set({
      projectId: opts?.projectId ?? null,
      filePath: opts?.filePath ?? null,
      activeClipId: p.clips[0]?.id ?? '',
      activeFrameIndex: 0,
      activeLayerId: p.clips[0]?.layers.at(-1)?.id ?? p.clips[0]?.layers[0]?.id ?? '',
      savedAt: Date.now(),
      playing: false,
      zoom: 12,
      panX: 0,
      panY: 0,
      selection: null,
      loadEpoch: loadEpochCounter,
    })
    syncFromBus()
  },

  setName: (name) => {
    try {
      bus.execute('project.rename', { name }, ORIGIN)
    } catch {
      /* validation failure (too long) — keep current name */
    }
  },

  // canvas resize for the OPEN project: buffers are re-created at the new
  // size with old pixels anchored top-left; bypasses tile history (full
  // document replace, same as newProject/loadProject)
  resizeCanvas: (w, h) => {
    const W = Math.max(16, Math.min(256, Math.round(w)))
    const H = Math.max(16, Math.min(256, Math.round(h)))
    const p = bus.getProject()
    if (p.width === W && p.height === H) return
    const remap = new Map<Uint8ClampedArray, Uint8ClampedArray>()
    const resized = (buf: Uint8ClampedArray) => {
      let out = remap.get(buf)
      if (!out) {
        out = new Uint8ClampedArray(W * H * 4)
        const cw = Math.min(p.width, W)
        const ch = Math.min(p.height, H)
        for (let y = 0; y < ch; y++) {
          out.set(buf.subarray(y * p.width * 4, y * p.width * 4 + cw * 4), y * W * 4)
        }
        remap.set(buf, out)
      }
      return out
    }
    const project: Project = {
      ...p,
      width: W,
      height: H,
      clips: p.clips.map((clip) => ({
        ...clip,
        frames: clip.frames.map((f) => {
          const cels: typeof f.cels = {}
          for (const [layerId, cel] of Object.entries(f.cels)) {
            cels[layerId] = { ...cel, buffer: resized(cel.buffer) }
          }
          return { ...f, cels }
        }),
      })),
    }
    bus.setProject(project, { dirty: true })
    // refit the view so the new canvas size is immediately visible
    const zoom = Math.max(1, Math.min(24, Math.floor(384 / Math.max(W, H))))
    set({ selection: null, zoom, panX: 0, panY: 0 })
    syncFromBus()
    toast({ title: `Canvas resized to ${W}×${H}` })
  },

  // --- pixel stroke flow ---

  beginStroke: () => {
    const refs = activeRefs(get())
    if (!refs) return null
    if (layerIsLocked(refs.clipId, refs.layerId)) {
      toast({ title: 'Layer is locked', description: 'Unlock it in the Layers panel to edit.', variant: 'destructive' })
      return null
    }
    try {
      return bus.beginStroke({ clipId: refs.clipId, frameId: refs.frameId, layerId: refs.layerId })
    } catch {
      return null // dangling refs / stroke conflict — same as v1 null return
    }
  },

  endStroke: (label, changed) => {
    if (!bus.activeStroke) return
    try {
      bus.endStroke(label, changed, ORIGIN)
    } catch {
      /* never throws under the guard above */
    }
  },

  cancelStroke: () => {
    if (!bus.activeStroke) return
    try {
      bus.cancelStroke(ORIGIN)
    } catch {
      /* same */
    }
  },

  bump: () => set((s) => ({ renderTick: s.renderTick + 1 })),

  // --- selection ops (Task 5a) ---------------------------------------------
  // Every committed mutation goes through the sanctioned bus paths: stroke
  // flow for pixel-moving edits (one tile-diff entry each), `pixels.applyOp`
  // rect commands for deterministic transforms.

  setSelection: (rect) => {
    if (!rect) {
      set({ selection: null })
      return
    }
    const { width, height } = bus.getProject()
    const clamped = clampRect(rect, width, height)
    set({ selection: clamped ? { x: clamped.x, y: clamped.y, w: clamped.w, h: clamped.h } : null })
  },

  deselect: () => set({ selection: null }),

  selectionCopy: () => {
    const { selection } = get()
    if (!selection) return
    const refs = activeRefs(get())
    if (!refs) return
    const project = bus.getProject()
    const cel = locateCel(project, refs.clipId, refs.frameId, refs.layerId)?.cel
    const source = cel?.buffer ?? new Uint8ClampedArray(project.width * project.height * 4)
    const clip = extractClipboard(source, project.width, project.height, selection)
    set({ clipboard: clip })
  },

  saveSelectionAsBrush: () => {
    const { selection } = get()
    if (!selection) return
    const refs = activeRefs(get())
    if (!refs) return
    const project = bus.getProject()
    const cel = locateCel(project, refs.clipId, refs.frameId, refs.layerId)?.cel
    const source = cel?.buffer ?? new Uint8ClampedArray(project.width * project.height * 4)
    const clip = extractClipboard(source, project.width, project.height, selection)
    set({ customBrush: { w: clip.w, h: clip.h, data: clip.buffer } })
    toast({ title: 'Custom brush saved', description: 'Paint stamps your selection — reset it in the brush popover.' })
  },

  selectionCut: () => {
    const { selection } = get()
    if (!selection) return
    const refs = activeRefs(get())
    if (!refs) return
    const project = bus.getProject()
    let captured: ClipboardContent | null = null
    const ok = withStroke('Cut selection', refs, (handle) => {
      captured = extractClipboard(handle.buffer, project.width, project.height, selection)
      clearRegionInPlace(handle.buffer, project.width, project.height, selection)
      return true
    })
    if (ok && captured) {
      set({ clipboard: captured, selection: null })
    }
  },

  selectionDelete: () => {
    const { selection } = get()
    if (!selection) return
    const refs = activeRefs(get())
    if (!refs) return
    const project = bus.getProject()
    const ok = withStroke('Delete selection', refs, (handle) => {
      clearRegionInPlace(handle.buffer, project.width, project.height, selection)
      return true
    })
    if (ok) set({ selection: null })
  },

  selectionPaste: () => {
    const { clipboard } = get()
    if (!clipboard) return
    const refs = activeRefs(get())
    if (!refs) return
    const project = bus.getProject()
    withStroke('Paste', refs, (handle) => {
      pasteRegionInPlace(
        handle.buffer,
        project.width,
        project.height,
        clipboard.buffer,
        clipboard.w,
        clipboard.h,
        clipboard.x,
        clipboard.y
      )
      return true
    })
  },

  selectionNudge: (dx, dy) => {
    const { selection } = get()
    if (!selection || (dx === 0 && dy === 0)) return
    const refs = activeRefs(get())
    if (!refs) return
    if (layerIsLocked(refs.clipId, refs.layerId)) {
      toast({ title: 'Layer is locked', description: 'Unlock it in the Layers panel to edit.', variant: 'destructive' })
      return
    }
    const project = bus.getProject()
    let ok = false
    try {
      const handle = bus.beginStroke({ clipId: refs.clipId, frameId: refs.frameId, layerId: refs.layerId })
      const snapshot = new Uint8ClampedArray(handle.buffer)
      composeSelectionMove(handle.buffer, snapshot, project.width, project.height, selection, dx, dy)
      ok = true
      bus.endStroke('Move selection', true, ORIGIN)
    } catch {
      if (bus.activeStroke) bus.cancelStroke(ORIGIN)
      return
    }
    if (ok) {
      set({
        selection: shiftRectClamped(selection, dx, dy, project.width, project.height),
      })
    }
  },

  commitSelectionShift: (rect, dx, dy, label) => {
    const refs = activeRefs(get())
    if (!refs) return false
    if (layerIsLocked(refs.clipId, refs.layerId)) {
      toast({ title: 'Layer is locked', description: 'Unlock it in the Layers panel to edit.', variant: 'destructive' })
      return false
    }
    const project = bus.getProject()
    let ok = false
    try {
      const handle = bus.beginStroke({ clipId: refs.clipId, frameId: refs.frameId, layerId: refs.layerId })
      const snapshot = new Uint8ClampedArray(handle.buffer)
      composeSelectionMove(handle.buffer, snapshot, project.width, project.height, rect, dx, dy)
      ok = dx !== 0 || dy !== 0
      bus.endStroke(label, ok, ORIGIN)
    } catch {
      if (bus.activeStroke) bus.cancelStroke(ORIGIN)
      return false
    }
    if (ok) {
      set({
        selection: shiftRectClamped(rect, dx, dy, project.width, project.height),
      })
    }
    return ok
  },

  selectionTransform: (kind) => {
    const { selection } = get()
    if (!selection) return
    const refs = activeRefs(get())
    if (!refs) return
    try {
      bus.execute(
        'pixels.applyOp',
        {
          clipId: refs.clipId,
          frameId: refs.frameId,
          layerId: refs.layerId,
          ops: [{ op: kind, rect: { x: selection.x, y: selection.y, w: selection.w, h: selection.h } }],
        },
        ORIGIN
      )
    } catch {
      return
    }
    if (kind === 'rotateCW' || kind === 'rotateCCW') {
      // non-square selections adopt their rotated footprint (same anchor)
      const { width, height } = bus.getProject()
      const rotated = clampRect(
        { x: selection.x, y: selection.y, w: selection.h, h: selection.w },
        width,
        height
      )
      set({ selection: rotated ? { x: rotated.x, y: rotated.y, w: rotated.w, h: rotated.h } : null })
    }
  },

  celTransform: (kind) => {
    const refs = activeRefs(get())
    if (!refs) return
    try {
      bus.execute(
        'pixels.applyOp',
        { clipId: refs.clipId, frameId: refs.frameId, layerId: refs.layerId, ops: [{ op: kind }] },
        ORIGIN
      )
    } catch {
      /* invalid target — ignore */
    }
  },

  // --- nearest-neighbor scaling (selection / whole cel) ---------------------
  // Same sanctioned path as the flips above: `pixels.applyOp` with the
  // deterministic 'scaleTo' / 'scale' ops (NN, anchored at the region's
  // top-left; content pushed outside the canvas is clipped away).

  selectionScaleTo: (target) => {
    const { selection } = get()
    if (!selection) return
    const w = Math.max(1, Math.round(target.w))
    const h = Math.max(1, Math.round(target.h))
    if (w === selection.w && h === selection.h) return // identical footprint no-op
    const refs = activeRefs(get())
    if (!refs) return
    try {
      bus.execute(
        'pixels.applyOp',
        {
          clipId: refs.clipId,
          frameId: refs.frameId,
          layerId: refs.layerId,
          ops: [{ op: 'scaleTo', rect: { x: selection.x, y: selection.y, w: selection.w, h: selection.h }, to: { x: target.x, y: target.y, w, h } }],
        },
        ORIGIN
      )
    } catch {
      return
    }
    const { width, height } = bus.getProject()
    const clamped = clampRect({ x: target.x, y: target.y, w, h }, width, height)
    set({ selection: clamped ? { x: clamped.x, y: clamped.y, w: clamped.w, h: clamped.h } : null })
  },

  selectionScale: (factor) => {
    const { selection } = get()
    if (!selection || !(factor > 0)) return
    const target: SelectionRect = {
      x: selection.x,
      y: selection.y,
      w: Math.max(1, Math.round(selection.w * factor)),
      h: Math.max(1, Math.round(selection.h * factor)),
    }
    get().selectionScaleTo(target)
  },

  celScale: (factor) => {
    const refs = activeRefs(get())
    if (!refs || !(factor > 0)) return
    try {
      bus.execute(
        'pixels.applyOp',
        { clipId: refs.clipId, frameId: refs.frameId, layerId: refs.layerId, ops: [{ op: 'scale', factor }] },
        ORIGIN
      )
    } catch {
      /* invalid factor/target — ignore */
    }
  },

  // --- undo/redo ---

  undo: () => {
    if (!bus.canUndo()) return
    try {
      bus.undo()
    } catch {
      /* nothing to undo after stale-walk — ignore */
    }
  },

  redo: () => {
    if (!bus.canRedo()) return
    try {
      bus.redo()
    } catch {
      /* ignore */
    }
  },

  // --- structural commands ---

  addFrame: (copyContent) => {
    const refs = activeRefs(get())
    if (!refs) return
    try {
      bus.execute('frame.add', { clipId: refs.clipId, afterIndex: refs.frameIndex, copy: copyContent }, ORIGIN)
    } catch {
      return
    }
    const insertAt = refs.frameIndex + 1
    set({ activeFrameIndex: insertAt, playing: false })
    toast(
      copyContent
        ? { title: `Frame ${insertAt + 1} duplicated` }
        : {
            title: `Frame ${insertAt + 1} added (empty)`,
            description: `The canvas now shows the new frame — frame ${refs.frameIndex + 1} and its pixels are safe on the timeline below.`,
          }
    )
  },

  deleteFrame: (index) => {
    const refs = activeRefs(get())
    if (!refs) return
    const clip = bus.getProject().clips.find((c) => c.id === refs.clipId)
    if (!clip || clip.frames.length <= 1) return
    try {
      bus.execute('frame.delete', { clipId: refs.clipId, frameIndex: index }, ORIGIN)
    } catch {
      return
    }
    const newLen = clip.frames.length - 1
    set({ activeFrameIndex: Math.min(Math.max(0, index), newLen - 1) })
  },

  moveFrame: (from, to) => {
    const refs = activeRefs(get())
    if (!refs) return
    const clip = bus.getProject().clips.find((c) => c.id === refs.clipId)
    if (!clip) return
    if (to < 0 || to >= clip.frames.length || from === to) return
    try {
      bus.execute('frame.move', { clipId: refs.clipId, from, to }, ORIGIN)
    } catch {
      return
    }
    set({ activeFrameIndex: to })
  },

  dragFrame: (srcClipId, srcIndex, dstClipId, dstIndex) => {
    const project = bus.getProject()
    const srcClip = project.clips.find((c) => c.id === srcClipId)
    const dstClip = project.clips.find((c) => c.id === dstClipId)
    if (!srcClip || !dstClip) return
    const srcFrame = srcClip.frames[srcIndex]
    if (!srcFrame) return
    if (dstIndex < 0 || dstIndex > dstClip.frames.length) return

    // same clip → plain reorder
    if (srcClipId === dstClipId) {
      const to = srcIndex < dstIndex ? dstIndex - 1 : dstIndex
      if (to !== srcIndex) {
        bus.execute('frame.move', { clipId: srcClipId, from: srcIndex, to }, ORIGIN)
        set({ activeClipId: dstClipId, activeFrameIndex: to, playing: false })
      }
      return
    }

    // cross-clip → composite the source frame and paint it onto the
    // destination's active layer as a NEW frame (one undo entry)
    const dstLayerId = dstClip.layers.find((l) => l.id === get().activeLayerId)?.id ?? dstClip.layers[0]?.id
    if (!dstLayerId) return
    const composed = composeFrameRgba(project, srcClip, srcFrame)
    const insertAt = Math.min(dstIndex, dstClip.frames.length)
    try {
      bus.transaction('Copy frame to clip', ORIGIN, () => {
        bus.execute('frame.add', { clipId: dstClipId, afterIndex: insertAt - 1, copy: false }, ORIGIN)
        const clip = bus.getProject().clips.find((c) => c.id === dstClipId)!
        const frame = clip.frames[insertAt]!
        bus.execute(
          'pixels.applyOp',
          { clipId: dstClipId, frameId: frame.id, layerId: dstLayerId, ops: [{ op: 'setBuffer', buffer: new Uint8ClampedArray(composed) }] },
          ORIGIN,
        )
      })
      set({ activeClipId: dstClipId, activeFrameIndex: insertAt, activeLayerId: dstLayerId, playing: false })
    } catch {
      return
    }
  },

  setFrameDuration: (frameIndex, durationMs) => {
    const refs = activeRefs(get())
    if (!refs) return
    const clip = bus.getProject().clips.find((c) => c.id === refs.clipId)
    const frame = clip?.frames[Math.min(Math.max(0, frameIndex), (clip?.frames.length ?? 1) - 1)]
    if (!clip || !frame) return
    const ms = Math.round(durationMs)
    if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) return
    try {
      bus.execute('frame.setDuration', { clipId: refs.clipId, frameId: frame.id, durationMs: ms }, ORIGIN)
    } catch {
      return
    }
  },

  setOnionRange: (patch) => {
    try {
      bus.execute('settings.setOnion', patch, ORIGIN)
    } catch {
      /* invalid patch — ignore */
    }
  },

  setStyleProfile: (profile) => {
    try {
      bus.execute('settings.setStyleProfile', { profile }, ORIGIN)
    } catch {
      /* style profile is validated again by the core command boundary */
    }
  },

  addLayer: () => {
    const refs = activeRefs(get())
    if (!refs) return
    const clip = bus.getProject().clips.find((c) => c.id === refs.clipId)
    if (!clip) return
    const name = `Layer ${clip.layers.length + 1}`
    try {
      bus.execute('layer.add', { clipId: refs.clipId, name }, ORIGIN)
    } catch {
      return
    }
    // layer.add appends to the top — the new top layer IS the new layer.
    const topId = bus.getProject().clips.find((c) => c.id === refs.clipId)?.layers.at(-1)?.id
    if (topId) set({ activeLayerId: topId })
    toast({
      title: `Layer "${name}" added`,
      description: `Added to all ${clip.frames.length} frame${clip.frames.length === 1 ? '' : 's'} in this clip.`,
    })
  },

  deleteLayer: (layerId) => {
    const refs = activeRefs(get())
    if (!refs) return
    const clip = bus.getProject().clips.find((c) => c.id === refs.clipId)
    if (!clip || clip.layers.length <= 1) return
    const idx = clip.layers.findIndex((l) => l.id === layerId)
    if (idx < 0) return
    try {
      bus.execute('layer.delete', { clipId: refs.clipId, layerId }, ORIGIN)
    } catch {
      return
    }
    const next = clip.layers[Math.min(idx, clip.layers.length - 2)]
    set({ activeLayerId: next?.id ?? clip.layers[0]?.id ?? '' })
  },

  duplicateLayer: (layerId) => {
    const refs = activeRefs(get())
    if (!refs) return
    const before = layerIds(bus.getProject(), refs.clipId)
    try {
      bus.execute('layer.duplicate', { clipId: refs.clipId, layerId }, ORIGIN)
    } catch {
      return
    }
    const newId = findNewLayerId(before, bus.getProject(), refs.clipId)
    if (newId) set({ activeLayerId: newId })
  },

  mergeDown: (layerId) => {
    const refs = activeRefs(get())
    if (!refs) return
    const clip = bus.getProject().clips.find((c) => c.id === refs.clipId)
    if (!clip) return
    const idx = clip.layers.findIndex((l) => l.id === layerId)
    if (idx <= 0) return // nothing below
    const bottomId = clip.layers[idx - 1].id
    try {
      bus.execute('layer.mergeDown', { clipId: refs.clipId, layerId }, ORIGIN)
    } catch {
      return
    }
    set({ activeLayerId: bottomId })
  },

  moveLayer: (layerId, dir) => {
    const refs = activeRefs(get())
    if (!refs) return
    try {
      bus.execute('layer.move', { clipId: refs.clipId, layerId, dir }, ORIGIN)
    } catch {
      /* out of range no-ops in the command itself */
    }
  },

  reorderLayer: (layerId, toIndex) => {
    const refs = activeRefs(get())
    if (!refs) return
    try {
      bus.execute('layer.reorder', { clipId: refs.clipId, layerId, to: toIndex }, ORIGIN)
    } catch {
      /* out of range no-ops in the command itself */
    }
  },

  setLayerProp: (layerId, patch) => {
    const refs = activeRefs(get())
    if (!refs) return
    try {
      bus.execute('layer.setProps', { clipId: refs.clipId, layerId, patch }, ORIGIN)
    } catch {
      /* invalid patch — ignore */
    }
  },

  setLayerLinked: (layerId, linked) => {
    const refs = activeRefs(get())
    if (!refs) return
    try {
      bus.execute('layer.setLinked', { clipId: refs.clipId, layerId, linked }, ORIGIN)
    } catch (err) {
      toast({ title: 'Could not change layer link', description: friendlyError(err), variant: 'destructive' })
    }
  },

  polishLayer: (layerId, opts = {}) => {
    const refs = activeRefs(get())
    if (!refs) return false
    if (layerIsLocked(refs.clipId, layerId)) {
      toast({ title: 'Layer is locked', description: 'Unlock it in the Layers panel to polish.', variant: 'destructive' })
      return false
    }
    const project = bus.getProject()
    const loc = locateCel(project, refs.clipId, refs.frameId, layerId)
    if (!loc?.cel) {
      toast({ title: 'Layer is empty', description: 'Draw on this layer before polishing.' })
      return false
    }
    const paletteLock = opts.paletteLock !== false
    const working = new Uint8ClampedArray(loc.cel.buffer)
    const changed = polishLayerPixelArt(working, project.width, project.height, {
      ...opts,
      palette: paletteLock ? project.palette : undefined,
    })
    if (!changed) {
      toast({ title: 'Already polished', description: 'No pixels needed changes with these options.' })
      return false
    }
    try {
      bus.execute(
        'pixels.applyOp',
        { clipId: refs.clipId, frameId: refs.frameId, layerId, ops: [{ op: 'setBuffer', buffer: working }] },
        ORIGIN,
        { label: opts.selOut ? 'Polish layer (sel-out)' : 'Polish layer' },
      )
      return true
    } catch (err) {
      toast({ title: 'Could not polish layer', description: friendlyError(err), variant: 'destructive' })
      return false
    }
  },

  centerContent: (scope = 'layer') => {
    const refs = activeRefs(get())
    if (!refs) return false
    const project = bus.getProject()
    const clip = project.clips.find((c) => c.id === refs.clipId)
    const frame = clip?.frames[refs.frameIndex]
    if (!clip || !frame) return false

    if (scope === 'layer') {
      if (layerIsLocked(refs.clipId, refs.layerId)) {
        toast({ title: 'Layer is locked', description: 'Unlock it in the Layers panel to center.', variant: 'destructive' })
        return false
      }
      const cel = frame.cels[refs.layerId]
      const res = cel ? computeCenterShift(cel.buffer, project.width, project.height) : null
      if (!res) {
        toast({ title: 'Layer is empty', description: 'Draw on this layer before centering.' })
        return false
      }
      if (res.dx === 0 && res.dy === 0) {
        toast({ title: 'Already centered', description: 'Active layer content is already centered on the canvas.' })
        return false
      }
      try {
        bus.execute(
          'pixels.applyOp',
          { clipId: refs.clipId, frameId: refs.frameId, layerId: refs.layerId, ops: [{ op: 'shift', dx: res.dx, dy: res.dy }] },
          ORIGIN,
          { label: 'Center layer' },
        )
        return true
      } catch (err) {
        toast({ title: 'Could not center layer', description: friendlyError(err), variant: 'destructive' })
        return false
      }
    }

    // Whole-frame centering: compute combined opaque bbox across visible unlocked layers
    const targets = clip.layers
      .filter((l) => l.visible && !l.locked && frame.cels[l.id])
      .map((l) => ({ layerId: l.id, buffer: frame.cels[l.id]!.buffer }))
    if (targets.length === 0) {
      toast({ title: 'Frame is empty', description: 'No visible unlocked layers have pixels to center.' })
      return false
    }
    const res = computeCenterShift(targets.map((t) => t.buffer), project.width, project.height)
    if (!res) {
      toast({ title: 'Frame is empty', description: 'No visible unlocked layers have pixels to center.' })
      return false
    }
    if (res.dx === 0 && res.dy === 0) {
      toast({ title: 'Already centered', description: 'Active frame artwork is already centered on the canvas.' })
      return false
    }
    try {
      bus.transaction('Center frame', ORIGIN, () => {
        for (const t of targets) {
          bus.execute(
            'pixels.applyOp',
            { clipId: refs.clipId, frameId: refs.frameId, layerId: t.layerId, ops: [{ op: 'shift', dx: res.dx, dy: res.dy }] },
            ORIGIN,
          )
        }
      })
      return true
    } catch (err) {
      toast({ title: 'Could not center frame', description: friendlyError(err), variant: 'destructive' })
      return false
    }
  },

  autoTrimCanvas: (padding = 1) => {
    const project = bus.getProject()
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
      toast({ title: 'Canvas is empty', description: 'Draw artwork before auto-trimming.' })
      return null
    }
    if (
      trim.width === project.width &&
      trim.height === project.height &&
      trim.dx === 0 &&
      trim.dy === 0
    ) {
      toast({ title: 'Already trimmed', description: `Canvas is already tight at ${project.width}×${project.height}.` })
      return null
    }
    try {
      bus.transaction('Auto-trim canvas', ORIGIN, () => {
        const growW = Math.max(project.width, trim.width)
        const growH = Math.max(project.height, trim.height)
        if (growW > project.width || growH > project.height) {
          bus.execute('canvas.resize', { width: growW, height: growH, anchor: 'top-left' }, ORIGIN)
        }
        if (trim.dx !== 0 || trim.dy !== 0) {
          for (const ref of celRefs) {
            bus.execute(
              'pixels.applyOp',
              {
                clipId: ref.clipId,
                frameId: ref.frameId,
                layerId: ref.layerId,
                ops: [{ op: 'shift', dx: trim.dx, dy: trim.dy }],
              },
              ORIGIN,
            )
          }
        }
        const cur = bus.getProject()
        if (cur.width !== trim.width || cur.height !== trim.height) {
          bus.execute('canvas.resize', { width: trim.width, height: trim.height, anchor: 'top-left' }, ORIGIN)
        }
      })
      set({ selection: null })
      return { width: trim.width, height: trim.height, dx: trim.dx, dy: trim.dy }
    } catch (err) {
      toast({ title: 'Auto-trim failed', description: friendlyError(err), variant: 'destructive' })
      return null
    }
  },

  sortPalette: (by) => {
    const current = bus.getProject().palette
    if (current.length <= 1) return
    const sorted = sortPaletteColors(current, by)
    if (sorted.length === current.length && sorted.every((c, i) => c.toLowerCase() === current[i]?.toLowerCase())) {
      toast({ title: 'Already sorted', description: `Palette is already ordered by ${by}.` })
      return
    }
    try {
      bus.execute(
        'palette.replaceAll',
        { colors: sorted },
        ORIGIN,
        { label: by === 'lightness' ? 'Sort palette (lightness)' : 'Sort palette (hue)' },
      )
    } catch {
      /* ignore */
    }
  },

  replaceColor: (fromHex, toHex, scope = 'layer') => {
    const refs = activeRefs(get())
    if (!refs) return 0
    const from = hexToRgba(fromHex)
    const to = hexToRgba(toHex)
    if (from[0] === to[0] && from[1] === to[1] && from[2] === to[2] && from[3] === to[3]) {
      toast({ title: 'Same color', description: 'Pick different primary and secondary colors to replace.' })
      return 0
    }
    const project = bus.getProject()
    const clip = project.clips.find((c) => c.id === refs.clipId)
    if (!clip) return 0

    const seen = new Set<Uint8ClampedArray>()
    const targets: Array<{ frameId: string; layerId: string; working: Uint8ClampedArray; count: number }> = []
    const frames = scope === 'clip' ? clip.frames : [clip.frames[refs.frameIndex]].filter((f): f is NonNullable<typeof f> => !!f)

    for (const frame of frames) {
      const layers = scope === 'layer'
        ? clip.layers.filter((l) => l.id === refs.layerId && !l.locked)
        : clip.layers.filter((l) => l.visible && !l.locked)
      for (const layer of layers) {
        const cel = frame.cels[layer.id]
        if (!cel || seen.has(cel.buffer)) continue
        seen.add(cel.buffer)
        const working = new Uint8ClampedArray(cel.buffer)
        const count = replaceColorInBuffer(working, from, to)
        if (count > 0) targets.push({ frameId: frame.id, layerId: layer.id, working, count })
      }
    }

    if (targets.length === 0) {
      toast({ title: 'No matching pixels', description: `No pixels of ${fromHex} found in this ${scope}.` })
      return 0
    }
    const total = targets.reduce((sum, t) => sum + t.count, 0)
    try {
      bus.transaction(`Replace color (${scope})`, ORIGIN, () => {
        for (const t of targets) {
          bus.execute(
            'pixels.applyOp',
            { clipId: clip.id, frameId: t.frameId, layerId: t.layerId, ops: [{ op: 'setBuffer', buffer: t.working }] },
            ORIGIN,
          )
        }
      })
      return total
    } catch (err) {
      toast({ title: 'Replace color failed', description: friendlyError(err), variant: 'destructive' })
      return 0
    }
  },

  remapToPalette: (targetPalette, opts = {}) => {
    const refs = activeRefs(get())
    if (!refs || targetPalette.length === 0) return 0
    const scope = opts.scope ?? 'clip'
    const mode = opts.mode ?? 'ramp'
    const updatePalette = opts.updatePalette !== false
    const project = bus.getProject()
    const clip = project.clips.find((c) => c.id === refs.clipId)
    if (!clip) return 0

    const seen = new Set<Uint8ClampedArray>()
    const celList: Array<{ frameId: string; layerId: string; buffer: Uint8ClampedArray }> = []
    const frames = scope === 'clip' ? clip.frames : [clip.frames[refs.frameIndex]].filter((f): f is NonNullable<typeof f> => !!f)

    for (const frame of frames) {
      const layers = scope === 'layer'
        ? clip.layers.filter((l) => l.id === refs.layerId && !l.locked)
        : clip.layers.filter((l) => l.visible && !l.locked)
      for (const layer of layers) {
        const cel = frame.cels[layer.id]
        if (!cel || seen.has(cel.buffer)) continue
        seen.add(cel.buffer)
        celList.push({ frameId: frame.id, layerId: layer.id, buffer: cel.buffer })
      }
    }

    const sourceColors = collectUniqueOpaqueColors(celList.map((c) => c.buffer))
    const updates: Array<{ frameId: string; layerId: string; working: Uint8ClampedArray; count: number }> = []
    for (const c of celList) {
      const working = new Uint8ClampedArray(c.buffer)
      const count = remapBufferToPalette(working, targetPalette, { mode, sourceColors })
      if (count > 0) updates.push({ frameId: c.frameId, layerId: c.layerId, working, count })
    }

    const total = updates.reduce((s, u) => s + u.count, 0)
    if (total === 0 && !updatePalette) {
      toast({ title: 'No pixels changed', description: 'Artwork already matches the target palette.' })
      return 0
    }

    try {
      bus.transaction(opts.label ?? 'Remap palette', ORIGIN, () => {
        if (updatePalette) {
          bus.execute('palette.replaceAll', { colors: targetPalette }, ORIGIN)
        }
        for (const u of updates) {
          bus.execute(
            'pixels.applyOp',
            { clipId: clip.id, frameId: u.frameId, layerId: u.layerId, ops: [{ op: 'setBuffer', buffer: u.working }] },
            ORIGIN,
          )
        }
      })
      return total
    } catch (err) {
      toast({ title: 'Palette remap failed', description: friendlyError(err), variant: 'destructive' })
      return 0
    }
  },

  setClipTags: (tags) => {
    const refs = activeRefs(get())
    if (!refs) return
    try {
      bus.execute('clip.setTags', { clipId: refs.clipId, tags }, ORIGIN)
    } catch (err) {
      toast({ title: 'Could not update tags', description: friendlyError(err), variant: 'destructive' })
    }
  },

  addClip: (name) => {
    const fps = Math.min(60, Math.max(1, useAppSettings.getState().defaultClipFps))
    let clipId: string | null = null
    try {
      bus.execute('clip.add', { name, fps }, ORIGIN)
      clipId = bus.getProject().clips.at(-1)?.id ?? null
    } catch {
      return
    }
    if (clipId) {
      const clip = bus.getProject().clips.find((c) => c.id === clipId)
      set({
        activeClipId: clipId,
        activeFrameIndex: 0,
        activeLayerId: clip?.layers[0]?.id ?? '',
        playing: false,
      })
    }
  },

  deleteClip: (clipId) => {
    const s = get()
    const project = bus.getProject()
    if (project.clips.length <= 1) return
    const idx = project.clips.findIndex((c) => c.id === clipId)
    if (idx < 0) return
    try {
      bus.execute('clip.delete', { clipId }, ORIGIN)
    } catch {
      return
    }
    const next = bus.getProject().clips[Math.min(idx, project.clips.length - 2)]
    set({
      activeClipId: next.id,
      activeFrameIndex: 0,
      activeLayerId: next.layers.at(-1)?.id ?? '',
      playing: false,
    })
  },

  setClipProp: (clipId, patch) => {
    try {
      bus.execute('clip.setProps', { clipId, patch }, ORIGIN)
    } catch {
      /* invalid patch — ignore */
    }
  },

  addPaletteColor: (hex) => {
    if (bus.getProject().palette.includes(hex.toLowerCase())) return
    try {
      bus.execute('palette.addColor', { hex }, ORIGIN)
    } catch {
      /* bad hex — ignore */
    }
  },

  removePaletteColor: (hex) => {
    if (!bus.getProject().palette.includes(hex.toLowerCase())) return
    try {
      bus.execute('palette.removeColor', { hex }, ORIGIN)
    } catch {
      /* ignore */
    }
  },

  setPalette: (colors, label) => {
    try {
      bus.execute('palette.replaceAll', { colors }, ORIGIN, { label })
    } catch {
      /* bad colors — ignore */
    }
  },

  // --- image / frame import (one undoable transaction each) ---

  importCandidateAsLayer: (buffer, name) => {
    const refs = activeRefs(get())
    if (!refs) return null
    let newLayerId: string | null = null
    try {
      bus.transaction('Import image as layer', 'ui', () => {
        bus.execute('layer.add', { clipId: refs.clipId, name }, 'ui')
        newLayerId = bus.getProject().clips.find((c) => c.id === refs.clipId)?.layers.at(-1)?.id ?? null
        if (!newLayerId) throw new CommandError('INVALID_STATE', 'layer add produced no id')
        bus.execute(
          'pixels.applyOp',
          { clipId: refs.clipId, frameId: refs.frameId, layerId: newLayerId, ops: [{ op: 'setBuffer', buffer: new Uint8ClampedArray(buffer) }] },
          'ui'
        )
      })
    } catch {
      toast({ title: 'Import failed', description: 'The image could not be imported.', variant: 'destructive' })
      return null
    }
    if (newLayerId) {
      set({ activeLayerId: newLayerId })
      return { kind: 'layer', clipId: refs.clipId, targetId: newLayerId }
    }
    return null
  },

  importCandidateAsFrame: (buffer, name) => {
    const refs = activeRefs(get())
    if (!refs) return null
    const insertAt = refs.frameIndex + 1
    let ok = false
    let newFrameId: string | null = null
    try {
      bus.transaction('Import image as frame', 'ui', () => {
        bus.execute('frame.add', { clipId: refs.clipId, afterIndex: refs.frameIndex, copy: false }, 'ui')
        const clip = bus.getProject().clips.find((c) => c.id === refs.clipId)
        const newFrame = clip?.frames[insertAt]
        if (!newFrame) throw new CommandError('INVALID_STATE', 'frame add produced no frame')
        newFrameId = newFrame.id
        bus.execute(
          'pixels.applyOp',
          { clipId: refs.clipId, frameId: newFrame.id, layerId: refs.layerId, ops: [{ op: 'setBuffer', buffer: new Uint8ClampedArray(buffer) }] },
          'ui'
        )
        ok = true
      })
    } catch {
      toast({ title: 'Import failed', description: 'The image could not be imported.', variant: 'destructive' })
      return null
    }
    if (ok) set({ activeFrameIndex: insertAt, playing: false })
    if (ok && newFrameId) return { kind: 'frame', clipId: refs.clipId, targetId: newFrameId }
    return null
  },

  // --- motion composer (Task 10) -------------------------------------------
  // Thin wrappers over the two core motion commands (part.set / motion.apply);
  // validation lives in the bus — the panel only toasts on rejection.

  setClipParts: (clipId, parts) => {
    try {
      bus.execute('part.set', { clipId, parts }, ORIGIN)
      return true
    } catch {
      return false
    }
  },

  applyMotionPreset: (payload) => {
    try {
      bus.execute('motion.apply', payload, ORIGIN)
    } catch {
      return null
    }
    if (payload.target.kind === 'existing') return payload.target.clipId
    return bus.getProject().clips.at(-1)?.id ?? null
  },

  // --- Reference import hand-off ---
  referenceDraft: null,
  rightDrawerOpen: false,

  setReferenceDraft: (brief) => set({ referenceDraft: brief }),

  requestRightTab: (tab) => set({ rightTab: tab, rightOpen: true, rightDrawerOpen: true }),

  // --- selection & ui ---

  selectClip: (id) => {
    const clip = bus.getProject().clips.find((c) => c.id === id)
    if (!clip) return
    set({
      activeClipId: id,
      activeFrameIndex: Math.min(get().activeFrameIndex, clip.frames.length - 1),
      activeLayerId: clip.layers.some((l) => l.id === get().activeLayerId)
        ? get().activeLayerId
        : (clip.layers.at(-1)?.id ?? ''),
      playing: false,
      selection: null,
    })
  },

  selectFrame: (index) => {
    const clip = bus.getProject().clips.find((c) => c.id === get().activeClipId) ?? bus.getProject().clips[0]
    if (!clip) return
    // Manual frame pick pauses playback (predictable transport behavior).
    set({
      activeFrameIndex: Math.min(Math.max(0, index), clip.frames.length - 1),
      selection: null,
      ...(get().playing ? { playing: false } : {}),
    })
  },

  setPlayhead: (index) => {
    const clip = bus.getProject().clips.find((c) => c.id === get().activeClipId) ?? bus.getProject().clips[0]
    if (!clip) return
    set({ activeFrameIndex: Math.min(Math.max(0, index), clip.frames.length - 1) })
  },

  selectLayer: (id) => set({ activeLayerId: id, selection: null }),
  setTool: (t) => set({ tool: t }),
  setPrimary: (hex) => set({ primary: hex }),
  setSecondary: (hex) => set({ secondary: hex }),
  swapColors: () => set((s) => ({ primary: s.secondary, secondary: s.primary })),
  setBrushSize: (n) => set({ brushSize: Math.min(8, Math.max(1, Math.round(n))) }),
  setBrushShape: (s) => set({ brushShape: s }),
  setCustomBrush: (b) => set({ customBrush: b }),
  setAgentAutoL1: (v) => set({ agentAutoL1: v }),
  setAgentChat: (m) => set({ agentChat: m }),
  setMirrorX: (v) => set({ mirrorX: v }),
  setMirrorY: (v) => set({ mirrorY: v }),
  setDither: (v) => set({ dither: v }),
  setEllipseFilled: (v) => set({ ellipseFilled: v }),
  setZoom: (z) => set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) }),
  setPan: (x, y) => set({ panX: x, panY: y }),
  setShowGrid: (v) => set({ showGrid: v }),
  setTileSize: (v) => set({ tileSize: v }),
  setTileSnap: (v) => set({ tileSnap: v }),
  setTileStamp: (v) => set({ tileStamp: v }),
  setTiledWrap: (v) => set({ tiledWrap: v }),
  setGrayscale: (v) => set({ grayscale: v }),
  setOnionSkin: (v) => set({ onionSkin: v }),
  setHover: (h) =>
    set((s) => {
      if (s.hover === h) return s
      if (s.hover && h && s.hover.x === h.x && s.hover.y === h.y) return s
      return { hover: h }
    }),
  setPlaying: (v) => set({ playing: v }),
  setRightTab: (t) => set({ rightTab: t }),
  setMotionPreviewIssues: (issues) => set({ motionPreviewIssues: issues }),
  setMotionDraftParts: (parts) => set({ motionDraftParts: parts }),
  setCraftPins: (pins) => set({ craftPins: pins }),
  setPaletteOpen: (v) => set({ paletteOpen: v }),
  setRightOpen: (v) => set({ rightOpen: v }),
  setRightDrawerOpen: (v) => set({ rightDrawerOpen: v }),
  setRightWidth: (w) => set({ rightWidth: Math.min(560, Math.max(260, Math.round(w))) }),
  setTimelineOpen: (v) => set({ timelineOpen: v }),
  setAutosave: (v) => set({ autosave: v }),

  // --- persistence ---

  setProjectId: (id) => set({ projectId: id }),
  setFilePath: (path) => set({ filePath: path }),
  setSavingFile: (v) => set({ savingFile: v }),
  markSaved: () => {
    bus.markSaved()
    set({ dirty: false, savedAt: Date.now() })
  },
  markDirty: () => set({ dirty: true }),
}))

// subscribe the mirror to every bus change (executed commands, undo/redo,
// stroke flow, document replacement)
bus.onChange(() => syncFromBus())

// --- selector helpers (with safe fallbacks) --------------------------------

export function getActiveClip(s: Pick<EditorState, 'project' | 'activeClipId'>): Project['clips'][number] {
  return s.project.clips.find((c) => c.id === s.activeClipId) ?? s.project.clips[0]
}

export function getActiveFrame(
  s: Pick<EditorState, 'project' | 'activeClipId' | 'activeFrameIndex'>
): Project['clips'][number]['frames'][number] {
  const clip = getActiveClip(s)
  return clip.frames[Math.min(s.activeFrameIndex, clip.frames.length - 1)] ?? clip.frames[0]
}

// Dev-only automation hook (browser E2E + desktop smoke harness). Gives test
// scripts read access to the core bus/store for state assertions. Process
// guards keep it out of production builds; it exposes NO new capabilities.
if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
  void import('./project-files').then((files) => {
    void import('./playback-controller').then((pc) => {
      void import('./export').then((exp) => {
        ;(window as unknown as Record<string, unknown>).__pf = {
          getBus,
          useEditor,
          playback: pc.editorPlayback,
          files: {
            saveProjectToPath: files.saveProjectToPath,
            openProjectFromPath: files.openProjectFromPath,
            inspectCurrentFileRecovery: files.inspectCurrentFileRecovery,
          },
          // Task 7 E2E probe: build/inspect export artifacts from the LIVE
          // document (same code path as the dialog) + decode PNGs in-page +
          // atomic desktop writes over the bridge fs (smoke harness).
          exportProbe: {
            build: (request: unknown) => exp.buildExportArtifacts(bus.getProject(), request as never),
            decodePng: (bytes: Uint8Array) => exp.decodeExportPng(bytes),
            write: (dir: string, files: { filename: string; bytes: Uint8Array }[], overwrite: boolean) =>
              writeExportPlan(makeBridgeFs(), dir, files, { overwrite }),
          },
        }
      })
    })
  })
}
