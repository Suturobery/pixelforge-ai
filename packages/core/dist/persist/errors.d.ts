/**
 * Persistence error taxonomy (v3.1 §6 / §9.3 "corrupted-file error handling").
 *
 * Every failure mode of the .pixelforgeproj pipeline maps to a typed code so
 * callers (renderer, main process, CLI) can react precisely — e.g. offer
 * journal replay on a truncated main file, or fall back to a backup on
 * BAD_CHECKSUM. All errors carry the offending entry/path when known.
 */
export type PersistErrorCode = 'NOT_FOUND' | 'BAD_ZIP' | 'BAD_CHECKSUM' | 'UNSUPPORTED_VERSION' | 'MISSING_ENTRY' | 'INVALID_SCHEMA' | 'UNSAFE_PATH' | 'DUPLICATE_ENTRY' | 'DECODE_FAILED' | 'ENCODE_FAILED' | 'FS_ERROR' | 'REPLAY_FAILED';
export declare class PersistError extends Error {
    readonly code: PersistErrorCode;
    readonly entry?: string;
    /** Non-fatal issues gathered before the error was raised, when available. */
    readonly issues?: PersistIssue[];
    constructor(code: PersistErrorCode, message?: string, opts?: {
        entry?: string;
        cause?: unknown;
        issues?: PersistIssue[];
    });
}
/** One structural problem found during schema validation (non-throwing report item). */
export interface PersistIssue {
    /** Dotted path into the serialized document, e.g. "clips[0].frames[1].cels". */
    path: string;
    code: PersistErrorCode;
    message: string;
}
