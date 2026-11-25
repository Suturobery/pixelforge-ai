'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  analyzePixelCraft,
  buildPlaybackCycle,
  composeFrameRgba,
  effectiveFrameMs,
  PlaybackClock,
  validateStyleCandidate,
} from '@pixelforge/core'
import { Check, Loader2, Pause, Play, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { copyText } from '@/lib/pixelforge/desktop-bridge'
import { currentProjectIdentity, mcpCtrl } from '@/lib/pixelforge/mcp-bridge'
import { useEditor } from '@/lib/pixelforge/store'
import { buildArtRevision, REVIEW_FOCUS, type ReviewFocus } from '@/lib/pixelforge/art-review-contract'

export interface ArtworkReviewTask {
  id: string
  title: string
  status: string
  verified: boolean | null
  targetProjectKey?: string | null
  reviewStatus?: 'approved' | 'needs_changes' | null
  reviewClipId?: string | null
  reviewFrameIndex?: number | null
  reviewStateHash?: string | null
}

function ProofCanvas({ rgba, width, height, zoom, label }: {
  rgba: Uint8ClampedArray
  width: number
  height: number
  zoom: number
  label: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0)
  }, [rgba, width, height])
  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      role="img"
      aria-label={label}
      className="block shrink-0"
      style={{ width: width * zoom, height: height * zoom, imageRendering: 'pixelated' }}
    />
  )
}

const checkerStyle = {
  backgroundColor: '#18181b',
  backgroundImage: 'conic-gradient(#27272a 25%, transparent 0 50%, #27272a 0 75%, transparent 0)',
  backgroundSize: '16px 16px',
}

