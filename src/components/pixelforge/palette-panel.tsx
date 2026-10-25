// PixelForge AI — floating palette panel ("PALETTE 16").
// Same floating-panel pattern as the preview overlay and the view toolbar:
// draggable anywhere over the stage, hideable to a labeled restore pill,
// position + visibility persisted (localStorage + desktop settings mirror).
//
// Colors come from the DOCUMENT palette (undoable via the bus): clicking a
// swatch sets the primary color, right-click sets the secondary. The fg/bg
// pair opens the studio color editor; palette presets replace the whole
// palette in one undoable step.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor } from '@/lib/pixelforge/store'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { savePanelRaw, onPanelsHydrated } from '@/lib/pixelforge/panel-storage'
import { FloatPill } from '@/components/pixelforge/float-pill'
import { ColorPickerContent } from '@/components/pixelforge/color-picker'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ArrowLeftRight, EyeOff, Minus, Palette, Plus } from 'lucide-react'
import { PALETTES } from '@/lib/pixelforge/palettes'

const STORE_KEY = 'pixelforge-palette-v1'

interface PxPos {
  x: number
  y: number
}

interface PalettePersist {
  open: boolean
  pos: PxPos | null
  pillPos: PxPos | null
}

function loadSaved(): PalettePersist {
  if (typeof window === 'undefined') return { open: true, pos: null, pillPos: null }
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return { open: true, pos: null, pillPos: null }
    const p = JSON.parse(raw) as Partial<PalettePersist>
    const ok = (v: PxPos | null | undefined) =>
      !!v && typeof v.x === 'number' && typeof v.y === 'number' ? (v as PxPos) : null
    return { open: p.open !== false, pos: ok(p.pos), pillPos: ok(p.pillPos) }
  } catch {
    return { open: true, pos: null, pillPos: null }
  }
}

