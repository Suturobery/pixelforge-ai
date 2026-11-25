// PixelForge AI — VFX Studio panel (built-in pixelfx procedural VFX engine).
//
// Browse all 244 deterministic procedural effects, live-preview them composited
// directly behind & in front of the active sprite (zero document mutation), and
// apply them in one undoable CommandBus transaction as either depth-wrapped
// Back + Front layers on the current clip OR a standalone VFX clip.

'use client'

import { composeFrameRgba } from '@pixelforge/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getActiveClip, useEditor } from '@/lib/pixelforge/store'
import {
  alphaOverRgba,
  generateVfx,
  listVfx,
  previewVfxFrames,
  type VfxDepthMode,
  type VfxEffectInfo,
  type VfxRenderedSequence,
  type VfxTarget,
} from '@/lib/pixelforge/vfx'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { useToast } from '@/hooks/use-toast'
import { friendlyError } from '@/lib/utils'
import { Dices, Flame, Layers, Pause, Play, RefreshCw, Search, Sparkles } from 'lucide-react'

const POPULAR_CATEGORIES = ['all', 'arcane', 'fire', 'lightning', 'ice', 'holy', 'impacts', 'melee', 'shadow', 'water', 'nature', 'pickups', 'weather', 'explosions'] as const

const DEFAULT_EFFECT_ID = 'arcane/rune-circle'

