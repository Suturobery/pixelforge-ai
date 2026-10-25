// PixelForge AI — animation timeline (Task 6).
// Clips row: clip tabs + full transport (restart / step / play / stop),
// loop mode (forward · reverse · ping-pong), loop on/off, onion-skin
// popover, FPS. Below: a proportional scrubber (drag anywhere — the shared
// playback engine maps position ⇄ frame) and the frame strip with
// thumbnails, per-frame duration badges (0 = inherit fps), HTML5
// drag-and-drop reordering, and add/duplicate/delete controls.
//
// All timing goes through the shared playback controller (single engine for
// timeline + preview); every document change goes through the CommandBus.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, getActiveClip } from '@/lib/pixelforge/store'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { editorPlayback } from '@/lib/pixelforge/playback-controller'
import { renderFrameScaled } from '@/lib/pixelforge/render'
import { analyzeClipMotion, type QAIssue } from '@pixelforge/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { StepperInput } from '@/components/pixelforge/stepper-input'
import { ColorPickerContent } from '@/components/pixelforge/color-picker'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Play,
  Pause,
  Plus,
  Copy,
  Trash2,
  TriangleAlert,
  ArrowLeft,
  ArrowRight,
  Ghost,
  Repeat,
  ChevronDown,
  ChevronUp,
  ChevronsLeft,
  ChevronLeft,
  Square,
  Timer,
  ArrowLeftRight,
} from 'lucide-react'
import type { Clip, Frame } from '@/lib/pixelforge/types'

const DURATION_MAX = 60_000

