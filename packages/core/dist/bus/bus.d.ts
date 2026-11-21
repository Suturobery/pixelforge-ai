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
import type { AnyCommandDefinition, ApplyOutcome, ChangeListener, CommandDefinition, CommandOrigin, HistoryStepResult, StrokeCommitResult, StrokeHandle, StrokeParams } from '../types/commands';
import type { Project } from '../types/document';
import type { HistoryStats } from '../types/history';
export interface CommandBusOptions {
    /** History memory budget in bytes; default 64 MB, clamped to 16–512 MB (§2.5). */
    budgetBytes?: number;
    /** Register built-in structural + pixel commands (default true). */
    registerBuiltins?: boolean;
}
export declare class CommandBus {
    private project;
    private readonly defs;
    private readonly engine;
    private readonly listeners;
    private stroke;
    private readonly txStack;
    private dirty;
    constructor(project: Project, opts?: CommandBusOptions);
    /** Register a command type. Duplicate types are rejected (no silent clobber). */
    register(def: CommandDefinition<never> | AnyCommandDefinition): void;
    has(type: string): boolean;
    /** Subscribe to document changes. Returns an unsubscribe function. */
    onChange(listener: ChangeListener): () => void;
    getProject(): Project;
    isDirty(): boolean;
    markSaved(): void;
    /**
     * Replace the whole document (new project / load project). Clears history
     * and any active stroke. `dirty` defaults to false (load semantics); pass
     * true for new-unsaved documents (prototype newProject behavior).
     */
    setProject(project: Project, opts?: {
        dirty?: boolean;
    }): void;
    /**
     * Validate + apply a command and commit it to history.
     * Throws CommandError on unknown command / failed validation / missing
     * targets — the document is never left half-mutated (commands are pure).
     */
    execute<P>(type: string, payload: P, origin: CommandOrigin, opts?: {
        label?: string;
    }): ApplyOutcome;
    private commit;
    private buildEntry;
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
    transaction<T>(label: string, origin: CommandOrigin, fn: () => T): T | Promise<T>;
    private commitTx;
    private rollbackTx;
    /** True while inside transaction() — strokes are rejected in that window. */
    get inTransaction(): boolean;
    /**
     * Begin a pixel stroke: swaps a working copy of the target cel into the
     * document and hands the caller a buffer to draw into. Nothing enters
     * history until endStroke. Missing cels are created (transparent, C2);
     * linked layers propagate the working buffer to every frame.
     */
    beginStroke(params: StrokeParams): StrokeHandle;
    /**
     * Commit the stroke as ONE tile-diff history entry (stroke-grouped).
     * `changed=false` short-circuits (fast path, no diffing). If the target
     * cel was deleted mid-stroke, the stroke is discarded (prototype unwind
     * semantics).
     */
    endStroke(label: string, changed: boolean, origin?: CommandOrigin): StrokeCommitResult;
    /** Cancel the stroke and restore the exact pre-stroke buffer. */
    cancelStroke(origin?: CommandOrigin): void;
    get activeStroke(): boolean;
    canUndo(): boolean;
    canRedo(): boolean;
    /**
     * Undo one history entry. Stale pixel entries (cel deleted) are dropped
     * and the walk continues to older entries. Throws when history is empty.
     */
    undo(): HistoryStepResult;
    redo(): HistoryStepResult;
    historyStats(): HistoryStats;
    /**
     * Drop all undo/redo history without touching the document. Used after a
     * journal replay / project load so the recovered document starts clean
     * (v3.1 §6 journal semantics; also the Task 4 load path).
     */
    resetHistory(): void;
    setHistoryBudget(bytes: number): void;
    private emit;
}
