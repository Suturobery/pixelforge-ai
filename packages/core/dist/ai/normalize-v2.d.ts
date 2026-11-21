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
import { type Oklab } from './oklab';
export type PaletteMode = 'project' | 'auto' | 'off';
export interface Normalize2Options {
    /** exact output width in pixels (1..512) */
    targetW: number;
    /** exact output height in pixels (1..512) */
    targetH: number;
    /** flood background removal from the borders */
    removeBg: boolean;
    /** flood tolerance (squared-RGB radius applied per channel-diff, 0..255) */
    bgTolerance: number;
    /** palette strategy: project palette | auto median-cut | off */
    paletteMode: PaletteMode;
    /** project palette hex colors (used when paletteMode === 'project') */
    palette: string[];
    /** max colors for the auto median-cut mode (2..64) */
    maxColors: number;
    /** clear the AA fringe ring left around the sprite after bg removal */
    outlineCleanup: boolean;
    /**
     * 'contain' (default): preserve the trimmed subject's aspect ratio and
     * center it on the target canvas (transparent margins where the aspect
     * differs) — no anisotropic stretching. 'fill': legacy behavior — stretch
     * the trimmed bbox to exactly fill the target.
     */
    fit?: 'fill' | 'contain';
    /** margin around the content as a fraction of the smaller target side (0..0.25, default 0.04; contain fit only) */
    paddingPct?: number;
    /** binary alpha threshold (1..255, default 128) — lower keeps soft px, higher cuts ghost pixels */
    alphaThreshold?: number;
    /** source-resolution stray-component cleanup: 'off' (default) | 'normal' (≈0.01% area) | 'strong' (≈0.05% area) */
    strayCleanup?: 'off' | 'normal' | 'strong';
    /**
     * clear ENCLOSED regions that match the background color (default false).
     * Off by design: an enclosed bg-colored region can be an intentional
     * light detail (eye, highlight) — the quality report warns about residue
     * instead of silently erasing it.
     */
    enclosedResidueCleanup?: boolean;
}
export declare const DEFAULT_NORMALIZE2_OPTIONS: Normalize2Options;
export interface Normalize2Stats {
    /** bbox that survived the trim step (source pixels) */
    trim: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    /** pixels cleared by background removal (source + target passes) */
    bgRemoved: number;
    /** pixels cleared by despeckle */
    specklesRemoved: number;
    /** distinct opaque colors after quantize (or before, when mode is 'off') */
    colorsOut: number;
    /** pixels cleared by outline fringe cleanup */
    fringeRemoved: number;
    /** which palette actually constrained the output */
    paletteUsed: 'project' | 'auto' | 'off';
    /** fit actually applied ('contain' | 'fill') */
    fit: 'fill' | 'contain';
    /** opaque source components removed by stray cleanup */
    sourceStraysRemoved: number;
    /** pixels cleared by enclosed-residue cleanup */
    residueRemoved: number;
    /** the background color the pipeline matched against, as #rrggbb */
    bgColor: string;
}
export interface Normalize2Result {
    buffer: Uint8ClampedArray;
    width: number;
    height: number;
    stats: Normalize2Stats;
}
/**
 * Background color estimate: MEDIAN of the opaque border-ring pixels (the
 * outermost 1px ring). Far more robust than the prototype's 4 corner
 * patches — a subject touching a corner, or a gradient backdrop, no longer
 * poisons the estimate (corner patches see a handful of px; the ring sees
 * them all). Per-channel medians are deterministic; when the ring is fully
 * transparent the corner-patch sampler is the fallback (same contract as
 * before), and a fully empty estimate falls back to white.
 */
export declare function sampleBorderColorMedian(buf: Uint8Array | Uint8ClampedArray, w: number, h: number): [number, number, number];
/**
 * Trim to the content bounding box: the smallest rectangle that contains all
 * pixels that differ from a "background" definition — fully transparent px
 * plus (when removeBg is on) px within tolerance of the sampled border color.
 * A fully empty or fully uniform image returns the full rect (no trim).
 */
export declare function trimContentBBox(buf: Uint8Array | Uint8ClampedArray, w: number, h: number, removeBg: boolean, bgTolerance: number): {
    x: number;
    y: number;
    w: number;
    h: number;
};
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
export declare function dominantColorDownscale(src: Uint8Array | Uint8ClampedArray, sw: number, sh: number, targetW: number, targetH: number): Uint8ClampedArray;
/** Binary alpha: < threshold → 0, everything else → 255. In place. */
export declare function applyAlphaThreshold(buf: Uint8ClampedArray, threshold?: number): void;
/**
 * Despeckle: clear isolated opaque pixels — opaque px whose 4 neighbors are
 * all transparent (border counts as transparent). Single deterministic pass;
 * removals do not cascade within the pass.
 */
