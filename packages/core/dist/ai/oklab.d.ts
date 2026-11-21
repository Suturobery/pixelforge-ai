/**
 * @pixelforge/core — OKLab color space (v3.1 Plan §3.3 step 5).
 *
 * Pure sRGB ⇄ OKLab conversion used by normalize-v2 palette quantization:
 * OKLab's perceptual uniformity makes nearest-palette-color mapping visibly
 * better than raw RGB distance on pixel art (no hue shifts on blues/skins).
 *
 * Deterministic: plain float math, no randomness, no Date/DOM.
 * Reference: Björn Ottosson's OKLab (public domain formulations).
 */
/** sRGB 0..255 → linear-light 0..1 (exact sRGB EOTF, not the fast gamma-2 approximation). */
export declare function srgbToLinear(c: number): number;
/** linear-light 0..1 → sRGB 0..255 (rounded). */
export declare function linearToSrgb(v: number): number;
export interface Oklab {
    /** lightness 0..1 */
    L: number;
    a: number;
    b: number;
}
/** sRGB (0..255 channels, alpha ignored) → OKLab. */
export declare function rgbToOklab(r: number, g: number, b: number): Oklab;
/** OKLab → sRGB 0..255 channels (rounded). */
export declare function oklabToRgb(o: Oklab): [number, number, number];
/** Squared perceptual distance between two OKLab colors (comparable ordering to ΔE). */
export declare function oklabDistance2(a: Oklab, b: Oklab): number;
/** Squared RGB distance (0..255 channels) — used for tie-breaks, not perception. */
export declare function rgbDistance2(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number;
/**
 * Parse #rrggbb / #rgb / #rrggbbaa hex into 0..255 channels.
 * Returns null for anything that is not a valid hex color (callers decide).
 */
export declare function parseHexColor(hex: string): [number, number, number] | null;
