"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.srgbToLinear = srgbToLinear;
exports.linearToSrgb = linearToSrgb;
exports.rgbToOklab = rgbToOklab;
exports.oklabToRgb = oklabToRgb;
exports.oklabDistance2 = oklabDistance2;
exports.rgbDistance2 = rgbDistance2;
exports.parseHexColor = parseHexColor;
/** sRGB 0..255 → linear-light 0..1 (exact sRGB EOTF, not the fast gamma-2 approximation). */
function srgbToLinear(c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
/** linear-light 0..1 → sRGB 0..255 (rounded). */
function linearToSrgb(v) {
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, s)) * 255);
}
/** sRGB (0..255 channels, alpha ignored) → OKLab. */
function rgbToOklab(r, g, b) {
    const lr = srgbToLinear(r);
    const lg = srgbToLinear(g);
    const lb = srgbToLinear(b);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return {
        L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    };
}
/** OKLab → sRGB 0..255 channels (rounded). */
function oklabToRgb(o) {
    const l_ = o.L + 0.3963377774 * o.a + 0.2158037573 * o.b;
    const m_ = o.L - 0.1055613458 * o.a - 0.0638541728 * o.b;
    const s_ = o.L - 0.0894841775 * o.a - 1.291485548 * o.b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
    return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}
/** Squared perceptual distance between two OKLab colors (comparable ordering to ΔE). */
function oklabDistance2(a, b) {
    const dl = a.L - b.L;
    const da = a.a - b.a;
    const db = a.b - b.b;
    return dl * dl + da * da + db * db;
}
/** Squared RGB distance (0..255 channels) — used for tie-breaks, not perception. */
function rgbDistance2(r1, g1, b1, r2, g2, b2) {
    const dr = r1 - r2;
    const dg = g1 - g2;
    const db = b1 - b2;
    return dr * dr + dg * dg + db * db;
}
/**
 * Parse #rrggbb / #rgb / #rrggbbaa hex into 0..255 channels.
 * Returns null for anything that is not a valid hex color (callers decide).
 */
function parseHexColor(hex) {
    if (typeof hex !== 'string')
        return null;
    let h = hex.trim().replace(/^#/, '');
    if (h.length === 3) {
        if (!/^[0-9a-fA-F]{3}$/.test(h))
            return null;
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    if (h.length === 8)
        h = h.slice(0, 6);
    if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h))
        return null;
    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
    ];
}
