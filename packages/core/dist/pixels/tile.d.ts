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
import type { TileDiff } from '../types/history';
export declare const TILE_SIZE: 16;
export declare const TILE_PIXELS: number;
export declare const TILE_BYTES: number;
export declare function tilesPerRow(width: number): number;
export declare function tilesPerColumn(height: number): number;
export declare function tileIndexAt(width: number, tx: number, ty: number): number;
/**
 * Compare two full-cel buffers tile by tile and return the dirty tiles with
 * copied before/after bytes. Both buffers must have length w*h*4.
 */
export declare function extractTileDiff(before: Uint8ClampedArray, after: Uint8ClampedArray, w: number, h: number): TileDiff[];
/**
 * Return a NEW buffer = `current` with the given tile side patched in.
 * Out-of-canvas padding is ignored, so partial edge tiles apply cleanly.
 * (New buffer, never in-place: structural history entries hold references
 * to existing buffers and must observe a stable past — copy-on-write.)
 */
export declare function applyTileDiff(current: Uint8ClampedArray, w: number, h: number, tiles: TileDiff[], side: 'before' | 'after'): Uint8ClampedArray;
