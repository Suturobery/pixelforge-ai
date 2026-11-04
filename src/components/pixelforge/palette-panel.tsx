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
import { harvestPalette } from '@pixelforge/core'
import { savePanelRaw, onPanelsHydrated, resetPanelLayoutsOnce } from '@/lib/pixelforge/panel-storage'
import { useToast } from '@/hooks/use-toast'
import { FloatPill } from '@/components/pixelforge/float-pill'
import { Button } from '@/components/ui/button'
import { ColorPickerContent } from '@/components/pixelforge/color-picker'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { loadLibrary, type PalettePreset } from '@/lib/pixelforge/palettes'
import { ArrowLeftRight, BookOpen, EyeOff, Minus, Palette, Plus, Share2 } from 'lucide-react'
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
  // palette library browser: lazily loaded on first open (~2k named palettes)
  const [libOpen, setLibOpen] = useState(false)
  const [library, setLibrary] = useState<PalettePreset[] | null>(null)
  const [libError, setLibError] = useState(false)
  // the select is an "apply preset" control, but it DISPLAYS the palette the
  // document currently matches ("Forge 16" by default) — matches the original
  // studio reference; shows "custom" after manual add/remove edits
  const currentPreset = PALETTES.find((p) => sameColors(p.colors, palette))
  const currentPaletteName = currentPreset?.name ?? 'custom'
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
    if (!libOpen || library || libError) return
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
  }, [libOpen, library, libError])

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

      {/* footer: add/remove row, then the palette preset select below it
          (matches the original reference: "Forge 16" dropdown full-width) */}
      <div className="border-t border-zinc-800 px-3 py-1.5">
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
        </div>
        <Select
          value=""
          onValueChange={(id) => {
            const preset = PALETTES.find((p) => p.id === id)
            if (preset) setPalette(preset.colors, `Palette: ${preset.name}`)
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <SelectTrigger
                className="mt-1 h-6 w-full border-zinc-800 bg-zinc-950 px-1.5 font-mono text-[10px] text-zinc-300"
                aria-label="Apply a palette preset"
              >
                <SelectValue placeholder={currentPaletteName} />
              </SelectTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">Apply a palette preset</TooltipContent>
          </Tooltip>
          <SelectContent>
            {PALETTES.map((p) => (
              <SelectItem key={p.id} value={p.id} className="font-mono text-[11px]">
                {p.name} ({p.colors.length})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* share codes: copy the current palette as PF1-… or paste one in */}
        <Popover open={shareOpen} onOpenChange={setShareOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="mt-1 flex h-6 w-full items-center justify-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 font-mono text-[10px] text-zinc-300 hover:border-frost-500/60 hover:text-frost-300"
              aria-label="Share or paste a palette code"
            >
              <Share2 className="h-3 w-3" aria-hidden /> Share / Paste code…
            </button>
          </PopoverTrigger>
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

        {/* palette library browser: search + apply across the ~2k named palettes */}
        <Popover open={libOpen} onOpenChange={setLibOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="mt-1 flex h-6 w-full items-center justify-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 font-mono text-[10px] text-zinc-300 hover:border-frost-500/60 hover:text-frost-300"
                  aria-label="Browse the palette library"
                >
                  <BookOpen className="h-3 w-3" aria-hidden /> Library…
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">Search 2,000+ named palettes</TooltipContent>
          </Tooltip>
          <PopoverContent side="top" align="end" className="w-72 p-0">
            <Command>
              <CommandInput placeholder="Search palettes (name or style)…" />
              <CommandList>
                <CommandEmpty>
                  {library === null ? (libError ? 'Library failed to load.' : 'Loading library…') : 'No matching palette.'}
                </CommandEmpty>
                {(library ?? []).slice(0, 60).map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`${p.id} ${p.name} ${p.notes ?? ''}`}
                    onSelect={() => {
                      setPalette(p.colors, `Palette: ${p.name}`)
                      setLibOpen(false)
                    }}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-mono text-[11px] text-zinc-200">
                        {p.name} ({p.colors.length})
                      </span>
                      <div className="flex overflow-hidden rounded-sm">
                        {p.colors.slice(0, 12).map((c, i) => (
                          <span key={i} className="h-2 flex-1" style={{ background: c }} />
                        ))}
                      </div>
                    </div>
                  </CommandItem>
                ))}
                {library !== null && library.length > 60 && (
                  <div className="px-3 py-1.5 text-center text-[10px] text-zinc-500">
                    Type to narrow — showing first 60 of {library.length}
                  </div>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
