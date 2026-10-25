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

import type {
  AnyCommandDefinition,
  ApplyOutcome,
  ChangeEvent,
  ChangeListener,
  CommandContext,
  CommandDefinition,
  CommandOrigin,
  HistoryStepResult,
  StrokeCommitResult,
  StrokeHandle,
  StrokeParams,
} from '../types/commands';
import type { Project } from '../types/document';
import type { HistoryEntry, HistoryStats } from '../types/history';
import {
  DEFAULT_HISTORY_BUDGET_BYTES,
  HistoryEngine,
  clampHistoryBudget,
  makeCompositeEntry,
  makePixelEntry,
  makeStructureEntry,
} from '../history/engine';
import { locateCel, setCel as setCelCompat, setCelEverywhere as setCelEverywhereCompat } from '../doc/access';
import { cloneBuffer } from '../util/buffers';
import { extractTileDiff } from '../pixels/tile';
import { builtinCommands } from './builtins';
import { CommandError } from './errors';

interface TxFrame {
  label: string;
  origin: CommandOrigin;
  start: Project;
  children: HistoryEntry[];
}

interface StrokeState {
  params: StrokeParams;
  /** Buffer as it was when the stroke began (diff source). */
  original: Uint8ClampedArray;
  startedAt: number;
}

export interface CommandBusOptions {
  /** History memory budget in bytes; default 64 MB, clamped to 16–512 MB (§2.5). */
  budgetBytes?: number;
  /** Register built-in structural + pixel commands (default true). */
  registerBuiltins?: boolean;
}

export class CommandBus {
  private project: Project;
  private readonly defs = new Map<string, AnyCommandDefinition>();
  private readonly engine: HistoryEngine;
  private readonly listeners = new Set<ChangeListener>();
  private stroke: StrokeState | null = null;
  private readonly txStack: TxFrame[] = [];
  private dirty = false;

  constructor(project: Project, opts: CommandBusOptions = {}) {
    this.project = project;
    this.engine = new HistoryEngine(opts.budgetBytes ?? DEFAULT_HISTORY_BUDGET_BYTES);
    if (opts.registerBuiltins !== false) {
      for (const def of builtinCommands()) this.register(def as unknown as AnyCommandDefinition);
    }
  }

  // -------------------------------------------------------------------------
  // registration
  // -------------------------------------------------------------------------

