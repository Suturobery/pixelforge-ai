"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AMPLITUDE_MAX = exports.AMPLITUDE_MIN = exports.MOTION_PARAMS_DEFAULTS = void 0;
exports.rectContains = rectContains;
exports.rectsIntersect = rectsIntersect;
exports.scaledOffset = scaledOffset;
exports.MOTION_PARAMS_DEFAULTS = {
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
exports.AMPLITUDE_MIN = 0.25;
exports.AMPLITUDE_MAX = 3;
/** Rect helpers reused by part validation + QA. */
function rectContains(r, x, y) {
    return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}
function rectsIntersect(a, b) {
    return (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
}
/** R10 offset mapping: sign-preserving, magnitude floor 1 px (C25). */
function scaledOffset(v, ampScale) {
    if (v === 0)
        return 0;
    const scaled = Math.round(Math.abs(v) * ampScale);
    return Math.sign(v) * Math.max(1, scaled);
}
