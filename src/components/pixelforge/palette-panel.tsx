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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor } from '@/lib/pixelforge/store'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { harvestPalette } from '@pixelforge/core'
import { savePanelRaw, onPanelsHydrated, resetPanelLayoutsOnce } from '@/lib/pixelforge/panel-storage'
import { useToast } from '@/hooks/use-toast'
import { FloatPill } from '@/components/pixelforge/float-pill'
import { Button } from '@/components/ui/button'
import { ColorPickerContent } from '@/components/pixelforge/color-picker'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { loadLibrary, type PalettePreset } from '@/lib/pixelforge/palettes'
import { ArrowLeftRight, ArrowUpDown, Check, ChevronDown, EyeOff, Minus, Palette, Plus, Replace, Share2, Sparkles } from 'lucide-react'
import { copyText } from '@/lib/pixelforge/desktop-bridge'
import { encodePaletteCode, decodePaletteCode } from '@/lib/pixelforge/palette-share'
import { PALETTES } from '@/lib/pixelforge/palettes'

const STORE_KEY = 'pixelforge-palette-v1'

/** true when both palettes hold the same colors in the same order (case-insensitive) */
function sameColors(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((c, i) => c.toLowerCase() === b[i].toLowerCase())
}

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
  const { toast } = useToast()
  const primary = useEditor((s) => s.primary)
  const secondary = useEditor((s) => s.secondary)
  const setPrimary = useEditor((s) => s.setPrimary)
  const setSecondary = useEditor((s) => s.setSecondary)
  const swapColors = useEditor((s) => s.swapColors)
  const addPaletteColor = useEditor((s) => s.addPaletteColor)
  const removePaletteColor = useEditor((s) => s.removePaletteColor)
  const setPalette = useEditor((s) => s.setPalette)
  const sortPalette = useEditor((s) => s.sortPalette)
  const replaceColor = useEditor((s) => s.replaceColor)
  const remapToPalette = useEditor((s) => s.remapToPalette)
  const floatBtnSize = useAppSettings((s) => s.floatBtnSize)

  // visibility lives in the editor store so the P shortcut can toggle it
  const open = useEditor((s) => s.paletteOpen)
  const setOpen = useEditor((s) => s.setPaletteOpen)
  const [pos, setPos] = useState<PxPos | null>(null)
  const [pillPos, setPillPos] = useState<PxPos | null>(null)
  const [dragging, setDragging] = useState(false)
  const [addColor, setAddColor] = useState('#2ce8f5')
  const harvestRef = useRef<HTMLInputElement>(null)
  // share codes: paste-a-code popover (encode lives behind "Share…" copy)
  const [shareOpen, setShareOpen] = useState(false)
  const [pasteValue, setPasteValue] = useState('')
  // palette sort & color replace popovers
  const [sortOpen, setSortOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replaceScope, setReplaceScope] = useState<'layer' | 'frame' | 'clip'>('frame')
  // unified palette selector / browser popover: lazily loaded library (~2k named palettes)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [remapOnPick, setRemapOnPick] = useState(false)
  const [remapMode, setRemapMode] = useState<'ramp' | 'nearest'>('ramp')
  const [searchQuery, setSearchQuery] = useState('')
  const [filterSize, setFilterSize] = useState<'all' | '8' | '16' | '32'>('all')
  const [library, setLibrary] = useState<PalettePreset[] | null>(null)
  const [libError, setLibError] = useState(false)

  // match current document palette against built-in presets or loaded library
  const currentPreset = PALETTES.find((p) => sameColors(p.colors, palette))
  const currentLibPreset = library?.find((p) => sameColors(p.colors, palette))
  const matchedPreset = currentPreset ?? currentLibPreset
  const currentPaletteName = matchedPreset ? matchedPreset.name : `Custom (${palette.length})`

  const filteredPresets = useMemo(() => {
    if (filterSize === '8') return PALETTES.filter((p) => p.colors.length <= 8)
    if (filterSize === '16') return PALETTES.filter((p) => p.colors.length > 8 && p.colors.length <= 16)
    if (filterSize === '32') return PALETTES.filter((p) => p.colors.length > 16)
    return PALETTES
  }, [filterSize])

  const filteredLibrary = useMemo(() => {
    if (!library) return []
    if (filterSize === '8') return library.filter((p) => p.colors.length <= 8)
    if (filterSize === '16') return library.filter((p) => p.colors.length > 8 && p.colors.length <= 16)
    if (filterSize === '32') return library.filter((p) => p.colors.length > 16)
    return library
  }, [library, filterSize])

  const searchedPresets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return filteredPresets
    return filteredPresets.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.notes && p.notes.toLowerCase().includes(q))
    )
  }, [filteredPresets, searchQuery])

  const searchedLibrary = useMemo(() => {
    if (!filteredLibrary.length) return []
    const q = searchQuery.trim().toLowerCase()
    if (!q) return filteredLibrary
    return filteredLibrary.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.notes && p.notes.toLowerCase().includes(q))
    )
  }, [filteredLibrary, searchQuery])
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const hydratedRef = useRef(false)

  // load persisted position / visibility once (deferred to rAF like the
  // other floating panels so the first paint is the stable anchor).
  // On phones the floating panel starts CLOSED (it would cover most of the
  // canvas — mobile audit) but phone sessions never PERSIST that state, so
  // the desktop preference in storage stays untouched.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const phone =
        typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
      if (phone) {
        // local-only closed state; hydratedRef stays false → nothing is saved
        setOpen(false)
        setPos(null)
        setPillPos(null)
        return
      }
      const saved = loadSaved()
      setOpen(saved.open)
      setPos(saved.pos)
      setPillPos(saved.pillPos)
      hydratedRef.current = true
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  // one-time stale pill-position discard (v2 layout reset) — before any
  // panel reads its saved shape
  resetPanelLayoutsOnce()

  // desktop settings-file hydration (Task 13a) — skipped on phones so the
  // phone's local-only closed state is never overwritten or persisted
  useEffect(
    () =>
      onPanelsHydrated(() => {
        if (window.matchMedia('(max-width: 767px)').matches) return
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

  // library loads once, on first browser open (lazy chunk)
  useEffect(() => {
    if (!browserOpen || library || libError) return
    let alive = true
    loadLibrary()
      .then((presets) => {
        if (alive) setLibrary(presets)
      })
      .catch(() => {
        if (alive) setLibError(true)
      })
    return () => {
      alive = false
    }
  }, [browserOpen, library, libError])

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
    // Portal children (the palette-preset Select dropdown, the color-picker
    // Popovers) bubble pointer events here through the REACT tree even though
    // they render outside this panel in the DOM. Starting a drag for them
    // steals the pointer capture and breaks their clicks entirely — bail.
    if (!el.contains(e.target as Node)) return
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
        defaultAnchorClass="top-3 left-3"
        onActivate={() => setOpen(true)}
        onMoved={setPillPos}
        onReset={() => setPillPos(null)}
      />
    )
  }

  return (
    <div
      ref={rootRef}
      data-testid="palette-panel"
      aria-label="Palette panel — drag the header to move, click the eye to hide"
      className={`absolute left-3 top-3 z-30 w-[216px] touch-none select-none rounded-xl border border-zinc-700/80 bg-zinc-900/90 shadow-xl backdrop-blur-xl ${
        dragging ? 'cursor-grabbing' : ''
      }`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* header (drag grip) */}
      <div className="flex items-center gap-1.5 border-b border-zinc-800 px-3 py-1.5">
        <Palette className="h-3 w-3 shrink-0 text-teal-400" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
          Palette {palette.length}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-zinc-400 hover:text-zinc-100"
              onClick={() => setOpen(false)}
              aria-label="Hide palette panel"
            >
              <EyeOff className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Hide — click the palette pill to bring it back</TooltipContent>
        </Tooltip>
      </div>

      {/* current colors: primary + secondary side by side (no overlap), swap */}
      <div className="flex items-center justify-center gap-3 px-3 pb-1.5 pt-2.5">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="h-9 w-9 rounded-lg border border-zinc-600 shadow-inner ring-2 ring-zinc-400/70 ring-offset-2 ring-offset-zinc-900"
              style={{ background: primary }}
              aria-label={`Primary color ${primary} — click to edit`}
            />
          </PopoverTrigger>
          <PopoverContent side="right" align="start" className="w-56 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
            <ColorPickerContent color={primary} onChange={setPrimary} />
          </PopoverContent>
        </Popover>
        <button
          type="button"
          className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          onClick={swapColors}
          aria-label="Swap primary and secondary colors"
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
        </button>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="h-9 w-9 rounded-lg border border-zinc-600 shadow-inner"
              style={{ background: secondary }}
              aria-label={`Secondary color ${secondary} — click to edit`}
            />
          </PopoverTrigger>
          <PopoverContent side="right" align="start" className="w-56 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
            <ColorPickerContent color={secondary} onChange={setSecondary} />
          </PopoverContent>
        </Popover>
      </div>

      {/* document palette — one 4×4 square: click: primary · right-click: secondary */}
      {/* scrollable swatch area — big palettes (library presets, harvest)
          never expand the floating panel; 4 rows visible, scroll for more.
          Inline maxHeight: the Tailwind arbitrary class was not applying
          (computed height grew past 516px with 48-color palettes). */}
      <div
        className="pixelforge-scroll overflow-y-auto px-3 pb-2 pt-2.5"
        style={{ maxHeight: 172 }}
      >
        <div className="grid grid-cols-4 gap-1.5" role="listbox" aria-label="Document palette">
          {palette.map((c) => (
            <button
              key={c}
              type="button"
              role="option"
              aria-selected={primary === c}
              aria-label={`Color ${c} — click: primary, right-click: secondary`}
              onClick={() => setPrimary(c)}
              onContextMenu={(e) => {
                e.preventDefault()
                setSecondary(c)
              }}
              className={`h-9 w-full rounded-md border transition-colors ${
                primary === c
                  ? 'border-zinc-200 ring-1 ring-zinc-200'
                  : secondary === c
                    ? 'border-zinc-300 ring-1 ring-zinc-300/50'
                    : 'border-zinc-700 hover:border-zinc-500'
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>

      {/* footer: action row (add/remove/code) + unified visual palette selector */}
      <div className="border-t border-zinc-800 px-3 py-1.5">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                      aria-label="Add color to palette"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="top">Add color to palette</TooltipContent>
              </Tooltip>
              <PopoverContent side="top" align="start" className="w-56 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
                <ColorPickerContent
                  color={addColor}
                  onChange={setAddColor}
                  alreadyInPalette={palette.includes(addColor.toLowerCase())}
                  onAddToPalette={() => addPaletteColor(addColor)}
                />
                {/* ramp generator: 4 shading steps around the picked color */}
                <button
                  type="button"
                  disabled={!/^#[0-9a-fA-F]{6}$/.test(addColor)}
                  onClick={() => {
                    const h = addColor.replace('#', '')
                    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
                    const hexAt = (m: number) => {
                      const c = [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v * m))))
                      return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
                    }
                    for (const hexv of [hexAt(1.2), hexAt(0.78), hexAt(0.58), hexAt(0.4)]) addPaletteColor(hexv)
                  }}
                  className="mt-2 w-full rounded border border-zinc-700 py-1 font-mono text-[10px] text-zinc-300 hover:border-frost-500/60 hover:text-frost-300 disabled:opacity-40"
                  title="Add a 4-step light/shade ramp around this color"
                >
                  Generate ramp (+4 shades)
                </button>
                {/* palette harvest: steal the 16 best colors from any image */}
                <input
                  ref={harvestRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (!file) return
                    try {
                      const dataUrl = await new Promise<string>((resolve, reject) => {
                        const fr = new FileReader()
                        fr.onload = () => resolve(fr.result as string)
                        fr.onerror = () => reject(new Error('Could not read file'))
                        fr.readAsDataURL(file)
                      })
                      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
                        const im = new Image()
                        im.onload = () => resolve(im)
                        im.onerror = () => reject(new Error('Could not decode image'))
                        im.src = dataUrl
                      })
                      const cvs = document.createElement('canvas')
                      cvs.width = img.naturalWidth
                      cvs.height = img.naturalHeight
                      cvs.getContext('2d')?.drawImage(img, 0, 0)
                      const rgba = cvs.getContext('2d')?.getImageData(0, 0, cvs.width, cvs.height)
                      if (!rgba) throw new Error('Could not read image pixels')
                      // harvest locally — core median cut handles any format the
                      // browser decoded (PNG/JPEG/WebP), no MCP roundtrip
                      const colors = harvestPalette(rgba.data, 16)
                      if (colors.length === 0) throw new Error('Image has no visible pixels')
                      for (const hexv of colors) addPaletteColor(hexv)
                    } catch (err) {
                      toast({
                        title: 'Palette harvest failed',
                        description: err instanceof Error ? err.message : 'Unknown error',
                        variant: 'destructive',
                      })
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => harvestRef.current?.click()}
                  className="mt-1 w-full rounded border border-zinc-700 py-1 font-mono text-[10px] text-zinc-300 hover:border-frost-500/60 hover:text-frost-300"
                  title="Extract the 16 best colors from any image (median cut)"
                >
                  Harvest from image…
                </button>
              </PopoverContent>
            </Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-red-300"
                  onClick={() => removePaletteColor(primary)}
                  disabled={palette.length <= 1}
                  aria-label="Remove primary color from palette"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Remove the primary color from the palette</TooltipContent>
            </Tooltip>

            {/* OKLab Palette Auto-Sort */}
            <Popover open={sortOpen} onOpenChange={setSortOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                      disabled={palette.length <= 1}
                      aria-label="Sort palette colors"
                    >
                      <ArrowUpDown className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="top">Sort palette (lightness / hue)</TooltipContent>
              </Tooltip>
              <PopoverContent side="top" align="start" className="w-44 space-y-1 border-zinc-800 bg-zinc-950 p-2">
                <p className="px-1 font-mono text-[9px] uppercase tracking-wider text-zinc-500">Sort Palette (OKLab)</p>
                <button
                  type="button"
                  onClick={() => {
                    sortPalette('lightness')
                    setSortOpen(false)
                  }}
                  className="w-full rounded px-2 py-1 text-left font-mono text-[10px] text-zinc-200 hover:bg-zinc-800"
                >
                  Lightness (dark → bright)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    sortPalette('hue')
                    setSortOpen(false)
                  }}
                  className="w-full rounded px-2 py-1 text-left font-mono text-[10px] text-zinc-200 hover:bg-zinc-800"
                >
                  Hue wheel (grouped)
                </button>
              </PopoverContent>
            </Popover>

            {/* 1-Click Color Replace (Primary -> Secondary) */}
            <Popover open={replaceOpen} onOpenChange={setReplaceOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                      aria-label="Replace color in artwork"
                    >
                      <Replace className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="top">Replace Primary → Secondary in artwork</TooltipContent>
              </Tooltip>
              <PopoverContent side="top" align="start" className="w-56 space-y-2 border-zinc-800 bg-zinc-950 p-2.5">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-300">
                  Replace Color
                </p>
                <div className="flex items-center justify-center gap-2 rounded border border-zinc-800 bg-zinc-900/70 py-1.5 font-mono text-[10px] text-zinc-300">
                  <span className="flex items-center gap-1.5">
                    <span className="h-4 w-4 rounded border border-zinc-600" style={{ background: primary }} />
                    {primary}
                  </span>
                  <span className="text-zinc-500">→</span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-4 w-4 rounded border border-zinc-600" style={{ background: secondary }} />
                    {secondary}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] text-zinc-400">Scope</span>
                  <div className="flex items-center gap-0.5" role="group" aria-label="Replace scope">
                    {(['layer', 'frame', 'clip'] as const).map((sc) => (
                      <button
                        key={sc}
                        type="button"
                        onClick={() => setReplaceScope(sc)}
                        aria-pressed={replaceScope === sc}
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] capitalize transition-colors ${
                          replaceScope === sc
                            ? 'bg-teal-500/20 text-teal-300 ring-1 ring-teal-500/40'
                            : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                        }`}
                      >
                        {sc}
                      </button>
                    ))}
                  </div>
                </div>
                <Button
                  size="sm"
                  className="h-7 w-full bg-teal-600 font-mono text-[10px] text-white hover:bg-teal-500"
                  onClick={() => {
                    const count = replaceColor(primary, secondary, replaceScope)
                    if (count > 0) {
                      toast({
                        title: `Replaced ${count} px`,
                        description: `${primary} → ${secondary} on active ${replaceScope} (Ctrl+Z to undo).`,
                      })
                      setReplaceOpen(false)
                    }
                  }}
                >
                  <Replace className="mr-1 h-3 w-3" /> Replace in {replaceScope}
                </Button>
              </PopoverContent>
            </Popover>
          </div>

          {/* compact share/paste code button */}
          <Popover open={shareOpen} onOpenChange={setShareOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex h-6 items-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 font-mono text-[10px] text-zinc-400 hover:border-frost-500/60 hover:text-frost-300"
                    aria-label="Share or paste a palette code"
                  >
                    <Share2 className="h-3 w-3" aria-hidden />
                    <span>Code</span>
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">Share or paste palette code (PF1-…)</TooltipContent>
            </Tooltip>
            <PopoverContent side="top" align="end" className="w-64 space-y-2 p-2.5">
              <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">Palette share code</p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-full border-zinc-800 font-mono text-[10px] text-zinc-200"
                onClick={async () => {
                  try {
                    const code = encodePaletteCode(palette)
                    await copyText(code)
                    toast({ title: 'Code copied', description: 'Anyone can paste it here to get this palette.' })
                  } catch (err) {
                    toast({ title: 'Share failed', description: String(err instanceof Error ? err.message : err), variant: 'destructive' })
                  }
                }}
              >
                Copy code for current palette
              </Button>
              <div className="flex items-center gap-1.5">
                <Input
                  value={pasteValue}
                  onChange={(e) => setPasteValue(e.target.value)}
                  placeholder="PF1-…"
                  aria-label="Paste a palette code"
                  className="h-6 flex-1 border-zinc-800 bg-zinc-950 px-1.5 font-mono text-[10px] text-zinc-200"
                  spellCheck={false}
                />
                <Button
                  size="sm"
                  className="h-6 shrink-0 bg-teal-600 px-2 font-mono text-[10px] text-white hover:bg-teal-500"
                  disabled={!pasteValue.trim()}
                  onClick={() => {
                    try {
                      const colors = decodePaletteCode(pasteValue)
                      setPalette(colors, 'Palette: shared code')
                      setPasteValue('')
                      setShareOpen(false)
                      toast({ title: 'Palette applied', description: `${colors.length} colors from the shared code.` })
                    } catch (err) {
                      toast({ title: 'Invalid code', description: String(err instanceof Error ? err.message : err), variant: 'destructive' })
                    }
                  }}
                >
                  Apply
                </Button>
              </div>
              <p className="font-mono text-[9px] leading-tight text-zinc-500">
                Codes travel through chat/email — no account, no server.
              </p>
            </PopoverContent>
          </Popover>
        </div>

        {/* unified palette selector: presets + 2k library in a single searchable popover */}
        <Popover open={browserOpen} onOpenChange={setBrowserOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex h-7 w-full items-center justify-between gap-1.5 rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-[11px] text-zinc-300 hover:border-frost-500/60 hover:text-zinc-100 transition-colors"
                  aria-label="Select or browse palettes"
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Palette className="h-3 w-3 shrink-0 text-teal-400" />
                    <span className="truncate font-medium">{currentPaletteName}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <div className="flex h-2.5 w-10 overflow-hidden rounded-[2px] border border-zinc-800">
                      {palette.slice(0, 10).map((c, i) => (
                        <span key={i} className="h-full flex-1" style={{ backgroundColor: c }} />
                      ))}
                    </div>
                    <ChevronDown className="h-3 w-3 text-zinc-500" />
                  </div>
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">Choose preset or browse 2,000+ palettes</TooltipContent>
          </Tooltip>
          <PopoverContent side="top" align="center" className="w-80 p-0 shadow-2xl border-zinc-800 bg-zinc-950">
            <Command shouldFilter={false} className="border-0 bg-transparent">
              <CommandInput
                placeholder="Search palettes (name or style)…"
                value={searchQuery}
                onValueChange={setSearchQuery}
                className="h-8 text-xs font-mono"
              />
              {/* quick size filter chips */}
              <div className="flex items-center gap-1 border-b border-zinc-800/80 bg-zinc-900/60 px-2 py-1">
                <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500 mr-0.5">Size:</span>
                {(
                  [
                    { id: 'all', label: 'All' },
                    { id: '8', label: '≤8c' },
                    { id: '16', label: '16c' },
                    { id: '32', label: '32c+' },
                  ] as const
                ).map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => setFilterSize(chip.id)}
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                      filterSize === chip.id
                        ? 'border border-teal-500/40 bg-teal-500/20 font-semibold text-teal-300'
                        : 'border border-transparent text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                    }`}
                  >
                    {chip.label}
                  </button>
                ))}
                <span className="ml-auto font-mono text-[9px] text-zinc-500">
                  {searchedPresets.length + searchedLibrary.length} found
                </span>
              </div>
              {/* Skin Variant Swap toggle: remap sprite pixels when picking any palette */}
              <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 bg-zinc-900/40 px-2 py-1.5">
                <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] text-zinc-300">
                  <input
                    type="checkbox"
                    checked={remapOnPick}
                    onChange={(e) => setRemapOnPick(e.target.checked)}
                    className="accent-teal-500"
                  />
                  <Sparkles className="h-3 w-3 text-teal-400" />
                  <span>Swap sprite skin on pick</span>
                </label>
                {remapOnPick ? (
                  <div className="flex items-center gap-0.5" role="group" aria-label="Remap mode">
                    {(['ramp', 'nearest'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setRemapMode(m)}
                        aria-pressed={remapMode === m}
                        className={`rounded px-1.5 py-0.5 font-mono text-[9px] capitalize ${
                          remapMode === m
                            ? 'bg-teal-500/20 text-teal-300 ring-1 ring-teal-500/40'
                            : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                        title={
                          m === 'ramp'
                            ? 'OKLab lightness-ramp swap (best for radical skin variants like Emerald → Lava/GameBoy)'
                            : 'Nearest OKLab color match (best for quantizing to similar hues)'
                        }
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const count = remapToPalette(palette, {
                        scope: 'clip',
                        mode: 'ramp',
                        updatePalette: false,
                        label: `Remap clip to ${currentPaletteName}`,
                      })
                      if (count > 0) {
                        toast({
                          title: `Remapped ${count} px`,
                          description: `Mapped active clip to ${currentPaletteName} (Ctrl+Z to undo).`,
                        })
                        setBrowserOpen(false)
                      }
                    }}
                    className="rounded border border-zinc-800 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400 hover:border-teal-500/40 hover:text-teal-300"
                    title="Remap active clip pixels onto the current palette"
                  >
                    Remap current
                  </button>
                )}
              </div>
              <CommandList className="max-h-72 overflow-y-auto">
                <CommandEmpty>
                  {library === null
                    ? libError
                      ? 'Library failed to load.'
                      : 'Loading 2,000+ palettes…'
                    : 'No matching palette found.'}
                </CommandEmpty>

                {searchedPresets.length > 0 && (
                  <CommandGroup heading={`Presets (${searchedPresets.length})`}>
                    {searchedPresets.map((p) => {
                      const isCurrent = sameColors(p.colors, palette)
                      return (
                        <CommandItem
                          key={p.id}
                          value={p.id}
                          onSelect={() => {
                            if (remapOnPick) {
                              const count = remapToPalette(p.colors, {
                                scope: 'clip',
                                mode: remapMode,
                                updatePalette: true,
                                label: `Skin swap: ${p.name}`,
                              })
                              toast({
                                title: `Skin swapped → ${p.name}`,
                                description: `${count} px remapped via OKLab ${remapMode} (Ctrl+Z to undo).`,
                              })
                            } else {
                              setPalette(p.colors, `Palette: ${p.name}`)
                            }
                            setBrowserOpen(false)
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-800/80"
                        >
                          <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                            {isCurrent && <Check className="h-3.5 w-3.5 text-teal-400" />}
                          </div>
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                              <span className="truncate font-mono text-[11px] text-zinc-200">
                                {p.name}
                              </span>
                              <span className="ml-1 shrink-0 font-mono text-[9px] text-zinc-400">
                                {p.colors.length}c
                              </span>
                            </div>
                            <div className="flex h-2 w-full overflow-hidden rounded-[2px]">
                              {p.colors.map((c, i) => (
                                <span key={i} className="h-full flex-1" style={{ backgroundColor: c }} />
                              ))}
                            </div>
                          </div>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                )}

                {searchedLibrary.length > 0 && (
                  <CommandGroup heading={`Library (${searchedLibrary.length})`}>
                    {searchedLibrary.slice(0, 80).map((p) => {
                      const isCurrent = sameColors(p.colors, palette)
                      return (
                        <CommandItem
                          key={p.id}
                          value={p.id}
                          onSelect={() => {
                            if (remapOnPick) {
                              const count = remapToPalette(p.colors, {
                                scope: 'clip',
                                mode: remapMode,
                                updatePalette: true,
                                label: `Skin swap: ${p.name}`,
                              })
                              toast({
                                title: `Skin swapped → ${p.name}`,
                                description: `${count} px remapped via OKLab ${remapMode} (Ctrl+Z to undo).`,
                              })
                            } else {
                              setPalette(p.colors, `Palette: ${p.name}`)
                            }
                            setBrowserOpen(false)
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-800/80"
                        >
                          <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                            {isCurrent && <Check className="h-3.5 w-3.5 text-teal-400" />}
                          </div>
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                              <span className="truncate font-mono text-[11px] text-zinc-200">
                                {p.name}
                              </span>
                              <span className="ml-1 shrink-0 font-mono text-[9px] text-zinc-400">
                                {p.colors.length}c
                              </span>
                            </div>
                            <div className="flex h-2 w-full overflow-hidden rounded-[2px]">
                              {p.colors.slice(0, 24).map((c, i) => (
                                <span key={i} className="h-full flex-1" style={{ backgroundColor: c }} />
                              ))}
                            </div>
                          </div>
                        </CommandItem>
                      )
                    })}
                    {searchedLibrary.length > 80 && (
                      <div className="p-2 text-center font-mono text-[9px] text-zinc-500">
                        Type to narrow — showing first 80 of {searchedLibrary.length} palettes
                      </div>
                    )}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
