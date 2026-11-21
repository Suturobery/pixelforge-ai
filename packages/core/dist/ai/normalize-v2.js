"use strict";
/**
 * @pixelforge/core — Deterministic normalize pipeline v2 (v3.1 Plan §3.3,
 * quality follow-up "v2.1" from the Task 9 output-quality audit).
 *
 * Order matters and every step is a pure, independently unit-testable
 * function. The v2.1 audit (Task 9 quality improvement) confirmed two real
 * defects in the shipped v2 order and fixed them WITHOUT changing the
 * step list's contract:
 *
 *   • BUG (fixed): background removal re-sampled the "background" color
 *     from the DOWNSCALED work buffer's corner patches — after trim those
 *     patches usually hit SUBJECT pixels, so the flood's tolerance base was
 *     a subject/bg blend and the flood could erase the whole sprite (the
 *     #P1 golden produced colorsOut: 0 and passed vacuously). v2.1 samples
 *     the background ONCE from the source (median of the opaque border
 *     ring, pre-removal) and threads that exact color through every
 *     downstream step.
 *   • BUG (fixed): background removal ran only at target resolution, so
 *     background between limbs/thin gaps was blended into modal-color
 *     blocks before it could be cleared — interior residue ("leftover
 *     pixels") and mushy silhouettes. v2.1 floods at SOURCE resolution
 *     first; the downscale then sees transparent blocks, and a target-res
 *     flood with the true bg color remains as a safety net.
 *
 * Pipeline (v2.1):
 *   1. sampleBorderColorMedian — background color estimate (source)
 *   2. floodRemoveBackgroundWithColor at SOURCE res (when removeBg)
 *   2b. removeStrayComponents at source res (optional control)
 *   3. trimContentBBox          — crop to the content bounding box
 *   4. dominantColorDownscale   — modal-color grid downscale; 'contain' fit
 *      (default) preserves the subject's aspect ratio and centers it with
 *      optional padding; 'fill' is the legacy anisotropic stretch
 *   5. alpha threshold (configurable) + despeckle
 *   6. target-res flood with the SAME true bg color (safety net for
 *      border-connected residue created by mixed modal cells)
 *   6b. removeEnclosedBgResidue (optional control — OFF by default: an
 *      enclosed bg-colored region may be an intentional light detail)
 *   7. quantizeToPalette        — OKLab nearest-color mapping (project
 *      palette, or auto median-cut ≤ maxColors); dithering OFF by design
 *   8. cleanupOutlineFringe     — AA-fringe ring cleanup
 *
 * DETERMINISM CONTRACT: no randomness, no Date.now, no Math.random, no DOM,
 * stable tie-breaks everywhere. The same input buffer + options always
 * produce byte-identical output — golden-image tests pin this.
 *
 * Buffers are RGBA, 4 bytes per pixel, row-major (the editor's CellBuffer
 * shape). Input may be Uint8ClampedArray or Uint8Array; outputs are always
 * fresh Uint8ClampedArray copies (source buffers are never mutated).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_NORMALIZE2_OPTIONS = void 0;
exports.sampleBorderColorMedian = sampleBorderColorMedian;
exports.trimContentBBox = trimContentBBox;
exports.dominantColorDownscale = dominantColorDownscale;
exports.applyAlphaThreshold = applyAlphaThreshold;
exports.despeckleIsolated = despeckleIsolated;
exports.sampleBorderColor = sampleBorderColor;
exports.floodRemoveBackground = floodRemoveBackground;
exports.floodRemoveBackgroundWithColor = floodRemoveBackgroundWithColor;
exports.removeStrayComponents = removeStrayComponents;
exports.removeEnclosedBgResidue = removeEnclosedBgResidue;
exports.medianCutPalette = medianCutPalette;
exports.harvestPalette = harvestPalette;
exports.quantizeToPalette = quantizeToPalette;
exports.cleanupOutlineFringe = cleanupOutlineFringe;
exports.cleanupOutlineFringeWithColor = cleanupOutlineFringeWithColor;
exports.normalizeV2 = normalizeV2;
exports.nearestNeighborContain = nearestNeighborContain;
exports.fitBufferToCanvas = fitBufferToCanvas;
const oklab_1 = require("./oklab");
exports.DEFAULT_NORMALIZE2_OPTIONS = {
    targetW: 32,
    targetH: 32,
    removeBg: true,
    bgTolerance: 48,
    paletteMode: 'auto',
    palette: [],
    maxColors: 16,
    outlineCleanup: true,
    fit: 'contain',
    paddingPct: 0.04,
    alphaThreshold: 128,
    strayCleanup: 'off',
    enclosedResidueCleanup: false,
};
// ------------------------------------------------------------------- step 1
/**
 * Background color estimate: MEDIAN of the opaque border-ring pixels (the
 * outermost 1px ring). Far more robust than the prototype's 4 corner
 * patches — a subject touching a corner, or a gradient backdrop, no longer
 * poisons the estimate (corner patches see a handful of px; the ring sees
 * them all). Per-channel medians are deterministic; when the ring is fully
 * transparent the corner-patch sampler is the fallback (same contract as
 * before), and a fully empty estimate falls back to white.
 */
