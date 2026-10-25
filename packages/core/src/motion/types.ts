/**
 * Motion types (v3.1 §4.1 / §4.1.1 — Task 10).
 *
 * Presets are parametric transform curves per part, composed into new cels
 * by the deterministic composer (composer.ts). All curve values below are
 * calibrated on the 32×32 reference sprite (§4.1 table); runtime offsets go
 * through the R10 scaling rule — see `scaledOffset`.
 *
 * Pure TypeScript: no DOM, no React, no Electron.
 */

import type { PartRect } from '../types/document';

export type MotionPresetId = 'idle' | 'walk' | 'run' | 'attack' | 'jump';

/** Vacated-pixel handling (R4 / C26). */
export type GapFillMode = 'none' | 'edge-extend';

/**
 * User-tunable parameters. `amplitude` multiplies every curve value BEFORE
 * the R10 canvas scaling (1 = reference motion); `frameCount` must be one of
 * the preset's allowed counts; `smear` is attack-only (1-px smear frame).
 */
export interface MotionParams {
  amplitude: number;
  frameCount: number;
  gapFill: GapFillMode;
  /** attack only: on the swing frame the arm is additionally pasted 1 px behind (smear trail). */
  smear: boolean;
}

export const MOTION_PARAMS_DEFAULTS: MotionParams = {
  amplitude: 1,
  frameCount: 0, // 0 = preset default (resolved per preset)
  // Phase-1 Task 10 QA correction: 'edge-extend' is the default because with
  // 'none' every bob/lean/squash frame opened 1–3px transparent holes at part
  // seams (hair↔face, arm↔torso, jump squash) and visibly detached limbs —
  // confirmed defects in the visual audit (artifacts/task10-core). 'none'
  // remains selectable for honest-gap workflows.
  gapFill: 'edge-extend',
  smear: false,
};

export const AMPLITUDE_MIN = 0.25 as const;
export const AMPLITUDE_MAX = 3 as const;

/**
 * One part's transform for a single frame. Values are REFERENCE-SCALE
 * (32×32) curve values; the composer applies R10 before moving pixels.
 * `squash` (jump only) = ground-anchored vertical squash in reference px:
 * the part is pasted `squash` px lower with its top rows dropped.
 */
export interface PartOffset {
  dx: number;
  dy: number;
  squash?: number;
}

/**
 * A canonical role → per-frame offset table. Roles map to parts BY NAME
 * (case-insensitive, e.g. a part named "armL"). Roles absent from the clip
 * are silently skipped for that role (C27) and listed in the apply report.
 */
export type PresetCurves = Record<string, PartOffset[]>;

export interface PresetDef {
  id: MotionPresetId;
  label: string;
  /** Allowed frame counts (§4.1: idle 4 · walk 4/6/8 · run 6 · attack 4–6 · jump 6 default, 4–8 supported). */
  frameCounts: readonly number[];
  defaultFrameCount: number;
  /** Play-once suggestion for the UI (the composer itself never changes clip loop props — R7). */
  playOnceSuggested: boolean;
  /** Canonical per-frame curves for EVERY allowed frame count. */
  curvesFor(frameCount: number): PresetCurves;
  description: string;
}

/** Compose-time problem entries surfaced to the user (never silent — C27). */
export type MotionSkippedReason = 'absent' | 'linked' | 'empty-region';

export interface SkippedPart {
  /** Canonical role the preset curve referenced. */
  role: string;
  /** Part name that matched (when a part existed but was unusable). */
  partName?: string;
  reason: MotionSkippedReason;
  detail: string;
}

export interface MotionWarning {
  code: string;
  message: string;
}

/** Per-frame, per-layer composed buffers (affected layers only). */
export interface ComposedFrame {
  /** Composed cel buffer per affected layer id (fresh buffers; W×H×4). */
  cels: Record<string, Uint8ClampedArray>;
}

export interface MotionPlanReport {
  preset: MotionPresetId;
  params: MotionParams;
  /** Resolved frame count. */
  frameCount: number;
  /** ampScale = clipHeight / 32 (R10). */
  ampScale: number;
  anchorFrameId: string;
  anchorFrameIndex: number;
  /** Layers that receive composed cels. */
  affectedLayerIds: string[];
  /** Layers un-linked before composition (R8; empty when none). */
  unlinkedLayerIds: string[];
  /** Curve roles with no usable part (C27) — every skip is reported. */
  skipped: SkippedPart[];
  /** Roles that DID move, with the part names driving them. */
  moved: Array<{ role: string; partName: string; layerId: string }>;
  /** Pixels dropped at canvas edges per preset (R4 clipping) — info only. */
  clippedPixels: number;
  warnings: MotionWarning[];
}

export interface MotionPlan {
  width: number;
  height: number;
  frames: ComposedFrame[];
  report: MotionPlanReport;
}

/** Rect helpers reused by part validation + QA. */
export function rectContains(r: PartRect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

export function rectsIntersect(a: PartRect, b: PartRect): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

/** R10 offset mapping: sign-preserving, magnitude floor 1 px (C25). */
export function scaledOffset(v: number, ampScale: number): number {
  if (v === 0) return 0;
  const scaled = Math.round(Math.abs(v) * ampScale);
  return Math.sign(v) * Math.max(1, scaled);
}
