// PixelForge AI — layers panel (per-clip layer stack + per-frame cels, v2)

'use client'

import { useEffect, useRef, useState } from 'react'
import { useEditor, getActiveFrame, getActiveClip } from '@/lib/pixelforge/store'
import { useToast } from '@/hooks/use-toast'
import type { Cel, Clip, Frame, Layer } from '@/lib/pixelforge/types'
import { drawCelBuffer, renderFrameScaled } from '@/lib/pixelforge/render'
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
  GripVertical,
} from 'lucide-react'

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
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, 28, 28)
    const scratch = document.createElement('canvas')
    scratch.width = w
    scratch.height = h
    const sctx = scratch.getContext('2d')
    if (!sctx) return
    drawCelBuffer(sctx, layer, cel, w, h, 1)
    // aspect-fit — non-square canvases were being stretched to 28×28
    const s = Math.min(28 / w, 28 / h)
    const dw = Math.max(1, Math.round(w * s))
    const dh = Math.max(1, Math.round(h * s))
    ctx.drawImage(scratch, (28 - dw) / 2, (28 - dh) / 2, dw, dh)
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
  const dragFrame = useEditor((s) => s.dragFrame)
  const { toast } = useToast()
  const [renaming, setRenaming] = useState<string | null>(null)
  // frame drag-and-drop: source (clipId+index) + current drop insertion point
  const [dragSrc, setDragSrc] = useState<{ clipId: string; index: number } | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overRow, setOverRow] = useState<number | null>(null)

  const frame = getActiveFrame(useEditor.getState())
  const clip = getActiveClip(useEditor.getState())
  const layers = [...clip.layers].reverse() // top first
  const active = clip.layers.find((l) => l.id === activeLayerId) ?? clip.layers.at(-1)

  return (
    <TooltipProvider delayDuration={200}>
      {/* column scrolls when the viewport is too short for the fixed blocks
          (header + frames + opacity + footer) — keeps the layer list usable */}
      <div className="pixelforge-scroll flex h-full flex-col overflow-x-hidden overflow-y-auto pb-2">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <span className="font-mono text-xs uppercase tracking-wider text-zinc-300">
            Layers · {clip.layers.length} layer{clip.layers.length === 1 ? '' : 's'}
          </span>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-300 hover:text-zinc-100" onClick={addLayer} aria-label="Add layer">
            <Plus className="h-4 w-4" />
          </Button>
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
                    className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setRenaming(layer.id)
                    }}
                    title={`${layer.name} — double-click to rename`}
                  >
                    {layer.name}
                  </span>
                )}
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
            <div className="flex gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400" onClick={() => moveLayer(active.id, 1)} aria-label="Move layer up">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Move up</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400" onClick={() => moveLayer(active.id, -1)} aria-label="Move layer down">
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Move down</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400" onClick={() => duplicateLayer(active.id)} aria-label="Duplicate layer">
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Duplicate</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400" onClick={() => mergeDown(active.id)} aria-label="Merge down">
                    <Merge className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Merge down</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-red-400/80 hover:text-red-300"
                    onClick={() => deleteLayer(active.id)}
                    disabled={clip.layers.length <= 1}
                    aria-label="Delete layer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete</TooltipContent>
              </Tooltip>
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