function sampleBorderColorMedian(buf, w, h) {
    const rs = [];
    const gs = [];
    const bs = [];
    const push = (x, y) => {
        const i = (y * w + x) * 4;
        if (buf[i + 3] >= 128) {
            rs.push(buf[i]);
            gs.push(buf[i + 1]);
            bs.push(buf[i + 2]);
        }
    };
    for (let x = 0; x < w; x++) {
        push(x, 0);
        push(x, h - 1);
    }
    for (let y = 1; y < h - 1; y++) {
        push(0, y);
        push(w - 1, y);
    }
    if (rs.length === 0)
        return sampleBorderColor(buf, w, h);
    const median = (arr) => {
        const sorted = [...arr].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    };
    return [median(rs), median(gs), median(bs)];
}
/**
 * Trim to the content bounding box: the smallest rectangle that contains all
 * pixels that differ from a "background" definition — fully transparent px
 * plus (when removeBg is on) px within tolerance of the sampled border color.
 * A fully empty or fully uniform image returns the full rect (no trim).
 */
function trimContentBBox(buf, w, h, removeBg, bgTolerance) {
    const border = sampleBorderColorMedian(buf, w, h);
    const tol2 = bgTolerance * bgTolerance;
    const isBgLike = (i) => {
        if (buf[i + 3] < 128)
            return true;
        if (!removeBg)
            return false;
        const dr = buf[i] - border[0];
        const dg = buf[i + 1] - border[1];
        const db = buf[i + 2] - border[2];
        return dr * dr + dg * dg + db * db <= tol2;
    };
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!isBgLike((y * w + x) * 4)) {
                if (x < minX)
                    minX = x;
                if (y < minY)
                    minY = y;
                if (x > maxX)
                    maxX = x;
                if (y > maxY)
                    maxY = y;
            }
        }
    }
    if (maxX < 0)
        return { x: 0, y: 0, w, h };
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
// ------------------------------------------------------------------- step 2
/**
 * Dominant-color grid downscale (§3.3 step 2). The source (already trimmed)
 * is covered by an exact targetW×targetH grid; per target cell the modal
 * color of the source block wins. Weights are center-weighted
 * (w = maxD + 1 − chebyshev(px, block center)), fully transparent px
 * (alpha < 128) only count when the whole block is transparent. Ties resolve
 * to the color closest to the block mean — never to scan order — so the
 * result is independent of iteration order and stable under future edits.
 *
 * Returns a fresh buffer of exactly targetW×targetH. Output pixels are
 * either fully opaque (alpha 255) or fully transparent (alpha 0).
 */
