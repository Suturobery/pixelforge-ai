/**
 * PixelForge AI — settings file schema (v3.1 §3.1/§8.2; Task 13a).
 *
 * The desktop app keeps ONE versioned settings file in the OS userData dir:
 *   <userData>/settings.json
 *
 * Contents:
 *   • app preferences (mirrors the renderer's zustand settings, no secrets)
 *   • window layout (bounds, maximized) — restored on start
 *   • panel layout (floating palette / preview / view toolbar states)
 *   • MCP connection preferences (master switch, bridge auto-connect)
 *   • AI provider profiles — apiKeyEnc holds safeStorage ciphertext ONLY
 *     (C13). Plaintext keys are never written to this file, never returned
 *     over IPC, and never logged.
 *
 * Hard rules enforced here:
 *   • allowlist validation — unknown fields are dropped, ranges are clamped
 *     to safe values, wrong types fall back to defaults (per-field recovery);
 *   • a wholly unparseable file is recovered as defaults (the caller backs up
 *     the corrupt file first — see store.ts) so the app always starts;
 *   • legacy shapes (missing/unknown version) migrate forward to v1;
 *   • forward (higher) versions are refused → defaults + a migration flag so
 *     an older app binary never writes garbage into a newer file.
 *
 * This module is PURE (no electron, no fs) so bun tests can exercise every
 * rule with a fake environment.
 */

export const SETTINGS_VERSION = 1;

// --------------------------------------------------------------------- types

export type AIProviderKind = 'zai' | 'openai' | 'anthropic' | 'custom';

/** Provider profile as stored in the settings file. `apiKeyEnc` = safeStorage ciphertext, base64. */
export interface StoredProvider {
  id: string;
  label: string;
  kind: AIProviderKind;
  baseUrl: string;
  model: string;
  enabled: boolean;
  /** base64 ciphertext (safeStorage.encryptString). NEVER plaintext. */
  apiKeyEnc?: string;
  /** ISO timestamp of when the key was stored. */
  apiKeyStoredAt?: string;
  /** True when the key lives in memory for this session only (encryption unavailable). */
  apiKeySessionOnly?: boolean;
}

export interface AppPreferences {
  autosaveDelay: number;
  historyLimit: number;
  defaultClipFps: number;
  defaultSize: number;
  defaultPaletteId: string;
  showGridDefault: boolean;
  onionSkinDefault: boolean;
  onionOpacity: number;
  onionPrevTint: string;
  onionNextTint: string;
  floatBtnSize: 'sm' | 'md' | 'lg';
}

export interface WindowLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface PanelLayout {
  /** free-form pixel position (top-left) of a floating panel */
  pos?: { x: number; y: number };
  open?: boolean;
  hidden?: boolean;
  pillPos?: { x: number; y: number };
}

export interface McpPrefs {
  /** MCP master switch (Settings → AI/MCP toggle) */
  agentApiEnabled: boolean;
  /** auto-connect the editor bridge on startup */
  bridgeAutoConnect: boolean;
}

/**
 * AI spend controls (Task 9, plan §3.1 "spend meter + monthly cap" and
 * §3.2 "monthly cap with hard stop"). Additive v1 section — defaults keep
 * old files valid and validation clamps every value.
 */
export interface AiPrefs {
  /** monthly cap in USD (hard stop before submit); 0 = unlimited */
  monthlyLimitUsd: number;
  /** warning threshold in USD (0 = no warning) */
  warnUsd: number;
  /** reuse cached results for identical recipes (hits cost nothing) */
  cacheEnabled: boolean;
}

export interface SettingsFile {
  version: number;
  updatedAt: string;
  app: AppPreferences;
  window: WindowLayout | null;
  panels: Record<string, PanelLayout>;
  mcp: McpPrefs;
  ai: AiPrefs;
  aiProviders: StoredProvider[];
  activeProviderId: string;
}

// ------------------------------------------------------------------ defaults

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
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
  floatBtnSize: 'md',
};

export const DEFAULT_MCP_PREFS: McpPrefs = {
  agentApiEnabled: true,
  bridgeAutoConnect: true,
};

export const DEFAULT_AI_PREFS: AiPrefs = {
  monthlyLimitUsd: 5,
  warnUsd: 1,
  cacheEnabled: true,
};

