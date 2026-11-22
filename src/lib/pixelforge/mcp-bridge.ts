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

import { AGENT_FETCH_HEADERS } from './agent-headers'
import { useAppSettings } from './settings'
import { getBus, useEditor } from './store'
import { notifyInBackground } from './desktop-bridge'
import { executeMcpTool, computeStateHash } from './mcp-tools'
import { composeFrameRgba } from '@pixelforge/core'

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

export interface RemoteEditRecord {
  tool: string
  clientName: string
  ok: boolean
  at: string
  /** before/after snapshots for pixel-affecting agent edits (Review Result). */
  review?: {
    clipId: string
    clipName: string
    frameId: string
    frameNumber: number
    layerId: string
    layerName: string
    before: Uint8ClampedArray | null
    after: Uint8ClampedArray
    width: number
    height: number
  } | null
}

const remoteEdits: RemoteEditRecord[] = []

/** Pixel tools whose relayed calls get Review Result snapshots. */
const REMOTE_PIXEL_TOOLS = new Set(['set_pixels', 'fill_rect', 'replace_color', 'flip_frame', 'rotate_frame', 'shift_frame', 'resize_canvas'])

/** Document-mutating tool calls relayed to CONNECTED MCP agents (e.g. ZCode) —
 *  the Agent panel labels these 'performed by: connected agent'. */
function recordRemoteEdit(tool: string, clientName: string, ok: boolean, review?: RemoteEditRecord['review']): void {
  remoteEdits.unshift({ tool, clientName, ok, at: new Date().toLocaleTimeString(), review: review ?? null })
  if (remoteEdits.length > 20) remoteEdits.length = 20
}

export function getRecentRemoteEdits(): RemoteEditRecord[] {
  return [...remoteEdits]
}

export function getBridgeState(): BridgeState {
  return state
}

export function subscribeBridge(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// ---------------------------------------------------------------------------
// active project identity (durable where possible; session-stable otherwise)
// ---------------------------------------------------------------------------

let unsavedDocCounter = 0

/**
 * Durable-ish identity for the OPEN document, used to keep task-board work in
 * its queued project. Saved projects key on the DB id or desktop file path;
 * unsaved ones key on a session-stable name so two different unsaved projects
 * never collide unless they share a name (the Brain card shows the name).
 */
function getEditorState() {
  return useEditor.getState()
}

export function currentProjectIdentity(): { key: string; name: string } {
  const st = getEditorState()
  const project = st.project
  if (st.projectId) return { key: `db:${st.projectId}`, name: project.name }
  if (st.filePath) return { key: `file:${st.filePath}`, name: project.name }
  return { key: `unsaved:${project.name}:${unsavedDocCounter}`, name: project.name }
}

/**
 * Called when the editor replaces the active document (new/load): bump the
 * unsaved counter so a SECOND unsaved project in the same session never
 * inherits the previous one's identity.
 */
export function noteDocumentReplaced(): void {
  unsavedDocCounter++
}

// ---------------------------------------------------------------------------
// connection management
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null
let candidateIndex = 0
let generation = 0
let rejectCount = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let eventThrottleTimer: ReturnType<typeof setTimeout> | null = null
let lastSentHash: string | null = null
let ctrlSeq = 0
const ctrlWaiters = new Map<string, { resolve: (v: { ok: boolean; data?: unknown; error?: { code: string; message: string } }) => void; timer: ReturnType<typeof setTimeout> }>()
let started = false
/** set by the Settings "Take over the bridge" button — explicit, never automatic */
let forceTakeover = false
let unsubSettings: (() => void) | null = null
let unsubBus: (() => void) | null = null
let lockWaitTimer: ReturnType<typeof setInterval> | null = null
let lockRelease: (() => void) | null = null

// single-editor lock: the server keeps ONE editor slot and a newer connection
// REPLACES the holder (editor-link 4005) — so two live app tabs would steal
// the slot from each other forever (connect → replaced → reconnect loop).
// Web Locks give the winner the bridge for its whole lifetime; other tabs
// wait and take over automatically when the holder closes.
const EDITOR_LOCK = 'pixelforge-mcp-editor'
const LOCK_HELD_MESSAGE = 'editor bridge is held by another PixelForge tab — close that tab to use the bridge here'

function acquireEditorLock(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      resolve(true) // no Locks API — legacy single-socket behavior
      return
    }
    navigator.locks
      .request(EDITOR_LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false)
          return
        }
        resolve(true)
        return new Promise<void>((release) => {
          lockRelease = release
        })
      })
      .catch(() => resolve(true)) // lock API failure — legacy behavior
  })
}