function dominantColorDownscale(src, sw, sh, targetW, targetH) {
    const out = new Uint8ClampedArray(targetW * targetH * 4);
    // exact float grid; blocks may be fractional when upscaling a tiny trim
    const cellW = sw / targetW;
    const cellH = sh / targetH;
    for (let ty = 0; ty < targetH; ty++) {
        const y0 = Math.floor(ty * cellH);
        const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * cellH));
        for (let tx = 0; tx < targetW; tx++) {
            const x0 = Math.floor(tx * cellW);
            const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * cellW));
            // center-weighted histogram of the block
            const counts = new Map();
            let opaqueWeight = 0;
            let sumR = 0, sumG = 0, sumB = 0;
            const cx = (x0 + x1 - 1) / 2;
            const cy = (y0 + y1 - 1) / 2;
            const maxD = Math.max(1, Math.ceil(Math.max(x1 - x0, y1 - y0) / 2));
            for (let y = y0; y < y1 && y < sh; y++) {
                for (let x = x0; x < x1 && x < sw; x++) {
                    const i = (y * sw + x) * 4;
                    const weight = maxD + 1 - Math.max(Math.abs(x - cx), Math.abs(y - cy));
                    if (src[i + 3] < 128) {
                        continue;
                    }
                    const key = (src[i] << 16) | (src[i + 1] << 8) | src[i + 2];
                    counts.set(key, (counts.get(key) ?? 0) + weight);
                    opaqueWeight += weight;
                    sumR += src[i] * weight;
                    sumG += src[i + 1] * weight;
                    sumB += src[i + 2] * weight;
                }
            }
            const o = (ty * targetW + tx) * 4;
            if (opaqueWeight === 0) {
                out[o + 3] = 0; // transparent cell
                continue;
            }
            // modal color; tie → closest to the block mean (per plan §3.3)
            let bestCount = -1;
            for (const count of counts.values()) {
                if (count > bestCount)
                    bestCount = count;
            }
            const winners = [];
            for (const [key, count] of counts) {
                if (count === bestCount)
                    winners.push(key);
            }
            let bestKey = winners[0];
            if (winners.length > 1) {
                const meanR = sumR / opaqueWeight;
                const meanG = sumG / opaqueWeight;
                const meanB = sumB / opaqueWeight;
                let bestDist = Infinity;
                for (const key of winners) {
                    const r = (key >> 16) & 255, g = (key >> 8) & 255, b = key & 255;
                    const d = (0, oklab_1.rgbDistance2)(r, g, b, meanR, meanG, meanB);
                    if (d < bestDist) {
                        bestDist = d;
                        bestKey = key;
                    }
                }
            }
            out[o] = (bestKey >> 16) & 255;
            out[o + 1] = (bestKey >> 8) & 255;
            out[o + 2] = bestKey & 255;
            out[o + 3] = 255;
        }
    }
    return out;
}
// ------------------------------------------------------------------- step 3
/** Binary alpha: < threshold → 0, everything else → 255. In place. */
function applyAlphaThreshold(buf, threshold = 128) {
    for (let i = 3; i < buf.length; i += 4) {
        buf[i] = buf[i] < threshold ? 0 : 255;
    }
}
/**
 * Despeckle: clear isolated opaque pixels — opaque px whose 4 neighbors are
 * all transparent (border counts as transparent). Single deterministic pass;
 * removals do not cascade within the pass.
 */
function despeckleIsolated(buf, w, h) {
    const toClear = [];
    const isOpaque = (x, y) => x >= 0 && y >= 0 && x < w && y < h && buf[(y * w + x) * 4 + 3] !== 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (buf[i + 3] === 0)
                continue;
            if (!isOpaque(x - 1, y) && !isOpaque(x + 1, y) && !isOpaque(x, y - 1) && !isOpaque(x, y + 1)) {
                toClear.push(i);
            }
        }
    }
    for (const i of toClear)
        buf[i + 3] = 0;
    return toClear.length;
}
// ------------------------------------------------------------------- step 4
/** Average the 4 corner patches of the image (prototype border sampler). */
function sampleBorderColor(buf, w, h) {
    const corners = [
        [1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2],
    ];
    const acc = [0, 0, 0];
    let samples = 0;
    for (const [cx, cy] of corners) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const x = Math.min(w - 1, Math.max(0, cx + dx));
                const y = Math.min(h - 1, Math.max(0, cy + dy));
                const i = (y * w + x) * 4;
                acc[0] += buf[i];
                acc[1] += buf[i + 1];
                acc[2] += buf[i + 2];
                samples++;
            }
        }
    }
    return samples === 0 ? [255, 255, 255] : [acc[0] / samples, acc[1] / samples, acc[2] / samples];
}
/**
 * Flood background removal from the borders (prototype algorithm, kept per
 * plan §3.3 step 4): clears every border-connected pixel within tolerance of
 * the sampled corner color. Interior same-colored pixels survive.
 * Returns the number of cleared pixels. In place.
 *
 * (Legacy self-sampling variant — retained for compatibility and the #B1/#B2
 * goldens. The pipeline itself uses floodRemoveBackgroundWithColor, which
 * never re-samples: see the v2.1 audit note atop this file.)
 */
function floodRemoveBackground(buf, w, h, tolerance = 48) {
    return floodRemoveBackgroundWithColor(buf, w, h, sampleBorderColor(buf, w, h), tolerance);
}
/**
 * Flood background removal against an EXPLICIT background color (v2.1).
 * Clears every border-connected pixel whose color sits within tolerance of
 * `bgColor`. Pixels already transparent (alpha < 128) act as walls — their
 * RGB is meaningless and must not seed or extend the flood. Interior
 * same-colored pixels survive. Deterministic. In place.
 */
