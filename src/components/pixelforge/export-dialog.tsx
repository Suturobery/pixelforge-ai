// PixelForge AI — export dialog (Task 7): scope × format × layout with a
// live pixel-true preview, deterministic naming, validation, and native
// desktop destinations.
//
// The preview and every artifact come from @pixelforge/core's export
// service — the SAME compositor the golden tests verify — so what you see
// here is byte-for-byte what gets written. No canvas-renderer involvement;
// onion skins / selection ants / guides physically cannot appear.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, getActiveClip } from '@/lib/pixelforge/store'
import {
  composeAtlasRgba,
  composeFrameRgba,
  composeSheetRgba,
  planExport,
  resolveAtlasLayout,
  slugify,
  type ExportFormat,
  type ExportScope,
  type Project,
} from '@pixelforge/core'
import { runAtlasExport, runExport, type JsonMetadataFormat } from '@/lib/pixelforge/export'
import { isDesktop } from '@/lib/pixelforge/desktop-bridge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StepperInput } from '@/components/pixelforge/stepper-input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { useToast } from '@/hooks/use-toast'
import { cn, friendlyError } from '@/lib/utils'
import { FileImage, FolderDown, ImageIcon, LayoutGrid, Loader2, Minus, Plus, Scan } from 'lucide-react'
import type { ExportOutcome, ExportScale } from '@/lib/pixelforge/export'

// ---------------------------------------------------------------------------
// tiny segmented control (radiogroup) — matches the studio's transport styling
// ---------------------------------------------------------------------------

