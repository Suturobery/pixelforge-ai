'use client'

import { useEffect, useMemo } from 'react'
import type { PresetId } from '@/lib/pixelforge/types'
import { getPresetSet, DEFAULT_PARAMS } from '@/lib/pixelforge/presets'
import { generateAnimation } from '@/lib/pixelforge/animate'
import { analyzeMotion } from '@/lib/pixelforge/qa'
import { effectiveDurations } from '@/lib/pixelforge/playback'
import { useEditor } from '@/lib/pixelforge/store'
import type { FixtureId } from '@/lib/pixelforge/fixtures'
import {
  Pencil,
  Eraser,
  Pipette,
  PaintBucket,
  Slash,
  Square,
  FlipHorizontal2,
  Plus,
  Minus,
} from 'lucide-react'

import { PixelCanvas } from '@/components/pixelforge/pixel-canvas'
import { PreviewPlayer } from '@/components/pixelforge/preview-player'
import { MotionPanel } from '@/components/pixelforge/motion-panel'
import { RigPanel } from '@/components/pixelforge/rig-panel'
import { FramesStrip } from '@/components/pixelforge/frames-strip'
import { AiPanel } from '@/components/pixelforge/ai-panel'
import { PalettePanel } from '@/components/pixelforge/palette-panel'

const TEMPLATES: { id: FixtureId; label: string }[] = [
  { id: 'simple', label: 'Simple humanoid 32×32' },
  { id: 'detailed', label: 'Detailed humanoid 48×48' },
  { id: 'slime', label: 'Slime 24×24' },
]

