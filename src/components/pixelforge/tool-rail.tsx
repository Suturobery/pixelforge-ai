// PixelForge AI — left tool rail

'use client'

import { useState } from 'react'
import { useEditor } from '@/lib/pixelforge/store'
import { useAppSettings } from '@/lib/pixelforge/settings'
import type { ToolId } from '@/lib/pixelforge/types'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Pencil,
  Eraser,
  Contrast,
  PaintBucket,
  Blend,
  Slash,
  Square,
  Circle,
  PenTool,
  BoxSelect,
  Wand2,
  Pipette,
  Move,
  FlipHorizontal2,
  FlipVertical2,
  LayoutGrid,
  Grid2x2,
  Grid3x3,
  ArrowLeftRight,
  HelpCircle,
} from 'lucide-react'
import { FeedbackDialog } from '@/components/pixelforge/feedback-dialog'

const TOOLS: { id: ToolId; label: string; key?: string; icon: React.ReactNode }[] = [
  { id: 'pencil', label: 'Pencil', key: 'B', icon: <Pencil className="h-4 w-4" /> },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: <Eraser className="h-4 w-4" /> },
  { id: 'shade', label: 'Shade brush (Left-click: darken · Right-click / Shift: lighten)', key: 'H', icon: <Contrast className="h-4 w-4" /> },
  { id: 'fill', label: 'Fill', key: 'F', icon: <PaintBucket className="h-4 w-4" /> },
  { id: 'gradient', label: 'Bayer dither gradient', key: 'V', icon: <Blend className="h-4 w-4" /> },
  { id: 'line', label: 'Line', key: 'L', icon: <Slash className="h-4 w-4" /> },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: <Square className="h-4 w-4" /> },
  { id: 'ellipse', label: 'Ellipse', key: 'C', icon: <Circle className="h-4 w-4" /> },
  { id: 'vector', label: 'Pixel-perfect vector (curves & shapes)', key: 'N', icon: <PenTool className="h-4 w-4" /> },
  { id: 'marquee', label: 'Select', key: 'S', icon: <BoxSelect className="h-4 w-4" /> },
  { id: 'wand', label: 'Magic wand (contiguous select)', key: 'U', icon: <Wand2 className="h-4 w-4" /> },
  { id: 'eyedropper', label: 'Eyedropper', key: 'I', icon: <Pipette className="h-4 w-4" /> },
  { id: 'move', label: 'Move layer', key: 'M', icon: <Move className="h-4 w-4" /> },
]

