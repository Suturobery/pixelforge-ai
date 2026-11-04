// PixelForge AI — interim state-change guard for state-mutating API routes.
//
// Context (see download/PixelForge_AI_MCP_Security_Assessment.md): the
// web-testbed REST surface executes tools and project mutations without
// authentication. The full fix (token pairing, allowlist, permission tiers,
// loopback-only bind) lands with the Task 8 MCP server per v3.1 §5. This
// module is the smallest immediate hardening that does not preempt Task 8:
//
//   1. Origin check (proxy-tolerant, CSRF-tripwire only) — browsers attach
//      `Origin` to cross-origin requests (and to most same-origin POSTs).
//      The studio runs behind proxy chains (sandbox gateway / preview
//      embed) where the externally visible origin does NOT always equal
//      the internal Host header, so a strict Host comparison breaks the
//      app's own UI (user report: every save 403'd with UNTRUSTED_ORIGIN).
//      Therefore the origin leg only adds a DIAGNOSTIC denial for requests
//      that BOTH carry a parseable, non-null Origin AND already failed the
//      header tripwire — the load-bearing gate is and stays step 2 (a
//      drive-by page cannot attach the custom header without a successful
//      CORS preflight, and these routes never answer preflights). Requests
//      carrying the tripwire header pass regardless of proxy topology,
//      exactly like non-browser agent clients.
//   2. Custom header `X-PixelForge-Agent` — the actual tripwire. This is
//      opportunistic hardening, NOT authentication (Task 8 owns the real
//      token pairing + permission tiers).
//
// Task 4 security preflight (v3.1 §12 Task 4 mandate): the same tripwire now
// also covers READ endpoints and cost-bearing AI operations — project data
// (full pixel content, usage logs) must not be silently exfiltrable by any
// network peer or drive-by page. Same mechanism, same residual-risk note:
// this is opportunistic hardening, NOT authentication (Task 8).

import { NextRequest, NextResponse } from 'next/server'
import { AGENT_HEADER } from './agent-headers'

export { AGENT_HEADER, AGENT_FETCH_HEADERS } from './agent-headers'

export type GuardErrorCode = 'UNTRUSTED_ORIGIN' | 'MISSING_AGENT_HEADER' | 'LOCAL_ONLY'

function deny(code: GuardErrorCode, message: string, hint: string): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code, message, hint } },
    { status: 403 }
  )
}

/**
 * Returns a 403 response when the request fails the interim guard, or null
 * when the request may proceed. Apply to every state-changing handler
 * (POST/PUT/DELETE) in /api/mcp/run, /api/projects, /api/projects/[id],
 * /api/ai/sprite.
 */
export function guardStateChange(req: NextRequest): NextResponse | null {
  // These routes hold anonymous local-project data and can trigger paid AI.
  // There is no account/tenant model for safely exposing them to the internet,
  // so fail closed outside localhost. The packaged Electron renderer is served
  // from 127.0.0.1 and continues to work normally.
  const host = (req.headers.get('host') ?? '').toLowerCase()
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
    return deny(
      'LOCAL_ONLY',
      'This local-first API is available only on localhost.',
      'Use the packaged desktop app, or add authenticated multi-user API routes before deploying it publicly.',
    )
  }
  const agentOk = req.headers.get(AGENT_HEADER) === '1'

  // 1) Origin diagnostics (NOT the gate — see module header): when a request
  // already fails the header tripwire AND carries a real, parseable,
  // non-null Origin that matches neither the internal Host nor the forwarded
  // host chain, report the more precise UNTRUSTED_ORIGIN instead of the
  // generic missing-header error. Proxy-embedded UI requests carry the
  // header and therefore never reach this branch.
  const origin = req.headers.get('origin')
  if (!agentOk && origin && origin !== 'null') {
    let originHost: string | null = null
    try {
      originHost = new URL(origin).host.toLowerCase()
    } catch {
      originHost = null
    }
    if (originHost) {
      const knownHosts = [
        req.headers.get('host'),
        req.headers.get('x-forwarded-host')?.split(',')[0]?.trim(),
      ]
        .filter((h): h is string => typeof h === 'string' && h.length > 0)
        .map((h) => h.toLowerCase())
      if (!knownHosts.includes(originHost)) {
        return deny(
          'UNTRUSTED_ORIGIN',
          'Cross-origin state changes are rejected by this endpoint',
          'Call PixelForge APIs from the app UI or an agent client that sends the X-PixelForge-Agent header.'
        )
      }
    }
  }

  // 2) Custom-header tripwire — the load-bearing gate (cross-origin pages
  // cannot set it without a CORS preflight these routes never answer).
  if (!agentOk) {
    return deny(
      'MISSING_AGENT_HEADER',
      `Requests to this endpoint must include the ${AGENT_HEADER} header`,
      'Add "X-PixelForge-Agent: 1" to request headers. Full agent authentication (pairing + tiers) arrives with the Task 8 MCP server.'
    )
  }

  return null
}

/**
 * Read-endpoint guard (Task 4 preflight): same origin + header tripwire as
 * state changes, applied to GET handlers that expose project content or
 * operational history. In-app clients send the header via
 * AGENT_FETCH_HEADERS; same-origin fetches never preflight, so this stays
 * transparent for the UI while blocking cross-origin reads and drive-by
 * URL navigation (browsers cannot attach the header to address-bar GETs).
 */
export function guardRead(req: NextRequest): NextResponse | null {
  return guardStateChange(req)
}
