// PixelForge AI — Motion Composer panel (Task 10, v3.1 §4.1).
//
// Deterministic part-based animation workflow:
//   Select source clip + anchor frame → Tag parts (marquee or manual rect,
//   regions never cuts) → Pick preset (Idle/Walk/Run/Attack/Jump) →
//   Adjust parameters → Preview (pure plan, NEVER committed until Accept) →
//   QA warnings → Accept (one undoable bus command) → edit frames as usual.
//
// The preview is the same pure composer the bus command runs — what you
// accept is byte-identical to what you previewed. Nothing here mutates the
// document except the two CommandBus actions (part.set / motion.apply).

'use client'

import {
  analyzeMotionPlan,
  composeFrameRgba,
  MOTION_PARAMS_DEFAULTS,
  MOTION_PRESETS,
  PRESET_IDS,
  planMotion,
  roleKey,
  type MotionParams,
  type MotionPlan,
  type MotionPresetId,
  type PartRect,
  type PresetDef,
  type QAIssue,
} from '@pixelforge/core'
import { useEffect, useRef, useState } from 'react'
import { getActiveClip, useEditor } from '@/lib/pixelforge/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import {
  AlertTriangle,
  Clapperboard,
  Eraser,
  Film,
  Info,
  Pause,
  Play,
  Plus,
  Square,
  Tag,
  Trash2,
} from 'lucide-react'

/** Canonical role names offered for tagging (plan §4.1); custom names allowed. */
const CANONICAL_ROLES = ['head', 'body', 'armL', 'armR', 'legL', 'legR', 'hair'] as const

const PART_COLORS = ['#2ce8f5', '#a7f070', '#ffcd75', '#ef7d57', '#f4f4f4', '#73eff7', '#b13e53', '#38b764']

interface DraftPart {
  name: string
  layerId: string
  rect?: PartRect
}

/** Composited display buffer for one preview frame (plan + static layers). */
function displayBuffer(
  project: Parameters<typeof composeFrameRgba>[0],
  clip: Parameters<typeof composeFrameRgba>[1],
  anchorFrame: Parameters<typeof composeFrameRgba>[2],
  plan: MotionPlan,
  frameIndex: number
): Uint8ClampedArray {
  const cels = { ...anchorFrame.cels }
  for (const [layerId, buf] of Object.entries(plan.frames[frameIndex].cels)) {
    cels[layerId] = { buffer: buf, linked: false }
  }
  return composeFrameRgba(project, clip, { id: anchorFrame.id, durationMs: 0, cels })
}

