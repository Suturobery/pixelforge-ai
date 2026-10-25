"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HistoryEngine = exports.MAX_HISTORY_BUDGET_BYTES = exports.MIN_HISTORY_BUDGET_BYTES = exports.DEFAULT_HISTORY_BUDGET_BYTES = void 0;
exports.clampHistoryBudget = clampHistoryBudget;
exports.estimatePixelEntryBytes = estimatePixelEntryBytes;
exports.estimateProjectStructureBytes = estimateProjectStructureBytes;
exports.estimateStructureEntryBytes = estimateStructureEntryBytes;
exports.makePixelEntry = makePixelEntry;
exports.makeStructureEntry = makeStructureEntry;
exports.makeCompositeEntry = makeCompositeEntry;
exports.applyEntry = applyEntry;
exports.assertHistoryStep = assertHistoryStep;
const id_1 = require("../id");
const access_1 = require("../doc/access");
const tile_1 = require("../pixels/tile");
const errors_1 = require("../bus/errors");
/** Default per-project history budget: 64 MB (v3.1 §2.5). */
exports.DEFAULT_HISTORY_BUDGET_BYTES = 64 * 1024 * 1024;
exports.MIN_HISTORY_BUDGET_BYTES = 16 * 1024 * 1024;
exports.MAX_HISTORY_BUDGET_BYTES = 512 * 1024 * 1024;
function clampHistoryBudget(bytes) {
    const n = Math.round(bytes);
    if (!Number.isFinite(n))
        return exports.DEFAULT_HISTORY_BUDGET_BYTES;
    return Math.min(exports.MAX_HISTORY_BUDGET_BYTES, Math.max(exports.MIN_HISTORY_BUDGET_BYTES, n));
}
/** Engine-level sanity normalization (no Settings clamp — see class note). */
function normalizeBudget(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return exports.DEFAULT_HISTORY_BUDGET_BYTES;
    return Math.max(1, Math.floor(bytes));
}
/** Rough per-entry accounting overhead (ids, label, tiles array slots…). */
const ENTRY_OVERHEAD = 96;
const TILE_SLOT_OVERHEAD = 24;
function estimatePixelEntryBytes(tileCount) {
    return ENTRY_OVERHEAD + tileCount * (1024 * 2 + TILE_SLOT_OVERHEAD);
}
/**
 * Estimated bytes of a document's STRUCTURE (buffers excluded — they are
 * shared by reference across snapshots under copy-on-write). Heuristic:
 * ~O(nodes), documented as an estimate; the ≥250-stroke guarantee depends on
 * the tile-diff math above, not on this estimate's precision.
 */
function estimateProjectStructureBytes(p) {
    let bytes = 256 + p.palette.length * 8 + p.trash.length * 64;
    for (const clip of p.clips) {
        bytes += 192 + clip.name.length + clip.layers.length * 88 + clip.parts.length * 120 + clip.tags.length * 48;
        for (const frame of clip.frames) {
            bytes += 96 + Object.keys(frame.cels).length * 56;
        }
    }
    return bytes;
}
function estimateStructureEntryBytes(before, after) {
    return ENTRY_OVERHEAD + estimateProjectStructureBytes(before) + estimateProjectStructureBytes(after);
}
function makePixelEntry(label, origin, data) {
    return {
        kind: 'pixels',
        id: (0, id_1.uid)('he'),
        label,
        origin,
        timestamp: Date.now(),
        bytes: estimatePixelEntryBytes(data.tiles.length),
        data,
    };
}
function makeStructureEntry(label, origin, before, after) {
    return {
        kind: 'structure',
        id: (0, id_1.uid)('he'),
        label,
        origin,
        timestamp: Date.now(),
        bytes: estimateStructureEntryBytes(before, after),
        before,
        after,
    };
}
function makeCompositeEntry(label, origin, children) {
    const bytes = children.reduce((sum, c) => sum + c.bytes, 0) + ENTRY_OVERHEAD;
    return { kind: 'composite', id: (0, id_1.uid)('he'), label, origin, timestamp: Date.now(), bytes, children };
}
/**
 * Apply one entry to a document in the given direction.
 * Returns the new document, or null when the entry is stale (its cel is
 * gone) and should be skipped. Pure: the input document is never mutated.
 */
function applyEntry(project, entry, dir) {
    switch (entry.kind) {
        case 'structure':
            return dir === 'undo' ? entry.before : entry.after;
        case 'pixels': {
            const data = entry.data;
            const loc = (0, access_1.locateCel)(project, data.clipId, data.frameId, data.layerId);
            if (!loc)
                return null; // stale — structure changed underneath
            const current = loc.cel ? loc.cel.buffer : new Uint8ClampedArray(project.width * project.height * 4);
            const patched = (0, tile_1.applyTileDiff)(current, project.width, project.height, data.tiles, dir === 'undo' ? 'before' : 'after');
            // Propagation follows the layer's CURRENT linkage (a layer unlinked
            // after the edit is undone per-frame; a linked layer propagates).
            const next = (0, access_1.replaceCelBuffer)(project, data.clipId, data.frameId, data.layerId, patched, loc.layer.linked);
            return next;
        }
        case 'composite': {
            let doc = project;
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
class HistoryEngine {
    past = [];
    future = [];
    bytes = 0;
    budget;
    evictedCount = 0;
    constructor(budgetBytes = exports.DEFAULT_HISTORY_BUDGET_BYTES) {
        this.budget = normalizeBudget(budgetBytes);
    }
    get budgetBytes() {
        return this.budget;
    }
    setBudget(bytes) {
        this.budget = normalizeBudget(bytes);
        this.evict();
    }
    /** Commit a new entry: clears the redo stack, appends, evicts. */
    push(entry) {
        this.clearFuture();
        this.past.push(entry);
        this.bytes += entry.bytes;
        this.evict();
    }
    dropPastOldest() {
        const entry = this.past.shift();
        if (entry) {
            this.bytes -= entry.bytes;
            this.evictedCount += 1;
        }
    }
    dropFutureOldest() {
        const entry = this.future.shift();
        if (entry)
            this.bytes -= entry.bytes;
    }
    evict() {
        // Keep at least the newest past entry even if it alone exceeds budget.
        while (this.bytes > this.budget && this.past.length > 1)
            this.dropPastOldest();
        while (this.bytes > this.budget && this.future.length > 0)
            this.dropFutureOldest();
    }
    clearFuture() {
        for (const e of this.future)
            this.bytes -= e.bytes;
        this.future = [];
    }
    canUndo() {
        return this.past.length > 0;
    }
    canRedo() {
        return this.future.length > 0;
    }
    /**
     * Undo one entry. Stale pixel entries are dropped and the walk continues
     * to older entries (prototype semantics).
     */
    undo(project) {
        let skipped = 0;
        while (this.past.length > 0) {
            const entry = this.past.pop();
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
    redo(project) {
        let skipped = 0;
        while (this.future.length > 0) {
            const entry = this.future.pop();
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
    stats() {
        const byOrigin = { ui: 0, mcp: 0, ai: 0 };
        for (const e of this.past)
            byOrigin[e.origin] += 1;
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
    clear() {
        this.past = [];
        this.future = [];
        this.bytes = 0;
    }
}
exports.HistoryEngine = HistoryEngine;
/** Re-export for bus-internal use without widening the public surface. */
function assertHistoryStep(step) {
    if (!step)
        throw new errors_1.CommandError('INVALID_STATE', 'Nothing to undo/redo');
    return step;
}
