// PixelForge AI — floating animation preview, overlaid on the edit area.
// Task 6: while the EDITOR plays, this preview mirrors the shared playhead
// (timeline ⇄ preview always synchronized — §6 single playback engine).
// While the editor is paused it runs its own looping mini-preview using the
// SAME PlaybackClock class from @pixelforge/core (no duplicated timing).
// Draggable anywhere on the stage (grab the header) and scalable (drag the
// corner grip or use the −/+ stepper). Collapsible to a small pill.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { PlaybackClock, buildPlaybackCycle } from '@pixelforge/core'
import { useEditor, getActiveClip } from '@/lib/pixelforge/store'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { savePanelRaw, onPanelsHydrated } from '@/lib/pixelforge/panel-storage'
import { renderFrameScaled } from '@/lib/pixelforge/render'
import { FloatPill } from '@/components/pixelforge/float-pill'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Clapperboard, Pause, Play, X, ZoomIn, ZoomOut } from 'lucide-react'

const STORE_KEY = 'pixelforge-preview-v1'

interface PxPos {
  x: number
  y: number
}

interface PreviewPersist {
  open: boolean
  pos: PxPos | null
  pillPos: PxPos | null
}

function loadSaved(): PreviewPersist {
  if (typeof window === 'undefined') return { open: true, pos: null, pillPos: null }
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return { open: true, pos: null, pillPos: null }
    const p = JSON.parse(raw) as Partial<PreviewPersist>
    const ok = (v: PxPos | null | undefined) =>
      !!v && typeof v.x === 'number' && typeof v.y === 'number' ? (v as PxPos) : null
    return { open: p.open !== false, pos: ok(p.pos), pillPos: ok(p.pillPos) }
  } catch {
    return { open: true, pos: null, pillPos: null }
  }
}

const MIN_SIZE = 80
const MAX_SIZE = 320
const SIZE_STEP = 32
// card chrome around the canvas: p-1.5 (12) + border (2) per axis
const CHROME = 14

const clampSize = (n: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)))

interface DragState {
  mode: 'move' | 'resize'
  sx: number
  sy: number
  px: number
  py: number
  size0: number
  cw0: number
  ch0: number
}

