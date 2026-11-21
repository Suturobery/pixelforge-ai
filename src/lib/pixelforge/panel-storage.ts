// PixelForge AI — panel layout storage (Task 13a).
//
// The three floating panels (palette / preview / view toolbar) keep using
// their own localStorage keys as the IMMEDIATE store (zero-risk for the web
// prototype and for desktop first-paint). On the DESKTOP, this module also
// mirrors every panel write into the versioned settings file held by the
// Electron main process (v3.1: "layout persistence moves from localStorage
// to app settings file"), and hydrates localStorage FROM that file at
// startup — so panel layout survives cache clears and follows the user's
// OS account.
//
// Keys are namespaced by panel id in the settings file (`panels.<id>`), and
// the raw localStorage shape of each panel is preserved verbatim (pos/open/
// hidden/pillPos), so the components stay dumb.

import { isDesktop } from '@/lib/pixelforge/desktop-bridge'

/** localStorage key ⇄ settings-file panel id. */
export const PANEL_IDS = {
  'pixelforge-palette-v1': 'palette',
  'pixelforge-preview-v1': 'preview',
  'pixelforge-viewbar-v1': 'view-toolbar',
} as const

export type PanelStorageKey = keyof typeof PANEL_IDS
export type PanelId = (typeof PANEL_IDS)[PanelStorageKey]

const HYDRATED_EVENT = 'pf-panels-hydrated'

/** One-time discard of stale pill positions (v2 layout reset): old dragged
 *  spots could strand pills mid-canvas after window/layout changes. Runs
 *  once per browser; after this, pills sit at their home anchors until the
 *  user drags them again. Desktop: the settings-file panel layouts are
 *  cleared too (after hydration, since that re-applies the file state). */
const RESET_FLAG = 'pixelforge:panels-reset-v2'
let resetStarted = false
export function resetPanelLayoutsOnce(): void {
  if (typeof window === 'undefined' || resetStarted) return
  resetStarted = true
  try {
    if (localStorage.getItem(RESET_FLAG) === '1') return
    localStorage.setItem(RESET_FLAG, '1')
  } catch {
    return
  }
  const clearLocal = () => {
    for (const key of Object.keys(PANEL_IDS)) {
      try {
        localStorage.removeItem(key)
      } catch {
        /* storage unavailable */
      }
    }
  }
  const clearDesktopFile = () => {
    if (!isDesktop()) return
    const bridge = window.pixelforge
    if (!bridge?.settings) return
    const empty: Record<string, Record<string, never>> = {}
    for (const panelId of Object.values(PANEL_IDS)) empty[panelId] = {}
    void bridge.settings.update({ panels: empty }).catch(() => undefined)
  }
  // web: clear immediately. Desktop: wait for hydration (it re-applies the
  // settings file), clear both stores, then re-emit so panels re-read.
  void panelsReady.then(() => {
    clearLocal()
    clearDesktopFile()
    window.dispatchEvent(new CustomEvent(HYDRATED_EVENT))
  })
}

/** Resolves once the desktop hydration pass has written localStorage (web: resolves immediately). */
let hydrationDone = false
export const panelsReady: Promise<void> = (() => {
  if (typeof window === 'undefined' || !isDesktop()) {
    hydrationDone = true
    return Promise.resolve()
  }
  const bridge = window.pixelforge
  if (!bridge?.settings) {
    hydrationDone = true
    return Promise.resolve()
  }
  return bridge.settings
    .getAll()
    .then((view) => {
      for (const [storageKey, panelId] of Object.entries(PANEL_IDS)) {
        const layout = view.panels?.[panelId]
        try {
          if (layout) window.localStorage.setItem(storageKey, JSON.stringify(layout))
        } catch {
          /* storage unavailable — positions fall back to defaults */
        }
      }
      hydrationDone = true
      // panels that already read localStorage re-sync (they re-run loadSaved)
      window.dispatchEvent(new CustomEvent(HYDRATED_EVENT))
    })
    .catch(() => {
      hydrationDone = true
      /* settings unavailable — keep localStorage as-is */
    })
})()

/** Read a panel's raw persisted shape (same contract as before — sync). */
export function loadPanelRaw(key: PanelStorageKey): unknown | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

let panelWriteTimer: ReturnType<typeof setTimeout> | null = null
let pendingPanelPatch: Record<string, Record<string, never>> = {}

/**
 * Persist a panel's raw shape: localStorage immediately (web + desktop) and,
 * desktop only, mirrored (debounced) into the versioned settings file so
 * dragging a floating panel at 60Hz does not hammer disk I/O on every frame.
 */
export function savePanelRaw(key: PanelStorageKey, value: unknown): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
  if (!isDesktop()) return
  const bridge = window.pixelforge
  const panelId = PANEL_IDS[key]
  if (!bridge?.settings || !panelId) return
  pendingPanelPatch[panelId] = value as Record<string, never>
  if (panelWriteTimer) clearTimeout(panelWriteTimer)
  panelWriteTimer = setTimeout(() => {
    panelWriteTimer = null
    const patch = pendingPanelPatch
    pendingPanelPatch = {}
    void bridge.settings.update({ panels: patch }).catch(() => {
      /* mirror failure is non-fatal */
    })
  }, 250)
}

/** Subscribe to the desktop hydration pass (panels re-read their saved shape).
 * Fires immediately when hydration already completed before subscribing. */
export function onPanelsHydrated(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  window.addEventListener(HYDRATED_EVENT, handler)
  if (hydrationDone) handler()
  return () => window.removeEventListener(HYDRATED_EVENT, handler)
}
