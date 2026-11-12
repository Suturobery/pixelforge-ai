// PixelForge AI — Dedicated "Second Brain · Groq" Panel.
//
// Functions as the central intelligent reasoning layer of PixelForge AI:
//   1. Intelligent Prompt Interpreter & Error Corrector — understands short,
//      incomplete, misspelled, or ambiguous prompts from artists & IDE agents,
//      infers missing details from the active project context, and enhances them.
//   2. Goal Orchestrator & MCP Task Board — turns high-level goals into
//      validated deterministic app steps (VFX, palette) + IDE agent tasks.
//   3. Project-Aware Advisory Q&A — pixel-art craft, animation, and workflow advice.
//   4. Continuous Learning Memory — learns from user feedback (prefer/avoid cues
//      and recent IDE agent context) locally without modifying model weights.

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Brain,
  Loader2,
  RotateCcw,
  Send,
  ListChecks,
  Play,
  WandSparkles,
  Check,
  Copy,
  ThumbsUp,
  ThumbsDown,
  Plus,
  X,
  ArrowRight,
  Sparkles,
  Activity,
  Bot,
  Eraser,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useEditor } from '@/lib/pixelforge/store'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { readBrainUsage, recordBrainCall, resetBrainUsage, type BrainUsage } from '@/lib/pixelforge/ai-usage'
import { describeApiErrorInline } from '@/lib/pixelforge/api-error'
import { mcpCtrl } from '@/lib/pixelforge/mcp-bridge'
import { copyText, desktopConfirm } from '@/lib/pixelforge/desktop-bridge'
import {
  addBrainPreference,
  buildBrainProjectContext,
  callBrain,
  checkPlanFreshness,
  clearBrainSessionContext,
  exportBrainMemory,
  interpretAndEnhancePrompt,
  readBrainMemory,
  recordAgentContextEvent,
  recordBrainFeedback,
  removeBrainPreference,
  resetBrainMemory,
  resolveBrainProvider,
  subscribeBrainMemory,
  writeBrainMemory,
  planStepToToolCall,
  type BrainCallPayload,
  type BrainProjectIdentity,
  type PlanStep,
  type PromptCorrection,
  type SecondBrainMemory,
} from '@/lib/pixelforge/brain-core'
import { computeStateHash, executeMcpTool, type ToolExecContext } from '@/lib/pixelforge/mcp-tools'
import { MCP_TOOLS } from '@/lib/pixelforge/mcp-tool-catalog'

/** Panel executions ride the shared dispatcher with an explicit identity so
 * the audit trail distinguishes the artist's own runs from agent work. */
const PANEL_EXEC_CTX: ToolExecContext = { clientId: 'second-brain-panel', clientName: 'second-brain', tier: 'L1' }

async function pushAgentTasks(steps: PlanStep[], planId: string | null, replacePending: boolean): Promise<boolean> {
  const res = await mcpCtrl<{ tasks: unknown[] }>({
    kind: 'brain-push',
    // idempotency keys make a re-queue of the same plan a no-op instead of a duplicate
    tasks: steps.map((s) => ({
      title: s.title,
      detail: s.detail ?? '',
      ...(planId ? { idempotencyKey: `${planId}:${s.title}` } : {}),
    })),
    ...(planId ? { planId } : {}),
    replacePending,
  })
  return Boolean(res.ok)
}

const QUICK_PROMPT_EXAMPLES = [
  'make knigth wlak no bg',
  'chibbi slime atack with fire',
  'add lightning effect to it',
]

/** Compact relative time for "last seen" rows ("just now", "4m", "2h"). */
function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