function floodRemoveBackgroundWithColor(buf, w, h, bgColor, tolerance = 48) {
    const tol2 = tolerance * tolerance;
    const isBg = (i) => {
        if (buf[i + 3] < 128)
            return false;
        const dr = buf[i] - bgColor[0];
        const dg = buf[i + 1] - bgColor[1];
        const db = buf[i + 2] - bgColor[2];
        return dr * dr + dg * dg + db * db <= tol2;
    };
    const visited = new Uint8Array(w * h);
    const stack = [];
    const push = (x, y) => {
        const p = y * w + x;
        if (visited[p])
            return;
        visited[p] = 1;
        if (isBg(p * 4))
            stack.push(p);
    };
    for (let x = 0; x < w; x++) {
        push(x, 0);
        push(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
        push(0, y);
        push(w - 1, y);
    }
    let cleared = 0;
    while (stack.length > 0) {
        const p = stack.pop();
        const i = p * 4;
        if (buf[i + 3] !== 0)
            cleared++;
        buf[i + 3] = 0;
        const x = p % w;
        const y = (p / w) | 0;
        if (x > 0)
            push(x - 1, y);
        if (x < w - 1)
            push(x + 1, y);
        if (y > 0)
            push(x, y - 1);
        if (y < h - 1)
            push(x, y + 1);
    }
    return cleared;
}
// --------------------------------------------------- v2.1 component cleanup
/**
 * Clear small stray opaque components (4-connected) whose pixel count is
 * below `minPx` — source-resolution dust and noise that would otherwise
 * inflate the trim bbox (shrinking the real subject) or survive into the
 * output as isolated dots. The LARGEST component (the subject) is never
 * touched, and components at/above minPx always survive. Deterministic
 * single pass. Returns the number of cleared PIXELS. In place.
 */
function removeStrayComponents(buf, w, h, minPx) {
    if (minPx < 2)
        return 0;
    const visited = new Uint8Array(w * h);
    const stack = [];
    const component = [];
    let cleared = 0;
    for (let start = 0; start < w * h; start++) {
        if (visited[start])
            continue;
        visited[start] = 1;
        if (buf[start * 4 + 3] < 128)
            continue;
        stack.length = 0;
        component.length = 0;
        stack.push(start);
        while (stack.length > 0) {
            const p = stack.pop();
            component.push(p);
            const x = p % w;
            const y = (p / w) | 0;
            if (x > 0)
                tryVisit(p - 1);
            if (x < w - 1)
                tryVisit(p + 1);
            if (y > 0)
                tryVisit(p - w);
            if (y < h - 1)
                tryVisit(p + w);
        }
        if (component.length < minPx) {
            for (const p of component)
                buf[p * 4 + 3] = 0;
            cleared += component.length;
        }
    }
    return cleared;
    function tryVisit(p) {
        if (visited[p])
            return;
        visited[p] = 1;
        if (buf[p * 4 + 3] < 128)
            return;
        stack.push(p);
    }
}
/**
 * Clear ENCLOSED background residue (v2.1 control): connected components of
 * opaque pixels that (a) match `bgColor` within tolerance and (b) do NOT
 * touch the image border. These are the leftover pools the flood could not
 * reach — background trapped between limbs, in gaps, or fully surrounded by
 * the subject. Border-connected bg is NOT cleared here (the flood owns it).
 *
 * OPT-IN by design: an enclosed bg-colored region may be an intentional
 * light detail (an eye, a highlight) — the quality report warns about
 * residue instead of erasing it silently. Deterministic. Returns cleared
 * pixel count. In place.
 */
function removeEnclosedBgResidue(buf, w, h, bgColor, tolerance = 48) {
    const tol2 = tolerance * tolerance;
    const isResidue = (i) => {
        if (buf[i + 3] < 128)
            return false;
        const dr = buf[i] - bgColor[0];
        const dg = buf[i + 1] - bgColor[1];
        const db = buf[i + 2] - bgColor[2];
        return dr * dr + dg * dg + db * db <= tol2;
    };
    const visited = new Uint8Array(w * h);
    const stack = [];
    const component = [];
    let touchesBorder = false;
    let cleared = 0;
    for (let start = 0; start < w * h; start++) {
        if (visited[start])
            continue;
        visited[start] = 1;
        if (!isResidue(start * 4))
            continue;
        stack.length = 0;
        component.length = 0;
        touchesBorder = false;
        stack.push(start);
        while (stack.length > 0) {
            const p = stack.pop();
            component.push(p);
            const x = p % w;
            const y = (p / w) | 0;
            if (x === 0 || y === 0 || x === w - 1 || y === h - 1)
                touchesBorder = true;
            if (x > 0)
                tryVisit(p - 1);
            if (x < w - 1)
                tryVisit(p + 1);
            if (y > 0)
                tryVisit(p - w);
            if (y < h - 1)
                tryVisit(p + w);
        }
        if (!touchesBorder) {
            for (const p of component)
                buf[p * 4 + 3] = 0;
            cleared += component.length;
        }
    }
    return cleared;
    function tryVisit(p) {
        if (visited[p])
            return;
        visited[p] = 1;
        if (!isResidue(p * 4))
            return;
        stack.push(p);
    }
}
// ------------------------------------------------------------------- step 5
/**
 * Median-cut palette extraction over the opaque pixels (auto mode).
 * Deterministic port of the prototype's quantizer: RGB boxes split at the
 * weighted median along their widest channel until `maxColors` boxes exist.
 */
function medianCutPalette(buf, maxColors) {
    const n = buf.length / 4;
    const counts = new Map();
    for (let i = 0; i < n; i++) {
        if (buf[i * 4 + 3] === 0)
            continue;
        const k = (buf[i * 4] << 16) | (buf[i * 4 + 1] << 8) | buf[i * 4 + 2];
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if (counts.size === 0)
        return [];
    if (counts.size <= maxColors) {
        return [...counts.keys()].map((k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]);
    }
    const cols = [...counts.entries()].map(([key, count]) => ({
        key,
        r: (key >> 16) & 255,
        g: (key >> 8) & 255,
        b: key & 255,
        count,
    }));
    let boxes = [cols];
    while (boxes.length < maxColors) {
        let bestIdx = -1;
        let bestScore = -1;
        for (let i = 0; i < boxes.length; i++) {
            const box = boxes[i];
            if (box.length < 2)
                continue;
            let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
            for (const p of box) {
                if (p.r < rmin)
                    rmin = p.r;
                if (p.r > rmax)
                    rmax = p.r;
                if (p.g < gmin)
                    gmin = p.g;
                if (p.g > gmax)
                    gmax = p.g;
                if (p.b < bmin)
                    bmin = p.b;
                if (p.b > bmax)
                    bmax = p.b;
            }
            const spread = Math.max(rmax - rmin, gmax - gmin, bmax - bmin);
            const weight = box.reduce((s, p) => s + p.count, 0);
            const score = spread * weight;
            if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }
        if (bestIdx < 0)
            break;
        const box = boxes[bestIdx];
        let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
        for (const p of box) {
            if (p.r < rmin)
                rmin = p.r;
            if (p.r > rmax)
                rmax = p.r;
            if (p.g < gmin)
                gmin = p.g;
            if (p.g > gmax)
                gmax = p.g;
            if (p.b < bmin)
                bmin = p.b;
            if (p.b > bmax)
                bmax = p.b;
        }
        const ranges = [rmax - rmin, gmax - gmin, bmax - bmin];
        const channel = ranges.indexOf(Math.max(ranges[0], ranges[1], ranges[2]));
        box.sort((a, b) => (channel === 0 ? a.r - b.r : channel === 1 ? a.g - b.g : a.b - b.b));
        const total = box.reduce((s, p) => s + p.count, 0);
        let acc = 0;
        let cut = 0;
        for (let i = 0; i < box.length; i++) {
            acc += box[i].count;
            if (acc >= total / 2) {
                cut = i + 1;
                break;
            }
        }
        if (cut <= 0 || cut >= box.length)
            cut = Math.floor(box.length / 2);
        boxes.splice(bestIdx, 1, box.slice(0, cut), box.slice(cut));
    }
    return boxes.map((box) => {
        let r = 0, g = 0, b = 0, c = 0;
        for (const p of box) {
            r += p.r * p.count;
            g += p.g * p.count;
            b += p.b * p.count;
            c += p.count;
        }
        return [Math.round(r / c), Math.round(g / c), Math.round(b / c)];
    });
}
/**
 * Palette harvest: extract the best `maxColors` from any RGBA image
 * (median cut over opaque pixels) as hex strings, sorted dark → light.
 * The one-call "steal this image's colors" helper.
 */
function harvestPalette(buf, maxColors = 16) {
    const rgb = medianCutPalette(buf, maxColors);
    return rgb
        .map(([r, g, b]) => {
        const hexv = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return { hexv, lum };
    })
        .sort((p, q) => p.lum - q.lum)
        .map((p) => p.hexv);
}
/**
 * OKLab quantize: map every opaque pixel to its nearest palette color in
 * OKLab space (perceptual — §3.3 step 5). Alpha is preserved. Deterministic
 * tie-break: lowest palette index wins. In place.
 */
function quantizeToPalette(buf, paletteRgb) {
    if (paletteRgb.length === 0)
        return;
    const lab = paletteRgb.map(([r, g, b]) => (0, oklab_1.rgbToOklab)(r, g, b));
    const cache = new Map();
    const n = buf.length / 4;
    for (let i = 0; i < n; i++) {
        if (buf[i * 4 + 3] === 0)
            continue;
        const key = (buf[i * 4] << 16) | (buf[i * 4 + 1] << 8) | buf[i * 4 + 2];
        let mapped = cache.get(key);
        if (!mapped) {
            const src = (0, oklab_1.rgbToOklab)((key >> 16) & 255, (key >> 8) & 255, key & 255);
            let best = 0;
            let bestDist = Infinity;
            for (let j = 0; j < lab.length; j++) {
                const d = (0, oklab_1.oklabDistance2)(src, lab[j]);
                if (d < bestDist) {
                    bestDist = d;
                    best = j;
                }
            }
            mapped = paletteRgb[best];
            cache.set(key, mapped);
        }
        buf[i * 4] = mapped[0];
        buf[i * 4 + 1] = mapped[1];
        buf[i * 4 + 2] = mapped[2];
    }
}
// ------------------------------------------------------------------- step 6
/**
 * Outline fringe cleanup (§3.3 step 6): opaque pixels adjacent (4-
 * neighborhood) to transparency that still sit within `tolerance` of the
 * background color are AA residue of the removed background — clear them.
 * Deterministic single pass. Returns the number of cleared pixels. In place.
 *
 * Note: the plan phrases step 6 as "remove out-of-palette px adjacent to
 * transparency". After step 5 with a palette every pixel is in-palette, so
 * the operational meaning is the AA ring left by background removal; this
 * implementation clears exactly that ring (color-match definition) and is
 * verified by golden tests. With quantize OFF the ring pixels are also the
 * blended, palette-foreign colors — the same rule catches them.
 */
function cleanupOutlineFringe(buf, w, h, tolerance = 40) {
    const base = sampleBorderColor(buf, w, h);
    // the background is already cleared here, so corner sampling would hit
    // transparent px — recover the original bg color from the options path:
    // callers pass the pre-removal border color via `bgColor` when needed.
    return cleanupOutlineFringeWithColor(buf, w, h, base, tolerance);
}
/**
 * Fringe cleanup against an EXPLICIT background color (the border color
 * sampled BEFORE flood removal) — this is the deterministic variant the
 * orchestrator uses. Returns cleared pixel count. In place.
 */
function cleanupOutlineFringeWithColor(buf, w, h, bgColor, tolerance = 40) {
    const tol2 = tolerance * tolerance;
    const isTransparent = (x, y) => x < 0 || y < 0 || x >= w || y >= h || buf[(y * w + x) * 4 + 3] === 0;
    const matchesBg = (i) => {
        const dr = buf[i] - bgColor[0];
        const dg = buf[i + 1] - bgColor[1];
        const db = buf[i + 2] - bgColor[2];
        return dr * dr + dg * dg + db * db <= tol2;
    };
    const toClear = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (buf[i + 3] === 0)
                continue;
            if (!isTransparent(x - 1, y) && !isTransparent(x + 1, y) && !isTransparent(x, y - 1) && !isTransparent(x, y + 1)) {
                continue; // not adjacent to transparency
            }
            if (matchesBg(i))
                toClear.push(i);
        }
    }
    for (const i of toClear)
        buf[i + 3] = 0;
    return toClear.length;
}
// ------------------------------------------------------------- orchestrator
function asClamped(buf) {
    return buf instanceof Uint8ClampedArray ? new Uint8ClampedArray(buf) : new Uint8ClampedArray(buf);
}
function countColors(buf) {
    const seen = new Set();
    for (let i = 0; i < buf.length; i += 4) {
        if (buf[i + 3] === 0)
            continue;
        seen.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
    }
    return seen.size;
}
/**
 * Contain-fit placement of the trimmed content inside the target canvas:
 * preserves the bbox aspect ratio, centers the result, and (optionally)
 * leaves a padding margin. The dominant-color grid downscale runs at the
 * contained size (dw×dh) and the grid is pasted 1:1 into a transparent
 * target-sized buffer. 'fill' stretches the bbox to the full target (legacy
 * v2 behavior). Exact targetW×targetH output, deterministic.
 */
