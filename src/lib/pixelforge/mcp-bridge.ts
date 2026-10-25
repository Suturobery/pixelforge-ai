// PixelForge AI — MCP editor bridge (renderer ⇄ MCP server, v3.1 §5.1).
//
// The CommandBus lives in the renderer (web testbed AND Electron-dev both
// run this UI). This module connects OUT to the MCP server's single editor
// WebSocket and executes relayed tool calls on the real bus via
// ./mcp-tools. It also pushes projectChanged events and carries the
// Settings control plane (pairing, client list, revoke, ops).
//
// Transport candidates (in order — first hello-ok wins):
//   1. gateway-relative: wss?://<current host>/?XTransformPort=3030
//      (sandbox/preview topology — the Caddy gateway forwards to the MCP
//       mini-service; relative path per the gateway contract)
//   2. direct loopback:  ws://127.0.0.1:3030/
//      (Electron dev renderer / direct-machine access)
//
// The server side checks Origin for the editor socket, so a drive-by page
// cannot impersonate the editor (browsers always send Origin).

import { useAppSettings } from './settings'
import { getBus } from './store'
import { executeMcpTool, computeStateHash } from './mcp-tools'

export const MCP_BRIDGE_VERSION = 1

export type BridgeStatus = 'disconnected' | 'connecting' | 'connected'

export interface BridgeServerStatus {
  mcpEnabled: boolean
  endpoint: string
  clientsPaired: number
  clientsConnected: number
  editorConnected: boolean
  lastStateHash: string | null
  startedAt: string
}

export interface BridgeState {
  status: BridgeStatus
  transport: string | null
  server: BridgeServerStatus | null
  lastError: string | null
  bump: number
}

// minimal reactive store for the Settings UI (avoids a zustand dependency
// cycle — plain subscribe/set here)
type Listener = (s: BridgeState) => void
const listeners = new Set<Listener>()
let state: BridgeState = { status: 'disconnected', transport: null, server: null, lastError: null, bump: 0 }

function setState(patch: Partial<BridgeState>): void {
  state = { ...state, ...patch, bump: state.bump + 1 }
  for (const fn of listeners) fn(state)
}

export function getBridgeState(): BridgeState {
  return state
}

export function subscribeBridge(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// ---------------------------------------------------------------------------
// connection management
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null
let candidateIndex = 0
let generation = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let eventThrottleTimer: ReturnType<typeof setTimeout> | null = null
let lastSentHash: string | null = null
let ctrlSeq = 0
const ctrlWaiters = new Map<string, { resolve: (v: { ok: boolean; data?: unknown; error?: { code: string; message: string } }) => void; timer: ReturnType<typeof setTimeout> }>()
let started = false
let unsubSettings: (() => void) | null = null
let unsubBus: (() => void) | null = null

function candidates(): string[] {
  const list: string[] = []
  if (typeof location !== 'undefined' && location.host) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    list.push(`${proto}//${location.host}/?XTransformPort=3030`)
  }
  list.push('ws://127.0.0.1:3030/')
  return list
}

function clearTimers(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
  if (eventThrottleTimer) {
    clearTimeout(eventThrottleTimer)
    eventThrottleTimer = null
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    openSocket()
  }, 3000)
}

function openSocket(): void {
  if (!started) return
  const list = candidates()
  const url = list[candidateIndex % list.length]!
  const myGen = ++generation
  // one failure → one candidate advance. onerror AND onclose both fire for
  // a dead socket; without this guard each failure double-increments the
  // index and the modulo wraps back to the same (broken) transport forever.
  const failedGens = new Set<number>()
  const failover = (reason: string) => {
    if (myGen !== generation || failedGens.has(myGen)) return
    failedGens.add(myGen)
    setState({ lastError: reason, status: 'disconnected', server: null })
    try {
      socket.close()
    } catch {
      /* already closed */
    }
    if (ws === socket) ws = null
    candidateIndex++
    scheduleReconnect()
  }

  setState({ status: 'connecting', transport: url, lastError: null })

  let socket: WebSocket
  try {
    socket = new WebSocket(url)
  } catch (err) {
    failover(err instanceof Error ? err.message : 'WebSocket constructor failed')
    return
  }
  ws = socket

  socket.onopen = () => {
    if (myGen !== generation) return
    socket.send(
      JSON.stringify({
        type: 'hello',
        bridgeVersion: MCP_BRIDGE_VERSION,
        appVersion: 'pixelforge-editor',
        origin: typeof location !== 'undefined' ? location.origin : null,
        mcpEnabled: useAppSettings.getState().agentApiEnabled,
      })
    )
  }
  socket.onmessage = (ev) => {
    if (myGen !== generation) return
    void handleMessage(String(ev.data))
  }
  socket.onerror = () => {
    if (myGen !== generation) return
    // record only — onclose is the single failure path (see failover guard)
    if (state.status !== 'connected') setState({ lastError: `no MCP server at ${url}` })
    else setState({ lastError: 'socket error' })
  }
  socket.onclose = (ev) => {
    if (myGen !== generation) return
    clearTimers()
    if (state.status === 'connected') {
      // a healthy link dropped (server restart) — retry from candidate 0
      setState({ status: 'disconnected', server: null })
      candidateIndex = 0
      scheduleReconnect()
      return
    }
    failover(`connection closed (${ev.code})`)
  }
}

