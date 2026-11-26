// PixelForge AI — Phase 3+: Tileset Stamp Picker + Live Animated Level Mockup
//
// Features:
//   • Tile sizes: 8, 16, 24, 32, 48, 64px
//   • Live auto-refreshing active Tile Brush as you edit the tileset
//   • Rotate 90° CW (Q), Flip H, Flip V, Reset + Main Canvas Ghost Stamp
//   • 2-Layer Level Mockup Room (Ground + alpha-composited Overlay/Props)
//   • Room Undo / Redo + live Hover Ghost Preview + Alt+click Eyedropper
//   • Animated multi-frame tiles playback + Expandable Theater Modal
//   • Full-room Bake to Clip (with optional auto-resize up to 256×256) + Export PNG

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  TILE_SIZES,
  composeFrameRgba,
  composeLevelMockup,
  encodePng,
  extractTilesetGrid,
  transformTileBuffer,
  type LevelMockupCell,
  type TileRotation,
} from '@pixelforge/core'
import { useEditor, type TileBrush } from '@/lib/pixelforge/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from '@/hooks/use-toast'
import {
  Grid3X3,
  RotateCw,
  FlipHorizontal,
  FlipVertical,
  RotateCcw,
  Stamp,
  Play,
  Pause,
  Trash2,
  Download,
  Layers,
  Eye,
  EyeOff,
  SquareDashed,
  Undo2,
  Redo2,
  Maximize2,
} from 'lucide-react'

const ROOM_PRESETS = [
  { label: '6×4', cols: 6, rows: 4 },
  { label: '8×6', cols: 8, rows: 6 },
  { label: '10×8', cols: 10, rows: 8 },
  { label: '12×8', cols: 12, rows: 8 },
] as const

type RoomLayerId = 'ground' | 'overlay'

interface RoomSnapshot {
  ground: Array<LevelMockupCell | null>
  overlay: Array<LevelMockupCell | null>
}

const ROOM_UNDO_CAP = 40

function cloneSnapshot(s: RoomSnapshot): RoomSnapshot {
  return {
    ground: s.ground.map((c) => (c ? { ...c } : null)),
    overlay: s.overlay.map((c) => (c ? { ...c } : null)),
  }
}

function buffersDiffer(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return true
  }
  return false
}

function TileThumb({
  buffer,
  size,
  displayPx = 36,
}: {
  buffer: Uint8ClampedArray
  size: number
  displayPx?: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, size, size)
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), size, size), 0, 0)
  }, [buffer, size])
  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      style={{ width: displayPx, height: displayPx, imageRendering: 'pixelated' }}
      className="pixelforge-checker rounded-sm"
      aria-hidden
    />
  )
}

function InteractiveRoomCanvas({
  mockup,
  cols,
  rows,
  tileSize,
  tileBrush,
  showGrid,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  className,
}: {
  mockup: { width: number; height: number; buffer: Uint8ClampedArray }
  cols: number
  rows: number
  tileSize: number
  tileBrush: TileBrush | null
  showGrid: boolean
  onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>, cell: { col: number; row: number }) => void
  onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>, cell: { col: number; row: number }) => void
  onPointerUp: () => void
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hoverCell, setHoverCell] = useState<{ col: number; row: number } | null>(null)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    cv.width = mockup.width
    cv.height = mockup.height
    ctx.clearRect(0, 0, mockup.width, mockup.height)
    ctx.putImageData(new ImageData(new Uint8ClampedArray(mockup.buffer), mockup.width, mockup.height), 0, 0)

    // Crisp translucent hover ghost preview of the active rotated/flipped tile!
    if (hoverCell && tileBrush && tileBrush.tileSize === tileSize) {
      const ghost = document.createElement('canvas')
      ghost.width = tileSize
      ghost.height = tileSize
      const gctx = ghost.getContext('2d')
      if (gctx) {
        gctx.putImageData(new ImageData(new Uint8ClampedArray(tileBrush.data), tileSize, tileSize), 0, 0)
        ctx.save()
        ctx.globalAlpha = 0.72
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(ghost, hoverCell.col * tileSize, hoverCell.row * tileSize)
        ctx.restore()
      }
    }
  }, [mockup, hoverCell, tileBrush, tileSize])

  const cellAt = (e: React.PointerEvent<HTMLCanvasElement>): { col: number; row: number } | null => {
    const cv = canvasRef.current
    if (!cv) return null
    const rect = cv.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const col = Math.floor(((e.clientX - rect.left) / rect.width) * cols)
    const row = Math.floor(((e.clientY - rect.top) / rect.height) * rows)
    if (col < 0 || row < 0 || col >= cols || row >= rows) return null
    return { col, row }
  }

  return (
    <div className={`relative overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 ${className ?? ''}`}>
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => {
          e.preventDefault()
          const c = cellAt(e)
          if (!c) return
          setHoverCell(c)
          e.currentTarget.setPointerCapture(e.pointerId)
          onPointerDown(e, c)
        }}
        onPointerMove={(e) => {
          const c = cellAt(e)
          setHoverCell(c)
          if (c) onPointerMove(e, c)
        }}
        onPointerLeave={() => setHoverCell(null)}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        className="pixelforge-checker block w-full cursor-crosshair touch-none"
        style={{
          aspectRatio: `${cols} / ${rows}`,
          imageRendering: 'pixelated',
        }}
      />
      {showGrid && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.08) 1px, transparent 1px)',
            backgroundSize: `${100 / cols}% ${100 / rows}%`,
          }}
        />
      )}
      {hoverCell && (
        <div
          aria-hidden
          className="pointer-events-none absolute border border-teal-400/90 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          style={{
            left: `${(hoverCell.col / cols) * 100}%`,
            top: `${(hoverCell.row / rows) * 100}%`,
            width: `${100 / cols}%`,
            height: `${100 / rows}%`,
          }}
        />
      )}
    </div>
  )
}

