// PixelForge AI — project file flows (Task 4 native desktop integration).
//
// Orchestrates .pixelforgeproj open/save/save-as/autosave through the
// Electron preload bridge. The heavy lifting is @pixelforge/core's
// persistence (loadPixelforgeproj / savePixelforgeproj / saveAutosave /
// inspectRecovery) — this module only:
//   • shows native dialogs (main process),
//   • feeds core a FileFs adapter over the allowlisted bridge transport,
//   • prompts for recovery (newer autosave / pending journal records),
//   • keeps the store's filePath/dirty state truthful,
//   • throttles the journal sidecar flush (crash window ≈ 5 s).
//
// The web prototype keeps its SQLite storage adapter (use-save.ts) — this
// module is inert without the bridge.

import {
  autosavePathFor,
  inspectRecovery,
  loadPixelforgeproj,
  saveAutosave,
  savePixelforgeproj,
  recordsToLines,
  type JournalRecord,
  type Project,
} from '@pixelforge/core'
import { describePersistError } from './project-io'
import { getBus, getRecorder, setJournalFlushHook, useEditor } from './store'
import { isDesktop, makeBridgeFs, getBridge, PROJECT_FILE_FILTERS } from './desktop-bridge'
import { rememberRecentProjectFile } from './recent-files'
import { toast } from '@/hooks/use-toast'
import { confirmDialog } from '@/components/ui/confirm-dialog'

// ---------------------------------------------------------------------------
// journal sidecar flush (throttled full-ring rewrite)
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 5000

let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushInProgress = false
let flushDirty = false

function sidecarPathFor(filePath: string): string {
  return `${filePath}.journal`
}

async function writeSidecar(filePath: string, records: JournalRecord[]): Promise<void> {
  const bridge = getBridge()
  if (!bridge) return
  const lines = recordsToLines(records)
  const body = lines.length > 0 ? lines.join('\n') + '\n' : ''
  await bridge.project.fs.writeFile(sidecarPathFor(filePath), new TextEncoder().encode(body))
}

function scheduleFlush(): void {
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null
      void runFlush()
    }, FLUSH_INTERVAL_MS)
  }
}

async function runFlush(): Promise<void> {
  const filePath = useEditor.getState().filePath
  if (!filePath || flushInProgress) {
    if (flushDirty) scheduleFlush()
    return
  }
  flushInProgress = true
  try {
    await writeSidecar(filePath, getRecorder().all() as JournalRecord[])
    flushDirty = false
  } catch {
    // best-effort: retry on the next command
    flushDirty = true
  } finally {
    flushInProgress = false
    if (flushDirty) scheduleFlush()
  }
}

