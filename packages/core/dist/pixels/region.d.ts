/**
 * Region-scoped pixel transforms (v3.1 §2.1 "Transform ops — flip H/V +
 * rotate 90° on layer/cel/selection"). All operations are integer-exact,
 * interpolation-free, alpha-preserving, and deterministic.
 *
 * Rect convention: {x, y, w, h} in canvas coordinates, inclusive-negative
 * (a rect covers w×h pixels starting at (x, y)). Every helper clamps the
 * rect to the canvas; empty/fully-outside rects are no-ops.
 *
 * Rotation anchoring: a w×h region rotated 90° occupies an h×w footprint
 * anchored at the SAME top-left corner (deterministic; for square regions —
 * the common case — this is the familiar in-place rotation). Content that
 * lands outside the canvas is dropped, content left behind by the new
 * footprint is cleared. Whole-cel transforms pass the full-canvas rect.
 */
export interface PixelRect {
    x: number;
    y: number;
    w: number;
    h: number;
}
/** Clamp a rect to the canvas; returns null when nothing remains. */
export declare function clampRect(rect: PixelRect, W: number, H: number): PixelRect | null;
/** Mirror a rect region horizontally, in place. */
export declare function flipRegionHInPlace(buf: Uint8ClampedArray, W: number, H: number, rect: PixelRect): void;
/** Mirror a rect region vertically, in place. */
export declare function flipRegionVInPlace(buf: Uint8ClampedArray, W: number, H: number, rect: PixelRect): void;
/**
 * Rotate the rect region 90° clockwise, in place. The content occupies an
 * h×w footprint anchored at the same top-left corner; pixels rotated outside
 * the canvas are dropped. Returns the destination footprint (clipped).
 */
export declare function rotateRegionCWInPlace(buf: Uint8ClampedArray, W: number, H: number, rect: PixelRect): PixelRect;
/** Rotate the rect region 90° counter-clockwise, in place. Same anchoring. */
export declare function rotateRegionCCWInPlace(buf: Uint8ClampedArray, W: number, H: number, rect: PixelRect): PixelRect;
/** Copy a rect region out (alpha verbatim — transparency preserved). */
export declare function extractRegion(buf: Uint8ClampedArray, W: number, H: number, rect: PixelRect): Uint8ClampedArray;
/** Zero a rect region in place (transparent). */
export declare function clearRegionInPlace(buf: Uint8ClampedArray, W: number, H: number, rect: PixelRect): void;
/**
 * Overwrite `buf` with `src` (rw×rh RGBA) anchored at (dx, dy). Pixels
 * outside the canvas are clipped; alpha is copied verbatim (pasting
 * transparent pixels punches transparency — Aseprite paste semantics).
 */
export declare function pasteRegionInPlace(buf: Uint8ClampedArray, W: number, H: number, src: Uint8ClampedArray, rw: number, rh: number, dx: number, dy: number): void;
