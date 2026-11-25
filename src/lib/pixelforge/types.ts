/**
 * PixelForge AI — editor types and document model re-exports.
 */

import type { StyleProfile } from '@pixelforge/core'

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
  | 'shade'
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
  /** v1.1 extension — classic v1 readers ignore it. */
  locked?: boolean
  /** v1.1 extension — compositing mode; omitted = normal. */
  blend?: 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
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
  settings?: {
    onion: { prev: number; next: number }
    /** Shared AI style contract; harmlessly ignored by classic v1 readers. */
    styleProfile?: StyleProfile
  }
}

/** Row summary for the Open-project dialog (/api/projects GET). */
export interface ProjectSummary {
  id: string
  name: string
  width: number
  height: number
  updatedAt: string
}
