// PixelForge AI — the studio.
//
// Layout (dark studio shell, per the original evidence screenshots):
//   ┌──────────────────────────────────────────────────────────────┐
//   │ Header — logo · project name · New/Open/Save · undo/redo · ⚙ Export │
//   ├──┬───────────────────────────────────────────────┬───────────┤
//   │ T│                                               │ PANELS    │
//   │ o│              CanvasStage                      │ [Layers | AI | Agent] │
//   │ o│   (floating palette · view bar · tool options │           │
//   │ l│    · preview overlay live inside the stage)   │           │
//   │ s├───────────────────────────────────────────────┤           │
//   │  │ Timeline — transport · scrubber · frames strip │           │
//   ├──┴───────────────────────────────────────────────┴───────────┤
//   │ Footer — size · zoom · hover · tool · clip/frame · save state │
//   └──────────────────────────────────────────────────────────────┘
//
// The page owns NO editor state: everything reads the zustand store; every
// mutation goes through the CommandBus. Keyboard shortcuts and the shared
// playback controller are wired here.

'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useEditor, type RightTab } from '@/lib/pixelforge/store'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { useSaveProject } from '@/components/pixelforge/use-save'
import { useKeyboardShortcuts } from '@/components/pixelforge/use-keyboard'
import { useIsMobile } from '@/components/pixelforge/use-is-mobile'
import { Header } from '@/components/pixelforge/header'
import { ToolRail } from '@/components/pixelforge/tool-rail'
import { CanvasStage } from '@/components/pixelforge/canvas-stage'
import { Timeline } from '@/components/pixelforge/timeline'
import { LayersPanel } from '@/components/pixelforge/layers-panel'
import { AiPanel } from '@/components/pixelforge/ai-panel'
import { AgentPanel } from '@/components/pixelforge/agent-panel'
import { Footer } from '@/components/pixelforge/footer'
import { cn } from '@/lib/utils'

const RIGHT_TABS: { id: RightTab; label: string }[] = [
  { id: 'layers', label: 'Layers' },
  { id: 'ai', label: 'AI' },
  { id: 'agent', label: 'Agent' },
]

function RightDock({ mobile }: { mobile: boolean }) {
  const rightTab = useEditor((s) => s.rightTab)
  const setRightTab = useEditor((s) => s.setRightTab)
  const rightOpen = useEditor((s) => s.rightOpen)
  const setRightOpen = useEditor((s) => s.setRightOpen)
  const rightWidth = useEditor((s) => s.rightWidth)
  const setRightWidth = useEditor((s) => s.setRightWidth)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  if (!rightOpen) {
    return (
      <button
        type="button"
        onClick={() => setRightOpen(true)}
        aria-label="Show panels"
        className="w-6 shrink-0 border-l border-zinc-800 bg-zinc-950/60 font-mono text-[10px] uppercase tracking-widest text-zinc-500 hover:text-teal-300 [writing-mode:vertical-rl]"
      >
        Panels
      </button>
    )
  }

  return (
    <aside
      aria-label="Panels"
      className="relative flex min-w-0 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950/60"
      style={{ width: mobile ? undefined : rightWidth }}
    >
      {/* tab bar — [Layers | AI | Agent] */}
      <div role="tablist" aria-label="Panel tabs" className="flex h-9 shrink-0 items-stretch border-b border-zinc-800">
        {RIGHT_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={rightTab === t.id}
            onClick={() => setRightTab(t.id)}
            className={`flex-1 border-b-2 px-2 font-mono text-xs transition-colors ${
              rightTab === t.id
                ? 'border-teal-400 bg-zinc-900/60 text-teal-300'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setRightOpen(false)}
          aria-label="Hide panels"
          className="w-7 shrink-0 font-mono text-[11px] text-zinc-500 hover:text-zinc-200"
          title="Hide panel dock"
        >
          ✕
        </button>
      </div>

      {/* active panel */}
      <div role="tabpanel" className="min-h-0 flex-1">
        {rightTab === 'layers' && <LayersPanel />}
        {rightTab === 'ai' && <AiPanel />}
        {rightTab === 'agent' && <AgentPanel />}
      </div>

      {/* width drag handle (desktop) */}
      {!mobile && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel dock"
          className="absolute left-0 top-0 h-full w-1 cursor-col-resize touch-none hover:bg-teal-500/40"
          onPointerDown={(e) => {
            dragRef.current = { startX: e.clientX, startW: rightWidth }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            const d = dragRef.current
            if (!d) return
            setRightWidth(d.startW - (e.clientX - d.startX))
          }}
          onPointerUp={() => {
            dragRef.current = null
          }}
        />
      )}
    </aside>
  )
}

export default function Home() {
  const dirty = useEditor((s) => s.dirty)
  const autosave = useEditor((s) => s.autosave)
  const autosaveDelay = useAppSettings((s) => s.autosaveDelay)
  const { save } = useSaveProject()
  const mobile = useIsMobile()

  // Cmd/Ctrl+S · transport · tools — shared keyboard hook
  useKeyboardShortcuts(useCallback(() => void save(), [save]))

  // debounced background autosave (web testbed adapter; desktop saves files)
  useEffect(() => {
    if (!autosave || !dirty) return
    const t = setTimeout(() => void save(true), Math.max(500, autosaveDelay))
    return () => clearTimeout(t)
  }, [autosave, dirty, autosaveDelay, save])

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <Header />

      <div className="relative flex min-h-0 flex-1">
        <ToolRail />

        <main className="flex min-w-0 flex-1 flex-col">
          <CanvasStage />
          <Timeline />
        </main>

        <RightDock mobile={mobile} />
      </div>

      <Footer />
    </div>
  )
}
