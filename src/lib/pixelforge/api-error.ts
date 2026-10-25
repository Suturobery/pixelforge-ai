// PixelForge AI — client-safe formatting of API error payloads.
//
// The api-guard and some validation paths return `error` as a STRUCTURED
// object ({ code, message, hint }) while other paths return a plain string.
// Naive interpolation of the object form produced the infamous
// "[object Object]" toast (Save failed · [object Object] — user report).
// Every consumer of these API shapes formats through this helper.

export interface ApiErrorMessage {
  message: string
  hint?: string
}

/**
 * Normalize an API `error` value (string | { code?, message?, hint?} |
 * anything else) into a displayable message + optional hint.
 */
export function describeApiError(value: unknown, fallback = 'Request failed'): ApiErrorMessage {
  if (typeof value === 'string' && value.trim()) {
    return { message: value }
  }
  if (value && typeof value === 'object') {
    const e = value as { code?: unknown; message?: unknown; hint?: unknown }
    const message =
      typeof e.message === 'string' && e.message.trim()
        ? e.message
        : typeof e.code === 'string' && e.code.trim()
          ? e.code
          : fallback
    const hint = typeof e.hint === 'string' && e.hint.trim() ? e.hint : undefined
    return { message, hint }
  }
  return { message: fallback }
}

/** Message + hint joined for single-line displays (toasts, list rows). */
export function describeApiErrorInline(value: unknown, fallback = 'Request failed'): string {
  const { message, hint } = describeApiError(value, fallback)
  return hint ? `${message} — ${hint}` : message
}
