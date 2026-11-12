// PixelForge AI — persisted app settings (localStorage via zustand persist;
// mirrored into the desktop settings file when running in the Electron shell —
// Task 13a). These are app-level preferences, separate from the undoable
// editor state: autosave timing, undo depth, defaults for new projects /
// fresh sessions, and AI / MCP connection profiles (Z.AI, GPT, Claude,
// Gemini, custom).
//
// C13 credential rules (Task 13a):
//   • WEB prototype (no bridge): provider.apiKey lives in localStorage
//     plaintext — documented residual, re-visited by the desktop port.
//   • DESKTOP (bridge v4): apiKey is NEVER persisted. The renderer submits
//     it once via the bridge (settings.setApiKey → safeStorage in main) and
//     keeps a session-only runtime copy for the interim /api/ai/sprite call
//     path. After a restart the key stays encrypted in main; the renderer
//     only sees hasKey booleans. Task 9 moves generation in-process and
//     retires the runtime copy entirely.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import { isDesktop } from '@/lib/pixelforge/desktop-bridge'

/** Provider dialects we know how to talk to. `custom` = any OpenAI-compatible endpoint. */
export type AIProviderKind = 'zai' | 'openai' | 'custom'

export interface AIProviderConfig {
  id: string
  label: string
  kind: AIProviderKind
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
}

export const DEFAULT_AI_PROVIDERS: AIProviderConfig[] = [
  {
    id: 'zai',
    label: 'Z.AI (built-in)',
    kind: 'zai',
    baseUrl: '',
    apiKey: '',
    model: 'auto',
    enabled: true,
  },
  {
    id: 'openai',
    label: 'OpenAI · GPT',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-image-1',
    enabled: false,
  },
  {
    id: 'gemini',
    label: 'Google · Gemini',
    kind: 'custom',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: '',
    model: 'gemini-3.1-flash-image',
    enabled: false,
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare · Workers AI',
    kind: 'custom',
    baseUrl: '',
    apiKey: '',
    model: '@cf/black-forest-labs/flux-1-schnell',
    enabled: false,
  },
  {
    id: 'groq',
    label: 'Groq (second brain)',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: '',
    model: 'llama-3.3-70b-versatile',
    enabled: false,
  },
  {
    id: 'custom',
    label: 'Custom / MCP endpoint',
    kind: 'custom',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    model: '',
    enabled: false,
  },
]

/**
 * Curated model suggestions per provider id — latest & most popular first.
 * Providers not listed here (custom endpoints) get a free-text model field.
 * Users can always pick "Custom…" and type any model id.
 */
export const MODEL_PRESETS: Record<string, { id: string; label: string }[]> = {
  zai: [{ id: 'auto', label: 'auto — best available' }],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b — best quality (second brain)' },
    { id: 'llama-3.1-8b-instant', label: 'llama-3.1-8b — instant (fastest)' },
    { id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b — strong reasoning' },
    { id: 'qwen/qwen3-32b', label: 'qwen3-32b — balanced' },
  ],
  openai: [
    { id: 'gpt-image-1', label: 'gpt-image-1 — latest image model' },
    { id: 'gpt-image-1-mini', label: 'gpt-image-1-mini — fast & cheaper' },
    { id: 'dall-e-3', label: 'dall-e-3 — HD illustrations' },
    { id: 'dall-e-2', label: 'dall-e-2 — legacy' },
  ],
  gemini: [
    { id: 'gemini-3.1-flash-image', label: 'gemini-3.1-flash-image — current image model' },
    { id: 'gemini-3.1-flash-lite-image', label: 'gemini-3.1-flash-lite-image — fast image model' },
    { id: 'gemini-3-pro-image', label: 'gemini-3-pro-image — high-fidelity image model' },
    { id: 'gemini-2.5-flash-image', label: 'gemini-2.5-flash-image — legacy (use only if your key supports it)' },
  ],
  cloudflare: [
    { id: '@cf/black-forest-labs/flux-1-schnell', label: 'FLUX.1 Schnell — Workers AI daily free allocation' },
  ],
}

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
  /** AI provider profiles (Z.AI / GPT / Claude / Gemini / custom MCP) */
  aiProviders: AIProviderConfig[]
  /** which enabled provider the Generate panel uses */
  activeProviderId: string
  /** which provider the Brain (reasoning) uses — id from aiProviders; Groq is
   * the default profile, not a hard-wired requirement (shared-Brain phase 3) */
  brainProviderId: string
  /** monthly spending cap in USD (ESTIMATE-based hard stop; 0 = unlimited) */
  aiMonthlyLimitUsd: number
  /** spending warning threshold in USD (0 = off) */
  aiWarnUsd: number
  /** expose the MCP editor tools to external AI assistants */
  agentApiEnabled: boolean
  /** port the MCP server listens on (default 3030; must match PF_MCP_PORT) */
  mcpPort: number
  /** size of the floating restore pills (collapsed Preview / View toolbar) */
  floatBtnSize: 'sm' | 'md' | 'lg'
  /** readable compact labels without changing canvas pixels or project data */
  uiTextScale: 'normal' | 'large'
  // --- runtime-only (never persisted) — desktop secure mode (Task 13a) ---
  /** true when the desktop bridge v4 settings vault is available */
  secureMode: boolean
  /** per-provider credential metadata mirrored from main (hasKey only) */
  keyStatus: Record<string, { hasKey: boolean; sessionOnly: boolean }>
  /** non-null when the OS keyring is unavailable (keys are session-only) */
  encryptionWarning: string | null
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
  aiProviders: DEFAULT_AI_PROVIDERS,
  activeProviderId: 'zai',
  brainProviderId: 'groq',
  aiMonthlyLimitUsd: 5,
  aiWarnUsd: 1,
  agentApiEnabled: true,
  mcpPort: 3030,
  floatBtnSize: 'md',
  uiTextScale: 'normal',
  secureMode: false,
  keyStatus: {},
  encryptionWarning: null,
}

