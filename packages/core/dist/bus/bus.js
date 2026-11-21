"use strict";
/**
 * CommandBus (v3.1 §2.5): the single execution path for every document
 * mutation — UI, AI, and MCP all call the exact same bus (v1 §03
 * separation-of-concerns, enforced in code). There is no separate AI or MCP
 * mutation path that could bypass validation.
 *
 * Features: execute · undo/redo · validation · transaction grouping ·
 * origin tracking ('ui' | 'mcp' | 'ai') · typed error handling · document
 * change notifications · stroke flow (prototype beginStroke/endStroke/
 * cancelStroke contract kept) · tile-diff history with memory budget.
 *
 * This class is framework-free (no React, no Electron, no DOM) — it runs in
 * the renderer, in workers, in Electron main, and in unit tests.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommandBus = void 0;
const engine_1 = require("../history/engine");
const access_1 = require("../doc/access");
const buffers_1 = require("../util/buffers");
const tile_1 = require("../pixels/tile");
const builtins_1 = require("./builtins");
const errors_1 = require("./errors");
function isThenable(value) {
    return typeof value?.then === 'function';
}
class CommandBus {
    project;
    defs = new Map();
    engine;
    listeners = new Set();
    stroke = null;
    txStack = [];
    dirty = false;
    constructor(project, opts = {}) {
        this.project = project;
        this.engine = new engine_1.HistoryEngine(opts.budgetBytes ?? engine_1.DEFAULT_HISTORY_BUDGET_BYTES);
        if (opts.registerBuiltins !== false) {
            for (const def of (0, builtins_1.builtinCommands)())
                this.register(def);
        }
    }
    // -------------------------------------------------------------------------
    // registration
    // -------------------------------------------------------------------------
    /** Register a command type. Duplicate types are rejected (no silent clobber). */
    register(def) {
        if (this.defs.has(def.type)) {
            throw new errors_1.CommandError('INVALID_STATE', `Command "${def.type}" is already registered`);
        }
        this.defs.set(def.type, def);
    }
    has(type) {
        return this.defs.has(type);
    }
    // -------------------------------------------------------------------------
    // subscriptions & document lifecycle
    // -------------------------------------------------------------------------
    /** Subscribe to document changes. Returns an unsubscribe function. */
    onChange(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    getProject() {
        return this.project;
    }
    isDirty() {
        return this.dirty;
    }
    markSaved() {
        this.dirty = false;
    }
    /**
     * Replace the whole document (new project / load project). Clears history
     * and any active stroke. `dirty` defaults to false (load semantics); pass
     * true for new-unsaved documents (prototype newProject behavior).
     */
    setProject(project, opts = {}) {
        this.stroke = null; // abort silently — the old document is gone
        this.project = project;
        this.engine.clear();
        this.dirty = opts.dirty ?? false;
        this.emit({ reason: 'document-replaced', project });
    }
    // -------------------------------------------------------------------------
    // execution
    // -------------------------------------------------------------------------
    /**
     * Validate + apply a command and commit it to history.
     * Throws CommandError on unknown command / failed validation / missing
     * targets — the document is never left half-mutated (commands are pure).
     */
    execute(type, payload, origin, opts = {}) {
        const def = this.defs.get(type);
        if (!def) {
            throw new errors_1.CommandError('UNKNOWN_COMMAND', `No command registered: "${type}"`);
        }
        const ctx = {
            project: this.project,
            width: this.project.width,
            height: this.project.height,
        };
        def.validate(payload, ctx); // throws CommandError → document untouched
        const outcome = def.apply(payload, ctx);
        this.commit(outcome, opts.label ?? outcome.label ?? def.defaultLabel, origin, type, payload);
        return outcome;
    }
    commit(outcome, label, origin, commandType, payload) {
        const entry = this.buildEntry(outcome, label, origin);
        if (this.txStack.length > 0) {
            if (entry)
                this.txStack[this.txStack.length - 1].children.push(entry);
            if (entry)
                this.dirty = true;
        }
        else if (entry) {
            this.engine.push(entry);
            this.dirty = true;
        }
        this.project = outcome.project;
        this.emit({
            reason: 'executed',
            project: this.project,
            label,
            origin,
            commandType,
            payload,
            historyChanged: !!entry,
        });
    }
    buildEntry(outcome, label, origin) {
        // Pixel path: presence of `pixels` (even with zero tiles) marks a pixel
        // command — zero tiles means a visual no-op, never a structure entry.
        if (outcome.pixels) {
            return outcome.pixels.tiles.length > 0
                ? (0, engine_1.makePixelEntry)(label, origin, outcome.pixels)
                : null;
        }
        if (outcome.project !== this.project) {
            return (0, engine_1.makeStructureEntry)(label, origin, this.project, outcome.project);
        }
        return null; // no-op
    }
    // -------------------------------------------------------------------------
    // transactions (§: transaction grouping)
    // -------------------------------------------------------------------------
    /**
     * Group several executes into ONE undoable history entry. If `fn` throws
     * (or the returned promise rejects), the document is rolled back to the
     * transaction start and the error is rethrown — no partial application,
     * no history pollution. Nested transactions fold into their parent.
     *
     * `fn` may be async: the commit/rollback then happens when the promise
     * settles. While an async transaction is open, commands executed from
     * other sources fold into it as children — keep the async window short.
     */
    transaction(label, origin, fn) {
        if (this.stroke) {
            throw new errors_1.CommandError('TRANSACTION_CONFLICT', 'Cannot open a transaction while a stroke is active');
        }
        const tx = { label, origin, start: this.project, children: [] };
        this.txStack.push(tx);
        let result;
        try {
            result = fn();
        }
        catch (err) {
            this.txStack.pop();
            this.rollbackTx(tx, label, origin);
            throw err;
        }
        if (isThenable(result)) {
            return result.then((value) => {
                this.txStack.pop();
                return this.commitTx(tx, label, origin, value);
            }, (err) => {
                this.txStack.pop();
                this.rollbackTx(tx, label, origin);
                throw err;
            });
        }
        this.txStack.pop();
        return this.commitTx(tx, label, origin, result);
    }
    commitTx(tx, label, origin, value) {
        if (tx.children.length > 0) {
            const entry = tx.children.length === 1
                ? tx.children[0]
                : (0, engine_1.makeCompositeEntry)(label, origin, tx.children);
            if (this.txStack.length > 0) {
                // Nested transaction: fold into the parent's children so the whole
                // outer transaction becomes ONE undoable entry.
                this.txStack[this.txStack.length - 1].children.push(entry);
            }
            else {
                this.engine.push(entry);
                this.dirty = true;
                this.emit({
                    reason: 'executed',
                    project: this.project,
                    label,
                    origin,
                    historyChanged: true,
                });
            }
        }
        return value;
    }
    rollbackTx(tx, label, origin) {
        // Commands are pure and buffers copy-on-write → restoring the start
        // document is an exact rollback.
        this.project = tx.start;
        this.emit({
            reason: 'transaction-rolled-back',
            project: this.project,
            label,
            origin,
        });
    }
    /** True while inside transaction() — strokes are rejected in that window. */
    get inTransaction() {
        return this.txStack.length > 0;
    }
    // -------------------------------------------------------------------------
    // stroke flow (prototype contract kept: begin/end/cancel)
    // -------------------------------------------------------------------------
    /**
     * Begin a pixel stroke: swaps a working copy of the target cel into the
     * document and hands the caller a buffer to draw into. Nothing enters
     * history until endStroke. Missing cels are created (transparent, C2);
     * linked layers propagate the working buffer to every frame.
     */
    beginStroke(params) {
        if (this.stroke) {
            throw new errors_1.CommandError('INVALID_STATE', 'A stroke is already active');
        }
        if (this.txStack.length > 0) {
            throw new errors_1.CommandError('TRANSACTION_CONFLICT', 'Cannot begin a stroke inside a transaction');
        }
        const loc = (0, access_1.locateCel)(this.project, params.clipId, params.frameId, params.layerId);
        if (!loc) {
            throw new errors_1.CommandError('NOT_FOUND', `Stroke target ${params.clipId}/${params.frameId}/${params.layerId} not found`);
        }
        const { width, height } = this.project;
        // Install the shared/original buffer everywhere first so every frame of
        // a linked layer participates; then copy → working.
        let original;
        if (loc.cel) {
            original = loc.cel.buffer;
        }
        else {
            original = new Uint8ClampedArray(width * height * 4);
            const linked = loc.layer.linked;
            this.project = linked
                ? (0, access_1.setCelEverywhere)(this.project, params.clipId, params.layerId, { buffer: original, linked: true })
                : (0, access_1.setCel)(this.project, params.clipId, params.frameId, params.layerId, { buffer: original, linked: false });
        }
        const working = (0, buffers_1.cloneBuffer)(original);
        this.project = (loc.layer.linked
            ? (0, access_1.setCelEverywhere)(this.project, params.clipId, params.layerId, { buffer: working, linked: true })
            : (0, access_1.setCel)(this.project, params.clipId, params.frameId, params.layerId, { buffer: working, linked: false }));
        this.stroke = { params: { ...params }, original, startedAt: Date.now() };
        this.emit({ reason: 'stroke-started', project: this.project });
        return { width, height, buffer: working };
    }
    /**
     * Commit the stroke as ONE tile-diff history entry (stroke-grouped).
     * `changed=false` short-circuits (fast path, no diffing). If the target
     * cel was deleted mid-stroke, the stroke is discarded (prototype unwind
     * semantics).
     */
    endStroke(label, changed, origin = 'ui') {
        const st = this.stroke;
        if (!st)
            throw new errors_1.CommandError('INVALID_STATE', 'No stroke is active');
        const finish = (committed, extra, journal) => {
            this.stroke = null;
            this.emit({
                reason: committed ? 'stroke-committed' : 'stroke-cancelled',
                project: this.project,
                label,
                origin,
                historyChanged: committed,
                ...(journal ?? {}),
            });
            return { committed, ...extra };
        };
        const loc = (0, access_1.locateCel)(this.project, st.params.clipId, st.params.frameId, st.params.layerId);
        if (!loc) {
            // Structure changed underneath — discard, like the prototype did.
            return finish(false, { discarded: true });
        }
        const { width, height } = this.project;
        if (!changed) {
            // Restore the original buffer object — exact pre-stroke state.
            this.project = (loc.layer.linked
                ? (0, access_1.setCelEverywhere)(this.project, st.params.clipId, st.params.layerId, { buffer: st.original, linked: true })
                : (0, access_1.setCel)(this.project, st.params.clipId, st.params.frameId, st.params.layerId, { buffer: st.original, linked: false }));
            return finish(false);
        }
        const working = loc.cel ? loc.cel.buffer : new Uint8ClampedArray(width * height * 4);
        const tiles = (0, tile_1.extractTileDiff)(st.original, working, width, height);
        if (tiles.length === 0) {
            this.project = (loc.layer.linked
                ? (0, access_1.setCelEverywhere)(this.project, st.params.clipId, st.params.layerId, { buffer: st.original, linked: true })
                : (0, access_1.setCel)(this.project, st.params.clipId, st.params.frameId, st.params.layerId, { buffer: st.original, linked: false }));
            return finish(false);
        }
        const entry = (0, engine_1.makePixelEntry)(label, origin, {
            clipId: st.params.clipId,
            frameId: st.params.frameId,
            layerId: st.params.layerId,
            tiles,
        });
        if (this.txStack.length > 0) {
            throw new errors_1.CommandError('TRANSACTION_CONFLICT', 'Stroke ended inside a transaction — impossible state');
        }
        this.engine.push(entry);
        this.dirty = true;
        this.project = (loc.layer.linked
            ? (0, access_1.setCelEverywhere)(this.project, st.params.clipId, st.params.layerId, { buffer: working, linked: true })
            : (0, access_1.setCel)(this.project, st.params.clipId, st.params.frameId, st.params.layerId, { buffer: working, linked: false }));
        // Journal hooks (Task 4): the committed stroke emits a REPLAYABLE payload
        // (a single setBuffer pixel op) so completed brush strokes survive a crash
        // via journal replay, not only via the autosave snapshot. The recorder
        // applies its own size policy (large buffers fall back to autosave).
        return finish(true, { entryId: entry.id }, {
            commandType: 'pixels.applyOp',
            payload: {
                clipId: st.params.clipId,
                frameId: st.params.frameId,
                layerId: st.params.layerId,
                ops: [{ op: 'setBuffer', buffer: working }],
            },
        });
    }
    /** Cancel the stroke and restore the exact pre-stroke buffer. */
    cancelStroke(origin = 'ui') {
        const st = this.stroke;
        if (!st)
            throw new errors_1.CommandError('INVALID_STATE', 'No stroke is active');
        this.stroke = null;
        const loc = (0, access_1.locateCel)(this.project, st.params.clipId, st.params.frameId, st.params.layerId);
        if (loc) {
            this.project = (loc.layer.linked
                ? (0, access_1.setCelEverywhere)(this.project, st.params.clipId, st.params.layerId, { buffer: st.original, linked: true })
                : (0, access_1.setCel)(this.project, st.params.clipId, st.params.frameId, st.params.layerId, { buffer: st.original, linked: false }));
        }
        this.emit({ reason: 'stroke-cancelled', project: this.project, origin });
    }
    get activeStroke() {
        return this.stroke !== null;
    }
    // -------------------------------------------------------------------------
    // undo / redo
    // -------------------------------------------------------------------------
    canUndo() {
        return this.engine.canUndo() && !this.stroke;
    }
    canRedo() {
        return this.engine.canRedo() && !this.stroke;
    }
    /**
     * Undo one history entry. Stale pixel entries (cel deleted) are dropped
     * and the walk continues to older entries. Throws when history is empty.
     */
    undo() {
        if (this.stroke) {
            throw new errors_1.CommandError('INVALID_STATE', 'Cannot undo while a stroke is active');
        }
        const step = this.engine.undo(this.project);
        if (!step)
            return { ok: false };
        this.project = step.project;
        this.dirty = true;
        this.emit({
            reason: 'undone',
            project: this.project,
            label: step.entry.label,
            origin: step.entry.origin,
            historyChanged: true,
        });
        return { ok: true, label: step.entry.label, origin: step.entry.origin, skipped: step.skipped };
    }
    redo() {
        if (this.stroke) {
            throw new errors_1.CommandError('INVALID_STATE', 'Cannot redo while a stroke is active');
        }
        const step = this.engine.redo(this.project);
        if (!step)
            return { ok: false };
        this.project = step.project;
        this.dirty = true;
        this.emit({
            reason: 'redone',
            project: this.project,
            label: step.entry.label,
            origin: step.entry.origin,
            historyChanged: true,
        });
        return { ok: true, label: step.entry.label, origin: step.entry.origin, skipped: step.skipped };
    }
    // -------------------------------------------------------------------------
    // history introspection
    // -------------------------------------------------------------------------
    historyStats() {
        return this.engine.stats();
    }
    /**
     * Drop all undo/redo history without touching the document. Used after a
     * journal replay / project load so the recovered document starts clean
     * (v3.1 §6 journal semantics; also the Task 4 load path).
     */
    resetHistory() {
        this.engine.clear();
    }
    setHistoryBudget(bytes) {
        this.engine.setBudget((0, engine_1.clampHistoryBudget)(bytes));
    }
    emit(event) {
        for (const listener of this.listeners) {
            try {
                listener(event);
            }
            catch (err) {
                // A broken listener must not corrupt the bus; surface for debugging.
                // console is available in Node, Electron main/renderer, and tests.
                console.error('[pixelforge/core] change listener failed', err);
            }
        }
    }
}
exports.CommandBus = CommandBus;
