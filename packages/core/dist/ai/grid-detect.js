"use strict";
/**
 * @pixelforge/core — Pixel-art grid detection, block snapping, and whole-number
 * scaling (AI slop fix #1).
 *
 * AI image generators do not output true 16×16 or 32×32 pixel art — they render
 * high-res images (512–2048px) where each logical "pixel" is a noisy block of
 * ~S×S screen pixels (often non-integer, e.g. 12.5px, with 1–2px anti-aliased
 * seams and diffusion noise). Laying an arbitrary target grid over those blocks
 * misaligns the boundaries and produces doubled lines, broken outlines, and
 * mixed pixel sizes ("mixels").
 *
 * This module recovers the underlying block lattice deterministically:
 *   1. computeEdgeProfiles  — 1D vertical/horizontal edge-energy profiles over
 *      opaque/silhouette transitions (with a soft noise floor for diffusion
 *      speckle).
 *   2. detectPixelGrid      — autocorrelation candidate generation + comb-
 *      template Pearson correlation r(T, E) with sub-pixel period/phase
 *      refinement. Pearson correlation symmetrically penalizes both coarse
 *      harmonics (2P) and fine sub-harmonics (P/2), while scoring ~0 on smooth
 *      non-grid images and native 1:1 pixel art.
 *   3. snapToDetectedGrid   — samples the denoised interior core of each
 *      detected block (ignoring AA seams, using neighborhood-clustered 5-bit
 *      mode + per-channel median) to recover the true logical sprite.
 *   4. scaleSpriteWholeNumber — places the snapped sprite onto the target
 *      canvas using whole-number scaling ONLY (1× native, k× integer upscale,
 *      or div× exact integer block downscale when oversized), flagging
 *      `oversized` when the true sprite has more detail than the canvas fits.
 *
 * Pure TypeScript, zero DOM, 100% deterministic.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeEdgeProfiles = computeEdgeProfiles;
exports.detectPixelGrid = detectPixelGrid;
exports.snapToDetectedGrid = snapToDetectedGrid;
exports.scaleSpriteWholeNumber = scaleSpriteWholeNumber;
const oklab_1 = require("./oklab");
// ------------------------------------------------------------ edge profiles
const EDGE_NOISE_FLOOR = 6;
const EDGE_CAP = 96;
const EDGE_SILHOUETTE = 96;
function makeAxisProfile(energy, len) {
    const m = Math.max(0, len - 1);
    if (m === 0)
        return { energy, len, m: 0, mean: 0, varSum: 0 };
    let sum = 0;
    for (let i = 1; i < len; i++)
        sum += energy[i];
    const mean = sum / m;
    let varSum = 0;
    for (let i = 1; i < len; i++) {
        const d = energy[i] - mean;
        varSum += d * d;
    }
    return { energy, len, m, mean, varSum };
}
/**
 * Compute 1D vertical (ex) and horizontal (ey) edge-energy profiles for an
 * RGBA buffer. ex[x] (1 <= x < w) is the summed edge strength between columns
 * x-1 and x; ey[y] (1 <= y < h) is the summed edge strength between rows y-1
 * and y. Transparent-transparent pairs contribute 0; opaque-transparent pairs
 * contribute a capped silhouette edge; opaque-opaque pairs apply a soft noise
 * floor so diffusion grain inside flat blocks does not obscure block seams.
 */
function computeEdgeProfiles(buf, w, h) {
    const ex = new Float64Array(w);
    const ey = new Float64Array(h);
    for (let y = 0; y < h; y++) {
        const rowBase = y * w;
        for (let x = 1; x < w; x++) {
            const i1 = (rowBase + x - 1) * 4;
            const i2 = (rowBase + x) * 4;
            const a1 = buf[i1 + 3] >= 128;
            const a2 = buf[i2 + 3] >= 128;
            if (!a1 && !a2)
                continue;
            if (a1 !== a2) {
                ex[x] += EDGE_SILHOUETTE;
            }
            else {
                const diff = (Math.abs(buf[i1] - buf[i2]) +
                    Math.abs(buf[i1 + 1] - buf[i2 + 1]) +
                    Math.abs(buf[i1 + 2] - buf[i2 + 2])) /
                    3;
                if (diff > EDGE_NOISE_FLOOR) {
                    ex[x] += Math.min(EDGE_CAP, diff - EDGE_NOISE_FLOOR);
                }
            }
        }
    }
    for (let y = 1; y < h; y++) {
        const rowPrev = (y - 1) * w;
        const rowCurr = y * w;
        let sumY = 0;
        for (let x = 0; x < w; x++) {
            const i1 = (rowPrev + x) * 4;
            const i2 = (rowCurr + x) * 4;
            const a1 = buf[i1 + 3] >= 128;
            const a2 = buf[i2 + 3] >= 128;
            if (!a1 && !a2)
                continue;
            if (a1 !== a2) {
                sumY += EDGE_SILHOUETTE;
            }
            else {
                const diff = (Math.abs(buf[i1] - buf[i2]) +
                    Math.abs(buf[i1 + 1] - buf[i2 + 1]) +
                    Math.abs(buf[i1 + 2] - buf[i2 + 2])) /
                    3;
                if (diff > EDGE_NOISE_FLOOR) {
                    sumY += Math.min(EDGE_CAP, diff - EDGE_NOISE_FLOOR);
                }
            }
        }
        ey[y] = sumY;
    }
    return { ex, ey };
}
// --------------------------------------------------- comb-template scoring
/**
 * Exact Pearson correlation r(T_{p,phi}, E) between a triangular comb template
 * T(x) = max(0, 1 - dist(x, phi + k*p)) and the axis edge profile E[1..len-1].
 * Because p >= 2, adjacent grid-line supports never overlap on integer x, so
 * evaluation runs in O(len / p) time.
 */
