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
/** Square brush stamp centered as closely as possible on (cx, cy). */
export declare function stampBrush(buf: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, size: number, c: RGBA, mirrorX?: boolean): void;
/** Bresenham line stamped with the brush. */
export declare function drawLinePixels(buf: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, x1: number, y1: number, size: number, c: RGBA, mirrorX?: boolean): void;
export declare function drawRectPixels(buf: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, x1: number, y1: number, size: number, c: RGBA, filled: boolean, mirrorX?: boolean): void;
/** Scanline flood fill. Returns true when any pixel changed. */
export declare function floodFill(buf: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, c: RGBA, mirrorX?: boolean): boolean;
/** Shift layer content by (dx, dy); returns a NEW buffer. */
export declare function moveBuffer(buf: Uint8ClampedArray, w: number, h: number, dx: number, dy: number): Uint8ClampedArray;
/** Zero every byte of the buffer in place (used by the "clear" op). */
export declare function clearBufferInPlace(buf: Uint8ClampedArray): void;
