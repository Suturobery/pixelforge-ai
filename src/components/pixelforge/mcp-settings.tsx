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
import { copyText } from '@/lib/pixelforge/desktop-bridge'
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
  Unlink,
} from 'lucide-react'

interface PairingClient {
  clientId: string
  name: string
  tier: 'L0' | 'L1'
  createdAt: string
  lastSeen: string | null
  revoked: boolean
}

interface OpRow {
  ts: string
  clientName: string
  tool: string
  tier: 'L0' | 'L1' | null
  ok: boolean
  errorCode: string | null
  durationMs: number
  summary: string | null
}

interface ApprovalRow {
  id: string
  tool: string
  clientName: string
  decision: 'approved' | 'denied' | 'timeout'
  at: string
  summary: string
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

export function McpConnections() {
  const bridge = useBridge()
  const agentApiEnabled = useAppSettings((s) => s.agentApiEnabled)
  const setSetting = useAppSettings((st) => st.setSetting)
  const { toast } = useToast()

  const [clients, setClients] = useState<PairingClient[]>([])
  const [ops, setOps] = useState<OpRow[]>([])
  const [approvals, setApprovals] = useState<{ pending: ApprovalRow[]; recent: ApprovalRow[] } | null>(null)
  const [pairing, setPairing] = useState<{ token: string; tier: 'L0' | 'L1' | 'L2' | 'L3'; expiresAt: string } | null>(null)
  const [pairTier, setPairTier] = useState<'L0' | 'L1' | 'L2' | 'L3'>('L1')
  const [pairingBusy, setPairingBusy] = useState(false)
  const [copied, setCopied] = useState<'code' | 'endpoint' | null>(null)

  const refresh = useCallback(async () => {
    const [c, o, a] = await Promise.all([
      mcpCtrl<{ clients: PairingClient[] }>({ kind: 'clients-list' }),
      mcpCtrl<{ ops: OpRow[] }>({ kind: 'ops-recent', limit: 12 }),
      mcpCtrl<{ approvals: { pending: ApprovalRow[]; recent: ApprovalRow[] } }>({ kind: 'approvals-list' }),
    ])
    if (c.ok && c.data) setClients(c.data.clients)
    if (o.ok && o.data) setOps(o.data.ops)
    if (a.ok && a.data) setApprovals(a.data.approvals)
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 8000)
    return () => clearInterval(t)
  }, [refresh])

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

  const copy = async (text: string, what: 'code' | 'endpoint') => {
    try {
      await copyText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast({ title: 'Copy failed', description: 'Clipboard is unavailable.', variant: 'destructive' })
    }
  }

