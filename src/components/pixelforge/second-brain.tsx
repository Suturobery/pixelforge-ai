// PixelForge AI — Second Brain Panel (deterministic reasoning surface).
//
// Functions as the central intelligent reasoning layer of PixelForge AI:
//   1. Intelligent Prompt Interpreter & Error Corrector — understands short,
//      incomplete, misspelled, or ambiguous prompts from artists & IDE agents,
//      infers missing details from the active project context, and enhances them.
//   2. Agent Task Board — monitors and manages the work delegated to
//      connected IDE agents (brain_claim_task loop), including cancel/retry.
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
  WandSparkles,
  Check,
  Copy,
  ThumbsUp,
  ThumbsDown,
  Plus,
  X,
  Activity,
  Bot,
  Eraser,
  ClipboardList,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useEditor } from '@/lib/pixelforge/store'
import { useToast } from '@/hooks/use-toast'
import { currentProjectIdentity, mcpCtrl } from '@/lib/pixelforge/mcp-bridge'
import type { RemoteEditRecord } from '@/lib/pixelforge/mcp-bridge'
import { copyText, desktopConfirm } from '@/lib/pixelforge/desktop-bridge'
import {
  addBrainPreference,
  clearBrainSessionContext,
  exportBrainMemory,
  interpretAndEnhancePrompt,
  readBrainMemory,
  recordBrainFeedback,
  removeBrainPreference,
  resetBrainMemory,
  subscribeBrainMemory,
  writeBrainMemory,
  type PromptCorrection,
  type SecondBrainMemory,
} from '@/lib/pixelforge/brain-core'
import { MCP_TOOLS } from '@/lib/pixelforge/mcp-tool-catalog'
import {
  PIXEL_ART_RECIPES,
  applyPixelArtRecipe,
  defaultBriefFields,
  buildAssetBrief,
  detectRecipeSuitability,
  type AssetBriefFields,
  type PixelArtRecipeId,
} from '@/lib/pixelforge/asset-brief'

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
  const setReferenceDraft = useEditor((s) => s.setReferenceDraft)
  const { toast } = useToast()
  const requestRightTab = useEditor((s) => s.requestRightTab)
  // Continuous learning memory state
  const [memory, setMemory] = useState<SecondBrainMemory>(() => readBrainMemory())
  useEffect(() => {
    setMemory(readBrainMemory())
    return subscribeBrainMemory(() => setMemory(readBrainMemory()))
  }, [])

  // Prompt Interpreter & Enhancer state
  const [rawPrompt, setRawPrompt] = useState('')
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

  // overview: MCP service, connected agents, pending approvals (doc §12)
  const [mcpStatus, setMcpStatus] = useState<{
    mcpEnabled: boolean
    editorConnected: boolean
    clientsPaired: number
    clientsConnected: number
    sessions: number
    lastProjectName: string | null
  } | null>(null)
  const [mcpClients, setMcpClients] = useState<
    Array<{ clientId: string; name: string; tier: string; lastSeen: string | null; revoked: boolean }>
  >([])
  const [boardTasks, setBoardTasks] = useState<
    Array<{
      id: string
      title: string
      status: string
      claimedBy: string | null
      result: string | null
      progress: string | null
      verified: boolean | null
      targetProjectName?: string | null
      targetProjectKey?: string | null
    }>
  >([])

  // --- Pixel Art Recipe (deterministic work contract → task board) ---
  const [brief, setBrief] = useState<AssetBriefFields>(() =>
    defaultBriefFields(project, readBrainMemory()),
  )
  const [selectedRecipe, setSelectedRecipe] = useState<PixelArtRecipeId | null>(null)
  const [briefPreviewOpen, setBriefPreviewOpen] = useState(false)
  const [briefText, setBriefText] = useState('')
  const [briefEdited, setBriefEdited] = useState(false)
  type BriefStatus =
    | 'sent'
    | 'copied'
    | 'not-connected-copied'
    | 'not-connected-copy-failed'
    | 'uncertain-copied'
    | 'uncertain-copy-failed'
    | 'rejected-copied'
    | 'rejected-copy-failed'
    | 'copy-failed'
    | null
  const [briefStatus, setBriefStatus] = useState<BriefStatus>(null)
  const [briefError, setBriefError] = useState<string | null>(null)
  const [briefBusy, setBriefBusy] = useState(false)
  const setBriefField = (key: keyof AssetBriefFields, value: string | number | string[]) =>
    setBrief((f) => ({ ...f, [key]: value }))
  const selectRecipe = (recipeId: PixelArtRecipeId) => {
    setSelectedRecipe(recipeId)
    setBrief((fields) => applyPixelArtRecipe(fields, recipeId))
    setBriefStatus(null)
  }
  const currentRecipe = PIXEL_ART_RECIPES.find((r) => r.id === selectedRecipe)
  const detectedCategory = detectRecipeSuitability(brief.assetType)
  const isMismatch = Boolean(selectedRecipe && detectedCategory && detectedCategory !== selectedRecipe)
  const suggestedRecipe = isMismatch && detectedCategory ? PIXEL_ART_RECIPES.find((r) => r.id === detectedCategory) : null

  const composeBrief = () => {
    const { detail } = buildAssetBrief(brief, project, memory)
    setBriefText(detail)
    setBriefEdited(false)
    setBriefPreviewOpen(true)
    setBriefStatus(null)
  }
  const recomposeBrief = () => {
    const { detail } = buildAssetBrief(brief, project, memory)
    setBriefText(detail)
    setBriefEdited(false)
  }
  const copyBrief = async () => {
    try {
      await copyText(briefText)
      setBriefStatus('copied')
    } catch {
      setBriefStatus('copy-failed')
    }
  }
  const confirmBrief = async () => {
    if (briefBusy || !briefText.trim()) return
    setBriefBusy(true)
    // mcpCtrl failure codes (mcp-bridge.ts): 'not_connected' = the request was
    // NEVER sent (certain: nothing queued); 'timeout' = sent over an open
    // socket but the reply was lost (UNCERTAIN — the server may have accepted
    // the task); any other ok:false is an explicit server rejection. A
    // mid-send socket error can also throw — treat that as uncertain too.
    const fallbackCopy = async (okStatus: BriefStatus, failStatus: BriefStatus) => {
      try {
        await copyText(briefText)
        setBriefStatus(okStatus)
      } catch {
        setBriefStatus(failStatus)
      }
    }
    try {
      const res = await mcpCtrl<{ tasks: unknown[] }>({
        kind: 'brain-push',
        tasks: [{ title: `Pixel art recipe: ${brief.assetType || 'asset'}`, detail: briefText, targetProject: currentProjectIdentity() }],
      })
      if (res.ok) {
        setBriefStatus('sent')
        void pollBoard()
        return
      }
      const code = res.error?.code ?? 'unknown'
      setBriefError(res.error?.message ?? null)
      if (code === 'not_connected') {
        // certain: the request was never sent — nothing was queued
        await fallbackCopy('not-connected-copied', 'not-connected-copy-failed')
      } else if (code === 'timeout' || code === 'unknown') {
        // uncertain: the server may have accepted the task — reply lost
        await fallbackCopy('uncertain-copied', 'uncertain-copy-failed')
      } else {
        // explicit rejection — confirmed: nothing was queued
        await fallbackCopy('rejected-copied', 'rejected-copy-failed')
      }
    } catch {
      // transport threw mid-send — delivery unknown → uncertain
      setBriefError(null)
      await fallbackCopy('uncertain-copied', 'uncertain-copy-failed')
    } finally {
      setBriefBusy(false)
    }
  }

  // Poll the MCP agent task board + overview facts on one timer
  const pollBoard = useCallback(async () => {
    const res = await mcpCtrl<{
      tasks: Array<{
        id: string
        title: string
        status: string
        claimedBy: string | null
        result: string | null
        progress: string | null
        verified: boolean | null
        targetProjectName?: string | null
        targetProjectKey?: string | null
      }>
    }>({
      kind: 'brain-tasks',
    })
    if (res.ok && res.data?.tasks) setBoardTasks(res.data.tasks)
    const statusRes = await mcpCtrl<{
      mcpEnabled: boolean
      editorConnected: boolean
      clientsPaired: number
      clientsConnected: number
      sessions: number
      lastProjectName: string | null
    }>({ kind: 'status' })
    if (statusRes.ok && statusRes.data) setMcpStatus(statusRes.data)
    const clientsRes = await mcpCtrl<{
      clients: Array<{ clientId: string; name: string; tier: string; lastSeen: string | null; revoked: boolean }>
    }>({ kind: 'clients-list' })
    if (clientsRes.ok && clientsRes.data?.clients) setMcpClients(clientsRes.data.clients)
  }, [])

  useEffect(() => {
    void pollBoard()
    const timer = setInterval(() => void pollBoard(), 8000)
    return () => clearInterval(timer)
  }, [pollBoard])

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


  const effectiveEnhanced = localInterpretation?.enhancedPrompt ?? ''
  const effectiveCorrections = localInterpretation?.corrections ?? []
  const effectiveGuidance = localInterpretation?.pixelArtGuidance ?? []

  /** Hand a custom sprite brief to the Reference panel: prefill the brief and
   *  guide to the approved reference when the project has none. */
  const openInReference = (briefText: string) => {
    setReferenceDraft(briefText.trim() || rawPrompt.trim())
    requestRightTab('reference')
    if ((project.settings.styleProfile?.references?.length ?? 0) === 0) {
      toast({
        title: 'No approved reference yet',
        description: 'Import a 16×16/32×32 PNG or pick a clip frame in section 2 — it is saved with the project style.',
      })
    }
  }

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
              <p className="font-mono text-xs font-semibold text-zinc-100">Second Brain</p>
              <p className="truncate font-mono text-[10px] text-zinc-400">
                Turn a rough idea into a usable pixel-art prompt.
              </p>
            </div>
          </div>
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
          Start with the idea. Second Brain handles the cleanup and project context. Deterministic — no model, no cost.
        </p>

        <div className="space-y-2">
          <Textarea
            value={rawPrompt}
            onChange={(e) => setRawPrompt(e.target.value)}
            placeholder="Describe what you want to make. Typos and shorthand are okay."
            aria-label="Prompt to interpret and enhance"
            className="min-h-[112px] resize-none border-zinc-700 bg-zinc-950 px-3 py-2.5 font-mono text-sm leading-relaxed shadow-inner"
            spellCheck={false}
          />
        </div>

        {/* Quick example chips */}
        <div className="mt-1.5 flex flex-wrap gap-1">
          {QUICK_PROMPT_EXAMPLES.map((ex) => (
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
              <p className="text-[9px] uppercase tracking-wider text-teal-400">Enhanced Prompt</p>
              <p className="mt-0.5 break-words rounded border border-zinc-800 bg-zinc-900/70 p-1.5 text-[10px] leading-relaxed text-zinc-100">
                {effectiveEnhanced}
              </p>
            </div>

            {/* Hand-off actions — sprite prompts route to the right workflow:
                bundled characters → Create Character; custom sprites → the
                Reference panel (uses the project's approved reference +
                style); anything queued for an IDE agent stays separate. */}
            {localInterpretation.detectedIntent === 'sprite-generation' && (
              <div className="rounded border border-teal-800/60 bg-teal-950/30 p-1.5">
                <p className="text-[9px] leading-tight text-teal-200">
                  Sprite brief ready — queue it for your external IDE agent below, or open the{' '}
                  <strong className="text-teal-300">Reference panel</strong> to import and clean an external PNG against the
                  project's approved style.
                </p>
                <Button
                  size="sm"
                  className="mt-1 h-6 w-full font-mono text-[10px]"
                  onClick={() => openInReference(rawPrompt)}
                  title="Open the Reference panel with this brief prefilled to import and grid-snap an external PNG"
                >
                  <WandSparkles className="mr-1 h-3 w-3" /> Open in Reference Import
                </Button>
              </div>
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

            {/* Copy & Continuous Learning Feedback */}
            <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-zinc-800/80 pt-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 font-mono text-[9px] text-zinc-300 hover:text-white"
                onClick={() => void handleCopyEnhanced()}
              >
                {copiedEnhanced ? <Check className="mr-1 h-3 w-3 text-emerald-400" /> : <Copy className="mr-1 h-3 w-3" />}
                {copiedEnhanced ? 'Copied' : 'Copy'}
              </Button>

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

      {/* ------------------------------------------------ 1.5 Pixel Art Recipe → IDE Agent */}
      <details className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-300 [&::-webkit-details-marker]:hidden">
          <ClipboardList className="h-3.5 w-3.5 text-teal-400" /> Pixel Art Recipe → IDE Agent
          <span className="ml-auto normal-case tracking-normal text-zinc-500">draw, review, refine</span>
        </summary>
        <p className="mb-2 font-mono text-[9px] leading-tight text-zinc-500">
          Choose a recipe, customize it, then send a staged drawing contract to your paired IDE agent.
          It draws with PixelForge tools—no image generation.
        </p>

        {!briefPreviewOpen ? (
          <>
            <div className="mb-2 grid grid-cols-3 gap-1" aria-label="Pixel art recipe types">
              {PIXEL_ART_RECIPES.map((recipe) => {
                const selected = selectedRecipe === recipe.id
                return (
                  <button
                    key={recipe.id}
                    type="button"
                    onClick={() => selectRecipe(recipe.id)}
                    aria-pressed={selected}
                    title={recipe.description}
                    className={`min-w-0 rounded border px-1.5 py-1.5 text-left transition-colors ${
                      selected
                        ? 'border-teal-500/60 bg-teal-950/50 text-teal-200'
                        : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                    }`}
                  >
                    <span className="block truncate font-mono text-[9px] font-semibold uppercase tracking-wide">
                      {recipe.label}
                    </span>
                    <span className="mt-0.5 block line-clamp-2 text-[8px] leading-tight text-zinc-500">
                      {recipe.description}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="mb-2 flex items-center gap-1" aria-label="Recipe workflow">
              {['Silhouette', 'Color', 'Polish', 'Animate', 'Review'].map((stage, index) => (
                <div key={stage} className="flex min-w-0 flex-1 items-center gap-1">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-800 font-mono text-[8px] text-teal-300">
                    {index + 1}
                  </span>
                  <span className="truncate font-mono text-[8px] text-zinc-500">{stage}</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {/* Asset type block with recipe-aware suggestions and suitability indicator */}
              <div className="col-span-2 space-y-1">
                <div className="flex items-center justify-between">
                  <label htmlFor="pf-recipe-asset-type" className="font-mono text-[9px] text-zinc-400">
                    Asset type
                    {selectedRecipe && (
                      <span className="ml-1 text-[8px] font-normal text-teal-400">
                        ({currentRecipe?.label} suitable)
                      </span>
                    )}
                  </label>
                  {selectedRecipe && (
                    <span className="font-mono text-[8px] text-zinc-500">
                      Pick a preset below or type custom
                    </span>
                  )}
                </div>
                <div className="flex gap-1.5">
                  <Input
                    id="pf-recipe-asset-type"
                    list="pf-suitable-asset-types"
                    value={brief.assetType}
                    onChange={(e) => {
                      const val = e.target.value
                      setBriefField('assetType', val)
                      if (!selectedRecipe) {
                        const detected = detectRecipeSuitability(val)
                        if (detected) selectRecipe(detected)
                      }
                    }}
                    placeholder={currentRecipe?.placeholder ?? 'knight sprite / tileset / vfx'}
                    aria-label="Asset type"
                    className="h-6 flex-1 border-zinc-800 bg-zinc-950 px-2 font-mono text-[10px]"
                  />
                  <datalist id="pf-suitable-asset-types">
                    {(currentRecipe?.suitableAssetTypes ?? []).map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                </div>

                {/* Quick suggestion chips for the active recipe */}
                {currentRecipe && (
                  <div className="flex flex-wrap gap-1 pt-0.5" aria-label="Suitable asset type presets">
                    {currentRecipe.suitableAssetTypes.map((typeOption) => {
                      const active = brief.assetType.toLowerCase() === typeOption.toLowerCase()
                      return (
                        <button
                          key={typeOption}
                          type="button"
                          onClick={() => {
                            setBriefField('assetType', typeOption)
                            if (selectedRecipe === 'tileset' && typeOption.includes('platformer')) {
                              setBriefField('cameraAngle', 'side view')
                            } else if (selectedRecipe === 'tileset' && typeOption.includes('autotile')) {
                              setBriefField('cameraAngle', 'top-down')
                            }
                          }}
                          className={`rounded px-1.5 py-0.5 font-mono text-[8px] transition-colors ${
                            active
                              ? 'border border-teal-500/60 bg-teal-950/60 font-semibold text-teal-300'
                              : 'border border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                          }`}
                        >
                          {typeOption}
                        </button>
                      )
                    })}
                  </div>
                )}

                {/* Suitability warning if user input belongs to a different recipe */}
                {isMismatch && suggestedRecipe && (
                  <div className="flex items-center justify-between gap-1 rounded border border-amber-500/30 bg-amber-950/20 px-2 py-1 font-mono text-[9px] text-amber-300">
                    <span className="truncate">
                      ⚠️ &ldquo;{brief.assetType}&rdquo; is usually a <strong>{suggestedRecipe.label}</strong> asset.
                    </span>
                    <button
                      type="button"
                      onClick={() => selectRecipe(suggestedRecipe.id)}
                      className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[8px] font-semibold text-amber-200 hover:bg-amber-500/30"
                    >
                      Switch to {suggestedRecipe.label} recipe
                    </button>
                  </div>
                )}
              </div>
              <label className="min-w-0 font-mono text-[9px] text-zinc-400">
                Canvas
                <Input
                  value={`${project.width}×${project.height}`}
                  readOnly
                  aria-label="Canvas size (from project)"
                  className="mt-0.5 h-6 border-zinc-800 bg-zinc-900 px-2 font-mono text-[10px] text-zinc-500"
                />
              </label>
              <label className="min-w-0 font-mono text-[9px] text-zinc-400">
                Camera angle
                <select
                  value={brief.cameraAngle}
                  onChange={(e) => setBriefField('cameraAngle', e.target.value)}
                  aria-label="Camera angle"
                  className="mt-0.5 h-6 w-full rounded border border-zinc-800 bg-zinc-950 px-1.5 font-mono text-[10px] text-zinc-200"
                >
                  {['side view', 'top-down', 'isometric', 'front', '3/4 view'].map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 font-mono text-[9px] text-zinc-400">
                Facing
                <select
                  value={brief.facing}
                  onChange={(e) => setBriefField('facing', e.target.value)}
                  aria-label="Facing direction"
                  className="mt-0.5 h-6 w-full rounded border border-zinc-800 bg-zinc-950 px-1.5 font-mono text-[10px] text-zinc-200"
                >
                  {['right', 'left', 'front', 'back', 'up', 'down'].map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 font-mono text-[9px] text-zinc-400">
                Pose / animation goal
                <Input
                  value={brief.poseGoal}
                  onChange={(e) => setBriefField('poseGoal', e.target.value)}
                  placeholder="4-frame walk cycle / idle bob / attack"
                  aria-label="Pose or animation goal"
                  className="mt-0.5 h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[10px]"
                />
              </label>
              <label className="min-w-0 font-mono text-[9px] text-zinc-400">
                Color limit (palette has {project.palette.length})
                <Input
                  type="number"
                  min={2}
                  max={project.palette.length}
                  value={brief.colorLimit}
                  onChange={(e) => setBriefField('colorLimit', Math.max(2, Math.min(project.palette.length, Number(e.target.value) || project.palette.length)))}
                  aria-label="Color limit"
                  className="mt-0.5 h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[10px]"
                />
              </label>
              <label className="min-w-0 font-mono text-[9px] text-zinc-400">
                Outline
                <Input
                  value={brief.outline}
                  onChange={(e) => setBriefField('outline', e.target.value)}
                  aria-label="Outline"
                  className="mt-0.5 h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[10px]"
                />
              </label>
              <label className="min-w-0 font-mono text-[9px] text-zinc-400">
                Lighting
                <Input
                  value={brief.lighting}
                  onChange={(e) => setBriefField('lighting', e.target.value)}
                  aria-label="Lighting"
                  className="mt-0.5 h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[10px]"
                />
              </label>
              <label className="min-w-0 font-mono text-[9px] text-zinc-400">
                Detail level
                <select
                  value={brief.detailLevel}
                  onChange={(e) => setBriefField('detailLevel', e.target.value)}
                  aria-label="Detail level"
                  className="mt-0.5 h-6 w-full rounded border border-zinc-800 bg-zinc-950 px-1.5 font-mono text-[10px] text-zinc-200"
                >
                  {['low', 'medium', 'high'].map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 font-mono text-[9px] text-zinc-400">
                Must include
                <Input
                  value={brief.requiredDetails}
                  onChange={(e) => setBriefField('requiredDetails', e.target.value)}
                  placeholder="glow ember, wooden handle…"
                  aria-label="Required details"
                  className="mt-0.5 h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[10px]"
                />
              </label>
              <label className="min-w-0 font-mono text-[9px] text-zinc-400">
                Avoid
                <Input
                  value={brief.avoid}
                  onChange={(e) => setBriefField('avoid', e.target.value)}
                  aria-label="Things to avoid"
                  className="mt-0.5 h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[10px]"
                />
              </label>
              <label className="min-w-0 font-mono text-[9px] text-zinc-400">
                Notes
                <Input
                  value={brief.notes}
                  onChange={(e) => setBriefField('notes', e.target.value)}
                  placeholder="optional extras"
                  aria-label="Brief notes"
                  className="mt-0.5 h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[10px]"
                />
              </label>
            </div>

            {/* reference clips from the active project */}
            {project.clips.length > 0 && (
              <div className="mt-1.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">Reference clips</p>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {project.clips.map((c) => {
                    const on = brief.references.includes(c.name)
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          setBriefField(
                            'references',
                            on ? brief.references.filter((r) => r !== c.name) : [...brief.references, c.name],
                          )
                        }
                        aria-pressed={on}
                        aria-label={`Use clip ${c.name} as reference`}
                        className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                          on
                            ? 'border-teal-600/60 bg-teal-950/40 text-teal-300'
                            : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {on ? '✓ ' : ''}{c.name} ({c.frames.length}f)
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <Button
              size="sm"
              className="mt-2 h-7 w-full font-mono text-[10px]"
              onClick={() => {
                composeBrief()
                setBriefPreviewOpen(true)
              }}
              disabled={!brief.assetType.trim() && !brief.poseGoal.trim()}
              title="Compose the brief preview from these fields (fully editable before sending)"
            >
              <WandSparkles className="mr-1 h-3 w-3" /> Compose brief preview
            </Button>
          </>
        ) : (
          <>
            {/* editable brief preview — this gates only the SEND; agent edits
                on the canvas are not approval-gated in-app */}
            <p className="mb-1 font-mono text-[9px] leading-tight text-zinc-500">
              Editable preview — adjust freely, then Confirm to queue for a connected IDE agent.
              {briefEdited ? ' (edited — recompose to discard manual edits)' : ''}
            </p>
            <Textarea
              value={briefText}
              onChange={(e) => {
                setBriefText(e.target.value)
                setBriefEdited(true)
              }}
              aria-label="Pixel art recipe text (editable)"
              className="pixelforge-scroll min-h-[140px] resize-y border-zinc-700 bg-zinc-950 px-2.5 py-2 font-mono text-[10px] leading-relaxed"
              spellCheck={false}
            />
            <p className="mt-0.5 font-mono text-[9px] text-zinc-500">
              {briefText.length}/2000 chars {briefText.length > 2000 ? '— too long, trim it' : ''}
            </p>
            <p className="col-span-2 font-mono text-[9px] leading-tight text-zinc-400" aria-live="polite">
              agent:{' '}
              {mcpStatus?.editorConnected && (mcpStatus?.clientsConnected ?? 0) > 0 ? (
                <span className="text-emerald-300">connected ({mcpStatus.clientsConnected} live) · task waits on the board until claimed</span>
              ) : mcpStatus?.editorConnected ? (
                <span className="text-amber-300">MCP live · no agent connected — the queued task waits to be claimed</span>
              ) : (
                <span className="text-zinc-500">not connected — queue anyway, or copy the brief</span>
              )}
            </p>
            <div className="mt-1.5 grid grid-cols-2 gap-1">
              <Button
                size="sm"
                className="h-7 font-mono text-[10px]"
                onClick={() => void confirmBrief()}
                disabled={briefBusy || !briefText.trim() || briefText.length > 2000}
                title="Queue this brief on the agent task board for a connected IDE agent"
              >
                {briefBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
                Send to Connected Agent
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-zinc-700 font-mono text-[10px]"
                onClick={() => void copyBrief()}
                title="Copy the brief to the clipboard (fallback: paste into your IDE agent)"
              >
                <Copy className="mr-1 h-3 w-3" /> Copy brief
              </Button>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 font-mono text-[9px] text-zinc-400"
                onClick={() => {
                  setBriefPreviewOpen(false)
                  setBriefStatus(null)
                }}
                aria-label="Cancel brief preview"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 font-mono text-[9px] text-zinc-400"
                onClick={recomposeBrief}
                disabled={!briefEdited}
                title="Regenerate the preview from the form fields (discards manual edits)"
              >
                <RotateCcw className="mr-1 h-2.5 w-2.5" /> Recompose from fields
              </Button>
            </div>
          </>
        )}

        {briefStatus === 'sent' && (
          <div role="status" className="mt-2 rounded border border-teal-700/60 bg-teal-950/30 px-2 py-1.5 font-mono text-[10px] leading-tight text-teal-200">
            <strong>Recipe sent to the task board</strong> — pending until an agent claims it. This is NOT “asset done”:
            edits appear on the canvas when the connected agent finishes (watch the Agent Task Board below, ✓ rows).
          </div>
        )}
        {briefStatus === 'copied' && (
          <div role="status" className="mt-2 rounded border border-teal-700/60 bg-teal-950/30 px-2 py-1.5 font-mono text-[10px] leading-tight text-teal-200">
            <strong>Brief copied — paste it into your IDE agent.</strong> It will execute the same tools on the
            same project (paired via Settings → AI connection).
          </div>
        )}
        {briefStatus === 'not-connected-copied' && (
          <div role="alert" className="mt-2 rounded border border-amber-700/60 bg-amber-950/30 px-2 py-1.5 font-mono text-[10px] leading-tight text-amber-200">
            <strong>MCP is not connected — nothing was queued.</strong> Brief copied to your clipboard — paste it
            into your IDE agent (pairing: Settings → AI connection).
          </div>
        )}
        {briefStatus === 'not-connected-copy-failed' && (
          <div role="alert" className="mt-2 rounded border border-red-800/60 bg-red-950/30 px-2 py-1.5 font-mono text-[10px] leading-tight text-red-200">
            <strong>MCP is not connected — nothing was queued</strong>, and clipboard copy failed. Copy the brief
            text from the preview above manually.
          </div>
        )}
        {briefStatus === 'uncertain-copied' && (
          <div role="alert" className="mt-2 rounded border border-amber-700/60 bg-amber-950/30 px-2 py-1.5 font-mono text-[10px] leading-tight text-amber-200">
            <strong>Brief copied to your clipboard — but couldn’t confirm whether it was queued.</strong> The
            reply may have been lost after the server accepted it. Check the task board before retrying.
          </div>
        )}
        {briefStatus === 'uncertain-copy-failed' && (
          <div role="alert" className="mt-2 rounded border border-red-800/60 bg-red-950/30 px-2 py-1.5 font-mono text-[10px] leading-tight text-red-200">
            <strong>Couldn’t confirm whether the brief was queued, and clipboard copy failed.</strong> Check the
            task board before retrying; copy the brief text from the preview above manually if needed.
          </div>
        )}
        {briefStatus === 'rejected-copied' && (
          <div role="alert" className="mt-2 rounded border border-amber-700/60 bg-amber-950/30 px-2 py-1.5 font-mono text-[10px] leading-tight text-amber-200">
            <strong>The task board rejected the brief — nothing was queued.</strong>
            {briefError ? ` Reason: ${briefError}.` : ''} Brief copied to your clipboard — paste it into your IDE
            agent instead.
          </div>
        )}
        {briefStatus === 'rejected-copy-failed' && (
          <div role="alert" className="mt-2 rounded border border-red-800/60 bg-red-950/30 px-2 py-1.5 font-mono text-[10px] leading-tight text-red-200">
            <strong>The task board rejected the brief — nothing was queued</strong>
            {briefError ? ` (reason: ${briefError})` : ''}, and clipboard copy failed. Copy the brief text from
            the preview above manually.
          </div>
        )}
        {briefStatus === 'copy-failed' && (
          <div role="alert" className="mt-2 rounded border border-red-800/60 bg-red-950/30 px-2 py-1.5 font-mono text-[10px] leading-tight text-red-200">
            <strong>Clipboard copy failed — the brief was NOT copied.</strong> Select the brief text in the
            preview above and copy it manually.
          </div>
        )}
      </details>

      {/* ------------------------------------------------ 2. Agent Task Board */}
      <details className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-300 [&::-webkit-details-marker]:hidden">
          <ListChecks className="h-3.5 w-3.5 text-frost-400" /> Agent Task Board
          <span className="ml-auto normal-case tracking-normal text-zinc-500">delegated work</span>
        </summary>
        <p className="mb-2 font-mono text-[9px] leading-tight text-zinc-500">
          Work queued by the artist's plans and external IDE agents. Pending tasks are claimable via brain_claim_task.
        </p>

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
                  {t.targetProjectName ? (
                    <span className="text-frost-400/80"> · {t.targetProjectName}</span>
                  ) : (
                    <span className="text-amber-500/70"> · no target project</span>
                  )}
                  {t.claimedBy ? <span className="text-zinc-600"> · claimed by {t.claimedBy}</span> : null}
                  {(t.result || t.progress) ? (
                    <span className="text-zinc-600"> · {t.status === 'running' && t.progress ? t.progress : (t.result ?? t.progress)}</span>
                  ) : null}
                  {t.status === 'done' && t.verified === true ? <span className="text-emerald-500/80"> · changes detected</span> : null}
                  {t.status === 'done' && t.verified === false ? <span className="text-amber-500/80"> · no changes detected</span> : null}
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
            <Bot className="h-3.5 w-3.5 text-sky-400" /> Connected Agents
          </span>
          <span className="font-mono text-[9px] text-zinc-500">
            {mcpClients.filter((c) => !c.revoked).length} paired
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

    </div>
  )
}