function combCorrelation(profile, p, phi) {
    const { energy, len, m, mean, varSum } = profile;
    if (m < 3 || varSum <= 1e-9 || p < 2)
        return 0;
    let sumT = 0;
    let sumTT = 0;
    let sumTE = 0;
    // Normalize phi into [0, p)
    let pos = ((phi % p) + p) % p;
    // First grid line whose support (pos - 1, pos + 1) can touch x >= 1
    if (pos === 0)
        pos = p;
    while (pos < len) {
        const x0 = Math.floor(pos);
        const frac = pos - x0;
        const t0 = 1 - frac;
        const t1 = frac;
        if (x0 >= 1 && x0 < len && t0 > 0) {
            sumT += t0;
            sumTT += t0 * t0;
            sumTE += t0 * energy[x0];
        }
        const x1 = x0 + 1;
        if (x1 >= 1 && x1 < len && t1 > 0) {
            sumT += t1;
            sumTT += t1 * t1;
            sumTE += t1 * energy[x1];
        }
        pos += p;
    }
    const varT = sumTT - (sumT * sumT) / m;
    if (varT <= 1e-12)
        return 0;
    const cov = sumTE - mean * sumT;
    if (cov <= 0)
        return 0;
    const r = cov / Math.sqrt(varT * varSum);
    return Math.max(0, Math.min(1, r));
}
/**
 * Find the optimal phase offset phi in [0, p) for a given period p on one
 * axis using O(len) phase-folding followed by local refinement.
 */
function bestPhaseForPeriod(profile, p) {
    const { energy, len, m, varSum } = profile;
    if (m < 3 || varSum <= 1e-9 || p < 2)
        return { score: 0, offset: 0 };
    const bins = Math.min(64, Math.max(8, Math.round(p * 2)));
    const foldSum = new Float64Array(bins);
    const foldCnt = new Uint32Array(bins);
    for (let x = 1; x < len; x++) {
        const rem = x % p;
        const b = Math.min(bins - 1, Math.floor((rem / p) * bins));
        foldSum[b] += energy[x];
        foldCnt[b] += 1;
    }
    const foldMean = new Float64Array(bins);
    for (let b = 0; b < bins; b++) {
        foldMean[b] = foldCnt[b] > 0 ? foldSum[b] / foldCnt[b] : 0;
    }
    // Pick top 2 circular bins (smoothed slightly for larger periods) + exact 0
    let bestBin1 = 0;
    let bestVal1 = -1;
    let bestBin2 = 0;
    let bestVal2 = -1;
    const smooth = p >= 6;
    for (let b = 0; b < bins; b++) {
        const val = smooth
            ? 0.25 * foldMean[(b + bins - 1) % bins] + 0.5 * foldMean[b] + 0.25 * foldMean[(b + 1) % bins]
            : foldMean[b];
        if (val > bestVal1) {
            bestVal2 = bestVal1;
            bestBin2 = bestBin1;
            bestVal1 = val;
            bestBin1 = b;
        }
        else if (val > bestVal2) {
            bestVal2 = val;
            bestBin2 = b;
        }
    }
    const seeds = [
        0,
        ((bestBin1 + 0.5) / bins) * p,
        (bestBin1 / bins) * p,
        ((bestBin2 + 0.5) / bins) * p,
    ];
    // For very small integer periods (p <= 4), test every 0.5px phase directly
    if (p <= 4.5) {
        for (let ph = 0; ph < p; ph += 0.5)
            seeds.push(ph);
    }
    let bestScore = -1;
    let bestPhi = 0;
    for (const seed of seeds) {
        const ph = ((seed % p) + p) % p;
        const sc = combCorrelation(profile, p, ph);
        if (sc > bestScore) {
            bestScore = sc;
            bestPhi = ph;
        }
    }
    // Local refinement around bestPhi: ±0.5, ±0.2, ±0.05 px
    const steps = [0.5, 0.2, 0.05];
    for (const step of steps) {
        const center = bestPhi;
        for (let k = -2; k <= 2; k++) {
            if (k === 0)
                continue;
            const ph = (((center + k * step) % p) + p) % p;
            const sc = combCorrelation(profile, p, ph);
            if (sc > bestScore) {
                bestScore = sc;
                bestPhi = ph;
            }
        }
    }
    return { score: Math.max(0, bestScore), offset: bestPhi };
}
/**
 * Normalized autocorrelation at integer lags [2..maxLag] to discover candidate
 * block periods without cumulative drift even when the true pitch is fractional.
 */