function downscaleIntoTarget(trimmed, bboxW, bboxH, targetW, targetH, fit, paddingPct) {
    let dw = targetW;
    let dh = targetH;
    let dx = 0;
    let dy = 0;
    if (fit === 'contain') {
        const pad = Math.min(Math.floor(Math.min(targetW, targetH) / 2) - 1, Math.round(Math.min(targetW, targetH) * paddingPct));
        const availW = Math.max(1, targetW - pad * 2);
        const availH = Math.max(1, targetH - pad * 2);
        const scale = Math.min(availW / bboxW, availH / bboxH);
        dw = Math.max(1, Math.min(targetW, Math.round(bboxW * scale)));
        dh = Math.max(1, Math.min(targetH, Math.round(bboxH * scale)));
        dx = Math.floor((targetW - dw) / 2);
        dy = Math.floor((targetH - dh) / 2);
    }
    const grid = dominantColorDownscale(trimmed, bboxW, bboxH, dw, dh);
    const out = new Uint8ClampedArray(targetW * targetH * 4);
    for (let y = 0; y < dh; y++) {
        out.set(grid.subarray(y * dw * 4, (y + 1) * dw * 4), ((dy + y) * targetW + dx) * 4);
    }
    return out;
}
/**
 * Full normalize-v2 pipeline (§3.3 + v2.1 quality audit). Steps run in the
 * documented order; the source buffer is never mutated. Exact output size is
 * guaranteed (targetW×targetH); transparency is preserved end-to-end.
 */
