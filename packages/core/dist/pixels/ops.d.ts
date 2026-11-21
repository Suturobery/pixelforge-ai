/**
 * Deterministic pixel operations — ported verbatim from the working web
 * prototype (src/lib/pixelforge/pixels.ts). All operations write into a
 * caller-provided RGBA buffer so the editor keeps copy-on-write semantics
 * (snapshot before stroke, commit after). Kept API-identical so the Task 4
 * renderer port and Task 5a tools reuse them unchanged.
 *
 * Pure TypeScript: no DOM canvas involved.
 */
import type { RGBA } from '../types/document';
export declare function inBounds(w: number, h: number, x: number, y: number): boolean;
export declare function getPixel(buf: Uint8ClampedArray, w: number, x: number, y: number): RGBA;
/** Brush footprint: square (default) or Aseprite-style circle disc. */
export type BrushShape = 'square' | 'circle';
/** True when the offset (dx,dy) from the brush center is inside the disc.
 *  Radius s/2 minus a hair for odd sizes: size 3 paints the classic plus,
 *  size 5 the 21-px circle, even sizes full rounded squares. */
export declare function inBrushDisc(dx: number, dy: number, size: number): boolean;
/** Brush stamp centered as closely as possible on (cx, cy). */
export declare function stampBrush(buf: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, size: number, c: RGBA, mirrorX?: boolean, shape?: BrushShape): void;
/** A captured RGBA stamp (selection → brush). */
export interface CustomBrush {
    w: number;
    h: number;
    /** RGBA, length = w*h*4 */
    data: Uint8ClampedArray;
}
/** Stamp a custom brush so its CENTER lands on (cx, cy).
 *  paint=false → ERASE every pixel under the brush's opaque footprint. */
export declare function stampCustomBuffer(buf: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, brush: CustomBrush, mirrorX?: boolean, erase?: boolean): void;
/** Bresenham line stamped with the brush. */
export declare function drawLinePixels(buf: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, x1: number, y1: number, size: number, c: RGBA, mirrorX?: boolean, shape?: BrushShape): void;
export declare function drawRectPixels(buf: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, x1: number, y1: number, size: number, c: RGBA, filled: boolean, mirrorX?: boolean, shape?: BrushShape): void;
/** Scanline flood fill. Returns true when any pixel changed. */
export declare function floodFill(buf: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, c: RGBA, mirrorX?: boolean): boolean;
/**
 * Flood fill with a 2×2 Bayer dither between colors a and b (checker pattern).
 * Returns true when any pixel changed.
 */
export declare function floodFillDither(buf: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, a: RGBA, b: RGBA, mirrorX?: boolean): boolean;
export interface PixelPerfectState {
    p2: {
        x: number;
        y: number;
    } | null;
    p1: {
        x: number;
        y: number;
    };
    /** pre-stroke colors of every pixel this stroke touched */
    patch: Map<string, RGBA>;
}
/**
 * Feed one pointermove point. Caller owns state (new PixelPerfectState at
 * stroke start) and the 1px guarantee — mirrors/custom brushes stay on the
 * plain path.
 */
export declare function pixelPerfectStroke(pp: PixelPerfectState, p: {
    x: number;
    y: number;
}, buf: Uint8ClampedArray, w: number, h: number, c: RGBA, shape?: BrushShape): void;
export interface BeautifyOptions {
    /** outline color; null skips the outline pass */
    outline?: RGBA | null;
    /** shade pixels whose down/right neighbor was empty before the pass */
    shade?: boolean;
}
/**
 * Auto-outline + auto-shade in one pass (light from top-left).
 * Outline: every empty pixel touching the shape's 4-neighbors gets the
 * outline color. Shade: original opaque pixels on the bottom/right inner
 * edge darken by 28% — measured against the PRE-outline snapshot so outline
 * pixels never shade themselves.
 */
export declare function beautifyLayer(buf: Uint8ClampedArray, w: number, h: number, opts?: BeautifyOptions): boolean;
/** Shift layer content by (dx, dy); returns a NEW buffer. */
export declare function moveBuffer(buf: Uint8ClampedArray, w: number, h: number, dx: number, dy: number): Uint8ClampedArray;
/** Zero every byte of the buffer in place (used by the "clear" op). */
export declare function clearBufferInPlace(buf: Uint8ClampedArray): void;
