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
  savePixelforgeproj,
  type Project,
} from '@pixelforge/core'
import { describePersistError } from './project-io'
import { getBus, setJournalFlushHook, useEditor } from './store'
import { isDesktop, makeBridgeFs, getBridge, PROJECT_FILE_FILTERS } from './desktop-bridge'
import { rememberRecentProjectFile } from './recent-files'
import { toast } from '@/hooks/use-toast'
import { confirmDialog } from '@/components/ui/confirm-dialog'

// ---------------------------------------------------------------------------
// single-file save discipline (no external .journal / .autosave sidecar spam)
// ---------------------------------------------------------------------------

let desktopSaveInFlight = false

/** Clear any legacy sidecar flush hook so saving never spawns extra files. */
function setFileTarget(_filePath: string | null): void {
  setJournalFlushHook(null)
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

/** Derive the clean file stem from a chosen `.pixelforgeproj` path. */
function fileStemFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.pixelforgeproj$/i, '').trim()
}

/** Save to the current file path in place (falls back to Save As when none).
 *  Always updates the existing `filePath` rather than creating duplicate
 *  renamed files when the in-memory project title differs. */
export async function saveProjectFile(): Promise<boolean> {
  if (!isDesktop()) return false
  const st = useEditor.getState()
  const path = st.filePath
  if (!path) return await saveProjectFileAs()
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
  const stem = fileStemFromPath(picked.path)
  if (stem && (!st.project.name || st.project.name === 'untitled')) {
    st.setName(stem)
  }
  return await saveProjectToPath(picked.path)
}

/** Core atomic save to a known path (dialog flows + autosave + dev harness).
 *  Writes strictly to `path` in-place (via atomic `.tmp` rename) without
 *  creating extra backup folders, `.journal` sidecars, or `.autosave` copies. */
export async function saveProjectToPath(
  path: string,
  previousPath?: string,
  opts?: { silent?: boolean },
): Promise<boolean> {
  const bridge = getBridge()
  if (!bridge) return false
  if (desktopSaveInFlight) return false
  desktopSaveInFlight = true
  const st = useEditor.getState()
  st.setSavingFile(true)
  try {
    const fs = makeBridgeFs()
    await savePixelforgeproj(fs, path, getBus().getProject(), {
      noBackup: true,
      keepBackups: 0,
      journalRecords: [],
    })
    await bridge.project.rememberCurrentPath(path)
    useEditor.getState().setFilePath(path)
    useEditor.getState().markSaved()
    setFileTarget(path)
    rememberRecentProjectFile(path, useEditor.getState().project.name)

    // Clean up any legacy autosave sidecar if one existed from an older build
    const legacyAutosave = autosavePathFor(path)
    try {
      if (await fs.exists(legacyAutosave)) {
        await fs.unlink(legacyAutosave)
      }
    } catch {
      /* ignore best-effort cleanup */
    }

    if (previousPath && previousPath !== path) {
      try {
        await fs.unlink(previousPath)
      } catch {
        /* stale file left behind is harmless — next save won't target it */
      }
    }
    return true
  } catch (err) {
    if (!opts?.silent) {
      toast({
        title: 'Save failed',
        description: describePersistError(err),
        variant: 'destructive',
      })
    } else {
      console.warn('[pixelforge] autosave failed:', describePersistError(err))
    }
    return false
  } finally {
    desktopSaveInFlight = false
    useEditor.getState().setSavingFile(false)
  }
}

/** Debounced desktop autosave — updates the existing `.pixelforgeproj` file
 *  in-place instead of creating a duplicate `.autosave.pixelforgeproj` file. */
export async function autosaveProjectFile(): Promise<void> {
  if (!isDesktop()) return
  const st = useEditor.getState()
  const path = st.filePath
  if (!path || !st.dirty || st.savingFile || desktopSaveInFlight) return
  await saveProjectToPath(path, undefined, { silent: true })
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
