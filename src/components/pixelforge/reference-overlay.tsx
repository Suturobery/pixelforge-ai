// PixelForge AI — floating reference image overlay.
//
// Pixel artists draw over a reference constantly: pick any local image,
// float it over/next to the canvas, adjust opacity, mirror, RESIZE via the
// corner handle. Session-only (object URL — nothing persisted, nothing
// uploaded). Draggable via the header (pointer capture on the header —
// capturing on an ancestor breaks move events).
//
// The image itself is pointer-events:none so strokes pass "under" the
// semi-transparent reference — the whole point of the feature.

'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Eye,
  EyeOff,
  FlipHorizontal2,
  Image as ImageIcon,
  Lock,
  LockOpen,
  Minus,
  Palette,
  Plus,
  X,
} from 'lucide-react'
import { remapBufferToPalette } from '@pixelforge/core'
import { useEditor } from '@/lib/pixelforge/store'

import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'

const MIN_W = 64
const MAX_W = 900

export function ReferenceOverlay() {
  const palette = useEditor((s) => s.project.palette)
  const [imgSrc, setImgSrc] = useState<string | null>(null)
  const [quantizedSrc, setQuantizedSrc] = useState<string | null>(null)
  const [quantizeToPalette, setQuantizeToPalette] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [opacity, setOpacity] = useState(0.5)
  const [mirrored, setMirrored] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [width, setWidth] = useState(288)
  /** false (default) = draw "under" the translucent ref (image ignores the
   *  pointer); true = the image itself becomes the drag grip for moving the
   *  whole panel — the natural gesture users try first. */
  const [unlocked, setUnlocked] = useState(false)
  const aspectRef = useRef(1)
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const resizeRef = useRef<{ sx: number; startW: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // keep the window inside the stage on container resizes
  useEffect(() => {
    const parent = rootRef.current?.offsetParent as HTMLElement | null
    if (!parent) return
    const ro = new ResizeObserver(() => {
      const el = rootRef.current
      setPos((cur) => {
        if (!el || !cur) return cur
        const maxX = Math.max(8, parent.clientWidth - el.offsetWidth - 8)
        const maxY = Math.max(8, parent.clientHeight - el.offsetHeight - 8)
        if (cur.x <= maxX && cur.y <= maxY) return cur
        return { x: Math.min(cur.x, maxX), y: Math.min(cur.y, maxY) }
      })
    })
    ro.observe(parent)
    return () => ro.disconnect()
  }, [imgSrc, hidden])

  const beginPanelDrag = (e: React.PointerEvent, grip: HTMLElement) => {
    if (e.button !== 0) return
    const el = rootRef.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return
    const r = el.getBoundingClientRect()
    const pr = parent.getBoundingClientRect()
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: r.left - pr.left, oy: r.top - pr.top }
    grip.setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const onHeaderPointerDown = (e: React.PointerEvent) => {
    // buttons (lock/mirror/hide/remove) must keep working — starting a drag
    // with pointer capture here hijacks their pointerup and kills their click
    if ((e.target as HTMLElement).closest('button')) return
    const header = headerRef.current
    if (header) beginPanelDrag(e, header)
  }
  const onImagePointerDown = (e: React.PointerEvent) => {
    // unlocked image doubles as the drag grip
    if (unlocked) beginPanelDrag(e, e.currentTarget as HTMLElement)
  }
  const onDragPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const parent = rootRef.current?.offsetParent as HTMLElement | null
    if (!parent) return
    const el = rootRef.current
    const nx = d.ox + (e.clientX - d.sx)
    const ny = d.oy + (e.clientY - d.sy)
    setPos({
      x: Math.min(Math.max(8, nx), Math.max(8, parent.clientWidth - (el?.offsetWidth ?? 0) - 8)),
      y: Math.min(Math.max(8, ny), Math.max(8, parent.clientHeight - (el?.offsetHeight ?? 0) - 8)),
    })
  }
  const onHeaderPointerUp = (e: React.PointerEvent) => {
    headerRef.current?.releasePointerCapture(e.pointerId)
    dragRef.current = null
    setDragging(false)
  }

  const onHandlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    handleRef.current?.setPointerCapture(e.pointerId)
    resizeRef.current = { sx: e.clientX, startW: width }
    setResizing(true)
  }
  const onHandlePointerMove = (e: React.PointerEvent) => {
    const d = resizeRef.current
    if (!d) return
    const next = Math.min(MAX_W, Math.max(MIN_W, d.startW + (e.clientX - d.sx)))
    setWidth(Math.round(next))
  }
  const onHandlePointerUp = (e: React.PointerEvent) => {
    handleRef.current?.releasePointerCapture(e.pointerId)
    resizeRef.current = null
    setResizing(false)
  }

  // Re-quantize the reference image live to the active project palette via OKLab
  useEffect(() => {
    if (!imgSrc || !quantizeToPalette || palette.length === 0) {
      setQuantizedSrc(null)
      return
    }
    let alive = true
    const im = new Image()
    im.onload = () => {
      if (!alive || im.naturalWidth === 0 || im.naturalHeight === 0) return
      const maxDim = 256
      const scale = Math.min(1, maxDim / Math.max(im.naturalWidth, im.naturalHeight))
      const rw = Math.max(1, Math.round(im.naturalWidth * scale))
      const rh = Math.max(1, Math.round(im.naturalHeight * scale))
      const cv = document.createElement('canvas')
      cv.width = rw
      cv.height = rh
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(im, 0, 0, rw, rh)
      const imgData = ctx.getImageData(0, 0, rw, rh)
      remapBufferToPalette(imgData.data, palette, { mode: 'nearest' })
      ctx.putImageData(imgData, 0, 0)
      if (alive) setQuantizedSrc(cv.toDataURL('image/png'))
    }
    im.src = imgSrc
    return () => {
      alive = false
    }
  }, [imgSrc, quantizeToPalette, palette])

  const pickFile = (f: File | undefined) => {
    if (!f || !f.type.startsWith('image/')) return
    if (imgSrc) URL.revokeObjectURL(imgSrc)
    setImgSrc(URL.createObjectURL(f))
    setQuantizedSrc(null)
    setQuantizeToPalette(false)
    setHidden(false)
    setPos(null)
    setOpacity(0.5)
    setMirrored(false)
    setWidth(288)
  }

  // collapsed states: pick button (no image) / show button (hidden image)
  if (!imgSrc || hidden) {
    const label = imgSrc ? 'Show reference image' : 'Load a reference image'
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-3 top-14 z-30 h-8 w-8 text-zinc-400 hover:text-zinc-100"
          onClick={() => (imgSrc ? setHidden(false) : fileRef.current?.click())}
          aria-label={label}
          title={imgSrc ? 'Show the reference image' : 'Reference image — float a picture over the canvas'}
        >
          {imgSrc ? <Eye className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
      </>
    )
  }

  const s = Math.round(opacity * 100)

  return (
    <>
      <div
        ref={rootRef}
        className={`absolute z-40 flex touch-none select-none flex-col gap-1 rounded-md border border-zinc-700/80 bg-zinc-950/95 p-1.5 shadow-xl backdrop-blur ${
          dragging || resizing ? 'cursor-grabbing' : ''
        }`}
        style={pos ? { left: pos.x, top: pos.y } : { right: 12, top: 12 }}
      >
        {/* drag grip = header (capture on the header itself) */}
        <div
          ref={headerRef}
          className={`flex items-center gap-1 ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerUp}
        >
          <ImageIcon className="h-3.5 w-3.5 shrink-0 text-teal-400" aria-hidden />
          <p className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-wider text-zinc-300">
            Reference
          </p>
          <button
            type="button"
            className={`rounded p-0.5 ${unlocked ? 'text-amber-300' : 'text-zinc-400 hover:text-zinc-100'}`}
            onClick={() => setUnlocked(!unlocked)}
            aria-label={unlocked ? 'Lock reference (draw under it)' : 'Unlock reference (drag the image to move)'}
            aria-pressed={unlocked}
            title={unlocked ? 'Unlocked — drag the image to move the panel' : 'Locked — draw under the reference (click to unlock for moving)'}
          >
            {unlocked ? <LockOpen className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            className={`rounded p-0.5 ${quantizeToPalette ? 'bg-teal-500/20 text-teal-300' : 'text-zinc-400 hover:text-zinc-100'}`}
            onClick={() => setQuantizeToPalette((v) => !v)}
            aria-label="Quantize reference image to active palette"
            aria-pressed={quantizeToPalette}
            title="Quantize reference to active project palette (OKLab)"
          >
            <Palette className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded p-0.5 text-zinc-400 hover:text-zinc-100"
            onClick={() => setMirrored(!mirrored)}
            aria-label="Mirror reference"
            aria-pressed={mirrored}
            title="Mirror horizontally"
          >
            <FlipHorizontal2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded p-0.5 text-zinc-400 hover:text-zinc-100"
            onClick={() => setHidden(true)}
            aria-label="Hide reference image"
            title="Hide — the small image button brings it back"
          >
            <EyeOff className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded p-0.5 text-zinc-400 hover:text-red-300"
            onClick={() => {
              if (imgSrc) URL.revokeObjectURL(imgSrc)
              setImgSrc(null)
              setPos(null)
              setHidden(false)
              setOpacity(0.5)
              setMirrored(false)
              setWidth(288)
            }}
            aria-label="Remove reference image"
            title="Remove"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* image — locked: pointer-events none, strokes pass under the
            translucent ref. Unlocked (lock button off): the image itself is
            the drag grip for moving the panel. */}
        <img
          src={quantizeToPalette && quantizedSrc ? quantizedSrc : imgSrc}
          alt="Reference"
          draggable={false}
          onPointerDown={onImagePointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerUp}
          className={`pixelforge-checker select-none rounded-sm object-contain ${
            unlocked ? 'cursor-grab ring-1 ring-amber-400/50' : ''
          }`}
          style={{
            width,
            height: 'auto',
            opacity,
            imageRendering: quantizeToPalette ? 'pixelated' : undefined,
            transform: mirrored ? 'scaleX(-1)' : undefined,
            pointerEvents: unlocked ? 'auto' : 'none',
          }}
          onLoad={(e) => {
            const img = e.currentTarget
            if (img.naturalWidth > 0) {
              aspectRef.current = img.naturalWidth / img.naturalHeight
              // first load: fit within a sane default, keep aspect
              if (!resizing) setWidth(Math.max(MIN_W, Math.min(img.naturalWidth, 288)))
            }
          }}
        />

        {/* opacity row */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="rounded p-0.5 text-zinc-400 hover:text-zinc-100"
            onClick={() => setOpacity((o) => Math.max(0.05, Math.round((o - 0.1) * 10) / 10))}
            aria-label="Decrease reference opacity"
          >
            <Minus className="h-3 w-3" />
          </button>
          <Slider
            value={[Math.round(opacity * 100)]}
            min={5}
            max={100}
            step={5}
            onValueChange={(v) => setOpacity((v[0] ?? 50) / 100)}
            className="flex-1"
            aria-label="Reference opacity"
          />
          <button
            type="button"
            className="rounded p-0.5 text-zinc-400 hover:text-zinc-100"
            onClick={() => setOpacity((o) => Math.min(1, Math.round((o + 0.1) * 10) / 10))}
            aria-label="Increase reference opacity"
          >
            <Plus className="h-3 w-3" />
          </button>
          <span className="w-8 text-right font-mono text-[9px] text-zinc-400">{s}%</span>
        </div>

        {/* resize row: − / size readout / + (corner handle does the heavy
            resizing; the slider was removed as redundant) */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="rounded p-0.5 text-zinc-400 hover:text-zinc-100"
            onClick={() => setWidth((w) => Math.max(MIN_W, w - 32))}
            aria-label="Smaller reference"
          >
            <Minus className="h-3 w-3" />
          </button>
          <span className="flex-1 text-center font-mono text-[9px] text-zinc-400">{width}px</span>
          <button
            type="button"
            className="rounded p-0.5 text-zinc-400 hover:text-zinc-100"
            onClick={() => setWidth((w) => Math.min(MAX_W, w + 32))}
            aria-label="Bigger reference"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>

        {/* corner resize handle — anchored INSIDE the panel so it follows
            drag/resize automatically */}
        <div
          ref={handleRef}
          role="separator"
          aria-label="Resize reference image"
          title="Drag to resize"
          className={`absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize touch-none rounded-sm border-b-2 border-r-2 border-teal-400/80 bg-zinc-950/60 ${
            resizing ? 'border-teal-300' : 'hover:border-teal-300'
          }`}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
        />
      </div>
    </>
  )
}
