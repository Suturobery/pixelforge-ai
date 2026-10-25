/**
 * History engine (v3.1 §2.5 / §9.1/§9.2).
 *
 * - Entries: pixels (tile diffs) · structure (shallow copy-on-write snapshots)
 *   · composite (transaction children).
 * - Budget: default 64 MB per project (Settings range 16–512 MB). Oldest
 *   entries are evicted when the estimate exceeds the budget. A typical
 *   32×32 stroke costs 1–8 KB, so ≥ 250 undos are guaranteed (C21) —
 *   usually thousands.
 * - Application discipline: buffers are never mutated in place; undo/redo
 *   build NEW buffers (tile patch) or swap whole documents (snapshots).
 *   Structural snapshots therefore always observe the exact bytes of their
 *   time — the invariant that makes mixed pixel/structure undo deterministic.
 * - Skipped entries: a pixel entry whose cel no longer exists (structure
 *   changed underneath) is dropped, matching the prototype's unwind behavior.
 */

import { uid } from '../id';
import type { Project } from '../types/document';
import type { CommandOrigin } from '../types/commands';
import type { PixelHistoryData } from '../types/commands';
import type { HistoryEntry, HistoryStats } from '../types/history';
import { locateCel, replaceCelBuffer } from '../doc/access';
import { applyTileDiff } from '../pixels/tile';
import { CommandError } from '../bus/errors';

/** Default per-project history budget: 64 MB (v3.1 §2.5). */
export const DEFAULT_HISTORY_BUDGET_BYTES = 64 * 1024 * 1024;
export const MIN_HISTORY_BUDGET_BYTES = 16 * 1024 * 1024;
export const MAX_HISTORY_BUDGET_BYTES = 512 * 1024 * 1024;

export function clampHistoryBudget(bytes: number): number {
  const n = Math.round(bytes);
  if (!Number.isFinite(n)) return DEFAULT_HISTORY_BUDGET_BYTES;
  return Math.min(MAX_HISTORY_BUDGET_BYTES, Math.max(MIN_HISTORY_BUDGET_BYTES, n));
}

/** Engine-level sanity normalization (no Settings clamp — see class note). */
function normalizeBudget(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_HISTORY_BUDGET_BYTES;
  return Math.max(1, Math.floor(bytes));
}

/** Rough per-entry accounting overhead (ids, label, tiles array slots…). */
const ENTRY_OVERHEAD = 96;
const TILE_SLOT_OVERHEAD = 24;

export function estimatePixelEntryBytes(tileCount: number): number {
  return ENTRY_OVERHEAD + tileCount * (1024 * 2 + TILE_SLOT_OVERHEAD);
}

/**
 * Estimated bytes of a document's STRUCTURE (buffers excluded — they are
 * shared by reference across snapshots under copy-on-write). Heuristic:
 * ~O(nodes), documented as an estimate; the ≥250-stroke guarantee depends on
 * the tile-diff math above, not on this estimate's precision.
 */
export function estimateProjectStructureBytes(p: Project): number {
  let bytes = 256 + p.palette.length * 8 + p.trash.length * 64;
  for (const clip of p.clips) {
    bytes += 192 + clip.name.length + clip.layers.length * 88 + clip.parts.length * 120 + clip.tags.length * 48;
    for (const frame of clip.frames) {
      bytes += 96 + Object.keys(frame.cels).length * 56;
    }
  }
  return bytes;
}

export function estimateStructureEntryBytes(before: Project, after: Project): number {
  return ENTRY_OVERHEAD + estimateProjectStructureBytes(before) + estimateProjectStructureBytes(after);
}

export function makePixelEntry(
  label: string,
  origin: CommandOrigin,
  data: PixelHistoryData
): HistoryEntry {
  return {
    kind: 'pixels',
    id: uid('he'),
    label,
    origin,
    timestamp: Date.now(),
    bytes: estimatePixelEntryBytes(data.tiles.length),
    data,
  };
}

export function makeStructureEntry(
  label: string,
  origin: CommandOrigin,
  before: Project,
  after: Project
): HistoryEntry {
  return {
    kind: 'structure',
    id: uid('he'),
    label,
    origin,
    timestamp: Date.now(),
    bytes: estimateStructureEntryBytes(before, after),
    before,
    after,
  };
}

export function makeCompositeEntry(
  label: string,
  origin: CommandOrigin,
  children: HistoryEntry[]
): HistoryEntry {
  const bytes = children.reduce((sum, c) => sum + c.bytes, 0) + ENTRY_OVERHEAD;
  return { kind: 'composite', id: uid('he'), label, origin, timestamp: Date.now(), bytes, children };
}

/**
 * Apply one entry to a document in the given direction.
 * Returns the new document, or null when the entry is stale (its cel is
 * gone) and should be skipped. Pure: the input document is never mutated.
 */
