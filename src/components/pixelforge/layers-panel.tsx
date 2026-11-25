// PixelForge AI — layers panel (per-clip layer stack + per-frame cels, v2)

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  SPRITE_TEMPLATES,
  analyzePixelCraft,
  composeFrameRgba,
  renderSpriteTemplate,
  type PixelCraftReport,
  type SpriteTemplateId,
} from '@pixelforge/core'
import { useEditor, getActiveFrame, getActiveClip } from '@/lib/pixelforge/store'
import { useToast } from '@/hooks/use-toast'
import type { Cel, Clip, Frame, Layer } from '@/lib/pixelforge/types'
import { renderCelScaled, renderFrameScaled } from '@/lib/pixelforge/render'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const BLEND_MODES: Array<{ value: string; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
]
import {
  Eye,
  EyeOff,
  Plus,
  Trash2,
  Copy,
  Merge,
  ArrowUp,
  ArrowDown,
  Lock,
  LockOpen,
  Link2,
  Unlink2,
  GripVertical,
  Sparkles,
  ScanSearch,
  Crosshair,
  Crop,
  Pin,
  Anchor,
  LayoutTemplate,
} from 'lucide-react'

function TemplatePreviewThumb({ templateId, palette }: { templateId: SpriteTemplateId; palette: readonly string[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const rendered = renderSpriteTemplate(templateId, 32, 32, palette)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, 32, 32)
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rendered.buffer), 32, 32), 0, 0)
  }, [templateId, palette])
  return (
    <canvas
      ref={ref}
      width={32}
      height={32}
      className="pixelforge-checker h-9 w-9 shrink-0 rounded border border-zinc-700/80"
      style={{ imageRendering: 'pixelated' }}
      aria-hidden
    />
  )
}

function LayerThumb({
  layer,
  cel,
  w,
  h,
  tick,
}: {
  layer: Layer
  cel: Cel | undefined
  w: number
  h: number
  tick: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    renderCelScaled(canvas, layer, cel, w, h)
  }, [layer, cel, w, h, tick])
  return (
    <canvas
      ref={ref}
      width={28}
      height={28}
      className="pixelforge-checker h-7 w-7 shrink-0 rounded-sm border border-zinc-700"
      aria-hidden
    />
  )
}

function FrameChip({
  clip,
  frame,
  index,
  active,
  w,
  h,
  tick,
  onClick,
  onDragStartFrame,
  onDropFrame,
  dropBefore,
}: {
  clip: Clip
  frame: Frame
  index: number
  active: boolean
  w: number
  h: number
  tick: number
  onClick: () => void
  /** drag source: registers which frame (clipId + index) started the drag */
  onDragStartFrame: (clipId: string, index: number) => void
  /** drop target: reorder within a clip, or copy across clips */
  onDropFrame: (targetClipId: string, targetIndex: number) => void
  /** visual: this chip is the current drop insertion point */
  dropBefore: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    renderFrameScaled(canvas, clip, frame, w, h)
  }, [clip, frame, w, h, tick])
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/pixelforge-frame', `${clip.id}:${index}`)
            onDragStartFrame(clip.id, index)
          }}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }}
          onDrop={(e) => {
            e.preventDefault()
            onDropFrame(clip.id, index)
          }}
          className={`relative shrink-0 rounded border p-0.5 transition-colors ${
            active
              ? 'border-teal-400 bg-teal-500/10 ring-1 ring-teal-400/50'
              : 'border-zinc-700 bg-zinc-900 hover:border-zinc-500'
          } ${dropBefore ? 'ring-2 ring-teal-400/70' : ''}`}
          aria-label={`Frame ${index + 1}${dropBefore ? ' (drop target)' : ''}`}
          aria-pressed={active}
        >
          <canvas
            ref={ref}
            width={28}
            height={28}
            className="pixelforge-checker h-7 w-7 rounded-sm"
            aria-hidden
          />
          <span className="absolute bottom-0 right-0.5 font-mono text-[9px] text-zinc-200">{index + 1}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Frame {index + 1} — drag to reorder or copy to another clip</TooltipContent>
    </Tooltip>
  )
}