/** Provider profiles WITHOUT secrets (defaults match the renderer's list). */
export function defaultProviders(): StoredProvider[] {
  return [
    { id: 'zai', label: 'Z.AI (built-in)', kind: 'zai', baseUrl: '', model: 'auto', enabled: true },
    { id: 'openai', label: 'OpenAI · GPT', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', enabled: false },
    { id: 'gemini', label: 'Google · Gemini', kind: 'custom', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash-image', enabled: false },
    { id: 'custom', label: 'Custom / MCP endpoint', kind: 'custom', baseUrl: 'http://localhost:11434/v1', model: '', enabled: false },
  ];
}

export function defaultSettingsFile(now = new Date()): SettingsFile {
  return {
    version: SETTINGS_VERSION,
    updatedAt: now.toISOString(),
    app: { ...DEFAULT_APP_PREFERENCES },
    window: null,
    panels: {},
    mcp: { ...DEFAULT_MCP_PREFS },
    ai: { ...DEFAULT_AI_PREFS },
    aiProviders: defaultProviders(),
    activeProviderId: 'zai',
  };
}

// --------------------------------------------------------------- validation

const PROVIDER_KINDS: readonly AIProviderKind[] = ['zai', 'openai', 'anthropic', 'custom'];
const FLOAT_SIZES: readonly AppPreferences['floatBtnSize'][] = ['sm', 'md', 'lg'];
const PALETTE_ID_RE = /^[a-z0-9_-]{1,64}$/;
const PROVIDER_ID_RE = /^[a-z0-9_-]{1,64}$/;
const CSS_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
export const API_KEY_PROVIDER_RE = PROVIDER_ID_RE;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampFloat(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function pickBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function pickString(v: unknown, max: number, fallback: string, re?: RegExp): string {
  if (typeof v !== 'string') return fallback;
  const s = v.slice(0, max);
  if (re && !re.test(s)) return fallback;
  return s;
}

function pickEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function pickPoint(v: unknown): { x: number; y: number } | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const x = typeof r['x'] === 'number' && Number.isFinite(r['x']) ? Math.round(r['x'] as number) : NaN;
  const y = typeof r['y'] === 'number' && Number.isFinite(r['y']) ? Math.round(r['y'] as number) : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  // sane screen-space bounds (multi-monitor layouts can go somewhat negative)
  if (x < -10000 || x > 20000 || y < -10000 || y > 20000) return undefined;
  return { x, y };
}

/** Base64 sanity for apiKeyEnc (safeStorage ciphertext never contains whitespace). */
function isBase64Ciphertext(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(v);
}

function validateApp(raw: unknown): AppPreferences {
  const d = DEFAULT_APP_PREFERENCES;
  if (typeof raw !== 'object' || raw === null) return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    autosaveDelay: clampInt(r['autosaveDelay'], 500, 60_000, d.autosaveDelay),
    historyLimit: clampInt(r['historyLimit'], 8, 500, d.historyLimit),
    defaultClipFps: clampInt(r['defaultClipFps'], 1, 60, d.defaultClipFps),
    defaultSize: clampInt(r['defaultSize'], 8, 256, d.defaultSize),
    defaultPaletteId: pickString(r['defaultPaletteId'], 64, d.defaultPaletteId, PALETTE_ID_RE),
    showGridDefault: pickBool(r['showGridDefault'], d.showGridDefault),
    onionSkinDefault: pickBool(r['onionSkinDefault'], d.onionSkinDefault),
    onionOpacity: clampFloat(r['onionOpacity'], 0.05, 0.8, d.onionOpacity),
    onionPrevTint: pickString(r['onionPrevTint'], 32, d.onionPrevTint, CSS_COLOR_RE),
    onionNextTint: pickString(r['onionNextTint'], 32, d.onionNextTint, CSS_COLOR_RE),
    floatBtnSize: pickEnum(r['floatBtnSize'], FLOAT_SIZES, d.floatBtnSize),
  };
}

function validateWindow(raw: unknown): WindowLayout | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const width = clampInt(r['width'], 400, 20000, 0);
  const height = clampInt(r['height'], 300, 20000, 0);
  if (width === 0 || height === 0) return null;
  return {
    x: clampInt(r['x'], -10_000, 20_000, 0),
    y: clampInt(r['y'], -10_000, 20_000, 0),
    width,
    height,
    isMaximized: pickBool(r['isMaximized'], false),
  };
}

function validatePanels(raw: unknown): Record<string, PanelLayout> {
  const out: Record<string, PanelLayout> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(key)) continue; // allowlist panel ids
    if (typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    const panel: PanelLayout = {};
    const pos = pickPoint(v['pos']);
    if (pos) panel.pos = pos;
    const pillPos = pickPoint(v['pillPos']);
    if (pillPos) panel.pillPos = pillPos;
    if (typeof v['open'] === 'boolean') panel.open = v['open'];
    if (typeof v['hidden'] === 'boolean') panel.hidden = v['hidden'];
    if (Object.keys(panel).length > 0) out[key] = panel;
  }
  return out;
}

function validateMcp(raw: unknown): McpPrefs {
  const d = DEFAULT_MCP_PREFS;
  if (typeof raw !== 'object' || raw === null) return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    agentApiEnabled: pickBool(r['agentApiEnabled'], d.agentApiEnabled),
    bridgeAutoConnect: pickBool(r['bridgeAutoConnect'], d.bridgeAutoConnect),
  };
}

