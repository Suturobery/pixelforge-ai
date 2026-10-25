// PixelForge AI — legacy REST tool runner: RETIRED (Task 8, v3.1 §5).
//
// This endpoint executed 9 unauthenticated tools against the web-testbed
// Prisma store — a SEPARATE editor state outside the CommandBus (the exact
// anti-pattern Task 8 §4 forbids) and an unprotected backdoor per the MCP
// security assessment. It is now 410 Gone: the real Model Context Protocol
// server (mini-services/mcp-server, 127.0.0.1:3030, Bearer pairing + L0/L1
// tiers) replaces it, and every document edit goes through the SAME
// CommandBus as manual editing.

import { NextResponse } from 'next/server'

export const RETIREMENT_NOTICE = {
  ok: false,
  error: {
    code: 'MCP_RETIRED',
    message:
      'The REST tool prototype was retired in Task 8. Use the real MCP server instead: it speaks the Model Context Protocol, authenticates clients via pairing, and enforces permission tiers.',
    hint: 'Endpoint: http://127.0.0.1:3030/mcp (Streamable HTTP) or mini-services/mcp-server/src/stdio-proxy.ts (stdio). Pair in Settings → MCP → Connect AI Assistant.',
  },
} as const

export function retiredResponse(): NextResponse {
  return NextResponse.json(RETIREMENT_NOTICE, { status: 410 })
}

export async function POST(): Promise<NextResponse> {
  return retiredResponse()
}

export async function GET(): Promise<NextResponse> {
  return retiredResponse()
}
