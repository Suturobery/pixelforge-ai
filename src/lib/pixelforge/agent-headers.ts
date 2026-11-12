// PixelForge AI — client-safe agent guard constants.
//
// Kept free of `next/server` imports so client components can include the
// guard header in their fetches without pulling server-only modules into the
// browser bundle. The server-side enforcement lives in api-guard.ts.

/** Custom header required on state-changing API calls (CSRF tripwire). */
export const AGENT_HEADER = 'x-pixelforge-agent';

/** Shared fetch headers for in-app clients so every mutation call passes the guard. */
export const AGENT_FETCH_HEADERS: Record<string, string> = {
  'X-PixelForge-Agent': '1',
};

/**
 * Real (optional) web-deployment auth, audit finding S1: when the server sets
 * PF_WEB_TOKEN, every guarded route additionally requires
 * `Authorization: Bearer <token>`. Pure client-safe check; enforcement lives
 * in api-guard.ts. No token configured (local dev / desktop) → legacy
 * tripwire behavior unchanged. Plain comparison by design — the threat model
 * is drive-by pages, not timing attacks; use a constant-time compare before
 * full internet exposure.
 */
export function checkWebToken(authHeader: string | null | undefined, expected: string | undefined): boolean {
  if (expected === undefined || expected === '') return true
  if (!authHeader) return false
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
  return match?.[1] === expected
}
