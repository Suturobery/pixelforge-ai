// PixelForge AI — AI Studio panel (Task 9).
//
// Complete candidate workflow per plan §3.2:
//   Prompt (+ recipe preset, size, palette mode, count) → Generate →
//   Normalize v2 (worker) → Review (original vs normalized, provenance) →
//   Accept as layer / Accept as frame / Discard — and re-run normalization
//   with adjusted parameters at any time.
//
// NEVER overwrites existing artwork: imports are additive CommandBus
// transactions (new layer on the active frame / new frame in the clip).
// Cost numbers are ESTIMATES ("≈ $x.xx") or "n/a" — never exact charges.

'use client'

import {
  estimateCostUsd,
  requestSizeFor,
  RECIPE_PRESETS,
  SIZE_PRESETS,
  type Normalize2Options,
  type PaletteMode,
} from '@pixelforge/core'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, getActiveClip } from '@/lib/pixelforge/store'
import { useAppSettings, getActiveProvider } from '@/lib/pixelforge/settings'
import { isDesktop } from '@/lib/pixelforge/desktop-bridge'
import {
  aiCandidateStore,
  loadAiHistoryFor,
  persistAiHistory,
  registerAcceptedTarget,
  useAiCandidates,
  type AiCandidate,
} from '@/lib/pixelforge/ai/candidates'
import { normalizeCandidate, cancelGeneration, submitGeneration } from '@/lib/pixelforge/ai/generate'
import { uid } from '@/lib/pixelforge/factory'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from '@/hooks/use-toast'
import { Sparkles, Upload, Trash2, ImagePlus, Layers, Film, Loader2, History, RotateCcw, Ban, RefreshCw } from 'lucide-react'

const SUGGESTIONS = [
  '32x32 farmer character, overalls and straw hat, front view, idle stance',
  'cute slime monster, green, bouncing pose',
  'space marine hero, chunky armor, side view',
  'treasure chest, closed, wooden with gold trim',
]

/** Small PNG thumbnail of a normalized buffer (history strip). */
function makeThumb(buffer: Uint8ClampedArray, w: number, h: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), w, h), 0, 0)
  return canvas.toDataURL('image/png')
}

function fmtCost(usd: number | null): string {
  if (usd === null) return 'cost n/a'
  if (usd === 0) return 'cost $0 (cache)'
  return `≈ $${usd.toFixed(3)} (estimate)`
}

