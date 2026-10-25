/**
 * Persistence error taxonomy (v3.1 §6 / §9.3 "corrupted-file error handling").
 *
 * Every failure mode of the .pixelforgeproj pipeline maps to a typed code so
 * callers (renderer, main process, CLI) can react precisely — e.g. offer
 * journal replay on a truncated main file, or fall back to a backup on
 * BAD_CHECKSUM. All errors carry the offending entry/path when known.
 */

export type PersistErrorCode =
  | 'NOT_FOUND'
  | 'BAD_ZIP'
  | 'BAD_CHECKSUM'
  | 'UNSUPPORTED_VERSION'
  | 'MISSING_ENTRY'
  | 'INVALID_SCHEMA'
  | 'UNSAFE_PATH'
  | 'DUPLICATE_ENTRY'
  | 'DECODE_FAILED'
  | 'ENCODE_FAILED'
  | 'FS_ERROR'
  | 'REPLAY_FAILED';

const CODE_MESSAGE: Record<PersistErrorCode, string> = {
  NOT_FOUND: 'File not found',
  BAD_ZIP: 'Archive is corrupt or not a ZIP container',
  BAD_CHECKSUM: 'Entry checksum mismatch — the file was modified or damaged',
  UNSUPPORTED_VERSION: 'File format version not supported by this build',
  MISSING_ENTRY: 'Required archive entry is missing',
  INVALID_SCHEMA: 'Document structure is invalid',
  UNSAFE_PATH: 'Archive entry path is unsafe',
  DUPLICATE_ENTRY: 'Archive contains duplicate entries',
  DECODE_FAILED: 'PNG data could not be decoded',
  ENCODE_FAILED: 'PNG data could not be encoded',
  FS_ERROR: 'File system operation failed',
  REPLAY_FAILED: 'Journal replay could not be completed',
};

export class PersistError extends Error {
  readonly code: PersistErrorCode;
  readonly entry?: string;
  /** Non-fatal issues gathered before the error was raised, when available. */
  readonly issues?: PersistIssue[];

  constructor(
    code: PersistErrorCode,
    message?: string,
    opts: { entry?: string; cause?: unknown; issues?: PersistIssue[] } = {}
  ) {
    super(message ? `${CODE_MESSAGE[code]}: ${message}` : CODE_MESSAGE[code]);
    this.name = 'PersistError';
    this.code = code;
    this.entry = opts.entry;
    this.issues = opts.issues;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

/** One structural problem found during schema validation (non-throwing report item). */
export interface PersistIssue {
  /** Dotted path into the serialized document, e.g. "clips[0].frames[1].cels". */
  path: string;
  code: PersistErrorCode;
  message: string;
}
