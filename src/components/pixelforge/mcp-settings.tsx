// PixelForge AI — Settings → MCP Connections (v3.1 §5.1/§8 of the Task 8
// mandate). Server status, master toggle, pairing workflow, client
// allowlist with revocation, recent MCP operations, troubleshooting.

'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  forceBridgeTakeover,
  getBridgeState,
  subscribeBridge,
  mcpCtrl,
  type BridgeState,
} from '@/lib/pixelforge/mcp-bridge'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { copyText, desktopConfirm, getBridge } from '@/lib/pixelforge/desktop-bridge'
import { buildIdeGuide, tierSummary } from '@/lib/pixelforge/ide-guide'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import {
  Bot,
  Check,
  Copy,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Unlink,
} from 'lucide-react'

interface PairingClient {
  clientId: string
  name: string
  tier: 'L0' | 'L1' | 'L2' | 'L3'
  createdAt: string
  lastSeen: string | null
  revoked: boolean
}

interface OpRow {
  ts: string
  clientId: string | null
  clientName: string
  tool: string
  tier: 'L0' | 'L1' | null
  ok: boolean
  errorCode: string | null
  durationMs: number
  summary: string | null
}

function useBridge(): BridgeState {
  return useSyncExternalStore(subscribeBridge, getBridgeState, getBridgeState)
}

function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${ok ? 'bg-frost-400' : warn ? 'bg-amber-400' : 'bg-zinc-600'}`}
      aria-hidden
    />
  )
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return '—'
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`
  return new Date(iso).toLocaleDateString()
}

/** Explain expected first-contact failures without hiding security evidence. */
function operationFailureHint(op: OpRow): string | null {
  const code = (op.errorCode ?? '').toLowerCase()
  if (/(auth|token|unauthor|pair)/.test(code)) {
    return 'Connection was refused safely: pair the IDE first, then use its returned client token (not the one-time code).'
  }
  return null
}