function topAutocorrelationLags(profile, maxLag, topK) {
    const { energy, len, m, mean, varSum } = profile;
    if (m < 6 || varSum <= 1e-9)
        return [];
    const limit = Math.min(maxLag, Math.floor(m / 2));
    if (limit < 2)
        return [];
    const invVar = m / varSum;
    const ac = new Float64Array(limit + 1);
    for (let lag = 2; lag <= limit; lag++) {
        const n = m - lag;
        if (n < 3)
            break;
        let sum = 0;
        for (let x = 1; x <= n; x++) {
            sum += (energy[x] - mean) * (energy[x + lag] - mean);
        }
        ac[lag] = (sum / n) * invVar;
    }
    const peaks = [];
    for (let lag = 2; lag <= limit; lag++) {
        const v = ac[lag];
        if (v <= 0.02)
            continue;
        const prev = lag > 2 ? ac[lag - 1] : -Infinity;
        const next = lag < limit ? ac[lag + 1] : -Infinity;
        if (v >= prev && v >= next) {
            peaks.push({ lag, val: v });
        }
    }
    peaks.sort((a, b) => b.val - a.val || a.lag - b.lag);
    return peaks.slice(0, topK).map((p) => p.lag);
}
// ------------------------------------------------------------ grid detection
const MIN_CONFIDENCE_JOINT = 0.38;
const MIN_CONFIDENCE_SINGLE_AXIS = 0.42;
const MIN_CONFIDENCE_SECONDARY_AXIS = 0.20;
const MIN_EDGE_CAPTURE = 0.55;
const MIN_SEAM_CONTRAST = 3.0;
const MIN_ACTIVE_LINE_RATIO = 0.35;
/**
 * Measure physical grid invariants on one axis:
 *   • edgeCapture: fraction of total edge energy located on the grid seams
 *     (proves block interiors are actually flat, rejecting 1:1 native art)
 *   • contrast: mean seam energy / mean interior energy
 *   • activeLines / totalLines: fraction of grid lines that carry real edges
 *     (rejects sparse 2-edge shapes like smooth circles or single boxes)
 */
function measureAxisGrid(profile, step, offset) {
    const { energy, len, m, mean } = profile;
    if (m < 3 || step < 2) {
        return { edgeCapture: 0, contrast: 0, activeLines: 0, totalLines: 0 };
    }
    const radius = step >= 5 ? 1 : 0;
    const onGrid = new Uint8Array(len);
    let totalLines = 0;
    let activeLines = 0;
    const activeThresh = Math.max(1e-6, mean * 0.5);
    let pos = ((offset % step) + step) % step;
    if (pos < 0.5)
        pos += step;
    while (pos <= len - 0.5) {
        const center = Math.round(pos);
        if (center >= 1 && center < len) {
            totalLines += 1;
            let linePeak = 0;
            const lo = Math.max(1, center - radius);
            const hi = Math.min(len - 1, center + radius);
            for (let x = lo; x <= hi; x++) {
                onGrid[x] = 1;
                if (energy[x] > linePeak)
                    linePeak = energy[x];
            }
            if (linePeak >= activeThresh)
                activeLines += 1;
        }
        pos += step;
    }
    let totalE = 0;
    let onE = 0;
    let onCount = 0;
    for (let x = 1; x < len; x++) {
        const e = energy[x];
        totalE += e;
        if (onGrid[x]) {
            onE += e;
            onCount += 1;
        }
    }
    const offCount = m - onCount;
    const offE = totalE - onE;
    const edgeCapture = totalE > 1e-9 ? onE / totalE : 0;
    const meanOn = onCount > 0 ? onE / onCount : 0;
    const meanOff = offCount > 0 ? offE / offCount : 0;
    const contrast = meanOff <= 1e-9 ? (meanOn > 0 ? Infinity : 0) : meanOn / meanOff;
    return { edgeCapture, contrast, activeLines, totalLines };
}
function evaluateSquarePeriod(px, py, p) {
    const canX = px.varSum > 1e-9 && px.len / p >= 2.5;
    const canY = py.varSum > 1e-9 && py.len / p >= 2.5;
    if (!canX && !canY) {
        return { period: p, score: 0, scoreX: 0, scoreY: 0, offsetX: 0, offsetY: 0 };
    }
    const rx = canX ? bestPhaseForPeriod(px, p) : { score: 0, offset: 0 };
    const ry = canY ? bestPhaseForPeriod(py, p) : { score: 0, offset: 0 };
    // Weight each active axis by cycle count (saturating at 8 cells) so narrow
    // 3-cell sprites (like swords/keys) are guided by their long axis.
    const wx = canX ? Math.min(1, px.len / p / 8) : 0;
    const wy = canY ? Math.min(1, py.len / p / 8) : 0;
    const score = wx + wy > 0 ? (wx * rx.score + wy * ry.score) / (wx + wy) : 0;
    return {
        period: p,
        score,
        scoreX: rx.score,
        scoreY: ry.score,
        offsetX: rx.offset,
        offsetY: ry.offset,
    };
}
/**
 * Compute grid line positions covering [0, len] given (step, offset).
 * Partial leading/trailing slivers narrower than 45% of `step` are treated as
 * anti-aliasing halo and excluded; wider partial edge cells are kept so
 * content pixels are never dropped.
 */