export function applyEntry(
  project: Project,
  entry: HistoryEntry,
  dir: 'undo' | 'redo'
): Project | null {
  switch (entry.kind) {
    case 'structure':
      return dir === 'undo' ? entry.before : entry.after;
    case 'pixels': {
      const data = entry.data;
      const loc = locateCel(project, data.clipId, data.frameId, data.layerId);
      if (!loc) return null; // stale — structure changed underneath
      const current = loc.cel ? loc.cel.buffer : new Uint8ClampedArray(project.width * project.height * 4);
      const patched = applyTileDiff(current, project.width, project.height, data.tiles, dir === 'undo' ? 'before' : 'after');
      // Propagation follows the layer's CURRENT linkage (a layer unlinked
      // after the edit is undone per-frame; a linked layer propagates).
      const next = replaceCelBuffer(
        project, data.clipId, data.frameId, data.layerId, patched, loc.layer.linked
      );
      return next;
    }
    case 'composite': {
      let doc: Project = project;
      let skipped = 0;
      const items = dir === 'undo' ? [...entry.children].reverse() : entry.children;
      for (const child of items) {
        const next = applyEntry(doc, child, dir);
        if (next === null) {
          skipped += 1;
          continue;
        }
        doc = next;
      }
      return skipped === entry.children.length ? null : doc;
    }
  }
}

/**
 * Owned undo/redo stacks with a byte budget and oldest-first eviction.
 * Eviction order: past (chronologically oldest) first, then future front
 * (oldest redo state) — each entry is self-contained, so shortening the
 * redo chain from the front keeps redo coherent.
 *
 * NOTE: the 16–512 MB Settings-range clamp is applied by the CommandBus
 * (settings policy layer). The engine itself accepts any positive budget so
 * eviction mechanics can be exercised (and CI can use small budgets).
 */
export class HistoryEngine {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private bytes = 0;
  private budget: number;
  private evictedCount = 0;

  constructor(budgetBytes: number = DEFAULT_HISTORY_BUDGET_BYTES) {
    this.budget = normalizeBudget(budgetBytes);
  }

  get budgetBytes(): number {
    return this.budget;
  }

  setBudget(bytes: number): void {
    this.budget = normalizeBudget(bytes);
    this.evict();
  }

  /** Commit a new entry: clears the redo stack, appends, evicts. */
  push(entry: HistoryEntry): void {
    this.clearFuture();
    this.past.push(entry);
    this.bytes += entry.bytes;
    this.evict();
  }

  private dropPastOldest(): void {
    const entry = this.past.shift();
    if (entry) {
      this.bytes -= entry.bytes;
      this.evictedCount += 1;
    }
  }

  private dropFutureOldest(): void {
    const entry = this.future.shift();
    if (entry) this.bytes -= entry.bytes;
  }

  private evict(): void {
    // Keep at least the newest past entry even if it alone exceeds budget.
    while (this.bytes > this.budget && this.past.length > 1) this.dropPastOldest();
    while (this.bytes > this.budget && this.future.length > 0) this.dropFutureOldest();
  }

  private clearFuture(): void {
    for (const e of this.future) this.bytes -= e.bytes;
    this.future = [];
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /**
   * Undo one entry. Stale pixel entries are dropped and the walk continues
   * to older entries (prototype semantics).
   */
  undo(project: Project): { project: Project; entry: HistoryEntry; skipped: number } | null {
    let skipped = 0;
    while (this.past.length > 0) {
      const entry = this.past.pop() as HistoryEntry;
      this.bytes -= entry.bytes;
      const next = applyEntry(project, entry, 'undo');
      if (next === null) {
        skipped += 1;
        continue; // stale — discard both ways
      }
      this.future.push(entry);
      this.bytes += entry.bytes;
      return { project: next, entry, skipped };
    }
    return skipped > 0 ? null : null;
  }

  redo(project: Project): { project: Project; entry: HistoryEntry; skipped: number } | null {
    let skipped = 0;
    while (this.future.length > 0) {
      const entry = this.future.pop() as HistoryEntry;
      this.bytes -= entry.bytes;
      const next = applyEntry(project, entry, 'redo');
      if (next === null) {
        skipped += 1;
        continue;
      }
      this.past.push(entry);
      this.bytes += entry.bytes;
      return { project: next, entry, skipped };
    }
    return null;
  }

  stats(): HistoryStats {
    const byOrigin: Record<CommandOrigin, number> = { ui: 0, mcp: 0, ai: 0 };
    for (const e of this.past) byOrigin[e.origin] += 1;
    return {
      undoDepth: this.past.length,
      redoDepth: this.future.length,
      bytes: this.bytes,
      budgetBytes: this.budget,
      usage: this.budget > 0 ? this.bytes / this.budget : 0,
      evictedCount: this.evictedCount,
      byOrigin,
    };
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.bytes = 0;
  }
}

/** Re-export for bus-internal use without widening the public surface. */
export function assertHistoryStep(
  step: { project: Project; entry: HistoryEntry; skipped: number } | null
): { project: Project; entry: HistoryEntry; skipped: number } {
  if (!step) throw new CommandError('INVALID_STATE', 'Nothing to undo/redo');
  return step;
}
