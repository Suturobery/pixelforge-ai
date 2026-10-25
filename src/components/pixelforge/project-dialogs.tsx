// PixelForge AI — New / Open project dialogs

'use client'

import { useCallback, useEffect, useState } from 'react'
import { useEditor, isUsableProject } from '@/lib/pixelforge/store'
import { AGENT_FETCH_HEADERS } from '@/lib/pixelforge/agent-headers'
import { describeApiErrorInline } from '@/lib/pixelforge/api-error'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { createProject } from '@/lib/pixelforge/factory'
import { importLegacyProjectJson, isSerializedProject } from '@/lib/pixelforge/project-io'
import { openProjectFileViaDialog } from '@/lib/pixelforge/project-files'
import { isDesktop } from '@/lib/pixelforge/desktop-bridge'
import type { ProjectSummary } from '@/lib/pixelforge/types'
import { PALETTES } from '@/lib/pixelforge/palettes'
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
import { Loader2, Trash2, FolderOpen } from 'lucide-react'

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

  const create = () => {
    // data-loss protection: explicit confirm when switching away from unsaved work
    if (dirty && !window.confirm('Discard unsaved changes and create a new project?')) return
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
  const [loading, setLoading] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
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
    if (useEditor.getState().dirty && !window.confirm('Discard unsaved changes and open this project?')) return
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
      onOpenChange(false)
      toast({ title: 'Project loaded', description: project.name })
    } catch (err) {
      toast({
        title: 'Load failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setLoadingId(null)
    }
  }

  const remove = async (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}" permanently?`)) return
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE', headers: AGENT_FETCH_HEADERS })
      await refresh()
      toast({ title: 'Project deleted' })
    } catch {
      toast({ title: 'Delete failed', variant: 'destructive' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono">Open project</DialogTitle>
          <DialogDescription className="font-mono text-xs text-zinc-400">
            {isDesktop()
              ? 'Saved projects live in the local database — or open a .pixelforgeproj file from disk.'
              : 'Saved projects live in the local database.'}
          </DialogDescription>
        </DialogHeader>
        {isDesktop() && (
          <Button
            variant="outline"
            className="h-8 w-full border-teal-700/60 font-mono text-xs text-teal-300 hover:bg-teal-900/30"
            onClick={() => {
              onOpenChange(false)
              void openProjectFileViaDialog()
            }}
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
          {!loading && projects.length === 0 && (
            <p className="py-8 text-center font-mono text-xs text-zinc-400">
              No saved projects yet — press Save to store the current one.
            </p>
          )}
          {projects.map((p) => (
            <div
              key={p.id}
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
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