export function McpConnections() {
  const bridge = useBridge()
  const agentApiEnabled = useAppSettings((s) => s.agentApiEnabled)
  const setSetting = useAppSettings((st) => st.setSetting)
  const { toast } = useToast()

  const [clients, setClients] = useState<PairingClient[]>([])
  const [ops, setOps] = useState<OpRow[]>([])
  const [pairing, setPairing] = useState<{ token: string; tier: 'L0' | 'L1' | 'L2' | 'L3'; expiresAt: string } | null>(null)
  // The normal desktop workflow is to connect a trusted IDE assistant to the
  // whole project surface (L2 — the top tier new pairings can pick; no tools
  // are registered at L3 anymore). The user can still deliberately choose a
  // smaller tier for an untrusted/read-only assistant.
  const [pairTier, setPairTier] = useState<'L0' | 'L1' | 'L2'>('L2')
  const [ideName, setIdeName] = useState('Codex')
  const [pairingBusy, setPairingBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [connectionCheck, setConnectionCheck] = useState<{
    server: boolean
    editor: boolean
    paired: boolean
    recentRead: boolean
    error?: string
  } | null>(null)
  const [copied, setCopied] = useState<'code' | 'endpoint' | 'guide' | null>(null)
  const [detectedIdes, setDetectedIdes] = useState<PfDetectedMcpClient[]>([])
  const [ideActionBusy, setIdeActionBusy] = useState<PfMcpClientId | null>(null)
  const [showAllIdes, setShowAllIdes] = useState(false)

  const refreshIdes = useCallback(async () => {
    const fn = getBridge()?.mcp?.detectClients
    if (!fn) return
    try {
      setDetectedIdes(await fn())
    } catch {
      // ignore detection failures
    }
  }, [])

  const refresh = useCallback(async () => {
    const [c, o] = await Promise.all([
      mcpCtrl<{ clients: PairingClient[] }>({ kind: 'clients-list' }),
      mcpCtrl<{ ops: OpRow[] }>({ kind: 'ops-recent', limit: 12 }),
    ])
    if (c.ok && c.data) setClients(c.data.clients)
    if (o.ok && o.data) setOps(o.data.ops)
  }, [])

  useEffect(() => {
    void refresh()
    void refreshIdes()
    const t = setInterval(() => void refresh(), 8000)
    return () => clearInterval(t)
  }, [refresh, refreshIdes])

  // expiry countdown for the displayed pairing code
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!pairing) return
    const t = setInterval(() => forceTick((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [pairing])

  const generate = async () => {
    setPairingBusy(true)
    try {
      const res = await mcpCtrl<{ token: string; tier: 'L0' | 'L1' | 'L2' | 'L3'; expiresAt: string }>({ kind: 'pair-generate', tier: pairTier })
      if (res.ok && res.data) {
        setPairing(res.data)
        await refresh()
      } else {
        toast({ title: 'Could not generate a pairing code', description: res.error?.message ?? 'MCP server unreachable', variant: 'destructive' })
      }
    } finally {
      setPairingBusy(false)
    }
  }

  const cancelPairing = async () => {
    if (!pairing) return
    await mcpCtrl({ kind: 'pair-cancel', token: pairing.token })
    setPairing(null)
  }

  const revoke = async (client: PairingClient) => {
    const res = await mcpCtrl({ kind: 'client-revoke', clientId: client.clientId })
    if (res.ok) {
      toast({ title: `Revoked "${client.name}"`, description: 'Its token no longer works.' })
      await refresh()
    } else {
      toast({ title: 'Revoke failed', description: res.error?.message, variant: 'destructive' })
    }
  }

  const removeRevoked = async (client: PairingClient) => {
    const approved = await desktopConfirm(
      `Remove "${client.name}" from the revoked clients list?`,
      'Its token is already invalid. This only removes the saved list entry; it does not restore access.',
    )
    if (!approved) return
    const res = await mcpCtrl({ kind: 'client-remove', clientId: client.clientId })
    if (res.ok) {
      toast({ title: `Removed "${client.name}"`, description: 'The revoked client entry was deleted.' })
      await refresh()
    } else {
      toast({ title: 'Remove failed', description: res.error?.message, variant: 'destructive' })
    }
  }

  const copy = async (text: string, what: 'code' | 'endpoint' | 'guide') => {
    try {
      await copyText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast({ title: 'Copy failed', description: 'Clipboard is unavailable.', variant: 'destructive' })
    }
  }

  const checkConnection = async () => {
    setChecking(true)
    try {
      const [status, clientResult, operationResult] = await Promise.all([
        mcpCtrl<{ mcpEnabled: boolean; editorConnected: boolean }>({ kind: 'status' }),
        mcpCtrl<{ clients: PairingClient[] }>({ kind: 'clients-list' }),
        mcpCtrl<{ ops: OpRow[] }>({ kind: 'ops-recent', limit: 100 }),
      ])
      const active = clientResult.ok ? clientResult.data?.clients.filter((client) => !client.revoked) ?? [] : []
      const clientIds = new Set(active.map((client) => client.clientId))
      const cutoff = Date.now() - 30 * 60_000
      setConnectionCheck({
        server: status.ok && status.data?.mcpEnabled === true,
        editor: status.ok && status.data?.editorConnected === true,
        paired: active.length > 0,
        recentRead: operationResult.ok && (operationResult.data?.ops.some((op) => op.ok && op.tool === 'get_project_state' && op.clientId !== null && clientIds.has(op.clientId) && new Date(op.ts).getTime() >= cutoff) ?? false),
        error: !status.ok ? status.error?.message ?? 'MCP service unavailable' : undefined,
      })
      await refresh()
    } catch {
      setConnectionCheck({ server: false, editor: false, paired: false, recentRead: false, error: 'Could not reach the MCP service.' })
    } finally {
      setChecking(false)
    }
  }

  const connectIdeOneClick = async (ide: PfDetectedMcpClient) => {
    const installer = getBridge()?.mcp?.installClient
    const endpoint = bridge.server?.endpoint
    if (!installer || !endpoint) {
      toast({ title: 'MCP server not ready', description: 'Wait for the local MCP server to connect first.', variant: 'destructive' })
      return
    }
    setIdeActionBusy(ide.id)
    try {
      const issued = await mcpCtrl<{ clientId: string; name: string; tier: string; token: string }>({
        kind: 'client-issue',
        name: ide.name,
        tier: pairTier,
      })
      if (!issued.ok || !issued.data?.token) {
        toast({ title: `Could not pair ${ide.name}`, description: issued.error?.message ?? 'MCP server did not issue a token.', variant: 'destructive' })
        return
      }
      const res = await installer({ clientId: ide.id, endpoint, token: issued.data.token })
      if (!res.ok) {
        // Roll back the newly issued client so we never leave an orphaned token on write failure
        await mcpCtrl({ kind: 'client-revoke', clientId: issued.data.clientId })
        toast({ title: `Could not configure ${ide.name}`, description: res.error ?? 'Config write failed.', variant: 'destructive' })
        return
      }
      toast({
        title: `${ide.name} connected (${pairTier})`,
        description: `Updated ${res.configPath ?? ide.configPath}. Reload MCP in ${ide.name} to start using PixelForge AI.`,
      })
      await Promise.all([refresh(), refreshIdes()])
    } finally {
      setIdeActionBusy(null)
    }
  }

  const removeIdeOneClick = async (ide: PfDetectedMcpClient) => {
    const uninstaller = getBridge()?.mcp?.uninstallClient
    if (!uninstaller) return
    const ok = await desktopConfirm(
      `Remove PixelForge AI from ${ide.name}?`,
      `Deletes the "pixelforge-ai" MCP entry from ${ide.configPath} (a backup is saved first).`,
    )
    if (!ok) return
    setIdeActionBusy(ide.id)
    try {
      const res = await uninstaller({ clientId: ide.id })
      if (res.ok) {
        toast({ title: `Removed from ${ide.name}`, description: 'You can also revoke its token under Connected clients.' })
        await refreshIdes()
      } else {
        toast({ title: `Could not update ${ide.name}`, description: res.error ?? 'Config update failed.', variant: 'destructive' })
      }
    } finally {
      setIdeActionBusy(null)
    }
  }

  const secsLeft = pairing ? Math.max(0, Math.floor((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)) : 0
  const activeClients = clients.filter((c) => !c.revoked)
  const serverReady = bridge.status === 'connected' && bridge.server?.mcpEnabled === true
  // tier-accurate guide - the copied text must describe the tier the code
  // was generated for, never a hardcoded 'full control'
  const ideGuide = pairing
    ? buildIdeGuide({
        tier: pairing.tier,
        endpoint: bridge.server?.endpoint ?? 'http://127.0.0.1:3030/mcp',
        token: pairing.token,
        clientName: ideName,
      })
    : null

  return (
    <div className="min-w-0 space-y-3 pb-2 pt-1">
      {/* ------------------------------------------------ server status */}
      <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Bot className="h-3.5 w-3.5 shrink-0 text-frost-400" />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-xs text-zinc-100">MCP server</p>
              <p className="break-words font-mono text-[10px] leading-tight text-zinc-400">
                Model Context Protocol — real tools, real protocol (127.0.0.1 only)
              </p>
            </div>
          </div>
          <Switch
            className="shrink-0"
            checked={agentApiEnabled}
            onCheckedChange={(v) => setSetting('agentApiEnabled', v)}
            aria-label="Enable MCP server"
          />
        </div>
        <div className="mt-2 grid min-w-0 gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-400 sm:grid-cols-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <StatusDot ok={bridge.status === 'connected'} />
            <span className="truncate">editor link: {bridge.status}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <StatusDot ok={serverReady} warn={agentApiEnabled && !serverReady} />
            <span className="truncate">
              server: {!agentApiEnabled ? 'disabled' : serverReady ? 'accepting tools' : 'starting / reconnecting'}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <StatusDot ok={!!bridge.server?.clientsPaired} />
            <span className="truncate">paired clients: {bridge.server?.clientsPaired ?? activeClients.length}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <StatusDot ok={!!bridge.server?.clientsConnected} warn={!bridge.server} />
            <span className="truncate">mcp sessions: {bridge.server?.clientsConnected ?? 0}</span>
          </span>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[10px] text-zinc-300">
            {bridge.server?.endpoint ?? 'Waiting for local MCP endpoint…'}
          </code>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-zinc-400 hover:text-zinc-200"
            onClick={() => bridge.server?.endpoint && void copy(bridge.server.endpoint, 'endpoint')}
            disabled={!bridge.server?.endpoint}
            aria-label="Copy MCP endpoint"
          >
            {copied === 'endpoint' ? <Check className="h-3 w-3 text-frost-400" /> : <Copy className="h-3 w-3" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-zinc-400 hover:text-zinc-200"
            onClick={() => void refresh()}
            aria-label="Refresh MCP status"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
        {bridge.status !== 'connected' && (
          <p className="mt-1.5 break-words font-mono text-[10px] leading-tight text-amber-400/90">
            Editor link down{bridge.lastError ? ` — ${bridge.lastError}` : ''}. Start the MCP mini-service
            (<code className="text-zinc-300">bun run dev</code> in mini-services/mcp-server) and keep this app open.
          </p>
        )}
        {bridge.status !== 'connected' && bridge.lastError?.includes('another editor') && (
          <Button
            size="sm"
            variant="outline"
            className="mt-1.5 h-6 border-amber-600/60 px-2 font-mono text-[10px] text-amber-300 hover:bg-amber-900/20"
            onClick={() => forceBridgeTakeover()}
            title="Claim the editor slot from the other PixelForge tab/window that currently holds it"
          >
            Take over the bridge
          </Button>
        )}
      </div>

      {/* -------------------------------------------- 1-click IDE setup (desktop) */}
      {detectedIdes.length > 0 && (
        <div className="min-w-0 overflow-hidden rounded-lg border border-teal-800/60 bg-teal-950/20 p-2.5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-teal-400" />
              <p className="font-mono text-xs text-zinc-100">1-Click IDE Setup</p>
            </div>
            <button
              type="button"
              onClick={() => setShowAllIdes((v) => !v)}
              className="shrink-0 font-mono text-[10px] text-zinc-400 hover:text-zinc-200"
            >
              {showAllIdes ? 'Detected only' : `Show all (${detectedIdes.length})`}
            </button>
          </div>
          <p className="mt-1 break-words font-mono text-[10px] leading-tight text-zinc-400">
            Automatically pairs and writes the PixelForge MCP config (with a <code className="text-zinc-300">.bak</code> backup) using tier <span className="text-teal-300">{pairTier}</span> — no manual JSON editing.
          </p>
          {(() => {
            const visible = showAllIdes
              ? detectedIdes
              : detectedIdes.filter((ide) => ide.detected || ide.configured)
            if (visible.length === 0) {
              return (
                <p className="mt-2 font-mono text-[10px] text-zinc-500">
                  No supported AI IDEs detected yet. Click <span className="text-zinc-300">Show all</span> to pre-configure Cursor, Claude Code, Codex, Windsurf, or Antigravity.
                </p>
              )
            }
            return (
              <ul className="mt-2 space-y-1.5">
                {visible.map((ide) => {
                  const busy = ideActionBusy === ide.id
                  return (
                    <li
                      key={ide.id}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded border border-zinc-800/80 bg-zinc-950/60 px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate font-mono text-[11px] text-zinc-100">
                          <span>{ide.name}</span>
                          {ide.configured && (
                            <span className="rounded border border-teal-600/50 bg-teal-950/60 px-1 py-0.2 text-[9px] text-teal-300">
                              ✓ configured
                            </span>
                          )}
                          {!ide.detected && !ide.configured && (
                            <span className="text-[9px] text-zinc-500">not detected</span>
                          )}
                        </p>
                        <p className="truncate font-mono text-[9px] text-zinc-500" title={ide.configPath}>
                          {ide.configPath}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant={ide.configured ? 'outline' : 'default'}
                          className={`h-6 px-2 font-mono text-[10px] ${
                            ide.configured
                              ? 'border-zinc-700 text-zinc-200 hover:bg-zinc-800'
                              : 'bg-teal-600 text-white hover:bg-teal-500'
                          }`}
                          onClick={() => void connectIdeOneClick(ide)}
                          disabled={busy || !serverReady}
                        >
                          {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                          {ide.configured ? 'Reconnect' : 'Connect'}
                        </Button>
                        {ide.configured && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-zinc-500 hover:text-red-300"
                            onClick={() => void removeIdeOneClick(ide)}
                            disabled={busy}
                            aria-label={`Remove PixelForge from ${ide.name}`}
                            title={`Remove PixelForge from ${ide.name}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )
          })()}
        </div>
      )}

      {/* ------------------------------------------------ connect assistant */}
      <div className="min-w-0 overflow-hidden rounded-lg border border-frost-900/60 bg-frost-950/20 p-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-frost-400" />
          <p className="font-mono text-xs text-zinc-100">Connect AI Assistant</p>
        </div>
        <p className="mt-1 break-words font-mono text-[10px] leading-tight text-zinc-400">
          Generate a one-time code for Codex, Claude, Z.AI, Cursor, or any MCP-capable IDE. It exchanges
          the code for its own token via the <code className="text-zinc-300">pair_client</code> tool. Codes expire in
          15 minutes and work once.
        </p>
        {!pairing ? (
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
            <Select value={ideName} onValueChange={setIdeName}>
              <SelectTrigger className="data-[size=default]:h-7 w-[130px] border-zinc-800 bg-zinc-900 px-2 font-mono text-[10px] text-zinc-300" aria-label="IDE assistant">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-950">
                {['Codex', 'Claude', 'Antigravity', 'Cursor', 'Other IDE'].map((name) => <SelectItem key={name} value={name} className="font-mono text-[11px] text-zinc-200">{name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={pairTier} onValueChange={(v) => setPairTier(v as 'L0' | 'L1' | 'L2')}>
              <SelectTrigger
                className="data-[size=default]:h-7 max-w-full w-[210px] gap-1 border-zinc-800 bg-zinc-900 px-2 font-mono text-[10px] text-zinc-300"
                aria-label="Pairing permission tier"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-950">
                <SelectItem value="L0" className="font-mono text-[11px] text-zinc-200">
                  L0 — read-only
                </SelectItem>
                <SelectItem value="L1" className="font-mono text-[11px] text-zinc-200">
                  L1 — read + undoable edits
                </SelectItem>
                <SelectItem value="L2" className="font-mono text-[11px] text-zinc-200">
                  L2 — full project control (recommended)
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 border-zinc-800 px-2.5 font-mono text-[10px] text-zinc-200 hover:text-frost-300"
              onClick={generate}
              disabled={pairingBusy || bridge.status !== 'connected'}
            >
              {pairingBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <ShieldCheck className="mr-1 h-3 w-3" />}
              Generate pairing code
            </Button>
          </div>
        ) : (
          <div className="mt-2 min-w-0 space-y-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <code
                className="min-w-[140px] flex-1 truncate rounded border border-frost-800/60 bg-zinc-950 px-2 py-1.5 font-mono text-xs tracking-wide text-frost-200"
                aria-label="Pairing code"
              >
                {pairing.token}
              </code>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 text-zinc-400 hover:text-zinc-200"
                  onClick={() => copy(pairing.token, 'code')}
                  aria-label="Copy pairing code"
                >
                  {copied === 'code' ? <Check className="h-3 w-3 text-frost-400" /> : <Copy className="h-3 w-3" />}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-1.5 font-mono text-[10px] text-zinc-400 hover:text-zinc-200"
                  onClick={() => ideGuide && void copy(ideGuide, 'guide')}
                  aria-label="Copy IDE connection guide"
                  title="Copy endpoint, pairing steps and full-access instructions"
                >
                  {copied === 'guide' ? <Check className="mr-1 h-3 w-3 text-frost-400" /> : <Copy className="mr-1 h-3 w-3" />} IDE guide
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-1.5 font-mono text-[10px] text-zinc-400 hover:text-red-300"
                  onClick={cancelPairing}
                  aria-label="Cancel pairing code"
                >
                  <Unlink className="h-3 w-3" />
                </Button>
              </div>
            </div>
            <p className="font-mono text-[10px] text-zinc-400">
              {tierSummary(pairing.tier)} · expires in{' '}
              <span className={secsLeft < 60 ? 'text-amber-400' : 'text-zinc-300'}>
                {Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, '0')}
              </span>
            </p>
            <p className="break-words font-mono text-[10px] leading-tight text-zinc-400">
              The client connects to <span className="break-all text-zinc-300">{bridge.server?.endpoint ?? 'http://127.0.0.1:3030/mcp'}</span> with
              <span className="text-zinc-300"> Authorization: Bearer &lt;code&gt;</span> and calls{' '}
              <span className="text-zinc-300">pair_client</span> — the returned token replaces the code immediately.
            </p>
          </div>
        )}
      </div>

      <div className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-mono text-xs text-zinc-100">Connection check</p>
            <p className="mt-0.5 text-[10px] text-zinc-500">After pairing, ask the IDE agent to call get_project_state, then run this check.</p>
          </div>
          <Button size="sm" variant="outline" className="h-7 border-zinc-700 font-mono text-[10px]" onClick={() => void checkConnection()} disabled={checking}>
            {checking ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}Check connection
          </Button>
        </div>
        {connectionCheck && (
          <div className="mt-2 grid gap-1 font-mono text-[10px] sm:grid-cols-2" role="status">
            {([
              ['MCP service on', connectionCheck.server],
              ['Editor attached', connectionCheck.editor],
              ['Assistant paired', connectionCheck.paired],
              ['Recent project read', connectionCheck.recentRead],
            ] as const).map(([label, ok]) => <p key={label} className={ok ? 'text-emerald-300' : 'text-amber-300'}>{ok ? '✓' : '○'} {label}</p>)}
            {connectionCheck.error && <p className="sm:col-span-2 text-amber-300">{connectionCheck.error}</p>}
            {!connectionCheck.recentRead && connectionCheck.paired && connectionCheck.editor && <p className="sm:col-span-2 text-zinc-400">No successful get_project_state call was observed in the last 30 minutes. Ask the paired IDE agent to run it, then check again.</p>}
          </div>
        )}
      </div>

      {/* --------------------------------------------------- client list */}
      <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <p className="font-mono text-xs text-zinc-100">Connected clients</p>
          <span className="shrink-0 font-mono text-[10px] text-zinc-400">{activeClients.length} active</span>
        </div>
        {clients.length === 0 ? (
          <p className="mt-1.5 font-mono text-[10px] text-zinc-400">No assistants paired yet.</p>
        ) : (
          <ul className="pixelforge-scroll mt-1.5 max-h-56 min-w-0 space-y-1 overflow-y-auto pr-1">
            {clients.map((c) => (
              <li key={c.clientId} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[11px] text-zinc-200">
                    {c.name}
                    {c.revoked && <span className="ml-1.5 text-[9px] uppercase text-red-400">revoked</span>}
                  </p>
                  <p className="truncate font-mono text-[9px] text-zinc-400">
                    {c.tier} · last seen {timeAgo(c.lastSeen)} · paired {new Date(c.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {!c.revoked ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-1.5 font-mono text-[10px] text-zinc-400 hover:text-red-300"
                    onClick={() => void revoke(c)}
                    aria-label={`Revoke ${c.name}`}
                  >
                    <Unlink className="mr-1 h-3 w-3" /> Revoke
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-1.5 font-mono text-[10px] text-zinc-400 hover:text-red-300"
                    onClick={() => void removeRevoked(c)}
                    aria-label={`Remove revoked ${c.name}`}
                    title="Remove this already-revoked client from the list"
                  >
                    <Trash2 className="mr-1 h-3 w-3" /> Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>



      {/* ------------------------------------------------- op history */}
      <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <p className="font-mono text-xs text-zinc-100">Recent MCP operations</p>
        <p className="mt-0.5 break-words font-mono text-[9px] leading-tight text-zinc-500">
          Security failures stay visible here. An auth failure from an IDE means it needs a fresh pairing token; it does not mean the server is exposed.
        </p>
        {ops.length === 0 ? (
          <p className="mt-1.5 font-mono text-[10px] text-zinc-400">No MCP tool calls yet.</p>
        ) : (
          <ul className="pixelforge-scroll mt-1.5 max-h-56 min-w-0 space-y-1 overflow-y-auto pr-1">
            {ops.map((op, i) => (
              <li key={`${op.ts}-${i}`} className="min-w-0 rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                  <span className={`min-w-0 truncate font-mono text-[10px] ${op.ok ? 'text-frost-300' : 'text-red-300'}`}>
                    {op.ok ? '✓' : '✗'} {op.tool}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-zinc-400">
                    {op.clientName} · {op.durationMs} ms · {new Date(op.ts).toLocaleTimeString()}
                  </span>
                </div>
                {op.summary && (
                  <p className="truncate font-mono text-[10px] text-zinc-400" title={op.summary}>
                    {op.summary}
                  </p>
                )}
                {!op.ok && op.errorCode && (
                  <p className="truncate font-mono text-[9px] text-red-400/80">{op.errorCode}</p>
                )}
                {!op.ok && operationFailureHint(op) && (
                  <p className="mt-0.5 break-words font-mono text-[9px] leading-snug text-amber-300/90">{operationFailureHint(op)}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ----------------------------------------------- troubleshooting */}
      <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <PlugZap className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          <p className="font-mono text-xs text-zinc-100">Troubleshooting</p>
        </div>
        <ul className="mt-1.5 min-w-0 space-y-1 break-words font-mono text-[10px] leading-tight text-zinc-400">
          <li>• The server binds <span className="text-zinc-300">127.0.0.1:3030</span> only — LAN devices cannot reach it.</li>
          <li>• Tool calls need <span className="text-zinc-300">Authorization: Bearer &lt;token&gt;</span> — the old static header is no longer accepted on MCP.</li>
          <li>• <span className="text-zinc-300">editor_not_connected</span> → keep the PixelForge app open (it is the tool executor).</li>
          <li>• <span className="text-zinc-300">dirty_project</span> → save the project, then retry the agent action.</li>
          <li>• <span className="text-zinc-300">rate_limited</span> → per tool tier: L0 60/min, L1 120/min, L2 60/min, L3 20/min (§5.5). Rejected calls still count — pace with <span className="text-zinc-300">get_quota</span>.</li>
          <li>• No paid tools: provider-backed image generation was removed. Everything agents call runs locally (pixels, layers, animation, procedural VFX).</li>
          <li>• Desktop app: it supervises the MCP service itself (starts, adopts or stops it) — no terminal needed.</li>
          <li>• Browser tab shows <span className="text-zinc-300">ERR_CONNECTION_REFUSED</span> on ws://127.0.0.1:3030 → no MCP service is running: open the desktop app, or start one with <span className="text-zinc-300">bun run dev</span> / <span className="text-zinc-300">npm run mcp:dev</span>.</li>
          <li>• Spawn-based clients: run <span className="text-zinc-300">mini-services/mcp-server/src/stdio-proxy.ts</span> with <span className="text-zinc-300">PF_MCP_TOKEN</span> = the <span className="text-zinc-300">paired client token</span> (not the one-time pairing code).</li>
        </ul>
      </div>
    </div>
  )
}
