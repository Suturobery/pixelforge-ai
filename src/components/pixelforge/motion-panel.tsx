'use client'

import type { MotionFramePlan, MotionQAReport, PixelGrid, PresetId } from '@/lib/pixelforge/types'
import { PRESET_ORDER, getPresetSet, DEFAULT_PARAMS } from '@/lib/pixelforge/presets'
import type { PresetVersion } from '@/lib/pixelforge/presets'
import { classifyReport } from '@/lib/pixelforge/qa'
import { useEditor } from '@/lib/pixelforge/store'
import { SheetExportButtons } from './export-bar'

const RATING_STYLES: Record<string, string> = {
  good: 'bg-emerald-950/50 text-emerald-300 border-emerald-800',
  'needs-adjustment': 'bg-amber-900/30 text-amber-300 border-amber-700/60',
  poor: 'bg-rose-100 text-rose-800 border-rose-300',
}

interface Props {
  frames: PixelGrid[]
  plans: MotionFramePlan[]
  qa: MotionQAReport | null
}

export function MotionPanel({ frames, plans, qa }: Props) {
  const presetId = useEditor((s) => s.presetId)
  const presetVersion = useEditor((s) => s.presetVersion)
  const params = useEditor((s) => s.params)
  const setPreset = useEditor((s) => s.setPreset)
  const setPresetVersion = useEditor((s) => s.setPresetVersion)
  const setParams = useEditor((s) => s.setParams)
  const resetParams = useEditor((s) => s.resetParams)
  const setDuration = useEditor((s) => s.setDuration)
  const resetDurations = useEditor((s) => s.resetDurations)
  const overrides = useEditor((s) => s.durationOverrides)

  const set = getPresetSet(presetVersion)
  const preset = set[presetId]
  const rating = qa ? classifyReport(qa) : null

  const effectiveDurations = plans.map((p, i) => overrides[i] ?? p.duration)

  return (
    <div className="flex flex-col gap-4" data-testid="motion-panel">
      {/* Preset picker */}
      <section className="rounded-lg border bg-[#1c1f26] p-4">
        <h3 className="mb-2 text-sm font-semibold text-zinc-100">Motion preset</h3>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {PRESET_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`preset-${id}`}
              onClick={() => setPreset(id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize ${
                presetId === id ? 'bg-cyan-500 text-white' : 'bg-[#262932] text-zinc-300 hover:bg-[#31343e]'
              }`}
            >
              {id}
            </button>
          ))}
        </div>
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className="text-zinc-500">Formula</span>
          {(['v2', 'v1'] as PresetVersion[]).map((v) => (
            <button
              key={v}
              type="button"
              data-testid={`version-${v}`}
              onClick={() => setPresetVersion(v)}
              className={`rounded px-2 py-1 font-mono ${
                presetVersion === v ? 'bg-[#262932] text-cyan-300 ring-1 ring-cyan-500/40' : 'bg-[#262932] text-zinc-400 hover:bg-[#31343e]'
              }`}
              title={v === 'v1' ? 'Legacy baseline (pre-audit) — for before/after comparison' : 'Improved formulas (post-audit)'}
            >
              {v === 'v2' ? 'v2 improved' : 'v1 legacy'}
            </button>
          ))}
          <span className={`ml-auto rounded border px-1.5 py-0.5 text-[11px] font-medium ${preset.loops ? 'border-[#3a3f4e] bg-[#15171c] text-zinc-400' : 'border-sky-300 bg-sky-50 text-sky-700'}`}>
            {preset.loops ? 'loops' : 'one-shot'}
          </span>
        </div>
        <p className="text-xs text-zinc-500">{preset.description}</p>
      </section>

      {/* Parameters */}
      <section className="rounded-lg border bg-[#1c1f26] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">Parameters</h3>
          <button
            type="button"
            data-testid="reset-params"
            onClick={resetParams}
            className="text-xs text-zinc-500 underline hover:text-zinc-100"
          >
            Reset defaults
          </button>
        </div>
        <label className="mb-2 block text-xs font-medium text-zinc-400">
          Amplitude ×{params.amplitude.toFixed(2)}
          <input
            type="range"
            data-testid="amplitude"
            min={0.5}
            max={2}
            step={0.25}
            value={params.amplitude}
            onChange={(e) => setParams({ amplitude: Number(e.target.value) })}
            className="mt-1 w-full accent-emerald-600"
          />
        </label>
        <label className="mb-2 block text-xs font-medium text-zinc-400">
          Speed ×{params.speed.toFixed(2)} <span className="text-zinc-600">(higher = slower)</span>
          <input
            type="range"
            data-testid="speed"
            min={0.5}
            max={2}
            step={0.25}
            value={params.speed}
            onChange={(e) => setParams({ speed: Number(e.target.value) })}
            className="mt-1 w-full accent-emerald-600"
          />
        </label>
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-zinc-400">Facing</span>
          {(['side', 'front'] as const).map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`facing-${f}`}
              onClick={() => setParams({ facing: f })}
              className={`rounded px-2 py-1 capitalize ${
                params.facing === f ? 'bg-[#262932] text-cyan-300 ring-1 ring-cyan-500/40' : 'bg-[#262932] text-zinc-400 hover:bg-[#31343e]'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </section>

      {/* Per-frame durations */}
      <section className="rounded-lg border bg-[#1c1f26] p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">Frame timing (ms)</h3>
          <button
            type="button"
            data-testid="reset-durations"
            onClick={resetDurations}
            className="text-xs text-zinc-500 underline hover:text-zinc-100"
          >
            Reset
          </button>
        </div>
        <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto pr-1">
          {effectiveDurations.map((d, i) => (
            <label key={i} className="flex flex-col items-center gap-1 text-[10px] text-zinc-500">
              <span className="font-mono">f{i + 1}</span>
              <input
                type="number"
                data-testid={`duration-${i}`}
                min={20}
                step={10}
                value={d}
                onChange={(e) => setDuration(i, Math.max(20, Number(e.target.value) || 20))}
                className="w-16 rounded border border-[#3a3f4e] px-1.5 py-1 text-center text-xs"
              />
            </label>
          ))}
        </div>
      </section>

      {/* QA report */}
      <section className="rounded-lg border bg-[#1c1f26] p-4" data-testid="qa-panel">
        <h3 className="mb-2 text-sm font-semibold text-zinc-100">Motion QA</h3>
        {rating && qa ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span
                data-testid="qa-rating"
                className={`rounded border px-2 py-0.5 text-xs font-semibold uppercase ${RATING_STYLES[rating.rating]}`}
              >
                {rating.rating.replace('-', ' ')}
              </span>
              <span className="text-xs text-zinc-600">heuristic — review frames before exporting</span>
            </div>
            {qa.issues.length === 0 ? (
              <p className="text-xs text-emerald-400" data-testid="qa-clean">No warnings on this preset.</p>
            ) : (
              <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto pr-1" data-testid="qa-issues">
                {qa.issues.map((issue, i) => (
                  <li
                    key={i}
                    className={`rounded border p-2 text-xs ${
                      issue.severity === 'warning' ? 'border-amber-700/60 bg-amber-950/30' : 'border-[#2e3340] bg-[#15171c]'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[10px] font-bold text-zinc-300">{issue.code}</span>
                      {issue.frames.length > 0 && (
                        <span className="text-[10px] text-zinc-500">frames {issue.frames.map((f) => f + 1).join(', ')}</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-zinc-100">{issue.message}</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">{issue.explanation}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-xs text-zinc-600">Analyzing…</p>
        )}
      </section>

      {/* Exports */}
      <SheetExportButtons frames={frames} durations={effectiveDurations} presetId={presetId} version={presetVersion} />
    </div>
  )
}
