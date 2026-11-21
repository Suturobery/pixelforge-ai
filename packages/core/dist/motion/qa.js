"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.QA_OPTIONS_DEFAULTS = void 0;
exports.diffChangedPixels = diffChangedPixels;
exports.analyzeMotionPlan = analyzeMotionPlan;
exports.footContactIssues = footContactIssues;
exports.analyzeClipMotion = analyzeClipMotion;
const export_1 = require("../export/export");
const presets_1 = require("./presets");
const types_1 = require("./types");
exports.QA_OPTIONS_DEFAULTS = {
    loopJumpFactor: 2,
    /** Auto mode: outlier detection (mean × 2 + 8). Override for fixed budgets. */
    flickerThreshold: undefined,
};
/** Count pixels whose RGBA bytes differ between two same-size buffers. */
function diffChangedPixels(a, b) {
    const n = Math.min(a.length, b.length);
    let changed = 0;
    for (let i = 0; i < n; i += 4) {
        if (a[i] !== b[i] ||
            a[i + 1] !== b[i + 1] ||
            a[i + 2] !== b[i + 2] ||
            a[i + 3] !== b[i + 3]) {
            changed++;
        }
    }
    return changed;
}
/** Mean of the per-step diffs (excluding the loop-closing step). */
function meanDiff(scores) {
    if (scores.length === 0)
        return 0;
    return scores.reduce((s, v) => s + v, 0) / scores.length;
}
/**
 * QA a MOTION PLAN before it is accepted (composer preview panel).
 * Combines structural part checks with per-frame checks over the composed
 * buffers (affected layers stacked per frame for diffing).
 */
function analyzeMotionPlan(project, source, plan, opts = {}) {
    const options = { ...exports.QA_OPTIONS_DEFAULTS, ...opts };
    const issues = [];
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
            const inBounds = r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 &&
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
            if (a.layerId !== b.layerId || !a.rect || !b.rect)
                continue;
            if ((0, types_1.rectsIntersect)(a.rect, b.rect)) {
                const winner = a.z >= b.z ? a : b;
                const loser = a.z >= b.z ? b : a;
                // Phase-1 Task 10 QA: informational, not a warning — adjacent rig
                // parts (hair over head, arm beside torso) always intersect by
                // design and R2 z-order resolves ownership deterministically.
                issues.push({
                    level: 'info',
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
            if (!part.rect)
                continue;
            const cel = anchor.cels[part.layerId];
            if (!cel)
                continue;
            let opaque = 0;
            const r = part.rect;
            for (let y = r.y; y < r.y + r.h && y < h; y++) {
                for (let x = r.x; x < r.x + r.w && x < w; x++) {
                    if (!(0, types_1.rectContains)(r, x, y))
                        continue;
                    if (cel.buffer[(y * w + x) * 4 + 3] >= 128)
                        opaque++;
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
    const semiFrames = new Set();
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
    // -- foot contact (walk/run gait characteristics — Phase-1 Task 10 QA) -----
    issues.push(...footContactIssues(source, plan));
    return issues;
}
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
function footContactIssues(source, plan) {
    const issues = [];
    const presetId = plan.report.preset;
    if (presetId !== 'walk' && presetId !== 'run')
        return issues;
    const preset = (0, presets_1.getPreset)(presetId);
    if (!preset)
        return issues;
    const curves = preset.curvesFor(plan.report.params.frameCount);
    const amp = plan.report.params.amplitude;
    const ampScale = plan.report.ampScale;
    const legCurves = ['legL', 'legR'].map((role) => {
        const curve = curves[role];
        if (!curve || curve.length === 0)
            return null;
        // roleKey semantics (composer C27): case/trim-insensitive match on BOTH sides
        const tagged = source.parts.some((p) => p.name.trim().toLowerCase() === role.trim().toLowerCase());
        return tagged ? curve : null;
    });
    if (!legCurves[0] && !legCurves[1])
        return issues;
    const frames = plan.report.frameCount;
    const slideFrames = new Set();
    const liftFrames = [];
    let maxSlide = 0;
    for (let i = 0; i < frames; i++) {
        const dy = legCurves.map((c) => (c ? (0, types_1.scaledOffset)(c[i % c.length].dy * amp, ampScale) : null));
        const dx = legCurves.map((c) => (c ? (0, types_1.scaledOffset)(c[i % c.length].dx * amp, ampScale) : null));
        if (dy[0] !== null && dy[1] !== null &&
            dy[0] < 0 && dy[1] < 0) {
            liftFrames.push(i);
        }
        for (let l = 0; l < 2; l++) {
            if (dy[l] === 0 && dx[l] !== null && Math.abs(dx[l]) > 0) {
                slideFrames.add(i);
                if (Math.abs(dx[l]) > maxSlide)
                    maxSlide = Math.abs(dx[l]);
            }
        }
    }
    if (maxSlide > 0) {
        issues.push({
            level: 'info',
            code: 'foot_slide',
            message: `Planted feet shift up to ${maxSlide}px horizontally on contact frames (${[...slideFrames].map((i) => i + 1).join(', ')}) — translation-only parts cannot pivot (R1). Refine those frames manually if ground-perfect footing matters.`,
            frameIndexes: [...slideFrames],
        });
    }
    if (liftFrames.length > 0) {
        if (presetId === 'run') {
            issues.push({
                level: 'info',
                code: 'both_feet_lift',
                message: `Both feet leave the ground on frames ${liftFrames.map((i) => i + 1).join(', ')} — the flight phase is normal for a run cycle.`,
                frameIndexes: [...liftFrames],
            });
        }
        else {
            issues.push({
                level: 'warning',
                code: 'both_feet_lift',
                message: `Both feet lift off the ground on frames ${liftFrames.map((i) => i + 1).join(', ')} — the preset curve table raises both legs mid-stride, which reads as a subtle hop. Refine those frames manually for a grounded gait.`,
                frameIndexes: [...liftFrames],
            });
        }
    }
    return issues;
}
/**
 * QA a COMMITTED clip (§4.4 flicker detector over the composited frames —
 * usable on any clip, motion-applied or hand-animated).
 */
function analyzeClipMotion(project, clip, opts = {}) {
    const options = { ...exports.QA_OPTIONS_DEFAULTS, ...opts };
    const issues = [];
    // frame consistency FIRST (a broken buffer must not crash composition):
    // frames with wrong-size cels are reported and stack as empty images
    const expected = project.width * project.height * 4;
    const badFrames = [];
    const stacked = [];
    for (let i = 0; i < clip.frames.length; i++) {
        const cels = Object.values(clip.frames[i].cels);
        if (cels.some((c) => c.buffer.length !== expected)) {
            badFrames.push(i);
            stacked.push(new Uint8ClampedArray(expected));
        }
        else {
            stacked.push((0, export_1.composeFrameRgba)(project, clip, clip.frames[i]));
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
function stackBuffers(cels, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (const buf of Object.values(cels)) {
        if (buf.length !== out.length)
            continue;
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
function flickerIssues(stacked, presetId, options) {
    const issues = [];
    if (stacked.length < 2)
        return issues;
    const step = stacked.map((buf, i) => i === 0 ? 0 : diffChangedPixels(stacked[i - 1], buf));
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
    }
    else {
        issues.push({
            level: 'info',
            code: 'play_once',
            message: 'This preset is play-once (attack/jump) — the loop-seam check is skipped. Set the clip to loop=false for correct playback.',
        });
    }
    return issues;
}
