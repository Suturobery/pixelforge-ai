'use client'

import { useEffect, useMemo } from 'react'
import type { PresetId } from '@/lib/pixelforge/types'
import { getPresetSet, DEFAULT_PARAMS } from '@/lib/pixelforge/presets'
import { generateAnimation } from '@/lib/pixelforge/animate'
import { analyzeMotion } from '@/lib/pixelforge/qa'
import { effectiveDurations } from '@/lib/pixelforge/playback'
import { useEditor } from '@/lib/pixelforge/store'
import type { FixtureId } from '@/lib/pixelforge/fixtures'

import { PixelCanvas } from '@/components/pixelforge/pixel-canvas'
import { PreviewPlayer } from '@/components/pixelforge/preview-player'
import { MotionPanel } from '@/components/pixelforge/motion-panel'
import { RigPanel } from '@/components/pixelforge/rig-panel'
import { FramesStrip } from '@/components/pixelforge/frames-strip'

const TEMPLATES: { id: FixtureId; label: string }[] = [
  { id: 'simple', label: 'Simple humanoid 32×32' },
  { id: 'detailed', label: 'Detailed humanoid 48×48' },
  { id: 'slime', label: 'Slime 24×24' },
]

const SWATCHES = ['#1a1622', '#e8b796', '#d8a878', '#f0c8a0', '#4a3123', '#7a3020', '#3f7d4e', '#2f5f3b', '#2e6f9e', '#5a4a68', '#c8ccd8', '#7a2430', '#d8b84a', '#59b359', '#3b4a36']

export default function Home() {
  const store = useEditor()
  const {
    grid, rig, tool, color, zoom,
    presetId, presetVersion, params, durationOverrides,
    undoStack, redoStack, savedAt, template,
  } = store

  // Load persisted project once
  useEffect(() => {
    useEditor.getState().load()
  }, [])

  // Debounced autosave for grid/rig changes
  useEffect(() => {
    const t = setTimeout(() => useEditor.getState().save(), 800)
    return () => clearTimeout(t)
  }, [grid, rig, durationOverrides, params, presetId, presetVersion])

  // Derived animation (pure, deterministic)
  const derived = useMemo(() => {
    const set = getPresetSet(presetVersion)
    const preset = set[presetId]
    const anim = generateAnimation(grid, rig, preset, params)
    const durations = effectiveDurations(anim.plans, durationOverrides)
    const qa = analyzeMotion(
      grid,
      rig,
      { ...preset, loops: preset.loops },
      anim.plans.map((p, i) => ({ ...p, duration: durations[i] }))
    )
    return { preset, anim, durations, qa }
  }, [grid, rig, presetId, presetVersion, params, durationOverrides])

  const keyboard = useMemo(() => ({
    onKey: (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) useEditor.getState().redo()
        else useEditor.getState().undo()
      }
    },
  }), [])

  useEffect(() => {
    window.addEventListener('keydown', keyboard.onKey)
    return () => window.removeEventListener('keydown', keyboard.onKey)
  }, [keyboard])

  return (
    <div className="flex min-h-screen flex-col bg-stone-100 text-stone-900">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2.5">
          <h1 className="text-sm font-bold tracking-tight">
            PixelForge <span className="text-emerald-600">Motion Lab</span>
          </h1>
          <span className="hidden text-[11px] text-stone-400 sm:inline">
            Task 10 · five presets · part-based composer · heuristic QA
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <select
              data-testid="template-select"
              value={template}
              onChange={(e) => useEditor.getState().loadTemplate(e.target.value as FixtureId)}
              className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-xs"
              aria-label="Load template sprite"
            >
              {TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
              {template === 'custom' && <option value="custom">Custom (saved)</option>}
            </select>
            <button
              type="button"
              data-testid="undo"
              onClick={store.undo}
              disabled={undoStack.length === 0}
              className="rounded-md border px-2 py-1.5 text-xs font-medium disabled:opacity-40"
              title="Undo (Ctrl+Z)"
            >
              Undo
            </button>
            <button
              type="button"
              data-testid="redo"
              onClick={store.redo}
              disabled={redoStack.length === 0}
              className="rounded-md border px-2 py-1.5 text-xs font-medium disabled:opacity-40"
              title="Redo (Ctrl+Shift+Z)"
            >
              Redo
            </button>
            <span className="text-[10px] text-stone-400" data-testid="save-state">
              {savedAt ? 'saved' : 'unsaved'}
            </span>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)] xl:grid-cols-[minmax(0,5fr)_minmax(0,3fr)_minmax(0,4fr)]">
        {/* Left: editor */}
        <section aria-label="Sprite editor" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-white p-2">
            {(['pencil', 'eraser', 'picker'] as const).map((t) => (
              <button
                key={t}
                type="button"
                data-testid={`tool-${t}`}
                onClick={() => store.setTool(t)}
                className={`rounded px-2.5 py-1.5 text-xs font-medium capitalize ${
                  tool === t ? 'bg-stone-800 text-white' : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
                }`}
              >
                {t}
              </button>
            ))}
            <div className="mx-1 h-6 w-px bg-stone-200" />
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => store.setColor(c)}
                className={`h-6 w-6 rounded border ${color === c ? 'ring-2 ring-emerald-600 ring-offset-1' : ''}`}
                style={{ background: c }}
                aria-label={`Color ${c}`}
              />
            ))}
            <input
              type="color"
              value={color}
              onChange={(e) => store.setColor(e.target.value)}
              className="h-6 w-8 cursor-pointer rounded border"
              aria-label="Custom color"
            />
            <div className="mx-1 h-6 w-px bg-stone-200" />
            <button type="button" onClick={() => store.setZoom(zoom - 2)} className="rounded border px-2 py-1 text-xs">−</button>
            <span className="font-mono text-[11px] text-stone-500">{zoom}×</span>
            <button type="button" onClick={() => store.setZoom(zoom + 2)} className="rounded border px-2 py-1 text-xs">+</button>
            <label className="ml-2 flex items-center gap-1 text-[11px] text-stone-600">
              <input
                type="checkbox"
                checked={store.showRects}
                onChange={(e) => store.setShowRects(e.target.checked)}
                data-testid="toggle-rects"
              />
              part rects
            </label>
          </div>
          <PixelCanvas grid={grid} rig={rig} />
          <FramesStrip frames={derived.anim.frames} plans={derived.anim.plans} overrides={durationOverrides} />
        </section>

        {/* Middle: preview (xl only) / merged below on smaller screens */}
        <section aria-label="Animation preview" className="flex flex-col gap-4 xl:col-auto max-xl:order-3">
          <PreviewPlayer plans={derived.anim.plans} frames={derived.anim.frames} overrides={durationOverrides} />
          <RigPanel grid={grid} rig={rig} />
        </section>

        {/* Right: motion composer + QA */}
        <section aria-label="Motion composer" className="flex flex-col gap-4">
          <MotionPanel
            frames={derived.anim.frames}
            plans={derived.anim.plans}
            qa={derived.qa}
          />
        </section>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-stone-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[11px] text-stone-500">
          <span className="font-semibold text-stone-700">PixelForge AI — Motion Lab</span>
          <span>Translation-only part composer (v3.1 R1–R10)</span>
          <span>QA warnings are heuristics — always review frames before export</span>
          <span className="ml-auto font-mono">{grid.width}×{grid.height} · {presetId}/{presetVersion} · amp ×{params.amplitude} · spd ×{params.speed} · {DEFAULT_PARAMS.facing === params.facing ? 'default' : 'custom'} params</span>
        </div>
      </footer>
    </div>
  )
}
