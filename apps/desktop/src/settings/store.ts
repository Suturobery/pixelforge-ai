/**
 * PixelForge AI — settings store (v3.1 §3.1/§8.2; Task 13a).
 *
 * Owns the versioned settings file: load → validate/migrate → atomic writes
 * (tmp + rename in the same directory).
 *
 * The store is PURE: fs is injected, so tests drive it with a fake fs.
 * The Electron wiring lives in main/index.ts.
 *
 * Legacy note: older builds stored an AI-provider credential vault
 * (safeStorage ciphertext) inside this file. That stack was removed —
 * agents reason in the artist's IDE over MCP, so there is no key producer.
 * Legacy ai/aiProviders fields on disk are dropped by schema validation on
 * the next write.
 */

import {
  SETTINGS_VERSION,
  defaultSettingsFile,
  validateAndMigrate,
  type AppPreferences,
  type McpPrefs,
  type PanelLayout,
  type SettingsFile,
  type WindowLayout,
} from './schema';

// ------------------------------------------------------------------- ports

/** Minimal fs surface the store needs (fake-able in tests). */
export interface SettingsFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  /** best-effort 0600 on POSIX; ignored where unsupported */
  chmodSync?(path: string, mode: number): void;
}

export interface SettingsStoreOptions {
  file: string;
  fs: SettingsFs;
  now?: () => Date;
}

// ------------------------------------------------------------------- store

/** IPC-visible settings payload. */
export interface PublicSettings {
  version: number;
  app: AppPreferences;
  window: WindowLayout | null;
  panels: Record<string, PanelLayout>;
  mcp: McpPrefs;
}

export class SettingsStore {
  private readonly file: string;
  private readonly fs: SettingsFs;
  private readonly now: () => Date;
  private data: SettingsFile;
  private loaded = false;

  constructor(opts: SettingsStoreOptions) {
    this.file = opts.file;
    this.fs = opts.fs;
    this.now = opts.now ?? (() => new Date());
    this.data = defaultSettingsFile(this.now());
  }

  // ------------------------------------------------------------------ load

  /** Load + validate/migrate the settings file. Recoverable, never throws. */
  load(): { recovered: boolean; notes: string[] } {
    this.loaded = true;
    if (!this.fs.existsSync(this.file)) {
      this.data = defaultSettingsFile(this.now());
      return { recovered: false, notes: [] };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
    } catch {
      // Malformed file: back it up next to itself, then start from defaults.
      const backup = this.backupCorrupt();
      this.data = defaultSettingsFile(this.now());
      return {
        recovered: true,
        notes: ['settings file is not valid JSON — recovered to defaults', backup ? `corrupt file backed up: ${backup}` : 'backup failed'],
      };
    }
    const res = validateAndMigrate(raw, this.now());
    if (!res.ok) {
      // Structurally broken (forward version / garbage shape): keep a copy of
      // the ORIGINAL so nothing is silently lost, then continue with whatever
      // per-field recovery produced.
      if (res.notes.some((n) => n.includes('newer than supported') || n.includes('not an object'))) {
        this.backupCorrupt('unreadable');
      }
    }
    this.data = res.file;
    return { recovered: !res.ok, notes: res.notes };
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load();
  }

  private persist(): void {
    this.data.updatedAt = this.now().toISOString();
    const tmp = `${this.file}.tmp`;
    const json = JSON.stringify(this.data, null, 2);
    // atomic write: tmp + rename (same directory → same filesystem)
    this.fs.writeFileSync(tmp, json);
    this.fs.renameSync(tmp, this.file);
    this.fs.chmodSync?.(this.file, 0o600); // restrict access to sensitive config
  }

  // ------------------------------------------------------------------- get

  /** IPC-safe view. */
  getPublic(): PublicSettings {
    this.ensureLoaded();
    return {
      version: SETTINGS_VERSION,
      app: { ...this.data.app },
      window: this.data.window ? { ...this.data.window } : null,
      panels: structuredClone(this.data.panels),
      mcp: { ...this.data.mcp },
    };
  }

  /** In-process read for main-process consumers (window restore, MCP host). */
  getInternal(): SettingsFile {
    this.ensureLoaded();
    return this.data;
  }

  // ---------------------------------------------------------------- update

  /** Validated preference patch (renderer → main). */
  update(patch: {
    app?: Partial<AppPreferences>;
    mcp?: Partial<McpPrefs>;
    panels?: Record<string, PanelLayout>;
  }): PublicSettings {
    this.ensureLoaded();
    if (patch.app) {
      // route through the validator so ranges/types hold at runtime too
      const res = validateAndMigrate({
        ...this.data,
        app: { ...this.data.app, ...patch.app },
      });
      this.data = res.file;
    }
    if (patch.mcp) {
      const res = validateAndMigrate({ ...this.data, mcp: { ...this.data.mcp, ...patch.mcp } });
      this.data = res.file;
    }
    if (patch.panels) {
      const merged = { ...this.data.panels };
      for (const [key, value] of Object.entries(patch.panels)) {
        // full replace per panel id (validated at the schema level on reload)
        if (value && typeof value === 'object') merged[key] = value;
        else delete merged[key];
      }
      const res = validateAndMigrate({ ...this.data, panels: merged });
      this.data = res.file;
    }
    this.persist();
    return this.getPublic();
  }

  /** Save window layout (called by main on move/resize debounce + quit). */
  saveWindow(w: WindowLayout): void {
    this.ensureLoaded();
    this.data.window = {
      x: Math.round(w.x),
      y: Math.round(w.y),
      width: Math.round(w.width),
      height: Math.round(w.height),
      isMaximized: w.isMaximized,
    };
    this.persist();
  }

  /** Replace the whole panel map (hydrated from the renderer's panel store). */
  replacePanels(panels: Record<string, PanelLayout>): void {
    this.ensureLoaded();
    const res = validateAndMigrate({ ...this.data, panels });
    this.data = res.file;
    this.persist();
  }

  // -------------------------------------------------------------- recovery

  /** Back up a corrupt settings file next to itself (called on load recovery). */
  backupCorrupt(suffix = 'corrupt'): string | null {
    try {
      if (!this.fs.existsSync(this.file)) return null;
      const dest = `${this.file}.${suffix}-${this.now().toISOString().replace(/[:.]/g, '-')}`;
      const json = this.fs.readFileSync(this.file, 'utf8');
      this.fs.writeFileSync(dest, json);
      return dest;
    } catch {
      return null;
    }
  }

  /** File path (for the smoke test / diagnostics; safe to log). */
  get filePath(): string {
    return this.file;
  }
}
