/**
 * PixelForge AI — Pure Tileset Slicer, Tile Stamp Transforms & Level Mockup
 * compositor (Phase 3, DOM-free).
 *
 * Slices any RGBA buffer into a deterministic tile grid, applies crisp
 * nearest-neighbor rotation (0/90/180/270) + H/V flips, stamps tiles onto
 * target buffers, and composes animated multi-frame test rooms / level mockups.
 */

export const TILE_SIZES = [8, 16, 24, 32, 48, 64] as const;
export type TileSize = (typeof TILE_SIZES)[number];

export type TileRotation = 0 | 90 | 180 | 270;

export interface TileTransform {
  rotation: TileRotation;
  flipH: boolean;
  flipV: boolean;
}

export interface SlicedTile {
  index: number;
  col: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  buffer: Uint8ClampedArray;
  empty: boolean;
}

export interface SlicedTileset {
  tileSize: number;
  cols: number;
  rows: number;
  tiles: SlicedTile[];
  nonEmptyCount: number;
}

export interface LevelMockupCell {
  /** 0-based tile index into the source tileset (row * cols + col) */
  tileIndex: number;
  rotation?: TileRotation;
  flipH?: boolean;
  flipV?: boolean;
}

export const IDENTITY_TILE_TRANSFORM: TileTransform = {
  rotation: 0,
  flipH: false,
  flipV: false,
};

/** Rotate a TileRotation clockwise by 90 degrees. */
export function rotateTileCW(rot: TileRotation): TileRotation {
  return (((rot + 90) % 360) as TileRotation);
}

/**
 * Slice an RGBA source buffer into a grid of square `tileSize × tileSize` tiles.
 * Partial edge tiles smaller than `tileSize` are ignored so every tile is exact.
 */
export function extractTilesetGrid(
  src: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  tileSize: number,
): SlicedTileset {
  const t = Math.max(1, Math.floor(tileSize));
  const cols = Math.floor(width / t);
  const rows = Math.floor(height / t);
  const tiles: SlicedTile[] = [];
  let nonEmptyCount = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const buf = new Uint8ClampedArray(t * t * 4);
      const sx0 = col * t;
      const sy0 = row * t;
      let hasOpaque = false;
      for (let py = 0; py < t; py++) {
        const srcRowStart = ((sy0 + py) * width + sx0) * 4;
        const dstRowStart = py * t * 4;
        for (let px = 0; px < t; px++) {
          const si = srcRowStart + px * 4;
          const di = dstRowStart + px * 4;
          const a = src[si + 3] ?? 0;
          if (a > 0) hasOpaque = true;
          buf[di] = src[si] ?? 0;
          buf[di + 1] = src[si + 1] ?? 0;
          buf[di + 2] = src[si + 2] ?? 0;
          buf[di + 3] = a;
        }
      }
      if (hasOpaque) nonEmptyCount++;
      tiles.push({
        index: row * cols + col,
        col,
        row,
        x: sx0,
        y: sy0,
        width: t,
        height: t,
        buffer: buf,
        empty: !hasOpaque,
      });
    }
  }

  return { tileSize: t, cols, rows, tiles, nonEmptyCount };
}

/**
 * Apply crisp nearest-neighbor flip + clockwise rotation to a square tile buffer.
 * Flip is applied first in local tile space, then clockwise rotation (0/90/180/270).
 */
export function transformTileBuffer(
  src: Uint8Array | Uint8ClampedArray,
  tileSize: number,
  transform: Partial<TileTransform>,
): Uint8ClampedArray {
  const t = Math.max(1, Math.floor(tileSize));
  const rot: TileRotation = transform.rotation ?? 0;
  const flipH = Boolean(transform.flipH);
  const flipV = Boolean(transform.flipV);
  const out = new Uint8ClampedArray(t * t * 4);

  if (rot === 0 && !flipH && !flipV) {
    out.set(src.subarray(0, t * t * 4));
    return out;
  }

  for (let sy = 0; sy < t; sy++) {
    for (let sx = 0; sx < t; sx++) {
      const fx = flipH ? t - 1 - sx : sx;
      const fy = flipV ? t - 1 - sy : sy;
      let dx: number;
      let dy: number;
      if (rot === 90) {
        dx = t - 1 - fy;
        dy = fx;
      } else if (rot === 180) {
        dx = t - 1 - fx;
        dy = t - 1 - fy;
      } else if (rot === 270) {
        dx = fy;
        dy = t - 1 - fx;
      } else {
        dx = fx;
        dy = fy;
      }
      const si = (sy * t + sx) * 4;
      const di = (dy * t + dx) * 4;
      out[di] = src[si] ?? 0;
      out[di + 1] = src[si + 1] ?? 0;
      out[di + 2] = src[si + 2] ?? 0;
      out[di + 3] = src[si + 3] ?? 0;
    }
  }

  return out;
}

/**
 * Stamp a `tileSize × tileSize` tile buffer onto `dest` at pixel origin `(ox, oy)`.
 * - `mode: 'over'` (default): preserves existing dest pixels where tile is transparent.
 * - `mode: 'replace'`: replaces the entire `tileSize × tileSize` cell (used for level rooms / clean tile overwrite).
 * Returns true if at least one byte changed.
 */
