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
export interface DetectedGrid {
    /** Whether a reliable pixel-art block grid was found. */
    detected: boolean;
    /** Detected horizontal block pitch in source pixels (1 when not detected). */
    stepX: number;
    /** Detected vertical block pitch in source pixels (1 when not detected). */
    stepY: number;
    /** Phase offset of the first vertical grid line in [0, stepX). */
    offsetX: number;
    /** Phase offset of the first vertical grid line in [0, stepY). */
    offsetY: number;
    /** Estimated logical sprite width in detected art pixels. */
    gridW: number;
    /** Estimated logical sprite height in detected art pixels. */
    gridH: number;
    /** Combined grid-alignment confidence in [0, 1] (comb-edge Pearson r). */
    confidence: number;
    /** Per-axis confidences in [0, 1]. */
    confidenceX: number;
    confidenceY: number;
}
export type GridScaleMode = 'none' | 'native-1x' | 'integer-up' | 'integer-down' | 'fill';
export interface GridSnapStats {
    /** Whether a pixel-art block grid was detected and snapped. */
    detected: boolean;
    /** Detected source block width (1 when not detected). */
    stepX: number;
    /** Detected source block height (1 when not detected). */
    stepY: number;
    /** Detected phase offset in trimmed source pixels. */
    offsetX: number;
    offsetY: number;
    /** True logical sprite dimensions after grid snapping (before canvas scaling). */
    trueW: number;
    trueH: number;
    /** Grid alignment confidence in [0, 1]. */
    confidence: number;
    /** Whether the detected true sprite exceeded the target canvas size. */
    oversized: boolean;
    /** How the snapped sprite was mapped to the target canvas. */
    scaleMode: GridScaleMode;
    /** Whole-number scale factor (>1 upscale, >1 downscale divisor, 1 native/none). */
    scaleFactor: number;
}
export interface SnappedSprite {
    buffer: Uint8ClampedArray;
    width: number;
    height: number;
}
export interface WholeNumberScaleResult {
    buffer: Uint8ClampedArray;
    width: number;
    height: number;
    scaleMode: 'native-1x' | 'integer-up' | 'integer-down';
    scaleFactor: number;
    oversized: boolean;
}
/**
 * Compute 1D vertical (ex) and horizontal (ey) edge-energy profiles for an
 * RGBA buffer. ex[x] (1 <= x < w) is the summed edge strength between columns
 * x-1 and x; ey[y] (1 <= y < h) is the summed edge strength between rows y-1
 * and y. Transparent-transparent pairs contribute 0; opaque-transparent pairs
 * contribute a capped silhouette edge; opaque-opaque pairs apply a soft noise
 * floor so diffusion grain inside flat blocks does not obscure block seams.
 */
export declare function computeEdgeProfiles(buf: Uint8Array | Uint8ClampedArray, w: number, h: number): {
    ex: Float64Array;
    ey: Float64Array;
};
/**
 * Detect whether `buf` (w×h, typically a trimmed sprite) lies on an upscaled
 * fake-pixel grid, returning the recovered pitch `(stepX, stepY)`, phase
 * `(offsetX, offsetY)`, logical dimensions `(gridW, gridH)`, and confidence.
 *
 * Returns `detected: false` for native 1:1 pixel art, smooth non-pixel-art
 * images, and tiny buffers where a grid cannot be observed reliably.
 */
export declare function detectPixelGrid(buf: Uint8Array | Uint8ClampedArray, w: number, h: number): DetectedGrid;
/**
 * Snap a trimmed source buffer onto a previously detected pixel grid, reading
 * one clean color per logical block and trimming any newly-transparent outer
 * ring left by sub-half-opaque edge slivers.
 */
export declare function snapToDetectedGrid(buf: Uint8Array | Uint8ClampedArray, w: number, h: number, grid: DetectedGrid): SnappedSprite;
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
export declare function scaleSpriteWholeNumber(src: Uint8Array | Uint8ClampedArray, sw: number, sh: number, targetW: number, targetH: number, paddingPct?: number): WholeNumberScaleResult;
