/**
 * History model (v3.1 §2.5): typed command history with
 *  - pixel edits  → 16×16 tile diffs (dirty tiles with before/after bytes)
 *  - structural edits → shallow document snapshots (copy-on-write buffers)
 *  - transactions → composite entries (children undone/redone in order)
 * Memory is capped by a configurable budget (default 64 MB, 16–512 range);
 * oldest entries are evicted when over budget.
 */

import type { Project } from './document';
import type { CommandOrigin } from './commands';
import type { PixelHistoryData } from './commands';

/** One dirty 16×16 tile. Buffers are fixed-size (TILE_BYTES), zero-padded
 * outside the canvas — see pixels/tile.ts. */
export interface TileDiff {
  /** ty * tilesPerRow + tx where tilesPerRow = ceil(width / 16). */
  index: number;
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
}

export type HistoryEntry =
  | {
      kind: 'pixels';
      id: string;
      label: string;
      origin: CommandOrigin;
      timestamp: number;
      /** Estimated memory cost in bytes (for the budget). */
      bytes: number;
      data: PixelHistoryData;
    }
  | {
      kind: 'structure';
      id: string;
      label: string;
      origin: CommandOrigin;
      timestamp: number;
      bytes: number;
      /** Shallow snapshots — buffers are shared by reference (copy-on-write). */
      before: Project;
      after: Project;
    }
  | {
      kind: 'composite';
      id: string;
      label: string;
      origin: CommandOrigin;
      timestamp: number;
      bytes: number;
      children: HistoryEntry[];
    };

export interface HistoryStats {
  undoDepth: number;
  redoDepth: number;
  /** Estimated bytes currently held by past + future entries. */
  bytes: number;
  budgetBytes: number;
  /** bytes / budgetBytes (can exceed 1 only for a single oversized entry). */
  usage: number;
  /** Total entries evicted since the engine was created (oldest first). */
  evictedCount: number;
  /** undoDepth breakdown by origin — provenance of the current history. */
  byOrigin: Record<CommandOrigin, number>;
}
