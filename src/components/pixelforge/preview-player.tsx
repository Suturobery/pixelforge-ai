'use client'

import { useEffect, useRef } from 'react'
import type { MotionFramePlan, PixelGrid } from '@/lib/pixelforge/types'
import { buildPlaybackSequence, cycleTime, effectiveDurations, type PlaybackMode } from '@/lib/pixelforge/playback'
import { gridToCanvas } from '@/lib/pixelforge/exporters'
import { useEditor } from '@/lib/pixelforge/store'

interface Props {
  plans: MotionFramePlan[]
  frames: PixelGrid[]
  overrides: (number | undefined)[]
}

export function PreviewPlayer({ plans, frames, overrides }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const stepRef = useRef(0)
  const lastTs = useRef<number | null>(null)

  const mode = useEditor((s) => s.playbackMode)
  const playing = useEditor((s) => s.playing)
  const currentStep = useEditor((s) => s.currentStep)
  const setPlaying = useEditor((s) => s.setPlaying)
  const setCurrentStep = useEditor((s) => s.setCurrentStep)
  const presetVersion = useEditor((s) => s.presetVersion)
  const presetId = useEditor((s) => s.presetId)

  const durations = effectiveDurations(plans, overrides)
  const seq = buildPlaybackSequence(
    plans.map((p, i) => ({ ...p, duration: durations[i] })),
    mode
  )
  const total = cycleTime(seq)

  // reset step when sequence shape changes
  useEffect(() => {
    stepRef.current = Math.min(currentStep, Math.max(0, seq.length - 1))
  }, [seq.length, currentStep])

  useEffect(() => {
    let cancelled = false
    const render = (stepIdx: number) => {
      const canvas = canvasRef.current
      if (!canvas || frames.length === 0) return
      const step = seq[Math.min(stepIdx, seq.length - 1)]
      if (!step) return
      const frame = frames[Math.min(step.frame, frames.length - 1)]
      const scale = Math.max(3, Math.floor(240 / Math.max(frame.width, frame.height)))
      const c = gridToCanvas(frame, { scale, checker: true })
      canvas.width = c.width
      canvas.height = c.height
      const ctx = canvas.getContext('2d')
      ctx?.drawImage(c, 0, 0)
    }
    render(playing ? stepRef.current : currentStep)
    if (!playing) return
    lastTs.current = null
    const tick = (ts: number) => {
      if (cancelled) return
      if (lastTs.current === null) lastTs.current = ts
      const dt = ts - lastTs.current
      const step = seq[Math.min(stepRef.current, seq.length - 1)]
      if (step && dt >= step.duration) {
        lastTs.current = ts
        stepRef.current = (stepRef.current + 1) % seq.length
        setCurrentStep(stepRef.current)
      }
      render(stepRef.current)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
    }
  }, [playing, seq, frames])

  const scrub = (v: number) => {
    setPlaying(false)
    setCurrentStep(v)
    stepRef.current = v
  }

  return (
    <div className="rounded-lg border bg-stone-50 p-4" data-testid="preview-player">
      <div className="flex flex-col items-center gap-3">
        <canvas
          ref={canvasRef}
          data-testid="preview-canvas"
          style={{ imageRendering: 'pixelated' }}
          className="max-w-full"
          aria-label="Animation preview"
        />
        <div className="flex w-full flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            data-testid="play-btn"
            onClick={() => setPlaying(!playing)}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          {(['loop', 'once', 'reverse', 'pingpong'] as PlaybackMode[]).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`mode-${m}`}
              onClick={() => useEditor.getState().setPlaybackMode(m)}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium capitalize ${
                mode === m ? 'bg-stone-800 text-white' : 'bg-white text-stone-700 hover:bg-stone-100'
              } border`}
            >
              {m}
            </button>
          ))}
        </div>
        <input
          type="range"
          data-testid="scrub"
          min={0}
          max={Math.max(0, seq.length - 1)}
          value={Math.min(currentStep, seq.length - 1)}
          onChange={(e) => scrub(Number(e.target.value))}
          className="w-full accent-emerald-600"
          aria-label="Scrub frames"
        />
        <div className="text-xs text-stone-500" data-testid="timing-readout">
          step {Math.min(currentStep, seq.length - 1) + 1}/{seq.length} · frame {seq[Math.min(currentStep, seq.length - 1)] ? seq[Math.min(currentStep, seq.length - 1)].frame + 1 : 0}/{frames.length} · cycle {total}ms ({(1000 / Math.max(1, total / seq.length)).toFixed(1)} fps avg) · {presetId} {presetVersion}
        </div>
      </div>
    </div>
  )
}
