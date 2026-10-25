// PixelForge AI — themed numeric stepper: [−] value [+].
// Replaces every native <input type="number"> (whose white up/down spinner
// arrows cannot be fully hidden on all browsers/OSes) with a text input using
// inputMode="numeric" — zero native arrows anywhere, numeric keypad on touch,
// ArrowUp/ArrowDown still step the value. Clamped, typed, and commit-on-blur.

'use client'

import { useState } from 'react'
import { Minus, Plus } from 'lucide-react'

interface StepperInputProps {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  /** unit shown after the number inside the field (e.g. "fps") */
  suffix?: string
  ariaLabel: string
  size?: 'sm' | 'md'
  className?: string
  disabled?: boolean
}

export function StepperInput({
  value,
  onChange,
  min = 0,
  max = 999,
  step = 1,
  suffix,
  ariaLabel,
  size = 'md',
  className = '',
  disabled = false,
}: StepperInputProps) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  // draft holds the text while typing; null = display the canonical value
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    if (draft != null) {
      const n = parseInt(draft, 10)
      if (!Number.isNaN(n)) onChange(clamp(n))
      setDraft(null)
    }
  }

  const stepBy = (dir: 1 | -1) => {
    const n = draft != null ? (parseInt(draft, 10) || value) : value
    onChange(clamp(n + dir * step))
    setDraft(null)
  }

  const h = size === 'sm' ? 'h-6' : 'h-8'
  const btn = size === 'sm' ? 'h-6 w-6' : 'h-8 w-7'
  const text = size === 'sm' ? 'text-[11px]' : 'text-xs'

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`inline-flex items-stretch overflow-hidden rounded-md border border-zinc-800 bg-zinc-900 transition-shadow focus-within:ring-1 focus-within:ring-teal-500/60 ${disabled ? 'opacity-50' : ''} ${className}`}
    >
      <button
        type="button"
        className={`flex ${btn} shrink-0 items-center justify-center border-r border-zinc-800 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-teal-300 disabled:cursor-not-allowed disabled:opacity-40`}
        onClick={() => stepBy(-1)}
        disabled={disabled || value <= min}
        aria-label={`Decrease ${ariaLabel}`}
      >
        <Minus className="h-3 w-3" />
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        spellCheck={false}
        value={draft ?? `${value}${suffix ? ` ${suffix}` : ''}`}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            stepBy(1)
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            stepBy(-1)
          }
        }}
        onFocus={(e) => (e.target as HTMLInputElement).select()}
        disabled={disabled}
        aria-label={ariaLabel}
        className={`min-w-0 flex-1 bg-transparent ${h} ${text} px-1.5 text-center font-mono text-zinc-100 caret-teal-400 outline-none placeholder:text-zinc-400`}
      />
      <button
        type="button"
        className={`flex ${btn} shrink-0 items-center justify-center border-l border-zinc-800 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-teal-300 disabled:cursor-not-allowed disabled:opacity-40`}
        onClick={() => stepBy(1)}
        disabled={disabled || value >= max}
        aria-label={`Increase ${ariaLabel}`}
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  )
}