function buildAxisBoundaries(len, step, offset, energy) {
    const off = ((offset % step) + step) % step;
    const lines = [];
    if (off >= step * 0.45) {
        lines.push(0);
    }
    for (let pos = off; pos <= len; pos += step) {
        if (lines.length === 0 || pos - lines[lines.length - 1] >= 1) {
            lines.push(pos);
        }
    }
    const last = lines.length > 0 ? lines[lines.length - 1] : 0;
    if (len - last >= step * 0.45) {
        lines.push(len);
    }
    else if (lines.length < 2) {
        lines.length = 0;
        lines.push(0, len);
    }
    // Convert to monotonic integer boundaries, with optional tiny local snap
    // (±15% of step, max ±2px) onto stronger nearby block seams for AI drift.
    const intBounds = lines.map((v) => Math.max(0, Math.min(len, Math.round(v))));
    if (energy && step >= 5) {
        const maxSnap = Math.min(2, Math.floor(step * 0.15));
        if (maxSnap >= 1) {
            for (let i = 1; i < intBounds.length - 1; i++) {
                const base = intBounds[i];
                const minAllowed = intBounds[i - 1] + Math.max(2, Math.floor(step * 0.5));
                const maxAllowed = intBounds[i + 1] - Math.max(2, Math.floor(step * 0.5));
                if (minAllowed > maxAllowed)
                    continue;
                let bestX = base;
                let bestE = energy[base] ?? 0;
                const lo = Math.max(minAllowed, base - maxSnap);
                const hi = Math.min(maxAllowed, base + maxSnap);
                for (let x = lo; x <= hi; x++) {
                    const e = energy[x] ?? 0;
                    if (e > bestE * 1.25 && e > (energy[base] ?? 0) * 1.25) {
                        bestE = e;
                        bestX = x;
                    }
                }
                intBounds[i] = bestX;
            }
        }
    }
    // Guarantee strict monotonicity
    const out = [intBounds[0]];
    for (let i = 1; i < intBounds.length; i++) {
        if (intBounds[i] > out[out.length - 1]) {
            out.push(intBounds[i]);
        }
    }
    if (out.length < 2)
        return [0, len];
    return out;
}
/**
 * Detect whether `buf` (w×h, typically a trimmed sprite) lies on an upscaled
 * fake-pixel grid, returning the recovered pitch `(stepX, stepY)`, phase
 * `(offsetX, offsetY)`, logical dimensions `(gridW, gridH)`, and confidence.
 *
 * Returns `detected: false` for native 1:1 pixel art, smooth non-pixel-art
 * images, and tiny buffers where a grid cannot be observed reliably.
 */
