// PixelForge AI — editor-link auth key for the REAL editor page.
//
// The MCP server persists a random editor token (mini-services/mcp-server/
// src/editor-auth.ts) in its data dir. This route hands it to the editor
// page — local connections only, same guard as every other app API. A
// remote page can never reach it (loopback bind + local-only guard), and a
// local drive-by cannot guess it (32-byte random).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { guardRead } from '@/lib/pixelforge/api-guard';

function dataDir(): string {
  return process.env.PF_MCP_DATA_DIR ?? join(process.cwd(), 'db');
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = guardRead(req);
  if (denied) return denied;
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir(), 'editor-auth.json'), 'utf8')) as { token?: unknown };
    if (typeof parsed.token === 'string' && parsed.token.length >= 32) {
      return NextResponse.json({ ok: true, key: parsed.token });
    }
  } catch {
    /* server not started yet or file unreadable */
  }
  return NextResponse.json({ ok: false, error: 'Editor key not available yet — is the MCP server running?' }, { status: 404 });
}
