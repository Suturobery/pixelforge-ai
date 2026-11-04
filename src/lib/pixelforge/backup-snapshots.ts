// PixelForge AI — rolling backup snapshots (per project, localStorage).
//
// A snapshot is the LEGACY serialized project JSON (the same shape
// importLegacyProjectJson consumes) taken on every successful manual save
// plus a periodic dirty-tick. Ring of 5 per project id — nothing leaves the
// browser/localStorage; the desktop file pipeline keeps its own autosave.
//
// Restore goes through the same load path as Recents (importLegacyProjectJson
// → isUsableProject → loadProject), so a snapshot restores EXACTLY like a
// saved file, undo history cleared by design.

import type { Project } from '@pixelforge/core'

const KEY_PREFIX = 'pixelforge:backups:'
const RING_SIZE = 5

export interface BackupSnapshot {
  at: string
  name: string
  /** legacy serialized project (same JSON the .pixelforgeproj file carries) */
  serialized: unknown
}

function storageKey(projectId: string): string {
  return KEY_PREFIX + projectId
}

function readAll(projectId: string): BackupSnapshot[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as BackupSnapshot[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(projectId: string, list: BackupSnapshot[]): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(list))
  } catch {
    // quota exceeded — drop the oldest half and retry once
    try {
      const trimmed = readAll(projectId).slice(Math.ceil(RING_SIZE / 2))
      localStorage.setItem(storageKey(projectId), JSON.stringify(trimmed))
    } catch {
      /* storage unavailable — backups silently off */
    }
  }
}

/** Push a snapshot (called after saves; the caller owns serialization). */
export function pushBackupSnapshot(projectId: string, project: Project, serialized: unknown): void {
  if (!projectId) return
  const list = readAll(projectId)
  list.unshift({ at: new Date().toISOString(), name: project.name, serialized })
  // dedupe identical consecutive snapshots (content hash on the JSON)
  const last = list[1]
  if (last && JSON.stringify(last.serialized) === JSON.stringify(serialized)) {
    list.shift() // nothing changed since the last snapshot — drop the dupe
  }
  writeAll(projectId, list.slice(0, RING_SIZE))
}

export function listBackupSnapshots(projectId: string): Array<{ at: string; name: string }> {
  return readAll(projectId).map((s) => ({ at: s.at, name: s.name }))
}

export function getBackupSnapshot(projectId: string, at: string): BackupSnapshot | null {
  return readAll(projectId).find((s) => s.at === at) ?? null
}

export function clearBackupSnapshots(projectId: string): void {
  try {
    localStorage.removeItem(storageKey(projectId))
  } catch {
    /* noop */
  }
}
