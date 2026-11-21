/**
 * Motion & animation QA (v3.1 §4.4 + Task 10 spec §7 — flicker detector,
 * consistency checks). Pure analysis: reports actionable issues, NEVER
 * alters artwork.
 *
 * Checks:
 *  - frame consistency        (cel presence / buffer sizes)
 *  - flicker                  (per-frame changed-px jitter score vs threshold)
 *  - loop transition          (last→first jump vs mean inter-frame diff)
 *  - broken/detached parts    (part regions with no opaque pixels)
 *  - transparency artifacts   (non-binary alpha after composition)
 *  - out-of-bounds pixels     (R4 edge clipping — informational)
 *  - incorrect overlaps       (intersecting part rects on one layer —
 *                               informational: R2 z-order resolves ownership
 *                               by design, adjacent rig parts always touch)
 *  - invalid anchors/rects    (dangling anchorFrameId / out-of-bounds rects)
 *  - foot contact (walk/run)  (Phase-1 Task 10 QA): planted-foot horizontal
 *                               slide (R1 translation-only consequence) and
 *                               both-feet-lift frames (curve-table gait),
 *                               computed analytically from the preset curves
 *                               — deterministic, no pixel scanning needed
 */
import type { Clip, Project } from '../types/document';
import { type MotionPlan } from './types';
export type QALevel = 'info' | 'warning';
export interface QAIssue {
    level: QALevel;
    /** Stable machine code, e.g. 'flicker', 'loop_jump', 'overlap'. */
    code: string;
    message: string;
    /** Frame indexes the issue relates to (when frame-scoped). */
    frameIndexes?: number[];
}
export interface QaOptions {
    /**
     * Max changed pixels per frame before a flicker warning fires.
     * Default: derived from the animation itself (mean × 3 + 12) so small
     * sprites are not drowned out by an absolute constant.
     */
    flickerThreshold?: number;
    /** Last→first diff over mean inter-frame diff before a loop-jump warning. */
    loopJumpFactor: number;
}
export declare const QA_OPTIONS_DEFAULTS: QaOptions;
/** Count pixels whose RGBA bytes differ between two same-size buffers. */
export declare function diffChangedPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number;
/**
 * QA a MOTION PLAN before it is accepted (composer preview panel).
 * Combines structural part checks with per-frame checks over the composed
 * buffers (affected layers stacked per frame for diffing).
 */
export declare function analyzeMotionPlan(project: Project, source: Clip, plan: MotionPlan, opts?: Partial<QaOptions>): QAIssue[];
/**
 * Foot-contact analysis for walk/run plans (Phase-1 Task 10 QA).
 *
 * Deterministic and analytic: re-derives each leg's per-frame integer offset
 * from the preset curves through the exact R10 mapping the composer uses, so
 * no pixel scanning is required and results are golden-stable.
 *
 * Reports:
 *  - foot_slide    (info): a planted leg (dy 0 after scaling) still shifts
 *                  horizontally — inherent to R1 translation-only parts;
 *                  refine contact frames manually for ground-perfect footing.
 *  - both_feet_lift (info on run — flight phase is normal; warning on walk —
 *                  the 6/8-frame tables lift both legs mid-stride, which reads
 *                  as a subtle hop users may want to refine by hand).
 */
export declare function footContactIssues(source: Clip, plan: MotionPlan): QAIssue[];
/**
 * QA a COMMITTED clip (§4.4 flicker detector over the composited frames —
 * usable on any clip, motion-applied or hand-animated).
 */
export declare function analyzeClipMotion(project: Project, clip: Clip, opts?: Partial<QaOptions>): QAIssue[];
