'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { PixelGrid, Rig } from '@/lib/pixelforge/types'
import { getPixel } from '@/lib/pixelforge/sprite'
import { useEditor } from '@/lib/pixelforge/store'

const PART_COLORS: Record<string, string> = {
  head: '#f59e0b',
  torso: '#10b981',
  armL: '#14b8a6',
  armR: '#a855f7',
  legL: '#f97316',
  legR: '#ec4899',
  custom: '#64748b',
}

interface Props {
  grid: PixelGrid
  rig: Rig
}

export function PixelCanvas({ grid, rig }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)
  const tool = useEditor((s) => s.tool)
  const zoom = useEditor((s) => s.zoom)
  const showRects = useEditor((s) => s.showRects)
  const activePart = useEditor((s) => s.activePart)
  const paintPixel = useEditor((s) => s.paintPixel)
  const floodFill = useEditor((s) => s.floodFill)
  const beginShape = useEditor((s) => s.beginShape)
  const previewShape = useEditor((s) => s.previewShape)
  const commitShape = useEditor((s) => s.commitShape)
  const beginStroke = useEditor((s) => s.beginStroke)
  const endStroke = useEditor((s) => s.endStroke)
  const setColor = useEditor((s) => s.setColor)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const s = zoom
    canvas.width = grid.width * s
    canvas.height = grid.height * s
    // dark checkerboard (original PixelForge studio look)
    const cs = Math.max(4, s)
    for (let y = 0; y < canvas.height; y += cs) {
      for (let x = 0; x < canvas.width; x += cs) {
        ctx.fillStyle = ((x / cs + y / cs) % 2) === 0 ? '#31343e' : '#262932'
        ctx.fillRect(x, y, cs, cs)
      }
    }
    // pixels
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const c = getPixel(grid, x, y)
        if (c.a === 0) continue
        ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${c.a / 255})`
        ctx.fillRect(x * s, y * s, s, s)
      }
    }
    // grid lines at high zoom
    if (s >= 10) {
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      for (let x = 0; x <= grid.width; x++) {
        ctx.beginPath(); ctx.moveTo(x * s + 0.5, 0); ctx.lineTo(x * s + 0.5, canvas.height); ctx.stroke()
      }
      for (let y = 0; y <= grid.height; y++) {
        ctx.beginPath(); ctx.moveTo(0, y * s + 0.5); ctx.lineTo(canvas.width, y * s + 0.5); ctx.stroke()
      }
    }
    // part rects
    if (showRects) {
      for (const p of rig.parts) {
        const active = p.id === activePart
        ctx.strokeStyle = PART_COLORS[p.role] ?? PART_COLORS.custom
        ctx.lineWidth = active ? 3 : 2
        ctx.setLineDash(active ? [] : [4, 3])
        ctx.strokeRect(p.rect.x * s + 1, p.rect.y * s + 1, p.rect.w * s - 2, p.rect.h * s - 2)
        ctx.setLineDash([])
        if (active) {
          ctx.fillStyle = 'rgba(255,255,255,0.85)'
          ctx.font = '11px ui-monospace, monospace'
          ctx.fillText(p.label, p.rect.x * s + 3, p.rect.y * s + 12)
        }
      }
    }
  }, [grid, rig, zoom, showRects, activePart])

  useEffect(() => { draw() }, [draw])

  const cellFromEvent = (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * grid.width)
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * grid.height)
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null
    return { x, y }
  }

  const onDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cell = cellFromEvent(e)
    if (!cell) return
    if (tool === 'picker') {
      const c = getPixel(grid, cell.x, cell.y)
      if (c.a > 0) {
        const hex = `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
        setColor(hex)
      }
      return
    }
    if (tool === 'fill') {
      floodFill(cell.x, cell.y)
      useEditor.getState().save()
      return
    }
    if (tool === 'line' || tool === 'rect') {
      dragging.current = true
      beginShape(cell.x, cell.y)
      return
    }
    dragging.current = true
    beginStroke()
    paintPixel(cell.x, cell.y)
  }

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return
    const cell = cellFromEvent(e)
    if (!cell) return
    if (tool === 'line' || tool === 'rect') {
      previewShape(cell.x, cell.y)
      return
    }
    paintPixel(cell.x, cell.y)
  }

  const onUp = () => {
    if (dragging.current) {
      dragging.current = false
      if (tool === 'line' || tool === 'rect') {
        commitShape()
        useEditor.getState().save()
      } else {
        endStroke()
      }
    }
  }

  const cursor =
    tool === 'picker' ? 'crosshair'
    : tool === 'fill' ? 'cell'
    : 'cell'

  return (
    <div className="overflow-auto rounded-lg border border-[#2e3340] bg-[#1c1f26] p-2 max-h-[60vh]" data-testid="canvas-wrap">
      <canvas
        ref={canvasRef}
        data-testid="pixel-canvas"
        className="touch-none select-none"
        style={{ imageRendering: 'pixelated', cursor }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
      />
    </div>
  )
}

export { PART_COLORS }