/** The provider used for sprite generation, or null to fall back to built-in. */
export function getActiveProvider(s: Pick<AppSettings, 'aiProviders' | 'activeProviderId'>): AIProviderConfig | null {
  const p = s.aiProviders.find((x) => x.id === s.activeProviderId) ?? null
  if (!p || !p.enabled) return null
  // Old saved settings may still carry kind "anthropic" (removed provider) —
  // treat as unusable so generation falls back to built-in.
  if ((p.kind as string) === 'anthropic') return null
  // Groq is the TEXT "second brain" — it has no image-generation API, so the
  // sprite pipeline must never pick it (the brain reads it by id instead).
  if (p.id === 'groq') return null
  if (p.kind !== 'zai' && !p.apiKey.trim()) return null
  return p
}

/**
 * True when the given provider has a usable key THIS session (desktop):
 * a runtime copy exists (entered this session) or — web prototype — the
 * legacy persisted key is present. The Settings UI uses keyStatus/hasKey for
 * display; this predicate gates the actual generation path.
 */
export function providerHasSessionKey(p: AIProviderConfig): boolean {
  if (p.kind === 'zai') return true
  return p.apiKey.trim() !== ''
}

interface SettingsStore extends AppSettings {
  setSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  resetSettings: () => void
  /** Task 13a: apply the main-process settings view (desktop hydrate). */
  applyDesktopView: (view: DesktopSettingsView) => void
}

