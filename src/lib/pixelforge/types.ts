/**
 * PixelForge AI — core types for the sprite/motion pipeline.
 *
 * v3.1 rules implemented here (R1–R10):
 *  R1  Part transforms are TRANSLATION-ONLY (dx,dy). No rotation, scale or skew.
 *  R2  Z-order is fixed per part (far limbs behind torso, near limbs in front).
 *  R3  Composition is deterministic: same sprite + rig + offsets => identical pixels.
 *  R4  Static pixels (outside every part rect) are preserved and never move.
 *  R5  Part pixels pushed outside the canvas are dropped and counted (OOB).
 *  R6  Looping presets must close their cycle (last frame -> first frame transition
 *      magnitude comparable to the mean adjacent transition).
 *  R7  Ground presets (idle/walk) must keep planted feet on a constant contact row.
 *  R8  One-shot presets (attack/jump) do not ping-pong; they play and recover.
 *  R9  Per-frame durations are first-class data (ms) and drive playback + export.
 *  R10 Motion QA is non-destructive: it reports warnings, never mutates artwork.
 */

export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

export interface PixelGrid {
  width: number
  height: number
  /** RGBA, length = width * height * 4 */
  data: Uint8ClampedArray
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Offset {
  x: number
  y: number
}

export type PartRole =
  | 'head'
  | 'torso'
  | 'armL' // near arm (viewer side when facing right)
  | 'armR' // far arm
  | 'legL' // near leg
  | 'legR' // far leg
  | 'custom'

export interface SpritePart {
  id: string
  role: PartRole
  label: string
  rect: Rect
  zOrder: number
}

export interface Rig {
  parts: SpritePart[]
}

export type PresetId = 'idle' | 'walk' | 'run' | 'attack' | 'jump'

export type Facing = 'side' | 'front'

export interface PresetParams {
  /** amplitude multiplier, 1 = default px offsets */
  amplitude: number
  /** duration multiplier, 1 = default timing; higher = slower */
  speed: number
  facing: Facing
}

export interface MotionFramePlan {
  offsets: Record<string, Offset>
  duration: number
}

export interface PresetDef {
  id: PresetId
  label: string
  description: string
  loops: boolean
  /** roles required for the preset to make sense */
  requiredRoles: PartRole[]
  optionalRoles: PartRole[]
  buildFrames(rig: Rig, params: PresetParams): MotionFramePlan[]
}

export interface MotionQAIssue {
  severity: 'info' | 'warning'
  code: string
  message: string
  frames: number[]
  /** heuristic-only hint; QA never claims certainty (R10) */
  explanation: string
}

export interface MotionQAMetrics {
  /** lowest opaque pixel row among translated leg rects, per frame */
  footContactRow: (number | null)[]
  footContactVariance: number
  /** pixel-diff count between consecutive frames (includes wrap for loops) */
  transitions: number[]
  loopTransitionDelta: number
  meanTransitionDelta: number
  /** connected components of moving-part pixels, per frame */
  partComponents: number[]
  /** fully-enclosed transparent pixels inside the silhouette, per frame */
  interiorHoles: number[]
  /** part pixels pushed out of canvas, per frame */
  oobPixels: number[]
  maxOffsetPx: number
  /** sum of |second difference| of part offsets (jitter proxy) */
  jitterScore: number
  /** transitions that are ~0 while their neighbours move (stutter proxy) */
  stutterTransitions: number[]
  /** part pixels stamped over static artwork, per frame */
  staticCovered: number[]
}

export interface MotionQAReport {
  presetId: PresetId
  issues: MotionQAIssue[]
  metrics: MotionQAMetrics
}

// ---------------------------------------------------------------------------
// Document model (v2 runtime) — owned by @pixelforge/core
//
// The renderer-facing modules (render.ts, factory.ts, layers-panel,
// timeline) read the core's v2 model: per-clip layer stacks + per-frame
// cels keyed by layer id. Re-exported here so consumers keep importing from
// this module. Shapes are the core's own — do not fork them locally.
// ---------------------------------------------------------------------------

export type {
  Cel,
  Clip,
  Frame,
  Layer,
  Project,
} from '@pixelforge/core'

// ---------------------------------------------------------------------------
// Editor UI types (view state)
// ---------------------------------------------------------------------------

/** Tools exposed by the left tool rail (tool-rail.tsx / use-keyboard.ts). */
export type ToolId =
  | 'pencil'
  | 'eraser'
  | 'fill'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'marquee'
  | 'eyedropper'
  | 'move'

/** Deterministic region transforms (tool-options-bar.tsx → pixels.applyOp). */
export type TransformKind = 'flipH' | 'flipV' | 'rotateCW' | 'rotateCCW'

/** Marquee selection rectangle in canvas pixels (VIEW state, never history). */
export interface SelectionRect {
  x: number
  y: number
  w: number
  h: number
}

/** Session clipboard content extracted from a selection (selection-ops.ts). */
export interface ClipboardContent {
  buffer: Uint8ClampedArray
  w: number
  h: number
  x: number
  y: number
}

// ---------------------------------------------------------------------------
// v1 serialized contract (web-testbed DB rows / server API payloads)
//
// The v1 JSON keeps per-frame layer stacks with PNG data URLs. The v2
// runtime document downgrades to this shape on save (project-io.ts
// exportLegacyProjectJson) and re-imports through the core v1 importer.
// Optional fields (loopMode / parts / durationMs / settings.onion) ride
// along for Task 6/10 metadata; classic v1 readers ignore them.
// ---------------------------------------------------------------------------

export interface SerializedLayer {
  id: string
  name: string
  visible: boolean
  /** 0..1 */
  opacity: number
  /** PNG data URL at the project's full canvas size. */
  png: string
}

export interface SerializedFrame {
  id: string
  /** Per-frame duration override in ms; omitted/0 = inherit clip fps (Task 6). */
  durationMs?: number
  layers: SerializedLayer[]
}

export interface SerializedPart {
  name: string
  layerId: string
  rect?: { x: number; y: number; w: number; h: number }
  anchorFrameId: string
  z: number
}

export interface SerializedClip {
  id: string
  name: string
  fps: number
  loop: boolean
  /** Playback direction; omitted = 'forward' (Task 6). */
  loopMode?: 'forward' | 'reverse' | 'pingpong'
  /** Motion parts ride along when non-empty (Task 10). */
  parts?: SerializedPart[]
  frames: SerializedFrame[]
}

export interface SerializedProject {
  version: 1
  name: string
  width: number
  height: number
  palette: string[]
  clips: SerializedClip[]
  /** Document-level onion-skin range (Task 6); omitted = defaults {1, 0}. */
  settings?: { onion: { prev: number; next: number } }
}

/** Row summary for the Open-project dialog (/api/projects GET). */
export interface ProjectSummary {
  id: string
  name: string
  width: number
  height: number
  updatedAt: string
}