export function PreviewOverlay() {
  const [open, setOpen] = useState(true)
  const [loopOn, setLoopOn] = useState(true)
  // pos = top-left inside the stage (null → default bottom-left until first drag)
  const [pos, setPos] = useState<PxPos | null>(null)
  // pillPos = where the collapsed "Preview" restore pill sits (draggable)
  const [pillPos, setPillPos] = useState<PxPos | null>(null)
  const [size, setSize] = useState(112)
  const [dragging, setDragging] = useState(false)
  const floatBtnSize = useAppSettings((s) => s.floatBtnSize)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const hydratedRef = useRef(false)

  const project = useEditor((s) => s.project)
  const activeClipId = useEditor((s) => s.activeClipId)
  const activeFrameIndex = useEditor((s) => s.activeFrameIndex)
  const editorPlaying = useEditor((s) => s.playing)
  const renderTick = useEditor((s) => s.renderTick)
  const clip = getActiveClip(useEditor.getState())
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // ------------------------------------------------------------- animation
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !open) return
    const drawAt = (i: number) => {
      const st = useEditor.getState()
      const c = getActiveClip(st)
      const frame = c.frames[Math.min(Math.max(0, i), c.frames.length - 1)]
      if (frame) renderFrameScaled(canvas, c, frame, st.project.width, st.project.height)
    }
    // Editor playback: MIRROR the shared playhead — zero timing of its own,
    // guaranteed synchronized with the timeline (Task 6 §6).
    if (editorPlaying || !loopOn) {
      drawAt(activeFrameIndex)
      return
    }
    // Paused editor: standalone looping mini-preview driven by the SAME
    // PlaybackClock implementation the timeline uses (own instance; always
    // loops so the "finished animation" view never freezes).
    const cycle = buildPlaybackCycle({ ...clip, loop: true })
    if (cycle.totalMs <= 0 || cycle.entries.length === 0) {
      drawAt(activeFrameIndex)
      return
    }
    const clock = new PlaybackClock(cycle)
    let raf = 0
    let last = performance.now()
    drawAt(clock.currentFrame())
    const tick = (now: number) => {
      const delta = Math.min(now - last, 1000)
      last = now
      const t = clock.tick(delta)
      if (t.changed) drawAt(t.frame)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, loopOn, editorPlaying, project, activeClipId, activeFrameIndex, renderTick, clip])

  // ------------------------------------------------------ position helpers
  const clampXY = useCallback((x: number, y: number, w: number, h: number) => {
    const parent = rootRef.current?.parentElement
    if (!parent) return { x, y }
    const maxX = Math.max(0, parent.clientWidth - w)
    const maxY = Math.max(0, parent.clientHeight - h)
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) }
  }, [])

  // restore persisted visibility/positions once (deferred to rAF so the first
  // paint uses the stable defaults; hydration lands on the next frame)
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

  // Task 13a (desktop): re-read when the settings-file hydration lands
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

  // persist visibility + positions (only after hydration — never wipe storage);
  // savePanelRaw mirrors into the desktop settings file (Task 13a)
  useEffect(() => {
    if (!hydratedRef.current || typeof window === 'undefined') return
    savePanelRaw(STORE_KEY, { open, pos, pillPos })
  }, [open, pos, pillPos])

  // re-clamp the card position on every change (deferred to rAF for the
  // strict-effects lint rule) — covers positions saved on a bigger screen
  useEffect(() => {
    if (!pos) return
    const root = rootRef.current
    if (!root) return
    const raf = requestAnimationFrame(() => {
      setPos((cur) => {
        if (!cur) return cur
        const r = root.getBoundingClientRect()
        const c = clampXY(cur.x, cur.y, r.width, r.height)
        return c.x !== cur.x || c.y !== cur.y ? c : cur
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [pos, clampXY])

  // first open: anchor at the bottom-left of the stage
  useEffect(() => {
    if (!open) return
    setPos((p) => {
      if (p) return p
      const root = rootRef.current
      const parent = root?.parentElement
      if (!root || !parent) return p
      const r = root.getBoundingClientRect()
      return clampXY(12, parent.clientHeight - r.height - 12, r.width, r.height)
    })
  }, [open, clampXY])

  // keep the card inside the stage when the size or the stage itself changes
  useEffect(() => {
    setPos((p) => {
      if (!p) return p
      const root = rootRef.current
      const parent = root?.parentElement
      if (!root || !parent) return p
      const r = root.getBoundingClientRect()
      return clampXY(p.x, p.y, r.width, r.height)
    })
  }, [size, clampXY])

  useEffect(() => {
    const parent = rootRef.current?.parentElement
    if (!parent) return
    const ro = new ResizeObserver(() => {
      setPos((p) => {
        if (!p) return p
        const root = rootRef.current
        if (!root) return p
        const r = root.getBoundingClientRect()
        return clampXY(p.x, p.y, r.width, r.height)
      })
    })
    ro.observe(parent)
    return () => ro.disconnect()
  }, [clampXY])

  // ------------------------------------------------------ drag & resize
  const startDrag = (e: React.PointerEvent, mode: 'move' | 'resize') => {
    const root = rootRef.current
    if (!root || e.button !== 0) return
    e.preventDefault()
    const parent = root.parentElement
    const r = root.getBoundingClientRect()
    const pr = parent?.getBoundingClientRect()
    const px = pr ? r.left - pr.left : r.left
    const py = pr ? r.top - pr.top : r.top
    if (mode === 'move' && !pos) setPos({ x: px, y: py })
    dragRef.current = {
      mode,
      sx: e.clientX,
      sy: e.clientY,
      px,
      py,
      size0: size,
      cw0: r.width,
      ch0: r.height,
    }
    root.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const onHeaderDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    startDrag(e, 'move')
  }

  const onGripDown = (e: React.PointerEvent) => startDrag(e, 'resize')

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (d.mode === 'move') {
      setPos(clampXY(d.px + dx, d.py + dy, d.cw0, d.ch0))
    } else {
      const ns = clampSize(d.size0 + Math.max(dx, dy))
      const grow = ns - d.size0
      setSize(ns)
      setPos(clampXY(d.px, d.py, d.cw0 + grow, d.ch0 + grow))
    }
  }

  const endDrag = (e: React.PointerEvent) => {
    const root = rootRef.current
    if (root?.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId)
    dragRef.current = null
    setDragging(false)
  }

  const stepSize = (d: number) => setSize((s) => clampSize(s + d))

  // ------------------------------------------------------------- collapsed
  // collapsed: a labeled, DRAGGABLE restore pill (plain click restores)
  if (!open) {
    return (
      <FloatPill
        label="Preview"
        ariaLabel="Show animation preview"
        icon={<Clapperboard className="h-full text-teal-400" aria-hidden />}
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
      role="region"
      aria-label="Animation preview"
      className={`absolute z-20 rounded-lg border border-zinc-700/80 bg-zinc-900/90 p-1.5 shadow-xl backdrop-blur ${
        dragging ? 'select-none' : ''
      }`}
      style={pos ? { left: pos.x, top: pos.y, width: size + CHROME } : { left: 12, bottom: 12, width: size + CHROME }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* header — drag handle */}
      <div
        className="mb-1 flex touch-none cursor-grab items-center justify-between gap-1 active:cursor-grabbing"
        onPointerDown={onHeaderDown}
        title="Drag to move the preview"
      >
        <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-zinc-400">
          <Clapperboard className="h-3 w-3 text-teal-400" aria-hidden /> Preview
        </span>
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-zinc-400 hover:text-teal-300"
                onClick={() => setLoopOn(!loopOn)}
                aria-label={loopOn ? 'Pause preview loop' : 'Resume preview loop'}
                aria-pressed={loopOn}
              >
                {loopOn ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{loopOn ? 'Pause preview loop' : 'Resume preview loop'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-zinc-400 hover:text-zinc-300"
                onClick={() => setOpen(false)}
                aria-label="Hide preview"
              >
                <X className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Hide — click the Preview pill to bring it back</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* preview canvas + corner resize grip */}
      <div className="relative" style={{ width: size, height: size }}>
        <canvas
          ref={canvasRef}
          width={256}
          height={256}
          style={{ width: size, height: size, imageRendering: 'pixelated' }}
          className="pixelforge-checker block rounded-md border border-zinc-800"
          aria-label="Looping animation preview of the active clip"
        />
        <div
          role="separator"
          aria-label="Drag to resize preview"
          title="Drag to resize"
          onPointerDown={onGripDown}
          className="absolute bottom-0.5 right-0.5 h-4 w-4 touch-none cursor-nwse-resize text-zinc-400 hover:text-teal-300"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="h-full w-full" aria-hidden>
            <path d="M14 7 7 14" />
            <path d="M14 11 11 14" />
          </svg>
        </div>
      </div>

      <div
        className="mt-0.5 truncate text-center font-mono text-[9px] text-zinc-400"
        title={`${clip.name} · ${clip.fps}fps · ${clip.frames.length} frames`}
      >
        {clip.name} · {clip.fps}fps · {clip.frames.length}f
        {editorPlaying && <span className="text-teal-400"> · synced</span>}
      </div>

      {/* scale stepper */}
      <div className="mt-0.5 flex items-center justify-center gap-0.5" role="group" aria-label="Preview size">
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-zinc-400 hover:text-teal-300"
          onClick={() => stepSize(-SIZE_STEP)}
          disabled={size <= MIN_SIZE}
          aria-label="Smaller preview"
        >
          <ZoomOut className="h-3 w-3" />
        </Button>
        <span className="w-9 text-center font-mono text-[9px] text-zinc-400" aria-live="polite">
          {size}px
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-zinc-400 hover:text-teal-300"
          onClick={() => stepSize(SIZE_STEP)}
          disabled={size >= MAX_SIZE}
          aria-label="Bigger preview"
        >
          <ZoomIn className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}
