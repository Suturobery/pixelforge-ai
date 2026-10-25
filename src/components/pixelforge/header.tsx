// PixelForge AI — top bar: identity, project name, file ops, undo/redo, export

'use client'

import { useState } from 'react'
import { useEditor } from '@/lib/pixelforge/store'
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
  Undo2,
  Redo2,
  Download,
  Loader2,
  Settings,
} from 'lucide-react'
import { NewProjectDialog, OpenProjectDialog } from './project-dialogs'
import { ExportDialog } from './export-dialog'
import { SettingsDialog } from './settings-dialog'

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
  const [exportOpen, setExportOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <TooltipProvider delayDuration={200}>
      <header className="flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b border-zinc-800 bg-zinc-950/90 px-3">
        {/* logo */}
        <div className="flex shrink-0 items-center gap-2" aria-label="PixelForge AI">
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden className="shrink-0">
            <rect x="1" y="1" width="18" height="18" fill="#0f172a" stroke="#2dd4bf" strokeWidth="1.5" />
            <rect x="4" y="4" width="4" height="4" fill="#2dd4bf" />
            <rect x="8" y="8" width="4" height="4" fill="#0d9488" />
            <rect x="12" y="4" width="4" height="4" fill="#5eead4" />
            <rect x="4" y="12" width="4" height="4" fill="#134e4a" />
            <rect x="12" y="12" width="4" height="4" fill="#2dd4bf" />
          </svg>
          <span className="hidden font-mono text-sm font-bold tracking-tight text-zinc-100 sm:inline">
            PixelForge <span className="text-teal-400">AI</span>
          </span>
        </div>

        <Separator orientation="vertical" className="mx-1 hidden h-6 shrink-0 bg-zinc-800 md:block" />

        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="hidden h-7 w-48 shrink-0 border-zinc-800 bg-zinc-900 font-mono text-xs md:block"
          aria-label="Project name"
        />

        <Separator orientation="vertical" className="mx-1 hidden h-6 shrink-0 bg-zinc-800 md:block" />

        <Button variant="ghost" size="sm" aria-label="New project" className="h-7 shrink-0 px-2 font-mono text-xs text-zinc-300 sm:px-3" onClick={() => setNewOpen(true)}>
          <FilePlus2 className="h-3.5 w-3.5 sm:mr-1.5" /><span className="hidden sm:inline">New</span>
        </Button>
        <Button variant="ghost" size="sm" aria-label="Open project" className="h-7 shrink-0 px-2 font-mono text-xs text-zinc-300 sm:px-3" onClick={() => setOpenOpen(true)}>
          <FolderOpen className="h-3.5 w-3.5 sm:mr-1.5" /><span className="hidden sm:inline">Open</span>
        </Button>
        <Button variant="ghost" size="sm" aria-label="Save project" className="h-7 shrink-0 px-2 font-mono text-xs text-zinc-300 sm:px-3" onClick={() => save()} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin sm:mr-1.5" /> : <Save className="h-3.5 w-3.5 sm:mr-1.5" />}
          <span className="hidden sm:inline">Save</span>
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
            className="h-7 bg-teal-600 px-2 font-mono text-xs text-white hover:bg-teal-500 sm:px-3"
            onClick={() => setExportOpen(true)}
          >
            <Download className="h-3.5 w-3.5 sm:mr-1" /> <span className="hidden sm:inline">Export</span>
          </Button>
        </div>
      </header>

      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} />
      <OpenProjectDialog open={openOpen} onOpenChange={setOpenOpen} />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </TooltipProvider>
  )
}