export declare function despeckleIsolated(buf: Uint8ClampedArray, w: number, h: number): number;
/** Average the 4 corner patches of the image (prototype border sampler). */
export declare function sampleBorderColor(buf: Uint8Array | Uint8ClampedArray, w: number, h: number): [number, number, number];
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
export declare function floodRemoveBackground(buf: Uint8ClampedArray, w: number, h: number, tolerance?: number): number;
/**
 * Flood background removal against an EXPLICIT background color (v2.1).
 * Clears every border-connected pixel whose color sits within tolerance of
 * `bgColor`. Pixels already transparent (alpha < 128) act as walls — their
 * RGB is meaningless and must not seed or extend the flood. Interior
 * same-colored pixels survive. Deterministic. In place.
 */
export declare function floodRemoveBackgroundWithColor(buf: Uint8ClampedArray, w: number, h: number, bgColor: [number, number, number], tolerance?: number): number;
/**
 * Clear small stray opaque components (4-connected) whose pixel count is
 * below `minPx` — source-resolution dust and noise that would otherwise
 * inflate the trim bbox (shrinking the real subject) or survive into the
 * output as isolated dots. The LARGEST component (the subject) is never
 * touched, and components at/above minPx always survive. Deterministic
 * single pass. Returns the number of cleared PIXELS. In place.
 */
export declare function removeStrayComponents(buf: Uint8ClampedArray, w: number, h: number, minPx: number): number;
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
export declare function removeEnclosedBgResidue(buf: Uint8ClampedArray, w: number, h: number, bgColor: [number, number, number], tolerance?: number): number;
/**
 * Median-cut palette extraction over the opaque pixels (auto mode).
 * Deterministic port of the prototype's quantizer: RGB boxes split at the
 * weighted median along their widest channel until `maxColors` boxes exist.
 */
export declare function medianCutPalette(buf: Uint8Array | Uint8ClampedArray, maxColors: number): Array<[number, number, number]>;
/**
 * Palette harvest: extract the best `maxColors` from any RGBA image
 * (median cut over opaque pixels) as hex strings, sorted dark → light.
 * The one-call "steal this image's colors" helper.
 */
export declare function harvestPalette(buf: Uint8Array | Uint8ClampedArray, maxColors?: number): string[];
/**
 * OKLab quantize: map every opaque pixel to its nearest palette color in
 * OKLab space (perceptual — §3.3 step 5). Alpha is preserved. Deterministic
 * tie-break: lowest palette index wins. In place.
 */
export declare function quantizeToPalette(buf: Uint8ClampedArray, paletteRgb: Array<[number, number, number]>): void;
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
export declare function cleanupOutlineFringe(buf: Uint8ClampedArray, w: number, h: number, tolerance?: number): number;
/**
 * Fringe cleanup against an EXPLICIT background color (the border color
 * sampled BEFORE flood removal) — this is the deterministic variant the
 * orchestrator uses. Returns cleared pixel count. In place.
 */
export declare function cleanupOutlineFringeWithColor(buf: Uint8ClampedArray, w: number, h: number, bgColor: [number, number, number], tolerance?: number): number;
/**
 * Full normalize-v2 pipeline (§3.3 + v2.1 quality audit). Steps run in the
 * documented order; the source buffer is never mutated. Exact output size is
 * guaranteed (targetW×targetH); transparency is preserved end-to-end.
 */
export declare function normalizeV2(src: Uint8Array | Uint8ClampedArray, srcW: number, srcH: number, opts: Normalize2Options): Normalize2Result;
/**
 * Contain-fit NEAREST-NEIGHBOR downscale — the PROTOTYPE pipeline, kept
 * exclusively for the §3.3 A/B benchmark and the legacy fallback path.
 * Deterministic; returns a fresh buffer of exactly targetW×targetH.
 */
export declare function nearestNeighborContain(src: Uint8Array | Uint8ClampedArray, sw: number, sh: number, targetW: number, targetH: number): Uint8ClampedArray;
/** OKLab helper re-export for tests. */
export type { Oklab };
/**
 * Center a normalized sprite buffer onto a canvas-sized transparent buffer
 * (pixel-perfect placement, NO resampling — pixels stay 1:1). Used by the
 * AI import paths (panel + MCP accept_candidate) so a candidate normalized
 * at any sprite size lands cleanly on the canvas cel. When the sizes already
 * match, the input is returned unchanged.
 */
export declare function fitBufferToCanvas(buffer: Uint8ClampedArray, w: number, h: number, canvasW: number, canvasH: number): Uint8ClampedArray;
