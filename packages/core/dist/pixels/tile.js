"use strict";
/**
 * 16×16 tile diffs (v3.1 §2.5 / §9.2): pixel edits are recorded as dirty
 * tiles with before/after bytes instead of full-buffer snapshots.
 *
 * A typical 32×32 stroke touches ≤ 4 tiles ≈ 1–8 KB of history (each tile
 * stores 1024 B before + 1024 B after), versus 4 KB×2 full buffers in the
 * prototype model — and the ratio improves with canvas size, which is what
 * makes the ≥ 250-undo guarantee (C21) at a 64 MB budget trivially met.
 *
 * Tiles are laid out in a grid of ceil(w/16) × ceil(h/16). Edge tiles are
 * clipped to the canvas: their stored bytes are zero-padded outside the
 * canvas bounds, and apply() writes only in-bounds pixels.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TILE_BYTES = exports.TILE_PIXELS = exports.TILE_SIZE = void 0;
exports.tilesPerRow = tilesPerRow;
exports.tilesPerColumn = tilesPerColumn;
exports.tileIndexAt = tileIndexAt;
exports.extractTileDiff = extractTileDiff;
exports.applyTileDiff = applyTileDiff;
exports.TILE_SIZE = 16;
exports.TILE_PIXELS = exports.TILE_SIZE * exports.TILE_SIZE; // 256
exports.TILE_BYTES = exports.TILE_PIXELS * 4; // 1024 bytes per stored side
function tilesPerRow(width) {
    return Math.max(1, Math.ceil(width / exports.TILE_SIZE));
}
function tilesPerColumn(height) {
    return Math.max(1, Math.ceil(height / exports.TILE_SIZE));
}
function tileIndexAt(width, tx, ty) {
    return ty * tilesPerRow(width) + tx;
}
/**
 * Compare two full-cel buffers tile by tile and return the dirty tiles with
 * copied before/after bytes. Both buffers must have length w*h*4.
 */
function extractTileDiff(before, after, w, h) {
    const cols = tilesPerRow(w);
    const rows = tilesPerColumn(h);
    const dirty = [];
    for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
            const x0 = tx * exports.TILE_SIZE;
            const y0 = ty * exports.TILE_SIZE;
            const x1 = Math.min(x0 + exports.TILE_SIZE, w);
            const y1 = Math.min(y0 + exports.TILE_SIZE, h);
            let changed = false;
            scan: for (let y = y0; y < y1; y++) {
                let i = (y * w + x0) * 4;
                for (let x = x0; x < x1; x++, i += 4) {
                    if (before[i] !== after[i] ||
                        before[i + 1] !== after[i + 1] ||
                        before[i + 2] !== after[i + 2] ||
                        before[i + 3] !== after[i + 3]) {
                        changed = true;
                        break scan;
                    }
                }
            }
            if (!changed)
                continue;
            dirty.push({
                index: ty * cols + tx,
                before: copyTile(before, w, x0, y0, x1, y1),
                after: copyTile(after, w, x0, y0, x1, y1),
            });
        }
    }
    return dirty;
}
function copyTile(src, w, x0, y0, x1, y1) {
    const out = new Uint8ClampedArray(exports.TILE_BYTES);
    for (let y = y0; y < y1; y++) {
        const sRow = (y * w + x0) * 4;
        const tRow = ((y - y0) * exports.TILE_SIZE) * 4;
        for (let x = x0; x < x1; x++) {
            const si = sRow + (x - x0) * 4;
            const ti = tRow + (x - x0) * 4;
            out[ti] = src[si];
            out[ti + 1] = src[si + 1];
            out[ti + 2] = src[si + 2];
            out[ti + 3] = src[si + 3];
        }
    }
    return out;
}
/**
 * Return a NEW buffer = `current` with the given tile side patched in.
 * Out-of-canvas padding is ignored, so partial edge tiles apply cleanly.
 * (New buffer, never in-place: structural history entries hold references
 * to existing buffers and must observe a stable past — copy-on-write.)
 */
function applyTileDiff(current, w, h, tiles, side) {
    const out = new Uint8ClampedArray(current);
    const cols = tilesPerRow(w);
    for (const tile of tiles) {
        const tx = tile.index % cols;
        const ty = (tile.index - tx) / cols;
        const x0 = tx * exports.TILE_SIZE;
        const y0 = ty * exports.TILE_SIZE;
        const x1 = Math.min(x0 + exports.TILE_SIZE, w);
        const y1 = Math.min(y0 + exports.TILE_SIZE, h);
        const src = side === 'before' ? tile.before : tile.after;
        for (let y = y0; y < y1; y++) {
            const sRow = ((y - y0) * exports.TILE_SIZE) * 4;
            const dRow = (y * w + x0) * 4;
            for (let x = x0; x < x1; x++) {
                const si = sRow + (x - x0) * 4;
                const di = dRow + (x - x0) * 4;
                out[di] = src[si];
                out[di + 1] = src[si + 1];
                out[di + 2] = src[si + 2];
                out[di + 3] = src[si + 3];
            }
        }
    }
    return out;
}
