// PixelForge AI — legacy REST operation log: RETIRED (Task 8, v3.1 §5).
// The MCP server keeps the authoritative audit log (db/mcp-ops.jsonl);
// get_operation_log is an MCP L0 tool. See ./run/route.ts for context.

import { retiredMcpResponse } from '@/lib/pixelforge/retired-mcp-response'

export async function GET(): Promise<Response> {
  return retiredMcpResponse()
}
