// PixelForge AI — Live AI Artist visual overlay & interactive Co-Pilot HUD.
//
// Canvas overlay is pointer-events-none (zero React re-renders during 60fps sweep).
// The floating Co-Pilot HUD pill stays unobtrusive when idle and expands into a
// live Activity Feed with 1-click Undo, Before/After peek, Jump-to-Frame,
// Auto-Follow toggle, and Artist Priority (Pause AI) lock.

'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Navigation,
  Pause,
  Play,
  Sparkles,
  Trash2,
  Undo2,
} from 'lucide-react'
import {
  clearAiActivityFeed,
  flashAiRegion,
  getAiActivitySnapshot,
  getUndoStepsForAiEntry,
  setAiAutoFollow,
  setAiComparePreview,
  setAiPaused,
  subscribeAiActivity,
  type AiActivityEntry,
  type AiDrawPulse,
} from '@/lib/pixelforge/ai-live-activity'
import { getBridgeState, subscribeBridge } from '@/lib/pixelforge/mcp-bridge'
import { followCommandTarget } from '@/lib/pixelforge/mcp-follow'
import { getBus, useEditor } from '@/lib/pixelforge/store'

function useAiActivity() {
  return useSyncExternalStore(subscribeAiActivity, getAiActivitySnapshot, getAiActivitySnapshot)
}

function useBridgeSnapshot() {
  return useSyncExternalStore(subscribeBridge, getBridgeState, getBridgeState)
}

function formatEntryTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/**
 * 60fps transparent overlay aligned 1:1 with the pixel board (`W*zoom × H*zoom`).
 * Renders:
 *   1. Soft corner brackets framing the edited region (or focus-flash region)
 *   2. Progressive glowing pixel-sparkle trail riding the exact reveal edge
 *   3. Moving Figma-style AI Artist cursor + name badge gliding along the stroke
 */