/** Effective duration of a frame for badges/scrubber (mirrors core math). */
function frameMs(clip: Clip, index: number): number {
  const f = clip.frames[index]
  if (!f) return 0
  if (f.durationMs > 0) return f.durationMs
  const fps = Math.min(60, Math.max(1, Math.round(clip.fps || 8)))
  return Math.max(1, Math.round(1000 / fps))
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 2)}s` : `${ms}ms`
}

// ------------------------------------------------------------- FrameThumb

function FrameThumb({
  clip,
  frame,
  index,
  active,
  dropBefore,
  qaNotes,
  w,
  h,
  tick,
  playing,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  clip: Clip
  frame: Frame
  index: number
  active: boolean
  dropBefore: boolean
  /** Phase-1 Task 10 QA: issues scoped to this frame (may be undefined). */
  qaNotes?: QAIssue[]
  w: number
  h: number
  tick: number
  playing: boolean
  onSelect: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
  onDragEnd: () => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [durOpen, setDurOpen] = useState(false)
  const setFrameDuration = useEditor((s) => s.setFrameDuration)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    renderFrameScaled(canvas, clip, frame, w, h)
  }, [clip, frame, w, h, tick])
  const ms = frame.durationMs
  const qaWarnings = qaNotes?.filter((n) => n.level === 'warning') ?? []
  const qaInfos = qaNotes?.filter((n) => n.level === 'info') ?? []
  const hasQaNotes = (qaNotes?.length ?? 0) > 0
  return (
    <div
      className={`relative shrink-0 ${dropBefore ? 'before:absolute before:inset-y-0 before:-left-1.5 before:z-10 before:w-1 before:rounded-full before:bg-teal-400' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(index))
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        onClick={onSelect}
        className={`relative rounded-md border p-1 transition-colors ${
          active
            ? 'border-teal-400 bg-teal-500/10 ring-1 ring-teal-400/60'
            : 'border-zinc-700 bg-zinc-900 hover:border-zinc-500'
        } ${playing && active ? 'animate-pulse' : ''}`}
        aria-label={`Frame ${index + 1}${ms > 0 ? `, ${ms} milliseconds` : ', inherited duration'}`}
        aria-pressed={active}
      >
        <canvas ref={ref} width={56} height={56} className="pixelforge-checker h-11 w-11 rounded-sm sm:h-14 sm:w-14" aria-hidden />
        <span className="absolute bottom-0.5 right-1 font-mono text-[9px] text-zinc-400">{index + 1}</span>
        {hasQaNotes && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`absolute -top-1.5 -left-0.5 flex h-4 w-4 items-center justify-center rounded-full border leading-none ${
                  qaWarnings.length > 0
                    ? 'border-amber-500/60 bg-amber-500/20 text-amber-300'
                    : 'border-zinc-600 bg-zinc-800 text-zinc-400'
                }`}
                aria-label={`Frame ${index + 1} motion QA: ${qaNotes!.map((n) => n.code).join(', ')}`}
              >
                {qaWarnings.length > 0 ? (
                  <TriangleAlert className="h-2.5 w-2.5" aria-hidden />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 space-y-1 p-2">
              {qaNotes!.map((n, k) => (
                <p key={k} className={`font-mono text-[10px] leading-snug ${n.level === 'warning' ? 'text-amber-300' : 'text-zinc-400'}`}>
                  <span className="uppercase">{n.code}</span> — {n.message}
                </p>
              ))}
            </TooltipContent>
          </Tooltip>
        )}
      </button>
      {/* duration badge → popover editor (Task 6 §2) */}
      <Popover open={durOpen} onOpenChange={setDurOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`absolute -top-1.5 -right-0.5 flex h-4 items-center gap-0.5 rounded-full border px-1 font-mono text-[8px] leading-none transition-colors ${
              ms > 0
                ? 'border-amber-500/60 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-300'
            }`}
            aria-label={`Edit duration of frame ${index + 1}`}
            title="Frame duration (0 = inherit clip FPS)"
          >
            <Timer className="h-2 w-2" aria-hidden />
            {ms > 0 ? `${ms}` : 'auto'}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="center" className="w-56 p-3">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
            Frame {index + 1} duration
          </p>
          <StepperInput
            value={ms}
            onChange={(v) => setFrameDuration(index, Math.min(DURATION_MAX, Math.max(0, v)))}
            min={0}
            max={DURATION_MAX}
            step={10}
            suffix="ms"
            ariaLabel={`Duration of frame ${index + 1} in milliseconds`}
            size="sm"
          />
          <p className="mt-1.5 text-[10px] leading-snug text-zinc-400">
            {ms > 0 ? (
              <>Overrides the clip FPS for this frame.</>
            ) : (
              <>
                <span className="text-amber-400">auto</span> — inherits the clip FPS
                ({frameMs(clip, index)}ms at {clip.fps}fps).
              </>
            )}
          </p>
          {ms > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-6 w-full text-[10px] text-zinc-400 hover:text-teal-300"
              onClick={() => setFrameDuration(index, 0)}
            >
              Reset to auto ({clip.fps}fps)
            </Button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

// ---------------------------------------------------------------- Scrubber

function Scrubber({ clip, activeIndex }: { clip: Clip; activeIndex: number }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const markerRef = useRef<HTMLDivElement>(null)
  const [hoverMs, setHoverMs] = useState<number | null>(null)

  // Playhead marker follows the shared engine via direct DOM writes — no
  // React re-render per animation tick (smooth at any fps).
  useEffect(
    () =>
      editorPlayback.onPosition((pos, total) => {
        const el = markerRef.current
        if (el) el.style.left = `${total > 0 ? Math.min(100, (pos / total) * 100) : 0}%`
      }),
    []
  )

  const msFromEvent = (clientX: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    const total = clip.frames.reduce((s, _, i) => s + frameMs(clip, i), 0)
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return Math.round(ratio * total)
  }

  const scrub = (clientX: number) => editorPlayback.scrubToMs(msFromEvent(clientX))

  return (
    <div className="px-2 pb-1">
      <div
        ref={trackRef}
        role="slider"
        aria-label="Timeline position"
        aria-valuemin={1}
        aria-valuemax={clip.frames.length}
        aria-valuenow={activeIndex + 1}
        aria-valuetext={`Frame ${activeIndex + 1} of ${clip.frames.length}`}
        tabIndex={0}
        className="relative flex h-5 cursor-pointer touch-none items-stretch overflow-hidden rounded-md border border-zinc-800 bg-zinc-900"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          scrub(e.clientX)
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) scrub(e.clientX)
          setHoverMs(msFromEvent(e.clientX))
        }}
        onPointerLeave={() => setHoverMs(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') editorPlayback.step(1)
          else if (e.key === 'ArrowLeft') editorPlayback.step(-1)
        }}
      >
        {/* proportional frame segments (width = effective duration) */}
        {clip.frames.map((f, i) => (
          <div
            key={f.id}
            title={`Frame ${i + 1} · ${frameMs(clip, i)}ms`}
            style={{ flexGrow: frameMs(clip, i), flexBasis: 0 }}
            className={`min-w-[3px] border-r border-zinc-950/80 last:border-r-0 ${
              i === activeIndex ? 'bg-teal-700/50' : i % 2 === 0 ? 'bg-zinc-800/70' : 'bg-zinc-800/40'
            }`}
          />
        ))}
        {/* playhead marker */}
        <div
          ref={markerRef}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-teal-400 shadow-[0_0_6px_rgba(45,212,191,0.8)]"
        />
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[9px] text-zinc-400">
        <span>
          {hoverMs != null ? `scrub ${formatMs(hoverMs)}` : `${clip.frames.length} frames`}
        </span>
        <span>{formatMs(clip.frames.reduce((s, _, i) => s + frameMs(clip, i), 0))} cycle</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------- Onion menu

