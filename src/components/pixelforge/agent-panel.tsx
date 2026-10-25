// PixelForge AI — Agent Console (Task 8 edition).
//
// Runs the SAME tool catalog as the real MCP server, but locally: every call
// executes in-process through ./mcp-tools on the shared CommandBus, so edits
// are immediately visible on the canvas, fully undoable (Ctrl+Z), and never
// touch the legacy REST runner (retired in Task 8 — a separate editor state).
// External assistants reach the same tools through the MCP server instead.

'use client'

import { useState } from 'react'
import { executeMcpTool, type ToolExecResult } from '@/lib/pixelforge/mcp-tools'
import { MCP_TOOLS } from '@/lib/pixelforge/mcp-tool-catalog'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { Bot, History, Loader2, Play } from 'lucide-react'

interface SessionOp {
  id: number
  tool: string
  ok: boolean
  summary: string
  at: string
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
  const [opSeq, setOpSeq] = useState(0)

  const pickTool = (name: string) => {
    const t = MCP_TOOLS.find((x) => x.name === name)
    setToolName(name)
    if (t) setArgsText(JSON.stringify(t.example, null, 2))
    setResult(null)
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
    try {
      // strip example placeholders ("<projectId>") — the executor resolves
      // active clip/frame/layer automatically when refs are omitted
      const clean: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(parsedArgs)) {
        if (typeof v === 'string' && /^<.*>$/.test(v.trim())) continue
        clean[k] = v
      }

      const res: ToolExecResult = await executeMcpTool(toolName, clean, {
        clientId: 'agent-console',
        clientName: 'agent-console',
        tier: 'L1',
      })
      setResult(JSON.stringify(res, null, 2))
      setResultOk(res.ok)
      setOpSeq((n) => n + 1)
      setOps((prev) =>
        [
          {
            id: opSeq,
            tool: toolName,
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

  // Agent API disabled in Settings → MCP: show a notice instead of the console
  if (!agentApiEnabled) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Bot className="h-6 w-6 text-zinc-500" />
        <p className="max-w-[240px] font-mono text-[10px] leading-relaxed text-zinc-400">
          The Agent API (MCP) is currently disabled. Enable it in{' '}
          <span className="text-teal-300">Settings → MCP</span> to run editor tools here or
          from external AI assistants.
        </p>
      </div>
    )
  }

  return (
    <div className="pixelforge-scroll mx-auto flex h-full w-full max-w-[520px] flex-col gap-3 overflow-x-hidden overflow-y-auto p-3">
      <div className="flex items-start gap-2 rounded-lg border border-teal-900/60 bg-teal-950/20 p-2.5">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-teal-400" />
        <p className="font-mono text-[10px] leading-relaxed text-teal-200/70">
          Agent console — run the same validated tools the MCP server exposes, executed locally on the shared
          CommandBus. Edits appear instantly and stay undoable (Ctrl+Z) — no re-sync needed.
        </p>
      </div>

      <div>
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-400" htmlFor="mcp-tool">
          Tool
        </label>
        <select
          id="mcp-tool"
          value={toolName}
          onChange={(e) => pickTool(e.target.value)}
          className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 font-mono text-xs text-zinc-200"
        >
          {MCP_TOOLS.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <div className="mt-1 flex items-start gap-1.5">
          <span
            className={`shrink-0 rounded border px-1 py-px font-mono text-[9px] uppercase tracking-wider ${
              MCP_TOOLS.find((t) => t.name === toolName)?.tier === 'L1'
                ? 'border-teal-800/60 bg-teal-950/40 text-teal-300'
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
          className="pixelforge-scroll min-h-[120px] resize-y border-zinc-800 bg-zinc-900 font-mono text-[11px]"
          spellCheck={false}
        />
      </div>

      <Button
        onClick={run}
        disabled={running || !toolName}
        className="h-8 bg-teal-600 font-mono text-xs text-white hover:bg-teal-500"
      >
        {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
        Run tool
      </Button>

      {result && (
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400">Result</div>
          <pre
            className={`pixelforge-scroll max-h-44 overflow-auto rounded-md border p-2 font-mono text-[10px] leading-relaxed ${
              resultOk ? 'border-zinc-800 bg-zinc-950 text-emerald-300/90' : 'border-red-900/60 bg-zinc-950 text-red-300/90'
            }`}
          >
            {result}
          </pre>
        </div>
      )}

      <div className="border-t border-zinc-800 pt-2">
        <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
          <History className="h-3 w-3" /> Session log
          <span className="ml-auto normal-case text-zinc-500">server-wide log: Settings → MCP</span>
        </div>
        {ops.length === 0 ? (
          <p className="font-mono text-[10px] text-zinc-400">No tool runs this session.</p>
        ) : (
          <ul className="pixelforge-scroll max-h-48 space-y-1 overflow-y-auto pr-1">
            {ops.map((op) => (
              <li key={op.id} className="rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-mono text-[10px] ${op.ok ? 'text-teal-300' : 'text-red-300'}`}>
                    {op.ok ? '✓' : '✗'} {op.tool}
                  </span>
                  <span className="font-mono text-[9px] text-zinc-400">{op.at}</span>
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
