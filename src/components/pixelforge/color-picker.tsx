// PixelForge AI — styled color editor, shown in a popover when the user clicks
// the primary/secondary chips in the palette column (replaces the native
// color-picker popup). Saturation/value square + hue slider + hex & RGB inputs.
// Fully controlled: the hex color prop is the single source of truth, so there
// is no effect-based state syncing.

'use client'

import { useState } from 'react'
import { hexToHsv, hsvToHex, hexToRgba, rgbToHex, type HSV } from '@/lib/pixelforge/color'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Plus } from 'lucide-react'

// tiny numeric readout for an RGB channel — text input with inputMode="numeric"
// (no native spinner arrows on any browser/OS; commits on blur/Enter)
function ChannelValue({
  value,
  onCommit,
  label,
}: {
  value: number
  onCommit: (n: number) => void
  label: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      spellCheck={false}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 3))}
      onBlur={() => {
        if (draft != null) {
          const n = parseInt(draft, 10)
          if (!Number.isNaN(n)) onCommit(Math.min(255, Math.max(0, n)))
          setDraft(null)
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      onFocus={(e) => (e.target as HTMLInputElement).select()}
      aria-label={`${label} channel (0–255)`}
      className="h-6 w-9 shrink-0 rounded border border-zinc-800 bg-zinc-900 text-center font-mono text-[11px] text-zinc-200 caret-teal-400 outline-none focus:border-teal-500/60"
    />
  )
}

interface ColorPickerContentProps {
  color: string
  onChange: (hex: string) => void
  onAddToPalette?: () => void
  alreadyInPalette?: boolean
}

export function ColorPickerContent({
  color,
  onChange,
  onAddToPalette,
  alreadyInPalette,
}: ColorPickerContentProps) {
  const hsv = hexToHsv(color)

  const update = (next: HSV) => onChange(hsvToHex(next.h, next.s, next.v))

  // ------------------------------------------------------ saturation/value
  const applySV = (clientX: number, clientY: number, el: HTMLDivElement | null) => {
    if (!el) return
    const r = el.getBoundingClientRect()
    const s = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    const v = 1 - Math.min(1, Math.max(0, (clientY - r.top) / r.height))
    update({ ...hsv, s, v })
  }

  // ------------------------------------------------------------------ hue
  const applyHue = (clientX: number, el: HTMLDivElement | null) => {
    if (!el) return
    const r = el.getBoundingClientRect()
    const h = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * 360
    update({ ...hsv, h })
  }

  // ------------------------------------------------------------- hex input
  // draft holds the text while the user types; null = show the canonical color
  const [draft, setDraft] = useState<string | null>(null)
  const commitHex = () => {
    if (draft != null) {
      const t = draft.trim().replace(/^#/, '')
      if (/^([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(t)) {
        update(hexToHsv(`#${t}`))
      }
      setDraft(null)
    }
  }

  const [r, g, b] = hexToRgba(color)
  const channels = [r, g, b]
  const setChannel = (idx: 0 | 1 | 2, value: string) => {
    const n = Math.min(255, Math.max(0, parseInt(value, 10) || 0))
    const next = [r, g, b]
    next[idx] = n
    update(hexToHsv(rgbToHex(next[0], next[1], next[2])))
  }

  // ------------------------------------------------------- rgb channel rows
  // Each row is a gradient slider (channel → 0…255 while the other two are
  // held) + a typed readout. Replaced the old number inputs entirely.
  const applyChannel = (idx: 0 | 1 | 2, clientX: number, el: HTMLDivElement | null) => {
    if (!el) return
    const rect = el.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    setChannel(idx, String(Math.round(t * 255)))
  }

  const CH = [
    { label: 'R', dot: 'text-red-400', track: `linear-gradient(to right, rgb(0,${g},${b}), rgb(255,${g},${b}))` },
    { label: 'G', dot: 'text-green-400', track: `linear-gradient(to right, rgb(${r},0,${b}), rgb(${r},255,${b}))` },
    { label: 'B', dot: 'text-sky-400', track: `linear-gradient(to right, rgb(${r},${g},0), rgb(${r},${g},255))` },
  ] as const

  return (
    <div className="space-y-2.5" role="group" aria-label="Color editor">
      {/* saturation / value square */}
      <div
        className="relative h-36 w-full cursor-crosshair touch-none rounded-md border border-zinc-800"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          applySV(e.clientX, e.clientY, e.currentTarget)
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) applySV(e.clientX, e.clientY, e.currentTarget)
        }}
        aria-label="Saturation and brightness"
      >
        <div
          className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: color }}
        />
      </div>

      {/* hue slider */}
      <div
        className="relative h-3.5 w-full cursor-pointer touch-none rounded-full border border-zinc-800"
        style={{
          background:
            'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          applyHue(e.clientX, e.currentTarget)
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) applyHue(e.clientX, e.currentTarget)
        }}
        role="slider"
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
      >
        <div
          className="pointer-events-none absolute top-1/2 h-[18px] w-2 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        />
      </div>

      {/* preview + hex */}
      <div className="flex items-center gap-2">
        <div
          className="h-8 w-8 shrink-0 rounded-md border border-zinc-700 shadow-inner"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <Input
          value={draft ?? color}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="h-8 flex-1 border-zinc-800 bg-zinc-900 font-mono text-xs uppercase"
          aria-label="Hex color"
          spellCheck={false}
        />
      </div>

      {/* rgb channel sliders (redesigned — no native number inputs) */}
      <div className="space-y-1.5" role="group" aria-label="RGB channels">
        {CH.map((ch, i) => (
          <div key={ch.label} className="flex items-center gap-1.5">
            <span className={`w-3 shrink-0 text-center font-mono text-[10px] font-bold ${ch.dot}`} aria-hidden>
              {ch.label}
            </span>
            <div
              className="relative h-4 flex-1 cursor-pointer touch-none"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                applyChannel(i as 0 | 1 | 2, e.clientX, e.currentTarget)
              }}
              onPointerMove={(e) => {
                if (e.buttons & 1) applyChannel(i as 0 | 1 | 2, e.clientX, e.currentTarget)
              }}
              role="slider"
              aria-label={`${ch.label} channel`}
              aria-valuemin={0}
              aria-valuemax={255}
              aria-valuenow={channels[i]}
            >
              <div className="absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full border border-zinc-800" style={{ background: ch.track }} />
              <div
                className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                style={{ left: `${(channels[i] / 255) * 100}%`, backgroundColor: ['rgb(239,68,68)', 'rgb(74,222,128)', 'rgb(56,189,248)'][i] }}
              />
            </div>
            <ChannelValue value={channels[i]} onCommit={(n) => setChannel(i as 0 | 1 | 2, String(n))} label={ch.label} />
          </div>
        ))}
      </div>

      {onAddToPalette && (
        <Button
          variant="secondary"
          className="h-7 w-full bg-teal-600/15 font-mono text-[11px] text-teal-300 hover:bg-teal-600/25"
          onClick={onAddToPalette}
          disabled={alreadyInPalette}
        >
          <Plus className="mr-1 h-3 w-3" />
          {alreadyInPalette ? 'Already in palette' : 'Add to palette'}
        </Button>
      )}
    </div>
  )
}