function normalizeV2(src, srcW, srcH, opts) {
    if (!Number.isInteger(opts.targetW) || !Number.isInteger(opts.targetH) || opts.targetW < 1 || opts.targetH < 1 || opts.targetW > 512 || opts.targetH > 512) {
        throw new Error('normalize-v2: target dimensions must be integers in [1, 512]');
    }
    if (srcW < 1 || srcH < 1 || src.length < srcW * srcH * 4) {
        throw new Error('normalize-v2: source buffer does not match its declared dimensions');
    }
    const fit = opts.fit ?? 'contain';
    const paddingPct = Math.max(0, Math.min(0.25, opts.paddingPct ?? 0));
    const alphaThreshold = Math.max(1, Math.min(255, Math.round(opts.alphaThreshold ?? 128)));
    const strayCleanup = opts.strayCleanup ?? 'off';
    // 1. ONE background estimate, sampled from the SOURCE pre-removal (median
    //    border ring — robust against subjects touching corners and against
    //    gradient backdrops), threaded through every downstream step.
    const borderColor = sampleBorderColorMedian(src, srcW, srcH);
    // 2. source-resolution background removal (v2.1 — before trim/downscale,
    //    so bg between limbs becomes transparency instead of modal-color mix)
    const work = asClamped(src);
    let bgRemoved = 0;
    if (opts.removeBg) {
        bgRemoved += floodRemoveBackgroundWithColor(work, srcW, srcH, borderColor, opts.bgTolerance);
    }
    // 2b. optional source stray cleanup (dust/noise would inflate the bbox)
    let sourceStrays = 0;
    if (strayCleanup !== 'off') {
        const area = srcW * srcH;
        const minPx = strayCleanup === 'strong'
            ? Math.max(3, Math.round(area * 0.0005))
            : Math.max(2, Math.round(area * 0.0001));
        sourceStrays = removeStrayComponents(work, srcW, srcH, minPx);
    }
    // 3. trim (bbox computed on the flooded work buffer, source coordinates)
    const bbox = trimContentBBox(work, srcW, srcH, opts.removeBg, opts.bgTolerance);
    const trimmed = new Uint8ClampedArray(bbox.w * bbox.h * 4);
    for (let y = 0; y < bbox.h; y++) {
        const srcRow = ((bbox.y + y) * srcW + bbox.x) * 4;
        trimmed.set(work.subarray(srcRow, srcRow + bbox.w * 4), y * bbox.w * 4);
    }
    // 4. dominant-color downscale into the exact target (contain: aspect-safe)
    let out = downscaleIntoTarget(trimmed, bbox.w, bbox.h, opts.targetW, opts.targetH, fit, paddingPct);
    // 5. binary alpha (configurable threshold) + despeckle
    applyAlphaThreshold(out, alphaThreshold);
    const speckles = despeckleIsolated(out, opts.targetW, opts.targetH);
    // 6. target-res flood with the SAME true bg color — safety net for
    //    border-connected residue created by mixed modal cells
    if (opts.removeBg) {
        bgRemoved += floodRemoveBackgroundWithColor(out, opts.targetW, opts.targetH, borderColor, opts.bgTolerance);
    }
    // 6b. optional enclosed-residue cleanup (user control, default off)
    let residueRemoved = 0;
    if (opts.removeBg && opts.enclosedResidueCleanup) {
        residueRemoved = removeEnclosedBgResidue(out, opts.targetW, opts.targetH, borderColor, opts.bgTolerance);
    }
    // 7. palette quantization
    let paletteUsed = 'off';
    let paletteRgb = [];
    if (opts.paletteMode === 'project') {
        paletteRgb = opts.palette
            .map((hex) => (0, oklab_1.parseHexColor)(hex))
            .filter((c) => c !== null);
        paletteUsed = 'project';
    }
    else if (opts.paletteMode === 'auto') {
        paletteRgb = medianCutPalette(out, Math.max(2, Math.min(64, opts.maxColors)));
        paletteUsed = 'auto';
    }
    if (paletteRgb.length > 0) {
        quantizeToPalette(out, paletteRgb);
    }
    // 8. outline fringe cleanup (against the true pre-removal bg color)
    let fringeRemoved = 0;
    if (opts.outlineCleanup && opts.removeBg) {
        fringeRemoved = cleanupOutlineFringeWithColor(out, opts.targetW, opts.targetH, borderColor, Math.min(64, opts.bgTolerance));
    }
    const hex = (v) => v.toString(16).padStart(2, '0');
    return {
        buffer: out,
        width: opts.targetW,
        height: opts.targetH,
        stats: {
            trim: bbox,
            bgRemoved,
            specklesRemoved: speckles,
            colorsOut: countColors(out),
            fringeRemoved,
            paletteUsed,
            fit,
            sourceStraysRemoved: sourceStrays,
            residueRemoved,
            bgColor: `#${hex(Math.round(borderColor[0]))}${hex(Math.round(borderColor[1]))}${hex(Math.round(borderColor[2]))}`,
        },
    };
}
/**
 * Contain-fit NEAREST-NEIGHBOR downscale — the PROTOTYPE pipeline, kept
 * exclusively for the §3.3 A/B benchmark and the legacy fallback path.
 * Deterministic; returns a fresh buffer of exactly targetW×targetH.
 */
