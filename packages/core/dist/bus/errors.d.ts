/**
 * Typed command errors (v3.1 §8.4: "typed error codes across bridge").
 * The bus throws these; Task 4 maps them to toasts, Task 8 maps them to
 * structured MCP errors.
 */
export type CommandErrorCode = 'UNKNOWN_COMMAND' | 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE' | 'TRANSACTION_CONFLICT';
export declare class CommandError extends Error {
    readonly code: CommandErrorCode;
    readonly details?: unknown;
    constructor(code: CommandErrorCode, message: string, details?: unknown);
}
/** Validation helper — throw a VALIDATION_FAILED error. */
export declare function fail(message: string, details?: unknown): never;
export declare function failNotFound(message: string, details?: unknown): never;
