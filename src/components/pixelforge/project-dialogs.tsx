// PixelForge AI — New / Open project dialogs

'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { useEditor, isUsableProject } from '@/lib/pixelforge/store'
import { AGENT_FETCH_HEADERS } from '@/lib/pixelforge/agent-headers'
import { describeApiErrorInline } from '@/lib/pixelforge/api-error'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { createProject } from '@/lib/pixelforge/factory'
import { importLegacyProjectJson, isSerializedProject } from '@/lib/pixelforge/project-io'
import { listBackupSnapshots, getBackupSnapshot } from '@/lib/pixelforge/backup-snapshots'
import { openProjectFileViaDialog, openRecentProjectFromPath } from '@/lib/pixelforge/project-files'
import { getBridge, isDesktop } from '@/lib/pixelforge/desktop-bridge'
import { forgetRecentProjectFile, listRecentProjectFiles, type RecentProjectFile } from '@/lib/pixelforge/recent-files'
import { rememberLastProject } from '@/lib/pixelforge/last-session'
import type { ProjectSummary } from '@/lib/pixelforge/types'
import { PALETTES } from '@/lib/pixelforge/palettes'
import { friendlyError } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { StepperInput } from '@/components/pixelforge/stepper-input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { Loader2, Trash2, FolderOpen, X } from 'lucide-react'

const SIZE_PRESETS = [16, 24, 32, 48, 64, 96, 128]

