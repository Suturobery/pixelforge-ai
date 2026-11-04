// PixelForge AI — floating restore pill (the small labeled button a panel
// collapses to, e.g. the animation "Preview" pill or the view toolbar "View"
// pill). Drag it anywhere on the stage like the panels themselves; a plain
// click (moved < 4px) activates it (restores the panel). Size comes from
// Settings → General → Floating buttons so it stays readable.

'use client'

import { useEffect, useRef, useState } from 'react'

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
  /** fired on every drag move — the owner persists the position */
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
  // latest pos/callback mirrors (kept in effects — refs must not be written
  // during render) so the observers below don't need to re-subscribe
  const posRef = useRef(pos)
  const onMovedRef = useRef(onMoved)
  useEffect(() => {
    posRef.current = pos
    onMovedRef.current = onMoved
  }, [pos, onMoved])

  const clampTo = (cur: PillPos): PillPos | null => {
    const el = ref.current
    if (!el) return null
    const parent = el.offsetParent as HTMLElement | null
    if (!parent) return null
    const maxX = Math.max(8, parent.clientWidth - el.offsetWidth - 8)
    const maxY = Math.max(8, parent.clientHeight - el.offsetHeight - 8)
    if (cur.x <= maxX && cur.y <= maxY) return null
    return { x: Math.min(cur.x, maxX), y: Math.min(cur.y, maxY) }
  }

  const clamp = (x: number, y: number): PillPos => {
    const el = ref.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return { x, y }
    const maxX = Math.max(8, parent.clientWidth - el.offsetWidth - 8)
    const maxY = Math.max(8, parent.clientHeight - el.offsetHeight - 8)
    return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) }
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
    onMoved(clamp(d.ox + dx, d.oy + dy))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const el = ref.current
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    if (drag.current?.moved) suppressClick.current = true
    drag.current = null
    setDragging(false)
  }

  const s = PILL_SIZE[size]

  // self-heal a stored position that no longer fits: (a) on mount/when the
  // pill appears, and (b) whenever the stage itself resizes (rotation,
  // breakpoint flips, panel toggles). Deferred to rAF so state updates never
  // cascade synchronously inside the effect.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const clampNow = () => {
      const cur = posRef.current
      if (!cur) return
      const fixed = clampTo(cur)
      if (fixed) onMovedRef.current(fixed)
    }
    const raf = requestAnimationFrame(clampNow)
    const parent = el.offsetParent as HTMLElement | null
    let ro: ResizeObserver | null = null
    if (parent) {
      ro = new ResizeObserver(clampNow)
      ro.observe(parent)
    }
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [])

  // also re-clamp when the owner feeds a new position programmatically
  useEffect(() => {
    if (!pos) return
    const raf = requestAnimationFrame(() => {
      const fixed = clampTo(pos)
      if (fixed) onMovedRef.current(fixed)
    })
    return () => cancelAnimationFrame(raf)
  }, [pos])

  return (
    <button
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      title={`${label} — drag to move · right-click to reset${pos ? '' : ' (home)'}`}
      className={`absolute z-30 flex touch-none select-none items-center border border-zinc-700/80 bg-zinc-900/80 text-xs font-medium text-zinc-300 shadow-lg backdrop-blur-xl transition-colors hover:border-zinc-500/60 hover:text-zinc-100 ${
        dragging ? 'cursor-grabbing shadow-xl' : 'cursor-grab'
      } ${s.box} ${pos ? '' : defaultAnchorClass}`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
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
