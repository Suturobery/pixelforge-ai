"use strict";
/**
 * Typed command errors (v3.1 §8.4: "typed error codes across bridge").
 * The bus throws these; Task 4 maps them to toasts, Task 8 maps them to
 * structured MCP errors.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommandError = void 0;
exports.fail = fail;
exports.failNotFound = failNotFound;
class CommandError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = 'CommandError';
        this.code = code;
        this.details = details;
    }
}
exports.CommandError = CommandError;
/** Validation helper — throw a VALIDATION_FAILED error. */
function fail(message, details) {
    throw new CommandError('VALIDATION_FAILED', message, details);
}
function failNotFound(message, details) {
    throw new CommandError('NOT_FOUND', message, details);
}
