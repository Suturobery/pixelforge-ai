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
 * Legacy note: settings files written by older builds may carry ai /
 * aiProviders / activeProviderId / brainProviderId sections and vaulted API
 * keys. Those fields are no longer part of the schema: they are dropped on
 * the next write (the in-app AI provider stack was removed — agents reason
 * in the artist's IDE over MCP, so the vault had no producer).
 *
 * This module is PURE (no electron, no fs) so bun tests can exercise every
 * rule with a fake environment.
 */

export const SETTINGS_VERSION = 1;

// --------------------------------------------------------------------- types

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
  /** compact PixelForge labels: default density or a one-step larger scale */
  uiTextScale: 'normal' | 'large';
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

export interface SettingsFile {
  version: number;
  updatedAt: string;
  app: AppPreferences;
  window: WindowLayout | null;
  panels: Record<string, PanelLayout>;
  mcp: McpPrefs;
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
  uiTextScale: 'normal',
};

export const DEFAULT_MCP_PREFS: McpPrefs = {
  agentApiEnabled: true,
  bridgeAutoConnect: true,
};

export function defaultSettingsFile(now = new Date()): SettingsFile {
  return {
    version: SETTINGS_VERSION,
    updatedAt: now.toISOString(),
    app: { ...DEFAULT_APP_PREFERENCES },
    window: null,
    panels: {},
    mcp: { ...DEFAULT_MCP_PREFS },
  };
}

// --------------------------------------------------------------- validation

const FLOAT_SIZES: readonly AppPreferences['floatBtnSize'][] = ['sm', 'md', 'lg'];
const UI_TEXT_SCALES: readonly AppPreferences['uiTextScale'][] = ['normal', 'large'];
const PALETTE_ID_RE = /^[a-z0-9_-]{1,64}$/;
const CSS_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

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
    uiTextScale: pickEnum(r['uiTextScale'], UI_TEXT_SCALES, d.uiTextScale),
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
    notes.push(`migrated settings v${version} → ${SETTINGS_VERSION}`);
    version = SETTINGS_VERSION;
  }

  const app = validateApp(r['app']);
  const window = validateWindow(r['window']);
  const panels = validatePanels(r['panels']);
  const mcp = validateMcp(r['mcp']);

  // Detect repairs / dropped fields so ok=false when file had to be repaired
  const ALLOWED_TOP_KEYS = new Set(['version', 'updatedAt', 'app', 'window', 'panels', 'mcp']);
  for (const k of Object.keys(r)) {
    if (!ALLOWED_TOP_KEYS.has(k)) {
      notes.push(`dropped unknown top-level field: ${k}`);
    }
  }

  if (typeof r['app'] === 'object' && r['app'] !== null) {
    const rawApp = r['app'] as Record<string, unknown>;
    const ALLOWED_APP_KEYS = new Set([
      'autosaveDelay', 'historyLimit', 'defaultClipFps', 'defaultSize',
      'defaultPaletteId', 'showGridDefault', 'onionSkinDefault', 'onionOpacity',
      'onionPrevTint', 'onionNextTint', 'floatBtnSize', 'uiTextScale',
    ]);
    for (const k of Object.keys(rawApp)) {
      if (!ALLOWED_APP_KEYS.has(k)) {
        notes.push(`dropped unknown app field: ${k}`);
      }
    }
    for (const [k, v] of Object.entries(app)) {
      if (rawApp[k] !== undefined && rawApp[k] !== v) {
        notes.push(`app.${k} repaired or clamped to safe value`);
      }
    }
  }

  if (typeof r['window'] === 'object' && r['window'] !== null) {
    const rawWin = r['window'] as Record<string, unknown>;
    if (window && (rawWin['width'] !== window.width || rawWin['height'] !== window.height)) {
      notes.push('window dimensions clamped to minimum safe bounds');
    }
  }

  if (typeof r['panels'] === 'object' && r['panels'] !== null) {
    for (const k of Object.keys(r['panels'] as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(k)) {
        notes.push(`dropped invalid panel key: ${k}`);
      }
    }
  }

  if (typeof r['mcp'] === 'object' && r['mcp'] !== null) {
    const rawMcp = r['mcp'] as Record<string, unknown>;
    if (rawMcp['agentApiEnabled'] !== undefined && typeof rawMcp['agentApiEnabled'] !== 'boolean') {
      notes.push('mcp.agentApiEnabled was not a boolean; restored default');
    }
    if (rawMcp['bridgeAutoConnect'] !== undefined && typeof rawMcp['bridgeAutoConnect'] !== 'boolean') {
      notes.push('mcp.bridgeAutoConnect was not a boolean; restored default');
    }
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
    },
    notes,
  };
}