// --- desktop bridge view (structural type — the ambient bridge d.ts holds
// the canonical copy; duplicated here to keep this module self-contained)
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
  ai: { monthlyLimitUsd: number; warnUsd: number; cacheEnabled: boolean }
  aiProviders: Array<{
    id: string
    label: string
    kind: AIProviderKind
    baseUrl: string
    model: string
    enabled: boolean
    hasKey: boolean
    sessionOnly: boolean
  }>
  activeProviderId: string
  brainProviderId: string
  credentials: {
    encryptionAvailable: boolean
    backend: string
    sessionOnlyKeys: number
  }
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
          agentApiEnabled: view.mcp.agentApiEnabled,
          ...(view.ai
            ? {
                aiMonthlyLimitUsd: typeof view.ai.monthlyLimitUsd === 'number' ? view.ai.monthlyLimitUsd : s.aiMonthlyLimitUsd,
                aiWarnUsd: typeof view.ai.warnUsd === 'number' ? view.ai.warnUsd : s.aiWarnUsd,
              }
            : {}),
          // provider profiles: merge non-secret fields; runtime apiKey untouched
          // (a key entered this session survives the hydrate)
          aiProviders: s.aiProviders.map((p) => {
            const v = view.aiProviders.find((x) => x.id === p.id)
            return v ? { ...p, label: v.label, kind: v.kind, baseUrl: v.baseUrl, model: v.model, enabled: v.enabled } : p
          }),
          activeProviderId: s.aiProviders.some((p) => p.id === view.activeProviderId) ? view.activeProviderId : s.activeProviderId,
          // reasoning-provider choice rides the desktop settings file too
          // (older main processes without the field keep the localStorage value)
          ...(typeof view.brainProviderId === 'string' ? { brainProviderId: view.brainProviderId } : {}),
          secureMode: true,
          keyStatus: Object.fromEntries(
            view.aiProviders.map((p) => [p.id, { hasKey: p.hasKey, sessionOnly: p.sessionOnly }]),
          ),
          encryptionWarning: view.credentials.encryptionAvailable
            ? null
            : `OS secure storage is unavailable (${view.credentials.backend}). API keys will be kept in memory for this session only and never written to disk.`,
        })),
    }),
    {
      name: 'pixelforge-settings-v1', // same storage key as v0/v1 blobs (migrated in place)
      version: 5,
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' ? window.localStorage : memoryStorage
      ),
      // Task 13a: on the DESKTOP the persisted slice never contains API keys.
      // (The web prototype keeps its legacy behavior — documented residual.)
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
        aiProviders: s.aiProviders.map((p) =>
          DESKTOP ? { ...p, apiKey: '' } : p
        ),
        activeProviderId: s.activeProviderId,
        brainProviderId: s.brainProviderId,
        agentApiEnabled: s.agentApiEnabled,
        mcpPort: s.mcpPort,
        aiMonthlyLimitUsd: s.aiMonthlyLimitUsd,
        aiWarnUsd: s.aiWarnUsd,
        floatBtnSize: s.floatBtnSize,
        uiTextScale: s.uiTextScale,
      }),
      // v0/v1 blobs may carry plaintext keys from an earlier build (or the web
      // prototype sharing this origin in dev): on desktop they are scrubbed
      // ONCE here — never auto-imported into the secure flow (plan C13).
      migrate: (persisted, fromVersion) => {
        const p = (persisted ?? {}) as Partial<AppSettings>
        if (DESKTOP && Array.isArray(p.aiProviders)) {
          p.aiProviders = p.aiProviders.map((x) => ({ ...x, apiKey: '' }))
        }
        // v3: the Anthropic provider was removed — stale persisted entries
        // (and an active pointer to one) are dropped so the Settings card
        // disappears instead of rendering a dead provider.
        if (fromVersion < 3 && Array.isArray(p.aiProviders)) {
          p.aiProviders = p.aiProviders.filter((x) => (x as { kind?: string }).kind !== 'anthropic')
        }
        if (p.activeProviderId === 'anthropic') p.activeProviderId = 'zai'
        // v4: the Groq "second brain" provider was added — older blobs predate
        // it; inject the default entry (before Custom) so the card appears.
        if (Array.isArray(p.aiProviders) && !p.aiProviders.some((x) => (x as { id?: string }).id === 'groq')) {
          const groq = DEFAULT_AI_PROVIDERS.find((x) => x.id === 'groq')
          if (groq) {
            const customIdx = p.aiProviders.findIndex((x) => (x as { id?: string }).id === 'custom')
            p.aiProviders = [...p.aiProviders]
            p.aiProviders.splice(customIdx >= 0 ? customIdx : p.aiProviders.length, 0, { ...groq })
          }
        }
        // v5: Cloudflare Workers AI needs a provider-specific transport rather
        // than the generic OpenAI-compatible path. Add its empty profile; its
        // API token remains absent until the artist explicitly saves one.
        if (Array.isArray(p.aiProviders) && !p.aiProviders.some((x) => (x as { id?: string }).id === 'cloudflare')) {
          const cloudflare = DEFAULT_AI_PROVIDERS.find((x) => x.id === 'cloudflare')
          if (cloudflare) {
            const groqIdx = p.aiProviders.findIndex((x) => (x as { id?: string }).id === 'groq')
            p.aiProviders = [...p.aiProviders]
            p.aiProviders.splice(groqIdx >= 0 ? groqIdx : p.aiProviders.length, 0, { ...cloudflare })
          }
        }
        return { ...DEFAULT_SETTINGS, ...p } as AppSettings & SettingsStore
      },
      onRehydrateStorage: () => (state) => {
        // one-time scrub: if a legacy blob restored plaintext keys on desktop,
        // overwrite the stored slice with the cleaned one immediately
        if (DESKTOP && state && state.aiProviders.some((p) => p.apiKey !== '')) {
          useAppSettings.setState({
            aiProviders: state.aiProviders.map((p) => ({ ...p, apiKey: '' })),
          })
        }
        // Anthropic provider was removed from the app — scrub stale persisted
        // entries on EVERY hydrate (idempotent) so the dead card never renders
        if (state && state.aiProviders.some((p) => (p.kind as string) === 'anthropic')) {
          useAppSettings.setState({
            aiProviders: state.aiProviders.filter((p) => (p.kind as string) !== 'anthropic'),
            ...(state.activeProviderId === 'anthropic' ? { activeProviderId: 'zai' } : {}),
          })
        }
      },
    }
  )
)