async function candidates(): Promise<string[]> {
  // The packaged shell connects only after Electron confirms that it owns a
  // running bundled MCP service. This prevents a random process on :3030
  // from becoming the editor's control plane.
  const desktopMcp = window.pixelforge?.mcp
  if (desktopMcp) {
    try {
      const status = await desktopMcp.status()
      if (!status.ready || !status.endpoint) return []
      return [status.endpoint.replace(/^http/, 'ws').replace(/\/mcp$/, '/')]
    } catch {
      return []
    }
  }

  const list: string[] = []
  const host = typeof location !== 'undefined' ? location.host : ''
  // Port from the persisted settings (default 3030) so an isolated dev
  // instance can run its own MCP server without touching the main one.
  // The gateway transform below still targets 3030 (proxy embeds only).
  const mcpPort = useAppSettings.getState().mcpPort ?? 3030
  // loopback first — the server binds 127.0.0.1 and this is the real path on
  // any locally-run setup. The gateway transform below only matters when the
  // page itself is served through a proxy (non-loopback host, sandbox embed);
  // on a directly-opened localhost page it can never complete a handshake
  // and would only spam a browser console error on every failover cycle.
  list.push(`ws://127.0.0.1:${mcpPort}/`)
  if (
    host &&
    host !== 'localhost' &&
    !host.startsWith('localhost:') &&
    !host.startsWith('127.')
  ) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    list.push(`${proto}//${host}/?XTransformPort=3030`)
  }
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

function scheduleReconnect(delayMs = 3000): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    openSocket()
  }, delayMs)
}

