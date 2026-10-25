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
import type { Project } from '../types/document';
import type { CommandOrigin } from '../types/commands';
import type { PixelHistoryData } from '../types/commands';
import type { HistoryEntry, HistoryStats } from '../types/history';
/** Default per-project history budget: 64 MB (v3.1 §2.5). */
export declare const DEFAULT_HISTORY_BUDGET_BYTES: number;
export declare const MIN_HISTORY_BUDGET_BYTES: number;
export declare const MAX_HISTORY_BUDGET_BYTES: number;
export declare function clampHistoryBudget(bytes: number): number;
export declare function estimatePixelEntryBytes(tileCount: number): number;
/**
 * Estimated bytes of a document's STRUCTURE (buffers excluded — they are
 * shared by reference across snapshots under copy-on-write). Heuristic:
 * ~O(nodes), documented as an estimate; the ≥250-stroke guarantee depends on
 * the tile-diff math above, not on this estimate's precision.
 */
export declare function estimateProjectStructureBytes(p: Project): number;
export declare function estimateStructureEntryBytes(before: Project, after: Project): number;
export declare function makePixelEntry(label: string, origin: CommandOrigin, data: PixelHistoryData): HistoryEntry;
export declare function makeStructureEntry(label: string, origin: CommandOrigin, before: Project, after: Project): HistoryEntry;
export declare function makeCompositeEntry(label: string, origin: CommandOrigin, children: HistoryEntry[]): HistoryEntry;
/**
 * Apply one entry to a document in the given direction.
 * Returns the new document, or null when the entry is stale (its cel is
 * gone) and should be skipped. Pure: the input document is never mutated.
 */
export declare function applyEntry(project: Project, entry: HistoryEntry, dir: 'undo' | 'redo'): Project | null;
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
export declare class HistoryEngine {
    private past;
    private future;
    private bytes;
    private budget;
    private evictedCount;
    constructor(budgetBytes?: number);
    get budgetBytes(): number;
    setBudget(bytes: number): void;
    /** Commit a new entry: clears the redo stack, appends, evicts. */
    push(entry: HistoryEntry): void;
    private dropPastOldest;
    private dropFutureOldest;
    private evict;
    private clearFuture;
    canUndo(): boolean;
    canRedo(): boolean;
    /**
     * Undo one entry. Stale pixel entries are dropped and the walk continues
     * to older entries (prototype semantics).
     */
    undo(project: Project): {
        project: Project;
        entry: HistoryEntry;
        skipped: number;
    } | null;
    redo(project: Project): {
        project: Project;
        entry: HistoryEntry;
        skipped: number;
    } | null;
    stats(): HistoryStats;
    clear(): void;
}
/** Re-export for bus-internal use without widening the public surface. */
export declare function assertHistoryStep(step: {
    project: Project;
    entry: HistoryEntry;
    skipped: number;
} | null): {
    project: Project;
    entry: HistoryEntry;
    skipped: number;
};