export function VfxPanel() {
  const project = useEditor((s) => s.project)
  const activeClipId = useEditor((s) => s.activeClipId)
  const rightTab = useEditor((s) => s.rightTab)
  const docVersion = useEditor((s) => s.docVersion)
  const { toast } = useToast()

  const clip = getActiveClip({ project, activeClipId })

  // --- catalog state ---------------------------------------------------------
  const [catalog, setCatalog] = useState<VfxEffectInfo[]>([])
  const [category, setCategory] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_EFFECT_ID)

  // --- render options --------------------------------------------------------
  const [target, setTarget] = useState<VfxTarget>('current_clip')
  const [depth, setDepth] = useState<VfxDepthMode>('split')
  const [useProjectPalette, setUseProjectPalette] = useState(true)
  const [crispPixelArt, setCrispPixelArt] = useState(true)
  const [autoWarmup, setAutoWarmup] = useState(true)
  const [fitMode, setFitMode] = useState<'fit' | 'crop'>('fit')
  const [light, setLight] = useState(0.72)
  const [alphaThreshold, setAlphaThreshold] = useState(96)
  const [seed, setSeed] = useState(7)
  const [customFrames, setCustomFrames] = useState<string>('')
  const [applying, setApplying] = useState(false)

  // --- live preview state ----------------------------------------------------
  const [sequence, setSequence] = useState<VfxRenderedSequence | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [frameIdx, setFrameIdx] = useState(0)
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null)

  // Load 244 built-in pixelfx effects once
  useEffect(() => {
    let cancelled = false
    void listVfx().then((list) => {
      if (cancelled) return
      setCatalog(list)
      if (!list.some((e) => e.id === DEFAULT_EFFECT_ID) && list[0]) {
        setSelectedId(list[0].id)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const e of catalog) set.add(e.category)
    const ordered: string[] = ['all']
    for (const c of POPULAR_CATEGORIES) {
      if (c !== 'all' && set.has(c)) ordered.push(c)
    }
    for (const c of [...set].sort()) {
      if (!ordered.includes(c)) ordered.push(c)
    }
    return ordered
  }, [catalog])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return catalog.filter((e) => {
      if (category !== 'all' && e.category !== category) return false
      if (!q) return true
      return (
        e.id.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q))
      )
    })
  }, [catalog, category, query])

  const selectedInfo = useMemo(
    () => catalog.find((e) => e.id === selectedId) ?? null,
    [catalog, selectedId],
  )

  const parsedFrames = useMemo(() => {
    const n = Number.parseInt(customFrames, 10)
    if (Number.isFinite(n) && n >= 1 && n <= 64) return n
    if (target === 'current_clip') {
      return clip.frames.length > 1 ? clip.frames.length : 12
    }
    return undefined
  }, [customFrames, target, clip.frames.length])

  const effectiveFps = target === 'current_clip' ? clip.fps : 12

  // Render pure preview frames whenever the panel is active and options change
  useEffect(() => {
    if (rightTab !== 'vfx') return
    if (!selectedId) return
    let cancelled = false
    const timer = setTimeout(() => {
      setRendering(true)
      setPreviewError(null)
      void previewVfxFrames(
        {
          effect: selectedId,
          seed,
          frames: parsedFrames,
          fps: effectiveFps,
          palette: useProjectPalette ? 'project' : undefined,
          fit: fitMode,
          light,
          crispPixelArt,
          alphaThreshold,
          warmup: autoWarmup ? 'auto' : 0,
        },
        project.width,
        project.height,
        project.palette,
        useProjectPalette,
      )
        .then((seq) => {
          if (cancelled) return
          setSequence(seq)
          setFrameIdx((idx) => (seq.combinedFrames.length > 0 ? idx % seq.combinedFrames.length : 0))
        })
        .catch((err) => {
          if (cancelled) return
          setPreviewError(friendlyError(err))
          setSequence(null)
        })
        .finally(() => {
          if (!cancelled) setRendering(false)
        })
    }, 80)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    rightTab,
    selectedId,
    seed,
    parsedFrames,
    effectiveFps,
    useProjectPalette,
    fitMode,
    light,
    crispPixelArt,
    alphaThreshold,
    autoWarmup,
    project.width,
    project.height,
    project.palette,
  ])

  // Playback tick for the live VFX preview canvas
  useEffect(() => {
    if (rightTab !== 'vfx' || !playing || !sequence || sequence.combinedFrames.length <= 1) return
    const ms = Math.max(33, Math.round(1000 / Math.max(1, sequence.fps)))
    const t = setInterval(() => {
      setFrameIdx((i) => (i + 1) % sequence.combinedFrames.length)
    }, ms)
    return () => clearInterval(t)
  }, [rightTab, playing, sequence])

  // Draw live composited preview:
  // When target === 'current_clip', composite the real sprite frame sandwiched
  // between Back VFX and Front VFX so what you see is byte-identical to Apply!
  useEffect(() => {
    if (rightTab !== 'vfx') return
    const canvas = previewCanvasRef.current
    if (!canvas || !sequence || sequence.combinedFrames.length === 0) return
    const w = project.width
    const h = project.height
    const expectedBytes = w * h * 4
    const idx = frameIdx % sequence.combinedFrames.length
    const comb = sequence.combinedFrames[idx]
    const back = sequence.backFrames[idx]
    const front = sequence.frontFrames[idx]
    // Guard against stale sequence frames right after a canvas resize / New Project
    // while the debounced preview re-render is still in flight.
    if (!comb || !back || !front || comb.length !== expectedBytes) return

    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let display: Uint8ClampedArray

    if (target === 'current_clip' && clip.frames.length > 0) {
      const spriteFrame = clip.frames[idx % clip.frames.length]!
      const spriteRgba = composeFrameRgba(project, clip, spriteFrame)
      if (spriteRgba.length !== expectedBytes) return
      if (depth === 'split') {
        const withBack = alphaOverRgba(back, spriteRgba)
        display = alphaOverRgba(withBack, front)
      } else if (depth === 'back') {
        display = alphaOverRgba(comb, spriteRgba)
      } else {
        display = alphaOverRgba(spriteRgba, comb)
      }
    } else {
      display = comb
    }

    if (display.length !== expectedBytes) return
    ctx.clearRect(0, 0, w, h)
    ctx.putImageData(new ImageData(new Uint8ClampedArray(display), w, h), 0, 0)
  }, [rightTab, sequence, frameIdx, target, depth, project, clip, docVersion])

  const handleApply = async () => {
    if (!selectedId || applying) return
    setApplying(true)
    try {
      const res = await generateVfx({
        effect: selectedId,
        seed,
        frames: parsedFrames,
        fps: effectiveFps,
        palette: useProjectPalette ? 'project' : undefined,
        fit: fitMode,
        light,
        crispPixelArt,
        alphaThreshold,
        warmup: autoWarmup ? 'auto' : 0,
        target,
        clipId: target === 'current_clip' ? clip.id : undefined,
        depth,
        origin: 'ui',
      })
      if (!res.ok) {
        toast({
          title: 'VFX failed',
          description: res.error?.message ?? 'Could not apply VFX.',
          variant: 'destructive',
        })
        return
      }
      const layerCount = res.createdLayerIds?.length ?? 1
      toast({
        title: target === 'current_clip' ? `Applied ${res.resolvedEffect}` : `Created VFX clip "${res.clipName}"`,
        description:
          target === 'current_clip'
            ? `Added ${layerCount} ${depth === 'split' ? 'Back + Front ' : ''}layer(s) to "${res.clipName}" (${res.frames}f @ ${res.fps}fps). Ctrl+Z to undo.`
            : `${res.frames}f @ ${res.fps}fps (${res.crispPixelArt ? 'crisp pixel art' : 'soft glow'}). Ctrl+Z to undo.`,
      })
    } catch (err) {
      toast({ title: 'VFX failed', description: friendlyError(err), variant: 'destructive' })
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950/60 text-zinc-100">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800/80 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Flame className="h-3.5 w-3.5 text-teal-400" aria-hidden />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
            VFX Studio
          </span>
        </div>
        <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
          {catalog.length || 244} pixelfx
        </span>
      </div>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
        {/* Live composited preview card */}
        <div className="rounded-lg border border-zinc-800/90 bg-zinc-900/70 p-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-zinc-100">
                {selectedInfo?.name ?? selectedId}
              </div>
              <div className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-400">
                <span className="truncate">{selectedId}</span>
                {selectedInfo && (
                  <span className={selectedInfo.loop ? 'text-teal-400' : 'text-amber-400'}>
                    {selectedInfo.loop ? '• loop' : '• one-shot'}
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                onClick={() => setPlaying((p) => !p)}
                title={playing ? 'Pause preview' : 'Play preview'}
                aria-label={playing ? 'Pause VFX preview' : 'Play VFX preview'}
              >
                {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                onClick={() => setSeed((s) => (s * 31 + 17) % 9999 + 1)}
                title="Randomize seed"
                aria-label="Randomize VFX seed"
              >
                <Dices className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div
            className="relative flex aspect-square w-full max-h-[176px] items-center justify-center overflow-hidden rounded-md border border-zinc-800"
            style={{
              backgroundImage:
                'linear-gradient(45deg, #1b1f27 25%, transparent 25%), linear-gradient(-45deg, #1b1f27 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1b1f27 75%), linear-gradient(-45deg, transparent 75%, #1b1f27 75%)',
              backgroundSize: '12px 12px',
              backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px',
              backgroundColor: '#13161c',
            }}
          >
            <canvas
              ref={previewCanvasRef}
              className="h-full w-full object-contain"
              style={{ imageRendering: 'pixelated' }}
              aria-label="Live VFX preview"
            />
            {rendering && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-zinc-950/40">
                <RefreshCw className="h-4 w-4 animate-spin text-teal-400" />
              </div>
            )}
            {previewError && (
              <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/80 p-2 text-center text-[11px] text-rose-400">
                {previewError}
              </div>
            )}
            {sequence && (
              <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-zinc-950/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                {frameIdx + 1}/{sequence.combinedFrames.length} · {sequence.fps}fps
              </span>
            )}
            <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-zinc-950/80 px-1.5 py-0.5 font-mono text-[10px] text-teal-300">
              {target === 'current_clip' ? `on "${clip.name}"` : 'standalone'}
            </span>
          </div>
        </div>

        {/* Target + Depth */}
        <div className="space-y-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-2.5">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-zinc-400">Apply Target</Label>
            <div className="grid grid-cols-2 gap-1 rounded-md bg-zinc-900 p-0.5">
              <button
                type="button"
                onClick={() => setTarget('current_clip')}
                className={`rounded px-2 py-1 text-[11px] font-medium transition ${
                  target === 'current_clip'
                    ? 'bg-teal-500/20 text-teal-300 ring-1 ring-teal-500/40'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Current Clip
              </button>
              <button
                type="button"
                onClick={() => setTarget('new_clip')}
                className={`rounded px-2 py-1 text-[11px] font-medium transition ${
                  target === 'new_clip'
                    ? 'bg-teal-500/20 text-teal-300 ring-1 ring-teal-500/40'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                New Clip
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-zinc-400">Depth Layering</Label>
            <div className="grid grid-cols-3 gap-1 rounded-md bg-zinc-900 p-0.5">
              {([
                ['split', 'Split B+F'],
                ['front', 'In Front'],
                ['back', 'Behind'],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setDepth(mode)}
                  className={`rounded px-1.5 py-1 text-[11px] font-medium transition ${
                    depth === mode
                      ? 'bg-zinc-800 text-teal-300 ring-1 ring-white/10'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Effect Catalog Browser */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search effects (rune, fire, slash, aura)..."
              aria-label="Search VFX effects"
              className="h-7 border-zinc-800 bg-zinc-900/70 pl-7 text-xs text-zinc-100 placeholder:text-zinc-500"
            />
          </div>

          {/* Category filter pills */}
          <div className="flex flex-wrap gap-1">
            {categories.slice(0, 12).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium capitalize transition ${
                  category === cat
                    ? 'bg-teal-500/20 text-teal-300 ring-1 ring-teal-500/40'
                    : 'bg-zinc-900/80 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Effect list */}
          <div
            role="listbox"
            aria-label="VFX effects catalog"
            className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-zinc-800/80 bg-zinc-900/50 p-1"
          >
            {filtered.length === 0 ? (
              <div className="py-4 text-center text-[11px] text-zinc-500">No matching effects</div>
            ) : (
              filtered.map((fx) => {
                const active = fx.id === selectedId
                return (
                  <button
                    key={fx.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => setSelectedId(fx.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] transition ${
                      active
                        ? 'bg-teal-500/15 text-teal-200 ring-1 ring-teal-500/40'
                        : 'text-zinc-300 hover:bg-zinc-800/70'
                    }`}
                  >
                    <span className="min-w-0 truncate font-medium">{fx.name}</span>
                    <span className="shrink-0 font-mono text-[9px] text-zinc-500">
                      {fx.category}
                      {fx.loop ? ' · ↻' : ''}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* Quality & Tuning Controls */}
        <div className="space-y-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="vfx-palette-lock" className="text-[11px] text-zinc-300">
              Match project palette
            </Label>
            <Switch
              id="vfx-palette-lock"
              checked={useProjectPalette}
              onCheckedChange={setUseProjectPalette}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="vfx-crisp-pixel" className="text-[11px] text-zinc-300">
              Crisp pixel art (no blur)
            </Label>
            <Switch
              id="vfx-crisp-pixel"
              checked={crispPixelArt}
              onCheckedChange={setCrispPixelArt}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="vfx-warmup" className="text-[11px] text-zinc-300">
              Auto-warmup looping FX
            </Label>
            <Switch
              id="vfx-warmup"
              checked={autoWarmup}
              onCheckedChange={setAutoWarmup}
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-zinc-400">Glow intensity</span>
              <span className="font-mono text-zinc-300">{Math.round(light * 100)}%</span>
            </div>
            <Slider
              value={[light]}
              min={0.1}
              max={1}
              step={0.05}
              onValueChange={([v]) => setLight(v ?? 0.72)}
            />
          </div>

          {crispPixelArt && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-zinc-400">Alpha cutoff</span>
                <span className="font-mono text-zinc-300">{alphaThreshold}</span>
              </div>
              <Slider
                value={[alphaThreshold]}
                min={24}
                max={200}
                step={8}
                onValueChange={([v]) => setAlphaThreshold(v ?? 96)}
              />
            </div>
          )}

          <div className="grid grid-cols-3 gap-1.5 pt-0.5">
            <div>
              <Label htmlFor="vfx-seed" className="text-[10px] text-zinc-400">
                Seed
              </Label>
              <Input
                id="vfx-seed"
                type="number"
                min={0}
                max={999999}
                value={seed}
                onChange={(e) => setSeed(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
                className="mt-0.5 h-7 border-zinc-800 bg-zinc-900 px-2 font-mono text-xs"
              />
            </div>
            <div>
              <Label htmlFor="vfx-frames" className="text-[10px] text-zinc-400">
                Frames
              </Label>
              <Input
                id="vfx-frames"
                type="number"
                min={1}
                max={64}
                placeholder={String(parsedFrames ?? 'auto')}
                value={customFrames}
                onChange={(e) => setCustomFrames(e.target.value)}
                className="mt-0.5 h-7 border-zinc-800 bg-zinc-900 px-2 font-mono text-xs"
              />
            </div>
            <div>
              <Label className="text-[10px] text-zinc-400">Framing</Label>
              <button
                type="button"
                onClick={() => setFitMode((f) => (f === 'fit' ? 'crop' : 'fit'))}
                className="mt-0.5 flex h-7 w-full items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-[11px] font-medium capitalize text-zinc-200 hover:bg-zinc-800"
              >
                {fitMode}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Sticky Apply CTA */}
      <div className="shrink-0 border-t border-zinc-800/80 bg-zinc-950/90 p-2.5">
        <Button
          type="button"
          onClick={() => void handleApply()}
          disabled={applying || !selectedId}
          className="h-8 w-full gap-1.5 bg-teal-500 text-xs font-semibold text-zinc-950 hover:bg-teal-400"
        >
          {target === 'current_clip' ? (
            <>
              <Layers className="h-3.5 w-3.5" />
              {applying
                ? 'Applying VFX...'
                : `Apply to "${clip.name}" (${depth === 'split' ? 'Back + Front' : depth})`}
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              {applying ? 'Creating VFX Clip...' : 'Create New VFX Clip'}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