const TOOLS = [
  { id: 'pencil', label: 'Pencil', Icon: Pencil },
  { id: 'eraser', label: 'Eraser', Icon: Eraser },
  { id: 'fill', label: 'Fill', Icon: PaintBucket },
  { id: 'line', label: 'Line', Icon: Slash },
  { id: 'rect', label: 'Rectangle', Icon: Square },
  { id: 'picker', label: 'Color picker', Icon: Pipette },
] as const

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
    <div className="flex min-h-screen flex-col bg-[#15171c] text-zinc-200">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-[#2e3340] bg-[#1c1f26]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 px-4 py-2.5">
          <h1 className="flex items-center gap-2 text-sm font-bold tracking-tight">
            <span className="inline-block h-3.5 w-3.5 rounded-[4px] bg-cyan-400 shadow-[0_0_10px_rgba(86,215,232,0.6)]" aria-hidden />
            PixelForge <span className="text-cyan-400">AI</span>
          </h1>
          <span className="hidden text-[11px] text-zinc-500 sm:inline">
            AI sprite generation · five motion presets · part-based composer · heuristic QA
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <select
              data-testid="template-select"
              value={template}
              onChange={(e) => useEditor.getState().loadTemplate(e.target.value as FixtureId)}
              className="rounded-md border border-[#2e3340] bg-[#15171c] px-2 py-1.5 text-xs text-zinc-300"
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
              className="rounded-md border border-[#2e3340] bg-[#15171c] px-2 py-1.5 text-xs font-medium text-zinc-300 hover:border-[#565d70] disabled:opacity-40"
              title="Undo (Ctrl+Z)"
            >
              Undo
            </button>
            <button
              type="button"
              data-testid="redo"
              onClick={store.redo}
              disabled={redoStack.length === 0}
              className="rounded-md border border-[#2e3340] bg-[#15171c] px-2 py-1.5 text-xs font-medium text-zinc-300 hover:border-[#565d70] disabled:opacity-40"
              title="Redo (Ctrl+Shift+Z)"
            >
              Redo
            </button>
            <span className="text-[10px] text-zinc-600" data-testid="save-state">
              {savedAt ? 'saved' : 'unsaved'}
            </span>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[auto_auto_minmax(0,5fr)] xl:grid-cols-[auto_auto_minmax(0,5fr)_minmax(0,4fr)]">
        {/* Tool rail — original left toolbar */}
        <section aria-label="Tools" className="flex flex-row gap-2 lg:flex-col">
          <div className="flex flex-row gap-1 rounded-lg border border-[#2e3340] bg-[#1c1f26] p-1.5 lg:flex-col">
            {TOOLS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                data-testid={`tool-${id}`}
                onClick={() => store.setTool(id)}
                aria-pressed={tool === id}
                title={label}
                aria-label={label}
                className={`flex h-10 w-10 items-center justify-center rounded-md transition ${
                  tool === id
                    ? 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/50'
                    : 'text-zinc-400 hover:bg-[#262932] hover:text-zinc-200'
                }`}
              >
                <Icon size={18} strokeWidth={2} />
              </button>
            ))}
            <div className="mx-1 h-6 w-px self-center bg-[#2e3340] max-lg:hidden" />
            <button
              type="button"
              onClick={store.flipHorizontal}
              title="Flip sprite horizontally"
              aria-label="Flip sprite horizontally"
              className="flex h-10 w-10 items-center justify-center rounded-md text-zinc-400 transition hover:bg-[#262932] hover:text-zinc-200"
            >
              <FlipHorizontal2 size={18} strokeWidth={2} />
            </button>
          </div>
          {/* zoom rail */}
          <div className="flex flex-row gap-1 rounded-lg border border-[#2e3340] bg-[#1c1f26] p-1.5 lg:flex-col">
            <button
              type="button"
              onClick={() => store.setZoom(zoom - 2)}
              title="Zoom out"
              aria-label="Zoom out"
              className="flex h-10 w-10 items-center justify-center rounded-md text-zinc-400 transition hover:bg-[#262932] hover:text-zinc-200"
            >
              <Minus size={16} />
            </button>
            <span className="flex h-10 w-10 items-center justify-center font-mono text-[10px] text-zinc-500">{zoom}×</span>
            <button
              type="button"
              onClick={() => store.setZoom(zoom + 2)}
              title="Zoom in"
              aria-label="Zoom in"
              className="flex h-10 w-10 items-center justify-center rounded-md text-zinc-400 transition hover:bg-[#262932] hover:text-zinc-200"
            >
              <Plus size={16} />
            </button>
            <label className="flex h-10 w-10 items-center justify-center" title="Show part rectangles">
              <input
                type="checkbox"
                checked={store.showRects}
                onChange={(e) => store.setShowRects(e.target.checked)}
                data-testid="toggle-rects"
                className="h-3.5 w-3.5 accent-cyan-400"
                aria-label="Show part rectangles"
              />
            </label>
          </div>
        </section>

        {/* Palette — Forge 16 */}
        <section aria-label="Palette">
          <PalettePanel />
        </section>

        {/* Center: canvas + frames */}
        <section aria-label="Sprite editor" className="flex flex-col gap-3">
          <PixelCanvas grid={grid} rig={rig} />
          <FramesStrip frames={derived.anim.frames} plans={derived.anim.plans} overrides={durationOverrides} />
        </section>

        {/* Right: AI + preview + motion composer + rig */}
        <section aria-label="Motion composer" className="flex flex-col gap-4">
          <AiPanel />
          <PreviewPlayer plans={derived.anim.plans} frames={derived.anim.frames} overrides={durationOverrides} />
          <MotionPanel
            frames={derived.anim.frames}
            plans={derived.anim.plans}
            qa={derived.qa}
          />
          <RigPanel grid={grid} rig={rig} />
        </section>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-[#2e3340] bg-[#1c1f26]">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[11px] text-zinc-500">
          <span className="font-semibold text-zinc-300">PixelForge AI — Studio</span>
          <span>Translation-only part composer (v3.1 R1–R10)</span>
          <span>QA warnings are heuristics — always review frames before export</span>
          <span className="ml-auto font-mono">{grid.width}×{grid.height} · {presetId}/{presetVersion} · amp ×{params.amplitude} · spd ×{params.speed} · {DEFAULT_PARAMS.facing === params.facing ? 'default' : 'custom'} params</span>
        </div>
      </footer>
    </div>
  )
}