  const secsLeft = pairing ? Math.max(0, Math.floor((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)) : 0
  const activeClients = clients.filter((c) => !c.revoked)
  const serverReady = bridge.status === 'connected' && bridge.server?.mcpEnabled === true

  return (
    <div className="space-y-3 pt-3">
      {/* ------------------------------------------------ server status */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Bot className="h-3.5 w-3.5 shrink-0 text-frost-400" />
            <div className="min-w-0">
              <p className="font-mono text-xs text-zinc-100">MCP server</p>
              <p className="font-mono text-[10px] leading-tight text-zinc-400">
                Model Context Protocol — real tools, real protocol (127.0.0.1 only)
              </p>
            </div>
          </div>
          <Switch
            checked={agentApiEnabled}
            onCheckedChange={(v) => setSetting('agentApiEnabled', v)}
            aria-label="Enable MCP server"
          />
        </div>
        <div className="mt-2 grid gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-400 sm:grid-cols-2">
          <span className="flex items-center gap-1.5">
            <StatusDot ok={bridge.status === 'connected'} />
            editor link: {bridge.status}
          </span>
          <span className="flex items-center gap-1.5">
            <StatusDot ok={serverReady} warn={agentApiEnabled && !serverReady} />
            server: {!agentApiEnabled ? 'disabled' : serverReady ? 'accepting tools' : 'starting / reconnecting'}
          </span>
          <span className="flex items-center gap-1.5">
            <StatusDot ok={!!bridge.server?.clientsPaired} />
            paired clients: {bridge.server?.clientsPaired ?? activeClients.length}
          </span>
          <span className="flex items-center gap-1.5">
            <StatusDot ok={!!bridge.server?.clientsConnected} warn={!bridge.server} />
            mcp sessions: {bridge.server?.clientsConnected ?? 0}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
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
          <p className="mt-1.5 font-mono text-[10px] leading-tight text-amber-400/90">
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

      {/* ------------------------------------------------ connect assistant */}
      <div className="rounded-lg border border-frost-900/60 bg-frost-950/20 p-2.5">
        <div className="flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-frost-400" />
          <p className="font-mono text-xs text-zinc-100">Connect AI Assistant</p>
        </div>
        <p className="mt-1 font-mono text-[10px] leading-tight text-zinc-400">
          Generate a one-time 6-word code, give it to your assistant (Claude Desktop, Cursor, …), and it exchanges
          the code for its own token via the <code className="text-zinc-300">pair_client</code> tool. Codes expire in
          15 minutes and work once.
        </p>
        {!pairing ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select value={pairTier} onValueChange={(v) => setPairTier(v as 'L0' | 'L1' | 'L2' | 'L3')}>
              <SelectTrigger
                className="data-[size=default]:h-7 w-[170px] gap-1 border-zinc-800 bg-zinc-900 px-2 font-mono text-[10px] text-zinc-300"
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
                  L2 — edits + destructive ops
                </SelectItem>
                <SelectItem value="L3" className="font-mono text-[11px] text-zinc-200">
                  L3 — everything incl. paid generation
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-zinc-800 px-2.5 font-mono text-[10px] text-zinc-200 hover:text-frost-300"
              onClick={generate}
              disabled={pairingBusy || bridge.status !== 'connected'}
            >
              {pairingBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <ShieldCheck className="mr-1 h-3 w-3" />}
              Generate pairing code
            </Button>
          </div>
        ) : (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <code
                className="min-w-0 flex-1 truncate rounded border border-frost-800/60 bg-zinc-950 px-2 py-1.5 font-mono text-xs tracking-wide text-frost-200"
                aria-label="Pairing code"
              >
                {pairing.token}
              </code>
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
                className="h-6 shrink-0 px-1.5 font-mono text-[10px] text-zinc-400 hover:text-red-300"
                onClick={cancelPairing}
                aria-label="Cancel pairing code"
              >
                <Unlink className="h-3 w-3" />
              </Button>
            </div>
            <p className="font-mono text-[10px] text-zinc-400">
              tier {pairing.tier} · expires in{' '}
              <span className={secsLeft < 60 ? 'text-amber-400' : 'text-zinc-300'}>
                {Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, '0')}
              </span>
            </p>
            <p className="font-mono text-[10px] leading-tight text-zinc-400">
              The client connects to <span className="text-zinc-300">{bridge.server?.endpoint ?? 'http://127.0.0.1:3030/mcp'}</span> with
              <span className="text-zinc-300"> Authorization: Bearer &lt;code&gt;</span> and calls{' '}
              <span className="text-zinc-300">pair_client</span> — the returned token replaces the code immediately.
            </p>
          </div>
        )}
      </div>

      {/* --------------------------------------------------- client list */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <div className="flex items-center justify-between">
          <p className="font-mono text-xs text-zinc-100">Connected clients</p>
          <span className="font-mono text-[10px] text-zinc-400">{activeClients.length} active</span>
        </div>
        {clients.length === 0 ? (
          <p className="mt-1.5 font-mono text-[10px] text-zinc-400">No assistants paired yet.</p>
        ) : (
          <ul className="pixelforge-scroll mt-1.5 max-h-40 space-y-1 overflow-y-auto pr-1">
            {clients.map((c) => (
              <li key={c.clientId} className="flex items-center justify-between gap-2 rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1.5">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[11px] text-zinc-200">
                    {c.name}
                    {c.revoked && <span className="ml-1.5 text-[9px] uppercase text-red-400">revoked</span>}
                  </p>
                  <p className="font-mono text-[9px] text-zinc-400">
                    {c.tier} · last seen {timeAgo(c.lastSeen)} · paired {new Date(c.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {!c.revoked && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-1.5 font-mono text-[10px] text-zinc-400 hover:text-red-300"
                    onClick={() => void revoke(c)}
                    aria-label={`Revoke ${c.name}`}
                  >
                    <Unlink className="mr-1 h-3 w-3" /> Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* -------------------------------------------- approval center feed */}
      <div className="rounded-lg border border-amber-900/40 bg-amber-950/10 p-2.5">
        <div className="flex items-center justify-between">
          <p className="font-mono text-xs text-zinc-100">Approval center (paid ops)</p>
          <span className="font-mono text-[10px] text-zinc-400">
            {approvals?.pending.length ? `${approvals.pending.length} pending` : 'none waiting'}
          </span>
        </div>
        {approvals?.pending.length ? (
          <ul className="mt-1.5 space-y-1">
            {approvals.pending.map((p) => (
              <li key={p.id} className="rounded border border-amber-600/40 bg-amber-950/30 px-2 py-1">
                <p className="truncate font-mono text-[10px] text-amber-300">
                  ⏳ {p.tool} — {p.clientName}
                </p>
                <p className="truncate font-mono text-[10px] text-zinc-400" title={p.summary}>{p.summary}</p>
              </li>
            ))}
          </ul>
        ) : null}
        {approvals && approvals.recent.length > 0 && (
          <ul className="pixelforge-scroll mt-1.5 max-h-28 space-y-1 overflow-y-auto pr-1">
            {approvals.recent.map((r, i) => (
              <li key={`${r.id}-${i}`} className="rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`font-mono text-[10px] ${
                      r.decision === 'approved' ? 'text-teal-300' : r.decision === 'denied' ? 'text-red-300' : 'text-amber-300'
                    }`}
                  >
                    {r.decision === 'approved' ? '✓' : r.decision === 'denied' ? '✗' : '⏱'} {r.decision} · {r.tool}
                  </span>
                  <span className="font-mono text-[9px] text-zinc-500">
                    {r.clientName} · {new Date(r.at).toLocaleTimeString()}
                  </span>
                </div>
                <p className="truncate font-mono text-[9px] text-zinc-500" title={r.summary}>{r.summary}</p>
              </li>
            ))}
          </ul>
        )}
        {approvals && approvals.pending.length === 0 && approvals.recent.length === 0 && (
          <p className="mt-1.5 font-mono text-[10px] text-zinc-400">
            No paid-op requests yet — generate_sprite calls will ask here before anything is spent.
          </p>
        )}
      </div>

      {/* ------------------------------------------------- op history */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <p className="font-mono text-xs text-zinc-100">Recent MCP operations</p>
        {ops.length === 0 ? (
          <p className="mt-1.5 font-mono text-[10px] text-zinc-400">No MCP tool calls yet.</p>
        ) : (
          <ul className="pixelforge-scroll mt-1.5 max-h-44 space-y-1 overflow-y-auto pr-1">
            {ops.map((op, i) => (
              <li key={`${op.ts}-${i}`} className="rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-mono text-[10px] ${op.ok ? 'text-frost-300' : 'text-red-300'}`}>
                    {op.ok ? '✓' : '✗'} {op.tool}
                  </span>
                  <span className="font-mono text-[9px] text-zinc-400">
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
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ----------------------------------------------- troubleshooting */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <div className="flex items-center gap-1.5">
          <PlugZap className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          <p className="font-mono text-xs text-zinc-100">Troubleshooting</p>
        </div>
        <ul className="mt-1.5 space-y-1 font-mono text-[10px] leading-tight text-zinc-400">
          <li>• The server binds <span className="text-zinc-300">127.0.0.1:3030</span> only — LAN devices cannot reach it.</li>
          <li>• Tool calls need <span className="text-zinc-300">Authorization: Bearer &lt;token&gt;</span> — the old static header is no longer accepted on MCP.</li>
          <li>• <span className="text-zinc-300">editor_not_connected</span> → keep the PixelForge app open (it is the tool executor).</li>
          <li>• <span className="text-zinc-300">dirty_project</span> → save the project, then retry the agent action.</li>
          <li>• <span className="text-zinc-300">rate_limited</span> → per tool tier: L0 60/min, L1 120/min, L2 60/min, L3 20/min (§5.5). Rejected calls still count — pace with <span className="text-zinc-300">get_quota</span>.</li>
          <li>• <span className="text-zinc-300">generate_sprite</span> (paid) parks until you click Approve/Deny on the approval card — denied or timed out means nothing was spent. Queue status: <span className="text-zinc-300">get_approvals</span>.</li>
          <li>• Desktop app: it supervises the MCP service itself (starts, adopts or stops it) — no terminal needed.</li>
          <li>• Browser tab shows <span className="text-zinc-300">ERR_CONNECTION_REFUSED</span> on ws://127.0.0.1:3030 → no MCP service is running: open the desktop app, or start one with <span className="text-zinc-300">bun run dev</span> / <span className="text-zinc-300">npm run mcp:dev</span>.</li>
          <li>• Spawn-based clients: run <span className="text-zinc-300">mini-services/mcp-server/src/stdio-proxy.ts</span> with <span className="text-zinc-300">PF_MCP_TOKEN</span> = the <span className="text-zinc-300">paired client token</span> (not the one-time pairing code).</li>
        </ul>
      </div>
    </div>
  )
}
