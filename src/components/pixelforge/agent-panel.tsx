// PixelForge AI — Agent Console (Task 8 edition).
//
// Runs the SAME tool catalog as the real MCP server, but locally: every call
// executes in-process through ./mcp-tools on the shared CommandBus, so edits
// are immediately visible on the canvas, fully undoable (Ctrl+Z), and never
// touch the legacy REST runner (retired in Task 8 — a separate editor state).
// External assistants reach the same tools through the MCP server instead.

'use client'

import { useEffect, useRef, useState } from 'react'
import { computeStateHash, executeMcpTool, type ToolExecResult } from '@/lib/pixelforge/mcp-tools'
import { MCP_TOOLS } from '@/lib/pixelforge/mcp-tool-catalog'
import { useEditor } from '@/lib/pixelforge/store'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { resolveBrainProvider } from '@/lib/pixelforge/brain-core'
import { copyText } from '@/lib/pixelforge/desktop-bridge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { friendlyError } from '@/lib/utils'
import { AGENT_FETCH_HEADERS } from '@/lib/pixelforge/agent-headers'
import { describeApiErrorInline } from '@/lib/pixelforge/api-error'
import {
  buildAgentInstructions,
  type AgentMsg,
  type AgentProviderConfig,
  type AgentToolCall,
} from '@/lib/pixelforge/ai/agent-chat'
import { Bot, Copy, History, Loader2, Play, Square, ChevronDown } from 'lucide-react'

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
  'beautify_layer',
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
  // AI agent approval gate: resolves the pending Promise from the UI buttons
  const pendingResolveRef = useRef<((v: 'run' | 'skip') => void) | null>(null)
  const [mcpStatus, setMcpStatus] = useState<{ reachable: boolean; authRequired: boolean; serverName?: string } | null>(null)

  /** Rule-based natural-language → tool mapping. Fills the form for review;
   *  nothing runs until the user presses Run. */
  const parseCommand = (text: string): { tool: string; args: Record<string, unknown> } | null => {
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
    if (/\badd\b.*\bframe\b/.test(t)) return { tool: 'add_frame', args: num ? { copyContent: true } : {} }
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
      toast({
        title: 'No matching command',
        description: 'Try: flip h · flip v · rotate ccw · shift left · add frame · add layer · merge · opacity 50 · undo · redo',
        variant: 'destructive',
      })
      return
    }
    const tool = MCP_TOOLS.find((x) => x.name === mapped.tool)
    if (!tool) return
    setToolName(tool.name)
    const merged = { ...structuredClone(tool.example), ...mapped.args }
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === 'string' && /^<.*>$/.test(v.trim())) delete merged[k]
    }
    setArgsText(JSON.stringify(merged, null, 2))
    setResult(null)
    setShowManual(true)
    toast({ title: `Ready: ${tool.name}`, description: 'Review the args, then press Run.' })
  }

  const pickTool = (name: string) => {
    const t = MCP_TOOLS.find((x) => x.name === name)
    setToolName(name)
    if (t) setArgsText(JSON.stringify(t.example, null, 2))
    setResult(null)
  }

  // --- AI Agent mode ---------------------------------------------------------
  const settings = useAppSettings()
  const [agentGoal, setAgentGoal] = useState('')
  const [agentBusy, setAgentBusy] = useState(false)
  const agentChat = useEditor((s) => s.agentChat)
  const setAgentChat = useEditor((s) => s.setAgentChat)
  const agentRunRequest = useEditor((s) => s.agentRunRequest)
  const clearAgentRunRequest = useEditor((s) => s.clearAgentRunRequest)
  const [pending, setPending] = useState<PendingChange | null>(null)
  const stoppedRef = useRef(false)
  // Stop must reach the in-flight provider fetch and a parked approval gate —
  // flipping only the flag left both unresponsive until they timed out
  const agentAbortRef = useRef<AbortController | null>(null)

  type AgentProvider = AgentProviderConfig & { id: string; label: string }
  const agentProvider: AgentProvider | null = (() => {
    const p = settings.aiProviders.find((x) => x.id === settings.activeProviderId)
    if (!p || !p.enabled) return null
    const hasVaultKey = Boolean(settings.secureMode && settings.keyStatus[p.id]?.hasKey)
    // unlike /api/ai/sprite (built-in engine fallback), the agent route calls
    // the provider API directly — a key is required for every kind, zai included
    if (!p.apiKey.trim() && !hasVaultKey) return null
    return { id: p.id, kind: p.kind, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, label: p.label }
  })()

  // Brain plans are reasoned with the configured Brain provider (default
  // Groq), so they can run in-app even when the currently selected image
  // provider is Gemini.  The desktop main process injects the vault key using
  // this provider id; browser mode uses its saved key as normal. Key presence
  // comes from the shared Brain Core facade.
  const { provider: brainProfile, hasKey: brainHasKey } = resolveBrainProvider(
    settings.aiProviders,
    settings.secureMode,
    settings.keyStatus,
    settings.brainProviderId,
  )
  const brainAgentProvider: AgentProvider | null =
    brainProfile && brainProfile.enabled && brainHasKey
      ? {
          id: brainProfile.id,
          kind: brainProfile.kind,
          baseUrl: brainProfile.baseUrl,
          apiKey: brainProfile.apiKey,
          model: brainProfile.model,
          label: brainProfile.label,
        }
      : null

  // append one message to the persistent conversation
  const pushMsg = (m: AgentMsg) => setAgentChat([...useEditor.getState().agentChat, m])

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

  const prepareChange = async (call: AgentToolCall): Promise<PendingChange> => {
    const state = useEditor.getState()
    const project = state.project
    const clip = project.clips.find((item) => item.id === state.activeClipId) ?? project.clips[0]
    if (!clip) throw new Error('The project has no active clip.')
    const frameIndex = Math.min(Math.max(0, state.activeFrameIndex), clip.frames.length - 1)
    const frame = clip.frames[frameIndex]
    const layer = clip.layers.find((item) => item.id === state.activeLayerId) ?? clip.layers[clip.layers.length - 1]
    if (!frame || !layer) throw new Error('The active clip needs a frame and layer before the agent can edit.')

    const supplied = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {}
    const args: Record<string, unknown> = { ...supplied, expectedStateHash: await computeStateHash() }
    // Pixel-changing commands are forcibly bound to what the artist has open.
    // Model-provided ids cannot redirect these writes to a hidden frame/layer.
    if (PIXEL_MUTATION_TOOLS.has(call.name)) {
      Object.assign(args, { clipId: clip.id, frameId: frame.id, layerId: layer.id })
    }

    return {
      call,
      args,
      scope: {
        projectName: project.name,
        canvas: `${project.width}×${project.height}`,
        clipName: clip.name,
        frameNumber: frameIndex + 1,
        layerName: layer.name,
        region: describeRegion(args, state.selection),
        stateHash: String(args.expectedStateHash).slice(0, 12),
      },
    }
  }

  const executeCall = async (call: AgentToolCall): Promise<AgentMsg['toolResults']> => {
    const tool = MCP_TOOLS.find((item) => item.name === call.name)
    if (!tool) {
      return [{ id: call.id, name: call.name, ok: false, content: 'This tool is not available in PixelForge.' }]
    }
    let args: Record<string, unknown> = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {}
    if (isDocumentMutation(call.name)) {
      const change = await prepareChange(call)
      args = change.args
      setPending(change)
      const verdict = await new Promise<'run' | 'skip'>((resolve) => {
        pendingResolveRef.current = resolve
      })
      setPending(null)
      if (verdict === 'skip') {
        return [{ id: call.id, name: call.name, ok: false, content: 'Artist declined this change plan; artwork was not modified.' }]
      }
    }
    try {
      const res: ToolExecResult = await executeMcpTool(call.name, args, {
        clientId: 'agent-console',
        clientName: 'agent-console',
        tier: tool.tier,
      })
      logOp(call.name, args, res.ok, res.summary ?? res.error?.message ?? '')
      return [
        {
          id: call.id,
          name: call.name,
          ok: res.ok,
          content: res.ok ? (res.summary ?? 'ok') : `error: ${res.error?.message ?? 'failed'}`,
        },
      ]
    } catch (err) {
      const msg = friendlyError(err)
      return [{ id: call.id, name: call.name, ok: false, content: `error: ${msg}` }]
    }
  }

  const runAgent = async (goal = agentGoal, provider: AgentProvider | null = agentProvider) => {
    if (agentBusy || !provider) return
    const trimmedGoal = goal.trim()
    if (!trimmedGoal) return
    stoppedRef.current = false
    setAgentBusy(true)
    const project = useEditor.getState().project
    const clip = useEditor.getState().activeClipId
      ? project.clips.find((c) => c.id === useEditor.getState().activeClipId)
      : project.clips[0]
    const system = [
      'You are the in-app agent of PixelForge AI, a pixel-art sprite editor.',
      'You manage the OPEN document by calling tools. One tool batch per turn; wait for results before deciding the next step.',
      'Always inspect with L0 tools before proposing a mutation. Every document or paid action is shown to the artist as a scoped change plan and must be accepted; never claim a change happened until its tool result confirms it.',
      'For pixel changes, work only on the active frame and active layer. Keep changes minimal, use a rect when the request is regional, and preserve the current canvas size and palette unless the artist explicitly asks otherwise.',
      `Current project: "${project.name}" ${project.width}×${project.height}, ${project.clips.length} clip(s)` +
        (clip ? `; active clip "${clip.name}" fps ${clip.fps}, ${clip.frames.length} frame(s), layers: ${clip.layers.map((l) => l.name).join(', ')}.` : '.'),
      'When the goal is complete, reply with a short summary and NO tool calls.',
    ].join(' ')
    // conversation memory: seed from the stored history so follow-ups work
    const messages: AgentMsg[] = [...useEditor.getState().agentChat, { role: 'user', text: trimmedGoal }]
    setAgentChat(messages)
    const MAX_STEPS = 8
    const commit = (m: AgentMsg[]) => {
      messages.length = 0
      messages.push(...m)
      setAgentChat(m)
    }
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (stoppedRef.current) {
          commit([...messages, { role: 'assistant', text: '⚠ Stopped by user.' }])
          break
        }
        let json: { text?: string; toolCalls?: AgentToolCall[]; error?: unknown }
        const reqPayload = { cfg: provider, system, messages: messages.slice(-30) }
        const abort = new AbortController()
        agentAbortRef.current = abort
        try {
          if (typeof window !== 'undefined' && window.pixelforge?.ai?.agent) {
            json = (await window.pixelforge.ai.agent(reqPayload)) as typeof json
          } else {
            const res = await fetch('/api/ai/agent', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...AGENT_FETCH_HEADERS },
              body: JSON.stringify(reqPayload),
              signal: abort.signal,
            })
            json = (await res.json()) as typeof json
          }
        } catch (err) {
          if (stoppedRef.current && err instanceof Error && err.name === 'AbortError') {
            agentAbortRef.current = null
            break
          }
          throw err
        }
        agentAbortRef.current = null
        if (json.error) {
          // guard denials return a structured { code, message, hint } object —
          // describeApiErrorInline renders it instead of "[object Object]"
          const errText = typeof json.error === 'string'
            ? json.error
            : describeApiErrorInline(json.error, 'Agent request failed')
          commit([...messages, { role: 'assistant', text: `⚠ ${errText}` }])
          break
        }
        const calls = json.toolCalls ?? []
        commit([...messages, { role: 'assistant', text: json.text ?? '' }])
        if (calls.length === 0) break
        const results: NonNullable<AgentMsg['toolResults']> = []
        for (const call of calls) {
          if (stoppedRef.current) break
          const r = (await executeCall(call)) ?? []
          results.push(...r)
          // live progress: grow the trailing results message in place
          commit([...messages, { role: 'user', toolResults: [...results] }])
        }
        if (stoppedRef.current) {
          commit([...messages, { role: 'assistant', text: '⚠ Stopped by user.' }])
          break
        }
      }
    } catch (err) {
      commit([...messages, { role: 'assistant', text: `⚠ ${friendlyError(err)}` }])
    } finally {
      setAgentBusy(false)
      setPending(null)
    }
  }

  // Consume a queued Brain plan only after this panel has mounted.  Clearing
  // the request before the async call prevents a re-render from starting it
  // twice.  Mutating tool calls still stop at the existing approval gate.
  useEffect(() => {
    if (!agentRunRequest || agentBusy) return
    clearAgentRunRequest(agentRunRequest.id)
    setAgentGoal(agentRunRequest.goal)
    if (!agentApiEnabled) {
      toast({
        title: 'Agent API is disabled',
        description: 'Enable Settings → MCP → Agent API, then run the plan again.',
        variant: 'destructive',
      })
      return
    }
    const provider = agentRunRequest.source === 'brain' ? brainAgentProvider : agentProvider
    if (!provider) {
      toast({
        title: 'Groq is needed for this Brain plan',
        description: 'Add and enable your Groq API key in Settings → AI & MCP, then run the plan again.',
        variant: 'destructive',
      })
      return
    }
    void runAgent(agentRunRequest.goal, provider)
  }, [agentRunRequest, agentApiEnabled, agentBusy, agentProvider, brainAgentProvider, clearAgentRunRequest, toast])

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
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 shrink-0 text-frost-400" aria-hidden />
        <span className="shrink-0 font-mono text-[11px] font-semibold text-zinc-200">Agent</span>
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
              ? mcpStatus.authRequired
                ? 'MCP live · pairing only'
                : `MCP live${mcpStatus.serverName ? ` · ${mcpStatus.serverName}` : ''}`
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
              .then(() => toast({ title: 'Agent instructions copied', description: 'Paste into Claude Desktop, Cline, ChatGPT…' }))
              .catch(() => toast({ title: 'MCP is not ready', description: 'Keep the desktop app open, then try again.', variant: 'destructive' }))
          }}
          aria-label="Copy agent instructions for external AI assistants"
          title="Tools run locally on the shared CommandBus — edits are instant and undoable (Ctrl+Z). External assistants connect via the MCP server."
        >
          <Copy className="mr-0.5 inline h-3 w-3" /> brief
        </button>
      </div>

      {/* ---------------------------- Quick actions (no AI needed) ---------------------------- */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
        <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Quick actions</div>
        <div className="flex flex-wrap gap-1">
          {([
            ['Outline + shade', 'beautify_layer', {}],
            ['Idle 4-frame clip', 'add_clip', { name: 'idle-2', fps: 8, frameCount: 4 }],
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
        </div>
      </div>

      {/* ---------------------------- AI Agent mode ---------------------------- */}
      <div className="rounded-lg border border-frost-900/60 bg-frost-950/20 p-2.5">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-frost-300">AI Agent</span>
          <span className="rounded border border-emerald-500/30 bg-emerald-950/30 px-1.5 py-px font-mono text-[8px] uppercase tracking-wider text-emerald-300">
            review before change
          </span>
        </div>
        <p className="mb-2 font-mono text-[9px] leading-relaxed text-zinc-500">
          Read-only checks run immediately. Every document or paid action is pinned to the current artwork, then requires your approval.
        </p>
        {!agentProvider && (
          <p className="mb-1.5 font-mono text-[10px] text-amber-300">
            No AI provider — add an API key in Settings → AI &amp; MCP (Claude included).
          </p>
        )}
        <div className="flex items-center gap-1.5">
          <input
            value={agentGoal}
            onChange={(e) => setAgentGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !agentBusy) void runAgent()
            }}
            placeholder='e.g. "add a layer named shading and set opacity 40"'
            aria-label="Agent goal"
            className="h-8 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus-visible:border-frost-500/60"
          />
          {agentBusy ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 border-zinc-800 font-mono text-[11px] text-zinc-300"
              onClick={() => {
                stoppedRef.current = true
                agentAbortRef.current?.abort()
                // a parked approval gate counts as declined so the loop unwinds
                pendingResolveRef.current?.('skip')
                pendingResolveRef.current = null
              }}
            >
              <Square className="mr-1 h-3 w-3" /> Stop
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-8 shrink-0 bg-frost-600 font-mono text-[11px] text-white hover:bg-frost-500"
              onClick={() => void runAgent()}
              disabled={!agentGoal.trim() || !agentProvider}
            >
              <Play className="mr-1 h-3 w-3" /> Run
            </Button>
          )}
        </div>
        {agentChat.length > 0 && (
          <div className="mt-2 flex items-center justify-between">
            <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">
              conversation · {agentChat.length} msg
            </span>
            <button
              type="button"
              onClick={() => setAgentChat([])}
              className="rounded px-1 font-mono text-[9px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              aria-label="Clear agent conversation"
            >
              clear
            </button>
          </div>
        )}
        {agentChat.length > 0 && (
          <ul className="pixelforge-scroll mt-1 max-h-56 space-y-1 overflow-y-auto pr-1" aria-label="Agent transcript">
            {agentChat.map((m, i) => {
              const rows: Array<{ cls: string; text: string }> = []
              if (m.role === 'user') {
                if (m.text) rows.push({ cls: 'bg-frost-900/30 text-frost-200', text: `› ${m.text}` })
                for (const r of m.toolResults ?? []) {
                  rows.push({ cls: r.ok ? 'bg-zinc-800/60 text-zinc-300' : 'bg-amber-500/10 text-amber-300', text: `${r.ok ? '⚙' : '✗'} ${r.name} — ${r.content}` })
                }
              } else if (m.text) {
                rows.push({ cls: 'bg-frost-900/30 text-frost-100', text: `AI: ${m.text}` })
              }
              return rows.map((row, j) => (
                <li key={`${i}-${j}`} className={`rounded px-2 py-1 font-mono text-[10px] leading-snug ${row.cls}`}>
                  {row.text}
                </li>
              ))
            })}
          </ul>
        )}
        {pending && (
          <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2" role="alert">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-mono text-[10px] font-semibold text-amber-100">
                  Change plan: <strong>{pending.call.name}</strong>
                </p>
                <p className="mt-0.5 font-mono text-[9px] leading-relaxed text-amber-200/80">
                  Nothing has changed yet. Approval applies only to the scope below.
                </p>
              </div>
              <span className="shrink-0 rounded border border-amber-400/30 px-1 py-px font-mono text-[8px] text-amber-200">pending</span>
            </div>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 rounded bg-zinc-950/40 p-1.5 font-mono text-[9px] leading-relaxed text-zinc-300">
              <dt className="text-zinc-500">project</dt><dd className="truncate">{pending.scope.projectName} · {pending.scope.canvas}</dd>
              <dt className="text-zinc-500">target</dt><dd className="truncate">{pending.scope.clipName} · frame {pending.scope.frameNumber} · {pending.scope.layerName}</dd>
              <dt className="text-zinc-500">region</dt><dd className="truncate">{pending.scope.region}</dd>
              <dt className="text-zinc-500">state</dt><dd title={pending.scope.stateHash}>#{pending.scope.stateHash}</dd>
            </dl>
            <pre className="pixelforge-scroll mt-1 max-h-24 overflow-auto rounded bg-zinc-950/60 p-1.5 font-mono text-[9px] text-zinc-300">
              {JSON.stringify(pending.args, null, 2)}
            </pre>
            <div className="mt-1.5 flex gap-1.5">
              <Button
                size="sm"
                className="h-6 bg-teal-600 px-2 font-mono text-[10px] text-white hover:bg-teal-500"
                onClick={() => pendingResolveRef.current?.('run')}
              >
                Accept change
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 font-mono text-[10px] text-zinc-400"
                onClick={() => pendingResolveRef.current?.('skip')}
              >
                Reject
              </Button>
            </div>
          </div>
        )}
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

      <div className="border-t border-zinc-800 pt-2">
        <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
          <History className="h-3 w-3" /> Session log
          <span className="ml-auto normal-case text-zinc-400">server-wide log: Settings → MCP</span>
        </div>
        {ops.length === 0 ? (
          <p className="font-mono text-[10px] text-zinc-400">No tool runs this session.</p>
        ) : (
          <ul className="pixelforge-scroll max-h-48 space-y-1 overflow-y-auto pr-1">
            {ops.map((op) => (
              <li key={op.id} className="rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1">
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
                  {op.summary}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