// --- Task 13a desktop sync ---------------------------------------------------

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
 * main-process settings file. Secrets are NOT part of this path — the vault
 * methods own them exclusively.
 */
export function startDesktopSettingsSync(): () => void {
  if (!desktopBridge()) return () => undefined
  const persistFields = [
    'autosaveDelay', 'historyLimit', 'defaultClipFps', 'defaultSize',
    'defaultPaletteId', 'showGridDefault', 'onionSkinDefault', 'onionOpacity',
    'onionPrevTint', 'onionNextTint', 'floatBtnSize', 'uiTextScale', 'agentApiEnabled',
    'activeProviderId', 'brainProviderId', 'aiProviders', 'aiMonthlyLimitUsd', 'aiWarnUsd',
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
        ai: { monthlyLimitUsd: s.aiMonthlyLimitUsd, warnUsd: s.aiWarnUsd, cacheEnabled: true },
        activeProviderId: s.activeProviderId,
        brainProviderId: s.brainProviderId,
        aiProviders: s.aiProviders.map((p) => ({
          id: p.id, label: p.label, kind: p.kind, baseUrl: p.baseUrl,
          model: p.model, enabled: p.enabled,
        })),
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

/**
 * Desktop credential flow (C13): submit the plaintext ONCE to main
 * (safeStorage encrypt → settings file), keep a session-only runtime copy so
 * the interim generation path keeps working, and refresh the key-status
 * mirror. Never called on the web prototype.
 */
export async function saveApiKeySecure(providerId: string, plaintext: string): Promise<{ ok: boolean; sessionOnly: boolean; error?: string }> {
  const settings = desktopBridge()
  if (!settings) return { ok: false, sessionOnly: false, error: 'desktop bridge unavailable' }
  try {
    const res = await settings.setApiKey(providerId, plaintext)
    if (res.ok) {
      useAppSettings.setState((s) => ({
        aiProviders: s.aiProviders.map((p) =>
          p.id === providerId ? { ...p, apiKey: plaintext } : p
        ),
        keyStatus: { ...s.keyStatus, [providerId]: { hasKey: true, sessionOnly: res.sessionOnly } },
        encryptionWarning: res.sessionOnly
          ? 'OS secure storage is unavailable — the key is kept in memory for this session only and never written to disk.'
          : s.encryptionWarning,
      }))
    }
    return { ok: res.ok, sessionOnly: res.sessionOnly }
  } catch (err) {
    return { ok: false, sessionOnly: false, error: err instanceof Error ? err.message : 'could not store the key' }
  }
}

/** Desktop: remove a stored credential (main + runtime mirror). */
export async function removeApiKeySecure(providerId: string): Promise<boolean> {
  const settings = desktopBridge()
  if (!settings) return false
  try {
    const removed = await settings.removeKey(providerId)
    if (removed) {
      useAppSettings.setState((s) => ({
        aiProviders: s.aiProviders.map((p) =>
          p.id === providerId ? { ...p, apiKey: '' } : p
        ),
        keyStatus: { ...s.keyStatus, [providerId]: { hasKey: false, sessionOnly: false } },
      }))
    }
    return removed
  } catch {
    return false
  }
}

/** Refresh the key-status mirror from main (after restarts/reconnects). */
export async function refreshKeyStatus(): Promise<void> {
  const settings = desktopBridge()
  if (!settings) return
  try {
    const status = await settings.credentialStatus()
    useAppSettings.setState((s) => ({
      secureMode: true,
      keyStatus: Object.fromEntries(status.providers.map((p) => [p.id, { hasKey: p.hasKey, sessionOnly: p.sessionOnly }])),
      encryptionWarning: status.encryptionAvailable
        ? null
        : `OS secure storage is unavailable (${status.backend}). API keys are kept in memory for this session only and never written to disk.`,
    }))
  } catch {
    /* non-fatal */
  }
}
