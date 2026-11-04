// PixelForge AI — approval center cards (Task 11 §5.2).
//
// Paid MCP ops (generate_sprite) park server-side until the human clicks
// Approve/Deny here. Rendered as a fixed overlay so the cards are visible
// no matter which panel tab or dock state is active.

'use client'

import { useRef, useState, useSyncExternalStore } from 'react'
import { Check, X, GripHorizontal, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  getApprovals,
  subscribeApprovals,
  respondApproval,
  type ApprovalItem,
} from '@/lib/pixelforge/mcp-bridge'

export function ApprovalCards() {
  const items = useSyncExternalStore(subscribeApprovals, getApprovals, getApprovals)
  if (items.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(92vw,360px)] flex-col gap-2">
      {items.map((a) => (
        <ApprovalCard key={a.id} item={a} />
      ))}
    </div>
  )
}

function ApprovalCard({ item }: { item: ApprovalItem }) {
  const ageSec = Math.max(0, Math.round((Date.now() - new Date(item.requestedAt).getTime()) / 1000))
  const leftSec = Math.max(0, item.timeoutSec - ageSec)
  // drag by the header: offset from the docked position, pointer-captured
  const drag = useRef<{ px: number; py: number; dx: number; dy: number } | null>(null)
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    drag.current = { px: e.clientX, py: e.clientY, dx: offset.x, dy: offset.y }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onHeaderPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    setOffset({ x: d.dx + (e.clientX - d.px), y: d.dy + (e.clientY - d.py) })
  }
  const onHeaderPointerUp = () => {
    drag.current = null
    setDragging(false)
  }

  return (
    <div
      role="alertdialog"
      aria-label={`Approval requested: ${item.tool}`}
      className="pointer-events-auto rounded-lg border border-amber-500/40 bg-zinc-950/95 p-3 shadow-2xl backdrop-blur-md"
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
    >
      <div
        className={`flex touch-none items-center gap-1 select-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <GripHorizontal className="h-3.5 w-3.5 shrink-0 cursor-grab text-zinc-600" aria-hidden />
        <Sparkles className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
        <p className="min-w-0 flex-1 font-mono text-[11px] uppercase tracking-wider text-amber-300">
          {item.tool} — approval
        </p>
        <span className="font-mono text-[10px] text-zinc-500">{Math.floor(leftSec / 60)}:{String(leftSec % 60).padStart(2, '0')}</span>
      </div>
      <p className="mt-1.5 break-words text-xs leading-relaxed text-zinc-200">{item.summary || item.tool}</p>
      <p className="mt-1 font-mono text-[10px] text-zinc-500">
        requested by {item.clientName} · nothing spent until you approve
      </p>
      <div className="mt-2.5 flex gap-2">
        <Button
          size="sm"
          className="h-7 flex-1 bg-teal-600 text-white hover:bg-teal-500"
          onClick={() => respondApproval(item.id, true)}
          aria-label={`Approve ${item.tool}`}
        >
          <Check className="h-3.5 w-3.5" /> Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 flex-1 border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          onClick={() => respondApproval(item.id, false)}
          aria-label={`Deny ${item.tool}`}
        >
          <X className="h-3.5 w-3.5" /> Deny
        </Button>
      </div>
    </div>
  )
}
