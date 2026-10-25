/**
 * Pixel-perfect ellipse rasterization (v3.1 §2.1 "Ellipse — midpoint
 * algorithm, filled/unfilled"). Deterministic: pure integer arithmetic,
 * no floating-point plot decisions, identical output on every platform.
 *
 * Algorithm — two-region midpoint walk in DOUBLED coordinates:
 *   • Pixel (x, y) maps to doubled offset u = 2x+1-w (w = box width), so
 *     adjacent pixel centers are 2 units apart and the midpoint between two
 *     candidate centers is an INTEGER even when the ellipse center sits
 *     between pixels (even-sized boxes). That is what keeps even sizes
 *     symmetric — the classic integer-center midpoint walk cannot.
 *   • Semi-axes (doubled units): A = w-1, B = h-1 — the curve passes through
 *     the outer pixel centers (A degenerates to 0 for w=1 → straight line).
 *   • One half arc (top → right → equator) is walked; every plotted pixel is
 *     mirrored about the box center (x for the half arc, y for the top rows),
 *     so the outline is symmetric by construction. Region 1 steps columns
 *     (x-major) while the slope ≤ 1, deciding the row via the midpoint sign
 *     of F(u, ym-1); region 2 steps rows (y-major) deciding the column via
 *     F(u+1, ym). F = B²u² + A²ym² - A²B² (exact in IEEE doubles for
 *     canvas sizes ≤ 256).
 *   • Filled mode scanline-fills each row between the outline extremes
 *     (no holes by construction, outline ⊆ fill).
 */
import type { RGBA } from '../types/document';
export interface EllipsePoint {
    x: number;
    y: number;
}
/** Normalize any two drag endpoints into an inclusive integer bbox. */
export declare function normalizeEllipseBox(x0: number, y0: number, x1: number, y1: number): {
    left: number;
    top: number;
    right: number;
    bottom: number;
};
/**
 * Outline pixel set of the ellipse inscribed in the INCLUSIVE integer box
 * [x0..x1] × [y0..y1] (coordinates may be unsorted; NOT clipped — the caller
 * clips first or filters with inBounds). Deterministic content + order.
 */
export declare function ellipseOutlinePoints(x0: number, y0: number, x1: number, y1: number): EllipsePoint[];
/**
 * Draw an ellipse into an RGBA buffer. Bbox endpoints are normalized and
 * clipped to the canvas; a box entirely outside plots nothing. Outline mode
 * stamps every ring pixel with the brush (`size`, mirrored via `mirrorX`
 * like the rect/line tools). Filled mode scanline-fills the ring interior
 * with single pixels (the brush does not thicken the interior). Returns the
 * number of distinct pre-mirror plot points that landed in bounds (≥ 0).
 */
export declare function drawEllipsePixels(buf: Uint8ClampedArray, W: number, H: number, x0: number, y0: number, x1: number, y1: number, size: number, color: RGBA, filled: boolean, mirrorX?: boolean): number;
