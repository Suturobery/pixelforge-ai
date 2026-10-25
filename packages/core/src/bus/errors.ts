/**
 * Typed command errors (v3.1 §8.4: "typed error codes across bridge").
 * The bus throws these; Task 4 maps them to toasts, Task 8 maps them to
 * structured MCP errors.
 */

export type CommandErrorCode =
  | 'UNKNOWN_COMMAND'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'TRANSACTION_CONFLICT';

export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly details?: unknown;

  constructor(code: CommandErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.details = details;
  }
}

/** Validation helper — throw a VALIDATION_FAILED error. */
export function fail(message: string, details?: unknown): never {
  throw new CommandError('VALIDATION_FAILED', message, details);
}

export function failNotFound(message: string, details?: unknown): never {
  throw new CommandError('NOT_FOUND', message, details);
}