// Quick-pick tints for the onion-skin color fields — a mini palette row so
// ghost colors are one click away, with the full studio editor below.
const ONION_TINT_PRESETS = [
  '#ff5d5d', '#ff9d3b', '#ffd93b', '#3fbf7f', '#3bd6c6',
  '#4b9dff', '#a06bff', '#ff6bd6', '#f5f5f5', '#18181b',
] as const

// Palette-style tint field (same interaction as the palette chips): the
// trigger shows the current color as a swatch + hex, clicking opens the
// styled color editor (SV square · hue · hex/RGB) instead of the native
// OS color dialog.
function TintField({
  label,
  color,
  onChange,
}: {
  label: string
  color: string
  onChange: (hex: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-zinc-400">{label}</span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-7 w-full items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 transition-colors hover:border-teal-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400"
            aria-label={`${label} ${color} — click to open the palette-style color editor`}
          >
            <span
              className="h-4 w-4 shrink-0 rounded-[3px] border border-zinc-500 shadow-inner"
              style={{ backgroundColor: color }}
              aria-hidden
            />
            <span className="font-mono text-[10px] uppercase text-zinc-300">{color}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={8}
          className="w-56 border-zinc-800 bg-zinc-950 p-3"
        >
          <p className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-zinc-400">
            {label}
          </p>
          <div className="mb-2 grid grid-cols-5 gap-1" role="listbox" aria-label={`${label} quick picks`}>
            {ONION_TINT_PRESETS.map((hex) => (
              <button
                key={hex}
                type="button"
                role="option"
                aria-selected={hex.toLowerCase() === color.toLowerCase()}
                aria-label={hex}
                title={hex}
                className={`h-5 w-full rounded-[3px] border transition-colors hover:border-zinc-400 ${
                  hex.toLowerCase() === color.toLowerCase()
                    ? 'border-teal-300 ring-1 ring-teal-400'
                    : 'border-zinc-700'
                }`}
                style={{ backgroundColor: hex }}
                onClick={() => onChange(hex)}
              />
            ))}
          </div>
          <div className="border-t border-zinc-800 pt-2">
            <ColorPickerContent color={color} onChange={onChange} />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function OnionPopover() {
  const project = useEditor((s) => s.project)
  const onionSkin = useEditor((s) => s.onionSkin)
  const setOnionSkin = useEditor((s) => s.setOnionSkin)
  const setOnionRange = useEditor((s) => s.setOnionRange)
  const setSetting = useAppSettings((s) => s.setSetting)
  const onionOpacity = useAppSettings((s) => s.onionOpacity)
  const onionPrevTint = useAppSettings((s) => s.onionPrevTint)
  const onionNextTint = useAppSettings((s) => s.onionNextTint)
  const { prev, next } = project.settings.onion

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={`h-7 w-7 ${onionSkin ? 'text-teal-300' : 'text-zinc-400'}`}
              aria-label="Onion skin settings"
              aria-pressed={onionSkin}
            >
              <Ghost className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Onion skin</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">Onion skin</p>
          <Switch checked={onionSkin} onCheckedChange={setOnionSkin} aria-label="Enable onion skin" />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] text-zinc-400">Previous (0–3)</span>
            <StepperInput
              value={prev}
              onChange={(v) => setOnionRange({ prev: Math.min(3, Math.max(0, v)) })}
              min={0}
              max={3}
              ariaLabel="Onion skin previous frames"
              size="sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] text-zinc-400">Next (0–3)</span>
            <StepperInput
              value={next}
              onChange={(v) => setOnionRange({ next: Math.min(3, Math.max(0, v)) })}
              min={0}
              max={3}
              ariaLabel="Onion skin next frames"
              size="sm"
            />
          </label>
        </div>
        <label className="mt-3 block">
          <span className="font-mono text-[10px] text-zinc-400">
            Opacity {Math.round(onionOpacity * 100)}%
          </span>
          <Slider
            value={[Math.round(onionOpacity * 100)]}
            onValueChange={([v]) => setSetting('onionOpacity', Math.min(0.8, Math.max(0.05, v / 100)))}
            min={5}
            max={80}
            step={5}
            aria-label="Onion skin opacity"
            className="mt-1"
          />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <TintField
            label="Previous tint"
            color={onionPrevTint}
            onChange={(hex) => setSetting('onionPrevTint', hex)}
          />
          <TintField
            label="Next tint"
            color={onionNextTint}
            onChange={(hex) => setSetting('onionNextTint', hex)}
          />
        </div>
        <p className="mt-2 text-[10px] leading-snug text-zinc-400">
          Range (prev/next) is saved with the project; tint &amp; opacity are studio
          preferences. Ghosts never appear in exports.
        </p>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------- Timeline

export function Timeline() {
  const project = useEditor((s) => s.project)
  const activeClipId = useEditor((s) => s.activeClipId)
  const activeFrameIndex = useEditor((s) => s.activeFrameIndex)
  const renderTick = useEditor((s) => s.renderTick)
  const playing = useEditor((s) => s.playing)
  const timelineOpen = useEditor((s) => s.timelineOpen)
  const selectClip = useEditor((s) => s.selectClip)
  const selectFrame = useEditor((s) => s.selectFrame)
  const setTimelineOpen = useEditor((s) => s.setTimelineOpen)
  const addFrame = useEditor((s) => s.addFrame)
  const deleteFrame = useEditor((s) => s.deleteFrame)
  const moveFrame = useEditor((s) => s.moveFrame)
  const addClip = useEditor((s) => s.addClip)
  const deleteClip = useEditor((s) => s.deleteClip)
  const setClipProp = useEditor((s) => s.setClipProp)
  const [renamingClip, setRenamingClip] = useState<string | null>(null)
  // drag-and-drop reorder state
  const dragFromRef = useRef<number | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  const clip = getActiveClip(useEditor.getState())
  const frameIndex = Math.min(activeFrameIndex, clip.frames.length - 1)

  // -- Phase-1 Task 10 QA: per-frame issue badges ---------------------------
  // (a) committed-clip QA (flicker / loop / artifacts — only meaningful when
  //     the clip carries motion parts) + (b) live plan-preview issues
  //     mirrored from the Motion Composer panel (foot contact, overlaps…).
  const motionPreviewIssues = useEditor((s) => s.motionPreviewIssues)
  const clipQaIssues = useMemo(
    () => (clip.parts.length > 0 ? analyzeClipMotion(project, clip) : []),
    [project, clip]
  )
  const qaByFrame = useMemo(() => {
    const m = new Map<number, QAIssue[]>()
    for (const issue of [...clipQaIssues, ...(motionPreviewIssues ?? [])]) {
      for (const fi of issue.frameIndexes ?? []) {
        if (fi < 0 || fi >= clip.frames.length) continue
        const list = m.get(fi)
        if (list) list.push(issue)
        else m.set(fi, [issue])
      }
    }
    return m
  }, [clipQaIssues, motionPreviewIssues, clip.frames.length])

  // keep the active thumb visible while playing / scrubbing
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const el = strip.querySelector<HTMLElement>(`[data-frame-index="${frameIndex}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: playing ? 'auto' : 'smooth' })
  }, [frameIndex, playing])

  const commitDrop = (target: number) => {
    const from = dragFromRef.current
    dragFromRef.current = null
    setDropTarget(null)
    if (from == null || from === target) return
    moveFrame(from, target)
  }

  const transport = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400" onClick={() => editorPlayback.restart()} aria-label="Restart from first frame">
            <ChevronsLeft className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Restart</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400" onClick={() => editorPlayback.step(-1)} aria-label="Previous frame">
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Previous frame (,)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={playing ? 'secondary' : 'ghost'}
            size="icon"
            className={`h-7 w-7 ${playing ? 'bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40' : 'text-zinc-300'}`}
            onClick={() => editorPlayback.toggle()}
            aria-label={playing ? 'Pause animation' : 'Play animation'}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Play / pause (Enter)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400" onClick={() => editorPlayback.step(1)} aria-label="Next frame">
            <ArrowRight className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Next frame (.)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400" onClick={() => editorPlayback.stop()} aria-label="Stop and rewind">
            <Square className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Stop &amp; rewind</TooltipContent>
      </Tooltip>
    </>
  )

  return (
    <TooltipProvider delayDuration={200}>
      <section aria-label="Animation timeline" className="shrink-0 border-t border-zinc-800 bg-zinc-950/80">
        {/* clips + transport row */}
        <div className="flex h-9 items-center gap-1 overflow-x-auto border-b border-zinc-800 px-2 pixelforge-scroll">
          {project.clips.map((c) => (
            <div key={c.id} className="flex shrink-0 items-center">
              {renamingClip === c.id ? (
                <Input
                  autoFocus
                  defaultValue={c.name}
                  className="h-6 w-24 border-zinc-700 bg-zinc-900 font-mono text-xs"
                  onBlur={(e) => {
                    setClipProp(c.id, { name: e.target.value || c.name })
                    setRenamingClip(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setRenamingClip(null)
                  }}
                />
              ) : (
                <button
                  type="button"
                  onDoubleClick={() => setRenamingClip(c.id)}
                  onClick={() => selectClip(c.id)}
                  className={`rounded-t-md border-b-2 px-3 py-1 font-mono text-xs transition-colors ${
                    c.id === clip.id
                      ? 'border-teal-400 bg-zinc-900 text-teal-300'
                      : 'border-transparent text-zinc-400 hover:text-zinc-300'
                  }`}
                  title={`${c.name} — ${c.frames.length} frames · double-click to rename`}
                >
                  {c.name}
                  <span className="ml-2 text-[10px] text-zinc-400">{c.frames.length}f</span>
                </button>
              )}
            </div>
          ))}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-zinc-400"
                onClick={() => addClip(`clip ${project.clips.length + 1}`)}
                aria-label="Add clip"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New clip</TooltipContent>
          </Tooltip>
          {project.clips.length > 1 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 text-red-400/70 hover:text-red-300"
                  onClick={() => deleteClip(clip.id)}
                  aria-label="Delete current clip"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete clip</TooltipContent>
            </Tooltip>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1 pl-3">
            {/* playback state chip (Task 6 §5 visible playback state) */}
            <span
              role="status"
              className={`mr-1 hidden shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider sm:inline ${
                playing ? 'bg-teal-500/15 text-teal-300' : 'bg-zinc-800 text-zinc-400'
              }`}
              aria-live="polite"
            >
              {playing ? `▶ ${frameIndex + 1}/${clip.frames.length}` : `paused ${frameIndex + 1}/${clip.frames.length}`}
            </span>
            {transport}
            {/* loop mode (Task 6 §3): forward · reverse · ping-pong */}
            <Select
              value={clip.loopMode}
              onValueChange={(v) => setClipProp(clip.id, { loopMode: v as Clip['loopMode'] })}
            >
              <SelectTrigger
                // NOTE: the base trigger ships `data-[size=default]:h-9`, whose
                // attribute-variant specificity beats a plain `h-7` — the same-variant
                // override here is what actually pins it to the 28px transport row.
                className="data-[size=default]:h-7 w-[96px] gap-1 border-zinc-800 bg-zinc-900 dark:bg-zinc-900 dark:hover:bg-zinc-800 px-2 font-mono text-[10px] text-zinc-300"
                aria-label="Playback mode"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="forward">Forward</SelectItem>
                <SelectItem value="reverse">Reverse</SelectItem>
                <SelectItem value="pingpong">Ping-pong</SelectItem>
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-7 w-7 ${clip.loop ? 'text-teal-300' : 'text-zinc-400'}`}
                  onClick={() => setClipProp(clip.id, { loop: !clip.loop })}
                  aria-label="Loop clip"
                  aria-pressed={clip.loop}
                >
                  <Repeat className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{clip.loop ? 'Looping' : 'Play once'}</TooltipContent>
            </Tooltip>
            <OnionPopover />
            <label className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-400">
              FPS
              <StepperInput
                size="sm"
                value={clip.fps}
                onChange={(v) => setClipProp(clip.id, { fps: Math.min(60, Math.max(1, v)) })}
                min={1}
                max={60}
                ariaLabel="Frames per second"
              />
            </label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-zinc-400"
                  onClick={() => setTimelineOpen(!timelineOpen)}
                  aria-label={timelineOpen ? 'Collapse frames strip' : 'Expand frames strip'}
                  aria-pressed={timelineOpen}
                >
                  {timelineOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{timelineOpen ? 'Collapse frames' : 'Expand frames'}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* frames strip (collapsible to give the canvas more vertical space) */}
        {timelineOpen && (
          <>
            <Scrubber clip={clip} activeIndex={frameIndex} />
            <div className="flex items-center gap-1 border-b border-zinc-800/60 px-2 py-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-zinc-400" onClick={() => addFrame(false)} aria-label="Add empty frame after current">
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Add frame (Alt+N)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-zinc-400" onClick={() => addFrame(true)} aria-label="Duplicate current frame">
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Duplicate frame</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-zinc-400"
                    onClick={() => moveFrame(frameIndex, frameIndex - 1)}
                    disabled={frameIndex === 0}
                    aria-label="Move frame left"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Move left</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-zinc-400"
                    onClick={() => moveFrame(frameIndex, frameIndex + 1)}
                    disabled={frameIndex >= clip.frames.length - 1}
                    aria-label="Move frame right"
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Move right</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-red-400/80 hover:text-red-300"
                    onClick={() => deleteFrame(frameIndex)}
                    disabled={clip.frames.length <= 1}
                    aria-label="Delete current frame"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete frame</TooltipContent>
              </Tooltip>
              <span className="ml-2 flex min-w-0 items-center gap-2 truncate font-mono text-[10px] text-zinc-400">
                <span>
                  frame {frameIndex + 1}/{clip.frames.length} · {clip.name} · {clip.fps}fps ·{' '}
                  {clip.loopMode}
                  {!clip.loop && ' · once'}
                </span>
                {playing && (
                  <span className="inline-flex items-center gap-1 text-teal-300">
                    <ArrowLeftRight className="h-3 w-3 animate-pulse" aria-hidden />
                    playing
                  </span>
                )}
              </span>
            </div>
            <div ref={stripRef} className="pixelforge-scroll flex items-center gap-2 overflow-x-auto px-2 py-2">
              {clip.frames.map((f, i) => (
                <div key={f.id} data-frame-index={i} className="shrink-0">
                  <FrameThumb
                    clip={clip}
                    frame={f}
                    index={i}
                    active={i === frameIndex}
                    dropBefore={dropTarget === i && dragFromRef.current !== i}
                    qaNotes={qaByFrame.get(i)}
                    w={project.width}
                    h={project.height}
                    tick={renderTick}
                    playing={playing}
                    onSelect={() => selectFrame(i)}
                    onDragStart={() => {
                      dragFromRef.current = i
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      if (dragFromRef.current != null && dropTarget !== i) setDropTarget(i)
                    }}
                    onDrop={() => commitDrop(i)}
                    onDragEnd={() => {
                      dragFromRef.current = null
                      setDropTarget(null)
                    }}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </TooltipProvider>
  )
}
