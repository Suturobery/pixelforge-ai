import { NextResponse } from 'next/server'

// Retired: this legacy route used the machine's built-in Z.AI configuration
// without authentication or quota controls. Generation now goes through the
// guarded /api/ai/sprite route or the desktop main-process AI service.
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    { ok: false, error: 'This legacy generation endpoint is disabled. Use the PixelForge AI panel instead.' },
    { status: 410 },
  )
}
