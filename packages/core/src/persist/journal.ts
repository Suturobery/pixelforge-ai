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
import { base64Decode, base64Encode } from './base64';
import { PersistError } from './errors';

export const JOURNAL_CAP = 200;

/**
 * Max cel byte size for stroke-commit journal records (Task 4): strokes on
 * canvases up to 128×128 (65536 buffer bytes) are journaled as replayable
 * setBuffer ops; larger strokes rely on the autosave snapshot (bounded JSONL
 * ring: 64 KB × 200 ≈ ≤ 13 MB worst case). Pure recovery policy — the
 * document model is unaffected.
 */
export const STROKE_JOURNAL_MAX_BYTES = 65_536;

/** One recorded command. `seq` increases monotonically per recorder. */
export interface JournalRecord {
  seq: number;
  ts: number;
  origin: CommandOrigin;
  commandType: string;
  payload: unknown;
}

// ---------------------------------------------------------------------------
// binary-safe JSON codec (payloads may embed Uint8ClampedArray)
// ---------------------------------------------------------------------------

const BUF_TAG = '__buf';
const TYPE_TAG = '__t';

export function encodeJsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v instanceof Uint8ClampedArray) {
      return { [BUF_TAG]: base64Encode(v), [TYPE_TAG]: 'u8c' };
    }
    if (v instanceof Uint8Array) {
      return { [BUF_TAG]: base64Encode(v), [TYPE_TAG]: 'u8' };
    }
    return v as unknown;
  });
}

export function decodeJsonSafe(text: string): unknown {
  return JSON.parse(text, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Record<string, unknown>)[BUF_TAG] === 'string') {
      const rec = v as Record<string, unknown>;
      const bytes = base64Decode(rec[BUF_TAG] as string);
      if (rec[TYPE_TAG] === 'u8c') {
        return new Uint8ClampedArray(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      }
      return bytes;
    }
    return v as unknown;
  });
}

// ---------------------------------------------------------------------------
// recorder
// ---------------------------------------------------------------------------

export interface JournalRecorderOptions {
  cap?: number;
  /** Called after each accepted record (sidecar flush hook, fire-and-forget). */
  onFlush?: (records: JournalRecord[]) => void;
  /** Called when a command is executed but not recordable. */
  onSkip?: (reason: string, event: ChangeEvent) => void;
}

export class JournalRecorder {
  private records: JournalRecord[] = [];
  private seq = 0;
  private readonly cap: number;
  private readonly onFlush?: (records: JournalRecord[]) => void;
  private readonly onSkip?: (reason: string, event: ChangeEvent) => void;
  private readonly unsubscribe: () => void;

  constructor(bus: CommandBus, opts: JournalRecorderOptions = {}) {
    this.cap = opts.cap ?? JOURNAL_CAP;
    this.onFlush = opts.onFlush;
    this.onSkip = opts.onSkip;
    this.unsubscribe = bus.onChange((event) => this.handle(event));
  }

  private handle(event: ChangeEvent): void {
    // A replaced document invalidates every prior record: the ring describes
    // the OLD project and must never replay onto the new one (Task 4 load path).
    if (event.reason === 'document-replaced') {
      this.clear();
      return;
    }
    const isCommand = event.reason === 'executed';
    // Task 4: committed strokes are journaled too (replayable setBuffer op).
    const isStrokeCommit = event.reason === 'stroke-committed';
    if (!isCommand && !isStrokeCommit) return;
    if (typeof event.commandType !== 'string') {
      this.onSkip?.('missing commandType', event);
      return;
    }
    if (event.payload === undefined) {
      this.onSkip?.('missing payload', event);
      return;
    }
    if (isStrokeCommit && !isReplayableStrokePayload(event.payload)) {
      this.onSkip?.('stroke payload not journalable (oversized/malformed) — covered by autosave', event);
      return;
    }
    this.seq += 1;
    this.records.push({
      seq: this.seq,
      ts: Date.now(),
      origin: event.origin ?? 'ui',
      commandType: event.commandType,
      payload: event.payload,
    });
    if (this.records.length > this.cap) {
      this.records.splice(0, this.records.length - this.cap);
    }
    this.onFlush?.(this.records);
  }

  /** Current ring (oldest first). */
  all(): JournalRecord[] {
    return [...this.records];
  }

  get lastSeq(): number {
    return this.seq;
  }

  get size(): number {
    return this.records.length;
  }

  /**
   * Drop all records WITHOUT resetting seq — horizons in already-written
   * manifests stay monotonic vs. any future ring contents.
   */
  clear(): void {
    this.records = [];
  }

  detach(): void {
    this.unsubscribe();
  }
}

function isReplayableStrokePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (typeof p['clipId'] !== 'string' || typeof p['frameId'] !== 'string' || typeof p['layerId'] !== 'string') return false;
  if (!Array.isArray(p['ops']) || p['ops'].length !== 1) return false;
  const op = p['ops'][0] as Record<string, unknown> | undefined;
  if (!op || op['op'] !== 'setBuffer') return false;
  const buf = op['buffer'];
  return buf instanceof Uint8ClampedArray && buf.byteLength <= STROKE_JOURNAL_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// (de)serialization + replay
// ---------------------------------------------------------------------------

export function recordsToLines(records: JournalRecord[]): string[] {
  return records.map((r) => encodeJsonSafe(r));
}

/** Tolerant parse: corrupt/truncated trailing lines are skipped (crash-safe). */
export function linesToRecords(lines: string[]): { records: JournalRecord[]; corruptLines: number } {
  const records: JournalRecord[] = [];
  let corruptLines = 0;
  for (const line of lines) {
    try {
      const parsed = decodeJsonSafe(line) as Partial<JournalRecord> | null;
      if (
        parsed &&
        typeof parsed.seq === 'number' &&
        typeof parsed.commandType === 'string' &&
        'payload' in parsed
      ) {
        records.push({
          seq: parsed.seq,
          ts: typeof parsed.ts === 'number' ? parsed.ts : 0,
          origin: (parsed.origin ?? 'ui') as CommandOrigin,
          commandType: parsed.commandType,
          payload: parsed.payload,
        });
      } else {
        corruptLines += 1;
      }
    } catch {
      corruptLines += 1;
    }
  }
  return { records, corruptLines };
}

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
export function replayJournal(
  project: Project,
  records: JournalRecord[],
  opts: { budgetBytes?: number } = {}
): ReplayResult {
  const bus = new CommandBus(project, { budgetBytes: opts.budgetBytes });
  let applied = 0;
  let skipped = 0;
  const skipReasons: string[] = [];

  for (const record of records) {
    try {
      bus.execute(record.commandType, record.payload, record.origin);
      applied += 1;
    } catch (err) {
      skipped += 1;
      if (skipReasons.length < 10) {
        skipReasons.push(
          `seq ${record.seq} ${record.commandType}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  const result = bus.getProject();
  bus.resetHistory();
  bus.markSaved();
  return { project: result, applied, skipped, skipReasons };
}

/** Convenience: build a replay error for callers that need it typed. */
export function replayError(message: string, cause?: unknown): PersistError {
  return new PersistError('REPLAY_FAILED', message, { cause });
}
