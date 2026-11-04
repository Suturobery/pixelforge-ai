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
  composeFrameRgba,
  composeSheetRgba,
  planExport,
  slugify,
  type ExportFormat,
  type ExportScope,
  type Project,
} from '@pixelforge/core'
import { runExport } from '@/lib/pixelforge/export'
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
import { useToast } from '@/hooks/use-toast'
import { cn, friendlyError } from '@/lib/utils'
import { FileImage, FolderDown, LayoutGrid, Loader2 } from 'lucide-react'
import type { ExportOutcome } from '@/lib/pixelforge/export'

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
  const [format, setFormat] = useState<ExportFormat | 'gif'>('sheet')
  const [layoutMode, setLayoutMode] = useState<'horizontal' | 'grid'>('grid')
  const [columns, setColumns] = useState(4)
  const [padding, setPadding] = useState(0)
  const [spacing, setSpacing] = useState(0)
  const [includeJson, setIncludeJson] = useState(true)
  const [zeroPad, setZeroPad] = useState('2')
  const [baseName, setBaseName] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewDims, setPreviewDims] = useState<{ w: number; h: number } | null>(null)
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
      format: (format === 'gif' ? 'png-frames' : format) as ExportFormat,
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
        plan: { files: [{ filename: `${effectiveBase}-${slugify(activeClip.name)}.gif` }], destination: 'browser downloads', artifacts: [] },
      }
    try {
      return { ok: true as const, plan: planExport(project, exportRequest) }
    } catch (err) {
      return { ok: false as const, message: friendlyError(err) }
    }
  }, [project, exportRequest, format, effectiveBase, activeClip.name])

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
        if (format === 'sheet') {
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
        await exportGif(frames, durations, `${effectiveBase}-${slugify(clip.name)}.gif`, { scale: 6, checker: false })
        toast({ title: 'Export complete', description: `1 file → browser downloads (GIF, ${clip.frames.length} frames)` })
        return
      }
      const outcome = await runExport(st.project, { ...exportRequest, overwrite })
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="pixelforge-scroll max-h-[85dvh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="font-mono">Export game-ready assets</DialogTitle>
          <DialogDescription className="font-mono text-xs text-zinc-400">
            Pixel-exact PNG + JSON metadata, deterministic across web and desktop. Onion skins,
            selection ants and guides never reach exports.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
          {/* left column: preview (landscape feel — the visual anchor) */}
          <div className="space-y-1">
            <div
              className={cn(
                'flex max-h-[220px] items-center justify-center overflow-hidden rounded-md border border-zinc-800 p-2',
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
                  aria-label="Export preview at native pixel size"
                  className="max-h-[204px] w-auto max-w-full [image-rendering:pixelated]"
                />
              )}
            </div>
            <p className="font-mono text-[10px] text-zinc-400">
              {previewDims
                ? `Preview ${previewDims.w}×${previewDims.h} px · native size · transparent background`
                : 'Preview unavailable'}
            </p>
          </div>

          {/* right column: all controls */}
          <div className="min-w-0 space-y-4">
          {/* scope + format */}
          <div className="grid grid-cols-2 gap-3">
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
                className="grid-cols-1"
                ariaLabel="Export format"
                value={format}
                onChange={setFormat}
                options={[
                  { value: 'png-frames', label: 'PNG frames' },
                  { value: 'sheet', label: 'Sprite sheet' },
                  { value: 'gif', label: 'GIF (clip)' },
                ]}
              />
            </div>
          </div>

          {format === 'sheet' && (
            <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="grid grid-cols-2 gap-2">
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
              <div className="grid grid-cols-2 gap-2">
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
                  JSON metadata (per sheet)
                </Label>
                <Switch id="exp-json" checked={includeJson} onCheckedChange={setIncludeJson} />
              </div>
            </div>
          )}

          {format === 'gif' && (
            <p className="rounded-md border border-zinc-800 bg-zinc-900/40 px-2.5 py-2 font-mono text-[10px] leading-snug text-zinc-400">
              Animated GIF of the ACTIVE clip ({activeClip.frames.length} frames · loop) — per-frame durations apply. Scale 6×.
            </p>
          )}

          {/* naming */}
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
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
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
