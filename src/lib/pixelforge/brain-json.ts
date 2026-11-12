// JSON-mode helpers shared by the Second Brain API paths.

export type JsonObject = Record<string, unknown>

/**
 * Prompt wording alone is not enough to make a reasoning model emit JSON: it
 * can return prose, or spend its completion budget before producing a final
 * answer. Groq's JSON Object Mode guarantees a syntactically valid object;
 * GPT-OSS additionally benefits from low effort for these compact,
 * machine-to-machine responses.
 */
export function structuredBrainOptions(model: string): JsonObject {
  return {
    response_format: { type: 'json_object' },
    ...(model.startsWith('openai/gpt-oss-') ? { reasoning_effort: 'low' } : {}),
  }
}

/**
 * Parse a complete JSON-mode response, with a narrow backwards-compatible
 * fallback for older provider proxies that wrap the object in a Markdown
 * fence. Deliberately do not search arbitrary prose for `{…}`: that old
 * greedy approach could consume text between unrelated braces.
 */
export function parseJsonObject(text: string): JsonObject | null {
  const trimmed = text.trim()
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim(),
  ]
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject
    } catch {
      // Try the next compatibility form.
    }
  }
  return null
}

export function noJsonError(area: 'Interpreter' | 'Planner', finishReason?: string): string {
  const suffix = finishReason === 'length' ? ' Groq reached its output limit; try a shorter request.' : ''
  return `${area} returned an invalid structured response.${suffix}`
}

/**
 * Strip control characters from model/planner text destined for the task
 * board or other machine surfaces (prompt-injection hardening: no invisible
 * instruction channels). Moved here from the route so the server service and
 * tests share one implementation.
 */
export function sanitizeBoardText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * S2 hardening: an optional SERVER-SIDE reasoning key. When PF_GROQ_KEY is
 * set in the process serving /api/ai/brain, clients may omit the provider
 * key entirely — the browser then never stores or transmits a secret.
 * Priority: explicit inline key (desktop vault injection, browser-saved key)
 * wins so the desktop vault path stays authoritative; env is the fallback.
 */
export function resolveBrainApiKey(inline: unknown): string {
  const inlineKey = typeof inline === 'string' ? inline.trim() : ''
  if (inlineKey) return inlineKey
  return (process.env.PF_GROQ_KEY ?? '').trim()
}
