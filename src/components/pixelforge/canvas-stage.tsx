// PixelForge AI — pixel canvas stage
// Deterministic Canvas 2D rendering: composite → scaled draw with smoothing
// off, checkerboard backdrop, pixel grid, onion skin, hover cursor, zoom/pan.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ONION_MAX } from '@pixelforge/core'
import { useEditor, getActiveClip, MIN_ZOOM, MAX_ZOOM } from '@/lib/pixelforge/store'
import { hexToRgba } from '@/lib/pixelforge/color'
import {
  stampBrush,
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
  const spaceRef = useRef(false)
  const [spaceHeld, setSpaceHeld] = useState(false)

  const project = useEditor((s) => s.project)
  const activeClipId = useEditor((s) => s.activeClipId)
  const activeFrameIndex = useEditor((s) => s.activeFrameIndex)
  const zoom = useEditor((s) => s.zoom)
  const panX = useEditor((s) => s.panX)
  const panY = useEditor((s) => s.panY)
  const showGrid = useEditor((s) => s.showGrid)
  const onionSkin = useEditor((s) => s.onionSkin)
  const onionOpacity = useAppSettings((s) => s.onionOpacity)
  const onionPrevTint = useAppSettings((s) => s.onionPrevTint)
  const onionNextTint = useAppSettings((s) => s.onionNextTint)
  const tool = useEditor((s) => s.tool)
  const primary = useEditor((s) => s.primary)
  const brushSize = useEditor((s) => s.brushSize)
  const mirrorX = useEditor((s) => s.mirrorX)
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
    st.setZoom(nz)
    st.setPan(cx - wx * nz, cy - wy * nz)
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
    if (showGrid && zoom >= 5) {
      ctx.lineWidth = 1
      for (let x = 0; x <= W; x++) {
        const strong = x % 8 === 0
        ctx.strokeStyle = strong ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)'
        const px = Math.round(x * zoom * dpr) / dpr + 0.5 / dpr
        ctx.beginPath()
        ctx.moveTo(px, 0)
        ctx.lineTo(px, ch)
        ctx.stroke()
      }
      for (let y = 0; y <= H; y++) {
        const strong = y % 8 === 0
        ctx.strokeStyle = strong ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)'
        const py = Math.round(y * zoom * dpr) / dpr + 0.5 / dpr
        ctx.beginPath()
        ctx.moveTo(0, py)
        ctx.lineTo(cw, py)
        ctx.stroke()
      }
    }

    // hover cursor (paint tools)
    if (hover && !playing && tool !== 'eyedropper' && tool !== 'move' && tool !== 'marquee') {
      const size = tool === 'fill' ? 1 : brushSize
      const off2 = Math.floor((Math.max(1, size) - 1) / 2)
      const hx = (hover.x - off2) * zoom
      const hy = (hover.y - off2) * zoom
      const hs = Math.max(1, size) * zoom
      ctx.strokeStyle = 'rgba(45, 212, 191, 0.9)'
      ctx.lineWidth = 1
      ctx.strokeRect(hx + 0.5, hy + 0.5, hs - 1, hs - 1)
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
  }, [project, W, H, zoom, panX, panY, showGrid, renderTick, hover, tool, brushSize, playing, activeFrameIndex, selection, scaleDraft, ellipseFilled, antsTick, onionSkin, onionOpacity, onionPrevTint, onionNextTint])

  // ------------------------------------------------------------ fit / zoom
  const fitView = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(Math.min((rect.width - 48) / W, (rect.height - 48) / H))))
    const st = useEditor.getState()
    st.setZoom(z)
    st.setPan((rect.width - W * z) / 2, (rect.height - H * z) / 2)
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
      const st = useEditor.getState()
      const rect = container.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const factor = Math.exp(-e.deltaY * 0.0015)
      const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, st.zoom * factor))
      const wx = (cx - st.panX) / st.zoom
      const wy = (cy - st.panY) / st.zoom
      st.setZoom(nz)
      st.setPan(cx - wx * nz, cy - wy * nz)
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [])

  // space-to-pan tracking
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        const t = e.target as HTMLElement
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
        spaceRef.current = true
        setSpaceHeld(true)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = false
        setSpaceHeld(false)
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // ------------------------------------------------------------- pointers
  const toPixel = useCallback(
    (clientX: number, clientY: number) => {
      const container = containerRef.current
      if (!container) return { x: 0, y: 0 }
      const rect = container.getBoundingClientRect()
      const x = Math.floor((clientX - rect.left - panX) / zoom)
      const y = Math.floor((clientY - rect.top - panY) / zoom)
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

    // pan: middle button, right button, or space held
    if (e.button === 1 || e.button === 2 || spaceRef.current) {
      interactionRef.current = {
        mode: 'pan',
        start: px,
        last: px,
        changed: false,
        panStart: { cx: e.clientX, cy: e.clientY, panX: st.panX, panY: st.panY },
      }
      return
    }
    if (e.button !== 0) return

    const { width: w, height: h } = st.project
    const color = hexToRgba(st.primary)

    switch (st.tool) {
      case 'pencil':
      case 'eraser': {
        const handle = st.beginStroke()
        if (!handle) return
        const c: [number, number, number, number] = st.tool === 'eraser' ? [0, 0, 0, 0] : color
        stampBrush(handle.buffer, w, h, px.x, px.y, st.brushSize, c, st.mirrorX)
        interactionRef.current = {
          mode: 'paint',
          tool: st.tool,
          start: px,
          last: px,
          handle,
          changed: true,
        }
        st.bump()
        break
      }
      case 'fill': {
        const handle = st.beginStroke()
        if (!handle) return
        const changed = floodFill(handle.buffer, w, h, px.x, px.y, color, st.mirrorX)
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
      const c: [number, number, number, number] = it.tool === 'eraser' ? [0, 0, 0, 0] : hexToRgba(st.primary)
      drawLinePixels(handle.buffer, w, h, it.last.x, it.last.y, px.x, px.y, st.brushSize, c, st.mirrorX)
      it.last = px
      it.changed = true
      st.bump()
      return
    }

    if (it.mode === 'shape' && it.snapshot) {
      handle.buffer.set(it.snapshot)
      if (it.tool === 'line') {
        const c = hexToRgba(st.primary)
        drawLinePixels(handle.buffer, w, h, it.start.x, it.start.y, px.x, px.y, st.brushSize, c, st.mirrorX)
      } else if (it.tool === 'rect') {
        const c = hexToRgba(st.primary)
        drawRectPixels(handle.buffer, w, h, it.start.x, it.start.y, px.x, px.y, st.brushSize, c, e.shiftKey, st.mirrorX)
      } else {
        // ellipse: outline uses the primary color; filled uses the secondary
        // (v3.1 §2.1 shape convention). Shift inverts the fill toggle.
        const filled = e.shiftKey ? !st.ellipseFilled : st.ellipseFilled
        const c = hexToRgba(filled ? st.secondary : st.primary)
        drawEllipsePixels(handle.buffer, w, h, it.start.x, it.start.y, px.x, px.y, st.brushSize, c, filled, st.mirrorX)
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
    scaleRect && hover && !spaceHeld
      ? handlePoints(scaleRect).find(
          (h) =>
            Math.abs(h.x - (hover.x + 0.5)) <= 6 / zoom &&
            Math.abs(h.y - (hover.y + 0.5)) <= 6 / zoom
        )
      : undefined

  const cursor = playing
    ? 'default'
    : spaceHeld
      ? 'grab'
      : handleHover
        ? HANDLE_CURSOR[handleHover.id]
        : tool === 'move'
          ? 'move'
          : tool === 'marquee' && selection && hover && pointInSelection(selection, hover.x, hover.y)
            ? 'move'
            : 'crosshair'

  return (
    <div className="@container relative min-w-0 flex-1 overflow-hidden bg-zinc-900/60">
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden"
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          ref={boardRef}
          className="pixelforge-checker absolute left-0 top-0 shadow-[0_0_0_1px_rgba(255,255,255,0.18),0_8px_32px_rgba(0,0,0,0.5)]"
        >
          <canvas
            ref={canvasRef}
            className="absolute left-0 top-0 touch-none select-none"
            style={{ cursor, imageRendering: 'pixelated' }}
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
      <PreviewOverlay />

      {/* floating palette — draggable + hideable (same pattern as preview) */}
      <PalettePanel />

      {/* floating view controls — draggable + hideable (persisted) */}
      <ViewToolbar onZoomBy={zoomBy} onFit={fitView} />

      {/* contextual tool options (ellipse fill toggle, selection actions) */}
      <ToolOptionsBar />

      {/* empty-frame hint — makes it explicit that pixels were NOT lost when
          the playhead sits on a blank frame (e.g. right after Add frame) */}
      {frameEmpty && !playing && (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-zinc-700/80 bg-zinc-950/90 px-3 py-1.5 text-center shadow-lg backdrop-blur"
        >
          <p className="font-mono text-[11px] text-zinc-200">
            Frame {Math.min(activeFrameIndex + 1, getActiveClip(useEditor.getState()).frames.length)} is empty
          </p>
          <p className="font-mono text-[10px] text-zinc-400">
            draw here — your other frames are safe on the timeline below
          </p>
        </div>
      )}
    </div>
  )
}
