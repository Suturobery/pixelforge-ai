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
import {
  hydrateDesktopSettings,
  startDesktopSettingsSync,
  useAppSettings,
} from '@/lib/pixelforge/settings'
import { initMcpBridge } from '@/lib/pixelforge/mcp-bridge'
import { restoreLastProject } from '@/lib/pixelforge/last-session'
import { autosaveProjectFile } from '@/lib/pixelforge/project-files'
import { isDesktop } from '@/lib/pixelforge/desktop-bridge'
import { useSaveProject } from '@/components/pixelforge/use-save'
import { useKeyboardShortcuts } from '@/components/pixelforge/use-keyboard'
import { useIsMobile } from '@/components/pixelforge/use-is-mobile'
import { Layers, Sparkles, Bot, PersonStanding, PanelRightClose, Maximize2, Minimize2, Loader2 } from 'lucide-react'
import { Header } from '@/components/pixelforge/header'
import { ToolRail } from '@/components/pixelforge/tool-rail'
import { CanvasStage } from '@/components/pixelforge/canvas-stage'
import { Timeline } from '@/components/pixelforge/timeline'
import { LayersPanel } from '@/components/pixelforge/layers-panel'
import { ApprovalCards } from '@/components/pixelforge/approval-cards'
import { OnboardingTour } from '@/components/pixelforge/onboarding-tour'
import { AiPanel } from '@/components/pixelforge/ai-panel'
import { AgentPanel } from '@/components/pixelforge/agent-panel'
import { MotionPanel } from '@/components/pixelforge/motion-panel'
import { Footer } from '@/components/pixelforge/footer'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'

const RIGHT_TABS: { id: RightTab; label: string; icon: React.ReactNode; tone: 'ember' | 'frost' }[] = [
  { id: 'layers', label: 'Layers', tone: 'ember', icon: <Layers className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'ai', label: 'AI', tone: 'frost', icon: <Sparkles className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'motion', label: 'Motion', tone: 'frost', icon: <PersonStanding className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'agent', label: 'Agent', tone: 'frost', icon: <Bot className="h-3.5 w-3.5" aria-hidden /> },
]

function RightDock({ mobile }: { mobile: boolean }) {
  const rightTab = useEditor((s) => s.rightTab)
  const setRightTab = useEditor((s) => s.setRightTab)
  const rightOpen = useEditor((s) => s.rightOpen)
  const setRightOpen = useEditor((s) => s.setRightOpen)
  const rightWidth = useEditor((s) => s.rightWidth)
  const setRightWidth = useEditor((s) => s.setRightWidth)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  // expand toggle: remembers the dragged width so collapse restores it
  const [expanded, setExpanded] = useState(false)
  const preExpandWidth = useRef(320)

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
        className="w-6 shrink-0 border-l border-zinc-800/80 bg-zinc-950/60 text-[10px] font-semibold uppercase tracking-widest text-zinc-500 hover:text-teal-400 [writing-mode:vertical-rl]"
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
              ? '@container absolute inset-y-0 right-0 z-40 flex w-[min(85vw,320px)] flex-col border-l border-zinc-800/80 bg-zinc-950/90 shadow-2xl backdrop-blur-xl'
              : '@container relative flex min-w-0 shrink-0 flex-col border-l border-zinc-800/80 bg-zinc-950/50 backdrop-blur-xl'
          }
        style={mobile ? undefined : { width: rightWidth }}
      >
        {/* PANELS header row (original studio chrome) */}
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800/80 pl-3 pr-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Panels</span>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => {
                if (expanded) {
                  setRightWidth(preExpandWidth.current)
                  setExpanded(false)
                } else {
                  preExpandWidth.current = rightWidth
                  setRightWidth(560)
                  setExpanded(true)
                }
              }}
              aria-label={expanded ? 'Collapse panels' : 'Expand panels'}
              aria-pressed={expanded}
              title={expanded ? 'Collapse panel dock' : 'Expand panel dock'}
              className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Hide panels"
              title="Hide panel dock"
              className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* tab bar — macOS segmented control; blue = artist panels, indigo = machine panels */}
        <div role="tablist" aria-label="Panel tabs" className="shrink-0 border-b border-zinc-800/80 p-2">
          <div className="flex gap-1 rounded-lg bg-zinc-800/60 p-0.5">
            {RIGHT_TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={rightTab === t.id}
                onClick={() => setRightTab(t.id)}
                className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all ${
                  rightTab === t.id
                    ? t.tone === 'frost'
                      ? 'bg-zinc-900/90 text-frost-300 shadow-sm ring-1 ring-white/10'
                      : 'bg-zinc-900/90 text-teal-400 shadow-sm ring-1 ring-white/10'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t.icon}
                <span className="truncate">{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* active panel */}
        <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
          {rightTab === 'layers' && <LayersPanel />}
          {rightTab === 'ai' && <AiPanel />}
          {rightTab === 'motion' && <MotionPanel />}
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

  // skip the pre-hydration frame: the persisted settings store rehydrates
  // after first paint, and the factory-default layout (floating palette,
  // empty stage) flashes before the real one — hold a splash until mounted
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Cmd/Ctrl+S · transport · tools — shared keyboard hook
  useKeyboardShortcuts(useCallback(() => void save(), [save]))

  // Debounced background autosave. Desktop must never call the manual Save
  // path here: an untitled desktop project has no file target yet, and manual
  // Save correctly opens a folder picker. Autosave simply waits for the user
  // to choose a file once, so Resize and every other edit stay picker-free.
  useEffect(() => {
    if (!autosave || !dirty) return
    const t = setTimeout(() => {
      if (isDesktop()) void autosaveProjectFile()
      else void save(true)
    }, Math.max(500, autosaveDelay))
    return () => clearTimeout(t)
  }, [autosave, dirty, autosaveDelay, save])

  // MCP editor bridge (renderer ⇄ mini-services/mcp-server) + desktop settings
  // vault hydrate/write-through. Browser-safe: both are no-ops outside their
  // environment, and the bridge guards itself against double-init.
  useEffect(() => {
    initMcpBridge()
    void hydrateDesktopSettings()
    return startDesktopSettingsSync()
  }, [])

  // refresh = new in-memory document — reopen the last saved project so a
  // reload continues where the artist left off (no-op when nothing saved yet)
  const { toast } = useToast()
  useEffect(() => {
    if (!mounted) return
    void restoreLastProject().then((name) => {
      if (name) toast({ title: 'Last project restored', description: name })
    })
  }, [mounted, toast])

  if (!mounted) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-zinc-950" aria-busy="true" aria-label="Loading studio">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-frost-400" />
          <span className="font-mono text-sm font-semibold text-zinc-100">PixelForge AI</span>
        </div>
        <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
      </div>
    )
  }

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

      {/* Task 11: paid-op approval cards — visible over any panel state */}
      <ApprovalCards />

      {/* first-run onboarding (shown once per browser) */}
      <OnboardingTour />

      <Footer />
    </div>
  )
}
