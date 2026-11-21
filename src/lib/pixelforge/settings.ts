// PixelForge AI — persisted app settings (localStorage via zustand persist;
// mirrored into the desktop settings file when running in the Electron shell).
// These are app-level preferences, separate from the undoable editor state:
// autosave timing, undo depth, defaults for new projects / fresh sessions,
// and the MCP agent-API switch. Subscription-only product: there are no
// image-generation provider profiles and no API-key settings here — agents
// reason in the artist's own IDE (e.g. Z.AI IDE) and connect through MCP.
//
// LEGACY NOTE: desktop settings files may still carry aiProviders / active-
// ProviderId / brainProviderId and vaulted keys from earlier versions. That
// data is left in place on disk (never deleted silently) but is no longer
// read by this store.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import { isDesktop } from '@/lib/pixelforge/desktop-bridge'

export interface AppSettings {
  /** debounce for background autosave, ms */
  autosaveDelay: number
  /** max undo/redo snapshots kept per project */
  historyLimit: number
  /** fps preselected for new clips / new projects */
  defaultClipFps: number
  /** canvas size preselected in the New project dialog */
  defaultSize: number
  /** palette preselected in the New project dialog */
  defaultPaletteId: string
  /** grid toggle applied when the studio opens */
  showGridDefault: boolean
  /** onion skin applied when the studio opens */
  onionSkinDefault: boolean
  /** onion ghost base opacity 0.05–0.8 (view pref, Task 6) */
  onionOpacity: number
  /** tint applied to previous-frame ghosts (any css color) */
  onionPrevTint: string
  /** tint applied to next-frame ghosts (any css color) */
  onionNextTint: string
  /** expose the MCP editor tools to external AI assistants */
  agentApiEnabled: boolean
  /** port the MCP server listens on (default 3030; must match PF_MCP_PORT) */
  mcpPort: number
  /** size of the floating restore pills (collapsed Preview / View toolbar) */
  floatBtnSize: 'sm' | 'md' | 'lg'
  /** readable compact labels without changing canvas pixels or project data */
  uiTextScale: 'normal' | 'large'
}

export const DEFAULT_SETTINGS: AppSettings = {
  autosaveDelay: 2500,
  historyLimit: 40,
  defaultClipFps: 8,
  defaultSize: 32,
  defaultPaletteId: 'forge16',
  showGridDefault: true,
  onionSkinDefault: true,
  onionOpacity: 0.3,
  onionPrevTint: '#ff5d5d',
  onionNextTint: '#3fbf7f',
  agentApiEnabled: true,
  mcpPort: 3030,
  floatBtnSize: 'md',
  uiTextScale: 'normal',
}

interface SettingsStore extends AppSettings {
  setSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  resetSettings: () => void
  /** apply the main-process settings view (desktop hydrate). */
  applyDesktopView: (view: DesktopSettingsView) => void
}

// --- desktop bridge view (structural type — the ambient bridge d.ts holds
// the canonical copy; duplicated here to keep this module self-contained).
// aiProviders / activeProviderId / brainProviderId may still arrive from
// older desktop builds; they are ignored (legacy data preserved on disk).
export interface DesktopSettingsView {
  version: number
  app: Partial<
    Pick<
      AppSettings,
      | 'autosaveDelay' | 'historyLimit' | 'defaultClipFps' | 'defaultSize'
      | 'defaultPaletteId' | 'showGridDefault' | 'onionSkinDefault'
      | 'onionOpacity' | 'onionPrevTint' | 'onionNextTint' | 'floatBtnSize' | 'uiTextScale'
    >
  >
  mcp: { agentApiEnabled: boolean; bridgeAutoConnect: boolean }
}

// SSR-safe storage (no localStorage on the server)
const memoryStorage: Storage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
}

/** Desktop detection captured at store creation (never true on the server). */
const DESKTOP = typeof window !== 'undefined' && isDesktop()
void DESKTOP

