// PixelForge AI — legacy REST tool runner: RETIRED (Task 8, v3.1 §5).
//
// This endpoint executed 9 unauthenticated tools against the web-testbed
// Prisma store — a SEPARATE editor state outside the CommandBus (the exact
// anti-pattern Task 8 §4 forbids) and an unprotected backdoor per the MCP
// security assessment. It is now 410 Gone: the real Model Context Protocol
// server (mini-services/mcp-server, 127.0.0.1:3030, Bearer pairing + L0/L1
// tiers) replaces it, and every document edit goes through the SAME
// CommandBus as manual editing.

import { retiredMcpResponse } from '@/lib/pixelforge/retired-mcp-response'

export async function POST(): Promise<Response> {
  return retiredMcpResponse()
}

export async function GET(): Promise<Response> {
  return retiredMcpResponse()
}