export function stampTileOntoBuffer(
  dest: Uint8ClampedArray,
  destW: number,
  destH: number,
  tileBuf: Uint8Array | Uint8ClampedArray,
  tileSize: number,
  ox: number,
  oy: number,
  opts: { mode?: 'over' | 'replace' } = {},
): boolean {
  const t = Math.max(1, Math.floor(tileSize));
  const mode = opts.mode ?? 'over';
  let changed = false;

  for (let py = 0; py < t; py++) {
    const ty = oy + py;
    if (ty < 0 || ty >= destH) continue;
    for (let px = 0; px < t; px++) {
      const tx = ox + px;
      if (tx < 0 || tx >= destW) continue;
      const si = (py * t + px) * 4;
      const sa = tileBuf[si + 3] ?? 0;
      const di = (ty * destW + tx) * 4;
      if (mode === 'over' && sa === 0) continue;

      const nr = tileBuf[si] ?? 0;
      const ng = tileBuf[si + 1] ?? 0;
      const nb = tileBuf[si + 2] ?? 0;
      const na = sa;

      if (mode === 'replace' || sa === 255 || dest[di + 3] === 0) {
        if (
          dest[di] !== nr ||
          dest[di + 1] !== ng ||
          dest[di + 2] !== nb ||
          dest[di + 3] !== na
        ) {
          dest[di] = nr;
          dest[di + 1] = ng;
          dest[di + 2] = nb;
          dest[di + 3] = na;
          changed = true;
        }
      } else {
        const a = sa / 255;
        const da = (dest[di + 3] ?? 0) / 255;
        const outA = a + da * (1 - a);
        const rr = Math.round((nr * a + (dest[di] ?? 0) * da * (1 - a)) / outA);
        const rg = Math.round((ng * a + (dest[di + 1] ?? 0) * da * (1 - a)) / outA);
        const rb = Math.round((nb * a + (dest[di + 2] ?? 0) * da * (1 - a)) / outA);
        const ra = Math.round(outA * 255);
        if (dest[di] !== rr || dest[di + 1] !== rg || dest[di + 2] !== rb || dest[di + 3] !== ra) {
          dest[di] = rr;
          dest[di + 1] = rg;
          dest[di + 2] = rb;
          dest[di + 3] = ra;
          changed = true;
        }
      }
    }
  }

  return changed;
}

/**
 * Compose a live Level Mockup / Test Room RGBA buffer from a Ground cell layer
 * plus an optional alpha-composited Overlay/Props cell layer, sampling one or
 * more frames of a tileset clip so animated tiles play cleanly in sync.
 */
export function composeLevelMockup(params: {
  tilesetFrames: readonly (Uint8Array | Uint8ClampedArray)[];
  srcW: number;
  srcH: number;
  tileSize: number;
  mapCols: number;
  mapRows: number;
  cells: readonly (LevelMockupCell | null)[];
  /** Optional second layer (props, torches, trees, furniture) alpha-composited over Ground */
  overlayCells?: readonly (LevelMockupCell | null)[];
  frameIndex?: number;
}): { width: number; height: number; buffer: Uint8ClampedArray } {
  const t = Math.max(1, Math.floor(params.tileSize));
  const mapCols = Math.max(1, Math.floor(params.mapCols));
  const mapRows = Math.max(1, Math.floor(params.mapRows));
  const outW = mapCols * t;
  const outH = mapRows * t;
  const buffer = new Uint8ClampedArray(outW * outH * 4);

  if (params.tilesetFrames.length === 0) {
    return { width: outW, height: outH, buffer };
  }

  const fi = ((Math.floor(params.frameIndex ?? 0) % params.tilesetFrames.length) + params.tilesetFrames.length) % params.tilesetFrames.length;
  const srcFrame = params.tilesetFrames[fi]!;
  const sliced = extractTilesetGrid(srcFrame, params.srcW, params.srcH, t);
  const transformedCache = new Map<string, Uint8ClampedArray>();

  const stampLayer = (layerCells: readonly (LevelMockupCell | null)[], mode: 'replace' | 'over') => {
    for (let row = 0; row < mapRows; row++) {
      for (let col = 0; col < mapCols; col++) {
        const cell = layerCells[row * mapCols + col];
        if (!cell) continue;
        const tile = sliced.tiles[cell.tileIndex];
        if (!tile) continue;

        const rot: TileRotation = cell.rotation ?? 0;
        const fh = Boolean(cell.flipH);
        const fv = Boolean(cell.flipV);
        const key = `${cell.tileIndex}:${rot}:${fh ? 1 : 0}:${fv ? 1 : 0}`;
        let transformed = transformedCache.get(key);
        if (!transformed) {
          transformed = transformTileBuffer(tile.buffer, t, { rotation: rot, flipH: fh, flipV: fv });
          transformedCache.set(key, transformed);
        }

        stampTileOntoBuffer(buffer, outW, outH, transformed, t, col * t, row * t, { mode });
      }
    }
  };

  stampLayer(params.cells, 'replace');
  if (params.overlayCells && params.overlayCells.length > 0) {
    stampLayer(params.overlayCells, 'over');
  }

  return { width: outW, height: outH, buffer };
}
