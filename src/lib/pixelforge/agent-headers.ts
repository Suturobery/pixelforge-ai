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
