// PixelForge AI — Agent Console (Task 8 edition).
//
// Runs the SAME tool catalog as the real MCP server, but locally: every call
// executes in-process through ./mcp-tools on the shared CommandBus, so edits
// are immediately visible on the canvas, fully undoable (Ctrl+Z), and never
// touch the legacy REST runner (retired in Task 8 — a separate editor state).
// External assistants reach the same tools through the MCP server instead.

'use client'

import { useEffect, useRef, useState } from 'react'
import { computeStateHash, executeMcpTool, type ToolExecResult, type ToolReview } from '@/lib/pixelforge/mcp-tools'
import { MCP_TOOLS } from '@/lib/pixelforge/mcp-tool-catalog'
import { useEditor } from '@/lib/pixelforge/store'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { copyText } from '@/lib/pixelforge/desktop-bridge'
import { getBridgeState, getRecentRemoteEdits, subscribeBridge, type RemoteEditRecord } from '@/lib/pixelforge/mcp-bridge'
import { drawSpritePreview } from './sprite-preview'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { friendlyError } from '@/lib/utils'
import { AGENT_FETCH_HEADERS } from '@/lib/pixelforge/agent-headers'
import { describeApiErrorInline } from '@/lib/pixelforge/api-error'
import {
  buildAgentInstructions,
  type AgentToolCall,
} from '@/lib/pixelforge/ai/agent-chat'
import { Bot, Copy, History, Loader2, Play, Square, ChevronDown, Eye, Undo2, Film } from 'lucide-react'

interface SessionOp {
  id: number
  tool: string
  args: string
  ok: boolean
  summary: string
  at: string
}

interface ChangeScope {
  projectName: string
  canvas: string
  clipName: string
  frameNumber: number
  layerName: string
  region: string
  stateHash: string
}

interface PendingChange {
  call: AgentToolCall
  args: Record<string, unknown>
  scope: ChangeScope
}

const PIXEL_MUTATION_TOOLS = new Set([
  'set_pixels',
  'fill_rect',
  'replace_color',
  'flip_frame',
  'rotate_frame',
  'shift_frame',
  'center_content',
  'remap_palette',
  'beautify_layer',
  'auto_trim',
])

function isDocumentMutation(name: string): boolean {
  return MCP_TOOLS.find((tool) => tool.name === name)?.tier !== 'L0'
}

function describeRegion(args: Record<string, unknown>, selection: { x: number; y: number; w: number; h: number } | null): string {
  const rect = args.rect
  if (
    rect &&
    typeof rect === 'object' &&
    !Array.isArray(rect) &&
    typeof (rect as Record<string, unknown>).x === 'number' &&
    typeof (rect as Record<string, unknown>).y === 'number' &&
    typeof (rect as Record<string, unknown>).w === 'number' &&
    typeof (rect as Record<string, unknown>).h === 'number'
  ) {
    const value = rect as { x: number; y: number; w: number; h: number }
    return `region x:${value.x} y:${value.y} · ${value.w}×${value.h}`
  }
  if (selection) return `active selection x:${selection.x} y:${selection.y} · ${selection.w}×${selection.h}`
  return 'entire active layer'
}

/** Tool picker groups: read-only helpers (L0) above editors (L1), alphabetical
 *  within each tier, narrowed by the filter box. */
function toolGroups(filter = ''): Array<{ tier: 'L0' | 'L1' | 'L2' | 'L3'; tools: typeof MCP_TOOLS }> {
  const f = filter.trim().toLowerCase()
  const groups: Array<{ tier: 'L0' | 'L1' | 'L2' | 'L3'; tools: typeof MCP_TOOLS }> = []
  for (const tier of ['L0', 'L1', 'L2', 'L3'] as const) {
    const tools = MCP_TOOLS.filter((t) => t.tier === tier && t.name.toLowerCase().includes(f)).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    if (tools.length > 0) groups.push({ tier, tools })
  }
  return groups
}

