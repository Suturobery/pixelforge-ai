"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeEllipseBox = normalizeEllipseBox;
exports.ellipseOutlinePoints = ellipseOutlinePoints;
exports.drawEllipsePixels = drawEllipsePixels;
const ops_1 = require("./ops");
/** Normalize any two drag endpoints into an inclusive integer bbox. */
function normalizeEllipseBox(x0, y0, x1, y1) {
    return {
        left: Math.min(x0, x1),
        top: Math.min(y0, y1),
        right: Math.max(x0, x1),
        bottom: Math.max(y0, y1),
    };
}
/**
 * Outline pixel set of the ellipse inscribed in the INCLUSIVE integer box
 * [x0..x1] × [y0..y1] (coordinates may be unsorted; NOT clipped — the caller
 * clips first or filters with inBounds). Deterministic content + order.
 */
function ellipseOutlinePoints(x0, y0, x1, y1) {
    const { left, top, right, bottom } = normalizeEllipseBox(x0, y0, x1, y1);
    const w = right - left + 1;
    const h = bottom - top + 1;
    const out = [];
    const plot = (bx, by, mirrorXOnly) => {
        const x = left + bx;
        const y = top + by;
        out.push({ x, y });
        if (mirrorXOnly)
            out.push({ x: left + (w - 1 - bx), y });
    };
    // Degenerate boxes: straight lines / dot (Asepite-style flat ellipses).
    if (w === 1 || h === 1) {
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++)
                out.push({ x: left + x, y: top + y });
        }
        return out;
    }
    const A = w - 1; // semi-axis in doubled units (≥ 1 here)
    const B = h - 1;
    const F = (u, ym) => B * B * u * u + A * A * ym * ym - A * A * B * B;
    const uStart = w % 2 === 0 ? 1 : 0; // minimal |u| pixel column
    const uEnd = A; // rightmost column (curve touches ym = 0 there)
    const ymEnd = h % 2 === 0 ? 1 : 0; // lowest row of the TOP half
    const px = (u) => Math.floor((u + w - 1) / 2);
    const py = (ym) => Math.floor((B - ym) / 2);
    let u = uStart;
    let ym = B; // top row (curve tops out at ym = B for u = uStart)
    plot(px(u), 0, true); // top row: mirror x only (y-mirror handled below)
    // Region 1 — x-major (slope ≤ 1): decide row via midpoint F(u, ym-1).
    while (B * B * u <= A * A * ym && u < uEnd) {
        u += 2;
        if (F(u, ym - 1) > 0)
            ym -= 2;
        plot(px(u), py(ym), true);
    }
    // Region 2 — y-major (slope > 1): decide column via midpoint F(u+1, ym).
    while (ym > ymEnd) {
        ym -= 2;
        if (u < uEnd && F(u + 1, ym) < 0)
            u += 2;
        plot(px(u), py(ym), true);
    }
    // Safety net: never leave the rightmost column unvisited.
    if (u < uEnd)
        plot(px(uEnd), py(ym), true);
    // y-mirror of every plotted pixel completes the bottom half.
    const topHalf = [...out];
    for (const p of topHalf) {
        if (p.y !== top + (h - 1 - (p.y - top)))
            out.push({ x: p.x, y: top + (h - 1 - (p.y - top)) });
    }
    return out;
}
/**
 * Draw an ellipse into an RGBA buffer. Bbox endpoints are normalized and
 * clipped to the canvas; a box entirely outside plots nothing. Outline mode
 * stamps every ring pixel with the brush (`size`, mirrored via `mirrorX`
 * like the rect/line tools). Filled mode scanline-fills the ring interior
 * with single pixels (the brush does not thicken the interior). Returns the
 * number of distinct pre-mirror plot points that landed in bounds (≥ 0).
 */
function drawEllipsePixels(buf, W, H, x0, y0, x1, y1, size, color, filled, mirrorX = false) {
    const { left, top, right, bottom } = normalizeEllipseBox(x0, y0, x1, y1);
    const l = Math.max(0, left);
    const t = Math.max(0, top);
    const r = Math.min(W - 1, right);
    const b = Math.min(H - 1, bottom);
    if (l > r || t > b)
        return 0;
    const points = ellipseOutlinePoints(l, t, r, b);
    if (filled) {
        const min = new Map();
        const max = new Map();
        for (const p of points) {
            if (!(0, ops_1.inBounds)(W, H, p.x, p.y))
                continue;
            const lo = min.get(p.y);
            if (lo === undefined || p.x < lo)
                min.set(p.y, p.x);
            const hi = max.get(p.y);
            if (hi === undefined || p.x > hi)
                max.set(p.y, p.x);
        }
        let count = 0;
        for (const [y, xa] of min) {
            const xb = max.get(y);
            for (let x = xa; x <= xb; x++) {
                (0, ops_1.stampBrush)(buf, W, H, x, y, 1, color, mirrorX);
                count++;
            }
        }
        return count;
    }
    const touched = new Set();
    for (const p of points) {
        if (!(0, ops_1.inBounds)(W, H, p.x, p.y))
            continue;
        touched.add(p.y * W + p.x);
    }
    for (const idx of touched) {
        (0, ops_1.stampBrush)(buf, W, H, idx % W, Math.floor(idx / W), size, color, mirrorX);
    }
    return touched.size;
}