async function handleMessage(raw: string): Promise<void> {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return
  }
  switch (msg.type) {
    case 'hello-ok': {
      setState({ status: 'connected', server: (msg.server as BridgeServerStatus) ?? null, lastError: null })
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, 15000)
      return
    }
    case 'status': {
      setState({ server: (msg.server as BridgeServerStatus) ?? state.server })
      return
    }
    case 'pong':
      return
    case 'tool-request': {
      const id = typeof msg.id === 'string' ? msg.id : ''
      const tool = typeof msg.tool === 'string' ? msg.tool : ''
      if (!id || !tool) return
      const result = await executeMcpTool(tool, msg.args, {
        clientId: typeof msg.clientId === 'string' ? msg.clientId : 'unknown',
        clientName: typeof msg.clientName === 'string' ? msg.clientName : 'unknown',
        tier: msg.tier === 'L1' ? 'L1' : 'L0',
      })
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'tool-result', id, ...result }))
      }
      return
    }
    case 'ctrl-result': {
      const id = typeof msg.id === 'string' ? msg.id : ''
      const waiter = ctrlWaiters.get(id)
      if (waiter) {
        clearTimeout(waiter.timer)
        ctrlWaiters.delete(id)
        waiter.resolve({ ok: msg.ok === true, data: msg.data, error: msg.error as { code: string; message: string } | undefined })
      }
      return
    }
    default:
      return
  }
}

// ---------------------------------------------------------------------------
// document events → server (projectChanged notifications for MCP clients)
// ---------------------------------------------------------------------------

function pushProjectChanged(): void {
  if (eventThrottleTimer) return
  eventThrottleTimer = setTimeout(async () => {
    eventThrottleTimer = null
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      const hash = await computeStateHash()
      if (hash === lastSentHash) return
      lastSentHash = hash
      const project = getBus().getProject()
      ws.send(
        JSON.stringify({
          type: 'event',
          event: { type: 'projectChanged', stateHash: hash, name: project.name, dirty: getBus().isDirty() },
        })
      )
    } catch {
      /* state hashing is best-effort */
    }
  }, 250)
}

// ---------------------------------------------------------------------------
// public control plane (Settings UI)
// ---------------------------------------------------------------------------

export function mcpCtrl<T = unknown>(payload: unknown, timeoutMs = 8000): Promise<{ ok: boolean; data?: T; error?: { code: string; message: string } }> {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, error: { code: 'not_connected', message: 'The MCP server link is not connected.' } })
      return
    }
    const id = `ui${++ctrlSeq}`
    const timer = setTimeout(() => {
      ctrlWaiters.delete(id)
      resolve({ ok: false, error: { code: 'timeout', message: 'MCP server did not answer the control request.' } })
    }, timeoutMs)
    ctrlWaiters.set(id, { resolve: resolve as (v: { ok: boolean; data?: unknown; error?: { code: string; message: string } }) => void, timer })
    ws.send(JSON.stringify({ type: 'ctrl-request', id, ctrl: payload }))
  })
}

/** Enabled toggle → server master switch (Settings → MCP). */
function pushEnabled(enabled: boolean): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'status-update', mcpEnabled: enabled }))
  }
}

export function initMcpBridge(): void {
  if (started || typeof window === 'undefined') return
  started = true
  openSocket()
  // master switch mirror (Settings → MCP toggle)
  unsubSettings = useAppSettings.subscribe((s, prev) => {
    if (s.agentApiEnabled !== prev.agentApiEnabled) pushEnabled(s.agentApiEnabled)
  })
  // document events (bus changes only — pointer strokes bump renderTick, not
  // the bus; playhead moves never touch the bus)
  unsubBus = getBus().onChange(() => pushProjectChanged())
}

export function shutdownMcpBridgeForTests(): void {
  started = false
  generation++
  clearTimers()
  unsubSettings?.()
  unsubBus?.()
  unsubSettings = null
  unsubBus = null
  try {
    ws?.close()
  } catch {
    /* noop */
  }
  ws = null
  setState({ status: 'disconnected', server: null })
}

// dev/E2E probe (browser automation reads status without React)
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  ;(window as unknown as Record<string, unknown>).__pfMcp = {
    getBridgeState,
    mcpCtrl,
    computeStateHash,
    // Task 9: local executor access for E2E (same path the Agent Console uses)
    executeMcpTool: (tool: string, args: unknown) =>
      import('./mcp-tools').then((m) =>
        m.executeMcpTool(tool, args, { clientId: 'e2e-probe', clientName: 'browser-e2e', tier: 'L1' }),
      ),
  }
}