export function ToolRail() {
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  const brushSize = useEditor((s) => s.brushSize)
  const setBrushSize = useEditor((s) => s.setBrushSize)
  const brushShape = useEditor((s) => s.brushShape)
  const setBrushShape = useEditor((s) => s.setBrushShape)
  const customBrush = useEditor((s) => s.customBrush)
  const setCustomBrush = useEditor((s) => s.setCustomBrush)
  const mirrorX = useEditor((s) => s.mirrorX)
  const setMirrorX = useEditor((s) => s.setMirrorX)
  const mirrorY = useEditor((s) => s.mirrorY)
  const setMirrorY = useEditor((s) => s.setMirrorY)
  const dither = useEditor((s) => s.dither)
  const setDither = useEditor((s) => s.setDither)
  const swapColors = useEditor((s) => s.swapColors)
  // Task 10b tilemap: snap toggle + tile size + stamp (K / Shift+K shortcuts)
  const tileSnap = useEditor((s) => s.tileSnap)
  const setTileSnap = useEditor((s) => s.setTileSnap)
  const tileSize = useEditor((s) => s.tileSize)
  const setTileSize = useEditor((s) => s.setTileSize)
  const tileStamp = useEditor((s) => s.tileStamp)
  const setTileStamp = useEditor((s) => s.setTileStamp)
  const tiledWrap = useEditor((s) => s.tiledWrap)
  const setTiledWrap = useEditor((s) => s.setTiledWrap)
  // help & feedback + (coming soon) accounts — parked at the rail bottom so
  // testers always know where to report bugs, whatever panel state they're in
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  return (
    <TooltipProvider delayDuration={200}>
      <aside
        aria-label="Tools"
        className="pixelforge-scroll flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-zinc-800/80 bg-zinc-950/50 py-2 backdrop-blur-xl"
      >
        {TOOLS.map((t) => (
          <Tooltip key={t.id}>
            <TooltipTrigger asChild>
              <Button
                variant={tool === t.id ? 'secondary' : 'ghost'}
                size="icon"
                className={`h-9 w-9 ${tool === t.id ? 'bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40' : 'text-zinc-400'}`}
                onClick={() => setTool(t.id)}
                aria-label={t.label}
                aria-pressed={tool === t.id}
              >
                {t.icon}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" className="font-mono text-xs">
              {t.label} {t.key && <kbd className="ml-1 rounded bg-white/20 px-1 font-sans text-[10px] font-semibold text-white">{t.key}</kbd>}
            </TooltipContent>
          </Tooltip>
        ))}

        <Separator className="my-1 w-6 bg-zinc-800" />

        {/* brush size — one control: the dot previews the current footprint,
            the popover slider adjusts it (1–8, keys 1–8 still work) */}
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 text-zinc-400 hover:text-zinc-200"
                  aria-label={`Brush size ${brushSize}×${brushSize} — scroll or click to adjust`}
                  onWheel={(e) => {
                    e.preventDefault()
                    setBrushSize(brushSize + (e.deltaY < 0 ? 1 : -1))
                  }}
                >
                  <span className="flex flex-col items-center gap-0.5">
                    <span
                      className="block rounded-[2px] bg-current"
                      style={{ width: 3 + brushSize * 2, height: 3 + brushSize * 2 }}
                    />
                    <span className="font-mono text-[8px] leading-none">{brushSize}</span>
                  </span>
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" className="font-mono text-xs">
              Brush {brushSize}×{brushSize} · scroll or keys 1–8 / [ ]
            </TooltipContent>
          </Tooltip>
          <PopoverContent side="right" align="start" className="w-48 p-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                Brush size
              </p>
              <span className="font-mono text-[10px] text-teal-300">
                {brushSize}×{brushSize}
              </span>
            </div>
            <Slider
              value={[brushSize]}
              min={1}
              max={8}
              step={1}
              onValueChange={([v]) => setBrushSize(v)}
              aria-label="Brush size"
              className="mt-2.5"
            />
            <div className="mt-2 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Shape</p>
              {customBrush ? (
                <button
                  type="button"
                  onClick={() => setCustomBrush(null)}
                  className="rounded border border-frost-500/50 bg-frost-900/30 px-1.5 py-0.5 font-mono text-[9px] text-frost-300 hover:bg-frost-900/50"
                  aria-label="Reset to standard brush"
                  title={`Custom brush ${customBrush.w}×${customBrush.h} active — click to reset`}
                >
                  custom {customBrush.w}×{customBrush.h} · reset
                </button>
              ) : (
                <div className="flex gap-1" role="group" aria-label="Brush shape">
                <button
                  type="button"
                  onClick={() => setBrushShape('square')}
                  aria-pressed={brushShape === 'square'}
                  aria-label="Square brush"
                  className={`flex h-6 w-6 items-center justify-center rounded border transition-colors ${
                    brushShape === 'square' ? 'border-teal-400 bg-teal-500/10 text-teal-300' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                  }`}
                >
                  <span className="block h-2.5 w-2.5 border border-current" />
                </button>
                <button
                  type="button"
                  onClick={() => setBrushShape('circle')}
                  aria-pressed={brushShape === 'circle'}
                  aria-label="Circle brush"
                  className={`flex h-6 w-6 items-center justify-center rounded border transition-colors ${
                    brushShape === 'circle' ? 'border-teal-400 bg-teal-500/10 text-teal-300' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                  }`}
                >
                  <span className="block h-2.5 w-2.5 rounded-full border border-current" />
                </button>
                </div>
              )}
            </div>
            <p className="mt-1.5 font-mono text-[9px] text-zinc-500">keys 1–8 · [ ]</p>
          </PopoverContent>
        </Popover>

        <Separator className="my-1 w-6 bg-zinc-800" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={mirrorX ? 'secondary' : 'ghost'}
              size="icon"
              className={`h-9 w-9 ${mirrorX ? 'bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40' : 'text-zinc-400'}`}
              onClick={() => setMirrorX(!mirrorX)}
              aria-label="Symmetry (vertical mirror)"
              aria-pressed={mirrorX}
            >
              <FlipHorizontal2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-mono text-xs">
            Symmetry (mirror X) <kbd className="ml-1 rounded bg-white/20 px-1 font-sans text-[10px] font-semibold text-white">Y</kbd>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={mirrorY ? 'secondary' : 'ghost'}
              size="icon"
              className={`h-9 w-9 ${mirrorY ? 'bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40' : 'text-zinc-400'}`}
              onClick={() => setMirrorY(!mirrorY)}
              aria-label="Symmetry Y (horizontal mirror)"
              aria-pressed={mirrorY}
            >
              <FlipVertical2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-mono text-xs">
            Symmetry (mirror Y) <kbd className="ml-1 rounded bg-white/20 px-1 font-sans text-[10px] font-semibold text-white">Shift+Y</kbd>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={dither ? 'secondary' : 'ghost'}
              size="icon"
              className={`h-9 w-9 ${dither ? 'bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40' : 'text-zinc-400'}`}
              onClick={() => setDither(!dither)}
              aria-label="Dither fill"
              aria-pressed={dither}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-mono text-xs">
            Dither fill — 2×2 Bayer checker between colors{' '}
            <kbd className="ml-1 rounded bg-white/20 px-1 font-sans text-[10px] font-semibold text-white">D</kbd>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-zinc-400"
              onClick={swapColors}
              aria-label="Swap colors"
            >
              <ArrowLeftRight className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-mono text-xs">
            Swap colors <kbd className="ml-1 rounded bg-white/20 px-1 font-sans text-[10px] font-semibold text-white">X</kbd>
          </TooltipContent>
        </Tooltip>

        {/* NOTE: no palette toggle here on purpose — the floating palette panel
            owns its own show/hide (eye + restore pill); a second toggle in the
            rail read as a duplicate palette control */}

        {/* Task 10b: tile snap — popover with size chips + stamp (K shortcut) */}
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant={tileSnap ? 'secondary' : 'ghost'}
                  size="icon"
                  className={`h-9 w-9 ${
                    tileSnap
                      ? 'bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40'
                      : 'text-zinc-400'
                  }`}
                  aria-label="Tile snap"
                  aria-pressed={tileSnap}
                >
                  <Grid2x2 className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" className="font-mono text-xs">
              Tile snap <kbd className="ml-1 rounded bg-white/20 px-1 font-sans text-[10px] font-semibold text-white">K</kbd>
            </TooltipContent>
          </Tooltip>
          <PopoverContent side="right" align="start" className="w-48 p-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">Tilemap</p>
            <div className="mt-2 flex items-center justify-between">
              <span className="font-mono text-[11px] text-zinc-300">Tile snap</span>
              <Switch checked={tileSnap} onCheckedChange={setTileSnap} aria-label="Tile snap" />
            </div>
            {tileSnap && (
              <>
                <div className="mt-2 flex items-center justify-between">
                  <span className="font-mono text-[11px] text-zinc-300">Tile size</span>
                  <div role="group" aria-label="Tile size" className="grid grid-cols-3 gap-0.5">
                    {([8, 16, 24, 32, 48, 64] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={tileSize === s}
                        onClick={() => setTileSize(s)}
                        className={`h-6 min-w-6 rounded px-1 font-mono text-[10px] transition-colors ${
                          tileSize === s
                            ? 'bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40'
                            : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="font-mono text-[11px] text-zinc-300">Stamp tile</span>
                  <Switch checked={tileStamp} onCheckedChange={setTileStamp} aria-label="Tile stamp" />
                </div>
                <p className="mt-1.5 font-mono text-[9px] leading-snug text-zinc-500">
                  Paint snaps to {tileSize}px tiles — a click fills the whole tile when stamp is on.
                </p>
              </>
            )}
          </PopoverContent>
        </Popover>

        {/* Tiled Wrap mode: 3×3 seamless tile preview + wrap painting (W shortcut) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={tiledWrap ? 'secondary' : 'ghost'}
              size="icon"
              className={`h-9 w-9 ${
                tiledWrap
                  ? 'bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40'
                  : 'text-zinc-400'
              }`}
              onClick={() => setTiledWrap(!tiledWrap)}
              aria-label="Tiled wrap (3×3 seamless)"
              aria-pressed={tiledWrap}
            >
              <Grid3x3 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-mono text-xs">
            Tiled wrap (3×3 seamless) <kbd className="ml-1 rounded bg-white/20 px-1 font-sans text-[10px] font-semibold text-white">W</kbd>
          </TooltipContent>
        </Tooltip>

        {/* bottom group: help & feedback + future account entry — mt-auto
            pins them below the tools regardless of rail height */}

        {/* bottom group: help & feedback + future account entry — mt-auto
            pins them below the tools regardless of rail height */}
        <div className="mt-auto flex flex-col items-center gap-1 pt-1">
          <Separator className="mb-1 w-6 bg-zinc-800" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 text-zinc-400 hover:text-teal-300"
                onClick={() => setFeedbackOpen(true)}
                aria-label="Help and feedback"
              >
                <HelpCircle className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" className="font-mono text-xs">
              Help &amp; feedback — report a bug or idea
            </TooltipContent>
          </Tooltip>
        </div>
      </aside>

      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </TooltipProvider>
  )
}
