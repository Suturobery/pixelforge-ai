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
