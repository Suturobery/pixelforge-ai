'use client'

import { useEditor } from '@/lib/pixelforge/store'

/**
 * Forge 16 — the original PixelForge palette (16 colors), restored from the
 * reference screenshots: bright cyan anchor + retro game tones on dark.
 */
export const FORGE_16 = [
  '#56d7e8', // cyan (signature)
  '#262b3d', // ink navy
  '#8a3dcc', // violet
  '#c22f4a', // crimson
  '#e8763a', // orange
  '#e8c84a', // gold
  '#4a9e4a', // green
  '#2e7d6e', // teal deep
  '#2e3a6e', // navy
  '#3a6ae8', // blue
  '#6aa0e8', // sky
  '#7ad0e0', // ice cyan
  '#f0f2f5', // white
  '#9aa2b2', // steel
  '#c8ccd8', // silver
  '#4a5060', // slate
]

export function PalettePanel() {
  const color = useEditor((s) => s.color)
  const secondaryColor = useEditor((s) => s.secondaryColor)
  const setColor = useEditor((s) => s.setColor)
  const setSecondaryColor = useEditor((s) => s.setSecondaryColor)
  const swapColors = useEditor((s) => s.swapColors)

  const pick = (c: string) => {
    // First click sets primary; clicking the primary again promotes it to secondary
    if (c === color) setSecondaryColor(c)
    else setColor(c)
  }

  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-[#2e3340] bg-[#1c1f26] p-3 lg:w-24" data-testid="palette-panel">
      {/* fg / bg pair (click bg to swap) */}
      <div className="flex items-center justify-center gap-0.5">
        <button
          type="button"
          className="h-9 w-9 rounded-md border border-[#3a3f4e] shadow-inner"
          style={{ background: color }}
          onClick={() => document.getElementById('pf-fg-input')?.click()}
          aria-label={`Primary color ${color}`}
          title="Primary color"
        />
        <button
          type="button"
          className="-ml-2.5 mt-4 h-7 w-7 rounded-md border border-[#3a3f4e]"
          style={{ background: secondaryColor }}
          onClick={swapColors}
          aria-label={`Swap — secondary color ${secondaryColor}`}
          title="Click to swap colors"
        />
      </div>
      <input
        id="pf-fg-input"
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="h-0 w-0 opacity-0"
        aria-label="Custom primary color"
      />
      <input
        type="color"
        value={secondaryColor}
        onChange={(e) => setSecondaryColor(e.target.value)}
        className="h-0 w-0 opacity-0"
        aria-label="Custom secondary color"
      />

      {/* 2-column swatch grid */}
      <div className="grid grid-cols-2 gap-1.5" role="listbox" aria-label="Forge 16 palette">
        {FORGE_16.map((c) => (
          <button
            key={c}
            type="button"
            role="option"
            aria-selected={color === c}
            onClick={() => pick(c)}
            className={`h-7 w-full rounded-md border transition ${
              color === c
                ? 'border-cyan-300 ring-1 ring-cyan-300/60'
                : 'border-[#3a3f4e] hover:border-[#565d70]'
            }`}
            style={{ background: c }}
            aria-label={`Color ${c}`}
          />
        ))}
      </div>

      {/* footer: +/- + label (original toolbar furniture) */}
      <div className="mt-auto flex items-center justify-between border-t border-[#2e3340] pt-2">
        <button
          type="button"
          onClick={swapColors}
          className="rounded p-1 text-[#9aa2b2] transition hover:bg-[#262932] hover:text-cyan-300"
          aria-label="Swap primary and secondary colors"
          title="Swap colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M16 3h5v5" /><path d="M8 21H3v-5" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" />
          </svg>
        </button>
        <span className="font-mono text-[10px] text-[#9aa2b2]">Forge 16</span>
      </div>
    </div>
  )
}
