'use client'

import type { PixelGrid, PresetId } from '@/lib/pixelforge/types'
import type { PresetVersion } from '@/lib/pixelforge/presets'
import { exportFramePng, exportGif, exportSheetPng } from '@/lib/pixelforge/exporters'

interface Props {
  frames: PixelGrid[]
  durations: number[]
  presetId: PresetId
  version: PresetVersion
}

export function SheetExportButtons({ frames, durations, presetId, version }: Props) {
  const base = `${presetId}-${version}`
  return (
    <section className="rounded-lg border bg-white p-4">
      <h3 className="mb-2 text-sm font-semibold text-stone-800">Export</h3>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="export-sheet"
          onClick={() => exportSheetPng(frames, `${base}-sheet.png`, { scale: 4, checker: true })}
          className="rounded-md bg-stone-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700"
        >
          Sprite sheet PNG ×4
        </button>
        <button
          type="button"
          data-testid="export-gif"
          onClick={() => exportGif(frames, durations, `${base}.gif`, { scale: 6 })}
          className="rounded-md bg-stone-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700"
        >
          Animated GIF
        </button>
        <button
          type="button"
          data-testid="export-frame"
          onClick={() => exportFramePng(frames[0] as PixelGrid, `${base}-frame1.png`, { scale: 4, checker: false })}
          disabled={frames.length === 0}
          className="rounded-md border px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
        >
          Current PNG ×4
        </button>
      </div>
      <p className="mt-2 text-[11px] text-stone-400">
        GIF timing uses the per-frame durations above. Sheet frames are laid out left→right in playback order.
      </p>
    </section>
  )
}
