// PixelForge AI — left tool rail

'use client'

import { useEditor } from '@/lib/pixelforge/store'
import type { ToolId } from '@/lib/pixelforge/types'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Pencil,
  Eraser,
  PaintBucket,
  Slash,
  Square,
  Circle,
  BoxSelect,
  Pipette,
  Move,
  FlipHorizontal2,
  ArrowLeftRight,
  Palette,
} from 'lucide-react'

const TOOLS: { id: ToolId; label: string; key?: string; icon: React.ReactNode }[] = [
  { id: 'pencil', label: 'Pencil', key: 'B', icon: <Pencil className="h-4 w-4" /> },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: <Eraser className="h-4 w-4" /> },
  { id: 'fill', label: 'Fill', key: 'F', icon: <PaintBucket className="h-4 w-4" /> },
  { id: 'line', label: 'Line', key: 'L', icon: <Slash className="h-4 w-4" /> },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: <Square className="h-4 w-4" /> },
  { id: 'ellipse', label: 'Ellipse', icon: <Circle className="h-4 w-4" /> },
  { id: 'marquee', label: 'Select', key: 'S', icon: <BoxSelect className="h-4 w-4" /> },
  { id: 'eyedropper', label: 'Eyedropper', key: 'I', icon: <Pipette className="h-4 w-4" /> },
  { id: 'move', label: 'Move layer', key: 'M', icon: <Move className="h-4 w-4" /> },
]

export function ToolRail() {
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  const brushSize = useEditor((s) => s.brushSize)
  const setBrushSize = useEditor((s) => s.setBrushSize)
  const mirrorX = useEditor((s) => s.mirrorX)
  const setMirrorX = useEditor((s) => s.setMirrorX)
  const swapColors = useEditor((s) => s.swapColors)
  const paletteOpen = useEditor((s) => s.paletteOpen)
  const setPaletteOpen = useEditor((s) => s.setPaletteOpen)

  return (
    <TooltipProvider delayDuration={200}>
      <aside
        aria-label="Tools"
        className="pixelforge-scroll flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-zinc-800 bg-zinc-950/60 py-2"
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
              {t.label} {t.key && <span className="text-zinc-300">[{t.key}]</span>}
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
                  aria-label={`Brush size ${brushSize}×${brushSize} — click to adjust`}
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
              Brush {brushSize}×{brushSize} · click to adjust
            </TooltipContent>
          </Tooltip>
          <PopoverContent side="right" align="start" className="w-48 p-3">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">
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
            <p className="mt-1.5 font-mono text-[9px] text-zinc-500">keys 1–8</p>
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
            Symmetry (mirror X)
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
            Swap colors
          </TooltipContent>
        </Tooltip>

        {/* palette toggle — collapse/expand the palette column */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={paletteOpen ? 'secondary' : 'ghost'}
              size="icon"
              className={`mt-auto h-9 w-9 shrink-0 ${
                paletteOpen
                  ? 'bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40'
                  : 'text-zinc-400'
              }`}
              onClick={() => setPaletteOpen(!paletteOpen)}
              aria-label={paletteOpen ? 'Hide palette' : 'Show palette'}
              aria-pressed={paletteOpen}
            >
              <Palette className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-mono text-xs">
            {paletteOpen ? 'Hide palette' : 'Show palette'}
          </TooltipContent>
        </Tooltip>
      </aside>
    </TooltipProvider>
  )
}
