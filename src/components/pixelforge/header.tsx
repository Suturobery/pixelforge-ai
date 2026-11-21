// PixelForge AI — top bar: identity, project name, file ops, undo/redo, export

'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, isUsableProject } from '@/lib/pixelforge/store'
import { importLegacyProjectJson } from '@/lib/pixelforge/project-io'
import { rememberLastProject } from '@/lib/pixelforge/last-session'
import { AGENT_FETCH_HEADERS } from '@/lib/pixelforge/agent-headers'
import { desktopConfirm } from '@/lib/pixelforge/desktop-bridge'
import { isDesktop } from '@/lib/pixelforge/desktop-bridge'
import { listRecentProjectFiles, type RecentProjectFile } from '@/lib/pixelforge/recent-files'
import { openRecentProjectFromPath } from '@/lib/pixelforge/project-files'
import { useSaveProject } from './use-save'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  FilePlus2,
  FolderOpen,
  Save,
  Scaling,
  Undo2,
  Redo2,
  Download,
  Loader2,
  Settings,
  Clock,
  UserPlus,
} from 'lucide-react'
import { NewProjectDialog, OpenProjectDialog, ResizeCanvasDialog } from './project-dialogs'
import { ExportDialog } from './export-dialog'
import { SettingsDialog } from './settings-dialog'

interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
}

type RecentEntry =
  | { kind: 'file'; file: RecentProjectFile }
  | { kind: 'database'; project: ProjectSummary }

/** Recents dropdown — last 6 saved projects, one click to open.
 *  Rendered through a portal with fixed positioning: the header is
 *  h-12 + overflow-hidden, which used to CLIP the inline dropdown
 *  entirely (the "menu behind the app" bug). */
function RecentProjects() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [recents, setRecents] = useState<RecentEntry[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuTop, setMenuTop] = useState(0)

  useEffect(() => {
    if (!open) return
    const r = rootRef.current?.getBoundingClientRect()
    if (r) setMenuTop(r.bottom + 4)
    setLoading(true)
    if (isDesktop()) {
      setRecents(listRecentProjectFiles().slice(0, 6).map((file) => ({ kind: 'file' as const, file })))
      setLoading(false)
    } else {
    void fetch('/api/projects', { headers: AGENT_FETCH_HEADERS })
      .then((r2) => r2.json())
      .then((j: { projects?: ProjectSummary[] }) => {
        setRecents((j.projects ?? []).slice(0, 6).map((project) => ({ kind: 'database' as const, project })))
      })
      .catch(() => setRecents([]))
      .finally(() => setLoading(false))
    }
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])

  const load = async (entry: RecentEntry) => {
    // same guard as the Open dialog — never discard unsaved work silently.
    // desktopConfirm: Electron has no window.confirm — native dialog instead.
    if (useEditor.getState().dirty && !(await desktopConfirm('Discard unsaved changes and open this project?'))) return
    setLoading(true)
    try {
      if (entry.kind === 'file') {
        const opened = await openRecentProjectFromPath(entry.file.path)
        if (opened) setOpen(false)
        return
      }
      const id = entry.project.id
      const res = await fetch(`/api/projects/${id}`, { headers: AGENT_FETCH_HEADERS })
      const json = (await res.json()) as { ok: boolean; project?: unknown }
      if (!json.ok) throw new Error('load failed')
      const { project } = await importLegacyProjectJson(json.project, id)
      if (!isUsableProject(project)) throw new Error('unusable')
      useEditor.getState().loadProject(project, { projectId: id })
      rememberLastProject(id)
      setOpen(false)
    } catch {
      setLoading(false)
    }
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-zinc-300 sm:px-3"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Clock className="h-3.5 w-3.5 sm:mr-1.5" />
        <span className="hidden sm:inline">Recents</span>
      </Button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', left: rootRef.current ? rootRef.current.getBoundingClientRect().left : 0, top: menuTop }}
            className="pixelforge-scroll z-50 max-h-64 w-56 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/95 p-1 shadow-xl backdrop-blur-xl"
          >
            {loading && <p className="px-2 py-2 font-mono text-[10px] text-zinc-400">Loading…</p>}
            {!loading && recents.length === 0 && (
              <p className="px-2 py-2 font-mono text-[10px] text-zinc-400">No saved projects yet.</p>
            )}
            {recents.map((entry) => {
              const p = entry.kind === 'file' ? entry.file : entry.project
              return (
              <button
                key={entry.kind === 'file' ? entry.file.path : entry.project.id}
                type="button"
                role="menuitem"
                onClick={() => void load(entry)}
                className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-zinc-900"
              >
                <span className="w-full truncate font-mono text-xs text-zinc-200">{p.name}</span>
                <span className="font-mono text-[9px] text-zinc-500">{new Date(p.updatedAt).toLocaleString()}</span>
              </button>
              )
            })}
          </div>,
          document.body,
        )}
    </div>
  )
}