export function LayersPanel() {
  const project = useEditor((s) => s.project)
  const activeClipId = useEditor((s) => s.activeClipId)
  const renderTick = useEditor((s) => s.renderTick)
  const activeFrameIndex = useEditor((s) => s.activeFrameIndex)
  const activeLayerId = useEditor((s) => s.activeLayerId)
  const selectLayer = useEditor((s) => s.selectLayer)
  const selectFrame = useEditor((s) => s.selectFrame)
  const addFrame = useEditor((s) => s.addFrame)
  const addLayer = useEditor((s) => s.addLayer)
  const deleteLayer = useEditor((s) => s.deleteLayer)
  const duplicateLayer = useEditor((s) => s.duplicateLayer)
  const mergeDown = useEditor((s) => s.mergeDown)
  const moveLayer = useEditor((s) => s.moveLayer)
  const reorderLayer = useEditor((s) => s.reorderLayer)
  const setLayerProp = useEditor((s) => s.setLayerProp)
  const setLayerLinked = useEditor((s) => s.setLayerLinked)
  const polishLayer = useEditor((s) => s.polishLayer)
  const centerContent = useEditor((s) => s.centerContent)
  const autoTrimCanvas = useEditor((s) => s.autoTrimCanvas)
  const setCraftPins = useEditor((s) => s.setCraftPins)
  const applySpriteTemplate = useEditor((s) => s.applySpriteTemplate)
  const pinStyleAnchor = useEditor((s) => s.pinStyleAnchor)
  const clearStyleAnchor = useEditor((s) => s.clearStyleAnchor)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [autoTagTemplateParts, setAutoTagTemplateParts] = useState(true)
  const [anchorOpen, setAnchorOpen] = useState(false)
  const [anchorLabel, setAnchorLabel] = useState('')
  const dragFrame = useEditor((s) => s.dragFrame)
  const { toast } = useToast()
  const [renaming, setRenaming] = useState<string | null>(null)
  // Pro Pixel Craft UI popovers (Polish Layer + Craft Check + Auto-Trim)
  const [polishOpen, setPolishOpen] = useState(false)
  const [polishSelOut, setPolishSelOut] = useState(true)
  const [polishShade, setPolishShade] = useState(true)
  const [polishHighlight, setPolishHighlight] = useState(false)
  const [polishCleanDoubles, setPolishCleanDoubles] = useState(true)
  const [polishPaletteLock, setPolishPaletteLock] = useState(true)
  const [craftOpen, setCraftOpen] = useState(false)
  const [craftPinned, setCraftPinned] = useState(false)
  const [trimOpen, setTrimOpen] = useState(false)
  const [trimPad, setTrimPad] = useState<0 | 1 | 2 | 4>(1)
  // frame drag-and-drop: source (clipId+index) + current drop insertion point
  const [dragSrc, setDragSrc] = useState<{ clipId: string; index: number } | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overRow, setOverRow] = useState<number | null>(null)

  const frame = getActiveFrame(useEditor.getState())
  const clip = getActiveClip(useEditor.getState())
  const layers = [...clip.layers].reverse() // top first
  const active = clip.layers.find((l) => l.id === activeLayerId) ?? clip.layers.at(-1)

  const craftReport = useMemo<PixelCraftReport | null>(() => {
    if (!craftOpen && !craftPinned) return null
    return analyzePixelCraft({
      buffer: composeFrameRgba(project, clip, frame),
      width: project.width,
      height: project.height,
      lighting: project.settings.styleProfile?.lighting ?? 'top-left',
    })
  }, [craftOpen, craftPinned, project, clip, frame, renderTick])

  // Sync live Craft Check defect locations directly onto the canvas stage
  useEffect(() => {
    if (!craftReport || (!craftOpen && !craftPinned)) {
      setCraftPins([])
      return
    }
    const pins: Array<{ kind: 'doubles' | 'orphans' | 'jaggies'; x: number; y: number }> = []
    for (const d of craftReport.defects) {
      if (d.kind === 'doubles' || d.kind === 'orphans' || d.kind === 'jaggies') {
        for (const loc of d.locations) pins.push({ kind: d.kind, x: loc.x, y: loc.y })
      }
    }
    setCraftPins(pins)
  }, [craftReport, craftOpen, craftPinned, setCraftPins])

  useEffect(() => () => setCraftPins([]), [setCraftPins])

  return (
    <TooltipProvider delayDuration={200}>
      {/* column scrolls when the viewport is too short for the fixed blocks
          (header + frames + opacity + footer) — keeps the layer list usable */}
      <div className="pixelforge-scroll flex h-full flex-col overflow-x-hidden overflow-y-auto pb-2">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <span className="font-mono text-xs uppercase tracking-wider text-zinc-300">
            Layers · {clip.layers.length} layer{clip.layers.length === 1 ? '' : 's'}
          </span>
          <div className="flex items-center gap-0.5">
            {/* Starter Sprite Templates Popover (v0.4.0) */}
            <Popover open={templateOpen} onOpenChange={setTemplateOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-zinc-400 hover:text-teal-300"
                      aria-label="Insert starter sprite template"
                    >
                      <LayoutTemplate className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">Starter sprite templates</TooltipContent>
              </Tooltip>
              <PopoverContent side="left" align="start" className="w-64 space-y-2.5 border-zinc-800 bg-zinc-950 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-200">
                    Starter Templates
                  </span>
                  <span className="font-mono text-[9px] text-zinc-500">
                    {project.width}×{project.height}
                  </span>
                </div>
                <p className="font-mono text-[9px] leading-snug text-zinc-400">
                  Clean palette-locked base silhouettes ready for detailing or Motion animation.
                </p>
                <div className="grid max-h-60 grid-cols-2 gap-1.5 overflow-y-auto pr-0.5">
                  {SPRITE_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => {
                        const res = applySpriteTemplate(tpl.id, { autoTagParts: autoTagTemplateParts })
                        if (res) {
                          toast({
                            title: `Inserted ${res.name}`,
                            description:
                              res.partsCount > 0
                                ? `Palette-locked layer + ${res.partsCount} Motion parts tagged (craft ${res.craftScore}/100).`
                                : `Palette-locked starter layer created (craft ${res.craftScore}/100).`,
                          })
                          setTemplateOpen(false)
                        }
                      }}
                      className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/70 p-1.5 text-left transition hover:border-teal-500/50 hover:bg-zinc-900"
                    >
                      <TemplatePreviewThumb templateId={tpl.id} palette={project.palette} />
                      <div className="min-w-0">
                        <div className="truncate text-[10px] font-medium text-zinc-100">{tpl.name}</div>
                        <div className="font-mono text-[8px] uppercase text-zinc-500">
                          {tpl.category}
                          {tpl.hasMotionParts ? ' · rig' : ''}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
                <label className="flex cursor-pointer items-center justify-between border-t border-zinc-800/80 pt-2 font-mono text-[9px] text-zinc-400">
                  <span>Auto-tag Motion body parts</span>
                  <input
                    type="checkbox"
                    checked={autoTagTemplateParts}
                    onChange={(e) => setAutoTagTemplateParts(e.target.checked)}
                    className="h-3.5 w-3.5 accent-teal-500"
                  />
                </label>
              </PopoverContent>
            </Popover>

            {/* Hero Sprite Style Anchor Popover (v0.4.0) */}
            <Popover
              open={anchorOpen}
              onOpenChange={(open) => {
                setAnchorOpen(open)
                if (open && !anchorLabel) {
                  setAnchorLabel(project.settings.styleProfile?.anchor?.label ?? project.name)
                }
              }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`h-7 w-7 ${
                        project.settings.styleProfile?.anchor
                          ? 'bg-teal-500/15 text-teal-300'
                          : 'text-zinc-400 hover:text-zinc-100'
                      }`}
                      aria-label="Hero sprite style anchor"
                      aria-pressed={Boolean(project.settings.styleProfile?.anchor)}
                    >
                      <Anchor className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {project.settings.styleProfile?.anchor
                    ? `Hero Style Anchor: ${project.settings.styleProfile.anchor.label}`
                    : 'Pin current frame as Hero Style Anchor'}
                </TooltipContent>
              </Tooltip>
              <PopoverContent side="left" align="start" className="w-64 space-y-2.5 border-zinc-800 bg-zinc-950 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-200">
                    Hero Style Anchor
                  </span>
                  {project.settings.styleProfile?.anchor && (
                    <span className="rounded bg-teal-500/15 px-1.5 py-0.5 font-mono text-[9px] text-teal-300">
                      pinned
                    </span>
                  )}
                </div>
                <p className="font-mono text-[9px] leading-snug text-zinc-400">
                  Locks sprite height, ground margin, outline style, and palette metrics for all paired AI IDEs.
                </p>
                {project.settings.styleProfile?.anchor && (
                  <div className="space-y-1.5 rounded border border-zinc-800 bg-zinc-900/70 p-2 font-mono text-[9px]">
                    <div className="truncate font-semibold text-zinc-100">
                      {project.settings.styleProfile.anchor.label}
                    </div>
                    <div className="grid grid-cols-2 gap-1 text-zinc-400">
                      <span>
                        Size: <strong className="text-zinc-200">{project.settings.styleProfile.anchor.spriteWidth}×{project.settings.styleProfile.anchor.spriteHeight}</strong>
                      </span>
                      <span>
                        Ground: <strong className="text-zinc-200">{project.settings.styleProfile.anchor.bottomMargin}px</strong>
                      </span>
                      <span>
                        Outline: <strong className="text-zinc-200">{project.settings.styleProfile.anchor.outlineStyle}</strong>
                      </span>
                      <span>
                        Craft: <strong className="text-teal-300">{project.settings.styleProfile.anchor.craftScore}/100</strong>
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-0.5 pt-0.5">
                      {project.settings.styleProfile.anchor.paletteUsed.slice(0, 12).map((hex) => (
                        <span
                          key={hex}
                          className="h-3 w-3 rounded-[2px] border border-white/15"
                          style={{ backgroundColor: hex }}
                          title={hex}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <Input
                  value={anchorLabel}
                  onChange={(e) => setAnchorLabel(e.target.value)}
                  placeholder="Hero label (e.g. Knight Hero)"
                  aria-label="Hero style anchor label"
                  className="h-7 border-zinc-800 bg-zinc-900 px-2 font-mono text-[10px]"
                />
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    className="h-7 flex-1 bg-teal-600 font-mono text-[10px] text-white hover:bg-teal-500"
                    onClick={() => {
                      const res = pinStyleAnchor(anchorLabel)
                      if (res) {
                        toast({
                          title: `Pinned "${res.label}"`,
                          description: `Locked ${res.spriteWidth}×${res.spriteHeight}px (${res.outlineStyle}, ${res.bottomMargin}px ground margin) for AI IDEs.`,
                        })
                        setAnchorOpen(false)
                      }
                    }}
                  >
                    <Anchor className="mr-1 h-3 w-3" />
                    {project.settings.styleProfile?.anchor ? 'Update Anchor' : 'Pin Frame'}
                  </Button>
                  {project.settings.styleProfile?.anchor && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 border-zinc-700 font-mono text-[10px] text-zinc-300 hover:bg-zinc-800"
                      onClick={() => {
                        clearStyleAnchor()
                        toast({ title: 'Style anchor unpinned' })
                        setAnchorOpen(false)
                      }}
                    >
                      Unpin
                    </Button>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-300 hover:text-zinc-100" onClick={addLayer} aria-label="Add layer">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* frames in this clip — pick a frame to see its layer cells below */}
        <div className="border-b border-zinc-800 px-3 py-2">
          <div className="mb-1 flex items-center justify-between px-0">
            <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">
              Frames · {clip.frames.length}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-zinc-300 hover:text-zinc-100"
              onClick={() => addFrame(false)}
              aria-label="Add empty frame after current"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            {clip.frames.map((f, i) => (
              <FrameChip
                key={f.id}
                clip={clip}
                frame={f}
                index={i}
                active={i === Math.min(activeFrameIndex, clip.frames.length - 1)}
                w={project.width}
                h={project.height}
                tick={renderTick}
                onClick={() => selectFrame(i)}
                onDragStartFrame={(clipId, idx) => setDragSrc({ clipId, index: idx })}
                onDropFrame={(targetClipId, targetIndex) => {
                  if (dragSrc) {
                    dragFrame(dragSrc.clipId, dragSrc.index, targetClipId, targetIndex)
                    toast({
                      title: dragSrc.clipId === targetClipId ? 'Frame moved' : 'Frame copied to clip',
                      description: dragSrc.clipId === targetClipId ? `Frame ${dragSrc.index + 1} → position ${targetIndex + 1}.` : `Frame ${dragSrc.index + 1} inserted at position ${targetIndex + 1}.`,
                    })
                  }
                  setDragSrc(null)
                  setDropIdx(null)
                }}
                dropBefore={dropIdx === i && !!dragSrc}
              />
            ))}
          </div>
        </div>

        {/* min-h floor: flex-1 + min-h-0 lets short viewports collapse this list
            to 0px, hiding the layer rows entirely (audit bug #3) */}
        <div className="pixelforge-scroll min-h-[76px] flex-1 overflow-y-auto">
          {layers.map((layer, row) => {
            const isActive = layer.id === active?.id
            return (
              <div
                key={layer.id}
                draggable
                onDragStart={(e) => {
                  setDragId(layer.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setOverRow(row)
                }}
                onDragLeave={() => setOverRow((cur) => (cur === row ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault()
                  // rows render top-first; the stack index runs bottom-up
                  if (dragId && dragId !== layer.id) reorderLayer(dragId, layers.length - 1 - row)
                  setDragId(null)
                  setOverRow(null)
                }}
                className={`group flex cursor-pointer items-center gap-2 border-b border-zinc-800/60 px-3 py-1.5 ${
                  isActive ? 'bg-teal-500/10' : 'hover:bg-zinc-900'
                } ${dragId === layer.id ? 'opacity-40' : ''} ${
                  overRow === row && dragId && dragId !== layer.id ? 'border-t-2 border-t-zinc-300' : ''
                }`}
                onClick={() => selectLayer(layer.id)}
                role="button"
                aria-pressed={isActive}
              >
                <GripVertical className="h-3.5 w-3 shrink-0 cursor-grab text-zinc-600" aria-hidden />
                <button
                  type="button"
                  className="text-zinc-400 hover:text-zinc-100"
                  onClick={(e) => {
                    e.stopPropagation()
                    setLayerProp(layer.id, { visible: !layer.visible })
                  }}
                  aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
                >
                  {layer.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 text-zinc-400" />}
                </button>
                <LayerThumb layer={layer} cel={frame.cels[layer.id]} w={project.width} h={project.height} tick={renderTick} />
                {renaming === layer.id ? (
                  <Input
                    autoFocus
                    defaultValue={layer.name}
                    className="h-6 border-zinc-700 bg-zinc-900 text-xs"
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      setLayerProp(layer.id, { name: e.target.value || layer.name })
                      setRenaming(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                  />
                ) : (
                  <span
                    className="flex min-w-0 flex-1 items-center gap-1 truncate font-mono text-xs text-zinc-300"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setRenaming(layer.id)
                    }}
                    title={`${layer.name} — double-click to rename`}
                  >
                    <span className="truncate">{layer.name}</span>
                    {layer.linked && (
                      <span
                        className="shrink-0 rounded bg-teal-500/20 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-teal-300"
                        title="Linked cel: shared across all frames"
                      >
                        link
                      </span>
                    )}
                  </span>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={`shrink-0 ${
                        layer.linked
                          ? 'text-teal-400'
                          : 'text-zinc-600 opacity-0 transition-opacity hover:text-zinc-300 group-hover:opacity-100'
                      }`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setLayerLinked(layer.id, !layer.linked)
                      }}
                      aria-label={layer.linked ? `Unlink ${layer.name} (separate cel per frame)` : `Link ${layer.name} (cel shared across all frames)`}
                      aria-pressed={!!layer.linked}
                    >
                      {layer.linked ? <Link2 className="h-3.5 w-3.5" /> : <Unlink2 className="h-3.5 w-3.5" />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {layer.linked ? 'Linked — cel shared across all frames (click to unlink)' : 'Link cel across all frames'}
                  </TooltipContent>
                </Tooltip>
                <button
                  type="button"
                  className={`shrink-0 ${layer.locked ? 'text-amber-400/90' : 'text-zinc-600 opacity-0 transition-opacity hover:text-zinc-300 group-hover:opacity-100'}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setLayerProp(layer.id, { locked: !layer.locked })
                  }}
                  aria-label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`}
                  aria-pressed={!!layer.locked}
                >
                  {layer.locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
                </button>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="w-7 shrink-0 text-right font-mono text-[10px] text-zinc-400 hover:text-zinc-200"
                      aria-label={`Opacity of ${layer.name} — click to adjust`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {Math.round(layer.opacity * 100)}%
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="left" align="center" className="w-44 p-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Opacity</p>
                      <span className="font-mono text-[10px] text-zinc-300">{Math.round(layer.opacity * 100)}%</span>
                    </div>
                    <Slider
                      value={[Math.round(layer.opacity * 100)]}
                      min={0}
                      max={100}
                      step={5}
                      onValueChange={(v) => setLayerProp(layer.id, { opacity: (v[0] ?? 100) / 100 })}
                      aria-label={`${layer.name} opacity`}
                      className="mt-2.5"
                    />
                  </PopoverContent>
                </Popover>
              </div>
            )
          })}
        </div>

        {active && (
          <div className="space-y-2 border-t border-zinc-800 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 font-mono text-[10px] text-zinc-400">OPACITY</span>
              <Slider
                value={[Math.round(active.opacity * 100)]}
                min={0}
                max={100}
                step={5}
                onValueChange={(v) => setLayerProp(active.id, { opacity: (v[0] ?? 100) / 100 })}
                aria-label="Layer opacity"
              />
              <span className="w-8 text-right font-mono text-[10px] text-zinc-300">
                {Math.round(active.opacity * 100)}%
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 font-mono text-[10px] text-zinc-400">BLEND</span>
              <Select value={active.blend ?? 'normal'} onValueChange={(v) => setLayerProp(active.id, { blend: v })}>
                <SelectTrigger size="sm" aria-label="Layer blend mode" className="h-6 w-full border-zinc-800 bg-zinc-900 font-mono text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BLEND_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value} className="font-mono text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-zinc-400" onClick={() => moveLayer(active.id, 1)} aria-label="Move layer up">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Move up</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-zinc-400" onClick={() => moveLayer(active.id, -1)} aria-label="Move layer down">
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Move down</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-6 w-6 ${active.linked ? 'text-teal-400 hover:text-teal-300' : 'text-zinc-400'}`}
                    onClick={() => setLayerLinked(active.id, !active.linked)}
                    aria-label={active.linked ? 'Unlink layer (separate cel per frame)' : 'Link layer (share cel across all frames)'}
                  >
                    {active.linked ? <Link2 className="h-3.5 w-3.5" /> : <Unlink2 className="h-3.5 w-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{active.linked ? 'Unlink cel (separate per frame)' : 'Link cel (shared across all frames)'}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-zinc-400" onClick={() => duplicateLayer(active.id)} aria-label="Duplicate layer">
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Duplicate</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-zinc-400"
                      onClick={() => mergeDown(active.id)}
                      disabled={active.linked}
                      aria-label="Merge down"
                    >
                      <Merge className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{active.linked ? 'Unlink layer before merging down' : 'Merge down'}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-red-400/80 hover:text-red-300"
                    onClick={() => deleteLayer(active.id)}
                    disabled={clip.layers.length <= 1}
                    aria-label="Delete layer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete</TooltipContent>
              </Tooltip>

              <div className="ml-auto flex items-center gap-0.5">
                {/* 1-click OKLab Sel-Out & Polish Layer popover */}
                <Popover open={polishOpen} onOpenChange={setPolishOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-teal-400 hover:bg-teal-500/10 hover:text-teal-300"
                          aria-label="Polish layer (sel-out & shading)"
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Polish layer (sel-out, shade & clean doubles)</TooltipContent>
                  </Tooltip>
                  <PopoverContent side="top" align="end" className="w-60 space-y-2 border-zinc-800 bg-zinc-950 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-teal-300">
                        Polish · {active.name}
                      </span>
                      <span className="font-mono text-[9px] text-zinc-500">undoable</span>
                    </div>
                    <div className="space-y-1.5 font-mono text-[10px] text-zinc-300">
                      <label className="flex cursor-pointer items-center justify-between gap-2">
                        <span>Sel-Out (colored outline)</span>
                        <input
                          type="checkbox"
                          checked={polishSelOut}
                          onChange={(e) => setPolishSelOut(e.target.checked)}
                          className="accent-teal-500"
                        />
                      </label>
                      <label className="flex cursor-pointer items-center justify-between gap-2">
                        <span>Directional shade</span>
                        <input
                          type="checkbox"
                          checked={polishShade}
                          onChange={(e) => setPolishShade(e.target.checked)}
                          className="accent-teal-500"
                        />
                      </label>
                      <label className="flex cursor-pointer items-center justify-between gap-2">
                        <span>Warm top-left rim</span>
                        <input
                          type="checkbox"
                          checked={polishHighlight}
                          onChange={(e) => setPolishHighlight(e.target.checked)}
                          className="accent-teal-500"
                        />
                      </label>
                      <label className="flex cursor-pointer items-center justify-between gap-2">
                        <span>Clean outline doubles</span>
                        <input
                          type="checkbox"
                          checked={polishCleanDoubles}
                          onChange={(e) => setPolishCleanDoubles(e.target.checked)}
                          className="accent-teal-500"
                        />
                      </label>
                      <label className="flex cursor-pointer items-center justify-between gap-2">
                        <span>Lock to project palette</span>
                        <input
                          type="checkbox"
                          checked={polishPaletteLock}
                          onChange={(e) => setPolishPaletteLock(e.target.checked)}
                          className="accent-teal-500"
                        />
                      </label>
                    </div>
                    <Button
                      size="sm"
                      className="h-7 w-full bg-teal-600 font-mono text-[10px] text-white hover:bg-teal-500"
                      onClick={() => {
                        const ok = polishLayer(active.id, {
                          selOut: polishSelOut,
                          outline: polishSelOut ? undefined : null,
                          shade: polishShade,
                          highlight: polishHighlight,
                          cleanDoubles: polishCleanDoubles,
                          paletteLock: polishPaletteLock,
                        })
                        if (ok) {
                          toast({
                            title: `Polished "${active.name}"`,
                            description: polishSelOut
                              ? 'Applied OKLab hue-shifted sel-out & palette-locked polish (Ctrl+Z to undo).'
                              : 'Applied layer polish (Ctrl+Z to undo).',
                          })
                          setPolishOpen(false)
                        }
                      }}
                    >
                      <Sparkles className="mr-1 h-3 w-3" /> Apply polish
                    </Button>
                  </PopoverContent>
                </Popover>

                {/* Live Pixel Craft Linter popover */}
                <Popover open={craftOpen} onOpenChange={setCraftOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={`h-6 w-6 ${craftPinned ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/40' : 'text-zinc-400 hover:text-zinc-100'}`}
                          aria-label="Inspect pixel craft score & defects"
                        >
                          <ScanSearch className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Craft Check (highlights doubles, orphans, jaggies on canvas)</TooltipContent>
                  </Tooltip>
                  <PopoverContent side="top" align="end" className="w-72 space-y-2 border-zinc-800 bg-zinc-950 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-300">
                        Pixel Craft Check
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setCraftPinned((v) => !v)}
                          aria-pressed={craftPinned}
                          className={`flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] transition-colors ${
                            craftPinned
                              ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40'
                              : 'border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                          }`}
                          title="Keep defect markers visible on the canvas while you paint"
                        >
                          <Pin className="h-2.5 w-2.5" />
                          {craftPinned ? 'Pinned' : 'Pin'}
                        </button>
                        {craftReport && (
                          <span
                            className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                              craftReport.score >= 90
                                ? 'bg-teal-500/20 text-teal-300'
                                : craftReport.score >= 70
                                  ? 'bg-amber-500/20 text-amber-300'
                                  : 'bg-red-500/20 text-red-300'
                            }`}
                          >
                            {craftReport.score}/100
                          </span>
                        )}
                      </div>
                    </div>
                    {craftReport && (
                      <>
                        <div className="grid grid-cols-4 gap-1 rounded border border-zinc-800 bg-zinc-900/60 p-1.5 text-center font-mono text-[9px]">
                          <div>
                            <div className="text-zinc-500">Colors</div>
                            <div className="text-zinc-200">{craftReport.metrics.uniqueColors}</div>
                          </div>
                          <div>
                            <div className="text-zinc-500">Doubles</div>
                            <div className={craftReport.metrics.doublesCount > 0 ? 'text-amber-300' : 'text-teal-300'}>
                              {craftReport.metrics.doublesCount}
                            </div>
                          </div>
                          <div>
                            <div className="text-zinc-500">Orphans</div>
                            <div className={craftReport.metrics.orphansCount > 0 ? 'text-amber-300' : 'text-teal-300'}>
                              {craftReport.metrics.orphansCount}
                            </div>
                          </div>
                          <div>
                            <div className="text-zinc-500">Jaggies</div>
                            <div className={craftReport.metrics.jaggiesCount > 0 ? 'text-amber-300' : 'text-teal-300'}>
                              {craftReport.metrics.jaggiesCount}
                            </div>
                          </div>
                        </div>
                        {craftReport.defects.length === 0 ? (
                          <p className="rounded border border-teal-500/30 bg-teal-950/20 px-2 py-1.5 font-mono text-[10px] text-teal-300">
                            Clean craft — no doubles, orphans, jaggies, or pillow shading detected.
                          </p>
                        ) : (
                          <div className="max-h-40 space-y-1.5 overflow-y-auto pr-0.5">
                            {craftReport.defects.map((d) => (
                              <div
                                key={d.kind}
                                className="rounded border border-zinc-800 bg-zinc-900/70 p-1.5 font-mono text-[9px]"
                              >
                                <p className={d.severity === 'warning' ? 'text-amber-300' : 'text-zinc-200'}>
                                  {d.message}
                                </p>
                                {d.locations.length > 0 && (
                                  <p className="mt-0.5 truncate text-zinc-500">
                                    at {d.locations.slice(0, 6).map((pt) => `(${pt.x},${pt.y})`).join(' ')}
                                    {d.locations.length > 6 ? ' …' : ''}
                                  </p>
                                )}
                                <p className="mt-0.5 text-zinc-400">{d.hint}</p>
                              </div>
                            ))}
                          </div>
                        )}
                        {craftReport.metrics.doublesCount > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 w-full border-teal-500/40 font-mono text-[10px] text-teal-300 hover:bg-teal-500/10"
                            onClick={() => {
                              const ok = polishLayer(active.id, {
                                outline: null,
                                selOut: false,
                                shade: false,
                                highlight: false,
                                cleanDoubles: true,
                                paletteLock: true,
                              })
                              if (ok) {
                                toast({ title: 'Cleaned outline doubles', description: `Removed outer L-corners on "${active.name}".` })
                              }
                            }}
                          >
                            Quick clean doubles on &ldquo;{active.name}&rdquo;
                          </Button>
                        )}
                      </>
                    )}
                  </PopoverContent>
                </Popover>

                {/* 1-Click Center Content (click = active layer, Shift+click = whole frame) */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-zinc-400 hover:text-zinc-100"
                      onClick={(e) => {
                        const scope = e.shiftKey ? 'frame' : 'layer'
                        const ok = centerContent(scope)
                        if (ok) {
                          toast({
                            title: scope === 'frame' ? 'Centered frame' : `Centered "${active.name}"`,
                            description: 'Shifted opaque artwork to exact canvas center (Ctrl+Z to undo).',
                          })
                        }
                      }}
                      aria-label="Center content on canvas"
                    >
                      <Crosshair className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Center layer on canvas (Shift+click: whole frame)</TooltipContent>
                </Tooltip>

                {/* Auto-Trim Canvas to opaque content */}
                <Popover open={trimOpen} onOpenChange={setTrimOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-zinc-400 hover:text-zinc-100"
                          aria-label="Auto-trim canvas to content"
                        >
                          <Crop className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Auto-trim canvas to content</TooltipContent>
                  </Tooltip>
                  <PopoverContent side="top" align="end" className="w-56 space-y-2.5 border-zinc-800 bg-zinc-950 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-300">
                        Auto-Trim Canvas
                      </span>
                      <span className="font-mono text-[10px] text-zinc-500">
                        {project.width}×{project.height}
                      </span>
                    </div>
                    <p className="font-mono text-[9px] leading-snug text-zinc-400">
                      Crops empty borders around artwork across all frames/clips (min 16×16, Ctrl+Z to undo).
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] text-zinc-300">Padding</span>
                      <div className="flex items-center gap-1" role="group" aria-label="Trim padding">
                        {([0, 1, 2, 4] as const).map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setTrimPad(p)}
                            aria-pressed={trimPad === p}
                            className={`h-6 min-w-6 rounded px-1.5 font-mono text-[10px] transition-colors ${
                              trimPad === p
                                ? 'bg-teal-500/20 text-teal-300 ring-1 ring-teal-500/40'
                                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                            }`}
                          >
                            {p}px
                          </button>
                        ))}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      className="h-7 w-full bg-teal-600 font-mono text-[10px] text-white hover:bg-teal-500"
                      onClick={() => {
                        const res = autoTrimCanvas(trimPad)
                        if (res) {
                          toast({
                            title: `Trimmed to ${res.width}×${res.height}`,
                            description: `Removed excess transparent margin with ${trimPad}px padding (Ctrl+Z to undo).`,
                          })
                          setTrimOpen(false)
                        }
                      }}
                    >
                      <Crop className="mr-1 h-3 w-3" /> Trim to content
                    </Button>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>
        )}

        <p className="shrink-0 border-t border-zinc-800/70 px-3 py-1.5 font-mono text-[10px] leading-relaxed text-zinc-400">
          Layers are shared by every frame in the clip — each frame keeps its own pixels.
        </p>
      </div>
    </TooltipProvider>
  )
}