async function openSocket(): Promise<void> {
  if (!started) return
  const list = await candidates()
  if (!started) return
  if (list.length === 0) {
    setState({ status: 'disconnected', transport: null, server: null, lastError: 'Desktop MCP service is unavailable.' })
    scheduleReconnect(5_000)
    return
  }
  const url = list[candidateIndex % list.length]!
  const myGen = ++generation
  // one failure → one candidate advance. onerror AND onclose both fire for
  // a dead socket; without this guard each failure double-increments the
  // index and the modulo wraps back to the same (broken) transport forever.
  const failedGens = new Set<number>()
  const failover = (reason: string, delayMs = 3000) => {
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
    scheduleReconnect(delayMs)
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

  
// Editor-link auth (see mini-services/mcp-server/src/editor-auth.ts): the
// MCP server requires this secret in hello — fetched from the app's own
// guarded API so only the real editor page can present it.
let editorKeyCache: string | null = null
async function ensureEditorKey(): Promise<string | null> {
  if (editorKeyCache) return editorKeyCache
  try {
    const res = await fetch('/api/mcp/editor-key', {
      headers: { ...AGENT_FETCH_HEADERS },
      // hello waits on this — without a deadline a hung request leaves the
      // socket open-but-silent and triggers a reconnect loop
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { key?: string }
    editorKeyCache = typeof json.key === 'string' && json.key.length >= 32 ? json.key : null
  } catch {
    editorKeyCache = null
  }
  return editorKeyCache
}

socket.onopen = async () => {
    if (myGen !== generation) return
    socket.send(
      JSON.stringify({
        type: 'hello',
        editorKey: await ensureEditorKey() ?? undefined,
        bridgeVersion: MCP_BRIDGE_VERSION,
        appVersion: 'pixelforge-editor',
        origin: typeof location !== 'undefined' ? location.origin : null,
        mcpEnabled: useAppSettings.getState().agentApiEnabled,
        // explicit user intent only (Settings → MCP): two live editors in
        // different browser contexts must never steal the slot back and forth
        ...(forceTakeover ? { takeover: true } : {}),
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
    // 'another editor holds the bridge' is a standing condition, not a
    // failure — retry slowly so a rejected second page sits quiet instead
    // of hammering the server (and the console) every 3 seconds
    failover(
      ev.code === 4000 ? 'another editor holds the bridge' : `connection closed (${ev.code})`,
      ev.code === 4000 ? 15_000 : 3000,
    )
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
      forceTakeover = false
      setState({ status: 'connected', server: (msg.server as BridgeServerStatus) ?? null, lastError: null })
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, 15000)
      // fresh server-side link (restart or first connect): re-report the
      // project identity even if the state hash is unchanged, so claim
      // gating never sits on a null target after a reconnect
      lastSentHash = null
      pushProjectChanged()
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
      const clientName = typeof msg.clientName === 'string' ? msg.clientName : 'unknown'
      // snapshot the target frame before/after so the Agent panel's Review
      // Result can show exactly what the connected agent changed
      let reviewBefore: { clipId: string; clipName: string; frameId: string; frameNumber: number; layerId: string; layerName: string; before: Uint8ClampedArray | null } | null = null
      if (REMOTE_PIXEL_TOOLS.has(tool)) {
        const st = useEditor.getState()
        const clip = st.project.clips.find((c) => c.id === st.activeClipId) ?? st.project.clips[0]
        const frame = clip?.frames[st.activeFrameIndex] ?? clip?.frames[0]
        if (clip && frame) {
          const layer = clip.layers.find((l) => l.id === st.activeLayerId) ?? clip.layers[clip.layers.length - 1] ?? clip.layers[0]
          reviewBefore = {
            clipId: clip.id,
            clipName: clip.name,
            frameId: frame.id,
            frameNumber: st.activeFrameIndex + 1,
            layerId: layer?.id ?? '',
            layerName: layer?.name ?? '',
            before: composeFrameRgba(st.project, clip, frame),
          }
        }
      }
      const result = await executeMcpTool(tool, msg.args, {
        clientId: typeof msg.clientId === 'string' ? msg.clientId : 'unknown',
        clientName,
        tier: msg.tier === 'L2' ? 'L2' : msg.tier === 'L3' ? 'L3' : msg.tier === 'L1' ? 'L1' : 'L0',
      })
      let review: RemoteEditRecord['review'] = null
      if (reviewBefore && result.ok) {
        const st = useEditor.getState()
        const clip = st.project.clips.find((c) => c.id === reviewBefore.clipId)
        const frame = clip?.frames.find((f) => f.id === reviewBefore.frameId)
        if (clip && frame) {
          review = {
            ...reviewBefore,
            after: composeFrameRgba(st.project, clip, frame),
            width: st.project.width,
            height: st.project.height,
          }
        }
      }
      recordRemoteEdit(tool, clientName, result.ok, review)
      setState({}) // nudge subscribers (Agent panel) to re-read remoteEdits
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
      const identity = currentProjectIdentity()
      ws.send(
        JSON.stringify({
          type: 'event',
          event: {
            type: 'projectChanged',
            stateHash: hash,
            name: project.name,
            dirty: getBus().isDirty(),
            projectKey: identity.key,
            projectName: identity.name,
          },
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

/**
 * Explicit user action (Settings → MCP "Take over the bridge"): the next
 * hello claims the slot from the current holder. One-shot — resets on
 * hello-ok. Never called automatically; two live editors must not war.
 */
export function forceBridgeTakeover(): void {
  forceTakeover = true
  if (!started) return
  if (state.status !== 'connected') {
    generation++
    clearTimers()
    try {
      ws?.close()
    } catch {
      /* noop */
    }
    ws = null
    openSocket()
  }
}

export function initMcpBridge(): void {
  if (started || typeof window === 'undefined') return
  started = true
  // master switch mirror (Settings → MCP toggle)
  unsubSettings = useAppSettings.subscribe((s, prev) => {
    if (s.agentApiEnabled !== prev.agentApiEnabled) pushEnabled(s.agentApiEnabled)
  })
  // document events (bus changes only — pointer strokes bump renderTick, not
  // the bus; playhead moves never touch the bus)
  unsubBus = getBus().onChange(() => pushProjectChanged())
  // document REPLACEMENT (new/load): bump the unsaved identity counter so a
  // second unsaved project in the session never inherits the first one's key
  useEditor.subscribe((s, prev) => {
    if (s.loadEpoch !== prev.loadEpoch) noteDocumentReplaced()
  })
  // dev only: a hot-reload re-evaluates this module (started resets to false)
  // while the OLD socket still holds the server's single editor slot — dispose
  // it explicitly so the fresh socket isn't rejected in a connect/reject loop
  interface HMRHot {
    dispose: (cb: () => void) => void
  }
  const hot = (import.meta as unknown as { hot?: HMRHot }).hot
  if (hot) hot.dispose(() => shutdownMcpBridgeForTests())

  void acquireEditorLock().then((acquired) => {
    if (!started) return
    if (acquired) {
      openSocket()
      return
    }
    setState({ status: 'disconnected', lastError: LOCK_HELD_MESSAGE })
    lockWaitTimer = setInterval(() => {
      void acquireEditorLock().then((ok) => {
        if (!started) return
        if (ok) {
          if (lockWaitTimer) {
            clearInterval(lockWaitTimer)
            lockWaitTimer = null
          }
          setState({ lastError: null })
          openSocket()
        }
      })
    }, 5000)
  })
}

export function shutdownMcpBridgeForTests(): void {
  started = false
  generation++
  clearTimers()
  if (lockWaitTimer) {
    clearInterval(lockWaitTimer)
    lockWaitTimer = null
  }
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
  const release = lockRelease
  lockRelease = null
  release?.()
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
