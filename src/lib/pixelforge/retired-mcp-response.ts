import { NextResponse } from 'next/server'

export const RETIRED_MCP_RESPONSE = {
  ok: false,
  error: {
    code: 'MCP_RETIRED',
    message:
      'The REST tool prototype was retired in Task 8. Use the real MCP server instead: it speaks the Model Context Protocol, authenticates clients via pairing, and enforces permission tiers.',
    hint: 'Endpoint: http://127.0.0.1:3030/mcp (Streamable HTTP) or mini-services/mcp-server/src/stdio-proxy.ts (stdio). Pair in Settings → MCP → Connect AI Assistant.',
  },
} as const

/** Shared 410 response for retired REST compatibility routes.
 * Kept outside app/api so Next route-module export validation stays strict. */
export function retiredMcpResponse(): NextResponse {
  return NextResponse.json(RETIRED_MCP_RESPONSE, { status: 410 })
}