export function AgentPanel() {
  const agentApiEnabled = useAppSettings((s) => s.agentApiEnabled)
  const { toast } = useToast()
  const [toolName, setToolName] = useState<string>(MCP_TOOLS[0]!.name)
  const [argsText, setArgsText] = useState<string>(JSON.stringify(MCP_TOOLS[0]!.example, null, 2))
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [resultOk, setResultOk] = useState(true)
  const [ops, setOps] = useState<SessionOp[]>([])
  // live JSON syntax check — run stays disabled while invalid
  let argsValid = true
  try {
    JSON.parse(argsText)
  } catch {
    argsValid = false
  }
  const [nlText, setNlText] = useState('')
  const [toolFilter, setToolFilter] = useState('')
  const [showManual, setShowManual] = useState(false)
  // interpreted-action preview: plain language ABOVE the JSON, filled by
  // applyCommand (typed commands) before anything runs
  const [interpreted, setInterpreted] = useState<{ plain: string; target: string } | null>(null)
  // clarify choices for ambiguous commands ("add 4 frames" — empty or copies?)
  const [clarify, setClarify] = useState<{ plain: string; options: Array<{ label: string; tool: string; args: Record<string, unknown> }> } | null>(null)
  const [latestReview, setReview] = useState<(ToolReview & { tool: string; clientName?: string }) | null>(null)
  const loadEpoch = useEditor((s) => s.loadEpoch)
  const review = latestReview?.loadEpoch === loadEpoch ? latestReview : null
  const [remoteEdits, setRemoteEdits] = useState<RemoteEditRecord[]>(() => getRecentRemoteEdits())
  const [connectedClients, setConnectedClients] = useState<number>(() => {
    const b = getBridgeState()
    return b.status === 'connected' ? (b.server?.clientsConnected ?? 0) : 0
  })
  // AI agent approval gate: resolves the pending Promise from the UI buttons
  const pendingResolveRef = useRef<((v: 'run' | 'skip') => void) | null>(null)
  const [mcpStatus, setMcpStatus] = useState<{ reachable: boolean; authRequired: boolean; serverName?: string } | null>(null)
  const reviewOpenRef = useRef<HTMLDivElement | null>(null)

  /** Rule-based natural-language → tool mapping. Fills the form for review;
   *  nothing runs until the user presses Run. */
  const parseCommand = (text: string): ({ tool: string; args: Record<string, unknown> } | { clarify: string }) | null => {
    const t = text.toLowerCase().trim()
    const num = t.match(/\b(\d+)\b/)?.[1]
    if (/\b(flip|mirror)\b/.test(t)) {
      const axis = /vert|up.?down|v\b/.test(t) ? 'vertical' : 'horizontal'
      return { tool: 'flip_frame', args: { axis } }
    }
    if (/\brotate\b/.test(t)) {
      const direction = /ccw|counter|left\b|anti/.test(t) ? 'ccw' : 'cw'
      return { tool: 'rotate_frame', args: { direction } }
    }
    if (/\bshift\b|\bmove (?:left|right|up|down)\b/.test(t)) {
      const dx = /left/.test(t) ? -(parseInt(num ?? '2', 10) || 2) : /right/.test(t) ? parseInt(num ?? '2', 10) || 2 : 0
      const dy = /up/.test(t) ? -(parseInt(num ?? '2', 10) || 2) : /down/.test(t) ? parseInt(num ?? '2', 10) || 2 : 0
      return { tool: 'shift_frame', args: { dx, dy } }
    }
    if (/\bundo\b/.test(t)) return { tool: 'undo', args: {} }
    if (/\bredo\b/.test(t)) return { tool: 'redo', args: {} }
    const frameCount = num ? Math.min(8, Math.max(1, parseInt(num, 10))) : 1
    const wantsCopies = /\b(cop\w*|duplicate\w*|clone\w*)\b/.test(t)
    const wantsEmpty = /\b(empty|blank)\b/.test(t)
    if (/\badd\b.*\bframes?\b/.test(t)) {
      if (frameCount === 1) return { tool: 'add_frame', args: wantsCopies ? { copyContent: true } : {} }
      // N frames: one undoable BATCH (all-or-nothing) — but empty vs copies
      // must be explicit when N > 1 (silently guessing destroys work intent)
      if (!wantsCopies && !wantsEmpty) {
        return { clarify: `Add ${frameCount} frames - empty or copies of the current frame?` }
      }
      const steps: Array<{ tool: string; args: Record<string, unknown> }> = []
      for (let i = 0; i < frameCount; i++) {
        steps.push(wantsCopies ? { tool: 'add_frame', args: { copyContent: true } } : { tool: 'add_frame', args: {} })
      }
      return { tool: 'batch', args: { steps } }
    }
    if (/\bduplicate\b.*\bframe\b/.test(t)) return { tool: 'duplicate_frame', args: {} }
    if (/\bdelete\b.*\bframe\b/.test(t)) return { tool: 'delete_frame', args: {} }
    if (/\badd\b.*\blayer\b/.test(t)) {
      const nm = t.match(/named\s+(\S+)/)?.[1]
      return { tool: 'add_layer', args: nm ? { name: nm } : {} }
    }
    if (/\bmerge\b/.test(t)) return { tool: 'merge_down', args: {} }
    if (/\bopacity\b/.test(t)) {
      const pct = parseInt(t.match(/(\d{1,3})\b/)?.[1] ?? '100', 10)
      return { tool: 'set_layer_props', args: { patch: { opacity: Math.min(100, Math.max(0, pct)) / 100 } } }
    }
    if (/\b(new|create)\b.*\bproject\b/.test(t)) {
      const nm = t.match(/named\s+(\S+)/)?.[1] ?? 'untitled'
      return { tool: 'create_project', args: { name: nm } }
    }
    return null
  }

  const applyCommand = () => {
    const mapped = parseCommand(nlText)
    if (!mapped) {
      // explain what the panel understood and what it supports — NOTHING runs
      // or edits until the user corrects the command
      const verbs = ['flip', 'rotate', 'shift', 'move', 'undo', 'redo', 'add', 'duplicate', 'delete', 'merge', 'opacity', 'create'].filter((v) =>
        new RegExp('\\b' + v, 'i').test(nlText),
      )
      const understood =
        verbs.length > 0
          ? `I recognized ${verbs.map((v) => `"${v}"`).join(', ')} but couldn't map them to a supported edit.`
          : 'No supported edit found in that command.'
      toast({
        title: understood,
        description:
          'Supported: flip h/v · rotate cw/ccw · shift left/right/up/down · add N empty frames · add N copies · duplicate frame · add layer · merge · opacity N · new project · undo · redo',
        variant: 'destructive',
      })
      setInterpreted(null)
      setClarify(null)
      return
    }
    if ('clarify' in mapped) {
      const msg = (mapped as { clarify: string }).clarify
      const n = parseInt(nlText.match(/\b(\d+)\b/)?.[1] ?? '4', 10) || 4
      setClarify({
        plain: msg,
        options: [
          { label: `Add ${n} empty frames`, tool: 'batch', args: { steps: Array.from({ length: n }, () => ({ tool: 'add_frame', args: {} })) } },
          { label: `Add ${n} copies of the current frame`, tool: 'batch', args: { steps: Array.from({ length: n }, () => ({ tool: 'add_frame', args: { copyContent: true } })) } },
        ],
      })
      setInterpreted(null)
      return
    }
    const mappedTool = mapped as { tool: string; args: Record<string, unknown> }
    const tool = MCP_TOOLS.find((x) => x.name === mappedTool.tool)
    if (!tool) return
    const merged = { ...structuredClone(tool.example), ...mappedTool.args }
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === 'string' && /^<.*>$/.test(v.trim())) delete merged[k]
    }
    setToolName(tool.name)
    setArgsText(JSON.stringify(merged, null, 2))
    setResult(null)
    setClarify(null)
    setShowManual(true)
    // plain-language interpreted action + target ABOVE the JSON controls
    const st = useEditor.getState()
    const clip = st.project.clips.find((c) => c.id === st.activeClipId) ?? st.project.clips[0]
    const target = clip
      ? `clip "${clip.name}" (${clip.layers.length} layer${clip.layers.length === 1 ? '' : 's'}, ${clip.frames.length} frame${clip.frames.length === 1 ? '' : 's'})`
      : 'active clip'
    const stepCount = (mappedTool.args as { steps?: unknown[] }).steps?.length
    const plain =
      mappedTool.tool === 'batch'
        ? `Will: run ${stepCount ?? '?'} add_frame steps as ONE undoable operation on ${target} — nothing runs until you press Run.`
        : `Will: ${tool.description.split('.')[0]} on ${target} — nothing runs until you press Run.`
    setInterpreted({ plain, target: mappedTool.tool })
    toast({ title: `Ready: ${tool.name}`, description: 'Review the interpreted action, then press Run.' })
  }

  const pickTool = (name: string) => {
    const t = MCP_TOOLS.find((x) => x.name === name)
    setToolName(name)
    if (t) setArgsText(JSON.stringify(t.example, null, 2))
    setResult(null)
  }

  const logOp = (tool: string, args: Record<string, unknown>, ok: boolean, summary: string) => {
    setOps((prev) =>
      [
        {
          // derive inside the updater — the old opSeq closure repeated ids
          id: (prev[0]?.id ?? -1) + 1,
          tool,
          args: JSON.stringify(args),
          ok,
          summary,
          at: new Date().toLocaleTimeString(),
        },
        ...prev,
      ].slice(0, 20),
    )
  }


  const run = async () => {
    if (running) return
    let parsedArgs: Record<string, unknown>
    try {
      parsedArgs = JSON.parse(argsText) as Record<string, unknown>
    } catch {
      toast({ title: 'Invalid JSON args', variant: 'destructive' })
      return
    }

    setRunning(true)
    setReview(null)
    try {
      // strip example placeholders ("<projectId>") — the executor resolves
      // active clip/frame/layer automatically when refs are omitted
      const clean: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(parsedArgs)) {
        if (typeof v === 'string' && /^<.*>$/.test(v.trim())) continue
        clean[k] = v
      }

      const selectedTool = MCP_TOOLS.find((item) => item.name === toolName)
      const res: ToolExecResult = await executeMcpTool(toolName, clean, {
        clientId: 'agent-console',
        clientName: 'agent-console',
        tier: selectedTool?.tier ?? 'L0',
        onReview: (snapshot) => setReview({ ...snapshot, tool: toolName }),
      })
      setResult(JSON.stringify(res, null, 2))
      setResultOk(res.ok)
      setOps((prev) =>
        [
          {
            id: (prev[0]?.id ?? -1) + 1,
            tool: toolName,
            args: argsText,
            ok: res.ok,
            summary: res.summary ?? res.error?.message ?? '',
            at: new Date().toLocaleTimeString(),
          },
          ...prev,
        ].slice(0, 20)
      )
      if (res.ok) {
        toast({ title: `Tool ${toolName} executed`, description: res.summary ?? 'See result below.' })
      } else {
        toast({ title: `Tool error: ${res.error?.code ?? 'failed'}`, description: res.error?.message, variant: 'destructive' })
      }
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    let alive = true
    void fetch('/api/mcp/status', { headers: AGENT_FETCH_HEADERS })
      .then((r) => r.json())
      .then((j: { reachable: boolean; authRequired: boolean; serverInfo?: { name?: string } | null }) => {
        if (alive) setMcpStatus({ reachable: j.reachable, authRequired: j.authRequired, serverName: j.serverInfo?.name })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // live remote-edit feed: refresh the session log reactively and, when a
  // connected IDE agent just changed pixels, flip Review Result to that edit
  const lastRemoteTopRef = useRef<RemoteEditRecord | undefined>(remoteEdits[0])
  useEffect(() => {
    const unsubscribe = subscribeBridge((bridge) => {
      setConnectedClients(bridge.status === 'connected' ? (bridge.server?.clientsConnected ?? 0) : 0)
      const next = getRecentRemoteEdits()
      const newest = next[0]
      if (newest !== lastRemoteTopRef.current) {
        lastRemoteTopRef.current = newest
        setRemoteEdits(next)
        if (newest?.review) {
          setReview({ ...newest.review, tool: newest.tool, clientName: newest.clientName })
        }
      }
    })
    return unsubscribe
  }, [])

  // Agent API disabled in Settings → MCP: show a notice instead of the console.
  // The status effect stays above this branch so Hooks keep their call order.
  if (!agentApiEnabled) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Bot className="h-6 w-6 text-zinc-400" />
        <p className="max-w-[240px] font-mono text-[10px] leading-relaxed text-zinc-400">
          The Agent API (MCP) is currently disabled. Enable it in{' '}
          <span className="text-frost-300">Settings → MCP</span> to run editor tools here or
          from external AI assistants.
        </p>
      </div>
    )
  }

  return (
    <div className="pixelforge-scroll mx-auto flex h-full w-full max-w-[520px] flex-col gap-3 overflow-x-hidden overflow-y-auto p-3">
      {/* slim header: identity + MCP status + brief export */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 shrink-0 text-frost-400" aria-hidden />
          <span className="shrink-0 font-mono text-[11px] font-semibold text-zinc-200">MCP Tools</span>
          <span
            className={`inline-flex min-w-0 items-center gap-1 truncate rounded-full border px-1.5 py-px font-mono text-[9px] ${
              mcpStatus === null
                ? 'border-zinc-700 text-zinc-400'
                : mcpStatus.reachable
                  ? mcpStatus.authRequired
                    ? 'border-amber-500/40 text-amber-300'
                    : 'border-emerald-500/40 text-emerald-300'
                  : 'border-zinc-700 text-zinc-500'
            }`}
            title={
              mcpStatus?.reachable
                ? mcpStatus.authRequired
                  ? 'MCP server is running — paired clients only'
                  : 'MCP server is running and accepting sessions'
                : 'MCP server not detected — tools run locally, built-in catalog (E2E-tested against the server)'
            }
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                mcpStatus === null
                  ? 'bg-zinc-500'
                  : mcpStatus.reachable
                    ? mcpStatus.authRequired
                      ? 'bg-amber-400'
                      : 'bg-emerald-400'
                    : 'bg-zinc-600'
              }`}
            />
            {mcpStatus === null
              ? 'checking…'
              : mcpStatus.reachable
                ? connectedClients > 0
                  ? `${connectedClients} IDE live`
                  : mcpStatus.authRequired
                    ? 'MCP live · pairing'
                    : 'MCP live'
                : 'local mode'}
          </span>
          <button
            type="button"
            className="ml-auto shrink-0 rounded px-1 font-mono text-[9px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={() => {
              void (async () => {
                const status = await window.pixelforge?.mcp.status()
                if (!status?.ready || !status.endpoint) throw new Error('MCP is not ready')
                return copyText(buildAgentInstructions(status.endpoint))
              })()
                .then(() => toast({ title: 'Agent instructions copied', description: 'Paste into Claude Code, Codex, Cursor, or Antigravity.' }))
                .catch(() => toast({ title: 'MCP is not ready', description: 'Keep the desktop app open, then try again.', variant: 'destructive' }))
            }}
            aria-label="Copy agent instructions for external AI assistants"
            title="Tools run locally on the shared CommandBus — edits are instant and undoable (Ctrl+Z). External assistants connect via the MCP server."
          >
            <Copy className="mr-0.5 inline h-3 w-3" /> brief
          </button>
        </div>
        <p className="font-mono text-[9px] leading-tight text-zinc-500">
          Run PixelForge actions locally, inspect 1×/3× before-after style checks, or test any MCP tool. Chat with your AI in Claude Code, Codex, or Cursor.
        </p>
      </div>

      {/* ---------------------------- Quick actions (no AI needed) ---------------------------- */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
        <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Quick actions</div>
        <div className="flex flex-wrap gap-1">
          {([
            ['Outline + shade', 'beautify_layer', {}],
            ['Create 4 empty frames', 'add_clip', { name: 'idle-2', fps: 8, frameCount: 4 }],
          ] as const).map(([label, tool, args]) => (
            <button
              key={label}
              type="button"
              disabled={running}
              onClick={async () => {
                setRunning(true)
                try {
                  const r: ToolExecResult = await executeMcpTool(tool, args, {
                    clientId: 'agent-console',
                    clientName: 'agent-console',
                    tier: 'L1',
                  })
                  setResult(JSON.stringify(r, null, 2))
                  setResultOk(r.ok)
                  if (r.ok) toast({ title: label, description: r.summary ?? 'Done — see result.' })
                  else toast({ title: `${label} failed`, description: r.error?.message, variant: 'destructive' })
                } finally {
                  setRunning(false)
                }
              }}
              className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[10px] text-zinc-300 hover:border-frost-500/60 hover:text-frost-300 disabled:opacity-40"
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            disabled={running}
            onClick={() => {
              // open the EXISTING Motion workflow on the active clip
              useEditor.getState().requestRightTab('motion')
              const st = useEditor.getState()
              const clip = st.project.clips.find((c) => c.id === st.activeClipId) ?? st.project.clips[0]
              if (clip && clip.parts.length === 0) {
                toast({
                  title: 'Configure parts first',
                  description: 'In the Motion panel (step 2) tag head/body/leg parts with Auto-detect or a marquee — then Generate preview → Accept.',
                })
              } else {
                toast({ title: 'Motion panel opened', description: 'Pick Idle (default) → Generate preview → Accept to commit frames.' })
              }
            }}
            className="flex items-center gap-1 rounded border border-frost-800/60 bg-frost-950/40 px-2 py-1 font-mono text-[10px] text-frost-300 hover:border-frost-500/60 disabled:opacity-40"
            aria-label="Preview Idle Animation"
            title="Opens the existing Motion workflow: pick Idle, Generate preview, Accept"
          >
            <Film className="h-3 w-3" /> Preview Idle Animation
          </button>
          {review && (
            <button
              type="button"
              onClick={() => {
                reviewOpenRef.current?.scrollIntoView({ block: 'start' })
              }}
              className="flex items-center gap-1 rounded border border-teal-700/60 bg-teal-950/40 px-2 py-1 font-mono text-[10px] text-teal-300 hover:border-teal-500"
              aria-label="Review Result"
              title="Show the affected target, before/after, and technical checks for the last edit"
            >
              <Eye className="h-3 w-3" /> Review Result
            </button>
          )}
        </div>
      </div>

      {/* ---------------------------- manual tools (collapsible) ---------------------------- */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
        <button
          type="button"
          onClick={() => setShowManual((v) => !v)}
          aria-expanded={showManual}
          className="flex w-full items-center gap-1.5 px-2.5 py-2 font-mono text-[10px] uppercase tracking-wider text-zinc-400 hover:text-zinc-200"
        >
          Manual tools
          <ChevronDown className={`ml-auto h-3.5 w-3.5 transition-transform ${showManual ? 'rotate-180' : ''}`} />
        </button>
        {showManual && (
        <div className="space-y-2.5 px-2.5 pb-2.5">
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-400" htmlFor="pf-nl">
            Quick command (plain English)
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="pf-nl"
              value={nlText}
              onChange={(e) => setNlText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyCommand()
              }}
              placeholder='e.g. "flip h" · "rotate ccw" · "add frame" · "opacity 50"'
              aria-label="Natural language command"
              className="h-8 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus-visible:border-frost-500/60"
            />
            <Button size="sm" variant="outline" className="h-8 shrink-0 border-zinc-800 font-mono text-[11px] text-zinc-300" onClick={applyCommand}>
              Map
            </Button>
          </div>
        </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className="block font-mono text-[10px] uppercase tracking-wider text-zinc-400" htmlFor="mcp-tool">
            Tool ({MCP_TOOLS.length})
          </label>
          <input
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            placeholder="filter…"
            aria-label="Filter tools"
            className="h-6 w-24 rounded border border-zinc-800 bg-zinc-900 px-1.5 font-mono text-[10px] text-zinc-200 outline-none placeholder:text-zinc-500 focus-visible:border-frost-500/60"
          />
        </div>
        <select
          id="mcp-tool"
          value={toolName}
          onChange={(e) => pickTool(e.target.value)}
          className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 font-mono text-xs text-zinc-200"
        >
          {toolGroups(toolFilter).map((g) => (
            <optgroup key={g.tier} label={`${g.tier} — ${{ L0: 'read-only', L1: 'editors', L2: 'destructive', L3: 'paid / AI' }[g.tier]} (${g.tools.length})`}>
              {g.tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <div className="mt-1 flex items-start gap-1.5">
          <span
            className={`shrink-0 rounded border px-1 py-px font-mono text-[9px] uppercase tracking-wider ${
              MCP_TOOLS.find((t) => t.name === toolName)?.tier === 'L1'
                ? 'border-frost-800/60 bg-frost-950/40 text-frost-300'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400'
            }`}
          >
            {MCP_TOOLS.find((t) => t.name === toolName)?.tier}
          </span>
          <p className="font-mono text-[10px] leading-snug text-zinc-400">
            {MCP_TOOLS.find((t) => t.name === toolName)?.description}
          </p>
        </div>
      </div>

      {interpreted && (
        <div className="rounded-lg border border-frost-800/60 bg-frost-950/30 p-2.5" aria-label="Interpreted action">
          <p className="font-mono text-[9px] uppercase tracking-wider text-frost-400">Interpreted action · {interpreted.target}</p>
          <p className="mt-1 text-[11px] leading-snug text-zinc-200">{interpreted.plain}</p>
        </div>
      )}
      {clarify && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-2.5" aria-label="Clarify command">
          <p className="text-[11px] leading-snug text-amber-200">{clarify.plain}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {clarify.options.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => {
                  setToolName(opt.tool)
                  setArgsText(JSON.stringify(opt.args, null, 2))
                  const tool = MCP_TOOLS.find((x) => x.name === opt.tool)
                  const st = useEditor.getState()
                  const clip = st.project.clips.find((c) => c.id === st.activeClipId) ?? st.project.clips[0]
                  setInterpreted({
                    plain: 'Will: run ' + (opt.args as { steps?: unknown[] }).steps?.length + ' add_frame steps as ONE undoable operation on clip "' + (clip?.name ?? 'idle') + '" — nothing runs until you press Run.',
                    target: opt.tool,
                  })
                  setClarify(null)
                  setShowManual(true)
                  toast({ title: 'Ready: ' + (tool?.name ?? opt.tool), description: 'Review the interpreted action, then press Run.' })
                }}
                className="rounded border border-amber-700/60 bg-amber-950/40 px-2 py-1 font-mono text-[10px] text-amber-200 hover:border-amber-500"
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-zinc-500">Nothing runs until you pick one (or correct the command).</p>
        </div>
      )}
      <div>
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-400" htmlFor="mcp-args">
          Arguments (JSON)
        </label>
        <Textarea
          id="mcp-args"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              void run()
            }
          }}
          className={`pixelforge-scroll min-h-[120px] resize-y border bg-zinc-900 font-mono text-[11px] ${
            argsValid ? 'border-zinc-800' : 'border-red-500/60 focus-visible:border-red-500'
          }`}
          spellCheck={false}
          aria-invalid={!argsValid}
        />
        {!argsValid && (
          <p className="mt-1 font-mono text-[10px] text-red-400">
            Invalid JSON — fix before running.
          </p>
        )}
      </div>

      <Button
        onClick={run}
        disabled={running || !toolName || !argsValid}
        className="h-8 bg-frost-600 font-mono text-xs text-white hover:bg-frost-500"
      >
        {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
        Run tool
      </Button>

      {result && (
        <div>
          <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-zinc-400">
            Result
            <button
              type="button"
              onClick={() => {
                void copyText(result).then(
                  () => toast({ title: 'Result copied' }),
                  () => toast({ title: 'Copy failed', variant: 'destructive' })
                )
              }}
              className="flex items-center gap-1 normal-case text-zinc-400 hover:text-zinc-200"
              aria-label="Copy result JSON"
            >
              <Copy className="h-3 w-3" /> copy
            </button>
          </div>
          <pre
            className={`pixelforge-scroll max-h-44 overflow-auto rounded-md border p-2 font-mono text-[10px] leading-relaxed ${
              resultOk ? 'border-zinc-800 bg-zinc-950 text-emerald-300/90' : 'border-red-900/60 bg-zinc-950 text-red-300/90'
            }`}
          >
            {result}
          </pre>
        </div>
      )}
        </div>
      )}
      </div>

      {/* ---------------------------- Review Result ---------------------------- */}
      {review && (
        <div ref={reviewOpenRef} className="rounded-lg border border-teal-800/50 bg-teal-950/10 p-2.5" aria-label="Review Result">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-teal-300">Review Result</span>
            <span className="font-mono text-[9px] text-zinc-500">
              {review.tool} · {review.clipName} · frame {review.frameNumber}
              {review.layerName ? ` · layer "${review.layerName}"` : ' · whole canvas'}
            </span>
          </div>
          <p className="mb-2 font-mono text-[9px] text-zinc-500">
            performed by:{' '}
            {review.clientName ? (
              <span className="text-frost-300">connected agent ({review.clientName} via MCP)</span>
            ) : (
              <span className="text-zinc-300">this Agent panel (local runner)</span>
            )}{' '}
            · undo via <button type="button" className="inline-flex items-center gap-0.5 rounded border border-zinc-700 px-1 text-[9px] text-zinc-300 hover:text-zinc-100" onClick={async () => { const r = await executeMcpTool('undo', {}, { clientId: 'agent-console', clientName: 'agent-console', tier: 'L1' }); toast({ title: r.ok ? 'Undone' : 'Undo failed', description: r.summary ?? r.error?.message }); }}><Undo2 className="inline h-2.5 w-2.5" /> undo</button>
          </p>
          <div className="mb-2.5 flex flex-wrap items-start gap-3 rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2.5">
            {([['before', review.before], ['after', review.after]] as const).map(([label, frame]) => (
              <figure key={label} className="shrink-0 text-center">
                <div className="flex items-end gap-1.5">
                  {([1, 3] as const).map((zoom) => (
                    <canvas
                      key={zoom}
                      className="rounded border border-zinc-800"
                      style={{ imageRendering: 'pixelated', width: frame.width * zoom, height: frame.height * zoom }}
                      aria-label={`${label} at ${zoom === 1 ? 'actual size' : 'zoom'}`}
                      ref={(canvas) => drawSpritePreview(canvas, frame.buffer, frame.width, frame.height)}
                    />
                  ))}
                </div>
                <figcaption className="mt-0.5 text-[10px] text-zinc-500">{label} · 1× · 3×</figcaption>
              </figure>
            ))}
          </div>
          <ul className="space-y-1" aria-label="Review technical checks">
            {review.checks.map((c) => (
              <li
                key={c.id}
                className={`flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug ${
                  c.status === 'pass'
                    ? 'bg-emerald-500/10 text-emerald-300'
                    : c.status === 'warning'
                      ? 'bg-amber-500/10 text-amber-300'
                      : 'bg-zinc-800/60 text-zinc-400'
                }`}
              >
                <span>
                  <span className="font-medium">{c.label}</span>
                  <span className="block text-[10px] opacity-80">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-center text-[10px] text-zinc-500">
            Technical checks only — style approval is yours. Latest edit is highlighted in the session log below.
          </p>
        </div>
      )}



      <div className="border-t border-zinc-800 pt-2">
        <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
          <History className="h-3 w-3" /> Session log
          <span className="ml-auto normal-case text-zinc-400">server-wide log: Settings → MCP</span>
        </div>
        {ops.length === 0 && remoteEdits.length === 0 ? (
          <p className="font-mono text-[10px] text-zinc-400">No tool runs this session.</p>
        ) : (
          <ul className="pixelforge-scroll max-h-48 space-y-1 overflow-y-auto pr-1">
            {ops.map((op) => (
              <li
                key={'local-' + op.id}
                className={`rounded border px-2 py-1 ${
                  review && op === ops[0]
                    ? 'border-teal-600/70 bg-teal-950/30 ring-1 ring-teal-600/50'
                    : 'border-zinc-800/70 bg-zinc-900/40'
                }`}
                aria-label={review && op === ops[0] ? 'Latest edit' : undefined}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-mono text-[10px] ${op.ok ? 'text-frost-300' : 'text-red-300'}`}>
                    {op.ok ? '✓' : '✗'} {op.tool}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setToolName(op.tool)
                        setArgsText(op.args)
                        setResult(null)
                        setShowManual(true)
                      }}
                      className="rounded px-1 font-mono text-[9px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                      aria-label={`Load ${op.tool} args again`}
                      title="Load args again"
                    >
                      ↻ rerun
                    </button>
                    <span className="font-mono text-[9px] text-zinc-400">{op.at}</span>
                  </span>
                </div>
                <p className="truncate font-mono text-[10px] text-zinc-400" title={op.summary}>
                  <span className="mr-1 rounded border border-zinc-700 px-1 text-[9px] text-zinc-500">local runner</span>
                  {op.summary}
                </p>
              </li>
            ))}
            {remoteEdits.map((r, i) => (
              <li key={'remote-' + i} className="rounded border border-frost-900/60 bg-frost-950/20 px-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-mono text-[10px] ${r.ok ? 'text-frost-300' : 'text-red-300'}`}>
                    {r.ok ? '✓' : '✗'} {r.tool}
                  </span>
                  <span className="font-mono text-[9px] text-zinc-400">{r.at}</span>
                </div>
                <p className="truncate font-mono text-[10px] text-zinc-400">
                  <span className="mr-1 rounded border border-frost-800/60 px-1 text-[9px] text-frost-400">
                    {r.clientName || 'IDE Agent'} (MCP)
                  </span>
                  live MCP edit
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