function validateAi(raw: unknown): AiPrefs {
  const d = DEFAULT_AI_PREFS;
  if (typeof raw !== 'object' || raw === null) return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    monthlyLimitUsd: clampFloat(r['monthlyLimitUsd'], 0, 10_000, d.monthlyLimitUsd),
    warnUsd: clampFloat(r['warnUsd'], 0, 10_000, d.warnUsd),
    cacheEnabled: pickBool(r['cacheEnabled'], d.cacheEnabled),
  };
}

function validateProviders(raw: unknown): StoredProvider[] {
  if (!Array.isArray(raw)) return defaultProviders();
  const out: StoredProvider[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const id = pickString(r['id'], 64, '', PROVIDER_ID_RE);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kind = pickEnum(r['kind'], PROVIDER_KINDS, 'custom');
    const p: StoredProvider = {
      id,
      label: pickString(r['label'], 80, id),
      kind,
      baseUrl: pickString(r['baseUrl'], 512, ''),
      model: pickString(r['model'], 128, ''),
      enabled: pickBool(r['enabled'], false),
    };
    const enc = r['apiKeyEnc'];
    if (typeof enc === 'string' && enc.length > 0) {
      if (isBase64Ciphertext(enc)) {
        p.apiKeyEnc = enc;
        p.apiKeyStoredAt = pickString(r['apiKeyStoredAt'], 40, new Date().toISOString());
        p.apiKeySessionOnly = pickBool(r['apiKeySessionOnly'], false);
      }
      // invalid ciphertext is DROPPED (fail-closed): the key is treated as
      // missing rather than risking a decrypt of corrupted data
    }
    out.push(p);
  }
  if (out.length === 0) return defaultProviders();
  return out;
}

export interface ValidateResult {
  ok: boolean;
  file: SettingsFile;
  /** human-readable reasons when recovery/migration happened */
  notes: string[];
}

/**
 * Validate + migrate a parsed settings object into a v1 SettingsFile.
 * Never throws — every field recovers to a safe default; `ok` is false when
 * the input had to be repaired (caller decides whether to log/persist).
 */
export function validateAndMigrate(raw: unknown, now = new Date()): ValidateResult {
  const notes: string[] = [];

  // wholly invalid → defaults
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      file: defaultSettingsFile(now),
      notes: ['settings payload is not an object — recovered to defaults'],
    };
  }

  const r = raw as Record<string, unknown>;
  let version = typeof r['version'] === 'number' ? Math.floor(r['version']) : 0;

  // FORWARD version (file written by a newer app build) — refuse to interpret
  if (version > SETTINGS_VERSION) {
    return {
      ok: false,
      file: defaultSettingsFile(now),
      notes: [
        `settings version ${version} is newer than supported ${SETTINGS_VERSION} — refusing to read (defaults written on next change)`,
      ],
    };
  }

  // v0 / legacy / unversioned → migrate into v1
  if (version < SETTINGS_VERSION) {
    notes.push(`migrated settings v${version} → v${SETTINGS_VERSION}`);
    version = SETTINGS_VERSION;
  }

  const app = validateApp(r['app']);
  const window = validateWindow(r['window']);
  const panels = validatePanels(r['panels']);
  const mcp = validateMcp(r['mcp']);
  const ai = validateAi(r['ai']);
  const aiProviders = validateProviders(r['aiProviders']);

  let activeProviderId = pickString(r['activeProviderId'], 64, 'zai', PROVIDER_ID_RE);
  if (!aiProviders.some((p) => p.id === activeProviderId)) {
    activeProviderId = aiProviders[0]?.id ?? 'zai';
    notes.push(`activeProviderId not found in providers — reset to ${activeProviderId}`);
  }

  return {
    ok: notes.length === 0,
    file: {
      version: SETTINGS_VERSION,
      updatedAt: typeof r['updatedAt'] === 'string' ? r['updatedAt'].slice(0, 40) : now.toISOString(),
      app,
      window,
      panels,
      mcp,
      ai,
      aiProviders,
      activeProviderId,
    },
    notes,
  };
}

/**
 * Public (IPC) view of a provider: secrets stripped — apiKeyEnc NEVER leaves
 * the main process. This is the shape the renderer is allowed to see.
 */
export interface ProviderView {
  id: string;
  label: string;
  kind: AIProviderKind;
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasKey: boolean;
  sessionOnly: boolean;
  apiKeyStoredAt: string | null;
}

export function toProviderView(p: StoredProvider): ProviderView {
  const hasCipher = typeof p.apiKeyEnc === 'string' && p.apiKeyEnc.length > 0;
  const sessionOnly = p.apiKeySessionOnly === true;
  return {
    id: p.id,
    label: p.label,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.model,
    enabled: p.enabled,
    // a session-only key (no OS keyring) is a usable key — report it
    hasKey: hasCipher || sessionOnly,
    sessionOnly,
    apiKeyStoredAt: p.apiKeyStoredAt ?? null,
  };
}
