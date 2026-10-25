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
 *  - incorrect overlaps       (intersecting part rects on one layer)
 *  - invalid anchors/rects    (dangling anchorFrameId / out-of-bounds rects)
 */

import type { Clip, Project } from '../types/document';
import { composeFrameRgba } from '../export/export';
import { rectContains, rectsIntersect, type MotionPlan } from './types';

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

export const QA_OPTIONS_DEFAULTS: QaOptions = {
  loopJumpFactor: 2,
  /** Auto mode: outlier detection (mean × 2 + 8). Override for fixed budgets. */
  flickerThreshold: undefined,
};

/** Count pixels whose RGBA bytes differ between two same-size buffers. */
export function diffChangedPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const n = Math.min(a.length, b.length);
  let changed = 0;
  for (let i = 0; i < n; i += 4) {
    if (
      a[i] !== b[i] ||
      a[i + 1] !== b[i + 1] ||
      a[i + 2] !== b[i + 2] ||
      a[i + 3] !== b[i + 3]
    ) {
      changed++;
    }
  }
  return changed;
}

/** Mean of the per-step diffs (excluding the loop-closing step). */
function meanDiff(scores: number[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

/**
 * QA a MOTION PLAN before it is accepted (composer preview panel).
 * Combines structural part checks with per-frame checks over the composed
 * buffers (affected layers stacked per frame for diffing).
 */
export function analyzeMotionPlan(
  project: Project,
  source: Clip,
  plan: MotionPlan,
  opts: Partial<QaOptions> = {}
): QAIssue[] {
  const options = { ...QA_OPTIONS_DEFAULTS, ...opts };
  const issues: QAIssue[] = [];
  const w = project.width;
  const h = project.height;

  // -- invalid parts ---------------------------------------------------------
  for (const part of source.parts) {
    if (!source.frames.some((f) => f.id === part.anchorFrameId)) {
      issues.push({
        level: 'warning',
        code: 'invalid_anchor',
        message: `Part "${part.name}" anchors to a frame that no longer exists — it will follow the first frame.`,
      });
    }
    if (part.rect) {
      const r = part.rect;
      const inBounds =
        r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 &&
        r.x + r.w <= w && r.y + r.h <= h;
      if (!inBounds) {
        issues.push({
          level: 'warning',
          code: 'invalid_rect',
          message: `Part "${part.name}" rect {x:${r.x}, y:${r.y}, w:${r.w}, h:${r.h}} is outside the ${w}×${h} canvas.`,
        });
      }
    }
    if (!source.layers.some((l) => l.id === part.layerId)) {
      issues.push({
        level: 'warning',
        code: 'invalid_layer',
        message: `Part "${part.name}" references a deleted layer.`,
      });
    }
  }

  // -- overlapping regions on the same layer (ownership: highest z wins) -----
  for (let i = 0; i < source.parts.length; i++) {
    for (let j = i + 1; j < source.parts.length; j++) {
      const a = source.parts[i];
      const b = source.parts[j];
      if (a.layerId !== b.layerId || !a.rect || !b.rect) continue;
      if (rectsIntersect(a.rect, b.rect)) {
        const winner = a.z >= b.z ? a : b;
        const loser = a.z >= b.z ? b : a;
        issues.push({
          level: 'warning',
          code: 'overlap',
          message: `Parts "${a.name}" and "${b.name}" overlap on one layer — "${winner.name}" (higher z) owns the shared pixels; "${loser.name}" never moves them.`,
        });
      }
    }
  }

  // -- detached parts (empty regions on the anchor) --------------------------
  const anchor = source.frames[Math.min(plan.report.anchorFrameIndex, source.frames.length - 1)];
  if (anchor) {
    for (const part of source.parts) {
      if (!part.rect) continue;
      const cel = anchor.cels[part.layerId];
      if (!cel) continue;
      let opaque = 0;
      const r = part.rect;
      for (let y = r.y; y < r.y + r.h && y < h; y++) {
        for (let x = r.x; x < r.x + r.w && x < w; x++) {
          if (!rectContains(r, x, y)) continue;
          if (cel.buffer[(y * w + x) * 4 + 3] >= 128) opaque++;
        }
      }
      if (opaque === 0) {
        issues.push({
          level: 'warning',
          code: 'detached_part',
          message: `Part "${part.name}" has no opaque pixels in its region on the anchor frame — check the rectangle or layer.`,
        });
      }
    }
  }

  // -- out-of-bounds (R4 — documented behavior, informational) ---------------
  if (plan.report.clippedPixels > 0) {
    issues.push({
      level: 'info',
      code: 'out_of_bounds',
      message: `${plan.report.clippedPixels} pixels were clipped at the canvas edge across the animation (parts moving outward lose those pixels — R4).`,
    });
  }

  // -- transparency artifacts in composed buffers ----------------------------
  const semiFrames = new Set<number>();
  for (let fi = 0; fi < plan.frames.length; fi++) {
    for (const buf of Object.values(plan.frames[fi].cels)) {
      for (let i = 3; i < buf.length; i += 4) {
        const a = buf[i];
        if (a !== 0 && a !== 255) {
          semiFrames.add(fi);
          break;
        }
      }
    }
  }
  if (semiFrames.size > 0) {
    issues.push({
      level: 'warning',
      code: 'transparency_artifact',
      message: `Frames ${[...semiFrames].map((i) => i + 1).join(', ')} contain semi-transparent pixels (from the static remainder). Run normalize or clean them for engine-safe binary alpha.`,
      frameIndexes: [...semiFrames],
    });
  }

  // -- flicker / loop transitions -------------------------------------------
  issues.push(...flickerIssues(plan.frames.map((f) => stackBuffers(f.cels, w, h)), plan.report.preset, options));
  return issues;
}

/**
 * QA a COMMITTED clip (§4.4 flicker detector over the composited frames —
 * usable on any clip, motion-applied or hand-animated).
 */
export function analyzeClipMotion(
  project: Project,
  clip: Clip,
  opts: Partial<QaOptions> = {}
): QAIssue[] {
  const options = { ...QA_OPTIONS_DEFAULTS, ...opts };
  const issues: QAIssue[] = [];

  // frame consistency FIRST (a broken buffer must not crash composition):
  // frames with wrong-size cels are reported and stack as empty images
  const expected = project.width * project.height * 4;
  const badFrames: number[] = [];
  const stacked: Uint8ClampedArray[] = [];
  for (let i = 0; i < clip.frames.length; i++) {
    const cels = Object.values(clip.frames[i].cels);
    if (cels.some((c) => c.buffer.length !== expected)) {
      badFrames.push(i);
      stacked.push(new Uint8ClampedArray(expected));
    } else {
      stacked.push(composeFrameRgba(project, clip, clip.frames[i]));
    }
  }
  if (badFrames.length > 0) {
    issues.push({
      level: 'warning',
      code: 'frame_consistency',
      message: `Frames ${badFrames.map((i) => i + 1).join(', ')} have cel buffers that do not match the canvas size.`,
      frameIndexes: badFrames,
    });
  }

  issues.push(...flickerIssues(stacked, null, options));
  return issues;
}

/** Stack a frame's buffers into one image for diffing (transparent under). */
function stackBuffers(cels: Record<string, Uint8ClampedArray>, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (const buf of Object.values(cels)) {
    if (buf.length !== out.length) continue;
    for (let i = 0; i < out.length; i += 4) {
      if (buf[i + 3] > 0) {
        out[i] = buf[i];
        out[i + 1] = buf[i + 1];
        out[i + 2] = buf[i + 2];
        out[i + 3] = buf[i + 3];
      }
    }
  }
  return out;
}

/** Shared flicker + loop-transition analysis over stacked frame images. */
function flickerIssues(
  stacked: Uint8ClampedArray[],
  presetId: string | null,
  options: QaOptions
): QAIssue[] {
  const issues: QAIssue[] = [];
  if (stacked.length < 2) return issues;

  const step = stacked.map((buf, i) =>
    i === 0 ? 0 : diffChangedPixels(stacked[i - 1], buf)
  );
  const interFrame = step.slice(1); // diffs 1..n-1
  const mean = meanDiff(interFrame);
  // auto mode = outlier detection (a frame changing ≥ 2× the animation's
  // average + slack is the flicker signature); explicit thresholds win
  const threshold = options.flickerThreshold ?? Math.max(8, Math.round(mean * 2 + 8));

  const outliers = interFrame
    .map((v, i) => ({ v, frame: i + 1 }))
    .filter((e) => e.v > threshold)
    .map((e) => e.frame);
  if (outliers.length > 0) {
    issues.push({
      level: 'warning',
      code: 'flicker',
      message: `Frames ${outliers.map((i) => i + 1).join(', ')} change far more pixels (${outliers
        .map((i) => step[i])
        .join(', ')}) than the animation average (${Math.round(mean)}) — inspect for flicker.`,
      frameIndexes: outliers,
    });
  }

  // loop transition: only meaningful for looping presets/clips
  const playOnce = presetId === 'attack' || presetId === 'jump';
  if (!playOnce) {
    const loopDiff = diffChangedPixels(stacked[stacked.length - 1], stacked[0]);
    if (loopDiff > Math.max(mean * options.loopJumpFactor, threshold)) {
      issues.push({
        level: 'warning',
        code: 'loop_jump',
        message: `The loop seam jumps (${loopDiff} px changed last→first vs ${Math.round(mean)} average) — the cycle will visibly pop when looping.`,
      });
    }
  } else {
    issues.push({
      level: 'info',
      code: 'play_once',
      message: 'This preset is play-once (attack/jump) — the loop-seam check is skipped. Set the clip to loop=false for correct playback.',
    });
  }
  return issues;
}