export function PalettePanel() {
  const palette = useEditor((s) => s.project.palette)
  const primary = useEditor((s) => s.primary)
  const secondary = useEditor((s) => s.secondary)
  const setPrimary = useEditor((s) => s.setPrimary)
  const setSecondary = useEditor((s) => s.setSecondary)
  const swapColors = useEditor((s) => s.swapColors)
  const addPaletteColor = useEditor((s) => s.addPaletteColor)
  const removePaletteColor = useEditor((s) => s.removePaletteColor)
  const setPalette = useEditor((s) => s.setPalette)
  const floatBtnSize = useAppSettings((s) => s.floatBtnSize)

  const [open, setOpen] = useState(true)
  const [pos, setPos] = useState<PxPos | null>(null)
  const [pillPos, setPillPos] = useState<PxPos | null>(null)
  const [dragging, setDragging] = useState(false)
  const [addColor, setAddColor] = useState('#2ce8f5')
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const hydratedRef = useRef(false)

  // load persisted position / visibility once (deferred to rAF like the
  // other floating panels so the first paint is the stable anchor)
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const saved = loadSaved()
      setOpen(saved.open)
      setPos(saved.pos)
      setPillPos(saved.pillPos)
      hydratedRef.current = true
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  // desktop settings-file hydration (Task 13a)
  useEffect(
    () =>
      onPanelsHydrated(() => {
        const saved = loadSaved()
        setOpen(saved.open)
        setPos(saved.pos)
        setPillPos(saved.pillPos)
      }),
    [],
  )

  // persist on change (after hydration so we never wipe the stored value)
  useEffect(() => {
    if (!hydratedRef.current || typeof window === 'undefined') return
    savePanelRaw(STORE_KEY, { open, pos, pillPos })
  }, [open, pos, pillPos])

  const clamp = useCallback((x: number, y: number): PxPos => {
    const el = rootRef.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return { x, y }
    const maxX = Math.max(10, parent.clientWidth - el.offsetWidth - 10)
    const maxY = Math.max(10, parent.clientHeight - el.offsetHeight - 10)
    return { x: Math.min(Math.max(10, x), maxX), y: Math.min(Math.max(10, y), maxY) }
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // only the header chrome drags — swatches stay clickable
    if ((e.target as HTMLElement).closest('button,[role="combobox"]')) return
    const el = rootRef.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return
    const rect = el.getBoundingClientRect()
    const pRect = parent.getBoundingClientRect()
    dragRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      ox: rect.left - pRect.left,
      oy: rect.top - pRect.top,
    }
    if (!pos) setPos({ x: rect.left - pRect.left, y: rect.top - pRect.top })
    el.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    setPos(clamp(d.ox + (e.clientX - d.sx), d.oy + (e.clientY - d.sy)))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = rootRef.current
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    dragRef.current = null
    setDragging(false)
  }

  if (!open) {
    return (
      <FloatPill
        label="Palette"
        ariaLabel="Show palette panel"
        icon={<Palette className={`text-teal-400 ${floatBtnSize === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5'}`} aria-hidden />}
        size={floatBtnSize}
        pos={pillPos}
        defaultAnchorClass="bottom-3 left-3"
        onActivate={() => setOpen(true)}
        onMoved={setPillPos}
      />
    )
  }

  return (
    <div
      ref={rootRef}
      data-testid="palette-panel"
      aria-label="Palette panel — drag the header to move, click the eye to hide"
      className={`absolute left-3 top-3 z-30 w-[176px] touch-none select-none rounded-lg border border-zinc-700/80 bg-zinc-900/95 shadow-xl backdrop-blur ${
        dragging ? 'cursor-grabbing' : ''
      }`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* header (drag grip) */}
      <div className="flex items-center gap-1.5 border-b border-zinc-800 px-2.5 py-1.5">
        <Palette className="h-3 w-3 shrink-0 text-teal-400" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-wider text-zinc-300">
          Palette {palette.length}
        </span>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-zinc-500 hover:text-zinc-200"
          onClick={() => setOpen(false)}
          aria-label="Hide palette panel"
          title="Hide (click the palette pill to bring it back)"
        >
          <EyeOff className="h-3 w-3" />
        </button>
      </div>

      {/* fg / bg pair + swap */}
      <div className="flex items-center justify-center gap-2 px-2.5 pb-1 pt-2">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="h-9 w-9 rounded-md border border-zinc-600 shadow-inner"
              style={{ background: primary }}
              aria-label={`Primary color ${primary} — click to edit`}
              title="Primary color — click to edit"
            />
          </PopoverTrigger>
          <PopoverContent side="right" align="start" className="w-56 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
            <ColorPickerContent color={primary} onChange={setPrimary} />
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="-ml-4 mt-5 h-7 w-7 rounded-md border border-zinc-600"
              style={{ background: secondary }}
              aria-label={`Secondary color ${secondary} — click to edit`}
              title="Secondary color — click to edit"
            />
          </PopoverTrigger>
          <PopoverContent side="right" align="start" className="w-56 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
            <ColorPickerContent color={secondary} onChange={setSecondary} />
          </PopoverContent>
        </Popover>
        <button
          type="button"
          className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-teal-300"
          onClick={swapColors}
          aria-label="Swap primary and secondary colors"
          title="Swap colors (X)"
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* document swatches — click: primary · right-click: secondary */}
      <div className="px-2.5 pb-1">
        <div className="grid grid-cols-2 gap-1" role="listbox" aria-label="Document palette">
          {palette.map((c) => (
            <button
              key={c}
              type="button"
              role="option"
              aria-selected={primary === c}
              aria-label={`Color ${c}`}
              title={`${c} — click: primary · right-click: secondary`}
              onClick={() => setPrimary(c)}
              onContextMenu={(e) => {
                e.preventDefault()
                setSecondary(c)
              }}
              className={`h-7 w-full rounded-md border transition ${
                primary === c
                  ? 'border-teal-300 ring-1 ring-teal-300/60'
                  : secondary === c
                    ? 'border-zinc-400 ring-1 ring-zinc-400/50'
                    : 'border-zinc-700 hover:border-zinc-500'
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>

      {/* footer: add/remove + palette presets */}
      <div className="flex items-center gap-1 border-t border-zinc-800 px-2 py-1.5">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-teal-300"
              aria-label="Add color to palette"
              title="Add color to palette"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-56 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
            <ColorPickerContent
              color={addColor}
              onChange={setAddColor}
              alreadyInPalette={palette.includes(addColor.toLowerCase())}
              onAddToPalette={() => addPaletteColor(addColor)}
            />
          </PopoverContent>
        </Popover>
        <button
          type="button"
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-red-300"
          onClick={() => removePaletteColor(primary)}
          disabled={palette.length <= 1}
          aria-label="Remove primary color from palette"
          title="Remove the primary color from the palette"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <Select
          value=""
          onValueChange={(id) => {
            const preset = PALETTES.find((p) => p.id === id)
            if (preset) setPalette(preset.colors, `Palette: ${preset.name}`)
          }}
        >
          <SelectTrigger
            className="ml-auto h-6 w-[104px] border-zinc-800 bg-zinc-950 px-1.5 font-mono text-[10px] text-zinc-300"
            aria-label="Apply a palette preset"
          >
            <SelectValue placeholder="presets" />
          </SelectTrigger>
          <SelectContent>
            {PALETTES.map((p) => (
              <SelectItem key={p.id} value={p.id} className="font-mono text-[11px]">
                {p.name} ({p.colors.length})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
