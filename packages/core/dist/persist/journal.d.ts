/**
 * Command journal — crash recovery + provenance foundation (v3.1 §6, §9.3).
 *
 * Recording: a JournalRecorder subscribes to the bus and captures every
 * executed command ({seq, ts, origin, commandType, payload}), keeping a ring
 * of the last 200 records (§6). Payloads are JSON-encoded with binary-safe
 * tagging (Uint8ClampedArray → {__buf: base64}) so pixel ops that embed
 * whole buffers survive the round trip.
 *
 * Storage: the store layer persists the ring as JSONL — embedded in the
 * archive at save time (history/journal.jsonl) and mirrored to a sidecar
 * file (<file>.journal) after each flush, so commands issued after the last
 * save are recoverable.
 *
 * Replay: replays records through a fresh CommandBus (identical validation
 * and semantics), then clears history so the recovered document starts
 * clean. Unknown/failing records are skipped and reported — never fatal,
 * because the journal is a best-effort recovery source by design.
 */
import { CommandBus } from '../bus/bus';
import type { ChangeEvent, CommandOrigin } from '../types/commands';
import type { Project } from '../types/document';
import { PersistError } from './errors';
export declare const JOURNAL_CAP = 200;
/**
 * Max cel byte size for stroke-commit journal records (Task 4): strokes on
 * canvases up to 128×128 (65536 buffer bytes) are journaled as replayable
 * setBuffer ops; larger strokes rely on the autosave snapshot (bounded JSONL
 * ring: 64 KB × 200 ≈ ≤ 13 MB worst case). Pure recovery policy — the
 * document model is unaffected.
 */
export declare const STROKE_JOURNAL_MAX_BYTES = 65536;
/** One recorded command. `seq` increases monotonically per recorder. */
export interface JournalRecord {
    seq: number;
    ts: number;
    origin: CommandOrigin;
    commandType: string;
    payload: unknown;
}
export declare function encodeJsonSafe(value: unknown): string;
export declare function decodeJsonSafe(text: string): unknown;
export interface JournalRecorderOptions {
    cap?: number;
    /** Called after each accepted record (sidecar flush hook, fire-and-forget). */
    onFlush?: (records: JournalRecord[]) => void;
    /** Called when a command is executed but not recordable. */
    onSkip?: (reason: string, event: ChangeEvent) => void;
}
export declare class JournalRecorder {
    private records;
    private seq;
    private readonly cap;
    private readonly onFlush?;
    private readonly onSkip?;
    private readonly unsubscribe;
    constructor(bus: CommandBus, opts?: JournalRecorderOptions);
    private handle;
    /** Current ring (oldest first). */
    all(): JournalRecord[];
    get lastSeq(): number;
    get size(): number;
    /**
     * Drop all records WITHOUT resetting seq — horizons in already-written
     * manifests stay monotonic vs. any future ring contents.
     */
    clear(): void;
    detach(): void;
}
export declare function recordsToLines(records: JournalRecord[]): string[];
/** Tolerant parse: corrupt/truncated trailing lines are skipped (crash-safe). */
export declare function linesToRecords(lines: string[]): {
    records: JournalRecord[];
    corruptLines: number;
};
export interface ReplayResult {
    project: Project;
    applied: number;
    skipped: number;
    /** Human-readable reasons for skipped records (first 10). */
    skipReasons: string[];
}
/**
 * Replay journal records onto a recovered project through a fresh CommandBus.
 * History is cleared afterwards so the recovered document starts clean; the
 * document is marked dirty (it contains un-saved-to-file commands).
 */
export declare function replayJournal(project: Project, records: JournalRecord[], opts?: {
    budgetBytes?: number;
}): ReplayResult;
/** Convenience: build a replay error for callers that need it typed. */
export declare function replayError(message: string, cause?: unknown): PersistError;