export function MotionPanel() {
  const project = useEditor((s) => s.project)
  const activeClipId = useEditor((s) => s.activeClipId)
  const selection = useEditor((s) => s.selection)
  const setRightTab = useEditor((s) => s.setRightTab)
  const setClipParts = useEditor((s) => s.setClipParts)
  const applyMotionPreset = useEditor((s) => s.applyMotionPreset)
  const docVersion = useEditor((s) => s.docVersion)
  const { toast } = useToast()

  const clip = getActiveClip({ project, activeClipId })
  const layerId = clip.layers.at(-1)?.id ?? ''

  // --- source / parts state ------------------------------------------------
  const [anchorIndex, setAnchorIndex] = useState(0)
  const [draftName, setDraftName] = useState('body')
  const [draftRect, setDraftRect] = useState<PartRect>({ x: 8, y: 8, w: 16, h: 16 })
  const [draftWholeLayer, setDraftWholeLayer] = useState(false)
  const [dirtyDraft, setDirtyDraft] = useState(false)

  // --- preview state (declared before the sync effect reads setPlan) --------
  const [plan, setPlan] = useState<MotionPlan | null>(null)
  const [issues, setIssues] = useState<QAIssue[]>([])
  const [playing, setPlaying] = useState(false)
  const [previewIdx, setPreviewIdx] = useState(0)
  const [showOverlay, setShowOverlay] = useState(true)
  const [targetMode, setTargetMode] = useState<'new' | 'overwrite'>('new')
  const [newClipName, setNewClipName] = useState('idle-1')

  // leaving the Motion panel (or unmounting the studio) clears the timeline
  // QA badges coming from the live plan preview
  useEffect(() => {
    return () => {
      useEditor.getState().setMotionPreviewIssues([])
    }
  }, [])

  // draft parts start as a copy of the committed clip parts; draft state is
  // reset whenever the clip or the document changes (render-time adjustment —
  // the React-endorsed pattern for derived-state resets, no sync effect)
  const [draftParts, setDraftParts] = useState<DraftPart[]>([])
  const syncKey = `${clip.id}:${docVersion}`
  const [lastSyncKey, setLastSyncKey] = useState(syncKey)
  if (lastSyncKey !== syncKey) {
    setLastSyncKey(syncKey)
    setDraftParts(clip.parts.map((p) => ({ name: p.name, layerId: p.layerId, ...(p.rect ? { rect: { ...p.rect } } : {}) })))
    setDirtyDraft(false)
    setAnchorIndex((i) => Math.min(i, clip.frames.length - 1))
    setPlan(null)
  }

  // --- preset state ----------------------------------------------------------
  const [presetId, setPresetId] = useState<MotionPresetId>('idle')
  const preset: PresetDef = MOTION_PRESETS[presetId]
  const [params, setParams] = useState<MotionParams>({ ...MOTION_PARAMS_DEFAULTS, frameCount: 4 })
  // switching presets snaps frameCount back to the new preset's default
  const [lastPresetId, setLastPresetId] = useState(presetId)
  if (lastPresetId !== presetId) {
    setLastPresetId(presetId)
    setParams((p) => ({ ...p, frameCount: preset.defaultFrameCount }))
  }

  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const stripRefs = useRef<Array<HTMLCanvasElement | null>>([])

  const anchorFrame = clip.frames[Math.min(anchorIndex, clip.frames.length - 1)]

  // --- preview rendering -----------------------------------------------------
  // plain function — the React Compiler memoizes; no hand-rolled dep arrays
  const renderPlan = () => {
    if (!anchorFrame) return
    let p: MotionPlan
    try {
      p = planMotion(project, clip, { preset: presetId, params, anchorFrameIndex: anchorIndex })
    } catch (err) {
      toast({ title: 'Preview failed', description: err instanceof Error ? err.message : 'Composer error', variant: 'destructive' })
      return
    }
    setPlan(p)
    const planIssues = analyzeMotionPlan(project, clip, p)
    setIssues(planIssues)
    // Phase-1 Task 10 QA: mirror plan issues into the store so the timeline
    // can badge the affected source frames while the preview is live
    useEditor.getState().setMotionPreviewIssues(planIssues)
    setPreviewIdx(0)
    setPlaying(false)
    // the suggested clip name follows the preset; the user can still edit it
    // before accepting (every fresh preview resets it)
    setNewClipName(`${presetId}-${project.clips.length}`)
  }

  // draw the source canvas (anchor composite + part rects overlay)
  useEffect(() => {
    const canvas = sourceCanvasRef.current
    if (!canvas || !anchorFrame) return
    canvas.width = project.width
    canvas.height = project.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const rgba = composeFrameRgba(project, clip, anchorFrame)
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), project.width, project.height), 0, 0)
    if (!showOverlay) return
    // part rects (1px, color per part) + ground line + center axis
    draftParts.forEach((p, i) => {
      const r = p.rect ?? { x: 0, y: 0, w: project.width, h: project.height }
      ctx.strokeStyle = PART_COLORS[i % PART_COLORS.length]
      ctx.lineWidth = 1
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1)
    })
    ctx.strokeStyle = 'rgba(45, 212, 191, 0.55)'
    ctx.beginPath()
    ctx.moveTo(0, project.height - 0.5)
    ctx.lineTo(project.width, project.height - 0.5)
    ctx.moveTo(project.width / 2 + 0.5, 0)
    ctx.lineTo(project.width / 2 + 0.5, project.height)
    ctx.stroke()
  }, [project, clip, anchorFrame, draftParts, showOverlay, docVersion])

  // draw the current preview frame + the strip thumbnails
  useEffect(() => {
    if (!plan || !previewCanvasRef.current) return
    const canvas = previewCanvasRef.current
    canvas.width = project.width
    canvas.height = project.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const rgba = displayBuffer(project, clip, anchorFrame, plan, previewIdx)
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), project.width, project.height), 0, 0)
    // preview frame part rects at their OFFSET positions (visual debugging)
    if (showOverlay) {
      ctx.strokeStyle = 'rgba(45, 212, 191, 0.55)'
      ctx.beginPath()
      ctx.moveTo(0, project.height - 0.5)
      ctx.lineTo(project.width, project.height - 0.5)
      ctx.stroke()
    }
    plan.frames.forEach((f, i) => {
      const c = stripRefs.current[i]
      if (!c) return
      c.width = project.width
      c.height = project.height
      const cctx = c.getContext('2d')
      if (!cctx) return
      const r = displayBuffer(project, clip, anchorFrame, plan, i)
      cctx.putImageData(new ImageData(new Uint8ClampedArray(r), project.width, project.height), 0, 0)
    })
  }, [plan, previewIdx, showOverlay, docVersion])

  // playback timer (clip fps; play-once presets stop on the last frame)
  useEffect(() => {
    if (!playing || !plan) return
    const ms = Math.max(30, Math.round(1000 / clip.fps))
    const t = setInterval(() => {
      setPreviewIdx((i) => {
        const next = i + 1
        if (next >= plan.frames.length) {
          if (preset.playOnceSuggested) {
            setPlaying(false)
            return i
          }
          return 0
        }
        return next
      })
    }, ms)
    return () => clearInterval(t)
  }, [playing, plan, clip.fps, preset])

  // --- actions -----------------------------------------------------------------
  const addDraftPart = () => {
    const name = draftName.trim()
    if (!name) return
    if (draftParts.some((p) => roleKey(p.name) === roleKey(name))) {
      toast({ title: 'Duplicate part name', description: `A part named "${name}" already exists — names are roles.`, variant: 'destructive' })
      return
    }
    if (draftParts.length >= 32) {
      toast({ title: 'Too many parts', description: 'At most 32 parts per clip.', variant: 'destructive' })
      return
    }
    setDraftParts((ps) => [...ps, { name, layerId, ...(draftWholeLayer ? {} : { rect: { ...draftRect } }) }])
    setDirtyDraft(true)
  }

  const useSelectionAsRect = () => {
    if (!selection) {
      toast({ title: 'No selection', description: 'Drag a marquee on the canvas first, then press "Use selection".', variant: 'destructive' })
      return
    }
    setDraftRect({ ...selection })
    setDraftWholeLayer(false)
  }

  const saveParts = () => {
    if (!setClipParts(clip.id, draftParts.map((p) => ({ ...p })))) return
    setDirtyDraft(false)
    toast({ title: 'Parts saved', description: `${draftParts.length} part${draftParts.length === 1 ? '' : 's'} tagged on "${clip.name}".` })
  }

  const accept = () => {
    if (!plan) return
    const target =
      targetMode === 'new'
        ? ({ kind: 'new', name: newClipName.trim() || `${presetId}-clip`, fps: clip.fps } as const)
        : ({ kind: 'existing', clipId: clip.id, overwrite: true } as const)
    const createdClipId = applyMotionPreset({
      sourceClipId: clip.id,
      preset: presetId,
      params: { amplitude: params.amplitude, frameCount: plan.report.frameCount, gapFill: params.gapFill, smear: params.smear },
      anchorFrameIndex: anchorIndex,
      target,
    })
    if (!createdClipId) return
    const skipped = plan.report.skipped.length
    toast({
      title: 'Motion applied',
      description:
        targetMode === 'new'
          ? `New clip "${target.kind === 'new' ? target.name : ''}" created with ${plan.report.frameCount} frames.${skipped ? ` ${skipped} absent role(s) skipped.` : ''}`
          : `${plan.report.frameCount} frame${plan.report.frameCount === 1 ? '' : 's'} of "${clip.name}" rewritten (undoable).`,
    })
    setPlan(null)
    setIssues([])
    useEditor.getState().setMotionPreviewIssues([])
    setPlaying(false)
    if (targetMode === 'new' && createdClipId) {
      const st = useEditor.getState()
      const created = st.project.clips.find((c) => c.id === createdClipId)
      useEditor.setState({
        activeClipId: createdClipId,
        activeFrameIndex: 0,
        activeLayerId: created?.layers.at(-1)?.id ?? st.activeLayerId,
      })
    }
  }

  // --- dev probe for browser smokes (mirrors window.__pfAi discipline) ----------
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__pfMotion = {
      draftParts: () => draftParts.length,
      savedParts: () => clip.parts.map((p) => ({ name: p.name, rect: p.rect ?? null })),
      tagPart: (name: string, rect?: PartRect) =>
        setDraftParts((ps) => [...ps, { name, layerId, ...(rect ? { rect } : {}) }]),
      saveParts,
      selectPreset: (id: string) => {
        if ((PRESET_IDS as string[]).includes(id)) setPresetId(id as MotionPresetId)
      },
      setParam: (k: 'amplitude' | 'frameCount' | 'gapFill' | 'smear', v: number | string | boolean) =>
        setParams((p) => ({ ...p, [k]: v } as MotionParams)),
      preview: renderPlan,
      report: () => plan?.report ?? null,
      issues: () => issues,
      setTarget: (m: 'new' | 'overwrite') => setTargetMode(m),
      accept,
    }
    return () => {
      delete w.__pfMotion
    }
  })

  // --------------------------------------------------------------------------------
  if (!anchorFrame) {
    return <div className="p-4 text-xs text-zinc-500">This clip has no frames.</div>
  }

  return (
    <div className="pixelforge-scroll mx-auto min-h-0 w-full max-w-[520px] flex-1 space-y-3 overflow-y-auto p-3" data-testid="motion-panel">
      {/* ---------------------------- source ---------------------------- */}
      <section aria-label="Source" className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
        <header className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-teal-300">
          <Film className="h-3 w-3" /> Source
        </header>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium text-zinc-200">{clip.name}</span>
          <div className="flex items-center gap-1">
            <span className="font-mono text-[10px] text-zinc-500">anchor</span>
            <Select value={String(anchorIndex)} onValueChange={(v) => setAnchorIndex(Number(v))}>
              <SelectTrigger className="h-6 w-[70px] font-mono text-[11px]" aria-label="Anchor frame">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-48">
                {clip.frames.map((f, i) => (
                  <SelectItem key={f.id} value={String(i)} className="font-mono text-[11px]">
                    {i + 1}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="mt-1 font-mono text-[10px] text-zinc-500">
          every frame derives from frame {anchorIndex + 1} (R5) · {clip.fps} fps
        </p>
      </section>

      {/* ---------------------------- parts ---------------------------- */}
      <section aria-label="Body parts" className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
        <header className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-teal-300">
            <Tag className="h-3 w-3" /> Parts ({draftParts.length})
          </span>
          {dirtyDraft && (
            <div className="flex gap-1">
              <Button size="sm" className="h-6 bg-teal-600 px-2 font-mono text-[10px] hover:bg-teal-500" onClick={saveParts}>
                Save parts
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 font-mono text-[10px] text-zinc-400"
                onClick={() => {
                  setDraftParts(clip.parts.map((p) => ({ name: p.name, layerId: p.layerId, ...(p.rect ? { rect: { ...p.rect } } : {}) })))
                  setDirtyDraft(false)
                }}
              >
                Revert
              </Button>
            </div>
          )}
        </header>

        {/* source preview with part rects */}
        <div className="mb-2 flex gap-2">
          <canvas
            ref={sourceCanvasRef}
            className="h-[96px] w-[96px] shrink-0 rounded border border-zinc-700 bg-zinc-950"
            style={{ imageRendering: 'pixelated' }}
            aria-label="Anchor frame with part rectangles"
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-mono text-[10px] leading-tight text-zinc-500">
              Regions only — never cuts. Overlaps are owned by the highest-z part (R2).
            </p>
            <div className="flex flex-wrap gap-1">
              {draftParts.map((p, i) => (
                <span
                  key={`${p.name}-${i}`}
                  className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
                >
                  <span className="h-2 w-2 rounded-sm" style={{ background: PART_COLORS[i % PART_COLORS.length] }} />
                  {p.name}
                  <button
                    className="text-zinc-500 hover:text-red-400"
                    aria-label={`Remove part ${p.name}`}
                    onClick={() => {
                      setDraftParts((ps) => ps.filter((_, j) => j !== i))
                      setDirtyDraft(true)
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {draftParts.length === 0 && (
                <span className="font-mono text-[10px] text-zinc-600">no parts tagged yet</span>
              )}
            </div>
          </div>
        </div>

        {/* tag controls */}
        <div className="space-y-2 rounded border border-zinc-800 bg-zinc-950/60 p-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="font-mono text-[10px] text-zinc-400">Part name</Label>
              <Select value={draftName} onValueChange={setDraftName}>
                <SelectTrigger className="h-7 font-mono text-[11px]" aria-label="Part name">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-48">
                  {CANONICAL_ROLES.map((r) => (
                    <SelectItem key={r} value={r} className="font-mono text-[11px]">
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="font-mono text-[10px] text-zinc-400">Region</Label>
              <div className="flex gap-1">
                <Input
                  className="h-7 font-mono text-[11px]"
                  aria-label="Rect x"
                  type="number"
                  min={0}
                  max={project.width - 1}
                  value={draftRect.x}
                  disabled={draftWholeLayer}
                  onChange={(e) => setDraftRect((r) => ({ ...r, x: Number(e.target.value) }))}
                />
                <Input
                  className="h-7 font-mono text-[11px]"
                  aria-label="Rect y"
                  type="number"
                  min={0}
                  max={project.height - 1}
                  value={draftRect.y}
                  disabled={draftWholeLayer}
                  onChange={(e) => setDraftRect((r) => ({ ...r, y: Number(e.target.value) }))}
                />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="font-mono text-[10px] text-zinc-400">Width</Label>
              <Input
                className="h-7 font-mono text-[11px]"
                aria-label="Rect width"
                type="number"
                min={1}
                max={project.width}
                value={draftRect.w}
                disabled={draftWholeLayer}
                onChange={(e) => setDraftRect((r) => ({ ...r, w: Number(e.target.value) }))}
              />
            </div>
            <div>
              <Label className="font-mono text-[10px] text-zinc-400">Height</Label>
              <Input
                className="h-7 font-mono text-[11px]"
                aria-label="Rect height"
                type="number"
                min={1}
                max={project.height}
                value={draftRect.h}
                disabled={draftWholeLayer}
                onChange={(e) => setDraftRect((r) => ({ ...r, h: Number(e.target.value) }))}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="outline" className="h-7 gap-1 border-zinc-700 px-2 font-mono text-[10px] hover:border-teal-500 hover:text-teal-300" onClick={useSelectionAsRect}>
              <Square className="h-3 w-3" /> Use selection
            </Button>
            <label className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-400">
              <Switch checked={draftWholeLayer} onCheckedChange={setDraftWholeLayer} className="scale-90" aria-label="Whole layer part" />
              whole layer
            </label>
            <Button size="sm" className="h-7 gap-1 bg-teal-600 px-2 font-mono text-[10px] hover:bg-teal-500" onClick={addDraftPart}>
              <Plus className="h-3 w-3" /> Tag part
            </Button>
          </div>
        </div>
      </section>

      {/* ---------------------------- preset ---------------------------- */}
      <section aria-label="Motion preset" className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
        <header className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-teal-300">
          <Clapperboard className="h-3 w-3" /> Preset
        </header>
        <div className="mb-2 grid grid-cols-5 gap-1">
          {PRESET_IDS.map((id) => (
            <button
              key={id}
              onClick={() => setPresetId(id)}
              aria-pressed={presetId === id}
              className={`rounded px-1 py-1.5 font-mono text-[10px] capitalize transition-colors ${
                presetId === id
                  ? 'bg-teal-600 text-white'
                  : 'bg-zinc-950 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              }`}
            >
              {id}
            </button>
          ))}
        </div>
        <p className="mb-2 font-mono text-[10px] leading-tight text-zinc-500">{preset.description}</p>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="font-mono text-[10px] text-zinc-400">Frames</Label>
            <Select
              value={String(params.frameCount || preset.defaultFrameCount)}
              onValueChange={(v) => setParams((p) => ({ ...p, frameCount: Number(v) }))}
            >
              <SelectTrigger className="h-7 font-mono text-[11px]" aria-label="Frame count">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {preset.frameCounts.map((n) => (
                  <SelectItem key={n} value={String(n)} className="font-mono text-[11px]">
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="font-mono text-[10px] text-zinc-400">Gap fill</Label>
            <Select
              value={params.gapFill}
              onValueChange={(v) => setParams((p) => ({ ...p, gapFill: v as MotionParams['gapFill'] }))}
            >
              <SelectTrigger className="h-7 font-mono text-[11px]" aria-label="Gap fill mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="font-mono text-[11px]">none (leave gaps)</SelectItem>
                <SelectItem value="edge-extend" className="font-mono text-[11px]">edge-extend (recommended)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-2">
          <Label className="flex items-center justify-between font-mono text-[10px] text-zinc-400">
            amplitude <span className="text-teal-300">{params.amplitude.toFixed(2)}×</span>
          </Label>
          <Slider
            value={[params.amplitude]}
            min={0.25}
            max={3}
            step={0.25}
            onValueChange={([v]) => setParams((p) => ({ ...p, amplitude: v }))}
            aria-label="Amplitude"
            className="mt-1"
          />
        </div>
        {presetId === 'attack' && (
          <label className="mt-2 flex items-center justify-between font-mono text-[10px] text-zinc-400">
            1-px smear frame (swing)
            <Switch checked={params.smear} onCheckedChange={(v) => setParams((p) => ({ ...p, smear: v }))} aria-label="Smear frame" />
          </label>
        )}
        {preset.playOnceSuggested && (
          <p className="mt-2 font-mono text-[10px] text-amber-400/80">
            {preset.label} is play-once — set the clip loop off (Layers → clip props) for correct playback.
          </p>
        )}

        <div className="mt-2 flex gap-2">
          <Button className="h-8 flex-1 gap-1.5 bg-teal-600 font-mono text-[11px] hover:bg-teal-500" onClick={renderPlan}>
            <Play className="h-3.5 w-3.5" /> Generate preview
          </Button>
          <Button
            variant="outline"
            className="h-8 gap-1 border-zinc-700 px-2 font-mono text-[10px] hover:border-teal-500 hover:text-teal-300"
            onClick={() => setShowOverlay((v) => !v)}
            aria-pressed={showOverlay}
            title="Ground line + center axis + part rects"
          >
            anchors {showOverlay ? 'on' : 'off'}
          </Button>
        </div>
      </section>

      {/* ---------------------------- preview ---------------------------- */}
      {plan && (
        <section aria-label="Preview" className="rounded-lg border border-teal-900/60 bg-zinc-900/60 p-3">
          <header className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-teal-300">
              <Clapperboard className="h-3 w-3" /> Preview — not committed
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-zinc-300 hover:text-teal-300"
                onClick={() => setPlaying((v) => !v)}
                aria-label={playing ? 'Pause preview' : 'Play preview'}
              >
                {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
              <span className="font-mono text-[10px] text-zinc-500">
                {previewIdx + 1}/{plan.frames.length}
              </span>
            </div>
          </header>

          <div className="flex gap-2">
            <figure className="shrink-0">
              <canvas
                ref={previewCanvasRef}
                className="h-[96px] w-[96px] rounded border border-zinc-700 bg-zinc-950"
                style={{ imageRendering: 'pixelated' }}
                aria-label={`Generated frame ${previewIdx + 1}`}
              />
              <figcaption className="mt-0.5 text-center font-mono text-[9px] text-teal-400/80">frame {previewIdx + 1}</figcaption>
            </figure>
            <figure className="shrink-0">
              <canvas
                className="h-[96px] w-[96px] rounded border border-zinc-800 bg-zinc-950"
                style={{ imageRendering: 'pixelated' }}
                ref={(c) => {
                  // static source thumbnail for A/B compare
                  if (c && anchorFrame) {
                    c.width = project.width
                    c.height = project.height
                    const ctx = c.getContext('2d')
                    if (ctx) {
                      ctx.putImageData(
                        new ImageData(new Uint8ClampedArray(composeFrameRgba(project, clip, anchorFrame)), project.width, project.height),
                        0,
                        0
                      )
                    }
                  }
                }}
                aria-label="Source anchor frame"
              />
              <figcaption className="mt-0.5 text-center font-mono text-[9px] text-zinc-500">source {anchorIndex + 1}</figcaption>
            </figure>
            <div className="pixelforge-scroll flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1">
              {plan.frames.map((_, i) => (
                <button key={i} onClick={() => { setPreviewIdx(i); setPlaying(false) }} aria-label={`Show frame ${i + 1}`} className="shrink-0">
                  <canvas
                    ref={(c) => { stripRefs.current[i] = c }}
                    className={`h-[44px] w-[44px] rounded border bg-zinc-950 ${i === previewIdx ? 'border-teal-400' : 'border-zinc-800'}`}
                    style={{ imageRendering: 'pixelated' }}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* QA issues */}
          <ul className="mt-2 space-y-1" aria-label="Quality checks">
            {issues.map((iss, i) => (
              <li key={`${iss.code}-${i}`} className={`flex items-start gap-1.5 rounded px-1.5 py-1 font-mono text-[10px] leading-tight ${iss.level === 'warning' ? 'bg-amber-500/10 text-amber-300' : 'bg-zinc-800/60 text-zinc-400'}`}>
                {iss.level === 'warning' ? <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> : <Info className="mt-0.5 h-3 w-3 shrink-0" />}
                <span>{iss.message}</span>
              </li>
            ))}
            {issues.length === 0 && (
              <li className="flex items-center gap-1.5 rounded bg-emerald-500/10 px-1.5 py-1 font-mono text-[10px] text-emerald-300">
                <Info className="h-3 w-3" /> QA clean — no flicker, gaps or overlap issues detected.
              </li>
            )}
          </ul>

          {/* skipped roles (C27 report) */}
          {plan.report.skipped.length > 0 && (
            <p className="mt-1 font-mono text-[10px] text-zinc-500">
              skipped roles: {plan.report.skipped.map((s) => s.role).join(', ')} (not tagged on this clip)
            </p>
          )}

          {/* commit target */}
          <div className="mt-3 space-y-2 rounded border border-zinc-800 bg-zinc-950/60 p-2">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-300">
                <input type="radio" checked={targetMode === 'new'} onChange={() => setTargetMode('new')} className="accent-teal-500" />
                new clip
              </label>
              {targetMode === 'new' && (
                <Input
                  className="h-7 flex-1 font-mono text-[11px]"
                  value={newClipName}
                  onChange={(e) => setNewClipName(e.target.value)}
                  aria-label="New clip name"
                  placeholder="clip name"
                />
              )}
            </div>
            <label className="flex items-start gap-1.5 font-mono text-[10px] text-zinc-300">
              <input type="radio" checked={targetMode === 'overwrite'} onChange={() => setTargetMode('overwrite')} className="mt-0.5 accent-teal-500" />
              <span>
                overwrite {Math.min(plan.report.frameCount, clip.frames.length)} frame
                {Math.min(plan.report.frameCount, clip.frames.length) === 1 ? '' : 's'} of "{clip.name}"
                <span className="block text-zinc-500">
                  requires overwrite — extra frames stay untouched, missing frames become holds (R6)
                </span>
              </span>
            </label>
          </div>

          <div className="mt-2 flex gap-2">
            <Button className="h-8 flex-1 bg-teal-600 font-mono text-[11px] hover:bg-teal-500" onClick={accept}>
              Accept &amp; create {targetMode === 'new' ? 'clip' : 'frames'}
            </Button>
            <Button
              variant="outline"
              className="h-8 gap-1 border-zinc-700 px-3 font-mono text-[11px] hover:border-red-500 hover:text-red-400"
              onClick={() => { setPlan(null); setIssues([]); setPlaying(false) }}
            >
              <Eraser className="h-3.5 w-3.5" /> Discard
            </Button>
          </div>
        </section>
      )}

      <p className="px-1 font-mono text-[10px] leading-tight text-zinc-600">
        deterministic composer · integer pixels · no interpolation · source colors preserved · $0
      </p>
    </div>
  )
}
