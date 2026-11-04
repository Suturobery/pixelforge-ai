// PixelForge AI — last-session restore (web).
//
// Refresh resets the in-memory document by design (the store is not
// persisted); this module makes the boot path reopen whatever the save
// hook stored last, so a refresh continues where the artist left off.
// Only the project ID rides in localStorage — the document itself lives
// in SQLite via /api/projects (single source of truth, no stale-copy risk).

import { useEditor, isUsableProject } from '@/lib/pixelforge/store'
import { importLegacyProjectJson, isSerializedProject } from '@/lib/pixelforge/project-io'
import { AGENT_FETCH_HEADERS } from '@/lib/pixelforge/agent-headers'

const KEY = 'pixelforge:lastProjectId'

export function rememberLastProject(id: string): void {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* private mode — restore just won't work */
  }
}

/**
 * Reopen the last saved project if the editor is still pristine (fresh
 * untitled boot — never clobber in-flight work). Returns the project name
 * on success, null when there is nothing (or nothing usable) to restore.
 */
export async function restoreLastProject(): Promise<string | null> {
  let id: string | null = null
  try {
    id = localStorage.getItem(KEY)
  } catch {
    return null
  }
  if (!id) return null

  const st = useEditor.getState()
  if (st.projectId || st.dirty) return null

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { headers: AGENT_FETCH_HEADERS })
    const json = (await res.json()) as { ok: boolean; project?: unknown }
    if (!json.ok || !isSerializedProject(json.project)) return null
    const { project } = await importLegacyProjectJson(json.project, id)
    if (!isUsableProject(project)) return null
    const cur = useEditor.getState()
    if (cur.projectId || cur.dirty) return null // raced — keep the current doc
    cur.loadProject(project, { projectId: id })
    return project.name
  } catch {
    return null // deleted or unreachable — a fresh start is the honest default
  }
}