export function Header() {
  const name = useEditor((s) => s.project.name)
  const setName = useEditor((s) => s.setName)
  const dirty = useEditor((s) => s.dirty)
  const canUndo = useEditor((s) => s.canUndo)
  const canRedo = useEditor((s) => s.canRedo)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const { save, saving } = useSaveProject()
  const [newOpen, setNewOpen] = useState(false)
  const [openOpen, setOpenOpen] = useState(false)
  const [resizeOpen, setResizeOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <TooltipProvider delayDuration={200}>
      <header className="relative z-40 flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b border-zinc-800/80 bg-zinc-950/70 px-3 backdrop-blur-xl">
        {/* logo — Glow Grid mark (matches build/icon.svg): 2×2 tiles, teal glow column */}
        <div className="flex shrink-0 items-center gap-2.5" aria-label="PixelForge AI">
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden className="shrink-0">
            <defs>
              <linearGradient id="pf-header-glow" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#5eead4" />
                <stop offset="1" stopColor="#14b8a6" />
              </linearGradient>
            </defs>
            <rect x="0.5" y="0.5" width="19" height="19" rx="4.5" fill="#09090b" />
            <rect x="2" y="2" width="7.5" height="7.5" rx="1.75" fill="#3f3f46" />
            <rect x="2" y="10.5" width="7.5" height="7.5" rx="1.75" fill="#52525b" />
            <rect x="10.5" y="2" width="7.5" height="7.5" rx="1.75" fill="#5eead4" />
            <rect x="10.5" y="10.5" width="7.5" height="7.5" rx="1.75" fill="url(#pf-header-glow)" />
          </svg>
          <span className="hidden text-[13px] font-semibold tracking-tight text-zinc-100 sm:inline">
            PixelForge <span className="text-teal-400">AI</span>
          </span>
        </div>

        <Separator orientation="vertical" className="mx-1 hidden h-6 shrink-0 bg-zinc-800 md:block" />

        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="hidden h-7 w-48 shrink-0 border-zinc-800 bg-zinc-900 text-xs md:block"
          aria-label="Project name"
        />

        <Separator orientation="vertical" className="mx-1 hidden h-6 shrink-0 bg-zinc-800 md:block" />

        <Button variant="ghost" size="sm" aria-label="New project" className="h-7 shrink-0 px-2 text-xs text-zinc-300 sm:px-3" onClick={() => setNewOpen(true)}>
          <FilePlus2 className="h-3.5 w-3.5 sm:mr-1.5" /><span className="hidden sm:inline">New</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Create character"
          title="Create a character from the bundled 32×32 kit"
          className="h-7 shrink-0 px-2 text-xs text-teal-300 sm:px-3 hover:text-teal-200"
          onClick={() => useEditor.getState().requestRightTab('create')}
        >
          <UserPlus className="h-3.5 w-3.5 sm:mr-1.5" /><span className="hidden sm:inline">Create Character</span>
        </Button>
        <Button variant="ghost" size="sm" aria-label="Open project" className="h-7 shrink-0 px-2 text-xs text-zinc-300 sm:px-3" onClick={() => setOpenOpen(true)}>
          <FolderOpen className="h-3.5 w-3.5 sm:mr-1.5" /><span className="hidden sm:inline">Open</span>
        </Button>
        <RecentProjects />
        <Button variant="ghost" size="sm" aria-label="Save project" className="h-7 shrink-0 px-2 text-xs text-zinc-300 sm:px-3" onClick={() => save()} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin sm:mr-1.5" /> : <Save className="h-3.5 w-3.5 sm:mr-1.5" />}
          <span className="hidden sm:inline">Save</span>
        </Button>
        <Button variant="ghost" size="sm" aria-label="Resize canvas" className="h-7 shrink-0 px-2 text-xs text-zinc-300 sm:px-3" onClick={() => setResizeOpen(true)}>
          <Scaling className="h-3.5 w-3.5 sm:mr-1.5" /><span className="hidden sm:inline">Resize</span>
        </Button>

        <Separator orientation="vertical" className="mx-1 h-6 shrink-0 bg-zinc-800" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-zinc-400" onClick={undo} disabled={!canUndo} aria-label="Undo">
              <Undo2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Undo [Ctrl+Z]</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-zinc-400" onClick={redo} disabled={!canRedo} aria-label="Redo">
              <Redo2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Redo [Ctrl+Shift+Z]</TooltipContent>
        </Tooltip>

        {/* status */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-400" aria-live="polite">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${dirty ? 'bg-amber-400' : 'bg-emerald-500'}`}
              aria-hidden
            />
            <span className="hidden sm:inline">{dirty ? 'unsaved changes' : 'saved'}</span>
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-zinc-400"
                onClick={() => setSettingsOpen(true)}
                aria-label="Settings"
              >
                <Settings className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
          <Button
            size="sm"
            aria-label="Export assets"
            className="h-7 rounded-md bg-teal-600 px-2.5 text-xs font-medium text-white shadow-sm hover:bg-teal-500 sm:px-3"
            onClick={() => setExportOpen(true)}
          >
            <Download className="h-3.5 w-3.5 sm:mr-1" /> <span className="hidden sm:inline">Export</span>
          </Button>
        </div>
      </header>

      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} />
      <OpenProjectDialog open={openOpen} onOpenChange={setOpenOpen} />
      <ResizeCanvasDialog open={resizeOpen} onOpenChange={setResizeOpen} />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </TooltipProvider>
  )
}
