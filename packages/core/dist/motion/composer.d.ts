/**
 * Deterministic motion composer (v3.1 §4.1.1 — Task 10).
 *
 * Pure function: (project, sourceClip, preset, params, anchor) → MotionPlan.
 * Zero DOM, zero clock, zero randomness — same source + parameters produce
 * byte-identical composed buffers (golden-tested).
 *
 * Semantics (R1–R10):
 *  R1  paint order  — parts processed bottom→top (stable z sort, array order
 *                     tie-break); per part: cut owned pixels → apply integer
 *                     offset → paste back. Higher-z parts win overlaps.
 *  R2  ownership    — a pixel belongs to exactly ONE part: the highest-z
 *                     part whose region contains it (computed once from the
 *                     anchor frame; lower parts never move pixels they
 *                     don't own).
 *  R3  transparency — alpha ≥ 128 = opaque (moves; alpha promoted to 255 —
 *                     binary rule, matches normalize v2); alpha < 128 =
 *                     transparent (cleared, does not move). Static remainder
 *                     bytes are never re-written, so untouched semi-alpha
 *                     stays bit-identical (R9) and is flagged by QA instead.
 *  R4  bounds/gaps  — integer offsets; targets outside the canvas are
 *                     dropped (no wrap). Vacated pixels: gapFill 'none'
 *                     leaves them transparent; 'edge-extend' (the default
 *                     since the Phase-1 Task 10 QA correction — with 'none'
 *                     bob/lean/squash frames opened visible seam holes and
 *                     detached limbs) repeats the trailing boundary pixels
 *                     until the hole is closed (C26 — fills 1–3 px strips at
 *                     reference amplitudes).
 *  R5  alignment    — every frame derives from ONE anchor frame (default
 *                     frame 1 = index 0); the same absolute regions and
 *                     per-frame offsets are used for every output frame.
 *  R7  timing       — the composer only produces buffers; frames are written
 *                     with durationMs 0 by the apply command (inherit clip
 *                     fps). Loop props are never modified by the composer.
 *  R8  linked cels  — the source data is read as-is; layers that parts
 *                     target are un-linked by the APPLY command (recorded in
 *                     the same undo entry) and listed in the report.
 *  R9  static rest  — pixels outside all part regions are bit-identical to
 *                     the anchor (the composer starts from a clone and only
 *                     rewrites owned pixels).
 *  R10 scaling      — ampScale = clipHeight / 32; offset(v) =
 *                     sign(v)·max(1, |round(v·ampScale)|) per non-zero curve
 *                     value (direction preserved, magnitude floor 1 px — C25).
 *                     The user `amplitude` parameter multiplies curve values
 *                     BEFORE R10 (intensity), squash included.
 */
import type { Clip, Project } from '../types/document';
import { type MotionParams, type MotionPlan, type MotionPresetId } from './types';
/** Normalize a part name to the canonical role key (case/trim insensitive). */
export declare function roleKey(name: string): string;
export interface PlanMotionOptions {
    preset: MotionPresetId;
    params?: Partial<MotionParams>;
    /** Anchor frame INDEX (0-based; R5 default = frame 1 → index 0). */
    anchorFrameIndex?: number;
}
/**
 * Build the full deterministic plan WITHOUT touching any document (preview
 * path + the motion.apply command both call this — one implementation).
 * Throws Error with a plain message for degenerate inputs (no anchor frame).
 */
export declare function planMotion(project: Project, source: Clip, opts: PlanMotionOptions): MotionPlan;
