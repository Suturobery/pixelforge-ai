// PixelForge AI — first-run onboarding (3 steps, shown once per browser).
// Steps: draw → animate → export/ship. Dismiss stores a flag; the tour
// never returns unless localStorage is cleared.

'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pencil, Play, Package, X } from 'lucide-react'

const KEY = 'pixelforge:onboarded-v1'

const STEPS = [
  {
    icon: Pencil,
    title: '1 — Draw',
    body: 'Pick a tool from the left rail (B pencil, E eraser, F fill) and paint on the canvas. Layers live in the right panel.',
  },
  {
    icon: Play,
    title: '2 — Animate',
    body: 'Add frames in the bottom timeline, press Space to play. Onion skin + the motion panel help with walk cycles.',
  },
  {
    icon: Package,
    title: '3 — Ship it',
    body: 'Export a sprite sheet, PNG frames or GIF — game-engine ready. Your IDE agent (via MCP) and the Brain panel can do the heavy lifting for you.',
  },
]

export function OnboardingTour() {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (typeof window === 'undefined') return
    let seen = false
    try {
      seen = localStorage.getItem(KEY) === '1'
    } catch {
      seen = false
    }
    // intentional mount check — the tour can only open after hydration reads
    // localStorage; this is a one-shot UI gate, not a data effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!seen) setOpen(true)
  }, [])

  const finish = () => {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* storage unavailable — tour may reappear next session, acceptable */
    }
    setOpen(false)
  }

  if (!open || typeof document === 'undefined') return null

  const s = STEPS[step]
  const last = step === STEPS.length - 1

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to PixelForge AI"
        className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <p className="font-mono text-[11px] uppercase tracking-wider text-teal-300">Welcome to PixelForge AI</p>
          <button
            type="button"
            onClick={finish}
            aria-label="Skip tour"
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-4 flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40">
            <s.icon className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="font-mono text-sm text-zinc-100">{s.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">{s.body}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-1.5" aria-hidden>
            {STEPS.map((_, i) => (
              <span key={i} className={`h-1.5 w-6 rounded-full ${i === step ? 'bg-teal-400' : 'bg-zinc-700'}`} />
            ))}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={finish}
              className="rounded px-2.5 py-1.5 font-mono text-[11px] text-zinc-500 hover:text-zinc-300"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={() => (last ? finish() : setStep(step + 1))}
              className="rounded bg-teal-600 px-3.5 py-1.5 font-mono text-[11px] text-white hover:bg-teal-500"
            >
              {last ? 'Start drawing' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