export function ArtworkReview({ task, currentStateHash, onClose, onRefresh }: {
  task: ArtworkReviewTask
  currentStateHash: string | null
  onClose: () => void
  onRefresh: () => void
}) {
  const project = useEditor((state) => state.project)
  const activeClipId = useEditor((state) => state.activeClipId)
  const activeFrameIndex = useEditor((state) => state.activeFrameIndex)
  const [clipId, setClipId] = useState(task.reviewClipId ?? activeClipId)
  const [frameIndex, setFrameIndex] = useState(task.reviewFrameIndex ?? activeFrameIndex)
  const [zoom, setZoom] = useState(4)
  const [playing, setPlaying] = useState(false)
  const [focus, setFocus] = useState<ReviewFocus[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'approve' | 'revise' | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const projectMatches = Boolean(task.targetProjectKey && task.targetProjectKey === currentProjectIdentity().key)
  const clip = project.clips.find((item) => item.id === clipId) ?? project.clips[0]
  const selectedFrameIndex = clip ? Math.min(Math.max(0, frameIndex), clip.frames.length - 1) : 0
  const frame = clip?.frames[selectedFrameIndex]

  useEffect(() => {
    if (!playing || !clip || clip.frames.length < 2) return
    const clock = new PlaybackClock(buildPlaybackCycle({ ...clip, loop: true }))
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const result = clock.tick(Math.min(now - last, 1000))
      last = now
      if (result.changed) setFrameIndex(result.frame)
      raf = requestAnimationFrame(tick)
    }
    setFrameIndex(clock.currentFrame())
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, clip])

  const rgba = useMemo(
    () => clip && frame ? composeFrameRgba(project, clip, frame) : null,
    [project, clip, frame],
  )
  const craft = useMemo(() => rgba && !playing ? analyzePixelCraft({
    buffer: rgba,
    width: project.width,
    height: project.height,
    lighting: project.settings.styleProfile?.lighting ?? 'top-left',
  }) : null, [rgba, playing, project.width, project.height, project.settings.styleProfile?.lighting])
  const styleWarnings = useMemo(() => rgba && !playing ? validateStyleCandidate({
    buffer: rgba,
    width: project.width,
    height: project.height,
    targetWidth: project.width,
    targetHeight: project.height,
    palette: [...project.palette],
    profile: project.settings.styleProfile ?? undefined,
  }).filter((check) => check.status === 'warning') : [], [rgba, playing, project])
  const reviewOutdated = task.reviewStatus === 'approved' && Boolean(task.reviewStateHash && currentStateHash && task.reviewStateHash !== currentStateHash)

  const toggleFocus = (item: ReviewFocus) => {
    setFocus((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item])
    setStatus(null)
    setPendingKey(null)
  }

  const approve = async () => {
    if (!projectMatches || !clip || busy) return
    setBusy('approve')
    setStatus(null)
    try {
      const result = await mcpCtrl({ kind: 'brain-review', id: task.id, verdict: 'approved', clipId: clip.id, frameIndex: selectedFrameIndex })
      setStatus(result.ok ? 'Approved for this project state.' : result.error?.message ?? 'Could not save approval.')
      if (result.ok) onRefresh()
    } catch {
      setStatus('Could not save approval. Check the MCP connection and retry.')
    } finally {
      setBusy(null)
    }
  }

  const requestRevision = async () => {
    if (!projectMatches || !clip || busy) return
    const revision = buildArtRevision({
      taskId: task.id,
      taskTitle: task.title,
      clipId: clip.id,
      clipName: clip.name,
      frameIndex: selectedFrameIndex,
      focus,
      note,
      craftFindings: craft?.defects.filter((defect) => defect.severity === 'warning').map((defect) => defect.message) ?? [],
      styleFindings: styleWarnings.map((check) => check.detail),
      animated: clip.frames.length > 1,
    })
    if (!revision) {
      setStatus('Select a focus or write what you want changed.')
      return
    }
    setBusy('revise')
    setStatus(null)
    const requestKey = pendingKey ?? crypto.randomUUID()
    setPendingKey(requestKey)
    try {
      const pushed = await mcpCtrl<{ tasks: Array<{ id: string }> }>({
        kind: 'brain-push',
        tasks: [{ ...revision, idempotencyKey: requestKey, targetProject: currentProjectIdentity() }],
      })
      if (pushed.ok) {
        const marked = await mcpCtrl({ kind: 'brain-review', id: task.id, verdict: 'needs_changes', clipId: clip.id, frameIndex: selectedFrameIndex })
        setStatus(marked.ok
          ? 'Revision queued. Your agent will edit this project when it claims the task.'
          : 'Revision queued, but the original task’s review badge could not be updated.')
        setPendingKey(null)
        onRefresh()
      } else if (pushed.error?.code === 'not_connected') {
        try {
          await copyText(revision.detail)
          setStatus('MCP is offline. Revision instructions copied for your IDE agent; nothing was queued.')
        } catch {
          setStatus('MCP is offline and clipboard copy failed. Reconnect the agent before requesting a revision.')
        }
        setPendingKey(null)
      } else if (pushed.error?.code && pushed.error.code !== 'timeout' && pushed.error.code !== 'unknown') {
        setStatus(pushed.error?.message ?? 'The task board rejected the revision; nothing was queued.')
        setPendingKey(null)
      } else {
        setStatus('Delivery is uncertain. Check the task board before retrying; a retry uses the same request key.')
      }
    } catch {
      setStatus('Delivery is uncertain. Check the task board before retrying; a retry uses the same request key.')
    } finally {
      setBusy(null)
    }
  }

  if (!projectMatches || !clip || !frame || !rgba) {
    return (
      <div className="mt-2 rounded border border-amber-800/60 bg-amber-950/20 p-2 text-[10px] text-amber-200">
        Open the task’s target project to review its artwork.
        <button type="button" onClick={onClose} className="ml-2 underline">Close</button>
      </div>
    )
  }

  return (
    <section className="mt-2 rounded-lg border border-teal-700/40 bg-zinc-950 p-2.5" aria-label="Artwork review">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-teal-400">Artwork proof</p>
          <h3 className="mt-0.5 text-xs font-medium text-zinc-100">{task.title}</h3>
          <p className="text-[9px] text-zinc-500">Live project view · choose the clip the agent edited</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close artwork review" className="rounded p-1 text-zinc-500 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-400">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {task.verified === false && <p className="mt-2 rounded border border-amber-800/50 px-2 py-1 text-[9px] text-amber-300">The task finished without detected document changes. Inspect the canvas before approving.</p>}
      {reviewOutdated && <p className="mt-2 rounded border border-amber-800/50 px-2 py-1 text-[9px] text-amber-300">The project changed since approval. Review the current artwork again.</p>}

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="min-w-[120px] flex-1 text-[9px] text-zinc-400">Clip
          <select value={clip.id} onChange={(event) => { setClipId(event.target.value); setFrameIndex(0); setPlaying(false); setStatus(null) }} aria-label="Artwork clip" className="mt-0.5 h-7 w-full rounded border border-zinc-700 bg-zinc-900 px-1.5 text-[10px] text-zinc-100">
            {project.clips.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {clip.frames.length > 1 && (
          <Button size="sm" variant="outline" className="h-7 border-zinc-700 text-[10px]" onClick={() => setPlaying((value) => !value)} aria-label={playing ? 'Pause artwork animation' : 'Play artwork animation'}>
            {playing ? <Pause className="mr-1 h-3 w-3" /> : <Play className="mr-1 h-3 w-3" />}
            {playing ? 'Pause' : 'Play'}
          </Button>
        )}
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(110px,1fr)_minmax(0,2fr)]">
        <div className="rounded border border-zinc-800 p-2">
          <p className="mb-1 font-mono text-[9px] text-zinc-400">True size · 1×</p>
          <div className="flex min-h-20 items-center justify-center overflow-auto rounded border border-zinc-800 p-1" style={checkerStyle}>
            <ProofCanvas rgba={rgba} width={project.width} height={project.height} zoom={1} label={`${clip.name} frame ${selectedFrameIndex + 1} at native size`} />
          </div>
        </div>
        <div className="min-w-0 rounded border border-zinc-800 p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="font-mono text-[9px] text-zinc-400">Pixel inspection · {zoom}×</p>
            <div className="flex gap-0.5" aria-label="Inspection zoom">
              {[2, 4, 8].map((level) => <button key={level} type="button" onClick={() => setZoom(level)} aria-pressed={zoom === level} className={`rounded px-1 font-mono text-[9px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-400 ${zoom === level ? 'bg-teal-900/60 text-teal-200' : 'text-zinc-500 hover:text-zinc-200'}`}>{level}×</button>)}
            </div>
          </div>
          <div className="flex max-h-52 min-h-20 items-start overflow-auto rounded border border-zinc-800 p-1" style={checkerStyle}>
            <ProofCanvas rgba={rgba} width={project.width} height={project.height} zoom={zoom} label={`${clip.name} frame ${selectedFrameIndex + 1} enlarged ${zoom} times`} />
          </div>
        </div>
      </div>

      <div className="pixelforge-scroll mt-1.5 flex gap-1 overflow-x-auto pb-1" aria-label="Animation frames">
        {clip.frames.map((item, index) => <button key={item.id} type="button" onClick={() => { setPlaying(false); setFrameIndex(index) }} aria-current={selectedFrameIndex === index ? 'true' : undefined} className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-400 ${selectedFrameIndex === index ? 'border-teal-500/70 bg-teal-950/40 text-teal-200' : 'border-zinc-800 text-zinc-500 hover:text-zinc-200'}`}>F{index + 1} <span className="text-zinc-500">{effectiveFrameMs(item, clip.fps)}ms</span></button>)}
      </div>

      <div className="mt-1.5 rounded border border-zinc-800 bg-zinc-900/40 p-2">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[9px] uppercase tracking-wide text-zinc-400">Technical checks · frame {selectedFrameIndex + 1}</p>
          {craft && <span className="font-mono text-[10px] text-teal-300">{craft.score}/100</span>}
        </div>
        {playing ? <p className="mt-1 text-[9px] text-zinc-500">Pause playback to inspect this frame.</p> : (
          <>
            <p className="mt-1 text-[9px] text-zinc-400">{craft?.summary}</p>
            {[...(craft?.defects.filter((item) => item.severity === 'warning').slice(0, 3) ?? []).map((item) => `${item.message}${item.locations[0] ? ` (${item.locations[0].x}, ${item.locations[0].y})` : ''}`), ...styleWarnings.slice(0, 2).map((item) => item.detail)].map((item, index) => <p key={`${index}-${item}`} className="mt-0.5 text-[9px] text-amber-300/90">• {item}</p>)}
            <p className="mt-1 text-[8px] text-zinc-600">Heuristic pixel checks cannot judge whether the art fits your game.</p>
          </>
        )}
      </div>

      <div className="mt-2 border-t border-zinc-800 pt-2">
        <p className="font-mono text-[9px] uppercase tracking-wide text-zinc-400">What should change?</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {REVIEW_FOCUS.map((item) => <button key={item} type="button" aria-pressed={focus.includes(item)} onClick={() => toggleFocus(item)} className={`rounded border px-1.5 py-0.5 text-[9px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-400 ${focus.includes(item) ? 'border-teal-600 bg-teal-950/50 text-teal-200' : 'border-zinc-700 text-zinc-400 hover:text-zinc-100'}`}>{item}</button>)}
        </div>
        <Textarea value={note} onChange={(event) => { setNote(event.target.value.slice(0, 600)); setStatus(null); setPendingKey(null) }} maxLength={600} aria-label="Artwork revision feedback" placeholder="Example: make the sword silhouette clearer at 1×; keep the pose and palette." className="mt-1.5 min-h-16 resize-y border-zinc-700 bg-zinc-900 text-[10px]" />
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Button size="sm" className="h-7 text-[10px]" onClick={() => void requestRevision()} disabled={busy !== null || (!note.trim() && focus.length === 0)}>
            {busy === 'revise' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RotateCcw className="mr-1 h-3 w-3" />}Request revision
          </Button>
          <Button size="sm" variant="outline" className="h-7 border-zinc-700 text-[10px]" onClick={() => void approve()} disabled={busy !== null}>
            {busy === 'approve' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}Approve frame
          </Button>
        </div>
        {status && <p role="status" className="mt-1.5 text-[9px] text-zinc-300">{status}</p>}
      </div>
    </section>
  )
}