export function AiPanel() {
  const project = useEditor((s) => s.project)
  const importCandidateAsLayer = useEditor((s) => s.importCandidateAsLayer)
  const importCandidateAsFrame = useEditor((s) => s.importCandidateAsFrame)
  const { toast } = useToast()
  const [prompt, setPrompt] = useState('')
  const [recipeId, setRecipeId] = useState('character')
  const [size, setSize] = useState<{ w: number; h: number }>({ w: project.width, h: project.height })
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('auto')
  const [maxColors, setMaxColors] = useState(16)
  const [removeBg, setRemoveBg] = useState(true)
  const [bgTolerance, setBgTolerance] = useState(48)
  const [outlineCleanup, setOutlineCleanup] = useState(true)
  const [count, setCount] = useState(1)
  const [seedOn, setSeedOn] = useState(false)
  const [seed, setSeed] = useState(1)
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [compare, setCompare] = useState(true)
  const [usageSpend, setUsageSpend] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const candidates = useAiCandidates((s) => s.candidates)
  const history = useAiCandidates((s) => s.history)

  // active generation engine (Settings → AI & MCP); null = built-in Z.AI
  const aiProviders = useAppSettings((s) => s.aiProviders)
  const activeProviderId = useAppSettings((s) => s.activeProviderId)
  const activeProvider = getActiveProvider({ aiProviders, activeProviderId })
  const secureMode = useAppSettings((s) => s.secureMode)
  const keyStatus = useAppSettings((s) => s.keyStatus)
  const aiMonthlyLimitUsd = useAppSettings((s) => s.aiMonthlyLimitUsd)

  // Desktop: the renderer never holds key material, so getActiveProvider's
  // key check cannot see vault-stored keys — keyStatus (hasKey booleans from
  // main) is the source of truth there. Web: the legacy inline key decides.
  const desktopProvider = secureMode
    ? (aiProviders.find((p) => p.id === activeProviderId && p.enabled && p.kind !== 'anthropic' && (p.kind === 'zai' || keyStatus[p.id]?.hasKey)) ?? null)
    : null
  const effectiveProvider = activeProvider ?? desktopProvider
  const effectiveProviderId = effectiveProvider?.id ?? (secureMode ? activeProviderId || 'zai' : 'zai')

  const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0] ?? null

  // per-project history lifecycle
  useEffect(() => {
    const pid = project.id
    if (!pid) return
    loadAiHistoryFor(pid)
    return () => persistAiHistory(pid)
  }, [project.id])

  // desktop usage meter (bridge → main-process usage records)
  useEffect(() => {
    const bridgeAi = typeof window !== 'undefined' && isDesktop() ? window.pixelforge?.ai : undefined
    if (!bridgeAi) return
    let alive = true
    bridgeAi
      .usage()
      .then((u) => {
        if (alive) setUsageSpend(u.monthSpendUsd)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [candidates.length])

  const normalizeOpts: Normalize2Options = useMemo(
    () => ({
      targetW: size.w,
      targetH: size.h,
      removeBg,
      bgTolerance,
      paletteMode,
      palette: paletteMode === 'project' ? project.palette : [],
      maxColors,
      outlineCleanup,
    }),
    [size.w, size.h, removeBg, bgTolerance, paletteMode, project.palette, maxColors, outlineCleanup],
  )

  // pre-flight cost estimate (ESTIMATE — provider pricing table; null = n/a)
  const preflightEstimate = effectiveProvider ? estimateCostUsd(effectiveProvider.kind, effectiveProvider.model, count) : null

  const generate = useCallback(async () => {
    const text = prompt.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      await submitGeneration(
        {
          prompt: text,
          recipeId,
          width: size.w,
          height: size.h,
          count,
          ...(seedOn && seed > 0 ? { seed } : {}),
          providerId: effectiveProviderId,
          providerLabel: effectiveProvider?.label ?? 'Z.AI (built-in)',
          model: effectiveProvider?.model ?? 'auto',
          normalize: normalizeOpts,
        },
        {
          // web prototype residual (13a): the key rides per-request; desktop
          // ignores these — the main process resolves the vault key itself
          webApiKey: effectiveProvider?.apiKey,
          webBaseUrl: effectiveProvider?.baseUrl,
          webProviderKind: effectiveProvider?.kind,
        },
      )
      toast({ title: 'Candidates ready', description: 'Review, then import as layer or frame.' })
      setSelectedId(aiCandidateStore.getState().candidates[0]?.id ?? null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      // provider-side hiccups (5xx, "network error, retry later", connection
      // drops) are usually transient — say so instead of showing raw text
      const transient =
        /status 5\d\d|网络错误|请稍后|temporar|unavailable|ECONN|ETIMEDOUT|fetch failed|timeout|503|overloaded/i.test(msg)
      toast({
        title: 'Generation failed',
        description: transient
          ? 'The image service had a temporary network error — your connection is fine. Press Generate again in a moment.'
          : msg,
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }, [prompt, busy, recipeId, size, count, seedOn, seed, effectiveProvider, effectiveProviderId, normalizeOpts, toast])

  const importFile = async (file: File) => {
    try {
      const src = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(r.result as string)
        r.onerror = () => reject(new Error('Could not read file'))
        r.readAsDataURL(file)
      })
      const candidate: AiCandidate = {
        id: uid('ai'),
        prompt: `import: ${file.name.slice(0, 60)}`,
        providerId: 'import',
        providerLabel: 'file import',
        model: '—',
        seed: null,
        requestSize: '—',
        width: size.w,
        height: size.h,
        createdAt: new Date().toISOString(),
        jobDurationMs: null,
        costEstimateUsd: null,
        cacheHit: false,
        recipe: 'free',
        originalSrc: src,
        // dimensions come from the decode inside normalizeCandidate
        originalW: 0,
        originalH: 0,
        normalizeOpts: normalizeOpts as unknown as Record<string, unknown>,
        normalized: null,
        status: 'normalizing',
        error: null,
      }
      aiCandidateStore.getState().upsert(candidate)
      setSelectedId(candidate.id)
      await normalizeCandidate(candidate.id, normalizeOpts)
      toast({ title: 'Image imported', description: 'Normalized — import as layer or frame.' })
    } catch (err) {
      toast({
        title: 'Import failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    }
  }

  const acceptAsLayer = (c: AiCandidate) => {
    if (!c.normalized) return
    const name = `AI: ${c.prompt.slice(0, 24)}`
    const ref = importCandidateAsLayer(new Uint8ClampedArray(c.normalized.buffer), name)
    if (!ref) return
    // re-import stays locked while the import exists; undo/delete unlocks it
    // (reconcileAcceptedCandidates flips the status back to 'review')
    registerAcceptedTarget(c.id, ref)
    aiCandidateStore.getState().patch(c.id, { status: 'accepted' })
    aiCandidateStore.getState().recordHistory({ ...c, thumbSrc: makeThumb(c.normalized.buffer, c.normalized.w, c.normalized.h) })
    if (project.id) persistAiHistory(project.id)
    toast({ title: 'Imported as new layer', description: 'Edit freely, undo, or delete the layer to discard.' })
  }

  const acceptAsFrame = (c: AiCandidate) => {
    if (!c.normalized) return
    const st = useEditor.getState()
    const clip = getActiveClip(st)
    const insertAt = Math.min(st.activeFrameIndex, clip.frames.length - 1) + 1
    const name = `AI: ${c.prompt.slice(0, 24)}`
    const ref = importCandidateAsFrame(new Uint8ClampedArray(c.normalized.buffer), name)
    if (!ref) return
    registerAcceptedTarget(c.id, ref)
    aiCandidateStore.getState().patch(c.id, { status: 'accepted' })
    aiCandidateStore.getState().recordHistory({ ...c, thumbSrc: makeThumb(c.normalized.buffer, c.normalized.w, c.normalized.h) })
    if (project.id) persistAiHistory(project.id)
    toast({ title: 'Imported as new frame', description: `Inserted at position ${insertAt + 1}.` })
  }

  const discard = (id: string) => {
    aiCandidateStore.getState().patch(id, { status: 'rejected' })
    aiCandidateStore.getState().remove(id)
    if (selectedId === id) setSelectedId(null)
  }

  const renormalize = async (c: AiCandidate) => {
    const updated = await normalizeCandidate(c.id, normalizeOpts)
    if (updated?.status === 'error') {
      toast({ title: 'Normalization failed', description: updated.error ?? undefined, variant: 'destructive' })
    } else {
      toast({ title: 'Re-normalized with current settings' })
    }
  }

  const restoreRecipe = (entry: (typeof history)[number]) => {
    setPrompt(entry.prompt)
    setRecipeId(entry.recipe)
    setSize({ w: entry.width, h: entry.height })
    toast({ title: 'Recipe restored', description: 'Press Generate to re-run this recipe.' })
  }

  const busyCandidate = candidates.some((c) => c.status === 'normalizing')

  return (
    <TooltipProvider delayDuration={200}>
      {/* overflow-x-hidden: rows below shrink/wrap — never poke outside the dock */}
      <div className="mx-auto flex h-full w-full max-w-[520px] flex-col gap-3 overflow-x-hidden overflow-y-auto pixelforge-scroll p-3">
        {/* ------------------------------------------------ prompt + recipe */}
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-zinc-400">
            <Sparkles className="h-3.5 w-3.5 text-teal-400" /> Text → sprite
          </div>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={`Describe a sprite for the ${size.w}×${size.h} canvas…`}
            className="min-h-[64px] resize-none border-zinc-800 bg-zinc-900 font-mono text-xs"
            aria-label="Sprite description"
          />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setPrompt(s)}
                className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-teal-500/50 hover:text-teal-300"
              >
                {s.split(',')[0]}
              </button>
            ))}
          </div>

          {/* recipe presets */}
          <div className="mt-2 grid grid-cols-2 gap-1">
            {RECIPE_PRESETS.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRecipeId(r.id)}
                title={r.description}
                aria-pressed={recipeId === r.id}
                className={`rounded-md border px-2 py-1 text-left font-mono text-[10px] ${
                  recipeId === r.id ? 'border-teal-500/60 bg-teal-900/30 text-teal-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* size presets */}
          <div className="mt-2 flex items-center gap-1.5">
            <span className="w-14 shrink-0 font-mono text-[10px] text-zinc-400">SIZE</span>
            <Select
              value={`${size.w}x${size.h}`}
              onValueChange={(v) => {
                const [w, h] = v.split('x').map((n) => parseInt(n, 10))
                if (w && h) setSize({ w, h })
              }}
            >
              <SelectTrigger className="h-7 min-w-0 flex-1 border-zinc-800 bg-zinc-900 font-mono text-[11px]" aria-label="Sprite size">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIZE_PRESETS.map((p) => (
                  <SelectItem key={p.label} value={`${p.w}x${p.h}`} className="font-mono text-[11px]">
                    {p.label}
                  </SelectItem>
                ))}
                {!SIZE_PRESETS.some((p) => p.w === project.width && p.h === project.height) && (
                  <SelectItem value={`${project.width}x${project.height}`} className="font-mono text-[11px]">
                    canvas {project.width}×{project.height}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 font-mono text-[10px] text-zinc-400"
                  onClick={() => setSize({ w: project.width, h: project.height })}
                >
                  canvas
                </Button>
              </TooltipTrigger>
              <TooltipContent>Use the canvas size</TooltipContent>
            </Tooltip>
          </div>

          {/* count + seed */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="w-14 shrink-0 font-mono text-[10px] text-zinc-400">CANDIDATES</span>
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setCount(n)}
                aria-pressed={count === n}
                className={`h-6 w-6 rounded border font-mono text-[10px] ${
                  count === n ? 'border-teal-500/60 bg-teal-900/30 text-teal-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400'
                }`}
              >
                {n}
              </button>
            ))}
            <label className="ml-auto flex items-center gap-1 font-mono text-[10px] text-zinc-400">
              seed
              <Switch checked={seedOn} onCheckedChange={setSeedOn} aria-label="Use seed" className="scale-90" />
            </label>
            {seedOn && (
              <input
                value={seed}
                onChange={(e) => setSeed(Math.max(1, Math.min(999999, parseInt(e.target.value, 10) || 1)))}
                inputMode="numeric"
                aria-label="Seed value"
                className="h-6 w-14 rounded border border-zinc-800 bg-zinc-900 px-1 font-mono text-[10px] text-zinc-200"
              />
            )}
          </div>

          <Button
            onClick={generate}
            disabled={busy || !prompt.trim()}
            className="mt-2 h-8 w-full bg-teal-600 font-mono text-xs text-white hover:bg-teal-500"
          >
            {busy || busyCandidate ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Generating…
              </>
            ) : (
              <>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Generate sprite
              </>
            )}
          </Button>
          {(busy || busyCandidate) && (
            <Button variant="outline" className="mt-1 h-7 w-full border-zinc-800 font-mono text-[10px] text-zinc-400" onClick={() => { cancelGeneration(); setBusy(false) }}>
              <Ban className="mr-1 h-3 w-3" /> Cancel
            </Button>
          )}
          <p className="mt-1 text-center font-mono text-[9px] leading-relaxed text-zinc-400">
            engine: {effectiveProvider ? effectiveProvider.label : 'Z.AI built-in'} · {requestSizeFor(size.w, size.h)} request
            <br />
            {fmtCost(preflightEstimate)}
            {usageSpend !== null && aiMonthlyLimitUsd > 0 ? ` · month ≈ $${usageSpend.toFixed(2)} / $${aiMonthlyLimitUsd.toFixed(2)}` : ''}
            {secureMode ? '' : ' · change in Settings → AI & MCP'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="h-px flex-1 bg-zinc-800" />
          <span className="font-mono text-[10px] text-zinc-400">OR IMPORT</span>
          <div className="h-px flex-1 bg-zinc-800" />
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void importFile(f)
            e.target.value = ''
          }}
        />
        <Button variant="outline" className="h-8 border-zinc-800 font-mono text-xs text-zinc-300" onClick={() => fileRef.current?.click()}>
          <Upload className="mr-1.5 h-3.5 w-3.5" /> Import image file
        </Button>

        {/* ------------------------------------------------ normalize pipeline */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-400">Normalize v2 pipeline</div>
          <div className="space-y-2 text-xs">
            <label className="flex items-center justify-between gap-2">
              <span className="text-zinc-300">Remove background</span>
              <Switch checked={removeBg} onCheckedChange={setRemoveBg} aria-label="Remove background" />
            </label>
            {removeBg && (
              <div className="flex items-center gap-2">
                <span className="w-16 font-mono text-[10px] text-zinc-400">TOLERANCE</span>
                <Slider value={[bgTolerance]} min={4} max={128} step={4} onValueChange={(v) => setBgTolerance(v[0] ?? 48)} aria-label="Background tolerance" />
                <span className="w-7 text-right font-mono text-[10px] text-zinc-400">{bgTolerance}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 font-mono text-[10px] text-zinc-400">PALETTE</span>
              <Select value={paletteMode} onValueChange={(v) => setPaletteMode(v as PaletteMode)}>
                <SelectTrigger className="h-7 min-w-0 flex-1 border-zinc-800 bg-zinc-900 font-mono text-[11px]" aria-label="Palette mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto" className="font-mono text-[11px]">auto · median cut ≤{maxColors}</SelectItem>
                  <SelectItem value="project" className="font-mono text-[11px]">project palette ({project.palette.length})</SelectItem>
                  <SelectItem value="off" className="font-mono text-[11px]">full color</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {paletteMode === 'auto' && (
              <div className="flex items-center gap-2">
                <span className="w-16 font-mono text-[10px] text-zinc-400">COLORS</span>
                <Slider value={[maxColors]} min={2} max={64} step={1} onValueChange={(v) => setMaxColors(v[0] ?? 16)} aria-label="Maximum colors" />
                <span className="w-7 text-right font-mono text-[10px] text-zinc-400">{maxColors}</span>
              </div>
            )}
            <label className="flex items-center justify-between gap-2">
              <span className="text-zinc-300">Outline cleanup</span>
              <Switch checked={outlineCleanup} onCheckedChange={setOutlineCleanup} aria-label="Outline fringe cleanup" />
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-full font-mono text-[10px] text-zinc-400"
              onClick={() => selected && void renormalize(selected)}
              disabled={!selected || !selected.originalSrc}
            >
              <RefreshCw className="mr-1 h-3 w-3" /> Re-run on selected
            </Button>
          </div>
        </div>

        {/* ------------------------------------------------ candidates */}
        {candidates.length > 0 && (
          <div>
            <div className="mb-1.5 font-mono text-xs uppercase tracking-wider text-zinc-400">Candidates ({candidates.length})</div>
            {/* py-2 keeps the corner discard badges inside the scroll clip */}
            <div className="pixelforge-scroll flex gap-2 overflow-x-auto py-2">
              {candidates.map((c) => (
                <div key={c.id} className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    className={`block h-16 w-16 overflow-hidden rounded-md border ${
                      c.id === selected?.id ? 'border-teal-400 ring-1 ring-teal-400/60' : 'border-zinc-700'
                    }`}
                    aria-label={`Candidate from ${c.createdAt}`}
                    aria-pressed={c.id === selected?.id}
                  >
                    {c.normalized ? (
                      <img src={makeThumb(c.normalized.buffer, c.normalized.w, c.normalized.h)} alt="Normalized candidate" className="pixelforge-checker h-full w-full object-contain" />
                    ) : c.originalSrc ? (
                      <img src={c.originalSrc} alt="Original candidate" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-[9px] text-zinc-400">…</span>
                    )}
                  </button>
                  {c.status === 'normalizing' && <span className="absolute left-1 top-1"><Loader2 className="h-3 w-3 animate-spin text-teal-300" /></span>}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => discard(c.id)}
                        className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-zinc-200 shadow-md before:absolute before:-inset-1.5 before:rounded-full before:content-[''] hover:border-red-400/60 hover:bg-red-500/20 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 touch-manipulation"
                        aria-label="Discard candidate"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Discard candidate</TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ------------------------------------------------ review card */}
        {selected && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">Review</span>
              <label className="flex items-center gap-1 font-mono text-[10px] text-zinc-400">
                compare
                <Switch checked={compare} onCheckedChange={setCompare} aria-label="Compare original and normalized" className="scale-90" />
              </label>
            </div>
            <div className="flex items-stretch gap-2">
              <figure className="min-w-0 flex-1">
                <div className="pixelforge-checker h-20 overflow-hidden rounded-md border border-zinc-700">
                  {selected.originalSrc ? (
                    <img src={selected.originalSrc} alt="Original generated image" className="h-full w-full object-contain" />
                  ) : (
                    <span className="flex h-full items-center justify-center font-mono text-[9px] text-zinc-400">no image</span>
                  )}
                </div>
                <figcaption className="mt-0.5 text-center font-mono text-[9px] text-zinc-400">original{selected.originalW ? ` ${selected.originalW}×${selected.originalH}` : ''}</figcaption>
              </figure>
              {compare && (
                <figure className="min-w-0 flex-1">
                  <div className="pixelforge-checker h-20 overflow-hidden rounded-md border border-teal-700/60">
                    {selected.normalized ? (
                      <img src={makeThumb(selected.normalized.buffer, selected.normalized.w, selected.normalized.h)} alt="Normalized pixel art" className="h-full w-full object-contain [image-rendering:pixelated]" />
                    ) : (
                      <span className="flex h-full items-center justify-center font-mono text-[9px] text-zinc-400">normalizing…</span>
                    )}
                  </div>
                  <figcaption className="mt-0.5 text-center font-mono text-[9px] text-teal-300/80">
                    v2 · {size.w}×{size.h}
                    {selected.normalized ? ` · ${selected.normalized.colors} colors` : ''}
                  </figcaption>
                </figure>
              )}
            </div>
            {/* provenance (plan §3.4) */}
            <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-zinc-400">
              {selected.providerLabel} · {selected.model} · {selected.recipe} · {selected.requestSize}
              {selected.seed !== null ? ` · seed ${selected.seed}` : ''}
              {selected.cacheHit ? ' · cache hit ($0)' : ''}
              {selected.jobDurationMs !== null ? ` · ${(selected.jobDurationMs / 1000).toFixed(1)}s` : ''}
              <br />
              {fmtCost(selected.costEstimateUsd)} · {new Date(selected.createdAt).toLocaleTimeString()}
            </p>
            {selected.error && <p className="mt-1 font-mono text-[9px] leading-relaxed text-red-400">{selected.error}</p>}
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    className="h-8 bg-teal-600 font-mono text-xs text-white hover:bg-teal-500"
                    onClick={() => acceptAsLayer(selected)}
                    disabled={!selected.normalized || selected.status === 'accepted'}
                  >
                    <Layers className="mr-1 h-3.5 w-3.5" /> As layer
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {selected.status === 'accepted'
                    ? 'Already imported — undo (Ctrl+Z) or delete the layer to import again'
                    : 'New top layer in current frame (undoable)'}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    className="h-8 border-teal-700/60 font-mono text-xs text-teal-300 hover:bg-teal-900/30"
                    onClick={() => acceptAsFrame(selected)}
                    disabled={!selected.normalized || selected.status === 'accepted'}
                  >
                    <Film className="mr-1 h-3.5 w-3.5" /> As frame
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {selected.status === 'accepted'
                    ? 'Already imported — undo (Ctrl+Z) or delete the frame to import again'
                    : 'New frame in current clip (undoable)'}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}

        {/* ------------------------------------------------ history */}
        {history.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-zinc-400">
              <History className="h-3.5 w-3.5" /> History ({history.length})
            </div>
            <div className="pixelforge-scroll max-h-40 space-y-1 overflow-y-auto pr-1">
              {history.map((h) => (
                <div key={h.id} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-1.5">
                  {h.thumbSrc ? (
                    <img src={h.thumbSrc} alt="Generation history thumbnail" className="pixelforge-checker h-8 w-8 rounded border border-zinc-800 object-contain [image-rendering:pixelated]" />
                  ) : (
                    <span className="h-8 w-8 rounded border border-zinc-800" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[10px] text-zinc-300">{h.prompt.slice(0, 48)}</p>
                    <p className="font-mono text-[9px] text-zinc-400">
                      {h.providerLabel} · {h.width}×{h.height} · {new Date(h.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 shrink-0 px-1.5 font-mono text-[9px] text-zinc-400" onClick={() => restoreRecipe(h)}>
                        <RotateCcw className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Restore this recipe into the form</TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
          </div>
        )}

        {candidates.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 p-6 text-center">
            <ImagePlus className="h-6 w-6 text-zinc-400" />
            <p className="max-w-[220px] font-mono text-[10px] leading-relaxed text-zinc-400">
              Candidates appear here. Imports are always added as new editable layers or frames — your existing art is
              never overwritten.
            </p>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}

// dev/smoke probe: the Electron AI smoke drives the REAL pipeline —
// submitGeneration → bridge → main job runner → events → candidate store →
// CommandBus import/undo — without touching React internals
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__pfAi = {
    store: aiCandidateStore,
    submit: submitGeneration,
    normalize: normalizeCandidate,
    cancel: cancelGeneration,
    importAsLayer: (buffer: Uint8ClampedArray, name: string) => useEditor.getState().importCandidateAsLayer(buffer, name),
    importAsFrame: (buffer: Uint8ClampedArray, name: string) => useEditor.getState().importCandidateAsFrame(buffer, name),
    undo: () => useEditor.getState().undo(),
    snapshot: () => {
      const p = useEditor.getState().project
      return {
        clips: p.clips.length,
        layers: p.clips.reduce((n, c) => n + c.layers.length, 0),
        frames: p.clips.reduce((n, c) => n + c.frames.length, 0),
        topLayerName: p.clips[0]?.layers.at(-1)?.name ?? null,
      }
    },
  }
}