export const useAppSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      setSetting: (key, value) => set({ [key]: value } as Partial<SettingsStore>),
      resetSettings: () => set({ ...DEFAULT_SETTINGS }),
      applyDesktopView: (view) =>
        set((s) => ({
          // app preferences: the main settings file is the desktop source of truth
          ...(view.app.autosaveDelay !== undefined ? { autosaveDelay: view.app.autosaveDelay } : {}),
          ...(view.app.historyLimit !== undefined ? { historyLimit: view.app.historyLimit } : {}),
          ...(view.app.defaultClipFps !== undefined ? { defaultClipFps: view.app.defaultClipFps } : {}),
          ...(view.app.defaultSize !== undefined ? { defaultSize: view.app.defaultSize } : {}),
          ...(view.app.defaultPaletteId !== undefined ? { defaultPaletteId: view.app.defaultPaletteId } : {}),
          ...(view.app.showGridDefault !== undefined ? { showGridDefault: view.app.showGridDefault } : {}),
          ...(view.app.onionSkinDefault !== undefined ? { onionSkinDefault: view.app.onionSkinDefault } : {}),
          ...(view.app.onionOpacity !== undefined ? { onionOpacity: view.app.onionOpacity } : {}),
          ...(view.app.onionPrevTint !== undefined ? { onionPrevTint: view.app.onionPrevTint } : {}),
          ...(view.app.onionNextTint !== undefined ? { onionNextTint: view.app.onionNextTint } : {}),
          ...(view.app.floatBtnSize !== undefined ? { floatBtnSize: view.app.floatBtnSize } : {}),
          ...(view.app.uiTextScale !== undefined ? { uiTextScale: view.app.uiTextScale } : {}),
          ...(view.mcp ? { agentApiEnabled: view.mcp.agentApiEnabled } : {}),
        })),
    }),
    {
      name: 'pixelforge-settings-v1', // same storage key as v0–v5 blobs (migrated in place)
      version: 6,
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' ? window.localStorage : memoryStorage
      ),
      partialize: (s) => ({
        autosaveDelay: s.autosaveDelay,
        historyLimit: s.historyLimit,
        defaultClipFps: s.defaultClipFps,
        defaultSize: s.defaultSize,
        defaultPaletteId: s.defaultPaletteId,
        showGridDefault: s.showGridDefault,
        onionSkinDefault: s.onionSkinDefault,
        onionOpacity: s.onionOpacity,
        onionPrevTint: s.onionPrevTint,
        onionNextTint: s.onionNextTint,
        agentApiEnabled: s.agentApiEnabled,
        mcpPort: s.mcpPort,
        floatBtnSize: s.floatBtnSize,
        uiTextScale: s.uiTextScale,
      }),
      // v6: image-generation providers, API keys and spend limits were removed
      // (subscription-only). Persisted provider fields are dropped from the
      // STORE on migrate; the desktop settings file keeps its legacy fields on
      // disk untouched (data preserved, unused).
      migrate: (persisted) => ({ ...DEFAULT_SETTINGS, ...((persisted ?? {}) as Partial<AppSettings>) }),
      onRehydrateStorage: () => () => {
        /* nothing to scrub — provider fields no longer exist in this store */
      },
    }
  )
)

// --- desktop sync ------------------------------------------------------------

let hydrating = false
let writeTimer: ReturnType<typeof setTimeout> | null = null

function desktopBridge(): PixelForgeBridge['settings'] | null {
  if (typeof window === 'undefined') return null
  const b = window.pixelforge
  return b && b.bridgeVersion >= 4 && b.settings ? b.settings : null
}

/**
 * Desktop hydration: the versioned settings file in the Electron main process
 * is the source of truth for preferences. Called once during studio init.
 * Panel layout hydration lives in panel-storage.ts (async, event-notified).
 */
export async function hydrateDesktopSettings(): Promise<void> {
  const settings = desktopBridge()
  if (!settings) return
  hydrating = true
  try {
    const view = await settings.getAll()
    useAppSettings.getState().applyDesktopView(view)
  } catch {
    /* keep localStorage-persisted prefs when the bridge hiccups */
  } finally {
    hydrating = false
  }
}

/**
 * Desktop write-through: preference changes are mirrored (debounced) into the
 * main-process settings file. Secrets were NEVER part of this path.
 */
export function startDesktopSettingsSync(): () => void {
  if (!desktopBridge()) return () => undefined
  const persistFields = [
    'autosaveDelay', 'historyLimit', 'defaultClipFps', 'defaultSize',
    'defaultPaletteId', 'showGridDefault', 'onionSkinDefault', 'onionOpacity',
    'onionPrevTint', 'onionNextTint', 'floatBtnSize', 'uiTextScale', 'agentApiEnabled',
  ] as const

  const schedule = () => {
    if (hydrating) return
    if (writeTimer) clearTimeout(writeTimer)
    writeTimer = setTimeout(() => {
      writeTimer = null
      const s = useAppSettings.getState()
      const patch = {
        app: {
          autosaveDelay: s.autosaveDelay,
          historyLimit: s.historyLimit,
          defaultClipFps: s.defaultClipFps,
          defaultSize: s.defaultSize,
          defaultPaletteId: s.defaultPaletteId,
          showGridDefault: s.showGridDefault,
          onionSkinDefault: s.onionSkinDefault,
          onionOpacity: s.onionOpacity,
          onionPrevTint: s.onionPrevTint,
          onionNextTint: s.onionNextTint,
          floatBtnSize: s.floatBtnSize,
          uiTextScale: s.uiTextScale,
        },
        mcp: { agentApiEnabled: s.agentApiEnabled },
      }
      void desktopBridge()!.update(patch).catch(() => {
        /* non-fatal: localStorage keeps working */
      })
    }, 300)
  }

  let prev: Partial<Record<(typeof persistFields)[number], unknown>> = {}
  for (const f of persistFields) prev[f] = useAppSettings.getState()[f]
  const unsub = useAppSettings.subscribe((s) => {
    for (const f of persistFields) {
      if (s[f] !== prev[f]) {
        prev[f] = s[f]
        schedule()
      }
    }
  })
  return unsub
}