export const AiLiveCanvasOverlay = memo(function AiLiveCanvasOverlay({
  width,
  height,
  zoom,
  clipId,
  frameId,
}: {
  width: number
  height: number
  zoom: number
  clipId: string
  frameId: string
}) {
  const { pulses, comparePreview } = useAiActivity()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const cursorLabelRef = useRef<HTMLSpanElement>(null)

  const cssW = Math.max(1, Math.round(width * zoom))
  const cssH = Math.max(1, Math.round(height * zoom))

  const visiblePulses = useMemo(
    () =>
      pulses.filter(
        (p) => !p.clipId || (p.clipId === clipId && (!p.frameId || p.frameId === frameId)),
      ),
    [pulses, clipId, frameId],
  )

  const isComparingHere =
    comparePreview !== null &&
    comparePreview.clipId === clipId &&
    comparePreview.frameId === frameId

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    const hideCursor = () => {
      if (cursorRef.current) cursorRef.current.style.opacity = '0'
    }

    if (visiblePulses.length === 0 || isComparingHere) {
      ctx.clearRect(0, 0, cv.width, cv.height)
      hideCursor()
      return
    }

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    let raf = 0
    const draw = () => {
      const now = Date.now()
      const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
      const targetW = Math.max(1, Math.round(cssW * dpr))
      const targetH = Math.max(1, Math.round(cssH * dpr))
      if (cv.width !== targetW || cv.height !== targetH) {
        cv.width = targetW
        cv.height = targetH
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)

      let anyAlive = false
      let leadCursor: { x: number; y: number; clientName: string; opacity: number } | null = null

      for (const pulse of visiblePulses as readonly AiDrawPulse[]) {
        const elapsed = now - pulse.startedAt
        if (elapsed >= pulse.durationMs) continue
        anyAlive = true

        const t = Math.max(0, Math.min(1, elapsed / pulse.durationMs))
        // Matches canvas-stage.tsx's progressive reveal curve so sparkles ride the reveal edge
        const sweep = reducedMotion ? 1 : Math.min(1, t / 0.68)
        const fade = t < 0.55 ? 1 : Math.max(0, 1 - (t - 0.55) / 0.45)

        // 1. Subtle glowing corner brackets around the edited region
        if (pulse.bbox) {
          const bx = pulse.bbox.x * zoom
          const by = pulse.bbox.y * zoom
          const bw = pulse.bbox.w * zoom
          const bh = pulse.bbox.h * zoom
          const arm = Math.max(4, Math.min(12, Math.min(bw, bh) * 0.35))
          ctx.save()
          if (pulse.highlightOnly) {
            ctx.fillStyle = `rgba(45, 212, 191, ${(0.14 * fade).toFixed(3)})`
            ctx.fillRect(bx, by, bw, bh)
          }
          ctx.strokeStyle = `rgba(45, 212, 191, ${(0.78 * fade).toFixed(3)})`
          ctx.lineWidth = pulse.highlightOnly ? 2 : 1.5
          ctx.beginPath()
          ctx.moveTo(bx, by + arm)
          ctx.lineTo(bx, by)
          ctx.lineTo(bx + arm, by)
          ctx.moveTo(bx + bw - arm, by)
          ctx.lineTo(bx + bw, by)
          ctx.lineTo(bx + bw, by + arm)
          ctx.moveTo(bx, by + bh - arm)
          ctx.lineTo(bx, by + bh)
          ctx.lineTo(bx + arm, by + bh)
          ctx.moveTo(bx + bw - arm, by + bh)
          ctx.lineTo(bx + bw, by + bh)
          ctx.lineTo(bx + bw, by + bh - arm)
          ctx.stroke()
          ctx.restore()
        }

        // 2. Glowing pixel trail sweeping across changed pixels
        const pts = pulse.pixels
        if (!pulse.highlightOnly && pts.length > 0) {
          const headIdx = Math.min(pts.length - 1, Math.floor(sweep * pts.length))
          const tailLen = Math.max(12, Math.min(140, Math.ceil(pts.length * 0.28)))
          const startIdx = reducedMotion ? 0 : Math.max(0, headIdx - tailLen)
          const cellSize = Math.max(1, zoom)

          for (let i = startIdx; i <= headIdx; i++) {
            const p = pts[i]!
            const local = reducedMotion ? 0.5 : (i - startIdx + 1) / (headIdx - startIdx + 1)
            const alpha = (0.12 + 0.48 * local * local) * fade
            ctx.fillStyle =
              local > 0.88 && !reducedMotion
                ? `rgba(204, 251, 241, ${Math.min(0.95, alpha * 1.35).toFixed(3)})`
                : `rgba(45, 212, 191, ${alpha.toFixed(3)})`
            ctx.fillRect(p.x * zoom, p.y * zoom, cellSize, cellSize)
          }

          if (!reducedMotion) {
            const head = pts[headIdx]!
            leadCursor = {
              x: (head.x + 0.5) * zoom,
              y: (head.y + 0.5) * zoom,
              clientName: pulse.clientName,
              opacity: fade,
            }
          }
        }
      }

      if (cursorRef.current) {
        if (leadCursor) {
          cursorRef.current.style.transform = `translate3d(${leadCursor.x}px, ${leadCursor.y}px, 0)`
          cursorRef.current.style.opacity = String(leadCursor.opacity)
          if (cursorLabelRef.current && cursorLabelRef.current.textContent !== leadCursor.clientName) {
            cursorLabelRef.current.textContent = leadCursor.clientName
          }
        } else {
          cursorRef.current.style.opacity = '0'
        }
      }

      if (anyAlive) {
        raf = requestAnimationFrame(draw)
      } else {
        ctx.clearRect(0, 0, cssW, cssH)
        hideCursor()
      }
    }

    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      hideCursor()
    }
  }, [visiblePulses, isComparingHere, cssW, cssH, zoom])

  if (visiblePulses.length === 0 && !isComparingHere) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-visible" aria-hidden>
      {isComparingHere && (
        <div className="absolute left-1.5 top-1.5 rounded bg-amber-500/95 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider text-zinc-950 shadow">
          BEFORE
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="absolute left-0 top-0"
        style={{ width: cssW, height: cssH }}
      />
      <div ref={cursorRef} className="absolute left-0 top-0" style={{ opacity: 0 }}>
        {/* Crisp AI brush cursor */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          className="-translate-x-1 -translate-y-1 drop-shadow-[0_1px_4px_rgba(20,184,166,0.9)]"
        >
          <path
            d="M2 2 L13 6.5 L8.2 8.2 L6.5 13 Z"
            fill="#2dd4bf"
            stroke="#042f2e"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
        <span className="-mt-1 ml-2.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-teal-400/50 bg-zinc-950/90 px-1.5 py-0.5 font-mono text-[9px] font-medium text-teal-200 shadow-lg backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
          <span ref={cursorLabelRef} />
        </span>
      </div>
    </div>
  )
})