/** Install/clear the throttled sidecar flush (call on path changes). */
function setFileTarget(filePath: string | null): void {
  if (filePath) {
    setJournalFlushHook(() => scheduleFlush())
    scheduleFlush()
  } else {
    setJournalFlushHook(null)
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

/**
 * Open a .pixelforgeproj via the native Open dialog. Handles:
 *   dirty confirm → dialog → core load (typed errors) → recovery prompt
 *   (newer autosave / pending journal records) → load into the bus.
 */
export async function openProjectFileViaDialog(): Promise<boolean> {
  const bridge = getBridge()
  if (!bridge) {
    toast({ title: 'Open unavailable', description: 'Desktop file access is unavailable.', variant: 'destructive' })
    return false
  }
  const st = useEditor.getState()
  if (
    st.dirty &&
    !(await confirmDialog({
      title: 'Discard unsaved changes?',
      message: 'Opening another project will lose your unsaved changes.',
      confirmLabel: 'Discard & Open',
      destructive: true,
    }))
  )
    return false

  try {
    const picked = await bridge.project.pickOpen({ filters: PROJECT_FILE_FILTERS })
    if (picked.canceled || !picked.paths[0]) return false
    return await openProjectFromPath(picked.paths[0])
  } catch (err) {
    toast({ title: 'Could not open file picker', description: describePersistError(err), variant: 'destructive' })
    return false
  }
}

/**
 * Open a project from a known path (dialog result / recent file / dev
 * harness). Recovery rules:
 *   • pending journal records newer than the file  → offer replay,
 *   • autosave newer than the main file            → offer the autosave.
 */
export async function openProjectFromPath(path: string): Promise<boolean> {
  const bridge = getBridge()
  if (!bridge) return false
  const fs = makeBridgeFs()
  try {
    const result = await loadPixelforgeproj(fs, path, { id: null })
    let project: Project = result.project

    const pending = result.recovery.pendingRecords.length
    const newerAutosave = result.recovery.autosaveExists && result.recovery.autosaveNewerThanMain
    if (pending > 0 || newerAutosave) {
      const what = [
        pending > 0 ? `${pending} command(s) newer than the saved file` : null,
        newerAutosave ? 'a newer autosave' : null,
      ]
        .filter(Boolean)
        .join(' and ')
      const recover = await confirmDialog({
        title: 'Recover unsaved work?',
        message: `Recovery data found for this project: ${what}.\nCancel opens the last saved state.`,
        confirmLabel: 'Recover',
      })
      if (recover) {
        try {
          if (newerAutosave) {
            const auto = await loadPixelforgeproj(fs, autosavePathFor(path), { id: null })
            project = auto.project
            if (auto.recovery.pendingRecords.length > 0) {
              project = auto.replayPending().project
            }
          } else {
            project = result.replayPending().project
          }
        } catch (err) {
          toast({
            title: 'Recovery failed',
            description: `${describePersistError(err)} — opened the last saved state.`,
            variant: 'destructive',
          })
        }
      }
    }

    useEditor.getState().loadProject(project, { filePath: path, projectId: null })
    useEditor.getState().markSaved()
    setFileTarget(path)
    rememberRecentProjectFile(path, project.name)
    const warnings = result.warnings.filter((w) => !w.startsWith('journal holds') && !w.startsWith('an autosave'))
    if (warnings.length > 0) {
      toast({ title: 'Project loaded (with warnings)', description: warnings.slice(0, 2).join(' · ') })
    } else {
      toast({ title: 'Project opened', description: path.split('/').pop() ?? path })
    }
    return true
  } catch (err) {
    toast({
      title: 'Could not open project',
      description: describePersistError(err),
      variant: 'destructive',
    })
    return false
  }
}

/** Re-open a previously native-picker-approved project from Recents. */
export async function openRecentProjectFromPath(path: string): Promise<boolean> {
  const bridge = getBridge()
  if (!bridge) return false
  try {
    await bridge.project.openRecent(path)
  } catch {
    toast({
      title: 'Recent project needs approval',
      description: 'Choose it again with From file to restore access.',
      variant: 'destructive',
    })
    return false
  }
  return openProjectFromPath(path)
}

// ---------------------------------------------------------------------------
// save / save-as / autosave
// ---------------------------------------------------------------------------

/** Filesystem-safe project filename from the project name. */
function projectFileName(name: string): string {
  const safe = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${safe || 'untitled'}.pixelforgeproj`
}

/** Save to the current file path (falls back to Save As when none).
 *  The FILE NAME follows the project name: renaming a project re-targets
 *  the save to `<project name>.pixelforgeproj` and removes the stale file,
 *  so file listings always match what the tester sees. */
export async function saveProjectFile(): Promise<boolean> {
  if (!isDesktop()) return false
  const st = useEditor.getState()
  const path = st.filePath
  if (!path) return await saveProjectFileAs()

  const currentName = path.split(/[\\/]/).pop() ?? ''
  const desired = projectFileName(st.project.name || 'untitled')
  if (currentName !== desired) {
    const dir = path.slice(0, path.length - currentName.length)
    const renamed = dir + desired
    const ok = await saveProjectToPath(renamed, path)
    return ok
  }
  return await saveProjectToPath(path)
}

/** Native Save As dialog → core atomic save. */
export async function saveProjectFileAs(): Promise<boolean> {
  const bridge = getBridge()
  if (!bridge) return false
  const st = useEditor.getState()
  const suggested = `${st.project.name || 'untitled'}.pixelforgeproj`
  const picked = await bridge.project.pickSave({
    filters: PROJECT_FILE_FILTERS,
    defaultPath: suggested,
  })
  if (picked.canceled || !picked.path) return false
  return await saveProjectToPath(picked.path)
}

/** Core atomic save to a known path (dialog flows + dev harness).
 *  previousPath: when the save RETARGETS (project renamed), the stale file
 *  is removed after a successful write so no duplicate/stale copies linger. */
export async function saveProjectToPath(path: string, previousPath?: string): Promise<boolean> {
  const bridge = getBridge()
  if (!bridge) return false
  const st = useEditor.getState()
  st.setSavingFile(true)
  try {
    const fs = makeBridgeFs()
    await savePixelforgeproj(fs, path, getBus().getProject(), { recorder: getRecorder() })
    await bridge.project.rememberCurrentPath(path)
    useEditor.getState().setFilePath(path)
    useEditor.getState().markSaved()
    setFileTarget(path)
    rememberRecentProjectFile(path, st.project.name)
    if (previousPath && previousPath !== path) {
      try {
        await fs.unlink(previousPath)
      } catch {
        /* stale file left behind is harmless — next save won't target it */
      }
    }
    return true
  } catch (err) {
    toast({
      title: 'Save failed',
      description: describePersistError(err),
      variant: 'destructive',
    })
    return false
  } finally {
    useEditor.getState().setSavingFile(false)
  }
}

/** Debounced desktop autosave → <file>.autosave.pixelforgeproj (core atomic path). */
export async function autosaveProjectFile(): Promise<void> {
  if (!isDesktop()) return
  const path = useEditor.getState().filePath
  if (!path || !useEditor.getState().dirty) return
  try {
    const fs = makeBridgeFs()
    await saveAutosave(fs, path, getBus().getProject())
  } catch (err) {
    // autosave must never toast-spam; failures surface on the next manual save
    console.warn('[pixelforge] autosave failed:', describePersistError(err))
  }
}

/** Recovery inspection for the current file (diagnostics / dev harness). */
export async function inspectCurrentFileRecovery(): Promise<{
  pending: number
  newerAutosave: boolean
  autosaveExists: boolean
} | null> {
  if (!isDesktop()) return null
  const path = useEditor.getState().filePath
  if (!path) return null
  try {
    const info = await inspectRecovery(makeBridgeFs(), path)
    return {
      pending: info.pendingRecords.length,
      newerAutosave: info.autosaveNewerThanMain,
      autosaveExists: info.autosaveExists,
    }
  } catch {
    return null
  }
}
