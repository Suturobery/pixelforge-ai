'use client'

import { useEditor } from '@/lib/pixelforge/store'
import type { PixelGrid, Rig } from '@/lib/pixelforge/types'
import { autoRig, validateRig } from '@/lib/pixelforge/rig'
import { PART_COLORS } from './pixel-canvas'

interface Props {
  grid: PixelGrid
  rig: Rig
}

export function RigPanel({ grid, rig }: Props) {
  const activePart = useEditor((s) => s.activePart)
  const setActivePart = useEditor((s) => s.setActivePart)
  const setPartRect = useEditor((s) => s.setPartRect)

  const validation = validateRig(rig, grid)

  const update = (field: 'x' | 'y' | 'w' | 'h', v: number) => {
    if (!activePart) return
    const part = rig.parts.find((p) => p.id === activePart)
    if (!part) return
    const rect = { ...part.rect, [field]: Math.max(0, Math.round(v) || 0) }
    setPartRect(activePart, rect)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="rig-panel">
      <section className="rounded-lg border bg-[#1c1f26] p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">Body parts (rig)</h3>
          <button
            type="button"
            data-testid="auto-rig"
            onClick={() => {
              const r = autoRig(grid)
              if (r.parts.length > 0) {
                useEditor.setState((s) => ({
                  rig: r,
                  undoStack: [...s.undoStack, { grid: s.grid, rig: s.rig }],
                  redoStack: [],
                  savedAt: null,
                }))
              }
            }}
            className="text-xs text-zinc-500 underline hover:text-zinc-100"
          >
            Auto-rig
          </button>
        </div>
        {validation.warnings.map((w, i) => (
          <p key={i} className="mb-1 text-[11px] text-amber-400">⚠ {w}</p>
        ))}
        {validation.errors.map((e, i) => (
          <p key={i} className="mb-1 text-[11px] text-rose-700">✕ {e}</p>
        ))}
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
          {rig.parts.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                data-testid={`part-${p.id}`}
                onClick={() => setActivePart(p.id)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${
                  activePart === p.id ? 'bg-[#262932] text-cyan-300 ring-1 ring-cyan-500/40' : 'hover:bg-[#262932] text-zinc-300'
                }`}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: PART_COLORS[p.role] ?? PART_COLORS.custom }}
                />
                <span className="font-medium">{p.label}</span>
                <span className={`ml-auto font-mono text-[10px] ${activePart === p.id ? 'text-zinc-600' : 'text-zinc-600'}`}>
                  {p.rect.x},{p.rect.y} {p.rect.w}×{p.rect.h} z{p.zOrder}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {activePart && (() => {
        const part = rig.parts.find((p) => p.id === activePart)
        if (!part) return null
        return (
          <section className="rounded-lg border bg-[#1c1f26] p-4">
            <h3 className="mb-2 text-sm font-semibold text-zinc-100">{part.label} rectangle</h3>
            <div className="grid grid-cols-4 gap-2">
              {(['x', 'y', 'w', 'h'] as const).map((f) => (
                <label key={f} className="text-[10px] font-medium uppercase text-zinc-500">
                  {f}
                  <input
                    type="number"
                    data-testid={`rect-${f}`}
                    min={0}
                    value={part.rect[f]}
                    onChange={(e) => update(f, Number(e.target.value))}
                    className="mt-0.5 w-full rounded border border-[#3a3f4e] px-1.5 py-1 text-center text-xs"
                  />
                </label>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-snug text-zinc-500">
              Include 1–2 shared pixels with the torso at the joint — limbs stay attached while they translate.
            </p>
          </section>
        )
      })()}
    </div>
  )
}