function detectPixelGrid(buf, w, h) {
    const noGrid = (confidence = 0, confidenceX = 0, confidenceY = 0) => ({
        detected: false,
        stepX: 1,
        stepY: 1,
        offsetX: 0,
        offsetY: 0,
        gridW: w,
        gridH: h,
        confidence: Math.round(confidence * 1000) / 1000,
        confidenceX: Math.round(confidenceX * 1000) / 1000,
        confidenceY: Math.round(confidenceY * 1000) / 1000,
    });
    const maxDim = Math.max(w, h);
    const minDim = Math.min(w, h);
    if (maxDim < 12 || minDim < 4)
        return noGrid();
    const maxStep = Math.min(128, Math.floor(maxDim / 4));
    if (maxStep < 2)
        return noGrid();
    const { ex, ey } = computeEdgeProfiles(buf, w, h);
    const px = makeAxisProfile(ex, w);
    const py = makeAxisProfile(ey, h);
    if (px.varSum <= 1e-9 && py.varSum <= 1e-9)
        return noGrid();
    // Stage 1: build candidate integer period pool
    const candidates = new Set();
    const smallCap = Math.min(24, maxStep);
    for (let p = 2; p <= smallCap; p++)
        candidates.add(p);
    const acX = topAutocorrelationLags(px, maxStep, 10);
    const acY = topAutocorrelationLags(py, maxStep, 10);
    for (const lag of [...acX, ...acY]) {
        for (const d of [-1, 0, 1]) {
            const v = lag + d;
            if (v >= 2 && v <= maxStep)
                candidates.add(v);
        }
        for (const div of [2, 3, 4]) {
            const sub = Math.round(lag / div);
            if (sub >= 2 && sub <= maxStep)
                candidates.add(sub);
        }
    }
    // Stage 2: coarse fractional comb-correlation scan around each integer candidate
    const sortedCands = [...candidates].sort((a, b) => a - b);
    const topEvals = [];
    const pushTop = (ev) => {
        if (ev.score <= 0)
            return;
        // Merge into an existing peak if within 0.5px
        for (let i = 0; i < topEvals.length; i++) {
            if (Math.abs(topEvals[i].period - ev.period) < 0.5) {
                if (ev.score > topEvals[i].score)
                    topEvals[i] = ev;
                return;
            }
        }
        topEvals.push(ev);
        topEvals.sort((a, b) => b.score - a.score || a.period - b.period);
        if (topEvals.length > 6)
            topEvals.length = 6;
    };
    for (const p0 of sortedCands) {
        // Adaptive fractional step keeps cumulative phase drift <= 0.25 cells across maxDim
        const dp = Math.max(0.025, Math.min(0.125, (0.25 * p0 * p0) / maxDim));
        const lo = Math.max(2, p0 - 0.55);
        const hi = Math.min(maxStep, p0 + 0.55);
        for (let p = lo; p <= hi + 1e-9; p += dp) {
            pushTop(evaluateSquarePeriod(px, py, p));
        }
    }
    if (topEvals.length === 0)
        return noGrid();
    // Stage 3: fine sub-pixel refinement around top peaks (+ sub-harmonics of winner)
    const refineSeeds = topEvals.map((e) => e.period);
    const leadP = topEvals[0].period;
    if (leadP / 2 >= 2)
        refineSeeds.push(leadP / 2);
    if (leadP / 3 >= 2)
        refineSeeds.push(leadP / 3);
    let best = topEvals[0];
    for (const seed of refineSeeds) {
        let cur = evaluateSquarePeriod(px, py, seed);
        let radius = Math.max(0.05, Math.min(0.25, (0.3 * seed * seed) / maxDim));
        for (let pass = 0; pass < 3; pass++) {
            const step = radius / 4;
            const center = cur.period;
            for (let k = -4; k <= 4; k++) {
                if (k === 0)
                    continue;
                const p = center + k * step;
                if (p < 2 || p > maxStep)
                    continue;
                const ev = evaluateSquarePeriod(px, py, p);
                if (ev.score > cur.score)
                    cur = ev;
            }
            radius = step;
        }
        if (cur.score > best.score)
            best = cur;
    }
    // Stage 4: optional small independent aspect refinement (±4%) when an axis
    // has >= 6 cells and clearly improves its correlation.
    let stepX = best.period;
    let stepY = best.period;
    let offsetX = best.offsetX;
    let offsetY = best.offsetY;
    let confX = best.scoreX;
    let confY = best.scoreY;
    if (px.varSum > 1e-9 && w / best.period >= 6) {
        let bestSX = stepX;
        let bestOX = offsetX;
        let bestRX = confX;
        const span = Math.max(0.1, best.period * 0.04);
        for (let i = -8; i <= 8; i++) {
            const sx = best.period + (i / 8) * span;
            if (sx < 2 || sx > maxStep)
                continue;
            const res = bestPhaseForPeriod(px, sx);
            if (res.score > bestRX) {
                bestRX = res.score;
                bestSX = sx;
                bestOX = res.offset;
            }
        }
        if (bestRX > confX + 0.03) {
            stepX = bestSX;
            offsetX = bestOX;
            confX = bestRX;
        }
    }
    if (py.varSum > 1e-9 && h / best.period >= 6) {
        let bestSY = stepY;
        let bestOY = offsetY;
        let bestRY = confY;
        const span = Math.max(0.1, best.period * 0.04);
        for (let i = -8; i <= 8; i++) {
            const sy = best.period + (i / 8) * span;
            if (sy < 2 || sy > maxStep)
                continue;
            const res = bestPhaseForPeriod(py, sy);
            if (res.score > bestRY) {
                bestRY = res.score;
                bestSY = sy;
                bestOY = res.offset;
            }
        }
        if (bestRY > confY + 0.03) {
            stepY = bestSY;
            offsetY = bestOY;
            confY = bestRY;
        }
    }
    // Snap nearly-exact integer periods (within 0.015px) to clean integers
    if (Math.abs(stepX - Math.round(stepX)) < 0.015) {
        const r = Math.round(stepX);
        const res = bestPhaseForPeriod(px, r);
        if (res.score >= confX - 0.005) {
            stepX = r;
            offsetX = res.offset;
            confX = res.score;
        }
    }
    if (Math.abs(stepY - Math.round(stepY)) < 0.015) {
        const r = Math.round(stepY);
        const res = bestPhaseForPeriod(py, r);
        if (res.score >= confY - 0.005) {
            stepY = r;
            offsetY = res.offset;
            confY = res.score;
        }
    }
    // Recompute final joint confidence
    const activeX = px.varSum > 1e-9 && w / stepX >= 2.5;
    const activeY = py.varSum > 1e-9 && h / stepY >= 2.5;
    const wx = activeX ? Math.min(1, w / stepX / 8) : 0;
    const wy = activeY ? Math.min(1, h / stepY / 8) : 0;
    const confidence = wx + wy > 0 ? (wx * confX + wy * confY) / (wx + wy) : 0;
    // Acceptance gates: reject non-grid images, sparse shapes, and native 1:1 pixel art
    const bothActive = activeX && activeY;
    const passesConfidence = bothActive
        ? confidence >= MIN_CONFIDENCE_JOINT &&
            Math.min(confX, confY) >= MIN_CONFIDENCE_SECONDARY_AXIS
        : confidence >= MIN_CONFIDENCE_SINGLE_AXIS;
    if (!passesConfidence)
        return noGrid(confidence, confX, confY);
    const mx = activeX ? measureAxisGrid(px, stepX, offsetX) : null;
    const my = activeY ? measureAxisGrid(py, stepY, offsetY) : null;
    const axisPasses = (met) => met.totalLines >= 2 &&
        met.edgeCapture >= MIN_EDGE_CAPTURE &&
        met.contrast >= MIN_SEAM_CONTRAST &&
        met.activeLines / met.totalLines >= MIN_ACTIVE_LINE_RATIO;
    const maxActiveLines = Math.max(mx?.activeLines ?? 0, my?.activeLines ?? 0);
    const totalActiveLines = (mx?.activeLines ?? 0) + (my?.activeLines ?? 0);
    let passesPhysical = false;
    if (mx && my) {
        const weightedCapture = (wx * mx.edgeCapture + wy * my.edgeCapture) / (wx + wy);
        const minContrast = Math.min(mx.contrast, my.contrast);
        const maxContrast = Math.max(mx.contrast, my.contrast);
        const ratioX = mx.totalLines > 0 ? mx.activeLines / mx.totalLines : 0;
        const ratioY = my.totalLines > 0 ? my.activeLines / my.totalLines : 0;
        passesPhysical =
            weightedCapture >= MIN_EDGE_CAPTURE &&
                maxContrast >= MIN_SEAM_CONTRAST &&
                minContrast >= 2.0 &&
                Math.max(ratioX, ratioY) >= MIN_ACTIVE_LINE_RATIO &&
                Math.min(ratioX, ratioY) >= 0.25 &&
                maxActiveLines >= 3 &&
                totalActiveLines >= 4;
    }
    else if (mx) {
        passesPhysical = axisPasses(mx) && mx.activeLines >= 3;
    }
    else if (my) {
        passesPhysical = axisPasses(my) && my.activeLines >= 3;
    }
    if (!passesPhysical)
        return noGrid(confidence, confX, confY);
    // Estimate cell counts using the actual boundary builder
    const xs = buildAxisBoundaries(w, stepX, offsetX);
    const ys = buildAxisBoundaries(h, stepY, offsetY);
    const gridW = xs.length - 1;
    const gridH = ys.length - 1;
    if (gridW < 2 && gridH < 2)
        return noGrid(confidence, confX, confY);
    return {
        detected: true,
        stepX: Math.round(stepX * 1000) / 1000,
        stepY: Math.round(stepY * 1000) / 1000,
        offsetX: Math.round(offsetX * 1000) / 1000,
        offsetY: Math.round(offsetY * 1000) / 1000,
        gridW,
        gridH,
        confidence: Math.round(confidence * 1000) / 1000,
        confidenceX: Math.round(confX * 1000) / 1000,
        confidenceY: Math.round(confY * 1000) / 1000,
    };
}
// ------------------------------------------------------------ grid snapping
function medianSorted(arr) {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
}
/**
 * Sample ONE denoised color from the interior core of a detected block
 * [x0, x1) × [y0, y1). Ignores the outer ~20% AA seam margin when the block is
 * >= 4px wide/tall, finds the dominant 5-bit RGB cluster (aggregating 3×3×3
 * adjacent bins so bin boundaries never split a cluster), and returns the
 * per-channel median of all pixels in that cluster. Deterministic tie-breaks.
 */