function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  ariaLabel: string
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('grid gap-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-8 truncate rounded-md border px-2 font-mono text-[10px] uppercase tracking-wide transition-colors',
            value === o.value
              ? 'border-teal-500/60 bg-teal-600/20 text-teal-200'
              : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const CHECKER_CLASS =
  'bg-[conic-gradient(from_90deg,#27272a_25%,#18181b_0_50%,#27272a_0_75%,#18181b_0)] bg-[length:16px_16px]'

const PREVIEW_ZOOM_LEVELS = [1, 2, 4, 8, 16, 32] as const

// ---------------------------------------------------------------------------

export function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { toast } = useToast()
  const [scope, setScope] = useState<ExportScope>('clip')
  const [format, setFormat] = useState<ExportFormat | 'atlas' | 'gif'>('sheet')
  const [exportScale, setExportScale] = useState<ExportScale>(1)
  const [scaleAutoSetForGif, setScaleAutoSetForGif] = useState(false)
  const [gifBg, setGifBg] = useState('#101014')
  const [layoutMode, setLayoutMode] = useState<'horizontal' | 'grid'>('grid')
  const [columns, setColumns] = useState(4)
  const [padding, setPadding] = useState(0)
  const [spacing, setSpacing] = useState(0)
  const [includeJson, setIncludeJson] = useState(true)
  const [jsonFormat, setJsonFormat] = useState<JsonMetadataFormat>('aseprite')
  const [includeGodotTres, setIncludeGodotTres] = useState(false)
  const [zeroPad, setZeroPad] = useState('2')
  const [baseName, setBaseName] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewDims, setPreviewDims] = useState<{ w: number; h: number } | null>(null)
  const [previewZoomIndex, setPreviewZoomIndex] = useState(3)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // subscribe so the preview + captions track the live document & selection
  const project = useEditor((s) => s.project)
  const activeClipId = useEditor((s) => s.activeClipId)
  const activeFrameIndex = useEditor((s) => s.activeFrameIndex)
  const activeClip = useMemo(() => getActiveClip({ project, activeClipId }), [project, activeClipId])

  const effectiveBase = baseName.trim() || slugify(project.name)
  const sheetOptions = useMemo(
    () =>
      layoutMode === 'horizontal'
        ? { columns: 0, padding, spacing }
        : { columns, padding, spacing },
    [layoutMode, columns, padding, spacing],
  )
  const exportRequest = useMemo(
    () => ({
      scope,
      clipId: activeClip.id,
      frameIndex: activeFrameIndex,
      format: (format === 'gif' || format === 'atlas' ? 'png-frames' : format) as ExportFormat,
      sheet: sheetOptions,
      includeJson,
      baseName: effectiveBase,
      zeroPadFrames: Number(zeroPad),
    }),
    [scope, activeClip.id, activeFrameIndex, format, sheetOptions, includeJson, effectiveBase, zeroPad],
  )

  // Deterministic artifact names for the caption (validated with the same
  // code path the real export uses — errors surface inline).
  const planned = useMemo(() => {
    if (format === 'gif')
      return {
        ok: true as const,
        plan: {
          artifacts: [
            {
              filename: `${effectiveBase}-${slugify(activeClip.name)}.gif`,
              kind: 'png' as const,
              label: 'Animated GIF',
              build: async () => new Uint8Array(),
            },
          ],
        },
      }
    if (format === 'atlas') {
      try {
        const layout = resolveAtlasLayout(project, sheetOptions)
        const artifacts: Array<{ filename: string; kind: 'png' | 'json'; label: string; build: () => Promise<Uint8Array> }> = [
          {
            filename: `${effectiveBase}_atlas.png`,
            kind: 'png',
            label: `Master atlas (${layout.clips.length} clips · ${layout.frames.length} frames)`,
            build: async () => new Uint8Array(),
          },
        ]
        if (includeJson) {
          artifacts.push({
            filename: `${effectiveBase}_atlas.json`,
            kind: 'json',
            label: jsonFormat === 'aseprite' ? 'Aseprite JSON (Unity/Phaser/Godot)' : 'PixelForge Atlas JSON',
            build: async () => new Uint8Array(),
          })
        }
        if (includeGodotTres) {
          artifacts.push({
            filename: `${effectiveBase}_atlas.tres`,
            kind: 'json',
            label: 'Godot 4 SpriteFrames (all clips)',
            build: async () => new Uint8Array(),
          })
        }
        return { ok: true as const, plan: { artifacts } }
      } catch (err) {
        return { ok: false as const, message: friendlyError(err) }
      }
    }
    try {
      const p = planExport(project, exportRequest)
      const artifacts = [...p.artifacts]
      if (format === 'sheet' && includeGodotTres) {
        const clips = scope === 'all-clips' ? project.clips : [activeClip]
        for (const c of clips) {
          artifacts.push({
            filename: `${effectiveBase}_${slugify(c.name)}.tres`,
            kind: 'json' as const,
            label: `Godot 4 SpriteFrames (${c.name})`,
            build: async () => new Uint8Array(),
          })
        }
      }
      return { ok: true as const, plan: { ...p, artifacts } }
    } catch (err) {
      return { ok: false as const, message: friendlyError(err) }
    }
  }, [project, exportRequest, format, sheetOptions, effectiveBase, activeClip, scope, includeJson, jsonFormat, includeGodotTres])

  // Live preview: compose through the CORE export service (pixel-identical to
  // the artifacts). Sheet preview shows the active clip; all-clips previews
  // its first clip (captions cover the full file list).
  useEffect(() => {
    if (!open) return
    let canceled = false
    const timer = setTimeout(() => {
      const cv = canvasRef.current
      if (!cv) return
      try {
        const st = useEditor.getState()
        const proj: Project = st.project
        const clip = getActiveClip(st)
        const frameIndex = Math.min(Math.max(0, st.activeFrameIndex), clip.frames.length - 1)
        let rgba: Uint8ClampedArray
        let w = proj.width
        let h = proj.height
        if (format === 'atlas') {
          const composed = composeAtlasRgba(proj, sheetOptions)
          rgba = composed.rgba
          w = composed.layout.width
          h = composed.layout.height
        } else if (format === 'sheet') {
          const composed = composeSheetRgba(proj, clip, sheetOptions)
          rgba = composed.rgba
          w = composed.layout.width
          h = composed.layout.height
        } else if (scope === 'frame') {
          rgba = composeFrameRgba(proj, clip, clip.frames[frameIndex])
        } else {
          rgba = composeFrameRgba(proj, clip, clip.frames[0])
        }
        if (canceled) return
        cv.width = w
        cv.height = h
        const ctx = cv.getContext('2d')
        if (ctx) {
          ctx.clearRect(0, 0, w, h)
          ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0)
        }
        setPreviewDims({ w, h })
        setPreviewError(null)
      } catch (err) {
        if (canceled) return
        setPreviewDims(null)
        setPreviewError(friendlyError(err))
      }
    }, 120)
    return () => {
      canceled = true
      clearTimeout(timer)
    }
  }, [open, format, scope, sheetOptions, project, activeClipId, activeFrameIndex])

  const describeOutcome = (outcome: ExportOutcome) => {
    if (outcome.status === 'canceled') {
      toast({ title: 'Export canceled', description: 'No files were written.' })
      return
    }
    if (outcome.status === 'conflicts') {
      toast({
        title: 'Export blocked — files already exist',
        description: `${outcome.conflicts.slice(0, 3).join(', ')}${outcome.conflicts.length > 3 ? ` +${outcome.conflicts.length - 3} more` : ''}. Enable "Overwrite existing files" or pick another folder.`,
        variant: 'destructive',
      })
      return
    }
    toast({
      title: 'Export complete',
      description: `${outcome.filenames.length} file${outcome.filenames.length > 1 ? 's' : ''} → ${outcome.destination}`,
    })
  }

  const run = async () => {
    setBusy(true)
    try {
      const st = useEditor.getState()
      if (format === 'gif') {
        // GIF: animated export of the ACTIVE clip via the existing gifenc path
        const { exportGif } = await import('@/lib/pixelforge/exporters')
        const clip = getActiveClip(st)
        const frames = clip.frames.map((f) => {
          const rgba = composeFrameRgba(st.project, clip, f)
          return { width: st.project.width, height: st.project.height, data: new Uint8ClampedArray(rgba) }
        })
        const durations = clip.frames.map((f) => f.durationMs > 0 ? f.durationMs : Math.round(1000 / clip.fps))
        const gifScale = exportScale
        await exportGif(frames, durations, `${effectiveBase}-${slugify(clip.name)}.gif`, { scale: gifScale, checker: false, bg: gifBg })
        toast({
          title: 'Export complete',
          description: `1 file → ${isDesktop() ? 'desktop save dialog' : 'browser downloads'} (GIF, ${clip.frames.length} frames, ${st.project.width * gifScale}×${st.project.height * gifScale} px · ${gifScale}×)`,
        })
        return
      }
      if (format === 'atlas') {
        const outcome = await runAtlasExport(st.project, {
          baseName: effectiveBase,
          columns: sheetOptions.columns,
          padding: sheetOptions.padding,
          spacing: sheetOptions.spacing,
          scale: exportScale,
          includeJson,
          jsonFormat,
          includeTres: includeGodotTres,
          overwrite,
        })
        describeOutcome(outcome)
        return
      }
      const outcome = await runExport(st.project, {
        ...exportRequest,
        overwrite,
        scale: exportScale,
        includeTres: includeGodotTres,
        jsonFormat,
      })
      describeOutcome(outcome)
    } catch (err) {
      toast({
        title: 'Export failed',
        description: friendlyError(err),
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  const desktop = typeof window !== 'undefined' && isDesktop()
  const namesPreview = planned.ok ? planned.plan.artifacts.map((a) => a.filename) : []
  const exportDisabled = busy || !planned.ok || activeClip.frames.length === 0
  const previewZoom = PREVIEW_ZOOM_LEVELS[previewZoomIndex]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="pixelforge-scroll max-h-[90dvh] overflow-y-auto border-zinc-800 bg-[#101114] p-0 text-zinc-100 sm:max-w-5xl">
        <DialogHeader className="border-b border-zinc-800/90 bg-zinc-950/70 px-5 py-4 pr-12 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-md border border-teal-400/25 bg-teal-400/10 text-teal-200">
              <ImageIcon className="size-4" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="font-mono text-base tracking-tight">Export assets</DialogTitle>
              <DialogDescription className="mt-0.5 font-mono text-[11px] leading-relaxed text-zinc-400">
                Prepare pixel-true files for your game. Editor-only overlays never export.
              </DialogDescription>
            </div>
          </div>
          <div className="sr-only">
          <DialogDescription className="font-mono text-xs text-zinc-400">
            Pixel-exact PNG + JSON metadata, deterministic across web and desktop. Onion skins,
            selection ants and guides never reach exports.
          </DialogDescription>
          </div>
        </DialogHeader>

        <div className="grid min-w-0 lg:grid-cols-[minmax(18rem,0.88fr)_minmax(0,1.12fr)]">
          {/* left column: preview (landscape feel — the visual anchor) */}
          <section className="min-w-0 border-b border-zinc-800/90 bg-[#15171c] p-4 sm:p-5 lg:border-r lg:border-b-0 lg:p-6">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-zinc-200">Output preview</h3>
                <p className="mt-0.5 font-mono text-[10px] text-zinc-500">Pixel-accurate, transparent canvas</p>
              </div>
              <div className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[10px] text-teal-200">{previewZoom}× zoom</div>
            </div>
            <div
              className={cn(
                'grid h-[min(42dvh,22rem)] w-full place-items-center overflow-auto rounded-md border border-zinc-700/80 p-5 shadow-inner',
                CHECKER_CLASS,
              )}
            >
              {previewError ? (
                <p className="px-4 py-6 text-center font-mono text-[10px] leading-relaxed text-red-400">
                  {previewError}
                </p>
              ) : (
                <canvas
                  ref={canvasRef}
                  aria-label={`Export preview at ${previewZoom} times zoom`}
                  className="block shrink-0 [image-rendering:pixelated]"
                  style={previewDims ? { width: previewDims.w * previewZoom, height: previewDims.h * previewZoom } : undefined}
                />
              )}
            </div>
            <p className="break-words font-mono text-[10px] text-zinc-400">
              {previewDims
                ? `Output ${previewDims.w * exportScale}×${previewDims.h * exportScale} px · ${exportScale}× nearest-neighbor · ${format === 'gif' ? (gifBg === 'transparent' ? 'transparent GIF' : `solid ${gifBg}`) : 'transparent background'}`
                : 'Preview unavailable'}
            </p>
            <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/50 p-2.5">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-7 border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  onClick={() => setPreviewZoomIndex((index) => Math.max(0, index - 1))}
                  disabled={previewZoomIndex === 0}
                  aria-label="Zoom preview out"
                  title="Zoom out"
                >
                  <Minus className="size-3.5" />
                </Button>
                <Slider
                  value={[previewZoomIndex]}
                  onValueChange={([value]) => setPreviewZoomIndex(value)}
                  min={0}
                  max={PREVIEW_ZOOM_LEVELS.length - 1}
                  step={1}
                  aria-label="Preview zoom level"
                  className="mx-1 [&_[data-slot=slider-range]]:bg-teal-400 [&_[data-slot=slider-thumb]]:border-teal-400"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-7 border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  onClick={() => setPreviewZoomIndex((index) => Math.min(PREVIEW_ZOOM_LEVELS.length - 1, index + 1))}
                  disabled={previewZoomIndex === PREVIEW_ZOOM_LEVELS.length - 1}
                  aria-label="Zoom preview in"
                  title="Zoom in"
                >
                  <Plus className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 font-mono text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-white"
                  onClick={() => setPreviewZoomIndex(0)}
                  title="Show each source pixel at its native size"
                >
                  <Scan className="size-3" /> Native
                </Button>
              </div>
              <p className="mt-2 font-mono text-[10px] leading-relaxed text-zinc-500">
                Use the slider or + / − buttons to inspect individual pixels.
              </p>
            </div>
          </section>

          {/* right column: all controls */}
          <section className="min-w-0 space-y-5 p-4 sm:p-5 lg:p-6">
            <div>
              <h3 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-zinc-200">1. Choose what to export</h3>
              <p className="mt-0.5 font-mono text-[10px] text-zinc-500">Pick content, format, and the final output size.</p>
            </div>
          {/* scope + format */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">Scope</span>
              <Segmented
                className="grid-cols-1"
                ariaLabel="Export scope"
                value={scope}
                onChange={setScope}
                options={[
                  { value: 'frame', label: `Frame ${Math.min(activeFrameIndex + 1, activeClip.frames.length)}` },
                  { value: 'clip', label: `Clip: ${activeClip.name}` },
                  { value: 'all-clips', label: `All clips (${project.clips.length})` },
                ]}
              />
            </div>
            <div className="space-y-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">Format</span>
              <Segmented
                className="grid-cols-2"
                ariaLabel="Export format"
                value={format}
                onChange={(next) => {
                  setFormat(next)
                  if (next === 'gif' && exportScale === 1) {
                    const maxDim = Math.max(project.width, project.height)
                    const recommended: ExportScale = maxDim <= 16 ? 16 : maxDim <= 64 ? 8 : maxDim <= 128 ? 4 : 2
                    setExportScale(recommended)
                    setScaleAutoSetForGif(true)
                  } else if (next !== 'gif' && scaleAutoSetForGif) {
                    setExportScale(1)
                    setScaleAutoSetForGif(false)
                  }
                }}
                options={[
                  { value: 'png-frames', label: 'PNG frames' },
                  { value: 'sheet', label: 'Sprite sheet' },
                  { value: 'atlas', label: 'Master atlas' },
                  { value: 'gif', label: 'GIF (clip)' },
                ]}
              />
            </div>
          </div>

          {/* scale multiplier */}
          <div className="space-y-1">
            <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">Scale (nearest-neighbor)</span>
            <Segmented
              className="grid-cols-5"
              ariaLabel="Export scale"
              value={String(exportScale) as '1' | '2' | '4' | '8' | '16'}
              onChange={(v) => {
                setExportScale(Number(v) as ExportScale)
                setScaleAutoSetForGif(false)
              }}
              options={[
                { value: '1', label: '1×' },
                { value: '2', label: '2×' },
                { value: '4', label: '4×' },
                { value: '8', label: '8×' },
                { value: '16', label: '16×' },
              ]}
            />
            <p className="font-mono text-[10px] text-zinc-500">
              Game engines (Godot/Unity): 1× · GIF / Viewing / Social: 4×–16× for razor-sharp pixels.
            </p>
          </div>

          {(format === 'sheet' || format === 'atlas') && (
            <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3.5">
              <div>
                <h3 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-zinc-300">
                  {format === 'atlas' ? 'Master atlas details' : 'Sheet details'}
                </h3>
                <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                  {format === 'atlas'
                    ? `Packs all ${project.clips.length} clip${project.clips.length === 1 ? '' : 's'} into one image (one row per clip, or wrapped grid).`
                    : 'Control how frames are packed into one image.'}
                </p>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">Layout</span>
                  <Segmented
                    className="grid-cols-2"
                    ariaLabel="Sheet layout"
                    value={layoutMode}
                    onChange={setLayoutMode}
                    options={[
                      { value: 'horizontal', label: 'Strip' },
                      { value: 'grid', label: 'Grid' },
                    ]}
                  />
                </div>
                <div className="space-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">Columns</span>
                  <StepperInput
                    value={columns}
                    onChange={(v) => setColumns(Math.max(1, Math.min(64, v)))}
                    min={1}
                    max={64}
                    ariaLabel="Sheet columns"
                    disabled={layoutMode === 'horizontal'}
                    className="w-full justify-between"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">Padding (outer)</span>
                  <StepperInput
                    value={padding}
                    onChange={(v) => setPadding(Math.max(0, Math.min(64, v)))}
                    min={0}
                    max={64}
                    ariaLabel="Sheet outer padding"
                    className="w-full justify-between"
                  />
                </div>
                <div className="space-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">Spacing (between)</span>
                  <StepperInput
                    value={spacing}
                    onChange={(v) => setSpacing(Math.max(0, Math.min(64, v)))}
                    min={0}
                    max={64}
                    ariaLabel="Spacing between frames"
                    className="w-full justify-between"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="exp-json" className="font-mono text-xs text-zinc-300">
                  JSON metadata ({format === 'atlas' ? 'combined atlas' : 'per sheet'})
                </Label>
                <Switch id="exp-json" checked={includeJson} onCheckedChange={setIncludeJson} />
              </div>
              {includeJson && (
                <div className="space-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">
                    JSON schema
                  </span>
                  <Segmented
                    className="grid-cols-2"
                    ariaLabel="JSON metadata schema"
                    value={jsonFormat}
                    onChange={setJsonFormat}
                    options={[
                      { value: 'aseprite', label: 'Aseprite (Unity/Phaser)' },
                      { value: 'pixelforge', label: 'PixelForge v2' },
                    ]}
                  />
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <div className="space-y-0.5">
                  <Label htmlFor="exp-tres" className="font-mono text-xs text-zinc-300">
                    Godot 4 SpriteFrames (.tres)
                  </Label>
                  <p className="text-[10px] text-zinc-500">
                    {format === 'atlas'
                      ? 'Single combined .tres with every clip as an AnimatedSprite2D animation'
                      : 'Resource with sheet frames & animation tags for AnimatedSprite2D'}
                  </p>
                </div>
                <Switch id="exp-tres" checked={includeGodotTres} onCheckedChange={setIncludeGodotTres} />
              </div>
            </div>
          )}

          {format === 'gif' && (
            <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">GIF background</span>
                  <Segmented
                    className="grid-cols-4"
                    ariaLabel="GIF background"
                    value={gifBg}
                    onChange={setGifBg}
                    options={[
                      { value: 'transparent', label: 'Trans' },
                      { value: '#101014', label: 'Dark' },
                      { value: '#000000', label: 'Black' },
                      { value: '#ffffff', label: 'White' },
                    ]}
                  />
                </div>
                <p className="font-mono text-[10px] leading-snug text-zinc-400">
                  Animated GIF of the ACTIVE clip ({activeClip.frames.length} frames · loop) — per-frame durations apply. Scale {exportScale}×.
                  GIF has no soft transparency: color modes flatten alpha onto the background; Trans dithers soft alpha into hard pixels.
                </p>
              </div>
            </div>
          )}

          {/* naming */}
          <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="space-y-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">File name base</span>
              <Input
                value={baseName}
                onChange={(e) => setBaseName(e.target.value)}
                placeholder={slugify(project.name)}
                aria-label="Export file name base"
                className="h-8 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-200 placeholder:text-zinc-400"
              />
            </div>
            {format === 'png-frames' && (
              <div className="space-y-1">
                <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">Frame # digits</span>
                <Select value={zeroPad} onValueChange={setZeroPad}>
                  {/* same-variant height override: the base trigger ships
                      data-[size=default]:h-9 which beats a plain h-7 */}
                  <SelectTrigger
                    aria-label="Frame number digits"
                    className="data-[size=default]:h-8 w-[84px] border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-300"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-zinc-800 bg-zinc-950">
                    <SelectItem value="0">off (0)</SelectItem>
                    <SelectItem value="1">1 digit</SelectItem>
                    <SelectItem value="2">2 digits</SelectItem>
                    <SelectItem value="3">3 digits</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* destination */}
          <div className="space-y-1 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-zinc-400">
              <FolderDown className="h-3 w-3" /> Destination
            </div>
            <p className="font-mono text-[10px] leading-relaxed text-zinc-400">
              {desktop
                ? 'Native dialog — save as one file, or pick a folder for multi-file exports.'
                : 'Web prototype — files go to your browser downloads folder.'}
            </p>
            {desktop && (
              <div className="flex items-center justify-between gap-2 pt-1">
                <Label htmlFor="exp-overwrite" className="font-mono text-xs text-zinc-300">
                  Overwrite existing files
                </Label>
                <Switch id="exp-overwrite" checked={overwrite} onCheckedChange={setOverwrite} />
              </div>
            )}
          </div>

          {/* run */}
          <Button
            className="h-9 w-full bg-teal-600 font-mono text-xs text-white hover:bg-teal-500"
            onClick={run}
            disabled={exportDisabled}
          >
            {busy ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <LayoutGrid className="mr-1.5 h-4 w-4" />
            )}
            Export {planned.ok ? `${planned.plan.artifacts.length} file${planned.plan.artifacts.length > 1 ? 's' : ''}` : 'assets'}
          </Button>

          {/* filenames + validation */}
          {!planned.ok ? (
            <p className="font-mono text-[10px] leading-relaxed text-red-400" role="alert">
              {planned.message}
            </p>
          ) : (
            <p
              className="line-clamp-2 break-all font-mono text-[10px] leading-relaxed text-zinc-400"
              title={namesPreview.join('\n')}
            >
              {namesPreview.length} file{namesPreview.length > 1 ? 's' : ''}: {namesPreview.join(', ')}
            </p>
          )}
          <p className="flex items-center gap-1 font-mono text-[10px] text-zinc-400">
            <FileImage className="h-3 w-3" /> Files never overwrite silently — conflicts are reported before writing.
          </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