export function TilesPanel() {
  const project = useEditor((s) => s.project)
  const activeClipId = useEditor((s) => s.activeClipId)
  const activeFrameIndex = useEditor((s) => s.activeFrameIndex)
  const renderTick = useEditor((s) => s.renderTick)
  const tileSize = useEditor((s) => s.tileSize)
  const setTileSize = useEditor((s) => s.setTileSize)
  const tileSnap = useEditor((s) => s.tileSnap)
  const tileStamp = useEditor((s) => s.tileStamp)
  const setTileSnap = useEditor((s) => s.setTileSnap)
  const setTileStamp = useEditor((s) => s.setTileStamp)
  const setTool = useEditor((s) => s.setTool)
  const tileBrush = useEditor((s) => s.tileBrush)
  const setTileBrush = useEditor((s) => s.setTileBrush)
  const rotateTileBrushCW = useEditor((s) => s.rotateTileBrushCW)
  const flipTileBrushH = useEditor((s) => s.flipTileBrushH)
  const flipTileBrushV = useEditor((s) => s.flipTileBrushV)
  const resetTileBrushTransform = useEditor((s) => s.resetTileBrushTransform)
  const bakeMockupToNewClip = useEditor((s) => s.bakeMockupToNewClip)
  const { toast } = useToast()

  const [sourceClipId, setSourceClipId] = useState<string>('')
  const [hideEmpty, setHideEmpty] = useState(false)
  const [roomPresetIdx, setRoomPresetIdx] = useState(1) // default 8×6
  const roomDims = ROOM_PRESETS[roomPresetIdx] ?? ROOM_PRESETS[1]

  // 2-Layer Room State (Ground + Overlay/Props) with full Undo/Redo stacks
  const [room, setRoom] = useState<RoomSnapshot>(() => ({
    ground: new Array<LevelMockupCell | null>(8 * 6).fill(null),
    overlay: new Array<LevelMockupCell | null>(8 * 6).fill(null),
  }))
  const [roomUndo, setRoomUndo] = useState<RoomSnapshot[]>([])
  const [roomRedo, setRoomRedo] = useState<RoomSnapshot[]>([])
  const [activeRoomLayer, setActiveRoomLayer] = useState<RoomLayerId>('ground')
  const [showOverlay, setShowOverlay] = useState(true)
  const [theaterOpen, setTheaterOpen] = useState(false)

  const [animPlaying, setAnimPlaying] = useState(true)
  const [animFrame, setAnimFrame] = useState(0)
  const [showRoomGrid, setShowRoomGrid] = useState(true)
  const paintingRoomRef = useRef<'stamp' | 'erase' | null>(null)
  const strokeSavedRef = useRef(false)

  const sourceClip = useMemo(() => {
    const found = project.clips.find((c) => c.id === sourceClipId)
    return found ?? project.clips.find((c) => c.id === activeClipId) ?? project.clips[0]!
  }, [project.clips, sourceClipId, activeClipId])

  // Composite every frame of the source tileset clip so animated tiles play live
  const tilesetFrames = useMemo(() => {
    void renderTick
    return sourceClip.frames.map((frame) => composeFrameRgba(project, sourceClip, frame))
  }, [project, sourceClip, renderTick])

  const previewFrameIdx =
    sourceClip.id === activeClipId
      ? Math.min(activeFrameIndex, Math.max(0, tilesetFrames.length - 1))
      : 0

  const sliced = useMemo(() => {
    const buf = tilesetFrames[previewFrameIdx] ?? tilesetFrames[0]
    if (!buf) {
      return { tileSize, cols: 0, rows: 0, tiles: [], nonEmptyCount: 0 }
    }
    return extractTilesetGrid(buf, project.width, project.height, tileSize)
  }, [tilesetFrames, previewFrameIdx, project.width, project.height, tileSize])

  // Live auto-sync: when you paint pixels onto the tileset on the main canvas,
  // refresh the active TileBrush automatically so stamps never go stale!
  useEffect(() => {
    if (!tileBrush) return
    if (tileBrush.sourceClipId !== sourceClip.id || tileBrush.tileSize !== tileSize) return
    const latest = sliced.tiles[tileBrush.tileIndex]
    if (!latest) return
    if (!buffersDiffer(tileBrush.rawData, latest.buffer)) return
    const rawData = new Uint8ClampedArray(latest.buffer)
    const data = transformTileBuffer(rawData, tileSize, {
      rotation: tileBrush.rotation,
      flipH: tileBrush.flipH,
      flipV: tileBrush.flipV,
    })
    setTileBrush({ ...tileBrush, rawData, data })
  }, [sliced, tileBrush, sourceClip.id, tileSize, setTileBrush])

  // Keep animated tile mockup ticking when source clip has > 1 frame
  useEffect(() => {
    if (!animPlaying || tilesetFrames.length <= 1) return
    const ms = Math.max(50, Math.round(1000 / Math.max(1, sourceClip.fps || 8)))
    const id = window.setInterval(() => {
      setAnimFrame((f) => (f + 1) % tilesetFrames.length)
    }, ms)
    return () => window.clearInterval(id)
  }, [animPlaying, tilesetFrames.length, sourceClip.fps])

  const pushRoomUndo = useCallback((snapshot: RoomSnapshot) => {
    setRoomUndo((prev) => [...prev.slice(-(ROOM_UNDO_CAP - 1)), cloneSnapshot(snapshot)])
    setRoomRedo([])
  }, [])

  const handleRoomUndo = useCallback(() => {
    setRoomUndo((prev) => {
      if (prev.length === 0) return prev
      const previous = prev[prev.length - 1]!
      setRoomRedo((r) => [...r.slice(-(ROOM_UNDO_CAP - 1)), cloneSnapshot(room)])
      setRoom(cloneSnapshot(previous))
      return prev.slice(0, -1)
    })
  }, [room])

  const handleRoomRedo = useCallback(() => {
    setRoomRedo((prev) => {
      if (prev.length === 0) return prev
      const next = prev[prev.length - 1]!
      setRoomUndo((u) => [...u.slice(-(ROOM_UNDO_CAP - 1)), cloneSnapshot(room)])
      setRoom(cloneSnapshot(next))
      return prev.slice(0, -1)
    })
  }, [room])

  // Resize room cell arrays cleanly when switching room grid preset
  const selectRoomPreset = useCallback((idx: number) => {
    const next = ROOM_PRESETS[idx] ?? ROOM_PRESETS[1]
    const old = ROOM_PRESETS[roomPresetIdx] ?? ROOM_PRESETS[1]
    setRoomPresetIdx(idx)
    setRoomUndo([])
    setRoomRedo([])
    setRoom((prev) => {
      const resizeLayer = (arr: Array<LevelMockupCell | null>) => {
        const out = new Array<LevelMockupCell | null>(next.cols * next.rows).fill(null)
        const minCols = Math.min(old.cols, next.cols)
        const minRows = Math.min(old.rows, next.rows)
        for (let r = 0; r < minRows; r++) {
          for (let c = 0; c < minCols; c++) {
            out[r * next.cols + c] = arr[r * old.cols + c] ?? null
          }
        }
        return out
      }
      return { ground: resizeLayer(prev.ground), overlay: resizeLayer(prev.overlay) }
    })
  }, [roomPresetIdx])

  const pickTile = useCallback(
    (tileIndex: number, opts?: { rotation?: TileRotation; flipH?: boolean; flipV?: boolean }) => {
      const tile = sliced.tiles[tileIndex]
      if (!tile) return
      const rotation: TileRotation = opts?.rotation ?? (tileBrush?.rotation ?? 0)
      const flipH = opts?.flipH ?? (tileBrush?.flipH ?? false)
      const flipV = opts?.flipV ?? (tileBrush?.flipV ?? false)
      const rawData = new Uint8ClampedArray(tile.buffer)
      const data = transformTileBuffer(rawData, tileSize, { rotation, flipH, flipV })
      setTileBrush({
        sourceClipId: sourceClip.id,
        tileIndex,
        tileSize,
        rotation,
        flipH,
        flipV,
        rawData,
        data,
      })
    },
    [sliced.tiles, tileBrush, tileSize, setTileBrush, sourceClip.id],
  )

  const enableCanvasStamp = useCallback(() => {
    if (!tileBrush) {
      const first = sliced.tiles.find((t) => !t.empty) ?? sliced.tiles[0]
      if (first) pickTile(first.index)
    }
    setTileSnap(true)
    setTileStamp(true)
    setTool('pencil')
  }, [tileBrush, sliced.tiles, pickTile, setTileSnap, setTileStamp, setTool])

  // Compose live 2-layer Level Mockup (Ground + optional alpha-composited Overlay/Props)
  const mockup = useMemo(() => {
    return composeLevelMockup({
      tilesetFrames,
      srcW: project.width,
      srcH: project.height,
      tileSize,
      mapCols: roomDims.cols,
      mapRows: roomDims.rows,
      cells: room.ground,
      overlayCells: showOverlay ? room.overlay : undefined,
      frameIndex: tilesetFrames.length > 1 ? animFrame % tilesetFrames.length : 0,
    })
  }, [tilesetFrames, project.width, project.height, tileSize, roomDims.cols, roomDims.rows, room, showOverlay, animFrame])

  const applyRoomCell = useCallback(
    (col: number, row: number, action: 'stamp' | 'erase') => {
      const idx = row * roomDims.cols + col
      setRoom((prev) => {
        const layerArr = prev[activeRoomLayer]
        const nextCell: LevelMockupCell | null =
          action === 'erase' || !tileBrush
            ? null
            : {
                tileIndex: tileBrush.tileIndex,
                rotation: tileBrush.rotation,
                flipH: tileBrush.flipH,
                flipV: tileBrush.flipV,
              }
        const cur = layerArr[idx]
        if (
          cur?.tileIndex === nextCell?.tileIndex &&
          cur?.rotation === nextCell?.rotation &&
          cur?.flipH === nextCell?.flipH &&
          cur?.flipV === nextCell?.flipV
        ) {
          return prev
        }
        if (!strokeSavedRef.current) {
          strokeSavedRef.current = true
          pushRoomUndo(prev)
        }
        const nextLayer = layerArr.slice()
        nextLayer[idx] = nextCell
        return { ...prev, [activeRoomLayer]: nextLayer }
      })
    },
    [roomDims.cols, activeRoomLayer, tileBrush, pushRoomUndo],
  )

  const handleRoomPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>, cell: { col: number; row: number }) => {
      // Alt+click eyedrops from active layer (falls back to other layer if empty)
      if (e.altKey) {
        const idx = cell.row * roomDims.cols + cell.col
        const placed =
          room[activeRoomLayer][idx] ??
          room[activeRoomLayer === 'overlay' ? 'ground' : 'overlay'][idx]
        if (placed) {
          pickTile(placed.tileIndex, {
            rotation: placed.rotation ?? 0,
            flipH: Boolean(placed.flipH),
            flipV: Boolean(placed.flipV),
          })
        }
        return
      }
      const action = e.button === 2 ? 'erase' : 'stamp'
      if (action === 'stamp' && !tileBrush) {
        const first = sliced.tiles.find((t) => !t.empty) ?? sliced.tiles[0]
        if (first) pickTile(first.index)
        return
      }
      strokeSavedRef.current = false
      paintingRoomRef.current = action
      applyRoomCell(cell.col, cell.row, action)
    },
    [roomDims.cols, room, activeRoomLayer, pickTile, tileBrush, sliced.tiles, applyRoomCell],
  )

  const handleRoomPointerMove = useCallback(
    (_e: React.PointerEvent<HTMLCanvasElement>, cell: { col: number; row: number }) => {
      const action = paintingRoomRef.current
      if (!action) return
      applyRoomCell(cell.col, cell.row, action)
    },
    [applyRoomCell],
  )

  const handleRoomPointerUp = useCallback(() => {
    paintingRoomRef.current = null
    strokeSavedRef.current = false
  }, [])

  const fillRoomWithActive = (borderOnly: boolean) => {
    if (!tileBrush) {
      toast({ title: 'Pick a tile first', description: 'Click any tile in the Tileset Picker above.' })
      return
    }
    const stamp: LevelMockupCell = {
      tileIndex: tileBrush.tileIndex,
      rotation: tileBrush.rotation,
      flipH: tileBrush.flipH,
      flipV: tileBrush.flipV,
    }
    pushRoomUndo(room)
    setRoom((prev) => {
      const nextLayer = prev[activeRoomLayer].map((cur, idx) => {
        const col = idx % roomDims.cols
        const row = Math.floor(idx / roomDims.cols)
        const isEdge = col === 0 || row === 0 || col === roomDims.cols - 1 || row === roomDims.rows - 1
        if (borderOnly && !isEdge) return cur
        return { ...stamp }
      })
      return { ...prev, [activeRoomLayer]: nextLayer }
    })
  }

  const handleClearActiveLayer = () => {
    const hasCells = room[activeRoomLayer].some((c) => c !== null)
    if (!hasCells) return
    pushRoomUndo(room)
    setRoom((prev) => ({
      ...prev,
      [activeRoomLayer]: new Array<LevelMockupCell | null>(roomDims.cols * roomDims.rows).fill(null),
    }))
  }

  const roomExceedsCanvas = mockup.width > project.width || mockup.height > project.height
  const canResizeToFullRoom = mockup.width <= 256 && mockup.height <= 256

  const handleBakeRoom = (resizeToFit: boolean) => {
    const filled = room.ground.some((c) => c !== null) || room.overlay.some((c) => c !== null)
    if (!filled) {
      toast({ title: 'Test room is empty', description: 'Stamp at least one tile before baking to a clip.' })
      return
    }
    const frameCount = Math.max(1, tilesetFrames.length)
    const frames: Uint8ClampedArray[] = []
    for (let f = 0; f < frameCount; f++) {
      frames.push(
        composeLevelMockup({
          tilesetFrames,
          srcW: project.width,
          srcH: project.height,
          tileSize,
          mapCols: roomDims.cols,
          mapRows: roomDims.rows,
          cells: room.ground,
          overlayCells: showOverlay ? room.overlay : undefined,
          frameIndex: f,
        }).buffer,
      )
    }
    const id = bakeMockupToNewClip({
      name: `room-${roomDims.cols}x${roomDims.rows}`,
      frames,
      width: mockup.width,
      height: mockup.height,
      fps: sourceClip.fps || 8,
      resizeToFit,
    })
    if (id) {
      const pAfter = useEditor.getState().project
      toast({
        title: 'Baked test room to new clip',
        description: `${frameCount} frame${frameCount === 1 ? '' : 's'} created (${mockup.width}×${mockup.height} onto ${pAfter.width}×${pAfter.height} canvas).`,
      })
      setTheaterOpen(false)
    }
  }

  const handleExportRoomPng = async () => {
    try {
      const png = await encodePng(mockup.width, mockup.height, mockup.buffer)
      const blob = new Blob([new Uint8Array(png)], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${project.name || 'pixelforge'}-room-${roomDims.cols}x${roomDims.rows}.png`
      a.click()
      URL.revokeObjectURL(url)
      toast({ title: 'Exported room mockup PNG', description: `${mockup.width}×${mockup.height}px downloaded.` })
    } catch (err) {
      toast({ title: 'Export failed', description: String(err), variant: 'destructive' })
    }
  }

  const visibleTiles = hideEmpty ? sliced.tiles.filter((t) => !t.empty) : sliced.tiles
  const canvasStampActive = tileSnap && tileStamp && tileBrush !== null

  const renderPickerControls = (compact: boolean) => (
    <section className="space-y-2 rounded-lg border border-zinc-800/90 bg-zinc-900/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Grid3X3 className="h-3.5 w-3.5 text-teal-400" />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-200">
            Tileset Picker
          </span>
        </div>
        <span className="font-mono text-[9px] text-zinc-500">
          {sliced.cols}×{sliced.rows} ({sliced.nonEmptyCount} used)
        </span>
      </div>

      {/* Clip selector + Hide Empty */}
      <div className="flex items-center gap-1.5">
        <select
          aria-label="Tileset source clip"
          value={sourceClip.id}
          onChange={(e) => setSourceClipId(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-[10px] text-zinc-200 focus:border-teal-500 focus:outline-none"
        >
          {project.clips.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.frames.length}f)
            </option>
          ))}
        </select>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={`h-7 w-7 shrink-0 ${hideEmpty ? 'bg-teal-500/15 text-teal-300' : 'text-zinc-400'}`}
              onClick={() => setHideEmpty((v) => !v)}
              aria-label="Hide empty tiles"
            >
              {hideEmpty ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {hideEmpty ? 'Showing non-empty tiles only' : 'Hide empty tiles'}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Tile Sizes: 8, 16, 24, 32, 48, 64px */}
      <div className="grid grid-cols-6 overflow-hidden rounded border border-zinc-800 bg-zinc-950">
        {TILE_SIZES.map((sz) => (
          <button
            key={sz}
            type="button"
            onClick={() => setTileSize(sz)}
            className={`py-1 font-mono text-[9px] transition ${
              tileSize === sz
                ? 'bg-teal-500/20 font-semibold text-teal-300'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {sz}px
          </button>
        ))}
      </div>

      {/* Tile Grid */}
      {visibleTiles.length === 0 ? (
        <p className="rounded border border-dashed border-zinc-800 px-2 py-4 text-center font-mono text-[10px] text-zinc-500">
          {sliced.tiles.length === 0
            ? `Canvas (${project.width}×${project.height}) is smaller than ${tileSize}px tile size.`
            : 'No drawn tiles yet — paint on the canvas or unhide empty tiles.'}
        </p>
      ) : (
        <div
          className={`pixelforge-scroll grid gap-1 overflow-y-auto rounded border border-zinc-800/80 bg-zinc-950/70 p-1.5 ${
            compact ? 'max-h-40 grid-cols-5' : 'max-h-[46vh] grid-cols-4'
          }`}
        >
          {visibleTiles.map((tile) => {
            const selected =
              tileBrush?.sourceClipId === sourceClip.id && tileBrush?.tileIndex === tile.index
            return (
              <button
                key={tile.index}
                type="button"
                onClick={() => pickTile(tile.index)}
                title={`Tile #${tile.index} (col ${tile.col}, row ${tile.row})`}
                className={`group relative flex items-center justify-center rounded border p-0.5 transition ${
                  selected
                    ? 'border-teal-400 bg-teal-500/15 ring-1 ring-teal-400/50'
                    : 'border-zinc-800/90 bg-zinc-900/60 hover:border-zinc-600'
                }`}
              >
                <TileThumb buffer={tile.buffer} size={tileSize} displayPx={compact ? 36 : 48} />
                <span className="pointer-events-none absolute bottom-0 right-0.5 rounded bg-black/70 px-0.5 font-mono text-[8px] text-zinc-400">
                  {tile.index}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* Active Stamp Transform Controls */}
      <div className="flex items-center justify-between gap-2 rounded-md border border-zinc-800/80 bg-zinc-950/80 p-1.5">
        <div className="flex items-center gap-2">
          {tileBrush ? (
            <TileThumb buffer={tileBrush.data} size={tileBrush.tileSize} displayPx={32} />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded border border-dashed border-zinc-700 font-mono text-[9px] text-zinc-500">
              —
            </div>
          )}
          <div className="min-w-0">
            <div className="font-mono text-[10px] font-medium text-zinc-200">
              {tileBrush ? `Tile #${tileBrush.tileIndex}` : 'No tile picked'}
            </div>
            <div className="font-mono text-[8px] text-zinc-500">
              {tileBrush
                ? `${tileBrush.rotation}°${tileBrush.flipH ? ' · FlipH' : ''}${tileBrush.flipV ? ' · FlipV' : ''}`
                : 'Click a tile above'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-zinc-300 hover:text-teal-300"
                disabled={!tileBrush}
                onClick={rotateTileBrushCW}
                aria-label="Rotate tile 90 degrees clockwise"
              >
                <RotateCw className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Rotate 90° CW [Q]</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-7 w-7 ${tileBrush?.flipH ? 'bg-teal-500/15 text-teal-300' : 'text-zinc-300'}`}
                disabled={!tileBrush}
                onClick={flipTileBrushH}
                aria-label="Flip tile horizontally"
              >
                <FlipHorizontal className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Flip Horizontal</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-7 w-7 ${tileBrush?.flipV ? 'bg-teal-500/15 text-teal-300' : 'text-zinc-300'}`}
                disabled={!tileBrush}
                onClick={flipTileBrushV}
                aria-label="Flip tile vertically"
              >
                <FlipVertical className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Flip Vertical</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-zinc-400 hover:text-zinc-200"
                disabled={!tileBrush}
                onClick={resetTileBrushTransform}
                aria-label="Reset tile transform"
              >
                <RotateCcw className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Reset rotation &amp; flip</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {compact && (
        <Button
          type="button"
          size="sm"
          variant={canvasStampActive ? 'secondary' : 'outline'}
          onClick={() => {
            if (canvasStampActive) setTileStamp(false)
            else enableCanvasStamp()
          }}
          className={`h-7 w-full font-mono text-[10px] ${
            canvasStampActive
              ? 'border-teal-500/50 bg-teal-500/15 text-teal-300'
              : 'border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-teal-500/50'
          }`}
        >
          <Stamp className="mr-1.5 h-3.5 w-3.5" />
          {canvasStampActive ? 'Canvas Tile Stamp: ON (click to stop)' : 'Stamp Selected Tile on Canvas'}
        </Button>
      )}
    </section>
  )

  const renderRoomControls = (inTheater: boolean) => (
    <section className={`flex flex-col gap-2 rounded-lg border border-zinc-800/90 bg-zinc-900/50 p-2.5 ${inTheater ? 'min-h-0 flex-1' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          <SquareDashed className="h-3.5 w-3.5 text-amber-400" />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-200">
            Level Mockup Room
          </span>
          <span className="font-mono text-[9px] text-zinc-500">
            {mockup.width}×{mockup.height}px
          </span>
        </div>

        <div className="flex items-center gap-1">
          {tilesetFrames.length > 1 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-6 w-6 ${animPlaying ? 'bg-teal-500/15 text-teal-300' : 'text-zinc-400'}`}
                  onClick={() => setAnimPlaying((v) => !v)}
                  aria-label={animPlaying ? 'Pause animated tiles' : 'Play animated tiles'}
                >
                  {animPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Animated tiles ({tilesetFrames.length}f @ {sourceClip.fps}fps)
              </TooltipContent>
            </Tooltip>
          )}
          <div className="flex overflow-hidden rounded border border-zinc-800 bg-zinc-950">
            {ROOM_PRESETS.map((p, idx) => (
              <button
                key={p.label}
                type="button"
                onClick={() => selectRoomPreset(idx)}
                className={`px-1.5 py-0.5 font-mono text-[9px] transition ${
                  roomPresetIdx === idx
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {!inTheater && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-zinc-400 hover:text-teal-300"
                  onClick={() => setTheaterOpen(true)}
                  aria-label="Expand Level Mockup Theater"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Expand Level Mockup Theater</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* 2-Layer Switcher (Ground vs Props/Overlay) + Room Undo/Redo */}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1">
          <div className="flex overflow-hidden rounded border border-zinc-800 bg-zinc-950">
            <button
              type="button"
              onClick={() => setActiveRoomLayer('ground')}
              className={`px-2 py-0.5 font-mono text-[9px] transition ${
                activeRoomLayer === 'ground'
                  ? 'bg-teal-500/20 font-semibold text-teal-300'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Ground
            </button>
            <button
              type="button"
              onClick={() => setActiveRoomLayer('overlay')}
              className={`px-2 py-0.5 font-mono text-[9px] transition ${
                activeRoomLayer === 'overlay'
                  ? 'bg-amber-500/20 font-semibold text-amber-300'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Props Overlay
            </button>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-6 w-6 ${showOverlay ? 'text-amber-300' : 'text-zinc-600'}`}
                onClick={() => setShowOverlay((v) => !v)}
                aria-label={showOverlay ? 'Hide Props Overlay layer' : 'Show Props Overlay layer'}
              >
                {showOverlay ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {showOverlay ? 'Props Overlay visible' : 'Props Overlay hidden'}
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={roomUndo.length === 0}
                onClick={handleRoomUndo}
                className="h-6 w-6 text-zinc-400 hover:text-zinc-100 disabled:opacity-35"
                aria-label="Undo room edit"
              >
                <Undo2 className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Undo room edit</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={roomRedo.length === 0}
                onClick={handleRoomRedo}
                className="h-6 w-6 text-zinc-400 hover:text-zinc-100 disabled:opacity-35"
                aria-label="Redo room edit"
              >
                <Redo2 className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Redo room edit</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <p className="font-mono text-[9px] leading-snug text-zinc-400">
        {activeRoomLayer === 'overlay'
          ? 'Overlay mode: transparent props composite cleanly over Ground! '
          : 'Left-drag stamps · Right-drag erases · Alt+click picks tile. '}
        {tilesetFrames.length > 1 ? 'Animated tiles play live!' : ''}
      </p>

      {/* Interactive Room Stage */}
      <div className={inTheater ? 'flex min-h-0 flex-1 items-center justify-center overflow-auto' : ''}>
        <InteractiveRoomCanvas
          mockup={mockup}
          cols={roomDims.cols}
          rows={roomDims.rows}
          tileSize={tileSize}
          tileBrush={tileBrush}
          showGrid={showRoomGrid}
          onPointerDown={handleRoomPointerDown}
          onPointerMove={handleRoomPointerMove}
          onPointerUp={handleRoomPointerUp}
          className={inTheater ? 'w-full max-w-[680px]' : 'w-full'}
        />
      </div>

      {/* Room Quick Actions */}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fillRoomWithActive(false)}
          className="h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[9px] text-zinc-300 hover:text-zinc-100"
        >
          Fill {activeRoomLayer === 'ground' ? 'Floor' : 'Overlay'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fillRoomWithActive(true)}
          className="h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[9px] text-zinc-300 hover:text-zinc-100"
        >
          Walls Border
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowRoomGrid((v) => !v)}
          className="h-6 px-2 font-mono text-[9px] text-zinc-400 hover:text-zinc-200"
        >
          Grid: {showRoomGrid ? 'ON' : 'OFF'}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleClearActiveLayer}
              className="ml-auto h-6 w-6 text-zinc-500 hover:text-rose-400"
              aria-label={`Clear ${activeRoomLayer} layer`}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Clear {activeRoomLayer} layer</TooltipContent>
        </Tooltip>
      </div>

      {/* Bake / Export Row */}
      {roomExceedsCanvas && (
        <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 font-mono text-[9px] leading-snug text-amber-200/90">
          Room ({mockup.width}×{mockup.height}px) is larger than canvas ({project.width}×{project.height}px).
          {canResizeToFullRoom
            ? ' Use "Resize & Bake" for the full room, or Export PNG.'
            : ' Export PNG saves full resolution without cropping.'}
        </p>
      )}
      <div className="grid grid-cols-2 gap-1.5 pt-0.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => handleBakeRoom(roomExceedsCanvas && canResizeToFullRoom)}
          className="h-7 border-zinc-800 bg-zinc-950 font-mono text-[10px] text-zinc-200 hover:border-teal-500/50"
        >
          <Layers className="mr-1.5 h-3 w-3 text-teal-400" />
          {roomExceedsCanvas && canResizeToFullRoom ? 'Resize & Bake' : 'Bake to Clip'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleExportRoomPng()}
          className="h-7 border-zinc-800 bg-zinc-950 font-mono text-[10px] text-zinc-200 hover:border-amber-500/50"
        >
          <Download className="mr-1.5 h-3 w-3 text-amber-400" />
          Export PNG
        </Button>
      </div>
    </section>
  )

  return (
    <TooltipProvider delayDuration={250}>
      <div className="pixelforge-scroll flex h-full flex-col gap-3 overflow-y-auto p-3">
        {renderPickerControls(true)}
        {renderRoomControls(false)}
      </div>

      {/* Expandable Level Mockup Theater Modal */}
      <Dialog open={theaterOpen} onOpenChange={setTheaterOpen}>
        <DialogContent className="flex h-[88vh] w-[94vw] max-w-[94vw] flex-col gap-3 border-zinc-800 bg-zinc-950 p-4 text-zinc-100 sm:max-w-6xl">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 font-mono text-sm">
              <Grid3X3 className="h-4 w-4 text-teal-400" />
              Level Mockup Theater
              <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] font-normal text-zinc-400">
                {tileSize}px tiles · {roomDims.cols}×{roomDims.rows} ({mockup.width}×{mockup.height}px)
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden md:grid-cols-[300px_1fr]">
            <div className="pixelforge-scroll min-h-0 overflow-y-auto pr-1">
              {renderPickerControls(false)}
            </div>
            {renderRoomControls(true)}
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