  /** Register a command type. Duplicate types are rejected (no silent clobber). */
  register(def: CommandDefinition<never> | AnyCommandDefinition): void {
    if (this.defs.has(def.type)) {
      throw new CommandError('INVALID_STATE', `Command "${def.type}" is already registered`);
    }
    this.defs.set(def.type, def as unknown as AnyCommandDefinition);
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  // -------------------------------------------------------------------------
  // subscriptions & document lifecycle
  // -------------------------------------------------------------------------

  /** Subscribe to document changes. Returns an unsubscribe function. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getProject(): Project {
    return this.project;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  markSaved(): void {
    this.dirty = false;
  }

  /**
   * Replace the whole document (new project / load project). Clears history
   * and any active stroke. `dirty` defaults to false (load semantics); pass
   * true for new-unsaved documents (prototype newProject behavior).
   */
  setProject(project: Project, opts: { dirty?: boolean } = {}): void {
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
  execute<P>(
    type: string,
    payload: P,
    origin: CommandOrigin,
    opts: { label?: string } = {}
  ): ApplyOutcome {
    const def = this.defs.get(type);
    if (!def) {
      throw new CommandError('UNKNOWN_COMMAND', `No command registered: "${type}"`);
    }
    const ctx: CommandContext = {
      project: this.project,
      width: this.project.width,
      height: this.project.height,
    };
    def.validate(payload, ctx); // throws CommandError → document untouched
    const outcome = def.apply(payload, ctx);
    this.commit(outcome, opts.label ?? outcome.label ?? def.defaultLabel, origin, type, payload);
    return outcome;
  }

  private commit(
    outcome: ApplyOutcome,
    label: string,
    origin: CommandOrigin,
    commandType: string,
    payload?: unknown
  ): void {
    const entry = this.buildEntry(outcome, label, origin);
    if (this.txStack.length > 0) {
      if (entry) this.txStack[this.txStack.length - 1].children.push(entry);
      if (entry) this.dirty = true;
    } else if (entry) {
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

  private buildEntry(outcome: ApplyOutcome, label: string, origin: CommandOrigin): HistoryEntry | null {
    // Pixel path: presence of `pixels` (even with zero tiles) marks a pixel
    // command — zero tiles means a visual no-op, never a structure entry.
    if (outcome.pixels) {
      return outcome.pixels.tiles.length > 0
        ? makePixelEntry(label, origin, outcome.pixels)
        : null;
    }
    if (outcome.project !== this.project) {
      return makeStructureEntry(label, origin, this.project, outcome.project);
    }
    return null; // no-op
  }

  // -------------------------------------------------------------------------
  // transactions (§: transaction grouping)
  // -------------------------------------------------------------------------

  /**
   * Group several executes into ONE undoable history entry. If `fn` throws,
   * the document is rolled back to the transaction start and the error is
   * rethrown — no partial application, no history pollution.
   * Nested transactions fold into their parent.
   */
  transaction<T>(label: string, origin: CommandOrigin, fn: () => T): T {
    if (this.stroke) {
      throw new CommandError('TRANSACTION_CONFLICT', 'Cannot open a transaction while a stroke is active');
    }
    const tx: TxFrame = { label, origin, start: this.project, children: [] };
    this.txStack.push(tx);
    try {
      const result = fn();
      this.txStack.pop();
      if (tx.children.length > 0) {
        const entry =
          tx.children.length === 1
            ? tx.children[0]
            : makeCompositeEntry(label, origin, tx.children);
        if (this.txStack.length > 0) {
          // Nested transaction: fold into the parent's children so the whole
          // outer transaction becomes ONE undoable entry.
          this.txStack[this.txStack.length - 1].children.push(entry);
        } else {
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
      return result;
    } catch (err) {
      this.txStack.pop();
      // Commands are pure and buffers copy-on-write → restoring the start
      // document is an exact rollback.
      this.project = tx.start;
      this.emit({
        reason: 'transaction-rolled-back',
        project: this.project,
        label,
        origin,
      });
      throw err;
    }
  }

  /** True while inside transaction() — strokes are rejected in that window. */
  get inTransaction(): boolean {
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
  beginStroke(params: StrokeParams): StrokeHandle {
    if (this.stroke) {
      throw new CommandError('INVALID_STATE', 'A stroke is already active');
    }
    if (this.txStack.length > 0) {
      throw new CommandError('TRANSACTION_CONFLICT', 'Cannot begin a stroke inside a transaction');
    }
    const loc = locateCel(this.project, params.clipId, params.frameId, params.layerId);
    if (!loc) {
      throw new CommandError('NOT_FOUND', `Stroke target ${params.clipId}/${params.frameId}/${params.layerId} not found`);
    }
    const { width, height } = this.project;
    // Install the shared/original buffer everywhere first so every frame of
    // a linked layer participates; then copy → working.
    let original: Uint8ClampedArray;
    if (loc.cel) {
      original = loc.cel.buffer;
    } else {
      original = new Uint8ClampedArray(width * height * 4);
      const linked = loc.layer.linked;
      this.project = linked
        ? setCelEverywhereCompat(this.project, params.clipId, params.layerId, { buffer: original, linked: true })
        : setCelCompat(this.project, params.clipId, params.frameId, params.layerId, { buffer: original, linked: false });
    }
    const working = cloneBuffer(original);
    this.project = (loc.layer.linked
      ? setCelEverywhereCompat(this.project, params.clipId, params.layerId, { buffer: working, linked: true })
      : setCelCompat(this.project, params.clipId, params.frameId, params.layerId, { buffer: working, linked: false }));
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
  endStroke(label: string, changed: boolean, origin: CommandOrigin = 'ui'): StrokeCommitResult {
    const st = this.stroke;
    if (!st) throw new CommandError('INVALID_STATE', 'No stroke is active');
    const finish = (
      committed: boolean,
      extra?: Partial<StrokeCommitResult>,
      journal?: { commandType: string; payload: unknown }
    ): StrokeCommitResult => {
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
    const loc = locateCel(this.project, st.params.clipId, st.params.frameId, st.params.layerId);
    if (!loc) {
      // Structure changed underneath — discard, like the prototype did.
      return finish(false, { discarded: true });
    }
    const { width, height } = this.project;
    if (!changed) {
      // Restore the original buffer object — exact pre-stroke state.
      this.project = (loc.layer.linked
        ? setCelEverywhereCompat(this.project, st.params.clipId, st.params.layerId, { buffer: st.original, linked: true })
        : setCelCompat(this.project, st.params.clipId, st.params.frameId, st.params.layerId, { buffer: st.original, linked: false }));
      return finish(false);
    }
    const working = loc.cel ? loc.cel.buffer : new Uint8ClampedArray(width * height * 4);
    const tiles = extractTileDiff(st.original, working, width, height);
    if (tiles.length === 0) {
      this.project = (loc.layer.linked
        ? setCelEverywhereCompat(this.project, st.params.clipId, st.params.layerId, { buffer: st.original, linked: true })
        : setCelCompat(this.project, st.params.clipId, st.params.frameId, st.params.layerId, { buffer: st.original, linked: false }));
      return finish(false);
    }
    const entry = makePixelEntry(label, origin, {
      clipId: st.params.clipId,
      frameId: st.params.frameId,
      layerId: st.params.layerId,
      tiles,
    });
    if (this.txStack.length > 0) {
      throw new CommandError('TRANSACTION_CONFLICT', 'Stroke ended inside a transaction — impossible state');
    }
    this.engine.push(entry);
    this.dirty = true;
    this.project = (loc.layer.linked
      ? setCelEverywhereCompat(this.project, st.params.clipId, st.params.layerId, { buffer: working, linked: true })
      : setCelCompat(this.project, st.params.clipId, st.params.frameId, st.params.layerId, { buffer: working, linked: false }));
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
  cancelStroke(origin: CommandOrigin = 'ui'): void {
    const st = this.stroke;
    if (!st) throw new CommandError('INVALID_STATE', 'No stroke is active');
    this.stroke = null;
    const loc = locateCel(this.project, st.params.clipId, st.params.frameId, st.params.layerId);
    if (loc) {
      this.project = (loc.layer.linked
        ? setCelEverywhereCompat(this.project, st.params.clipId, st.params.layerId, { buffer: st.original, linked: true })
        : setCelCompat(this.project, st.params.clipId, st.params.frameId, st.params.layerId, { buffer: st.original, linked: false }));
    }
    this.emit({ reason: 'stroke-cancelled', project: this.project, origin });
  }

  get activeStroke(): boolean {
    return this.stroke !== null;
  }

  // -------------------------------------------------------------------------
  // undo / redo
  // -------------------------------------------------------------------------

  canUndo(): boolean {
    return this.engine.canUndo() && !this.stroke;
  }

  canRedo(): boolean {
    return this.engine.canRedo() && !this.stroke;
  }

  /**
   * Undo one history entry. Stale pixel entries (cel deleted) are dropped
   * and the walk continues to older entries. Throws when history is empty.
   */
  undo(): HistoryStepResult {
    if (this.stroke) {
      throw new CommandError('INVALID_STATE', 'Cannot undo while a stroke is active');
    }
    const step = this.engine.undo(this.project);
    if (!step) return { ok: false };
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

  redo(): HistoryStepResult {
    if (this.stroke) {
      throw new CommandError('INVALID_STATE', 'Cannot redo while a stroke is active');
    }
    const step = this.engine.redo(this.project);
    if (!step) return { ok: false };
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

  historyStats(): HistoryStats {
    return this.engine.stats();
  }

  /**
   * Drop all undo/redo history without touching the document. Used after a
   * journal replay / project load so the recovered document starts clean
   * (v3.1 §6 journal semantics; also the Task 4 load path).
   */
  resetHistory(): void {
    this.engine.clear();
  }

  setHistoryBudget(bytes: number): void {
    this.engine.setBudget(clampHistoryBudget(bytes));
  }

  private emit(event: ChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // A broken listener must not corrupt the bus; surface for debugging.
        // console is available in Node, Electron main/renderer, and tests.
        console.error('[pixelforge/core] change listener failed', err);
      }
    }
  }
}