function sampleBlockColor(buf, w, x0, x1, y0, y1) {
    const bw = x1 - x0;
    const bh = y1 - y0;
    const mx = bw >= 5 ? Math.floor(bw * 0.2) : bw >= 4 ? 1 : 0;
    const my = bh >= 5 ? Math.floor(bh * 0.2) : bh >= 4 ? 1 : 0;
    const cx0 = x0 + mx;
    const cx1 = Math.max(cx0 + 1, x1 - mx);
    const cy0 = y0 + my;
    const cy1 = Math.max(cy0 + 1, y1 - my);
    const totalCore = (cx1 - cx0) * (cy1 - cy0);
    const binCounts = new Map();
    const rs = [];
    const gs = [];
    const bs = [];
    const bins = [];
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let y = cy0; y < cy1; y++) {
        const rowBase = y * w;
        for (let x = cx0; x < cx1; x++) {
            const i = (rowBase + x) * 4;
            if (buf[i + 3] < 128)
                continue;
            const r = buf[i];
            const g = buf[i + 1];
            const b = buf[i + 2];
            const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
            binCounts.set(bin, (binCounts.get(bin) ?? 0) + 1);
            rs.push(r);
            gs.push(g);
            bs.push(b);
            bins.push(bin);
            sumR += r;
            sumG += g;
            sumB += b;
        }
    }
    const opaque = rs.length;
    if (opaque === 0 || opaque * 2 < totalCore) {
        return [0, 0, 0, 0];
    }
    // Fast path: single bin → exact median immediately
    if (binCounts.size === 1) {
        return [medianSorted(rs), medianSorted(gs), medianSorted(bs), 255];
    }
    // Score each occupied 5-bit bin by the total pixel count in its 3×3×3
    // neighborhood (immune to bin-edge splits; rejects minority outlier colors).
    const meanR = sumR / opaque;
    const meanG = sumG / opaque;
    const meanB = sumB / opaque;
    const occupied = [...binCounts.entries()];
    let bestBin = occupied[0][0];
    let bestClusterWeight = -1;
    let bestDirectCount = -1;
    let bestMeanDist = Infinity;
    for (let i = 0; i < occupied.length; i++) {
        const [bKey, directCount] = occupied[i];
        const br = (bKey >> 10) & 31;
        const bg = (bKey >> 5) & 31;
        const bb = bKey & 31;
        let clusterWeight = 0;
        for (let j = 0; j < occupied.length; j++) {
            const [oKey, oCount] = occupied[j];
            const or = (oKey >> 10) & 31;
            const og = (oKey >> 5) & 31;
            const ob = oKey & 31;
            if (Math.abs(br - or) <= 1 && Math.abs(bg - og) <= 1 && Math.abs(bb - ob) <= 1) {
                clusterWeight += oCount;
            }
        }
        const centerR = (br << 3) + 4;
        const centerG = (bg << 3) + 4;
        const centerB = (bb << 3) + 4;
        const dist = (0, oklab_1.rgbDistance2)(centerR, centerG, centerB, meanR, meanG, meanB);
        const better = clusterWeight > bestClusterWeight ||
            (clusterWeight === bestClusterWeight && directCount > bestDirectCount) ||
            (clusterWeight === bestClusterWeight && directCount === bestDirectCount && dist < bestMeanDist) ||
            (clusterWeight === bestClusterWeight &&
                directCount === bestDirectCount &&
                dist === bestMeanDist &&
                bKey < bestBin);
        if (better) {
            bestBin = bKey;
            bestClusterWeight = clusterWeight;
            bestDirectCount = directCount;
            bestMeanDist = dist;
        }
    }
    const winR = (bestBin >> 10) & 31;
    const winG = (bestBin >> 5) & 31;
    const winB = bestBin & 31;
    const inR = [];
    const inG = [];
    const inB = [];
    for (let k = 0; k < opaque; k++) {
        const bk = bins[k];
        const br = (bk >> 10) & 31;
        const bg = (bk >> 5) & 31;
        const bb = bk & 31;
        if (Math.abs(br - winR) <= 1 && Math.abs(bg - winG) <= 1 && Math.abs(bb - winB) <= 1) {
            inR.push(rs[k]);
            inG.push(gs[k]);
            inB.push(bs[k]);
        }
    }
    return [medianSorted(inR), medianSorted(inG), medianSorted(inB), 255];
}
/**
 * Snap a trimmed source buffer onto a previously detected pixel grid, reading
 * one clean color per logical block and trimming any newly-transparent outer
 * ring left by sub-half-opaque edge slivers.
 */
