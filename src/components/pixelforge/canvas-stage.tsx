// PixelForge AI — pixel canvas stage
// Deterministic Canvas 2D rendering: composite → scaled draw with smoothing
// off, checkerboard backdrop, pixel grid, onion skin, hover cursor, zoom/pan.

'use client'

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { ONION_MAX, floodFillDither, pixelPerfectStroke, type PixelPerfectState } from '@pixelforge/core'
import { useEditor, getActiveClip, MIN_ZOOM, MAX_ZOOM } from '@/lib/pixelforge/store'
import { useToast } from '@/hooks/use-toast'
import { friendlyError } from '@/lib/utils'
import { hexToRgba } from '@/lib/pixelforge/color'
import {
  stampBrush,
  stampCustomBuffer,
  drawLinePixels,
  drawRectPixels,
  drawEllipsePixels,
  floodFill,
  moveBuffer,
} from '@/lib/pixelforge/pixels'
import {
  composeSelectionMove,
  rectFromPoints,
  pointInSelection,
  shiftRectClamped,
} from '@/lib/pixelforge/selection-ops'
import { drawFrame, type OnionGhost } from '@/lib/pixelforge/render'
import { useAppSettings } from '@/lib/pixelforge/settings'
import type { SelectionRect, StrokeHandle } from '@/lib/pixelforge/store'
import type { ToolId } from '@/lib/pixelforge/types'
import { PreviewOverlay } from '@/components/pixelforge/preview-overlay'
import { ViewToolbar } from '@/components/pixelforge/view-toolbar'
import { ToolOptionsBar } from '@/components/pixelforge/tool-options-bar'
import { PalettePanel } from '@/components/pixelforge/palette-panel'
import { ReferenceOverlay } from '@/components/pixelforge/reference-overlay'

// Memoized floating overlays: CanvasStage re-renders on pixel hover moves,
// so wrapping these prevents hover from reconciling 5 unrelated UI panels.
const MemoPreviewOverlay = memo(PreviewOverlay)
const MemoPalettePanel = memo(PalettePanel)
const MemoReferenceOverlay = memo(ReferenceOverlay)
const MemoViewToolbar = memo(ViewToolbar)
const MemoToolOptionsBar = memo(ToolOptionsBar)

// --------------------------------------------------------- free-scale handles
// The marquee selection gets 8 handles (corners + edge midpoints). The dots
// are a visual overlay; the CANVAS hit-tests them in onPointerDown so they
// never block painting, and dragging one resizes the selection square freely
// — on release the content is NN-resampled into the new footprint (scaleTo).

type ScaleHandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const HANDLE_ANCHORS: Array<{ id: ScaleHandleId; fx: 0 | 0.5 | 1; fy: 0 | 0.5 | 1 }> = [
  { id: 'nw', fx: 0, fy: 0 },
  { id: 'n', fx: 0.5, fy: 0 },
  { id: 'ne', fx: 1, fy: 0 },
  { id: 'e', fx: 1, fy: 0.5 },
  { id: 'se', fx: 1, fy: 1 },
  { id: 's', fx: 0.5, fy: 1 },
  { id: 'sw', fx: 0, fy: 1 },
  { id: 'w', fx: 0, fy: 0.5 },
]

const HANDLE_CURSOR: Record<ScaleHandleId, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
}

/** The 8 scale-handle points of a rect, in canvas coordinates. */
function handlePoints(r: SelectionRect): Array<{ id: ScaleHandleId; x: number; y: number }> {
  return HANDLE_ANCHORS.map((h) => ({ id: h.id, x: r.x + r.w * h.fx, y: r.y + r.h * h.fy }))
}

/** Shrink a rect into the canvas, never smaller than 1×1. */
function clampSelRect(r: SelectionRect, W: number, H: number): SelectionRect {
  const x = Math.max(0, Math.min(r.x, W - 1))
  const y = Math.max(0, Math.min(r.y, H - 1))
  return {
    x,
    y,
    w: Math.max(1, Math.min(r.x + r.w, W) - x),
    h: Math.max(1, Math.min(r.y + r.h, H) - y),
  }
}

interface Interaction {
  mode: 'paint' | 'shape' | 'move' | 'pan' | 'marquee-create' | 'sel-move' | 'sel-scale'
  tool?: ToolId
  start: { x: number; y: number }
  last: { x: number; y: number }
  handle?: StrokeHandle
  snapshot?: Uint8ClampedArray
  changed: boolean
  /** paint: which pointer button started the stroke (2 = secondary color) */
  btn?: number
  /** paint: pixel-perfect freehand state (pencil/eraser, 1px, no mirror) */
  pp?: PixelPerfectState
  panStart?: { cx: number; cy: number; panX: number; panY: number }
  /** marquee-create / sel-move / sel-scale */
  selectionStart?: SelectionRect
  /** sel-scale: which handle is being dragged */
  scaleHandle?: ScaleHandleId
  /** sel-move: currently applied pixel offset (committed on pointer-up). */
  moveDx?: number
  moveDy?: number
}