export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { toast } = useToast()
  const dirty = useEditor((s) => s.dirty)
  const settings = useAppSettings()
  // preselects fall back to the saved settings; user choices override them
  // until the dialog closes again (no effect needed → lint-safe)
  const [sizeOverride, setSizeOverride] = useState<string | null>(null)
  const [paletteOverride, setPaletteOverride] = useState<string | null>(null)
  const [custom, setCustom] = useState<{ w: number; h: number } | null>(null)
  const [name, setName] = useState('untitled')
  const size = sizeOverride ?? String(settings.defaultSize)
  const customW = custom?.w ?? settings.defaultSize
  const customH = custom?.h ?? settings.defaultSize
  const paletteId = paletteOverride ?? settings.defaultPaletteId
  const setSize = setSizeOverride
  const setPaletteId = setPaletteOverride

  const create = async () => {
    // data-loss protection: explicit confirm when switching away from unsaved work
    if (
      dirty &&
      !(await confirmDialog({
        title: 'Discard unsaved changes?',
        message: 'Creating a new project will lose your unsaved changes.',
        confirmLabel: 'Discard & Create',
        destructive: true,
      }))
    )
      return
    const w = size === 'custom' ? customW : parseInt(size, 10)
    const h = size === 'custom' ? customH : parseInt(size, 10)
    const palette = PALETTES.find((p) => p.id === paletteId)?.colors
    const project = createProject({
      name: name.trim() || 'untitled',
      width: Math.max(16, Math.min(256, w)),
      height: Math.max(16, Math.min(256, h)),
      palette,
    })
    useEditor.getState().newProject(project)
    onOpenChange(false)
    setSizeOverride(null)
    setPaletteOverride(null)
    setCustom(null)
    toast({
      title: 'New project created',
      description: `${project.width}×${project.height} · clip "idle"`,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono">New project</DialogTitle>
          <DialogDescription className="font-mono text-xs text-zinc-400">
            {dirty ? 'Warning: unsaved changes in the current project will be lost.' : 'Start a fresh sprite project.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="np-name" className="font-mono text-xs text-zinc-400">Name</Label>
            <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} className="h-8 border-zinc-800 bg-zinc-900 font-mono text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-xs text-zinc-400">Canvas size</Label>
            <Select value={size} onValueChange={setSize}>
              <SelectTrigger className="h-8 border-zinc-800 bg-zinc-900 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIZE_PRESETS.map((s) => (
                  <SelectItem key={s} value={String(s)} className="font-mono text-xs">
                    {s} × {s}
                  </SelectItem>
                ))}
                <SelectItem value="custom" className="font-mono text-xs">
                  Custom…
                </SelectItem>
              </SelectContent>
            </Select>
            {size === 'custom' && (
              <div className="flex items-center gap-2 pt-1">
                <StepperInput value={customW} onChange={(w) => setCustom({ w, h: customH })} min={16} max={256} ariaLabel="Width" className="flex-1 justify-between" />
                <span className="text-zinc-400">×</span>
                <StepperInput value={customH} onChange={(h) => setCustom({ w: customW, h })} min={16} max={256} ariaLabel="Height" className="flex-1 justify-between" />
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-xs text-zinc-400">Palette</Label>
            <Select value={paletteId} onValueChange={setPaletteId}>
              <SelectTrigger className="h-8 border-zinc-800 bg-zinc-900 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PALETTES.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="font-mono text-xs">
                    {p.name} ({p.colors.length})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button className="h-8 w-full bg-teal-600 font-mono text-xs text-white hover:bg-teal-500" onClick={create}>
            Create project
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function OpenProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { toast } = useToast()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [recentFiles, setRecentFiles] = useState<RecentProjectFile[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const currentFilePath = useEditor((s) => s.filePath)

  /** rolling backup snapshots for one project (fresh read each render) */
  const backupsFor = (pid: string) => listBackupSnapshots(pid)

  const refresh = useCallback(async () => {
    setLoading(true)
    if (isDesktop()) setRecentFiles(listRecentProjectFiles())
    try {
      const res = await fetch('/api/projects', { headers: AGENT_FETCH_HEADERS })
      const json = (await res.json()) as { ok: boolean; projects?: ProjectSummary[] }
      setProjects(json.projects ?? [])
    } catch {
      setProjects([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const load = async (id: string) => {
    if (
      useEditor.getState().dirty &&
      !(await confirmDialog({
        title: 'Discard unsaved changes?',
        message: 'Opening this project will lose your unsaved changes.',
        confirmLabel: 'Discard & Open',
        destructive: true,
      }))
    )
      return
    setLoadingId(id)
    try {
      const res = await fetch(`/api/projects/${id}`, { headers: AGENT_FETCH_HEADERS })
      const json = (await res.json()) as { ok: boolean; project?: unknown; error?: unknown }
      if (!json.ok || !isSerializedProject(json.project)) {
        throw new Error(describeApiErrorInline(json.error, 'Corrupt project'))
      }
      const { project } = await importLegacyProjectJson(json.project, id)
      if (!isUsableProject(project)) throw new Error('Project has no usable clips, frames or layers')
      useEditor.getState().loadProject(project, { projectId: id })
      rememberLastProject(id) // refresh restores what YOU loaded, not the last autosave
      onOpenChange(false)
      toast({ title: 'Project loaded', description: project.name })
    } catch (err) {
      toast({
        title: 'Load failed',
        description: friendlyError(err),
        variant: 'destructive',
      })
    } finally {
      setLoadingId(null)
    }
  }

  /** Restore a rolling backup snapshot (last 5 successful saves). */
  const restoreSnapshot = async (id: string, at: string) => {
    const snap = getBackupSnapshot(id, at)
    if (!snap || !isSerializedProject(snap.serialized)) {
      toast({ title: 'Snapshot unusable', variant: 'destructive' })
      return
    }
    if (
      useEditor.getState().dirty &&
      !(await confirmDialog({
        title: 'Discard unsaved changes?',
        message: `Restore the backup from ${new Date(at).toLocaleString()}? Your current canvas will be replaced.`,
        confirmLabel: 'Restore backup',
        destructive: true,
      }))
    )
      return
    setLoadingId(`bk-${at}`)
    try {
      const { project } = await importLegacyProjectJson(snap.serialized, id)
      if (!isUsableProject(project)) throw new Error('Snapshot has no usable content')
      useEditor.getState().loadProject(project, { projectId: id })
      rememberLastProject(id)
      toast({ title: 'Backup restored', description: `Snapshot from ${new Date(at).toLocaleString()}` })
    } catch (err) {
      toast({ title: 'Restore failed', description: friendlyError(err), variant: 'destructive' })
    } finally {
      setLoadingId(null)
    }
  }

  const loadFile = async (file: RecentProjectFile) => {
    if (
      useEditor.getState().dirty &&
      !(await confirmDialog({
        title: 'Discard unsaved changes?',
        message: 'Opening this project will lose your unsaved changes.',
        confirmLabel: 'Discard & Open',
        destructive: true,
      }))
    )
      return
    setLoadingId(file.path)
    try {
      if (await openRecentProjectFromPath(file.path)) onOpenChange(false)
    } finally {
      setLoadingId(null)
    }
  }

  const forgetFile = async (file: RecentProjectFile) => {
    setLoadingId(`forget:${file.path}`)
    try {
      const bridge = getBridge()
      if (!bridge) throw new Error('Desktop file access is unavailable.')
      await bridge.project.forgetRecent(file.path)
      forgetRecentProjectFile(file.path)
      setRecentFiles((items) => items.filter((item) => item.path !== file.path))
      toast({ title: 'Removed from Recents', description: `${file.name} stays on your computer.` })
    } catch (err) {
      toast({ title: 'Could not remove recent project', description: friendlyError(err), variant: 'destructive' })
    } finally {
      setLoadingId(null)
    }
  }

  const trashFile = async (file: RecentProjectFile) => {
    if (file.path === currentFilePath) {
      toast({
        title: 'Project is currently open',
        description: 'Open or create another project before moving this file to the Recycle Bin.',
        variant: 'destructive',
      })
      return
    }
    setLoadingId(`trash:${file.path}`)
    try {
      const bridge = getBridge()
      if (!bridge) throw new Error('Desktop file access is unavailable.')
      const result = await bridge.project.trashRecent(file.path)
      if (!result.trashed) return // native confirmation was cancelled
      forgetRecentProjectFile(file.path)
      setRecentFiles((items) => items.filter((item) => item.path !== file.path))
      toast({ title: 'Moved to Recycle Bin', description: `${file.name} can be restored from Windows if needed.` })
    } catch (err) {
      toast({ title: 'Could not move project to Recycle Bin', description: friendlyError(err), variant: 'destructive' })
    } finally {
      setLoadingId(null)
    }
  }

  const remove = async (id: string, name: string) => {
    if (
      !(await confirmDialog({
        title: `Delete "${name}"?`,
        message: 'This permanently removes the project from the local database.',
        confirmLabel: 'Delete',
        destructive: true,
      }))
    )
      return
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE', headers: AGENT_FETCH_HEADERS })
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: unknown } | null
      if (!res.ok || !json?.ok) {
        throw new Error(describeApiErrorInline(json?.error, `Delete failed (HTTP ${res.status})`))
      }
      await refresh()
      toast({ title: 'Project deleted' })
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: friendlyError(err),
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono">Open project</DialogTitle>
          <DialogDescription className="font-mono text-xs text-zinc-400">
            {isDesktop()
              ? 'Your recent .pixelforgeproj files are listed below. Use From file to choose another saved project.'
              : 'Saved projects live in the local database.'}
          </DialogDescription>
        </DialogHeader>
        {isDesktop() && (
          <Button
            variant="outline"
            className="h-8 w-full border-teal-700/60 font-mono text-xs text-teal-300 hover:bg-teal-900/30"
            onClick={() => void (async () => {
              if (await openProjectFileViaDialog()) onOpenChange(false)
            })()}
          >
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" /> From file (.pixelforgeproj)…
          </Button>
        )}
        <div className="pixelforge-scroll max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {loading && (
            <div className="flex items-center justify-center py-8 text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
          {!loading && recentFiles.length === 0 && projects.length === 0 && (
            <p className="py-8 text-center font-mono text-xs text-zinc-400">
              No saved projects yet — press Save, then choose a file name and folder.
            </p>
          )}
          {recentFiles.map((file) => (
            <div
              key={file.path}
              className="flex items-center gap-2 rounded-md border border-teal-900/60 bg-teal-950/10 px-3 py-2 hover:border-teal-700"
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-teal-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs text-zinc-200">{file.name}</p>
                <p className="truncate font-mono text-[10px] text-zinc-400">{file.path}</p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-zinc-400 hover:text-zinc-100"
                  onClick={() => void forgetFile(file)}
                  disabled={loadingId !== null}
                  aria-label={`Remove ${file.name} from Recents`}
                  title="Remove from Recents (keeps the file)"
                >
                  {loadingId === `forget:${file.path}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-red-400/70 hover:text-red-300"
                  onClick={() => void trashFile(file)}
                  disabled={loadingId !== null || file.path === currentFilePath}
                  aria-label={`Move ${file.name} to Recycle Bin`}
                  title={file.path === currentFilePath ? 'Open another project before deleting this file' : 'Move file to Recycle Bin'}
                >
                  {loadingId === `trash:${file.path}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  size="sm"
                  className="h-7 bg-teal-600 font-mono text-xs text-white hover:bg-teal-500"
                  onClick={() => void loadFile(file)}
                  disabled={loadingId !== null}
                >
                  {loadingId === file.path ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Open'}
                </Button>
              </div>
            </div>
          ))}
          {projects.map((p) => (
            <Fragment key={p.id}>
              <div
                className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 hover:border-zinc-600"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-zinc-200">{p.name}</p>
                  <p className="font-mono text-[10px] text-zinc-400">
                    {p.width}×{p.height} · {new Date(p.updatedAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-red-400/70 hover:text-red-300"
                  onClick={() => remove(p.id, p.name)}
                  aria-label={`Delete ${p.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  className="h-7 bg-teal-600 font-mono text-xs text-white hover:bg-teal-500"
                  onClick={() => load(p.id)}
                  disabled={loadingId === p.id}
                >
                  {loadingId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Load'}
                </Button>
              </div>
              {backupsFor(p.id).length > 0 && (
                <div className="mt-0.5 rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                  <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">
                    Backup snapshots (last 5 saves)
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {backupsFor(p.id).map((b) => (
                      <button
                        key={b.at}
                        type="button"
                        className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-300 hover:border-teal-500/50 hover:text-teal-300 disabled:opacity-50"
                        onClick={() => void restoreSnapshot(p.id, b.at)}
                        disabled={loadingId !== null}
                        title={`Restore backup from ${new Date(b.at).toLocaleString()}`}
                      >
                        {loadingId === `bk-${b.at}` ? <Loader2 className="h-3 w-3 animate-spin" /> : new Date(b.at).toLocaleTimeString()}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Fragment>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ResizeCanvasDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const project = useEditor((s) => s.project)
  const resizeCanvas = useEditor((s) => s.resizeCanvas)
  const [w, setW] = useState(project.width)
  const [h, setH] = useState(project.height)
  // 'custom' whenever W×H isn't a square preset (e.g. 48×40) or steppers move
  const [size, setSize] = useState('custom')
  // re-sync steppers each time the dialog opens (sizes follow the open doc)
  const [seenOpen, setSeenOpen] = useState(false)
  if (open && !seenOpen) {
    setW(project.width)
    setH(project.height)
    setSize(SIZE_PRESETS.includes(project.width) && project.width === project.height ? String(project.width) : 'custom')
    setSeenOpen(true)
  }
  if (!open && seenOpen) setSeenOpen(false)

  const setBoth = (v: string) => {
    setSize(v)
    if (v !== 'custom') {
      setW(parseInt(v, 10))
      setH(parseInt(v, 10))
    }
  }

  const resize = () => {
    resizeCanvas(w, h)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-1 gap-3 border-zinc-800 bg-zinc-950 p-5 text-zinc-100 sm:max-w-xs">
        <DialogHeader>
          <DialogTitle className="font-mono">Resize canvas</DialogTitle>
          <DialogDescription className="font-mono text-xs text-zinc-400">
            Current {project.width}×{project.height} — artwork stays anchored top-left. Applies to every clip and frame.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Select value={size} onValueChange={setBoth}>
            <SelectTrigger size="sm" aria-label="Canvas size preset" className="h-7 w-full border-zinc-800 bg-zinc-900 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SIZE_PRESETS.map((s) => (
                <SelectItem key={s} value={String(s)} className="font-mono text-xs">
                  {s} × {s}
                </SelectItem>
              ))}
              <SelectItem value="custom" className="font-mono text-xs">
                Custom…
              </SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1.5">
            <StepperInput
              value={w}
              onChange={(v) => {
                setW(v)
                setSize('custom')
              }}
              min={16}
              max={256}
              size="sm"
              ariaLabel="Canvas width"
              className="flex-1 justify-between"
            />
            <span className="font-mono text-[10px] text-zinc-400">×</span>
            <StepperInput
              value={h}
              onChange={(v) => {
                setH(v)
                setSize('custom')
              }}
              min={16}
              max={256}
              size="sm"
              ariaLabel="Canvas height"
              className="flex-1 justify-between"
            />
          </div>
          <Button className="h-8 w-full bg-teal-600 font-mono text-xs text-white hover:bg-teal-500" onClick={resize}>
            Resize canvas
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
