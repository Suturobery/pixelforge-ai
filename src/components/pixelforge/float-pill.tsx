// PixelForge AI — floating restore pill (the small labeled button a panel
// collapses to, e.g. the animation "Preview" pill or the view toolbar "View"
// pill). Drag it anywhere on the stage like the panels themselves; a plain
// click (moved < 4px) activates it (restores the panel). Size comes from
// Settings → General → Floating buttons so it stays readable.
//
// POSITION CONTRACT (fix: pills wandered across app/browser starts):
// positions are stored as FRACTIONS of the stage (x, y in 0..1), so a saved
// spot restores to the same RELATIVE place no matter how the stage resizes
// (panel dock expand/collapse, window size, monitor change). Legacy saved
// positions in absolute pixels (> 1) still work: they are clamped, then
// migrated to fractions on the first measurement.

'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export const PILL_SIZE = {
  sm: { box: 'h-7 gap-1 rounded-md px-2 text-[10px]', icon: 'h-3 w-3' },
  md: { box: 'h-9 gap-1.5 rounded-lg px-3 text-xs', icon: 'h-3.5 w-3.5' },
  lg: { box: 'h-11 gap-2 rounded-lg px-4 text-sm', icon: 'h-4 w-4' },
} as const

export type PillSize = keyof typeof PILL_SIZE

export interface PillPos {
  x: number
  y: number
}

interface FloatPillProps {
  label: string
  ariaLabel: string
  icon: React.ReactNode
  size: PillSize
  pos: PillPos | null
  /** anchor classes used until the first drag (e.g. "bottom-3 left-3") */
  defaultAnchorClass: string
  /** fired on a plain click (no drag) — usually "restore the panel" */
  onActivate: () => void
  /** fired on every drag move — the owner persists the position (fractions) */
  onMoved: (p: PillPos) => void
  /** double-click: drop the saved position and return to the home anchor */
  onReset: () => void
  iconClassName?: string
}

export function FloatPill({
  label,
  ariaLabel,
  icon,
  size,
  pos,
  defaultAnchorClass,
  onActivate,
  onMoved,
  onReset,
  iconClassName = '',
}: FloatPillProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const [dragging, setDragging] = useState(false)
  // parent (stage) size — fractions convert through this
  const [parentSize, setParentSize] = useState<{ w: number; h: number } | null>(null)
  // latest pos/callback mirrors (kept in effects — refs must not be written
  // during render) so the observers below don't need to re-subscribe
  const posRef = useRef(pos)
  const onMovedRef = useRef(onMoved)
  useEffect(() => {
    posRef.current = pos
    onMovedRef.current = onMoved
  }, [pos, onMoved])

  const isFraction = (p: PillPos): boolean => p.x <= 1 && p.y <= 1

  /** stored pos → absolute px inside the current parent (legacy px supported) */
  const toAbs = (p: PillPos, pw: number, ph: number): PillPos => {
    if (isFraction(p)) return { x: Math.min(1, Math.max(0, p.x)) * pw, y: Math.min(1, Math.max(0, p.y)) * ph }
    return p
  }

  const clampAbs = (x: number, y: number): PillPos => {
    const el = ref.current
    const pw = parentSize?.w ?? el?.offsetParent?.clientWidth ?? 0
    const ph = parentSize?.h ?? el?.offsetParent?.clientHeight ?? 0
    const maxX = Math.max(8, pw - (el?.offsetWidth ?? 0) - 8)
    const maxY = Math.max(8, ph - (el?.offsetHeight ?? 0) - 8)
    return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) }
  }

  /** absolute → stored form (fractions) */
  const absToStored = (x: number, y: number): PillPos => {
    const pw = parentSize?.w ?? 1
    const ph = parentSize?.h ?? 1
    return { x: Math.min(1, Math.max(0, x / pw)), y: Math.min(1, Math.max(0, y / ph)) }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    const el = ref.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return
    const r = el.getBoundingClientRect()
    const pr = parent.getBoundingClientRect()
    drag.current = { sx: e.clientX, sy: e.clientY, ox: r.left - pr.left, oy: r.top - pr.top, moved: false }
    el.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
    d.moved = true
    const c = clampAbs(d.ox + dx, d.oy + dy)
    onMoved(absToStored(c.x, c.y))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const el = ref.current
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    if (drag.current?.moved) suppressClick.current = true
    drag.current = null
    setDragging(false)
  }

  const s = PILL_SIZE[size]

  // measure the parent (stage) so fractions render correctly
  useLayoutEffect(() => {
    const measure = () => {
      const parent = ref.current?.offsetParent as HTMLElement | null
      if (parent) setParentSize({ w: parent.clientWidth, h: parent.clientHeight })
    }
    measure()
    const parent = ref.current?.offsetParent as HTMLElement | null
    let ro: ResizeObserver | null = null
    if (parent) {
      ro = new ResizeObserver(measure)
      ro.observe(parent)
    }
    return () => ro?.disconnect()
  }, [])

  // self-heal + MIGRATE: clamp any stored position into the current stage.
  // Legacy absolute positions (>1) convert to fractions on first measurement,
  // then clamp — after this the stored form is always fractional.
  useEffect(() => {
    if (!parentSize) return
    const cur = posRef.current
    if (!cur) return
    const abs = toAbs(cur, parentSize.w, parentSize.h)
    const clamped = clampAbs(abs.x, abs.y)
    if (Math.abs(clamped.x - abs.x) > 0.5 || Math.abs(clamped.y - abs.y) > 0.5 || !isFraction(cur)) {
      onMovedRef.current(absToStored(clamped.x, clamped.y))
    }
  }, [parentSize])

  // also re-clamp when the owner feeds a new position programmatically
  useEffect(() => {
    if (!pos || !parentSize) return
    const raf = requestAnimationFrame(() => {
      const abs = toAbs(pos, parentSize.w, parentSize.h)
      const c = clampAbs(abs.x, abs.y)
      if (Math.abs(c.x - abs.x) > 0.5 || Math.abs(c.y - abs.y) > 0.5) onMovedRef.current(absToStored(c.x, c.y))
    })
    return () => cancelAnimationFrame(raf)
  }, [pos, parentSize])

  // rendered position: stored → absolute px (fractions scale with the stage)
  const renderedAbs = pos && parentSize ? toAbs(pos, parentSize.w, parentSize.h) : null

  return (
    <button
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      title={`${label} — drag to move · right-click to reset${pos ? '' : ' (home)'}`}
      className={`absolute z-30 flex touch-none select-none items-center border border-zinc-700/80 bg-zinc-900/80 text-xs font-medium text-zinc-300 shadow-lg backdrop-blur-xl transition-colors hover:border-zinc-500/60 hover:text-zinc-100 ${
        dragging ? 'cursor-grabbing shadow-xl' : 'cursor-grab'
      } ${s.box} ${renderedAbs ? '' : defaultAnchorClass}`}
      style={renderedAbs ? { left: renderedAbs.x, top: renderedAbs.y } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false
          return
        }
        onActivate()
      }}
      // right-click, not double-click: the plain click already opens the
      // panel (unmounting the pill), which kills the second click
      onContextMenu={(e) => {
        e.preventDefault()
        onReset()
      }}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}