export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const offRef = useRef<HTMLCanvasElement | null>(null)
  const interactionRef = useRef<Interaction | null>(null)
  const wheelZoomRef = useRef<{ factor: number; cx: number; cy: number } | null>(null)
  const wheelZoomRafRef = useRef<number | null>(null)

  const project = useEditor((s) => s.project)
  const activeClipId = useEditor((s) => s.activeClipId)
  const activeFrameIndex = useEditor((s) => s.activeFrameIndex)
  const zoom = useEditor((s) => s.zoom)
  const panX = useEditor((s) => s.panX)
  const panY = useEditor((s) => s.panY)
  const showGrid = useEditor((s) => s.showGrid)
  const tileSize = useEditor((s) => s.tileSize)
  const tileSnap = useEditor((s) => s.tileSnap)
  const onionSkin = useEditor((s) => s.onionSkin)
  const onionOpacity = useAppSettings((s) => s.onionOpacity)
  const onionPrevTint = useAppSettings((s) => s.onionPrevTint)
  const onionNextTint = useAppSettings((s) => s.onionNextTint)
  const tool = useEditor((s) => s.tool)
  const primary = useEditor((s) => s.primary)
  const brushSize = useEditor((s) => s.brushSize)
  const brushShape = useEditor((s) => s.brushShape)
  const customBrush = useEditor((s) => s.customBrush)
  const grayscale = useEditor((s) => s.grayscale)
  const [dragOver, setDragOver] = useState(false)
  const { toast } = useToast()
  const mirrorX = useEditor((s) => s.mirrorX)
  const mirrorY = useEditor((s) => s.mirrorY)
  const rightTab = useEditor((s) => s.rightTab)
  const motionDraftParts = useEditor((s) => s.motionDraftParts)
  const ellipseFilled = useEditor((s) => s.ellipseFilled)
  const selection = useEditor((s) => s.selection)
  const playing = useEditor((s) => s.playing)
  const renderTick = useEditor((s) => s.renderTick)
  const hover = useEditor((s) => s.hover)
  const projectId = useEditor((s) => s.projectId)
  const filePath = useEditor((s) => s.filePath)
  const loadEpoch = useEditor((s) => s.loadEpoch)
  const [, forceRedraw] = useState(0)
  // marching-ants animation tick (only runs while a selection exists)
  const [antsTick, setAntsTick] = useState(0)
  // free-scale draft: the in-progress selection rect while a scale handle is
  // being dragged (drives the ants overlay; commits as ONE scaleTo op on
  // release). The ref mirrors the state so pointerup reads the latest value.
  const [scaleDraft, setScaleDraft] = useState<SelectionRect | null>(null)
  const scaleDraftRef = useRef<SelectionRect | null>(null)
  // true when the composited active frame is fully transparent — we show a
  // "this frame is empty" hint so a blank canvas is never mistaken for lost
  // pixel data (top user confusion after adding an empty frame)
  const [frameEmpty, setFrameEmpty] = useState(false)

  // zoom anchored at the viewport center (buttons used to expand the canvas
  // from its top-left corner, drifting it off-screen)
  const zoomBy = useCallback((factor: number) => {
    const st = useEditor.getState()
    const container = containerRef.current
    const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, st.zoom * factor))
    if (!container) {
      st.setZoom(nz)
      return
    }
    const rect = container.getBoundingClientRect()
    const cx = rect.width / 2
    const cy = rect.height / 2
    const wx = (cx - st.panX) / st.zoom
    const wy = (cy - st.panY) / st.zoom
    // One atomic store update avoids a redundant intermediate canvas redraw.
    useEditor.setState({ zoom: nz, panX: cx - wx * nz, panY: cy - wy * nz })
  }, [])

  const { width: W, height: H } = project

  // ------------------------------------------------------------- composite
  useEffect(() => {
    if (!offRef.current) offRef.current = document.createElement('canvas')
    const off = offRef.current
    if (off.width !== W || off.height !== H) {
      off.width = W
      off.height = H
    }
    const ctx = off.getContext('2d')
    if (!ctx) return
    const st = useEditor.getState()
    const clip = getActiveClip(st)
    const len = clip.frames.length
    const idx = Math.min(activeFrameIndex, len - 1)
    const frame = clip.frames[idx]
    if (!frame) {
      ctx.clearRect(0, 0, W, H)
      return
    }
    // Onion skin (Task 6 §4): prev/next counts are DOCUMENT settings
    // (undoable via settings.setOnion); opacity + tints are view prefs.
    // Ghosts wrap the loop seam only when the clip actually loops.
    const ghosts: OnionGhost[] = []
    if (onionSkin && len > 1) {
      const { prev: prevCount, next: nextCount } = st.project.settings.onion
      for (let d = 1; d <= Math.min(prevCount, ONION_MAX); d++) {
        const i = idx - d
        if (i < 0 && !clip.loop) break
        const f = clip.frames[((i % len) + len) % len]
        if (f && f !== frame) {
          ghosts.push({ frame: f, depth: d - 1, dir: 'prev', tint: onionPrevTint, opacity: onionOpacity })
        }
      }
      for (let d = 1; d <= Math.min(nextCount, ONION_MAX); d++) {
        const i = idx + d
        if (i > len - 1 && !clip.loop) break
        const f = clip.frames[i % len]
        if (f && f !== frame) {
          ghosts.push({ frame: f, depth: d - 1, dir: 'next', tint: onionNextTint, opacity: onionOpacity })
        }
      }
    }
    drawFrame(ctx, clip, frame, W, H, { ghosts })
    // detect a fully-empty ACTIVE frame — scan the cel buffers directly so
    // onion-skin ghosts don't mask the "empty frame" hint
    let hasPixel = false
    for (const layer of clip.layers) {
      if (!layer.visible) continue
      const cel = frame.cels[layer.id]
      if (!cel) continue // absent cel = transparent (C2)
      const d = cel.buffer
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] > 0) {
          hasPixel = true
          break
        }
      }
      if (hasPixel) break
    }
    setFrameEmpty((cur) => (cur === hasPixel ? cur : !hasPixel))
  }, [project, activeClipId, activeFrameIndex, renderTick, onionSkin, onionOpacity, onionPrevTint, onionNextTint, W, H])

  // marching ants: step the dash offset while a selection is visible
  useEffect(() => {
    if (!selection || playing) return
    const t = setInterval(() => setAntsTick((v) => v + 1), 120)
    return () => clearInterval(t)
  }, [selection, playing])

  // ----------------------------------------------------------------- paint
  useEffect(() => {
    const canvas = canvasRef.current
    const board = boardRef.current
    if (!canvas || !board || !offRef.current) return
    const dpr = window.devicePixelRatio || 1
    const cw = W * zoom
    const ch = H * zoom
    const bw = Math.max(1, Math.round(cw * dpr))
    const bh = Math.max(1, Math.round(ch * dpr))
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }
    canvas.style.width = `${cw}px`
    canvas.style.height = `${ch}px`
    board.style.width = `${cw}px`
    board.style.height = `${ch}px`
    board.style.transform = `translate(${panX}px, ${panY}px)`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, cw, ch)
    ctx.drawImage(offRef.current, 0, 0, cw, ch)

    // pixel grid
    // The grid used to wait for 500% zoom, which made the enabled Grid
    // control look broken at normal editing magnification. At 200% each
    // cell still has enough room for a crisp one-pixel line.
    if (showGrid && zoom >= 2) {
      ctx.lineWidth = 1
      // Draw each grid weight as ONE path. The previous implementation
      // stroked every row and column independently (up to 512 strokes per
      // redraw), which made wheel zoom stutter on larger canvases.
      for (const strong of [false, true]) {
        ctx.strokeStyle = strong ? 'rgba(25, 57, 61, 0.62)' : 'rgba(25, 57, 61, 0.28)'
        ctx.beginPath()
        for (let x = 0; x <= W; x++) {
          if ((x % 8 === 0) !== strong) continue
          const px = Math.round(x * zoom * dpr) / dpr + 0.5 / dpr
          ctx.moveTo(px, 0)
          ctx.lineTo(px, ch)
        }
        for (let y = 0; y <= H; y++) {
          if ((y % 8 === 0) !== strong) continue
          const py = Math.round(y * zoom * dpr) / dpr + 0.5 / dpr
          ctx.moveTo(0, py)
          ctx.lineTo(cw, py)
        }
        ctx.stroke()
      }
    }

    // Task 10b tilemap grid: teal tile-boundary lines over the pixel grid so
    // the snap grid is visible even at low zoom (where the pixel grid hides)
    if (tileSnap && zoom >= 2) {
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(45, 212, 191, 0.35)'
      ctx.beginPath()
      for (let x = 0; x <= W; x += tileSize) {
        const px = Math.round(x * zoom * dpr) / dpr + 0.5 / dpr
        ctx.moveTo(px, 0)
        ctx.lineTo(px, ch)
      }
      for (let y = 0; y <= H; y += tileSize) {
        const py = Math.round(y * zoom * dpr) / dpr + 0.5 / dpr
        ctx.moveTo(0, py)
        ctx.lineTo(cw, py)
      }
      ctx.stroke()
    }

    // Symmetry centerline guides (Mirror X / Mirror Y)
    if ((mirrorX || mirrorY) && !playing) {
      ctx.save()
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = 'rgba(45, 212, 191, 0.65)'
      ctx.beginPath()
      if (mirrorX) {
        const mx = Math.round((W / 2) * zoom * dpr) / dpr + 0.5 / dpr
        ctx.moveTo(mx, 0)
        ctx.lineTo(mx, ch)
      }
      if (mirrorY) {
        const my = Math.round((H / 2) * zoom * dpr) / dpr + 0.5 / dpr
        ctx.moveTo(0, my)
        ctx.lineTo(cw, my)
      }
      ctx.stroke()
      ctx.restore()
    }

    // Motion part bounding boxes overlay when the Motion tab is active
    if (rightTab === 'motion' && !playing) {
      const clip = getActiveClip(useEditor.getState())
      const parts = motionDraftParts.length > 0 ? motionDraftParts : clip.parts
      const partColors = ['#2ce8f5', '#a7f070', '#ffcd75', '#ef7d57', '#f4f4f4', '#73eff7', '#b13e53', '#38b764']
      ctx.save()
      parts.forEach((p, idx) => {
        const r = p.rect ?? { x: 0, y: 0, w: W, h: H }
        const color = partColors[idx % partColors.length]
        const rx = r.x * zoom
        const ry = r.y * zoom
        const rw = r.w * zoom
        const rh = r.h * zoom
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.setLineDash([3, 2])
        ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(1, rw - 1), Math.max(1, rh - 1))
        if (zoom >= 4) {
          ctx.setLineDash([])
          ctx.font = '600 9px monospace'
          const tw = ctx.measureText(p.name).width + 6
          ctx.fillStyle = 'rgba(9, 9, 11, 0.82)'
          ctx.fillRect(rx, Math.max(0, ry - 12), tw, 12)
          ctx.fillStyle = color
          ctx.fillText(p.name, rx + 3, Math.max(9, ry - 3))
        }
      })
      ctx.restore()
    }

    // hover cursor (paint tools), grey like the frame-thumb hover border
    if (hover && !playing && tool !== 'eyedropper' && tool !== 'move' && tool !== 'marquee') {
      const size = tool === 'fill' ? 1 : brushSize
      const off2 = Math.floor((Math.max(1, size) - 1) / 2)
      const hx = (hover.x - off2) * zoom
      const hy = (hover.y - off2) * zoom
      const hs = Math.max(1, size) * zoom
      ctx.strokeStyle = 'rgba(113, 113, 122, 0.9)'
      ctx.lineWidth = 1
      if (customBrush) {
        ctx.strokeRect(
          (hover.x - Math.floor(customBrush.w / 2)) * zoom + 0.5,
          (hover.y - Math.floor(customBrush.h / 2)) * zoom + 0.5,
          customBrush.w * zoom - 1,
          customBrush.h * zoom - 1,
        )
      } else if (brushShape === 'circle') {
        ctx.beginPath()
        ctx.arc(hx + hs / 2, hy + hs / 2, hs / 2, 0, Math.PI * 2)
        ctx.stroke()
      } else {
        ctx.strokeRect(hx + 0.5, hy + 0.5, hs - 1, hs - 1)
      }
    }

    // marching-ants selection outline (two alternating dashed passes);
    // while a scale handle is dragged the DRAFT rect is outlined instead
    if (selection && !playing) {
      const ants = scaleDraft ?? selection
      const sx = ants.x * zoom
      const sy = ants.y * zoom
      const sw = ants.w * zoom
      const sh = ants.h * zoom
      const dash = Math.max(3, Math.round(zoom / 2))
      ctx.save()
      ctx.lineWidth = 1
      ctx.setLineDash([dash, dash])
      ctx.lineDashOffset = -(antsTick % 2) * dash // crawl
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.95)'
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1)
      ctx.lineDashOffset = -(antsTick % 2) * dash + dash / 2
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1)
      ctx.restore()
    }
    // NOTE: activeFrameIndex must be a dep — selectFrame() only composites the
    // offscreen buffer; without this dep the visible canvas keeps showing the
    // previous frame until the next hover/tick change ("frame click delay").
    // NOTE: the onion values must be deps too — toggling the switch or changing
    // opacity/tints re-composites the offscreen buffer only; without these deps
    // the visible canvas keeps showing the pre-onion blit (stale ghosts).
  }, [project, W, H, zoom, panX, panY, showGrid, tileSnap, tileSize, mirrorX, mirrorY, rightTab, motionDraftParts, renderTick, hover, tool, brushSize, brushShape, customBrush, playing, activeFrameIndex, selection, scaleDraft, ellipseFilled, antsTick, onionSkin, onionOpacity, onionPrevTint, onionNextTint])

  // ------------------------------------------------------------ fit / zoom
  const fitView = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(Math.min((rect.width - 48) / W, (rect.height - 48) / H))))
    const st = useEditor.getState()
    useEditor.setState({ zoom: z, panX: (rect.width - W * z) / 2, panY: (rect.height - H * z) / 2 })
  }, [W, H])

  useEffect(() => {
    fitView()
    // re-fit when a different project is loaded/newed (loadProject resets view state)
  }, [W, H, projectId, filePath, loadEpoch])

  // refit when the stage container is resized (device rotation, breakpoint
  // flip desktop ↔ mobile, panel toggles) so the canvas stays centered
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let lastW = container.clientWidth
    let lastH = container.clientHeight
    let raf = 0
    const check = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const w = container.clientWidth
        const h = container.clientHeight
        if (Math.abs(w - lastW) > 2 || Math.abs(h - lastH) > 2) {
          lastW = w
          lastH = h
          fitView()
        }
      })
    }
    const ro = new ResizeObserver(check)
    ro.observe(container)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [fitView])

  // wheel zoom (anchored at cursor)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = container.getBoundingClientRect()
      const pending = wheelZoomRef.current
      wheelZoomRef.current = {
        factor: (pending?.factor ?? 1) * Math.exp(-e.deltaY * 0.0015),
        cx: e.clientX - rect.left,
        cy: e.clientY - rect.top,
      }
      if (wheelZoomRafRef.current !== null) return
      wheelZoomRafRef.current = requestAnimationFrame(() => {
        wheelZoomRafRef.current = null
        const input = wheelZoomRef.current
        wheelZoomRef.current = null
        if (!input) return
        const st = useEditor.getState()
        const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, st.zoom * input.factor))
        const wx = (input.cx - st.panX) / st.zoom
        const wy = (input.cy - st.panY) / st.zoom
        // Store zoom + pan together. This caps wheel redraws to the display
        // refresh rate while preserving the cursor anchor.
        useEditor.setState({ zoom: nz, panX: input.cx - wx * nz, panY: input.cy - wy * nz })
      })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      container.removeEventListener('wheel', onWheel)
      if (wheelZoomRafRef.current !== null) cancelAnimationFrame(wheelZoomRafRef.current)
      wheelZoomRafRef.current = null
      wheelZoomRef.current = null
    }
  }, [])

  // ------------------------------------------------------------- pointers
  // pinch-zoom: track two touch pointers on the container; spread → zoom
  const pinchRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchStartRef = useRef<{ dist: number; zoom: number } | null>(null)

  const onContainerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch') return
    pinchRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinchRef.current.size === 2) {
      const [a, b] = Array.from(pinchRef.current.values())
      pinchStartRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom }
      // cancel any in-progress paint when the second finger lands
      finishInteraction()
      interactionRef.current = null
    }
  }

  const onContainerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch' || !pinchRef.current.has(e.pointerId)) return
    pinchRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const start = pinchStartRef.current
    if (pinchRef.current.size !== 2 || !start) return
    const [a, b] = Array.from(pinchRef.current.values())
    const dist = Math.hypot(a.x - b.x, a.y - b.y)
    if (start.dist > 0) {
      useEditor.setState({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, start.zoom * (dist / start.dist))) })
    }
  }

  const onContainerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pinchRef.current.delete(e.pointerId) && pinchRef.current.size < 2) pinchStartRef.current = null
  }

  const toPixel = useCallback(
    (clientX: number, clientY: number) => {
      const container = containerRef.current
      if (!container) return { x: 0, y: 0 }
      const rect = container.getBoundingClientRect()
      const x = Math.floor((clientX - rect.left - panX) / zoom)
      const y = Math.floor((clientY - rect.top - panY) / zoom)
      // Task 10b tilemap mode: snap raw pixels to the tile grid so strokes,
      // fills and rects land on tile boundaries (top-left of the tile).
      const snap = useEditor.getState()
      if (snap.tileSnap && snap.tileStamp === false) {
        const t = snap.tileSize
        return { x: Math.floor(x / t) * t, y: Math.floor(y / t) * t }
      }
      return { x, y }
    },
    [panX, panY, zoom]
  )

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (playing) return
    const canvas = canvasRef.current
    if (!canvas) return
    const st = useEditor.getState()
    const px = toPixel(e.clientX, e.clientY)
    canvas.setPointerCapture(e.pointerId)

    // pan: middle button only — right button paints the secondary color (Aseprite)
    if (e.button === 1) {
      interactionRef.current = {
        mode: 'pan',
        start: px,
        last: px,
        changed: false,
        panStart: { cx: e.clientX, cy: e.clientY, panX: st.panX, panY: st.panY },
      }
      return
    }
    if (e.button !== 0 && e.button !== 2) return

    const { width: w, height: h } = st.project
    const color = hexToRgba(e.button === 2 ? st.secondary : st.primary)

    // Task 10b: tile stamp — a pencil click fills the ENTIRE tile under the
    // cursor with the primary (right-click = secondary / eraser clears it).
    // Works with pencil/eraser tools while tileStamp is on; snap keeps the
    // tile aligned so every click lands on exact tile boundaries.
    if (st.tileSnap && st.tileStamp && st.tileSize <= w && st.tileSize <= h && (st.tool === 'pencil' || st.tool === 'eraser')) {
      const t = st.tileSize
      const handle = st.beginStroke()
      if (!handle) return
      const c: [number, number, number, number] = st.tool === 'eraser' || e.button === 2 ? [0, 0, 0, 0] : color
      const tile = new Uint8ClampedArray(t * t * 4)
      for (let i = 0; i < t * t; i++) {
        tile[i * 4] = c[0]
        tile[i * 4 + 1] = c[1]
        tile[i * 4 + 2] = c[2]
        tile[i * 4 + 3] = c[3]
      }
      // stampCustomBuffer centers the brush on (cx, cy) — offset to the tile's
      // center so the whole tile fills exactly
      stampCustomBuffer(handle.buffer, w, h, px.x + Math.floor(t / 2), px.y + Math.floor(t / 2), { w: t, h: t, data: tile }, st.mirrorX, st.tool === 'eraser')
      if (st.mirrorY) {
        stampCustomBuffer(handle.buffer, w, h, px.x + Math.floor(t / 2), h - 1 - (px.y + Math.floor(t / 2)), { w: t, h: t, data: tile }, st.mirrorX, st.tool === 'eraser')
      }
      interactionRef.current = {
        mode: 'paint',
        tool: st.tool,
        start: px,
        last: px,
        handle,
        changed: true,
        btn: e.button,
      }
      st.bump()
      return
    }

    switch (st.tool) {
      case 'pencil':
      case 'eraser': {
        const handle = st.beginStroke()
        if (!handle) return
        const c: [number, number, number, number] = st.tool === 'eraser' ? [0, 0, 0, 0] : color
        if (st.customBrush) {
          stampCustomBuffer(handle.buffer, w, h, px.x, px.y, st.customBrush, st.mirrorX, st.tool === 'eraser')
          if (st.mirrorY) {
            stampCustomBuffer(handle.buffer, w, h, px.x, h - 1 - px.y, st.customBrush, st.mirrorX, st.tool === 'eraser')
          }
        } else {
          stampBrush(handle.buffer, w, h, px.x, px.y, st.brushSize, c, st.mirrorX, st.brushShape)
          if (st.mirrorY) {
            stampBrush(handle.buffer, w, h, px.x, h - 1 - px.y, st.brushSize, c, st.mirrorX, st.brushShape)
          }
        }
        interactionRef.current = {
          mode: 'paint',
          tool: st.tool,
          start: px,
          last: px,
          handle,
          changed: true,
          btn: e.button,
          pp: st.brushSize === 1 && !st.customBrush && !st.mirrorX && !st.mirrorY && !st.dither
            ? { p2: null, p1: px, patch: new Map() }
            : undefined,
        }
        st.bump()
        break
      }
      case 'fill': {
        const handle = st.beginStroke()
        if (!handle) return
        const sec = hexToRgba(st.secondary)
        let changed = st.dither
          ? floodFillDither(handle.buffer, w, h, px.x, px.y, color, sec, st.mirrorX)
          : floodFill(handle.buffer, w, h, px.x, px.y, color, st.mirrorX)
        if (st.mirrorY) {
          const my = h - 1 - px.y
          const changedY = st.dither
            ? floodFillDither(handle.buffer, w, h, px.x, my, color, sec, st.mirrorX)
            : floodFill(handle.buffer, w, h, px.x, my, color, st.mirrorX)
          changed = changed || changedY
        }
        st.endStroke('Fill', changed)
        break
      }
      case 'eyedropper': {
        const off = offRef.current
        if (off && px.x >= 0 && px.y >= 0 && px.x < w && px.y < h) {
          const octx = off.getContext('2d', { willReadFrequently: true })
          if (octx) {
            const d = octx.getImageData(px.x, px.y, 1, 1).data
            if (d[3] > 0) {
              const hex = `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`
              st.setPrimary(hex)
            }
          }
        }
        break
      }
      case 'line':
      case 'rect':
      case 'ellipse': {
        const handle = st.beginStroke()
        if (!handle) return
        interactionRef.current = {
          mode: 'shape',
          tool: st.tool,
          start: px,
          last: px,
          handle,
          snapshot: new Uint8ClampedArray(handle.buffer),
          changed: false,
        }
        break
      }
      case 'marquee': {
        const sel = st.selection
        // free-scale handles first — screen-space proximity around the 8
        // handle points wins over move/create so the dots feel sticky
        if (sel) {
          const container = containerRef.current
          if (container) {
            const rect = container.getBoundingClientRect()
            const fx = (e.clientX - rect.left - panX) / zoom
            const fy = (e.clientY - rect.top - panY) / zoom
            const radius = (e.pointerType === 'touch' ? 14 : 6) / zoom
            const hit = handlePoints(sel).find(
              (h) => Math.abs(h.x - fx) <= radius && Math.abs(h.y - fy) <= radius
            )
            if (hit) {
              interactionRef.current = {
                mode: 'sel-scale',
                tool: 'marquee',
                start: px,
                last: px,
                changed: false,
                selectionStart: sel,
                scaleHandle: hit.id,
              }
              scaleDraftRef.current = { ...sel }
              setScaleDraft({ ...sel })
              return
            }
          }
        }
        if (sel && pointInSelection(sel, px.x, px.y)) {
          // drag INSIDE an existing selection → move those pixels (stroke
          // flow: preview mutates only the handed-out working buffer)
          const handle = st.beginStroke()
          if (!handle) return
          interactionRef.current = {
            mode: 'sel-move',
            tool: 'marquee',
            start: px,
            last: px,
            handle,
            snapshot: new Uint8ClampedArray(handle.buffer),
            changed: false,
            selectionStart: sel,
          }
        } else {
          // drag OUTSIDE → draw a new selection rect (view state only)
          interactionRef.current = {
            mode: 'marquee-create',
            tool: 'marquee',
            start: px,
            last: px,
            changed: false,
          }
          st.setSelection(rectFromPoints(px.x, px.y, px.x, px.y))
        }
        break
      }
      case 'move': {
        const handle = st.beginStroke()
        if (!handle) return
        interactionRef.current = {
          mode: 'move',
          tool: 'move',
          start: px,
          last: px,
          handle,
          snapshot: new Uint8ClampedArray(handle.buffer),
          changed: false,
        }
        break
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const st = useEditor.getState()
    const px = toPixel(e.clientX, e.clientY)
    st.setHover({ x: px.x, y: px.y })
    const it = interactionRef.current
    if (!it || playing) return

    if (it.mode === 'pan' && it.panStart) {
      st.setPan(it.panStart.panX + (e.clientX - it.panStart.cx), it.panStart.panY + (e.clientY - it.panStart.cy))
      return
    }

    // marquee-create runs without a stroke handle (view state only)
    if (it.mode === 'marquee-create') {
      const rect = rectFromPoints(it.start.x, it.start.y, px.x, px.y)
      st.setSelection(rect)
      it.changed = true
      return
    }

    // free-scale: resize the draft square (content commits once on release)
    if (it.mode === 'sel-scale' && it.selectionStart && it.scaleHandle) {
      const s = it.selectionStart
      let x0 = s.x
      let y0 = s.y
      let x1 = s.x + s.w
      let y1 = s.y + s.h
      if (it.scaleHandle.includes('w')) x0 = px.x
      if (it.scaleHandle.includes('e')) x1 = px.x
      if (it.scaleHandle.startsWith('n')) y0 = px.y
      if (it.scaleHandle.startsWith('s')) y1 = px.y
      const draft = clampSelRect(
        {
          x: Math.min(x0, x1),
          y: Math.min(y0, y1),
          w: Math.max(1, Math.abs(x1 - x0)),
          h: Math.max(1, Math.abs(y1 - y0)),
        },
        st.project.width,
        st.project.height
      )
      const cur = scaleDraftRef.current
      if (
        !cur ||
        draft.x !== cur.x ||
        draft.y !== cur.y ||
        draft.w !== cur.w ||
        draft.h !== cur.h
      ) {
        scaleDraftRef.current = draft
        setScaleDraft(draft)
      }
      it.changed =
        draft.x !== s.x || draft.y !== s.y || draft.w !== s.w || draft.h !== s.h
      return
    }

    const handle = it.handle
    if (!handle) return
    const { width: w, height: h } = st.project

    if (it.mode === 'paint' && it.tool) {
      const c: [number, number, number, number] = it.tool === 'eraser'
        ? [0, 0, 0, 0]
        : hexToRgba(it.btn === 2 ? st.secondary : st.primary)
      // dither pencil/eraser: 1px + dither ON → checker stamps (own path —
      // the pixel-perfect tracker assumes every adjacent cell)
      if (st.dither && st.brushSize === 1 && !st.customBrush && !st.mirrorX && !st.mirrorY &&
        (it.tool === 'pencil' || it.tool === 'eraser')) {
        const pts: Array<{ x: number; y: number }> = []
        let x = it.last.x, y = it.last.y
        const dx = Math.abs(px.x - x), dy = Math.abs(px.y - y)
        const sx = it.last.x < px.x ? 1 : -1, sy = it.last.y < px.y ? 1 : -1
        let err = dx - dy
        for (let i = 0; i <= dx + dy + 1; i++) {
          if ((x + y) % 2 === 0) pts.push({ x, y })
          if (x === px.x && y === px.y) break
          const e2 = 2 * err
          if (e2 > -dy) { err -= dy; x += sx }
          if (e2 < dx) { err += dx; y += sy }
        }
        for (const p of pts) stampBrush(handle.buffer, w, h, p.x, p.y, 1, c, false, st.brushShape)
        it.last = px
        it.changed = true
        st.bump()
        return
      }
      // pixel-perfect freehand: 1px pencil/eraser, no custom brush, no mirror
      if (it.pp && !st.customBrush && !st.mirrorX && !st.mirrorY && st.brushSize === 1) {
        pixelPerfectStroke(it.pp, px, handle.buffer, w, h, c, st.brushShape)
        it.last = px
        it.changed = true
        st.bump()
        return
      }
      if (st.customBrush) {
        // interpolate stamps along the segment so fast strokes stay connected
        const steps = Math.max(1, Math.hypot(px.x - it.last.x, px.y - it.last.y))
        for (let s = 0; s <= steps; s++) {
          const sx = Math.round(it.last.x + ((px.x - it.last.x) * s) / steps)
          const sy = Math.round(it.last.y + ((px.y - it.last.y) * s) / steps)
          stampCustomBuffer(
            handle.buffer, w, h,
            sx, sy,
            st.customBrush, st.mirrorX, st.tool === 'eraser',
          )
          if (st.mirrorY) {
            stampCustomBuffer(
              handle.buffer, w, h,
              sx, h - 1 - sy,
              st.customBrush, st.mirrorX, st.tool === 'eraser',
            )
          }
        }
      } else {
        const lineC: [number, number, number, number] = it.tool === 'eraser' ? [0, 0, 0, 0] : c
        drawLinePixels(handle.buffer, w, h, it.last.x, it.last.y, px.x, px.y, st.brushSize, lineC, st.mirrorX, st.brushShape)
        if (st.mirrorY) {
          drawLinePixels(handle.buffer, w, h, it.last.x, h - 1 - it.last.y, px.x, h - 1 - px.y, st.brushSize, lineC, st.mirrorX, st.brushShape)
        }
      }
      it.last = px
      it.changed = true
      st.bump()
      return
    }

    if (it.mode === 'shape' && it.snapshot) {
      handle.buffer.set(it.snapshot)
      if (it.tool === 'line') {
        const c = hexToRgba(st.primary)
        drawLinePixels(handle.buffer, w, h, it.start.x, it.start.y, px.x, px.y, st.brushSize, c, st.mirrorX, st.brushShape)
        if (st.mirrorY) {
          drawLinePixels(handle.buffer, w, h, it.start.x, h - 1 - it.start.y, px.x, h - 1 - px.y, st.brushSize, c, st.mirrorX, st.brushShape)
        }
      } else if (it.tool === 'rect') {
        const filled = e.shiftKey ? !st.ellipseFilled : st.ellipseFilled
        const c = hexToRgba(filled ? st.secondary : st.primary)
        drawRectPixels(handle.buffer, w, h, it.start.x, it.start.y, px.x, px.y, st.brushSize, c, filled, st.mirrorX, st.brushShape)
        if (st.mirrorY) {
          drawRectPixels(handle.buffer, w, h, it.start.x, h - 1 - it.start.y, px.x, h - 1 - px.y, st.brushSize, c, filled, st.mirrorX, st.brushShape)
        }
      } else {
        // ellipse: outline uses the primary color; filled uses the secondary
        // (v3.1 §2.1 shape convention). Shift inverts the fill toggle.
        const filled = e.shiftKey ? !st.ellipseFilled : st.ellipseFilled
        const c = hexToRgba(filled ? st.secondary : st.primary)
        drawEllipsePixels(handle.buffer, w, h, it.start.x, it.start.y, px.x, px.y, st.brushSize, c, filled, st.mirrorX)
        if (st.mirrorY) {
          drawEllipsePixels(handle.buffer, w, h, it.start.x, h - 1 - it.start.y, px.x, h - 1 - px.y, st.brushSize, c, filled, st.mirrorX)
        }
      }
      it.last = px
      it.changed = true
      st.bump()
      return
    }

    if (it.mode === 'sel-move' && it.snapshot && it.selectionStart) {
      const dx = px.x - it.start.x
      const dy = px.y - it.start.y
      if (dx === (it.moveDx ?? 0) && dy === (it.moveDy ?? 0)) {
        return
      }
      composeSelectionMove(
        handle.buffer,
        it.snapshot,
        w,
        h,
        it.selectionStart,
        dx,
        dy
      )
      it.moveDx = dx
      it.moveDy = dy
      it.changed = dx !== 0 || dy !== 0
      it.last = px
      st.bump()
      return
    }

    if (it.mode === 'move' && it.snapshot) {
      const dx = px.x - it.start.x
      const dy = px.y - it.start.y
      const moved = moveBuffer(it.snapshot, w, h, dx, dy)
      handle.buffer.set(moved)
      it.changed = dx !== 0 || dy !== 0
      st.bump()
    }
  }

  const finishInteraction = () => {
    const st = useEditor.getState()
    const it = interactionRef.current
    interactionRef.current = null
    if (!it || it.mode === 'pan') return
    if (it.mode === 'paint' && it.tool) {
      st.endStroke(it.tool === 'eraser' ? 'Eraser' : 'Pencil', it.changed)
    } else if (it.mode === 'shape' && it.tool) {
      st.endStroke(it.tool === 'line' ? 'Line' : it.tool === 'ellipse' ? 'Ellipse' : 'Rect', it.changed)
    } else if (it.mode === 'move') {
      st.endStroke('Move layer', it.changed)
    } else if (it.mode === 'marquee-create') {
      // a click without a drag collapses to a deselect (predictable UX)
      const st2 = useEditor.getState()
      if (st2.selection && st2.selection.w <= 1 && st2.selection.h <= 1 && !it.changed) {
        st2.setSelection(null)
      }
    } else if (it.mode === 'sel-scale' && it.selectionStart) {
      // commit: NN-resample the content into the dragged footprint (one
      // undoable scaleTo op; the store clamps + no-ops identical footprints)
      const draft = scaleDraftRef.current
      scaleDraftRef.current = null
      setScaleDraft(null)
      if (draft) {
        const changed =
          draft.x !== it.selectionStart.x ||
          draft.y !== it.selectionStart.y ||
          draft.w !== it.selectionStart.w ||
          draft.h !== it.selectionStart.h
        if (changed) useEditor.getState().selectionScaleTo(draft)
      }
    } else if (it.mode === 'sel-move' && it.selectionStart) {
      // commit the final offset into history (the working buffer already
      // holds the preview; endStroke diffs it against the stroke start)
      useEditor
        .getState()
        .endStroke('Move selection', it.changed)
      if (it.changed) {
        const project = useEditor.getState().project
        useEditor.setState({
          selection: shiftRectClamped(
            it.selectionStart,
            it.moveDx ?? 0,
            it.moveDy ?? 0,
            project.width,
            project.height
          ),
        })
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    finishInteraction()
  }

  const scaleRect = tool === 'marquee' && !playing ? scaleDraft ?? selection : null
  const handleHover =
    scaleRect && hover
      ? handlePoints(scaleRect).find(
          (h) =>
            Math.abs(h.x - (hover.x + 0.5)) <= 6 / zoom &&
            Math.abs(h.y - (hover.y + 0.5)) <= 6 / zoom
        )
      : undefined

  const cursor = playing
    ? 'default'
    : handleHover
      ? HANDLE_CURSOR[handleHover.id]
      : tool === 'move'
        ? 'move'
        : tool === 'marquee' && selection && hover && pointInSelection(selection, hover.x, hover.y)
          ? 'move'
          : 'crosshair'

  return (
    <div
      className={`@container relative min-w-0 flex-1 overflow-hidden bg-zinc-900/60 ${
        dragOver ? 'ring-2 ring-inset ring-frost-400/60' : ''
      }`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const f = e.dataTransfer.files?.[0]
        if (!f || !f.type.startsWith('image/')) return
        void f.arrayBuffer().then(async (buf) => {
          try {
            const bmp = await createImageBitmap(new Blob([buf], { type: f.type }))
            const project = useEditor.getState().project
            // contain-fit the image inside the canvas, centered
            const s = Math.min(project.width / bmp.width, project.height / bmp.height)
            const dw = Math.max(1, Math.round(bmp.width * s))
            const dh = Math.max(1, Math.round(bmp.height * s))
            const off = document.createElement('canvas')
            off.width = project.width
            off.height = project.height
            const octx = off.getContext('2d')
            if (!octx) return
            octx.imageSmoothingEnabled = false
            octx.drawImage(bmp, Math.floor((project.width - dw) / 2), Math.floor((project.height - dh) / 2), dw, dh)
            const rgba = octx.getImageData(0, 0, project.width, project.height).data
            const ref = useEditor.getState().importCandidateAsLayer(
              new Uint8ClampedArray(rgba),
              `dropped: ${f.name.slice(0, 24)}`,
            )
            if (ref) toast({ title: 'Image imported as layer', description: f.name.slice(0, 40) })
          } catch (err) {
            toast({ title: 'Drop import failed', description: friendlyError(err), variant: 'destructive' })
          }
        })
      }}
    >
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden"
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={onContainerPointerDown}
        onPointerMove={onContainerPointerMove}
        onPointerUp={onContainerPointerUp}
        onPointerCancel={onContainerPointerUp}
      >
        <div
          ref={boardRef}
          className="pixelforge-canvas-checker absolute left-0 top-0 rounded-md shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_12px_40px_rgba(0,0,0,0.45)]"
        >
          {/* signature: soft focus halo hugging the board (system blue) */}
          <div className="pf-ticks pointer-events-none absolute inset-0 rounded-md" aria-hidden />
          <canvas
            ref={canvasRef}
            className="absolute left-0 top-0 touch-none select-none"
            style={{ cursor, imageRendering: 'pixelated', filter: grayscale ? 'grayscale(1)' : undefined }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={(e) => {
              useEditor.getState().setHover(null)
              onPointerUp(e)
            }}
          />

          {/* free-scale handles — visual only (pointer-events-none; the canvas
              hit-tests them) — they track the live draft while dragging */}
          {scaleRect && (
            <div className="pointer-events-none absolute inset-0">
              {handlePoints(scaleRect).map((h) => (
                <div
                  key={h.id}
                  className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-zinc-900 bg-teal-300 shadow"
                  style={{ left: h.x * zoom, top: h.y * zoom }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* floating animation preview — lives on the edit area itself */}
      <MemoPreviewOverlay />

      {/* floating palette — draggable + hideable (same pattern as preview) */}
      <MemoPalettePanel />

      {/* floating reference image — draw "under" a semi-transparent picture */}
      <MemoReferenceOverlay />

      {/* floating view controls — draggable + hideable (persisted) */}
      <MemoViewToolbar onZoomBy={zoomBy} onFit={fitView} />

      {/* contextual tool options (ellipse fill toggle, tilemap toggle, selection actions) */}
      <MemoToolOptionsBar />

      {/* empty-frame hint — makes it explicit that pixels were NOT lost when
          the playhead sits on a blank frame (e.g. right after Add frame) */}
      {frameEmpty && !playing && (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-sm border border-zinc-700 bg-zinc-950/95 px-3 py-1.5 text-center shadow-lg"
        >
          <p className="text-[11px] text-zinc-100">
            Frame {Math.min(activeFrameIndex + 1, getActiveClip(useEditor.getState()).frames.length)} is empty
          </p>
          <p className="mt-0.5 text-[10px] text-zinc-400">
            draw here — your other frames are safe on the timeline below
          </p>
        </div>
      )}
    </div>
  )
}
