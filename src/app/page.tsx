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

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor, type RightTab } from '@/lib/pixelforge/store'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { useSaveProject } from '@/components/pixelforge/use-save'
import { useKeyboardShortcuts } from '@/components/pixelforge/use-keyboard'
import { useIsMobile } from '@/components/pixelforge/use-is-mobile'
import { Layers, Sparkles, Bot, PanelRightClose } from 'lucide-react'
import { Header } from '@/components/pixelforge/header'
import { ToolRail } from '@/components/pixelforge/tool-rail'
import { CanvasStage } from '@/components/pixelforge/canvas-stage'
import { Timeline } from '@/components/pixelforge/timeline'
import { LayersPanel } from '@/components/pixelforge/layers-panel'
import { AiPanel } from '@/components/pixelforge/ai-panel'
import { AgentPanel } from '@/components/pixelforge/agent-panel'
import { Footer } from '@/components/pixelforge/footer'
import { cn } from '@/lib/utils'

const RIGHT_TABS: { id: RightTab; label: string; icon: React.ReactNode }[] = [
  { id: 'layers', label: 'Layers', icon: <Layers className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'ai', label: 'AI', icon: <Sparkles className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'agent', label: 'Agent', icon: <Bot className="h-3.5 w-3.5" aria-hidden /> },
]

function RightDock({ mobile }: { mobile: boolean }) {
  const rightTab = useEditor((s) => s.rightTab)
  const setRightTab = useEditor((s) => s.setRightTab)
  const rightOpen = useEditor((s) => s.rightOpen)
  const setRightOpen = useEditor((s) => s.setRightOpen)
  const rightWidth = useEditor((s) => s.rightWidth)
  const setRightWidth = useEditor((s) => s.setRightWidth)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  // on phones the dock is a slide-over drawer and starts CLOSED so the
  // canvas + timeline always get the full width (mobile UI audit fix)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const open = mobile ? drawerOpen : rightOpen
  const setOpen = (v: boolean) => (mobile ? setDrawerOpen(v) : setRightOpen(v))

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Show panels"
        className="w-6 shrink-0 border-l border-zinc-800 bg-zinc-950/60 font-mono text-[10px] uppercase tracking-widest text-zinc-500 hover:text-teal-300 [writing-mode:vertical-rl]"
      >
        Panels
      </button>
    )
  }

  return (
    <>
      {/* phone drawer: dim + tap-outside to close (desktop has no backdrop) */}
      {mobile && (
        <button
          type="button"
          aria-label="Hide panels"
          tabIndex={-1}
          onClick={() => setOpen(false)}
          className="absolute inset-0 z-30 cursor-default bg-black/40"
        />
      )}
      <aside
        aria-label="Panels"
        className={
          mobile
            ? 'absolute inset-y-0 right-0 z-40 flex w-[min(85vw,320px)] flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl'
            : 'relative flex min-w-0 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950/60'
        }
        style={mobile ? undefined : { width: rightWidth }}
      >
        {/* PANELS header row (original studio chrome) */}
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 pl-3 pr-1.5">
          <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-400">Panels</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Hide panels"
            title="Hide panel dock"
            className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>

        {/* tab bar — [Layers | AI | Agent] segmented group with icons */}
        <div role="tablist" aria-label="Panel tabs" className="flex shrink-0 gap-1 border-b border-zinc-800 p-1.5">
          {RIGHT_TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={rightTab === t.id}
              onClick={() => setRightTab(t.id)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-xs transition-colors ${
                rightTab === t.id
                  ? 'bg-zinc-800 text-teal-300 ring-1 ring-zinc-700'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
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
    </>
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
