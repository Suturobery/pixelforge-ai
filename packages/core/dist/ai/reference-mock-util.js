"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.snapToPaletteHex = snapToPaletteHex;
/**
 * Shared mock helper: snap a #rrggbb hex to the nearest palette entry
 * (weighted RGB distance, stable tie-break by palette order).
 */
function snapToPaletteHex(hex, palette) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    let best = palette[0] ?? hex;
    let bestDist = Infinity;
    for (const entry of palette) {
        const raw = entry.replace('#', '');
        const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw.slice(0, 6);
        const r2 = parseInt(full.slice(0, 2), 16);
        const g2 = parseInt(full.slice(2, 4), 16);
        const b2 = parseInt(full.slice(4, 6), 16);
        const dist = 2 * (r - r2) * (r - r2) + 4 * (g - g2) * (g - g2) + 3 * (b - b2) * (b - b2);
        if (dist < bestDist) {
            bestDist = dist;
            best = entry;
        }
    }
    return best;
}
