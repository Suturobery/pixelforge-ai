"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.JournalRecorder = exports.STROKE_JOURNAL_MAX_BYTES = exports.JOURNAL_CAP = void 0;
exports.encodeJsonSafe = encodeJsonSafe;
exports.decodeJsonSafe = decodeJsonSafe;
exports.recordsToLines = recordsToLines;
exports.linesToRecords = linesToRecords;
exports.replayJournal = replayJournal;
exports.replayError = replayError;
const bus_1 = require("../bus/bus");
const base64_1 = require("./base64");
const errors_1 = require("./errors");
exports.JOURNAL_CAP = 200;
/**
 * Max cel byte size for stroke-commit journal records (Task 4): strokes on
 * canvases up to 128×128 (65536 buffer bytes) are journaled as replayable
 * setBuffer ops; larger strokes rely on the autosave snapshot (bounded JSONL
 * ring: 64 KB × 200 ≈ ≤ 13 MB worst case). Pure recovery policy — the
 * document model is unaffected.
 */
exports.STROKE_JOURNAL_MAX_BYTES = 65_536;
// ---------------------------------------------------------------------------
// binary-safe JSON codec (payloads may embed Uint8ClampedArray)
// ---------------------------------------------------------------------------
const BUF_TAG = '__buf';
const TYPE_TAG = '__t';
function encodeJsonSafe(value) {
    return JSON.stringify(value, (_key, v) => {
        if (v instanceof Uint8ClampedArray) {
            return { [BUF_TAG]: (0, base64_1.base64Encode)(v), [TYPE_TAG]: 'u8c' };
        }
        if (v instanceof Uint8Array) {
            return { [BUF_TAG]: (0, base64_1.base64Encode)(v), [TYPE_TAG]: 'u8' };
        }
        return v;
    });
}
function decodeJsonSafe(text) {
    return JSON.parse(text, (_key, v) => {
        if (v && typeof v === 'object' && !Array.isArray(v) && typeof v[BUF_TAG] === 'string') {
            const rec = v;
            const bytes = (0, base64_1.base64Decode)(rec[BUF_TAG]);
            if (rec[TYPE_TAG] === 'u8c') {
                return new Uint8ClampedArray(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
            }
            return bytes;
        }
        return v;
    });
}
class JournalRecorder {
    records = [];
    seq = 0;
    cap;
    onFlush;
    onSkip;
    unsubscribe;
    constructor(bus, opts = {}) {
        this.cap = opts.cap ?? exports.JOURNAL_CAP;
        this.onFlush = opts.onFlush;
        this.onSkip = opts.onSkip;
        this.unsubscribe = bus.onChange((event) => this.handle(event));
    }
    handle(event) {
        // A replaced document invalidates every prior record: the ring describes
        // the OLD project and must never replay onto the new one (Task 4 load path).
        if (event.reason === 'document-replaced') {
            this.clear();
            return;
        }
        const isCommand = event.reason === 'executed';
        // Task 4: committed strokes are journaled too (replayable setBuffer op).
        const isStrokeCommit = event.reason === 'stroke-committed';
        if (!isCommand && !isStrokeCommit)
            return;
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
    all() {
        return [...this.records];
    }
    get lastSeq() {
        return this.seq;
    }
    get size() {
        return this.records.length;
    }
    /**
     * Drop all records WITHOUT resetting seq — horizons in already-written
     * manifests stay monotonic vs. any future ring contents.
     */
    clear() {
        this.records = [];
    }
    detach() {
        this.unsubscribe();
    }
}
exports.JournalRecorder = JournalRecorder;
function isReplayableStrokePayload(payload) {
    if (!payload || typeof payload !== 'object')
        return false;
    const p = payload;
    if (typeof p['clipId'] !== 'string' || typeof p['frameId'] !== 'string' || typeof p['layerId'] !== 'string')
        return false;
    if (!Array.isArray(p['ops']) || p['ops'].length !== 1)
        return false;
    const op = p['ops'][0];
    if (!op || op['op'] !== 'setBuffer')
        return false;
    const buf = op['buffer'];
    return buf instanceof Uint8ClampedArray && buf.byteLength <= exports.STROKE_JOURNAL_MAX_BYTES;
}
// ---------------------------------------------------------------------------
// (de)serialization + replay
// ---------------------------------------------------------------------------
function recordsToLines(records) {
    return records.map((r) => encodeJsonSafe(r));
}
/** Tolerant parse: corrupt/truncated trailing lines are skipped (crash-safe). */
function linesToRecords(lines) {
    const records = [];
    let corruptLines = 0;
    for (const line of lines) {
        try {
            const parsed = decodeJsonSafe(line);
            if (parsed &&
                typeof parsed.seq === 'number' &&
                typeof parsed.commandType === 'string' &&
                'payload' in parsed) {
                records.push({
                    seq: parsed.seq,
                    ts: typeof parsed.ts === 'number' ? parsed.ts : 0,
                    origin: (parsed.origin ?? 'ui'),
                    commandType: parsed.commandType,
                    payload: parsed.payload,
                });
            }
            else {
                corruptLines += 1;
            }
        }
        catch {
            corruptLines += 1;
        }
    }
    return { records, corruptLines };
}
/**
 * Replay journal records onto a recovered project through a fresh CommandBus.
 * History is cleared afterwards so the recovered document starts clean; the
 * document is marked dirty (it contains un-saved-to-file commands).
 */
function replayJournal(project, records, opts = {}) {
    const bus = new bus_1.CommandBus(project, { budgetBytes: opts.budgetBytes });
    let applied = 0;
    let skipped = 0;
    const skipReasons = [];
    for (const record of records) {
        try {
            bus.execute(record.commandType, record.payload, record.origin);
            applied += 1;
        }
        catch (err) {
            skipped += 1;
            if (skipReasons.length < 10) {
                skipReasons.push(`seq ${record.seq} ${record.commandType}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    const result = bus.getProject();
    bus.resetHistory();
    bus.markSaved();
    return { project: result, applied, skipped, skipReasons };
}
/** Convenience: build a replay error for callers that need it typed. */
function replayError(message, cause) {
    return new errors_1.PersistError('REPLAY_FAILED', message, { cause });
}