function snapToDetectedGrid(buf, w, h, grid) {
    if (!grid.detected || grid.stepX < 2 && grid.stepY < 2) {
        return { buffer: new Uint8ClampedArray(buf), width: w, height: h };
    }
    const { ex, ey } = computeEdgeProfiles(buf, w, h);
    const xs = buildAxisBoundaries(w, grid.stepX, grid.offsetX, ex);
    const ys = buildAxisBoundaries(h, grid.stepY, grid.offsetY, ey);
    const gw = xs.length - 1;
    const gh = ys.length - 1;
    const raw = new Uint8ClampedArray(gw * gh * 4);
    let minX = gw;
    let minY = gh;
    let maxX = -1;
    let maxY = -1;
    for (let gy = 0; gy < gh; gy++) {
        const y0 = ys[gy];
        const y1 = ys[gy + 1];
        for (let gx = 0; gx < gw; gx++) {
            const x0 = xs[gx];
            const x1 = xs[gx + 1];
            const [r, g, b, a] = sampleBlockColor(buf, w, x0, x1, y0, y1);
            const o = (gy * gw + gx) * 4;
            raw[o] = r;
            raw[o + 1] = g;
            raw[o + 2] = b;
            raw[o + 3] = a;
            if (a >= 128) {
                if (gx < minX)
                    minX = gx;
                if (gy < minY)
                    minY = gy;
                if (gx > maxX)
                    maxX = gx;
                if (gy > maxY)
                    maxY = gy;
            }
        }
    }
    if (maxX < 0)
        return { buffer: raw, width: gw, height: gh };
    const trimW = maxX - minX + 1;
    const trimH = maxY - minY + 1;
    if (trimW === gw && trimH === gh) {
        return { buffer: raw, width: gw, height: gh };
    }
    const trimmed = new Uint8ClampedArray(trimW * trimH * 4);
    for (let y = 0; y < trimH; y++) {
        const srcRow = ((minY + y) * gw + minX) * 4;
        trimmed.set(raw.subarray(srcRow, srcRow + trimW * 4), y * trimW * 4);
    }
    return { buffer: trimmed, width: trimW, height: trimH };
}
// --------------------------------------------------- whole-number scaling
/**
 * Place a clean snapped sprite (sw×sh) onto a transparent targetW×targetH
 * canvas using WHOLE-NUMBER scaling only:
 *   • Fits in target (sw <= targetW && sh <= targetH): integer replicate k×k
 *     (k >= 1, largest integer fitting within the padded box; never shrinks a
 *     sprite that already fits the canvas).
 *   • Oversized (sw > targetW || sh > targetH): exact integer block downscale
 *     by div = ceil(max(sw/targetW, sh/targetH)), sampling each div×div cell
 *     with center-weighted modal color (preserving crisp thin lines and exact
 *     integer stride), and reports `oversized: true` so the caller can warn.
 */
