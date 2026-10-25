'use client'

import { useEffect, useRef } from 'react'
import type { MotionFramePlan, PixelGrid } from '@/lib/pixelforge/types'
import { gridToCanvas } from '@/lib/pixelforge/exporters'
import { useEditor } from '@/lib/pixelforge/store'

interface Props {
  frames: PixelGrid[]
  plans: MotionFramePlan[]
  overrides: (number | undefined)[]
}

function ThumbCanvas({ grid }: { grid: PixelGrid }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const scale = Math.max(2, Math.floor(72 / Math.max(grid.width, grid.height)))
    const c = gridToCanvas(grid, { scale, checker: true })
    const canvas = ref.current
    if (!canvas) return
    canvas.width = c.width
    canvas.height = c.height
    canvas.getContext('2d')?.drawImage(c, 0, 0)
  }, [grid])
  return <canvas ref={ref} style={{ imageRendering: 'pixelated' }} className="max-w-[72px]" aria-hidden />
}

export function FramesStrip({ frames, plans, overrides }: Props) {
  const currentStep = useEditor((s) => s.currentStep)
  const setPlaying = useEditor((s) => s.setPlaying)
  const setCurrentStep = useEditor((s) => s.setCurrentStep)

  const activeFrame = plans[currentStep] ? currentStep : 0

  return (
    <div className="rounded-lg border bg-[#1c1f26] p-3" data-testid="frames-strip">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-100">Generated frames</h3>
        <span className="text-[11px] text-zinc-600">{frames.length} frames · click to inspect</span>
      </div>
      <div className="flex max-h-48 gap-2 overflow-x-auto pb-1">
        {frames.map((f, i) => {
          const isActive = i === activeFrame
          return (
            <button
              key={i}
              type="button"
              data-testid={`frame-${i}`}
              onClick={() => {
                setPlaying(false)
                setCurrentStep(i)
              }}
              className={`flex shrink-0 flex-col items-center gap-1 rounded border p-1 ${
                isActive ? 'border-cyan-500 bg-emerald-950/40' : 'border-[#2e3340] hover:bg-[#15171c]'
              }`}
            >
              <ThumbCanvas grid={f} />
              <span className={`font-mono text-[10px] ${isActive ? 'text-emerald-400' : 'text-zinc-600'}`}>
                f{i + 1} · {overrides[i] ?? plans[i]?.duration ?? 0}ms
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
