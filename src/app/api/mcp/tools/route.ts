// PixelForge AI — legacy REST tool catalog: RETIRED (Task 8, v3.1 §5).
// The real MCP server advertises its own tool list via the protocol
// (tools/list). See ./run/route.ts for the full retirement rationale.

import { retiredMcpResponse } from '@/lib/pixelforge/retired-mcp-response'

export async function GET(): Promise<Response> {
  return retiredMcpResponse()
}