function nearestNeighborContain(src, sw, sh, targetW, targetH) {
    const out = new Uint8ClampedArray(targetW * targetH * 4);
    const scale = Math.min(targetW / sw, targetH / sh);
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));
    const dx = Math.floor((targetW - dw) / 2);
    const dy = Math.floor((targetH - dh) / 2);
    for (let y = 0; y < dh; y++) {
        const sy = Math.min(sh - 1, Math.floor((y + 0.5) / scale));
        for (let x = 0; x < dw; x++) {
            const sx = Math.min(sw - 1, Math.floor((x + 0.5) / scale));
            const si = (sy * sw + sx) * 4;
            const oi = ((dy + y) * targetW + (dx + x)) * 4;
            out[oi] = src[si];
            out[oi + 1] = src[si + 1];
            out[oi + 2] = src[si + 2];
            out[oi + 3] = src[si + 3];
        }
    }
    return out;
}
// ------------------------------------------------------------- import fit
/**
 * Center a normalized sprite buffer onto a canvas-sized transparent buffer
 * (pixel-perfect placement, NO resampling — pixels stay 1:1). Used by the
 * AI import paths (panel + MCP accept_candidate) so a candidate normalized
 * at any sprite size lands cleanly on the canvas cel. When the sizes already
 * match, the input is returned unchanged.
 */
function fitBufferToCanvas(buffer, w, h, canvasW, canvasH) {
    if (w === canvasW && h === canvasH)
        return buffer;
    if (w > canvasW || h > canvasH) {
        throw new Error(`fitBufferToCanvas: sprite ${w}×${h} exceeds the canvas ${canvasW}×${canvasH}`);
    }
    const out = new Uint8ClampedArray(canvasW * canvasH * 4);
    const dx = Math.floor((canvasW - w) / 2);
    const dy = Math.floor((canvasH - h) / 2);
    for (let y = 0; y < h; y++) {
        const srcRow = y * w * 4;
        out.set(buffer.subarray(srcRow, srcRow + w * 4), ((dy + y) * canvasW + dx) * 4);
    }
    return out;
}