export function SecondBrain() {
  const project = useEditor((s) => s.project)
  const activeClipId = useEditor((s) => s.activeClipId)
  const activeLayerId = useEditor((s) => s.activeLayerId)
  const activeFrameIndex = useEditor((s) => s.activeFrameIndex)
  const setRightTab = useEditor((s) => s.setRightTab)
  const setRightOpen = useEditor((s) => s.setRightOpen)
  const requestAgentRun = useEditor((s) => s.requestAgentRun)

  const aiProviders = useAppSettings((s) => s.aiProviders)
  const secureMode = useAppSettings((s) => s.secureMode)
  const keyStatus = useAppSettings((s) => s.keyStatus)
  const brainProviderId = useAppSettings((s) => s.brainProviderId)
  const { provider: brainProfile, hasKey } = resolveBrainProvider(aiProviders, secureMode, keyStatus, brainProviderId)
  const brainLabel = brainProfile ? brainProfile.label.replace(/ \(second brain\)$/, '') : 'local'

  // Continuous learning memory state
  const [memory, setMemory] = useState<SecondBrainMemory>(() => readBrainMemory())
  useEffect(() => {
    setMemory(readBrainMemory())
    return subscribeBrainMemory(() => setMemory(readBrainMemory()))
  }, [])

  // Prompt Interpreter & Enhancer state
  const [rawPrompt, setRawPrompt] = useState('')
  const [deepInterpreting, setDeepInterpreting] = useState(false)
  const [deepResult, setDeepResult] = useState<{
    correctedPrompt: string
    enhancedPrompt: string
    reasoningSummary: string
    corrections: PromptCorrection[]
    pixelArtGuidance: string[]
  } | null>(null)
  const [copiedEnhanced, setCopiedEnhanced] = useState(false)
  const [memoryExported, setMemoryExported] = useState(false)
  const [feedbackNote, setFeedbackNote] = useState('')
  const [feedbackSaved, setFeedbackSaved] = useState<'up' | 'down' | null>(null)
  const [newPrefer, setNewPrefer] = useState('')
  const [newAvoid, setNewAvoid] = useState('')

  // Live deterministic + context-aware interpretation — recommendations are
  // filtered against the REAL editor tool catalog so they never invent tools
  const editorToolNames = useMemo(() => MCP_TOOLS.map((t) => t.name), [])
  const localInterpretation = useMemo(() => {
    if (!rawPrompt.trim()) return null
    return interpretAndEnhancePrompt(
      rawPrompt,
      project,
      {
        clipId: activeClipId,
        layerId: activeLayerId,
        frameIndex: activeFrameIndex,
      },
      memory,
      editorToolNames,
    )
  }, [rawPrompt, project, activeClipId, activeLayerId, activeFrameIndex, memory, editorToolNames])

  // Clear deep Groq override when the raw input changes
  useEffect(() => {
    setDeepResult(null)
    setFeedbackSaved(null)
  }, [rawPrompt])

  // Advisory state
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [usage, setUsage] = useState<BrainUsage>(() => readBrainUsage())
  useEffect(() => setUsage(readBrainUsage()), [])

  // Orchestrator state
  const [goal, setGoal] = useState('')
  const [plan, setPlan] = useState<PlanStep[] | null>(null)
  const [planRevision, setPlanRevision] = useState<string | null>(null)
  const [planning, setPlanning] = useState(false)
  const [running, setRunning] = useState(false)
  const [boardTasks, setBoardTasks] = useState<
    Array<{ id: string; title: string; status: string; claimedBy: string | null; result: string | null; progress: string | null; verified: boolean | null }>
  >([])
  // explicit replace-vs-append for queueing a plan (doc §9.2: never silently
  // destroy unrelated pending tasks — append is the default)
  const [replacePending, setReplacePending] = useState(false)

  // overview: MCP service, connected agents, pending approvals (doc §12)
  const [mcpStatus, setMcpStatus] = useState<{
    mcpEnabled: boolean
    editorConnected: boolean
    clientsPaired: number
    sessions: number
    lastProjectName: string | null
  } | null>(null)
  const [mcpClients, setMcpClients] = useState<
    Array<{ clientId: string; name: string; tier: string; lastSeen: string | null; revoked: boolean }>
  >([])
  const [pendingApprovals, setPendingApprovals] = useState<
    Array<{ id: string; tool: string; clientName: string; summary: string }>
  >([])

  // Poll the MCP agent task board + overview facts on one timer
  const pollBoard = useCallback(async () => {
    const res = await mcpCtrl<{
      tasks: Array<{ id: string; title: string; status: string; claimedBy: string | null; result: string | null; progress: string | null; verified: boolean | null }>
    }>({
      kind: 'brain-tasks',
    })
    if (res.ok && res.data?.tasks) setBoardTasks(res.data.tasks)
    const [statusRes, clientsRes, approvalsRes] = await Promise.all([
      mcpCtrl<{
        mcpEnabled: boolean
        editorConnected: boolean
        clientsPaired: number
        sessions: number
        lastProjectName: string | null
      }>({ kind: 'status' }),
      mcpCtrl<{ clients: Array<{ clientId: string; name: string; tier: string; lastSeen: string | null; revoked: boolean }> }>({
        kind: 'clients-list',
      }),
      mcpCtrl<{ approvals: { pending: Array<{ id: string; tool: string; clientName: string; summary: string }> } }>({
        kind: 'approvals-list',
      }),
    ])
    if (statusRes.ok && statusRes.data) setMcpStatus(statusRes.data)
    if (clientsRes.ok && clientsRes.data?.clients) setMcpClients(clientsRes.data.clients)
    if (approvalsRes.ok && approvalsRes.data?.approvals) setPendingApprovals(approvalsRes.data.approvals.pending)
  }, [])

  useEffect(() => {
    void pollBoard()
    const timer = setInterval(() => void pollBoard(), 8000)
    return () => clearInterval(timer)
  }, [pollBoard])

  const projectContextPayload = useCallback(
    (identity?: BrainProjectIdentity) => buildBrainProjectContext(project, memory, identity),
    [project, memory],
  )

  const deepInterpretWithGroq = useCallback(async () => {
    const p = rawPrompt.trim()
    if (!p || deepInterpreting || !hasKey) return
    setDeepInterpreting(true)
    setError(null)
    try {
      const payload: BrainCallPayload = {
        action: 'interpret',
        prompt: p,
        provider: { id: brainProfile?.id ?? brainProviderId, baseUrl: brainProfile?.baseUrl, apiKey: brainProfile?.apiKey, model: brainProfile?.model },
        project: projectContextPayload(),
      }
      const json = await callBrain<{
        ok: boolean
        correctedPrompt?: string
        enhancedPrompt?: string
        reasoningSummary?: string
        corrections?: PromptCorrection[]
        pixelArtGuidance?: string[]
        usage?: { tokensIn: number; tokensOut: number }
        error?: string
      }>(payload)
      if (!json.ok) throw new Error(describeApiErrorInline(json.error, 'Groq prompt analysis failed'))
      setDeepResult({
        correctedPrompt: json.correctedPrompt ?? localInterpretation?.correctedPrompt ?? p,
        enhancedPrompt: json.enhancedPrompt ?? localInterpretation?.enhancedPrompt ?? p,
        reasoningSummary: json.reasoningSummary ?? '',
        corrections:
          json.corrections && json.corrections.length > 0
            ? json.corrections
            : (localInterpretation?.corrections ?? []),
        pixelArtGuidance:
          json.pixelArtGuidance && json.pixelArtGuidance.length > 0
            ? json.pixelArtGuidance
            : (localInterpretation?.pixelArtGuidance ?? []),
      })
      recordAgentContextEvent('second-brain', 'interpret', `Analyzed: "${p.slice(0, 48)}"`)
      if (json.usage) setUsage(recordBrainCall(json.usage.tokensIn, json.usage.tokensOut))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setDeepInterpreting(false)
    }
  }, [rawPrompt, deepInterpreting, hasKey, brainProfile, projectContextPayload, localInterpretation])

  const ask = useCallback(async () => {
    const q = question.trim()
    if (!q || busy) return
    setBusy(true)
    setError(null)
    setAnswer(null)
    try {
      const interpreted = interpretAndEnhancePrompt(
        q,
        project,
        { clipId: activeClipId, layerId: activeLayerId, frameIndex: activeFrameIndex },
        memory,
      )
      const payload = {
        question: interpreted.correctedPrompt,
        provider: { id: brainProfile?.id ?? brainProviderId, baseUrl: brainProfile?.baseUrl, apiKey: brainProfile?.apiKey, model: brainProfile?.model },
        project: projectContextPayload(),
      }
      const json = await callBrain<{ ok: boolean; answer?: string; error?: string; usage?: { tokensIn: number; tokensOut: number } }>(payload)
      if (!json.ok) throw new Error(describeApiErrorInline(json.error, 'Second brain request failed'))
      setAnswer(json.answer ?? '')
      recordAgentContextEvent('second-brain', 'advisory', `Q: "${q.slice(0, 48)}"`)
      if (json.usage) setUsage(recordBrainCall(json.usage.tokensIn, json.usage.tokensOut))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }, [question, busy, brainProfile, project, activeClipId, activeLayerId, activeFrameIndex, memory, projectContextPayload])

  const planGoal = useCallback(
    async (overrideGoal?: string) => {
      const rawGoal = (overrideGoal ?? goal).trim()
      if (!rawGoal || planning || running) return
      setPlanning(true)
      setError(null)
      setPlan(null)
      setPlanRevision(null)
      try {
        // Automatically run the goal through Second Brain typo correction & context interpretation first
        const interpreted = interpretAndEnhancePrompt(
          rawGoal,
          project,
          { clipId: activeClipId, layerId: activeLayerId, frameIndex: activeFrameIndex },
          memory,
        )
        // record the document fingerprint the plan was made against so
        // execution can reject a stale plan instead of applying it silently
        const revision = await computeStateHash()
        const payload: BrainCallPayload = {
          action: 'plan',
          goal: interpreted.correctedPrompt,
          provider: { id: brainProfile?.id ?? brainProviderId, baseUrl: brainProfile?.baseUrl, apiKey: brainProfile?.apiKey, model: brainProfile?.model },
          project: projectContextPayload({ projectId: project.id, revision }),
        }
        const json = await callBrain<{ ok: boolean; steps?: PlanStep[]; error?: string }>(payload)
        if (!json.ok) throw new Error(describeApiErrorInline(json.error, 'Planning failed'))
        setPlan((json.steps ?? []).map((s) => ({ ...s, status: 'pending' as const })))
        setPlanRevision(revision)
        recordAgentContextEvent('second-brain', 'plan', `Planned "${interpreted.correctedPrompt.slice(0, 48)}" (${json.steps?.length ?? 0} steps)`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Planning failed')
      } finally {
        setPlanning(false)
      }
    },
    [goal, planning, running, brainProfile, project, activeClipId, activeLayerId, activeFrameIndex, memory, projectContextPayload],
  )

  const runPlan = useCallback(async () => {
    if (!plan || running) return
    // freshness gate: a plan made from an older document snapshot must be
    // re-planned, never applied silently
    const freshness = checkPlanFreshness(planRevision, await computeStateHash())
    if (freshness.stale) {
      setError(freshness.reason)
      return
    }
    setRunning(true)
    setError(null)
    const steps = plan.map((s) => ({ ...s }))
    for (const step of steps) {
      try {
        if (step.kind === 'agent') {
          step.status = 'queued'
          step.result = 'queued for IDE agents'
          setPlan([...steps])
          continue
        }
        // dispatch through the SHARED executor — same handler, validation,
        // state-hash stamping and audit trail as built-in Agent / MCP agents
        const call = planStepToToolCall(step)
        if (!call) {
          step.status = 'failed'
          step.result = 'unsupported step kind — rejected'
          setPlan([...steps])
          continue
        }
        step.status = 'pending'
        setPlan([...steps])
        const res = await executeMcpTool(call.tool, call.args, PANEL_EXEC_CTX)
        if (!res.ok) throw new Error(res.error?.message ?? 'step failed')
        step.status = 'done'
        if (call.tool === 'generate_vfx') {
          const d = res.data as { clipName?: string; frames?: number } | undefined
          step.result = d?.clipName ? `${d.clipName} · ${d.frames ?? '?'}f` : (res.summary ?? 'done')
        } else {
          step.result = res.summary ?? 'done'
        }
      } catch (err) {
        step.status = 'failed'
        step.result = err instanceof Error ? err.message : 'failed'
      }
      setPlan([...steps])
    }
    const agentSteps = steps.filter((s) => s.status === 'queued')
    if (agentSteps.length > 0) {
      const ok = await pushAgentTasks(agentSteps, planRevision, replacePending)
      if (!ok) setError('Could not queue agent steps — is the MCP server running?')
      else void pollBoard()
    }
    setRunning(false)
  }, [plan, running, planRevision, replacePending, pollBoard])

  /** Send the validated plan to PixelForge's built-in Agent instead of only
   * putting creative work on the external MCP task board.  The Agent still
   * performs L0 inspection first and shows an approval card for every edit or
   * image-generation request. */
  const runPlanInApp = useCallback(async () => {
    if (!plan || running) return
    // same freshness gate as the direct runner — the built-in Agent re-checks
    // per-call too, but a stale plan should never reach it silently
    const freshness = checkPlanFreshness(planRevision, await computeStateHash())
    if (freshness.stale) {
      setError(freshness.reason)
      return
    }
    const steps = plan.map((step, index) => {
      if (step.kind === 'app-vfx') {
        return `${index + 1}. Create the procedural VFX “${step.effect ?? step.title}”${step.seed !== undefined ? ` with seed ${step.seed}` : ''}${step.light !== undefined ? ` and light ${step.light}` : ''}. Name it “${step.title}”.`
      }
      if (step.kind === 'app-palette') {
        return `${index + 1}. Replace the project palette with these dark-to-bright colors: ${(step.colors ?? []).join(', ')}.`
      }
      return `${index + 1}. ${step.detail ?? step.title}`
    })
    const goalForAgent = [
      'Execute this validated Second Brain plan in the open PixelForge project, in order.',
      'Inspect the project first. Use the matching PixelForge tool for each step. Do not skip the normal approval flow: wait for the artist to approve every document-changing or image-generation action before continuing.',
      '',
      ...steps,
    ].join('\n')
    requestAgentRun(goalForAgent, 'brain')
    setRightTab('agent')
    setRightOpen(true)
  }, [plan, planRevision, requestAgentRun, running, setRightOpen, setRightTab])

  const resetUsage = () => setUsage(resetBrainUsage())

  const clearFinishedTasks = useCallback(async () => {
    const res = await mcpCtrl<{ tasks: typeof boardTasks }>({ kind: 'brain-clear' })
    if (res.ok && res.data?.tasks) setBoardTasks(res.data.tasks)
  }, [])

  const retryFailedTasks = useCallback(async (id?: string) => {
    const res = await mcpCtrl<{ tasks: typeof boardTasks }>({ kind: 'brain-retry', ...(id ? { id } : {}) })
    if (res.ok && res.data?.tasks) setBoardTasks(res.data.tasks)
  }, [])

  // editor-side cancel: the human may cancel ANY unfinished board task
  const cancelBoardTask = useCallback(async (id: string) => {
    const res = await mcpCtrl<{ task: unknown }>({ kind: 'brain-cancel', id })
    if (res.ok) void pollBoard()
  }, [pollBoard])

  // revoke a paired agent (Permissions & approvals control, doc §12)
  const revokeAgent = useCallback(
    async (clientId: string) => {
      // desktopConfirm: Electron has no window.confirm — it returns undefined
      // and every revoke click would be silently dropped
      if (!(await desktopConfirm('Revoke this agent? Its token stops working immediately.'))) return
      await mcpCtrl({ kind: 'client-revoke', clientId })
      void pollBoard()
    },
    [pollBoard],
  )

  const effectiveEnhanced = deepResult?.enhancedPrompt ?? localInterpretation?.enhancedPrompt ?? ''
  const effectiveCorrections = deepResult?.corrections ?? localInterpretation?.corrections ?? []
  const effectiveGuidance = deepResult?.pixelArtGuidance ?? localInterpretation?.pixelArtGuidance ?? []

  const handleCopyEnhanced = async () => {
    if (!effectiveEnhanced) return
    await copyText(effectiveEnhanced)
    setCopiedEnhanced(true)
    setTimeout(() => setCopiedEnhanced(false), 1500)
  }

  const handleFeedback = (rating: 'up' | 'down') => {
    if (!rawPrompt.trim() || !effectiveEnhanced) return
    recordBrainFeedback({
      prompt: rawPrompt,
      enhancedPrompt: effectiveEnhanced,
      rating,
      note: feedbackNote.trim() || undefined,
    })
    setFeedbackSaved(rating)
    setFeedbackNote('')
  }

  const hasFinishedBoardTasks = boardTasks.some((t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled')
  const hasFailedBoardTasks = boardTasks.some((t) => t.status === 'failed')

  return (
    <div
      className="pixelforge-scroll mx-auto flex h-full min-h-0 w-full max-w-[640px] flex-col gap-3 overflow-y-auto overflow-x-hidden p-3 sm:p-4"
      data-testid="second-brain"
    >
      {/* ------------------------------------------------ Header & Active Context */}
      <div className="rounded-lg border border-frost-900/50 bg-frost-950/15 p-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Brain className="h-4 w-4 shrink-0 text-frost-400" />
            <div className="min-w-0">
              <p className="font-mono text-xs font-semibold text-zinc-100">Second Brain · {brainLabel}</p>
              <p className="truncate font-mono text-[10px] text-zinc-400">
                Turn a rough idea into a usable pixel-art prompt.
              </p>
            </div>
          </div>
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
              hasKey
                ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300'
                : 'border-amber-700/60 bg-amber-950/40 text-amber-300'
            }`}
          >
            {hasKey ? `${brainLabel} Ready` : 'Local + Key Needed'}
          </span>
          {mcpStatus && (
            <span
              className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                mcpStatus.mcpEnabled && mcpStatus.editorConnected
                  ? 'border-sky-700/60 bg-sky-950/40 text-sky-300'
                  : 'border-zinc-700/60 bg-zinc-900/60 text-zinc-400'
              }`}
              title={`MCP server ${mcpStatus.mcpEnabled ? 'enabled' : 'disabled'} · editor ${mcpStatus.editorConnected ? 'connected' : 'offline'} · ${mcpStatus.clientsPaired} paired agent(s) · ${mcpStatus.sessions} session(s)`}
            >
              {mcpStatus.mcpEnabled
                ? mcpStatus.editorConnected
                  ? `MCP · ${mcpStatus.clientsPaired} agent${mcpStatus.clientsPaired === 1 ? '' : 's'}`
                  : 'MCP · no editor'
                : 'MCP off'}
            </span>
          )}
        </div>

        {/* Live Project Context Pills */}
        <div className="mt-2 flex flex-wrap items-center gap-1 font-mono text-[9px] text-zinc-300">
          <span className="rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5">
            {project.width}×{project.height}px
          </span>
          <span className="rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5">
            {project.palette.length} colors
          </span>
          <span className="rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5">
            {project.clips.length} clip{project.clips.length === 1 ? '' : 's'}
          </span>
          <span className="rounded border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5">
            Style Lock: {project.settings.styleProfile?.enabled ? 'ON' : 'off'}
          </span>
        </div>

        {/* Auto-Enhance Master Toggle */}
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-zinc-800/80 pt-2">
          <div className="min-w-0">
            <p className="font-mono text-[10px] text-zinc-200">Auto-enhance studio & IDE prompts</p>
            <p className="font-mono text-[9px] leading-tight text-zinc-500">
              Automatically fix typos, expand shorthand & apply learned preferences
            </p>
          </div>
          <Switch
            checked={memory.autoEnhancePrompts}
            onCheckedChange={(v) => writeBrainMemory({ autoEnhancePrompts: v })}
            aria-label="Auto-enhance studio and IDE prompts"
          />
        </div>

        {!hasKey && (
          <p className="mt-2 rounded border border-amber-800/50 bg-amber-950/25 px-2 py-1.5 font-mono text-[10px] leading-tight text-amber-200">
            Add your {brainLabel} API key in{' '}
            <button
              type="button"
              className="underline hover:text-white"
              onClick={() => document.querySelector<HTMLButtonElement>('[aria-label="Settings"]')?.click()}
            >
              Settings → AI
            </button>{' '}
            to unlock LLM deep reasoning, planning, and Q&A.
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="mt-2 rounded border border-red-800/60 bg-red-950/30 px-2 py-1.5 font-mono text-[10px] leading-tight text-red-200"
          >
            <span className="font-semibold">Brain request failed:</span> {error}
          </div>
        )}
      </div>

      {/* ------------------------------------------------ 1. Intelligent Prompt Interpreter & Enhancer */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-300">
            <WandSparkles className="h-3.5 w-3.5 text-teal-400" /> Prompt Interpreter & Enhancer
          </div>
          {localInterpretation && (
            <span className="rounded border border-teal-800/60 bg-teal-950/40 px-1.5 py-0.5 font-mono text-[9px] text-teal-300">
              {localInterpretation.detectedIntent}
            </span>
          )}
        </div>
        <p className="mb-2 font-mono text-[10px] leading-tight text-zinc-500">
          Start with the idea. Second Brain handles the cleanup and project context.
        </p>

        <div className="space-y-2">
          <Textarea
            value={rawPrompt}
            onChange={(e) => setRawPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && hasKey) {
                e.preventDefault()
                void deepInterpretWithGroq()
              }
            }}
            placeholder="Describe what you want to make. Typos and shorthand are okay."
            aria-label="Prompt to interpret and enhance"
            className="min-h-[112px] resize-none border-zinc-700 bg-zinc-950 px-3 py-2.5 font-mono text-sm leading-relaxed shadow-inner"
            spellCheck={false}
          />
          {hasKey && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-full border-zinc-700 font-mono text-[11px] text-frost-300 hover:bg-frost-950/30"
              onClick={() => void deepInterpretWithGroq()}
              disabled={deepInterpreting || !rawPrompt.trim()}
              title="Refine interpretation with Groq LLM"
            >
              {deepInterpreting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 h-3 w-3" />}
              Refine with Groq
            </Button>
          )}
        </div>

        {/* Quick example chips */}
        <div className="mt-1.5 flex flex-wrap gap-1">
          {QUICK_PROMPT_EXAMPLES.slice(0, 2).map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setRawPrompt(ex)}
              className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
            >
              {ex}
            </button>
          ))}
        </div>

        {localInterpretation && (
          <div className="mt-2 space-y-2 rounded border border-zinc-800/90 bg-zinc-950 p-2 font-mono text-[10px]">
            {/* Auto-corrections */}
            {effectiveCorrections.length > 0 && (
              <div>
                <p className="text-[9px] uppercase tracking-wider text-amber-400/90">
                  Auto-Corrected ({effectiveCorrections.length})
                </p>
                <ul className="mt-0.5 space-y-0.5 text-[9px] text-zinc-300">
                  {effectiveCorrections.map((c, idx) => (
                    <li key={idx} className="break-words">
                      <span className="line-through text-zinc-500">{c.from}</span> →{' '}
                      <span className="text-emerald-300">{c.to}</span>{' '}
                      <span className="text-zinc-500">({c.reason})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Enhanced prompt output */}
            <div>
              <div className="flex items-center justify-between">
                <p className="text-[9px] uppercase tracking-wider text-teal-400">Enhanced Prompt</p>
                {deepResult && <span className="text-[8px] uppercase text-frost-400">Groq Refined</span>}
              </div>
              <p className="mt-0.5 break-words rounded border border-zinc-800 bg-zinc-900/70 p-1.5 text-[10px] leading-relaxed text-zinc-100">
                {effectiveEnhanced}
              </p>
            </div>

            {deepResult?.reasoningSummary && (
              <p className="break-words text-[9px] leading-snug text-frost-300/90">
                Reason: {deepResult.reasoningSummary}
              </p>
            )}

            {/* Inferred context & recommended tools */}
            <div className="flex flex-wrap gap-1 text-[9px] text-zinc-400">
              {localInterpretation.inferredContext.targetClipName && (
                <span className="rounded bg-zinc-900 px-1.5 py-0.5">
                  clip: <strong className="text-zinc-200">{localInterpretation.inferredContext.targetClipName}</strong>
                </span>
              )}
              {localInterpretation.inferredContext.motionPreset && (
                <span className="rounded bg-zinc-900 px-1.5 py-0.5">
                  preset: <strong className="text-teal-300">{localInterpretation.inferredContext.motionPreset}</strong>
                </span>
              )}
              {localInterpretation.inferredContext.vfxEffect && (
                <span className="rounded bg-zinc-900 px-1.5 py-0.5">
                  vfx: <strong className="text-amber-300">{localInterpretation.inferredContext.vfxEffect}</strong>
                </span>
              )}
              <span className="rounded bg-zinc-900 px-1.5 py-0.5">
                tools: {localInterpretation.inferredContext.recommendedTools.join(' → ')}
              </span>
            </div>

            {/* Pixel Art & Animation Accuracy Tips */}
            {effectiveGuidance.length > 0 && (
              <div className="border-t border-zinc-800/80 pt-1.5">
                <p className="text-[9px] uppercase tracking-wider text-zinc-400">Pixel Art & Animation Accuracy</p>
                <ul className="mt-0.5 space-y-0.5 text-[9px] leading-snug text-zinc-400">
                  {effectiveGuidance.map((tip, i) => (
                    <li key={i}>• {tip}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Action buttons & Continuous Learning Feedback */}
            <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-zinc-800/80 pt-1.5">
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 font-mono text-[9px] text-zinc-300 hover:text-white"
                  onClick={() => void handleCopyEnhanced()}
                >
                  {copiedEnhanced ? <Check className="mr-1 h-3 w-3 text-emerald-400" /> : <Copy className="mr-1 h-3 w-3" />}
                  {copiedEnhanced ? 'Copied' : 'Copy'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 font-mono text-[9px] text-frost-300 hover:text-frost-200"
                  onClick={() => {
                    setGoal(effectiveEnhanced)
                    if (hasKey) void planGoal(effectiveEnhanced)
                  }}
                >
                  <ArrowRight className="mr-1 h-3 w-3" /> Send to Orchestrator
                </Button>
              </div>

              <div className="flex items-center gap-1">
                <input
                  value={feedbackNote}
                  onChange={(e) => setFeedbackNote(e.target.value)}
                  placeholder="Optional rule to learn…"
                  className="h-5 w-28 rounded border border-zinc-800 bg-zinc-900 px-1.5 font-mono text-[9px] text-zinc-200 placeholder:text-zinc-600"
                />
                <button
                  type="button"
                  onClick={() => handleFeedback('up')}
                  title="Good interpretation (saves optional note to Prefer)"
                  aria-label="Thumbs up interpretation"
                  className={`rounded border p-1 ${
                    feedbackSaved === 'up'
                      ? 'border-emerald-600 bg-emerald-950/50 text-emerald-300'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-emerald-300'
                  }`}
                >
                  <ThumbsUp className="h-2.5 w-2.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleFeedback('down')}
                  title="Needs improvement (saves optional note to Avoid)"
                  aria-label="Thumbs down interpretation"
                  className={`rounded border p-1 ${
                    feedbackSaved === 'down'
                      ? 'border-rose-600 bg-rose-950/50 text-rose-300'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-rose-300'
                  }`}
                >
                  <ThumbsDown className="h-2.5 w-2.5" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ------------------------------------------------ 2. Goal Orchestrator & Task Board */}
      <details className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-300 [&::-webkit-details-marker]:hidden">
          <ListChecks className="h-3.5 w-3.5 text-frost-400" /> Goal Orchestrator & IDE Task Board
          <span className="ml-auto normal-case tracking-normal text-zinc-500">Plan bigger work</span>
        </summary>
        <p className="mb-2 font-mono text-[9px] leading-tight text-zinc-500">
          Break a goal into deterministic app actions (VFX, palette) + structured tasks for connected MCP IDE agents.
        </p>

        <div className="flex items-center gap-1">
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void planGoal()
              }
            }}
            placeholder="Goal: make my mimic game-ready…"
            aria-label="Goal for the orchestrator"
            className="h-7 min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600"
            spellCheck={false}
          />
          <Button
            size="sm"
            className="h-7 shrink-0 px-2.5 font-mono text-[10px]"
            onClick={() => void planGoal()}
            disabled={!hasKey || planning || running || !goal.trim()}
          >
            {planning ? <Loader2 className="h-3 w-3 animate-spin" /> : <ListChecks className="mr-1 h-3 w-3" />}
            Plan
          </Button>
        </div>

        {plan && plan.length > 0 && (
          <div className="pixelforge-scroll mt-2 max-h-48 space-y-1 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-2">
            {plan.map((s, i) => (
              <div key={i} className="flex items-start gap-1.5 font-mono text-[10px] leading-tight">
                <span
                  className={
                    s.status === 'done'
                      ? 'text-emerald-400'
                      : s.status === 'failed'
                        ? 'text-red-400'
                        : s.status === 'queued'
                          ? 'text-sky-400'
                          : 'text-zinc-500'
                  }
                >
                  {s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'queued' ? '⏳' : '·'}
                </span>
                <span className="min-w-0 flex-1 break-words text-zinc-300">
                  <span className="text-zinc-500">{s.kind === 'agent' ? 'agent' : 'app'}:</span> {s.title}
                  {s.result ? <span className="text-zinc-500"> — {s.result}</span> : null}
                </span>
              </div>
            ))}
            <div className="mt-1.5 grid grid-cols-2 gap-1">
              <Button
                size="sm"
                className="h-7 font-mono text-[10px]"
                onClick={() => void runPlanInApp()}
                disabled={running}
                title="Run this plan with PixelForge's built-in Agent"
              >
                <Bot className="mr-1 h-3 w-3" /> Run in app
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-zinc-700 font-mono text-[10px]"
                onClick={() => void runPlan()}
                disabled={running}
                title="Run built-in steps and queue creative work for an external MCP/IDE agent"
              >
                {running ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
                {running ? 'Running…' : 'Queue external'}
              </Button>
            </div>
            <label className="mt-1 flex items-center gap-1.5 font-mono text-[9px] text-zinc-400">
              <input
                type="checkbox"
                checked={replacePending}
                onChange={(e) => setReplacePending(e.target.checked)}
                className="accent-teal-400"
                aria-label="Replace pending tasks on the board instead of appending"
              />
              Replace pending board tasks (default: append)
            </label>
          </div>
        )}

        {boardTasks.length > 0 && (
          <div className="pixelforge-scroll mt-2 max-h-40 space-y-1 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[9px] leading-tight">
            <div className="mb-1 flex items-center justify-between text-[8px] uppercase tracking-wider text-zinc-500">
              <span>Agent task board ({boardTasks.length})</span>
              <div className="flex items-center gap-1">
                {hasFailedBoardTasks && (
                  <button
                    type="button"
                    onClick={() => void retryFailedTasks()}
                    className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[8px] text-amber-300 hover:bg-amber-500/20"
                    title="Re-queue failed tasks so connected agents can claim them again"
                  >
                    Retry failed
                  </button>
                )}
                {hasFinishedBoardTasks && (
                  <button
                    type="button"
                    onClick={() => void clearFinishedTasks()}
                    className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[8px] text-zinc-400 hover:text-zinc-200"
                    title="Remove finished (done/failed) tasks from the board"
                  >
                    Clear done
                  </button>
                )}
              </div>
            </div>
            {boardTasks.map((t) => (
              <div key={t.id} className="flex items-start gap-1">
                <span
                  className={
                    t.status === 'done'
                      ? 'text-emerald-400'
                      : t.status === 'failed'
                        ? 'text-red-400'
                        : t.status === 'claimed' || t.status === 'running'
                          ? 'text-sky-400'
                          : t.status === 'cancelled'
                            ? 'text-zinc-600'
                            : 'text-zinc-500'
                  }
                >
                  {t.status === 'done'
                    ? '✓'
                    : t.status === 'failed'
                      ? '✗'
                      : t.status === 'running'
                        ? '▶'
                        : t.status === 'claimed'
                          ? '⚙'
                          : t.status === 'cancelled'
                            ? '⊘'
                            : '⏳'}
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-400" title={t.result ?? t.progress ?? t.title}>
                  {t.title}
                  {t.claimedBy ? <span className="text-zinc-600"> · {t.claimedBy}</span> : null}
                  {(t.result || t.progress) ? (
                    <span className="text-zinc-600"> · {t.status === 'running' && t.progress ? t.progress : (t.result ?? t.progress)}</span>
                  ) : null}
                  {t.status === 'done' && t.verified === true ? <span className="text-emerald-500/80"> · state ✓</span> : null}
                  {t.status === 'done' && t.verified === false ? <span className="text-amber-500/80"> · state unchanged</span> : null}
                </span>
                {(t.status === 'pending' || t.status === 'claimed' || t.status === 'running') && (
                  <button
                    type="button"
                    onClick={() => void cancelBoardTask(t.id)}
                    aria-label={`Cancel task: ${t.title}`}
                    title="Cancel this task (human override — agents can be revoked separately)"
                    className="shrink-0 rounded border border-zinc-800 bg-zinc-900 p-0.5 text-zinc-500 hover:border-rose-900/60 hover:text-rose-300"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </details>

      {/* ------------------------------------------------ 3. Connected Agents & Approvals */}
      <details className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <summary className="flex cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-300">
            <Bot className="h-3.5 w-3.5 text-sky-400" /> Connected Agents &amp; Approvals
          </span>
          <span className="font-mono text-[9px] text-zinc-500">
            {mcpClients.filter((c) => !c.revoked).length} paired
            {pendingApprovals.length > 0 ? ` · ${pendingApprovals.length} approval${pendingApprovals.length === 1 ? '' : 's'} pending` : ''}
          </span>
        </summary>

        {mcpStatus ? (
          <p className="font-mono text-[9px] leading-tight text-zinc-500">
            server {mcpStatus.mcpEnabled ? 'on' : 'off'} · editor {mcpStatus.editorConnected ? 'connected' : 'offline'} ·{' '}
            {mcpStatus.sessions} session{mcpStatus.sessions === 1 ? '' : 's'}
            {mcpStatus.lastProjectName ? ` · project "${mcpStatus.lastProjectName}"` : ''}
          </p>
        ) : (
          <p className="font-mono text-[9px] text-zinc-500">MCP bridge not connected — external agents are unavailable.</p>
        )}

        {mcpClients.length > 0 && (
          <div className="mt-1.5 space-y-0.5 font-mono text-[9px] leading-tight">
            {mcpClients.map((c) => (
              <div key={c.clientId} className="flex items-center gap-1.5">
                <span className={c.revoked ? 'text-zinc-600' : 'text-sky-300'}>{c.revoked ? '⊘' : '●'}</span>
                <span className={`min-w-0 flex-1 truncate ${c.revoked ? 'text-zinc-600 line-through' : 'text-zinc-300'}`}>
                  {c.name}
                  <span className="text-zinc-600"> · {c.tier} · last seen {relTime(c.lastSeen)}</span>
                </span>
                {c.revoked ? (
                  <span className="shrink-0 rounded border border-zinc-800 px-1 text-[8px] uppercase text-zinc-500">revoked</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void revokeAgent(c.clientId)}
                    aria-label={`Revoke agent ${c.name}`}
                    title="Revoke this agent's token immediately"
                    className="shrink-0 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[8px] text-zinc-500 hover:border-rose-900/60 hover:text-rose-300"
                  >
                    revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 border-t border-zinc-800/80 pt-1.5">
          <p className="font-mono text-[9px] uppercase tracking-wider text-amber-400/90">
            Pending paid-op approvals ({pendingApprovals.length})
          </p>
          {pendingApprovals.length > 0 ? (
            <ul className="mt-1 space-y-0.5 font-mono text-[9px] leading-tight text-zinc-400">
              {pendingApprovals.map((a) => (
                <li key={a.id} className="truncate" title={a.summary}>
                  <span className="text-amber-300">{a.tool}</span> · <span className="text-zinc-300">{a.clientName}</span>: {a.summary}
                </li>
              ))}
              <li className="text-zinc-500">Decide on the approval cards over the canvas — external agents can never approve their own spend.</li>
            </ul>
          ) : (
            <p className="mt-0.5 font-mono text-[9px] text-zinc-500">Nothing waiting — paid agent requests (e.g. generate_sprite) park here.</p>
          )}
        </div>
      </details>

      {/* ------------------------------------------------ 4. Project-Aware Advisory Q&A */}
      <details className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-300 [&::-webkit-details-marker]:hidden">
          <Brain className="h-3.5 w-3.5 text-emerald-400" /> Advisory Assistant (Q&A)
          <span className="ml-auto normal-case tracking-normal text-zinc-500">Ask a question</span>
        </summary>
        <div className="flex items-center gap-1">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void ask()
              }
            }}
            placeholder="Ask: what should I build next?"
            aria-label="Ask the second brain"
            className="h-7 min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600"
            spellCheck={false}
          />
          <Button
            size="sm"
            className="h-7 shrink-0 px-2.5 font-mono text-[10px]"
            onClick={() => void ask()}
            disabled={!hasKey || busy || !question.trim()}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          </Button>
        </div>
        {answer && (
          <p className="pixelforge-scroll mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-emerald-300/90">
            {answer}
          </p>
        )}
      </details>

      {/* ------------------------------------------------ 4. Continuous Learning & IDE Agent Memory */}
      <details className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <summary className="flex cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-300">
            <Activity className="h-3.5 w-3.5 text-amber-400" /> Learned Preferences & IDE Context
          </span>
          <span className="font-mono text-[9px] text-zinc-500">
            {memory.feedbackHistory.length} feedback signal{memory.feedbackHistory.length === 1 ? '' : 's'}
          </span>
        </summary>

        {/* Prefer cues */}
        <div className="space-y-1">
          <p className="font-mono text-[9px] uppercase tracking-wider text-emerald-400/90">Always Prefer</p>
          <div className="flex flex-wrap gap-1">
            {memory.prefer.map((cue) => (
              <span
                key={cue}
                className="inline-flex items-center gap-1 rounded border border-emerald-900/60 bg-emerald-950/30 px-1.5 py-0.5 font-mono text-[9px] text-emerald-200"
              >
                {cue}
                <button
                  type="button"
                  onClick={() => removeBrainPreference('prefer', cue)}
                  className="text-emerald-400/70 hover:text-emerald-200"
                  aria-label={`Remove preferred cue ${cue}`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-1 pt-0.5">
            <input
              value={newPrefer}
              onChange={(e) => setNewPrefer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newPrefer.trim()) {
                  e.preventDefault()
                  addBrainPreference('prefer', newPrefer)
                  setNewPrefer('')
                }
              }}
              placeholder="Add preferred style cue…"
              className="h-6 min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-[10px] text-zinc-200 placeholder:text-zinc-600"
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 font-mono text-[9px]"
              onClick={() => {
                if (!newPrefer.trim()) return
                addBrainPreference('prefer', newPrefer)
                setNewPrefer('')
              }}
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Avoid cues */}
        <div className="mt-2 space-y-1">
          <p className="font-mono text-[9px] uppercase tracking-wider text-rose-400/90">Always Avoid</p>
          <div className="flex flex-wrap gap-1">
            {memory.avoid.map((cue) => (
              <span
                key={cue}
                className="inline-flex items-center gap-1 rounded border border-rose-900/60 bg-rose-950/30 px-1.5 py-0.5 font-mono text-[9px] text-rose-200"
              >
                {cue}
                <button
                  type="button"
                  onClick={() => removeBrainPreference('avoid', cue)}
                  className="text-rose-400/70 hover:text-rose-200"
                  aria-label={`Remove avoided cue ${cue}`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-1 pt-0.5">
            <input
              value={newAvoid}
              onChange={(e) => setNewAvoid(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newAvoid.trim()) {
                  e.preventDefault()
                  addBrainPreference('avoid', newAvoid)
                  setNewAvoid('')
                }
              }}
              placeholder="Add pattern to avoid…"
              className="h-6 min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-[10px] text-zinc-200 placeholder:text-zinc-600"
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 font-mono text-[9px]"
              onClick={() => {
                if (!newAvoid.trim()) return
                addBrainPreference('avoid', newAvoid)
                setNewAvoid('')
              }}
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Recent IDE / Agent Context Activity */}
        {memory.recentContext.length > 0 && (
          <div className="mt-2.5 border-t border-zinc-800/80 pt-2">
            <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-zinc-400">
              Recent Studio & IDE Context ({memory.recentContext.length})
            </p>
            <ul className="pixelforge-scroll max-h-28 space-y-0.5 overflow-y-auto font-mono text-[9px] text-zinc-400">
              {memory.recentContext.slice(0, 8).map((evt) => (
                <li key={evt.id} className="truncate" title={evt.summary}>
                  <span className="text-teal-400">{evt.source}</span> ·{' '}
                  <span className="text-zinc-300">{evt.toolOrAction}</span>: {evt.summary}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Memory lifecycle: inspect / clear session / full reset */}
        <div className="mt-2.5 flex items-center gap-1 border-t border-zinc-800/80 pt-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 font-mono text-[9px] text-zinc-400 hover:text-zinc-200"
            onClick={() => {
              void copyText(exportBrainMemory())
              setMemoryExported(true)
              setTimeout(() => setMemoryExported(false), 1500)
            }}
            title="Copy the full memory record as JSON (preferences, aliases, feedback, context)"
          >
            {memoryExported ? <Check className="mr-1 h-2.5 w-2.5 text-emerald-400" /> : <Copy className="mr-1 h-2.5 w-2.5" />}
            {memoryExported ? 'Copied' : 'Export JSON'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 font-mono text-[9px] text-zinc-400 hover:text-zinc-200"
            onClick={() => clearBrainSessionContext()}
            title="Clear recent activity and feedback history, keeping learned preferences"
          >
            <Eraser className="mr-1 h-2.5 w-2.5" /> Clear context
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-5 px-1.5 font-mono text-[9px] text-rose-400/80 hover:text-rose-300"
            onClick={async () => {
              // desktopConfirm: Electron has no window.confirm
              if (await desktopConfirm('Reset ALL Brain memory — learned preferences, aliases, feedback and context?')) {
                resetBrainMemory()
              }
            }}
            title="Factory-reset the whole Brain memory"
          >
            <RotateCcw className="mr-1 h-2.5 w-2.5" /> Reset all
          </Button>
        </div>
      </details>

      {/* ------------------------------------------------ Usage Footer */}
      <div className="mt-auto flex items-center gap-2 rounded border border-zinc-800/60 bg-zinc-950/60 px-2.5 py-1.5 font-mono text-[9px] text-zinc-500">
        <span title="today: calls / tokens in / tokens out">
          today {usage.calls} calls · {usage.tokensIn} in · {usage.tokensOut} out
        </span>
        <span title="all time">
          (all-time {usage.totalCalls} · {usage.totalTokensIn + usage.totalTokensOut} tok)
        </span>
        <button
          type="button"
          onClick={resetUsage}
          aria-label="Reset usage counters"
          title="Reset usage counters"
          className="ml-auto rounded px-1 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <RotateCcw className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  )
}
