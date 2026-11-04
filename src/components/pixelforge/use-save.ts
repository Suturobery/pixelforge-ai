// PixelForge AI — save hook (explicit save + autosave share this).
// Task 4 routing:
//   • Desktop with an open .pixelforgeproj → core atomic file save
//     (project-files.ts; backups/journal included).
//   • Otherwise (web prototype, or desktop without a file yet) → the
//     existing SQLite storage adapter (v2 document downgraded to the v1
//     JSON contract the server API speaks — see project-io.ts).

'use client'

import { useCallback, useRef, useState } from 'react'
import { useEditor } from '@/lib/pixelforge/store'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { useEffect } from 'react'
import { exportLegacyProjectJson } from '@/lib/pixelforge/project-io'
import { saveProjectFile } from '@/lib/pixelforge/project-files'
import { isDesktop } from '@/lib/pixelforge/desktop-bridge'
import { useToast } from '@/hooks/use-toast'
import { AGENT_FETCH_HEADERS } from '@/lib/pixelforge/agent-headers'
import { describeApiErrorInline } from '@/lib/pixelforge/api-error'
import { rememberLastProject } from '@/lib/pixelforge/last-session'
import { pushBackupSnapshot } from '@/lib/pixelforge/backup-snapshots'
import { autosaveProjectFile } from '@/lib/pixelforge/project-files'

export function useSaveProject() {
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const { toast } = useToast()

  const save = useCallback(
    async (silent = false) => {
      if (savingRef.current) return
      savingRef.current = true
      setSaving(true)
      try {
        // Desktop: saving to the open file (Save As dialog when no file yet).
        if (isDesktop()) {
          const st0 = useEditor.getState()
          const ok = await saveProjectFile()
          if (ok) {
            // snapshot ring: one entry per successful save (rolling 5)
            if (st0.projectId) pushBackupSnapshot(st0.projectId, st0.project, exportLegacyProjectJson(st0.project))
            if (!silent) {
              const p = useEditor.getState().filePath
              toast({ title: 'Project saved', description: p ?? '' })
            }
          }
          return
        }

        // Web testbed: SQLite adapter (v1 JSON contract).
        const s = useEditor.getState()
        const project = exportLegacyProjectJson(s.project)
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AGENT_FETCH_HEADERS },
          body: JSON.stringify({ id: s.projectId, project }),
        })
        const json = (await res.json()) as { ok: boolean; id?: string; error?: unknown }
        // error may be a structured object ({ code, message, hint }) — e.g. the
        // guard's 403 — so a bare `new Error(json.error)` rendered "[object Object]".
        if (!res.ok || !json.ok) throw new Error(describeApiErrorInline(json.error, 'Save failed'))
        const st = useEditor.getState()
        if (json.id && st.projectId !== json.id) st.setProjectId(json.id)
        if (json.id) {
          rememberLastProject(json.id)
          pushBackupSnapshot(json.id, st.project, project)
        }
        useEditor.getState().markSaved()
        if (!silent) {
          toast({ title: 'Project saved', description: `Stored as ${json.id}` })
        }
      } catch (err) {
        if (!silent) {
          toast({
            title: 'Save failed',
            description: err instanceof Error ? err.message : 'Unknown error',
            variant: 'destructive',
          })
        }
      } finally {
        savingRef.current = false
        setSaving(false)
      }
    },
    [toast]
  )

  // Autosave (setting-gated): debounced silent save while dirty.
  // Web: SQLite adapter. Desktop: the .autosave sidecar file (the main file
  // saves explicitly, preserving Save-As naming choices).
  const editorDirty = useEditor((s) => s.dirty)
  const autosaveOn = useEditor((s) => s.autosave)
  const autosaveDelay = useAppSettings((s) => s.autosaveDelay)
  useEffect(() => {
    if (!autosaveOn || !editorDirty || savingRef.current) return
    const t = setTimeout(() => {
      if (savingRef.current) return
      if (isDesktop()) {
        void autosaveProjectFile()
      } else {
        void save(true)
      }
    }, Math.max(500, autosaveDelay))
    return () => clearTimeout(t)
  }, [editorDirty, autosaveOn, autosaveDelay, save])

  return { save, saving }
}
