// PixelForge AI — Phase 3: Clips Contact Sheet
//
// Displays every clip in the project side-by-side at an identical pixel scale
// with synchronized live playback, shared ground-line baseline, trimmed height
// & ground-margin drift badges, per-clip palette swatches, and 1-click PNG export.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  buildPlaybackCycle,
  composeClipsContactSheet,
  encodePng,
  frameAtPosition,
  measureClipContactMetrics,
  type Clip,
  type Project,
} from '@pixelforge/core'
import { useEditor } from '@/lib/pixelforge/store'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import {
  Play,
  Pause,
  Download,
  Ruler,
  SquareDashed,
  AlertTriangle,
  CheckCircle2,
  LayoutGrid,
} from 'lucide-react'

type SheetBg = 'checker' | 'dark' | 'light'

function ClipSheetCard({
  project,
  clip,
  frameIndex,
  scale,
  bg,
  showGroundLine,
  showBounds,
  refBottomMargin,
  refHeight,
  isActive,
  renderTick,
  onSelect,
}: {
  project: Project
  clip: Clip
  frameIndex: number
  scale: number
  bg: SheetBg
  showGroundLine: boolean
  showBounds: boolean
  refBottomMargin: number | null
  refHeight: number | null
  isActive: boolean
  renderTick: number
  onSelect: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const w = project.width
  const h = project.height

  const { metrics, buffer } = useMemo(() => {
    void renderTick
    return measureClipContactMetrics(project, clip, frameIndex)
  }, [project, clip, frameIndex, renderTick])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    cv.width = w
    cv.height = h
    ctx.clearRect(0, 0, w, h)
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), w, h), 0, 0)
  }, [buffer, w, h])

  const heightDelta =
    refHeight !== null && metrics.bounds !== null ? metrics.spriteHeight - refHeight : null
  const groundDelta =
    refBottomMargin !== null && metrics.bounds !== null
      ? metrics.bottomMargin - refBottomMargin
      : null
  const hasGroundDrift = groundDelta !== null && Math.abs(groundDelta) >= 2
  const hasPaletteIssue = metrics.outOfPaletteColors > 0

  const stageClass =
    bg === 'checker'
      ? 'pixelforge-checker'
      : bg === 'light'
        ? 'bg-zinc-200'
        : 'bg-zinc-950'

  const displayW = w * scale
  const displayH = h * scale

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group flex flex-col overflow-hidden rounded-lg border text-left transition ${
        isActive
          ? 'border-teal-400/80 bg-zinc-900/90 ring-1 ring-teal-400/40'
          : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-600'
      }`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 px-2.5 py-1.5">
        <div className="min-w-0">
          <div className="truncate font-mono text-[11px] font-semibold text-zinc-100">
            {clip.name}
          </div>
          <div className="font-mono text-[9px] text-zinc-500">
            f{metrics.frameIndex + 1}/{clip.frames.length} · {clip.fps}fps
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasPaletteIssue ? (
            <span
              title={`${metrics.outOfPaletteColors} color(s) outside active palette`}
              className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] text-amber-300"
            >
              <AlertTriangle className="h-2.5 w-2.5" />+{metrics.outOfPaletteColors}
            </span>
          ) : (
            <span
              title="100% locked to project palette"
              className="inline-flex items-center rounded bg-emerald-500/10 p-0.5 text-emerald-400"
            >
              <CheckCircle2 className="h-3 w-3" />
            </span>
          )}
        </div>
      </div>

      {/* Scaled Pixel Viewport */}
      <div className={`relative flex min-h-[120px] flex-1 items-center justify-center p-3 ${stageClass}`}>
        <div
          className="relative shrink-0"
          style={{ width: displayW, height: displayH }}
        >
          <canvas
            ref={canvasRef}
            width={w}
            height={h}
            style={{ width: displayW, height: displayH, imageRendering: 'pixelated' }}
            className="block"
          />
          {/* Shared reference ground-line baseline */}
          {showGroundLine && refBottomMargin !== null && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-[-8px] border-t border-dashed border-teal-400/80"
              style={{ top: `${((h - refBottomMargin) / h) * 100}%` }}
            />
          )}
          {/* Trimmed sprite bounding box */}
          {showBounds && metrics.bounds && (
            <div
              aria-hidden
              className="pointer-events-none absolute border border-amber-400/80"
              style={{
                left: `${(metrics.bounds.x / w) * 100}%`,
                top: `${(metrics.bounds.y / h) * 100}%`,
                width: `${(metrics.bounds.w / w) * 100}%`,
                height: `${(metrics.bounds.h / h) * 100}%`,
              }}
            />
          )}
        </div>
      </div>

      {/* Proportions + Palette Swatches Footer */}
      <div className="space-y-1.5 border-t border-zinc-800/80 bg-zinc-950/70 px-2.5 py-2">
        <div className="flex flex-wrap items-center justify-between gap-1 font-mono text-[9px]">
          <span className="text-zinc-300">
            {metrics.bounds ? `${metrics.spriteWidth}×${metrics.spriteHeight}px` : 'empty'}
            {heightDelta !== null && heightDelta !== 0 && (
              <span className="ml-1 text-zinc-500">
                ({heightDelta > 0 ? `+${heightDelta}` : heightDelta}h)
              </span>
            )}
          </span>
          <span className={hasGroundDrift ? 'text-amber-300' : 'text-zinc-400'}>
            base {metrics.bottomMargin}px
            {hasGroundDrift && groundDelta !== null
              ? ` (${groundDelta > 0 ? `+${groundDelta}` : groundDelta})`
              : ''}
          </span>
        </div>

        {/* Swatch bar for quick color consistency checks */}
        <div className="flex items-center gap-1">
          <div className="flex flex-1 flex-wrap gap-0.5">
            {metrics.topColors.length === 0 ? (
              <span className="font-mono text-[8px] text-zinc-600">no colors</span>
            ) : (
              metrics.topColors.map((hex) => (
                <span
                  key={hex}
                  title={hex}
                  className="h-2.5 w-2.5 rounded-[2px] border border-black/40"
                  style={{ backgroundColor: hex }}
                />
              ))
            )}
          </div>
          <span className="font-mono text-[8px] text-zinc-500">{metrics.uniqueColors}c</span>
        </div>
      </div>
    </button>
  )
}

export function ClipsContactSheetDialog() {
  const open = useEditor((s) => s.contactSheetOpen)
  const setOpen = useEditor((s) => s.setContactSheetOpen)
  const project = useEditor((s) => s.project)
  const activeClipId = useEditor((s) => s.activeClipId)
  const selectClip = useEditor((s) => s.selectClip)
  const renderTick = useEditor((s) => s.renderTick)
  const { toast } = useToast()

  const autoScale = Math.max(1, Math.min(6, Math.floor(120 / Math.max(project.width, project.height)) || 1))
  const [scale, setScale] = useState<number>(autoScale)
  const [bg, setBg] = useState<SheetBg>('checker')
  const [showGroundLine, setShowGroundLine] = useState(true)
  const [showBounds, setShowBounds] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [elapsedMs, setElapsedMs] = useState(0)

  // Synchronized animation clock across all clips while dialog is open
  useEffect(() => {
    if (!open || !playing) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      setElapsedMs((t) => t + dt)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [open, playing])

  const frameByClip = useMemo(() => {
    const map: Record<string, number> = {}
    for (const c of project.clips) {
      if (c.frames.length <= 1) {
        map[c.id] = 0
        continue
      }
      const cycle = buildPlaybackCycle(c)
      const total = Math.max(1, cycle.totalMs)
      map[c.id] = frameAtPosition(cycle, elapsedMs % total).frame
    }
    return map
  }, [project.clips, elapsedMs])

  // Reference ground line & sprite height (pinned Hero Style Anchor > first non-empty clip)
  const reference = (() => {
    if (!open) return { bottomMargin: null, height: null, label: '' }
    const anchor = project.settings.styleProfile?.anchor ?? null
    if (anchor) {
      return { bottomMargin: anchor.bottomMargin, height: anchor.spriteHeight, label: `Anchor: ${anchor.label}` }
    }
    for (const c of project.clips) {
      const { metrics } = measureClipContactMetrics(project, c, 0)
      if (metrics.bounds) {
        return { bottomMargin: metrics.bottomMargin, height: metrics.spriteHeight, label: `Ref: ${c.name}` }
      }
    }
    return { bottomMargin: null, height: null, label: 'No sprites yet' }
  })()

  const handleExportPng = async () => {
    try {
      const composed = composeClipsContactSheet(project, {
        scale,
        columns: Math.min(4, Math.max(1, project.clips.length)),
        showGroundLine,
        showBounds,
        frameByClip,
        background: bg,
      })
      const png = await encodePng(composed.width, composed.height, composed.buffer)
      const blob = new Blob([new Uint8Array(png)], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${project.name || 'pixelforge'}-contact-sheet.png`
      a.click()
      URL.revokeObjectURL(url)
      toast({
        title: 'Exported Clips Contact Sheet',
        description: `${project.clips.length} clips · ${composed.width}×${composed.height}px PNG downloaded.`,
      })
    } catch (err) {
      toast({ title: 'Contact sheet export failed', description: String(err), variant: 'destructive' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[86vh] max-w-4xl flex-col gap-3 border-zinc-800 bg-zinc-950 p-4 text-zinc-100">
        <DialogHeader className="shrink-0 space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
            <DialogTitle className="flex items-center gap-2 font-mono text-sm">
              <LayoutGrid className="h-4 w-4 text-teal-400" />
              Clips Contact Sheet
              <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] font-normal text-zinc-400">
                {project.clips.length} clip{project.clips.length === 1 ? '' : 's'} · {project.width}×{project.height}px
              </span>
            </DialogTitle>
            <span className="font-mono text-[10px] text-teal-300/90">
              {reference.label}
              {reference.height !== null ? ` (${reference.height}px h · ${reference.bottomMargin}px base)` : ''}
            </span>
          </div>
        </DialogHeader>

        {/* Controls Bar */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/60 px-2.5 py-1.5">
          <Button
            type="button"
            variant={playing ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setPlaying((v) => !v)}
            className={`h-7 px-2.5 font-mono text-[10px] ${
              playing ? 'bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40' : 'text-zinc-300'
            }`}
          >
            {playing ? <Pause className="mr-1.5 h-3 w-3" /> : <Play className="mr-1.5 h-3 w-3" />}
            {playing ? 'Playing' : 'Paused'}
          </Button>

          <div className="flex overflow-hidden rounded border border-zinc-800 bg-zinc-950">
            {[1, 2, 3, 4, 6].map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => setScale(z)}
                className={`px-2 py-1 font-mono text-[10px] transition ${
                  scale === z ? 'bg-teal-500/20 text-teal-300' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {z}×
              </button>
            ))}
          </div>

          <div className="flex overflow-hidden rounded border border-zinc-800 bg-zinc-950">
            {(['checker', 'dark', 'light'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setBg(mode)}
                className={`px-2 py-1 font-mono text-[10px] capitalize transition ${
                  bg === mode ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowGroundLine((v) => !v)}
            className={`h-7 px-2 font-mono text-[10px] ${
              showGroundLine ? 'bg-teal-500/15 text-teal-300' : 'text-zinc-400'
            }`}
          >
            <Ruler className="mr-1 h-3 w-3" />
            Ground Line
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowBounds((v) => !v)}
            className={`h-7 px-2 font-mono text-[10px] ${
              showBounds ? 'bg-amber-500/15 text-amber-300' : 'text-zinc-400'
            }`}
          >
            <SquareDashed className="mr-1 h-3 w-3" />
            Bounds
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleExportPng()}
            className="ml-auto h-7 border-zinc-700 bg-zinc-950 px-2.5 font-mono text-[10px] text-zinc-200 hover:border-teal-500/60"
          >
            <Download className="mr-1.5 h-3 w-3 text-teal-400" />
            Export PNG
          </Button>
        </div>

        {/* Clips Comparison Grid */}
        <div className="pixelforge-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {project.clips.map((c) => (
              <ClipSheetCard
                key={c.id}
                project={project}
                clip={c}
                frameIndex={frameByClip[c.id] ?? 0}
                scale={scale}
                bg={bg}
                showGroundLine={showGroundLine}
                showBounds={showBounds}
                refBottomMargin={reference.bottomMargin}
                refHeight={reference.height}
                isActive={c.id === activeClipId}
                renderTick={renderTick}
                onSelect={() => {
                  selectClip(c.id)
                  setOpen(false)
                }}
              />
            ))}
          </div>
        </div>

        <p className="shrink-0 font-mono text-[9px] text-zinc-500">
          Click any clip card to jump straight to it · Teal dashed line marks the shared baseline so feet &amp; proportions match across clips.
        </p>
      </DialogContent>
    </Dialog>
  )
}