function scaleSpriteWholeNumber(src, sw, sh, targetW, targetH, paddingPct = 0.04) {
    const out = new Uint8ClampedArray(targetW * targetH * 4);
    const clampedPad = Math.max(0, Math.min(0.25, paddingPct));
    const pad = Math.min(Math.floor(Math.min(targetW, targetH) / 2) - 1, Math.round(Math.min(targetW, targetH) * clampedPad));
    const availW = Math.max(1, targetW - pad * 2);
    const availH = Math.max(1, targetH - pad * 2);
    // Case 1: fits inside target canvas → exact whole-number upscale (k >= 1)
    if (sw <= targetW && sh <= targetH) {
        const k = Math.max(1, Math.floor(Math.min(availW / sw, availH / sh)));
        const dw = sw * k;
        const dh = sh * k;
        const dx = Math.floor((targetW - dw) / 2);
        const dy = Math.floor((targetH - dh) / 2);
        for (let sy = 0; sy < sh; sy++) {
            for (let sx = 0; sx < sw; sx++) {
                const si = (sy * sw + sx) * 4;
                const a = src[si + 3];
                if (a === 0)
                    continue;
                const r = src[si];
                const g = src[si + 1];
                const b = src[si + 2];
                const baseY = dy + sy * k;
                const baseX = dx + sx * k;
                for (let py = 0; py < k; py++) {
                    const row = (baseY + py) * targetW;
                    for (let px = 0; px < k; px++) {
                        const oi = (row + baseX + px) * 4;
                        out[oi] = r;
                        out[oi + 1] = g;
                        out[oi + 2] = b;
                        out[oi + 3] = a;
                    }
                }
            }
        }
        return {
            buffer: out,
            width: targetW,
            height: targetH,
            scaleMode: k === 1 ? 'native-1x' : 'integer-up',
            scaleFactor: k,
            oversized: false,
        };
    }
    // Case 2: oversized → whole-number integer divisor block downscale
    const div = Math.max(2, Math.ceil(Math.max(sw / targetW, sh / targetH)));
    const dw = Math.max(1, Math.min(targetW, Math.ceil(sw / div)));
    const dh = Math.max(1, Math.min(targetH, Math.ceil(sh / div)));
    // Symmetric source alignment offset so left/right and top/bottom remain balanced
    const offX = -Math.floor((dw * div - sw) / 2);
    const offY = -Math.floor((dh * div - sh) / 2);
    const dx = Math.floor((targetW - dw) / 2);
    const dy = Math.floor((targetH - dh) / 2);
    for (let ty = 0; ty < dh; ty++) {
        const y0 = Math.max(0, offY + ty * div);
        const y1 = Math.min(sh, offY + (ty + 1) * div);
        for (let tx = 0; tx < dw; tx++) {
            const x0 = Math.max(0, offX + tx * div);
            const x1 = Math.min(sw, offX + (tx + 1) * div);
            if (x0 >= x1 || y0 >= y1)
                continue;
            // Center-weighted modal color inside the exact div×div block
            const counts = new Map();
            let opaqueWeight = 0;
            let totalWeight = 0;
            let sumR = 0;
            let sumG = 0;
            let sumB = 0;
            const cx = (x0 + x1 - 1) / 2;
            const cy = (y0 + y1 - 1) / 2;
            const maxD = Math.max(1, Math.ceil(Math.max(x1 - x0, y1 - y0) / 2));
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const i = (y * sw + x) * 4;
                    const weight = maxD + 1 - Math.max(Math.abs(x - cx), Math.abs(y - cy));
                    totalWeight += weight;
                    if (src[i + 3] < 128)
                        continue;
                    const key = (src[i] << 16) | (src[i + 1] << 8) | src[i + 2];
                    counts.set(key, (counts.get(key) ?? 0) + weight);
                    opaqueWeight += weight;
                    sumR += src[i] * weight;
                    sumG += src[i + 1] * weight;
                    sumB += src[i + 2] * weight;
                }
            }
            // Require meaningful opaque coverage (at least 1/3 weight, or any opaque
            // pixel in 2×2 blocks so 1px outlines survive)
            if (opaqueWeight === 0 || (div >= 3 && opaqueWeight * 3 < totalWeight))
                continue;
            let bestCount = -1;
            for (const c of counts.values()) {
                if (c > bestCount)
                    bestCount = c;
            }
            const winners = [];
            for (const [key, c] of counts) {
                if (c === bestCount)
                    winners.push(key);
            }
            let bestKey = winners[0];
            if (winners.length > 1) {
                const meanR = sumR / opaqueWeight;
                const meanG = sumG / opaqueWeight;
                const meanB = sumB / opaqueWeight;
                let bestDist = Infinity;
                for (const key of winners) {
                    const r = (key >> 16) & 255;
                    const g = (key >> 8) & 255;
                    const b = key & 255;
                    const d = (0, oklab_1.rgbDistance2)(r, g, b, meanR, meanG, meanB);
                    if (d < bestDist || (d === bestDist && key < bestKey)) {
                        bestDist = d;
                        bestKey = key;
                    }
                }
            }
            const oi = ((dy + ty) * targetW + (dx + tx)) * 4;
            out[oi] = (bestKey >> 16) & 255;
            out[oi + 1] = (bestKey >> 8) & 255;
            out[oi + 2] = bestKey & 255;
            out[oi + 3] = 255;
        }
    }
    return {
        buffer: out,
        width: targetW,
        height: targetH,
        scaleMode: 'integer-down',
        scaleFactor: div,
        oversized: true,
    };
}
