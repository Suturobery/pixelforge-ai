/**
 * MCP server reachability probe for the Agent panel badge.
 * The endpoint is a FIXED loopback constant — no client-supplied URL is
 * ever fetched (SSRF-safe by construction).
 */

import { NextRequest, NextResponse } from 'next/server'

import { guardRead } from '@/lib/pixelforge/api-guard'

const MCP_PORT = Number(process.env.PF_MCP_PORT ?? 3030)

function endpointFor(): string {
  // The port is supplied by the trusted Electron main process at launch, not
  // by a web request. Accepting a query-string port turns this endpoint into
  // a loopback port scanner when the renderer is publicly reachable.
  return `http://127.0.0.1:${MCP_PORT}/mcp`
}

function parseSseOrJson(text: string): { serverInfo?: { name?: string; version?: string } } | null {
  // Streamable HTTP may answer JSON or an SSE stream with data: lines.
  const dataLine = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .pop()
  const raw = dataLine ? dataLine.slice(5).trim() : text
  try {
    const json = JSON.parse(raw) as { result?: { serverInfo?: { name?: string; version?: string } } }
    return json.result ?? null
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const guard = guardRead(req)
  if (guard) return guard
  const endpoint = endpointFor()
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pixelforge-panel', version: '1.0.0' },
    },
  })
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body,
      signal: AbortSignal.timeout(1500),
    })
    if (res.ok) {
      const info = parseSseOrJson(await res.text())?.serverInfo
      return NextResponse.json({ reachable: true, authRequired: false, serverInfo: info ?? null, endpoint })
    }
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ reachable: true, authRequired: true, serverInfo: null, endpoint })
    }
    return NextResponse.json({ reachable: true, authRequired: false, serverInfo: null, endpoint, note: `HTTP ${res.status}` })
  } catch {
    return NextResponse.json({ reachable: false, authRequired: false, serverInfo: null, endpoint })
  }
}
