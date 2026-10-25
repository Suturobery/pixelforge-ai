"use strict";
/**
 * Persistence error taxonomy (v3.1 §6 / §9.3 "corrupted-file error handling").
 *
 * Every failure mode of the .pixelforgeproj pipeline maps to a typed code so
 * callers (renderer, main process, CLI) can react precisely — e.g. offer
 * journal replay on a truncated main file, or fall back to a backup on
 * BAD_CHECKSUM. All errors carry the offending entry/path when known.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersistError = void 0;
const CODE_MESSAGE = {
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
class PersistError extends Error {
    code;
    entry;
    /** Non-fatal issues gathered before the error was raised, when available. */
    issues;
    constructor(code, message, opts = {}) {
        super(message ? `${CODE_MESSAGE[code]}: ${message}` : CODE_MESSAGE[code]);
        this.name = 'PersistError';
        this.code = code;
        this.entry = opts.entry;
        this.issues = opts.issues;
        if (opts.cause !== undefined) {
            this.cause = opts.cause;
        }
    }
}
exports.PersistError = PersistError;
