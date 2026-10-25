// PixelForge AI — floating view toolbar (zoom out/in %, fit, grid).
// Per user request: the toolbar can be dragged anywhere over the stage and
// hidden; position + visibility persist in localStorage. Drag anywhere on the
// pill chrome (the zoom % is the grip); buttons stay clickable.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor } from '@/lib/pixelforge/store'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { savePanelRaw, onPanelsHydrated } from '@/lib/pixelforge/panel-storage'
import { FloatPill } from '@/components/pixelforge/float-pill'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Scan, ZoomIn, ZoomOut, Grid3X3, EyeOff, SlidersHorizontal } from 'lucide-react'

const STORE_KEY = 'pixelforge-viewbar-v1'
const MARGIN = 10

interface Pos {
  x: number
  y: number
}

function loadSaved(): { pos: Pos | null; hidden: boolean } {
  if (typeof window === 'undefined') return { pos: null, hidden: false }
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return { pos: null, hidden: false }
    const p = JSON.parse(raw) as { pos?: Pos | null; hidden?: boolean }
    const pos =
      p.pos && typeof p.pos.x === 'number' && typeof p.pos.y === 'number' ? p.pos : null
    return { pos, hidden: Boolean(p.hidden) }
  } catch {
    return { pos: null, hidden: false }
  }
}

export function ViewToolbar({
  onZoomBy,
  onFit,
}: {
  onZoomBy: (factor: number) => void
  onFit: () => void
}) {
  const zoom = useEditor((s) => s.zoom)
  const showGrid = useEditor((s) => s.showGrid)
  const setShowGrid = useEditor((s) => s.setShowGrid)
  const floatBtnSize = useAppSettings((s) => s.floatBtnSize)
  const [pos, setPos] = useState<Pos | null>(null)
  const [hidden, setHidden] = useState(false)
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const hydratedRef = useRef(false)

  // load persisted position / visibility once (deferred so the first paint is
  // the stable bottom-right anchor; hydration lands on the next frame)
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const saved = loadSaved()
      setPos(saved.pos)
      setHidden(saved.hidden)
      hydratedRef.current = true
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  // Task 13a (desktop): re-read when the settings-file hydration lands
  useEffect(
    () =>
      onPanelsHydrated(() => {
        const saved = loadSaved()
        setPos(saved.pos)
        setHidden(saved.hidden)
      }),
    [],
  )

  // persist on change (after hydration so we never wipe the stored value);
  // savePanelRaw mirrors into the desktop settings file (Task 13a)
  useEffect(() => {
    if (!hydratedRef.current || typeof window === 'undefined') return
    savePanelRaw(STORE_KEY, { pos, hidden })
  }, [pos, hidden])

  // keep the pill inside the stage when the container shrinks
  useEffect(() => {
    const parent = rootRef.current?.offsetParent as HTMLElement | null
    if (!parent) return
    const ro = new ResizeObserver(() => {
      const el = rootRef.current
      setPos((cur) => {
        if (!el || !cur) return cur
        const maxX = Math.max(MARGIN, parent.clientWidth - el.offsetWidth - MARGIN)
        const maxY = Math.max(MARGIN, parent.clientHeight - el.offsetHeight - MARGIN)
        if (cur.x <= maxX && cur.y <= maxY) return cur
        return { x: Math.min(cur.x, maxX), y: Math.min(cur.y, maxY) }
      })
    })
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  const clamp = useCallback((x: number, y: number): Pos => {
    const el = rootRef.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return { x, y }
    const maxX = Math.max(MARGIN, parent.clientWidth - el.offsetWidth - MARGIN)
    const maxY = Math.max(MARGIN, parent.clientHeight - el.offsetHeight - MARGIN)
    return { x: Math.min(Math.max(MARGIN, x), maxX), y: Math.min(Math.max(MARGIN, y), maxY) }
  }, [])

  // re-clamp on every position change — covers a position saved on a big
  // desktop screen being restored on a phone (the ResizeObserver above only
  // fires on parent resizes, not on hydration). Deferred to rAF so the
  // state update never cascades synchronously inside the effect.
  useEffect(() => {
    if (!pos) return
    const el = rootRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      setPos((cur) => {
        if (!cur) return cur
        const c = clamp(cur.x, cur.y)
        return c.x !== cur.x || c.y !== cur.y ? c : cur
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [pos, clamp])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // buttons stay clickable — only the pill chrome drags
    if ((e.target as HTMLElement).closest('button')) return
    const el = rootRef.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return
    const rect = el.getBoundingClientRect()
    const pRect = parent.getBoundingClientRect()
    const origin = { x: rect.left - pRect.left, y: rect.top - pRect.top }
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: origin.x, oy: origin.y }
    if (!pos) setPos(origin) // first drag anchors the pill where it currently is
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

  const anchorClass = pos ? '' : 'bottom-3 right-3'

  // hidden state: a labeled restore pill in the same spot — draggable like the
  // panels (a plain click restores; dragging just moves the pill)
  if (hidden) {
    return (
      <FloatPill
        label="View"
        ariaLabel="Show view toolbar"
        icon={<SlidersHorizontal className={`text-teal-400 ${floatBtnSize === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5'}`} aria-hidden />}
        size={floatBtnSize}
        pos={pos}
        defaultAnchorClass="bottom-3 right-3"
        onActivate={() => setHidden(false)}
        onMoved={setPos}
      />
    )
  }

  const zoomPct = Math.round(zoom * 100)

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="View controls — drag to move, click the eye to hide"
      className={`absolute z-30 flex touch-none select-none items-center gap-0.5 rounded-lg border border-zinc-700/80 bg-zinc-900/90 p-1 shadow-lg backdrop-blur ${
        dragging ? 'cursor-grabbing shadow-xl' : 'cursor-grab'
      } ${anchorClass}`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onZoomBy(1 / 1.25)} aria-label="Zoom out">
            <ZoomOut className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Zoom out</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="w-12 cursor-grab text-center font-mono text-[11px] text-zinc-400"
            title="Drag to move the toolbar"
            aria-label="Zoom level — drag to move the toolbar"
          >
            {zoomPct}%
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">Drag to move the toolbar</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onZoomBy(1.25)} aria-label="Zoom in">
            <ZoomIn className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Zoom in</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onFit} aria-label="Fit view">
            <Scan className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Fit view</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={showGrid ? 'secondary' : 'ghost'}
            size="icon"
            className="h-7 w-7"
            onClick={() => setShowGrid(!showGrid)}
            aria-label="Toggle grid"
            aria-pressed={showGrid}
          >
            <Grid3X3 className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Toggle grid</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-zinc-400 hover:text-zinc-100"
            onClick={() => setHidden(true)}
            aria-label="Hide view toolbar"
          >
            <EyeOff className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Hide — click the sliders pill to bring it back</TooltipContent>
      </Tooltip>
    </div>
  )
}