/**
 * Floating top-center Live AI Co-Pilot HUD:
 *  - Shows real-time agent activity, pixel delta, or Artist Priority pause state
 *  - Quick inline actions: Jump (when off-frame), Hold-to-Compare Before/After, 1-click Undo, Pause/Resume AI
 *  - Expands into a compact Activity Feed with per-step Undo, Auto-Follow toggle, and region highlight
 */
export const AiLiveStatusPill = memo(function AiLiveStatusPill() {
  const { banner, feed, paused, autoFollow, comparePreview } = useAiActivity()
  const bridge = useBridgeSnapshot()
  const historyUndoDepth = useEditor((s) => s.historyUndoDepth)
  const loadEpoch = useEditor((s) => s.loadEpoch)
  const [feedOpen, setFeedOpen] = useState(false)
  const hudRef = useRef<HTMLDivElement>(null)

  const connectedAgents =
    bridge.status === 'connected' ? (bridge.server?.clientsConnected ?? 0) : 0

  // Close the Activity Feed on Escape or click outside
  useEffect(() => {
    if (!feedOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFeedOpen(false)
    }
    const onPointerDown = (e: PointerEvent) => {
      if (hudRef.current && !hudRef.current.contains(e.target as Node)) {
        setFeedOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [feedOpen])

  const runUndoSteps = useCallback((steps: number) => {
    const bus = getBus()
    if (bus.activeStroke) return
    setAiComparePreview(null)
    for (let i = 0; i < steps; i++) {
      if (!bus.canUndo()) break
      bus.undo()
    }
  }, [])

  const jumpToEntry = useCallback((entry: Pick<AiActivityEntry, 'id' | 'clipId' | 'frameId' | 'bbox'>) => {
    if (entry.clipId) {
      followCommandTarget({ clipId: entry.clipId, frameId: entry.frameId }, { force: true })
    }
    if (entry.bbox) {
      flashAiRegion(entry.id)
    }
  }, [])

  const startCompare = useCallback(
    (entry: AiActivityEntry) => {
      if (!entry.compare) return
      followCommandTarget({ clipId: entry.compare.clipId, frameId: entry.compare.frameId }, { force: true })
      setAiComparePreview(entry.id)
    },
    [],
  )

  const stopCompare = useCallback(() => {
    setAiComparePreview(null)
  }, [])

  if (!banner && !paused && feed.length === 0 && connectedAgents === 0) return null

  const isEntryStillApplied = (entry: AiActivityEntry): boolean =>
    !entry.undoInvalidated &&
    entry.loadEpoch === loadEpoch &&
    (entry.undoDepthAfter === undefined || entry.undoDepthAfter <= historyUndoDepth)

  // Resolve the featured entry (banner's entry if present, otherwise latest feed entry)
  const featuredEntry =
    (banner?.entryId ? feed.find((e) => e.id === banner.entryId) : undefined) ?? feed[0] ?? null
  const featuredUndoSteps = featuredEntry
    ? getUndoStepsForAiEntry(featuredEntry, historyUndoDepth, loadEpoch)
    : null
  const canCompareFeatured =
    featuredEntry !== null &&
    featuredEntry.compare !== undefined &&
    isEntryStillApplied(featuredEntry)

  const isWaiting = banner?.tone === 'waiting'
  const isError = banner?.tone === 'error'
  const pillBorder = paused
    ? 'border-amber-500/60 shadow-[0_4px_20px_rgba(245,158,11,0.2)]'
    : isWaiting
      ? 'border-amber-400/50 shadow-[0_4px_20px_rgba(245,158,11,0.18)]'
      : isError
        ? 'border-rose-500/50 shadow-[0_4px_20px_rgba(244,63,94,0.18)]'
        : banner
          ? 'border-teal-500/45 shadow-[0_4px_24px_rgba(20,184,166,0.22)]'
          : connectedAgents > 0
            ? 'border-teal-500/30 shadow-lg'
            : 'border-zinc-700/70 shadow-lg'

  return (
    <div
      ref={hudRef}
      className="pointer-events-none absolute left-1/2 top-3 z-30 flex max-w-[94%] -translate-x-1/2 flex-col items-center gap-1.5"
    >
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-auto flex max-w-full items-center gap-1.5 rounded-full border bg-zinc-950/92 px-2.5 py-1 backdrop-blur-md transition-colors ${pillBorder}`}
      >
        {/* Status dot */}
        <span className="relative flex h-2 w-2 shrink-0">
          {banner?.busy && !paused && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />
          )}
          <span
            className={`relative inline-flex h-2 w-2 rounded-full ${
              paused || isWaiting
                ? 'bg-amber-400'
                : isError
                  ? 'bg-rose-400'
                  : banner
                    ? 'bg-teal-400'
                    : 'bg-teal-400/70'
            }`}
          />
        </span>

        {/* Icon + Main label */}
        {paused ? (
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px]">
            <Pause className="h-3 w-3 shrink-0 text-amber-300" aria-hidden />
            <span className="shrink-0 font-semibold text-amber-200">AI Paused</span>
            <span className="hidden truncate text-zinc-400 sm:inline">artist holds canvas</span>
          </div>
        ) : banner ? (
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px]">
            <Sparkles
              className={`h-3 w-3 shrink-0 ${
                isWaiting ? 'text-amber-300' : isError ? 'text-rose-300' : 'text-teal-300'
              }`}
              aria-hidden
            />
            <span
              className={`shrink-0 font-semibold ${
                isWaiting ? 'text-amber-200' : isError ? 'text-rose-200' : 'text-teal-200'
              }`}
            >
              {banner.clientName}
            </span>
            <span className="max-w-[180px] truncate text-zinc-300 sm:max-w-[260px]">
              {banner.label}
            </span>
            {banner.totalChanged && banner.totalChanged > 0 ? (
              <span className="shrink-0 rounded bg-teal-500/15 px-1 py-0.5 text-[9px] text-teal-300">
                +{banner.totalChanged} px
              </span>
            ) : null}
          </div>
        ) : feed.length > 0 ? (
          <button
            type="button"
            onClick={() => setFeedOpen((v) => !v)}
            className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-300 hover:text-teal-200"
          >
            <Sparkles className="h-3 w-3 shrink-0 text-teal-400/80" aria-hidden />
            <span className="font-medium">
              {connectedAgents > 0 ? `${connectedAgents} AI live` : 'AI Live'}
            </span>
            <span className="text-zinc-500">·</span>
            <span className="text-zinc-400">
              {feed.length} {feed.length === 1 ? 'step' : 'steps'}
            </span>
          </button>
        ) : (
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-300">
            <Sparkles className="h-3 w-3 shrink-0 text-teal-400" aria-hidden />
            <span className="font-medium text-teal-200">
              {connectedAgents} AI {connectedAgents === 1 ? 'agent' : 'agents'} live
            </span>
          </div>
        )}

        {/* Quick Jump button when AI edited another clip/frame while auto-follow is OFF */}
        {banner?.offView && banner.clipId && !banner.busy && (
          <button
            type="button"
            onClick={() => {
              followCommandTarget({ clipId: banner.clipId, frameId: banner.frameId }, { force: true })
              if (banner.entryId) flashAiRegion(banner.entryId)
            }}
            title={`Jump to ${banner.clipName ?? 'clip'}${banner.frameNumber ? ` F${banner.frameNumber}` : ''}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-teal-500/40 bg-teal-500/15 px-1.5 py-0.5 font-mono text-[9px] font-medium text-teal-200 hover:bg-teal-500/25"
          >
            <Navigation className="h-2.5 w-2.5" />
            Jump
          </button>
        )}

        {/* Quick Hold-to-Compare Before/After on latest visual edit */}
        {canCompareFeatured && featuredEntry && !banner?.busy && (
          <button
            type="button"
            onPointerDown={() => startCompare(featuredEntry)}
            onPointerUp={stopCompare}
            onPointerLeave={stopCompare}
            onPointerCancel={stopCompare}
            onBlur={stopCompare}
            title="Hold to peek Before this AI edit"
            className={`inline-flex shrink-0 select-none items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9px] transition-colors ${
              comparePreview?.entryId === featuredEntry.id
                ? 'border-amber-400/70 bg-amber-500/25 text-amber-200'
                : 'border-zinc-700/80 bg-zinc-900/90 text-zinc-300 hover:border-teal-500/50 hover:text-teal-200'
            }`}
          >
            <Eye className="h-2.5 w-2.5" />
            <span className="hidden sm:inline">Before</span>
          </button>
        )}

        {/* Quick 1-click Undo for latest AI step */}
        {featuredUndoSteps !== null && !banner?.busy && (
          <button
            type="button"
            onClick={() => runUndoSteps(featuredUndoSteps)}
            title={
              featuredUndoSteps === 1
                ? `Undo "${featuredEntry?.label ?? 'AI edit'}"`
                : `Undo this AI edit and ${featuredUndoSteps - 1} newer step(s)`
            }
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-700/80 bg-zinc-900/90 px-1.5 py-0.5 font-mono text-[9px] text-zinc-200 hover:border-rose-400/50 hover:bg-rose-500/15 hover:text-rose-200"
          >
            <Undo2 className="h-2.5 w-2.5" />
            <span>{featuredUndoSteps > 1 ? `Undo ${featuredUndoSteps}` : 'Undo'}</span>
          </button>
        )}

        {/* Artist Priority Pause / Resume toggle */}
        <button
          type="button"
          onClick={() => setAiPaused(!paused)}
          title={
            paused
              ? 'Resume live AI edits'
              : 'Pause live AI edits (holds agent writes while you paint)'
          }
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9px] font-medium transition-colors ${
            paused
              ? 'border-amber-400/60 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30'
              : 'border-zinc-700/80 bg-zinc-900/80 text-zinc-400 hover:border-amber-400/50 hover:text-amber-200'
          }`}
        >
          {paused ? <Play className="h-2.5 w-2.5" /> : <Pause className="h-2.5 w-2.5" />}
          {paused ? <span>Resume</span> : null}
        </button>

        {/* Activity Feed toggle */}
        {feed.length > 0 && (
          <button
            type="button"
            onClick={() => setFeedOpen((v) => !v)}
            aria-expanded={feedOpen}
            title="Toggle Live AI Activity Feed"
            className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
          >
            <span>{feed.length}</span>
            {feedOpen ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
          </button>
        )}
      </div>

      {/* Collapsible Live AI Activity Feed */}
      {feedOpen && feed.length > 0 && (
        <div className="pointer-events-auto w-[332px] max-w-[92vw] overflow-hidden rounded-lg border border-zinc-800/90 bg-zinc-950/95 shadow-2xl backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-zinc-800/80 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5 font-mono text-[10px] font-semibold text-zinc-200">
              <Sparkles className="h-3 w-3 text-teal-400" />
              <span>AI Activity Feed</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setAiAutoFollow(!autoFollow)}
                title={
                  autoFollow
                    ? 'Auto-follow ON: camera follows AI edits across clips/frames'
                    : 'Auto-follow OFF: stay on your current clip/frame'
                }
                className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px] transition-colors ${
                  autoFollow
                    ? 'border-teal-500/45 bg-teal-500/15 text-teal-200'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {autoFollow ? <Navigation className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
                <span>Follow</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  clearAiActivityFeed()
                  setFeedOpen(false)
                }}
                title="Clear activity feed"
                className="inline-flex items-center rounded border border-zinc-800 bg-zinc-900 p-1 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              >
                <Trash2 className="h-2.5 w-2.5" />
              </button>
            </div>
          </div>

          <div className="max-h-60 divide-y divide-zinc-800/60 overflow-y-auto">
            {feed.map((entry) => {
              const undoSteps = getUndoStepsForAiEntry(entry, historyUndoDepth, loadEpoch)
              const hasCompare = entry.compare !== undefined && isEntryStillApplied(entry)
              const dotColor =
                entry.status === 'ok'
                  ? 'bg-teal-400'
                  : entry.status === 'paused' || entry.status === 'busy'
                    ? 'bg-amber-400'
                    : 'bg-rose-400'

              return (
                <div
                  key={entry.id}
                  className="flex items-start justify-between gap-2 px-2.5 py-1.5 transition-colors hover:bg-zinc-900/75"
                >
                  <button
                    type="button"
                    onClick={() => jumpToEntry(entry)}
                    className="min-w-0 flex-1 text-left"
                    title="Click to jump to this frame & highlight edited pixels"
                  >
                    <div className="flex items-center gap-1.5 font-mono text-[10px]">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
                      <span className="shrink-0 font-semibold text-zinc-200">
                        {entry.clientName}
                      </span>
                      {entry.clipName && (
                        <span className="truncate rounded bg-zinc-800/90 px-1 text-[9px] text-zinc-400">
                          {entry.clipName}
                          {entry.frameNumber ? `·F${entry.frameNumber}` : ''}
                        </span>
                      )}
                      {entry.totalChanged > 0 && (
                        <span className="shrink-0 text-[9px] text-teal-300/90">
                          +{entry.totalChanged}px
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-400">
                      {entry.label}
                    </p>
                    <p className="mt-0.5 font-mono text-[9px] text-zinc-600">
                      {entry.tool} · {formatEntryTime(entry.at)}
                    </p>
                  </button>

                  <div className="flex shrink-0 items-center gap-1 pt-0.5">
                    {hasCompare && (
                      <button
                        type="button"
                        onPointerDown={() => startCompare(entry)}
                        onPointerUp={stopCompare}
                        onPointerLeave={stopCompare}
                        onPointerCancel={stopCompare}
                        onBlur={stopCompare}
                        title="Hold to peek Before this edit"
                        className={`inline-flex select-none items-center rounded border p-1 transition-colors ${
                          comparePreview?.entryId === entry.id
                            ? 'border-amber-400/70 bg-amber-500/20 text-amber-200'
                            : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-teal-500/50 hover:text-teal-200'
                        }`}
                      >
                        <Eye className="h-3 w-3" />
                      </button>
                    )}
                    {undoSteps !== null && (
                      <button
                        type="button"
                        onClick={() => runUndoSteps(undoSteps)}
                        title={
                          undoSteps === 1
                            ? 'Undo this step'
                            : `Undo this step + ${undoSteps - 1} newer step(s)`
                        }
                        className="inline-flex items-center gap-0.5 rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-300 hover:border-rose-400/50 hover:bg-rose-500/15 hover:text-rose-200"
                      >
                        <Undo2 className="h-2.5 w-2.5" />
                        <span>{undoSteps > 1 ? undoSteps : 'Undo'}</span>
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
})
