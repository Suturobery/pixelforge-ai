/**
 * Command envelope & bus contracts (v3.1 §2.5).
 *
 * Every document mutation — UI, AI, or MCP — goes through the CommandBus
 * (v1 §03 separation-of-concerns, enforced in code). There is no separate
 * AI/MCP mutation path.
 */

import type { Project, RGBA } from './document';
import type { TileDiff } from './history';

/** Where a command came from — recorded on every history entry. */
export type CommandOrigin = 'ui' | 'mcp' | 'ai';

/** Immutable view of the document handed to command validate/apply. */
export interface CommandContext {
  /** Document BEFORE the command runs. Never mutate; return a new one. */
  project: Project;
  width: number;
  height: number;
}

/**
 * Tile-diff payload produced by pixel-editing commands: which 16×16 tiles
 * changed, with before/after bytes (v3.1 §2.5).
 */
export interface PixelHistoryData {
  clipId: string;
  frameId: string;
  layerId: string;
  tiles: TileDiff[];
}

/** What a command's apply() returns. */
export interface ApplyOutcome {
  /** New document after applying (previous document object left untouched). */
  project: Project;
  /** Label override for history; falls back to the definition's defaultLabel. */
  label?: string;
  /**
   * When present, the bus records a tile-diff history entry (pixel edit).
   * When absent, the bus records a structural snapshot entry.
   */
  pixels?: PixelHistoryData;
}

/**
 * A registered command. Validation must throw CommandError on bad payloads;
 * apply must be pure: (document in) → (new document out). Purity is what
 * makes failed-command rollback and transaction grouping safe.
 */
export interface CommandDefinition<P = unknown> {
  /** Unique command type, e.g. "frame.add". */
  type: string;
  /** Default history label. */
  defaultLabel: string;
  validate(payload: P, ctx: CommandContext): void;
  apply(payload: P, ctx: CommandContext): ApplyOutcome;
}

/** Loosely-typed registration shape (payload validated at runtime). */
export type AnyCommandDefinition = CommandDefinition<any> & {
  validate: (payload: any, ctx: CommandContext) => void;
  apply: (payload: any, ctx: CommandContext) => ApplyOutcome;
};

/** Document change notification (renderer subscribes; Task 4 store shim). */
export interface ChangeEvent {
  reason:
    | 'executed'
    | 'undone'
    | 'redone'
    | 'stroke-started'
    | 'stroke-committed'
    | 'stroke-cancelled'
    | 'transaction-rolled-back'
    | 'document-replaced';
  project: Project;
  label?: string;
  origin?: CommandOrigin;
  commandType?: string;
  /** The validated payload of an executed command (journal/provenance consumers). */
  payload?: unknown;
  /** True when a history entry was produced by this change. */
  historyChanged?: boolean;
}

export type ChangeListener = (event: ChangeEvent) => void;

export function unsubscribe(): void {}

/** Stroke handle — same shape as the prototype store's StrokeHandle. */
export interface StrokeHandle {
  width: number;
  height: number;
  /** Working buffer to draw into (copy-on-write; committed at endStroke). */
  buffer: Uint8ClampedArray;
}

export interface StrokeParams {
  clipId: string;
  frameId: string;
  layerId: string;
}

export interface StrokeCommitResult {
  committed: boolean;
  /** Present when committed — id of the produced history entry. */
  entryId?: string;
  /** True when the stroke target (cel) vanished mid-stroke and the stroke was discarded. */
  discarded?: boolean;
}

/** Result of undo()/redo(). */
export interface HistoryStepResult {
  ok: boolean;
  label?: string;
  origin?: CommandOrigin;
  /** True when entries were skipped because their target cels no longer exist. */
  skipped?: number;
}
