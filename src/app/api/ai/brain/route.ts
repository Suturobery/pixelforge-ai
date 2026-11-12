// PixelForge AI — "Second brain" HTTP route. Transport-only: the shared
// Brain service lives in brain-server.ts so the web route, the desktop
// bridge and future MCP adapters execute the same logic.

import { NextRequest, NextResponse } from 'next/server'
import { guardStateChange } from '@/lib/pixelforge/api-guard'
import { handleBrainPost } from '@/lib/pixelforge/brain-server'

export async function POST(req: NextRequest): Promise<NextResponse> {
  // quota-spending in BOTH modes — same tripwire as image generation
  const denied = guardStateChange(req)
  if (denied) return denied

  const body: unknown = await req.json().catch(() => ({}))
  return handleBrainPost(body)
}
