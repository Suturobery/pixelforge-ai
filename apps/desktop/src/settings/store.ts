/**
 * PixelForge AI — settings store (v3.1 §3.1/§8.2/C13; Task 13a).
 *
 * Owns the versioned settings file: load → validate/migrate → atomic writes
 * (tmp + rename in the same directory), plus the C13 credential vault:
 *
 *   • setApiKey(providerId, plaintext) → main process ONLY:
 *       - safeStorage available  → encrypt → persist base64 `apiKeyEnc`
 *         inside the settings file; plaintext NEVER hits the disk;
 *       - safeStorage unavailable → the key is kept in main's memory for
 *         THIS SESSION ONLY (`apiKeySessionOnly`), nothing is written —
 *         no plaintext fallback, no obfuscation, per plan C13;
 *   • plaintext is never returned over IPC (hasKey/removeKey/status only);
 *   • decryption (`revealApiKey`) exists for the in-process AI job runner
 *     (Task 9) — it is NOT exposed on the IPC surface;
 *   • ciphertext from a different machine/env fails to decrypt → treated as
 *     a missing key and scrubbed from the file (recovery, not an error).
 *
 * The store is PURE: fs and crypto are injected, so tests drive it with a
 * fake fs + fake SecretBox. The Electron wiring lives in main/index.ts.
 */

import {
  SETTINGS_VERSION,
  defaultProviders,
  defaultSettingsFile,
  toProviderView,
  validateAndMigrate,
  API_KEY_PROVIDER_RE,
  type AiPrefs,
  type AppPreferences,
  type McpPrefs,
  type PanelLayout,
  type ProviderView,
  type SettingsFile,
  type StoredProvider,
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

/**
 * safeStorage port (v3.1 C13). encryptString returns DPAPI/Keychain-backed
 * ciphertext; decryptString of foreign ciphertext throws (→ treated as a
 * missing key). `backendLabel` is for UI display only ('DPAPI', 'Keychain',
 * 'libsecret/kwallet', …).
 */
export interface SecretBox {
  isAvailable(): boolean;
  backendLabel(): string;
  encrypt(plaintext: string): string; // → base64 ciphertext
  decrypt(ciphertextB64: string): string | null; // null when undecryptable
}

export interface SettingsStoreOptions {
  file: string;
  fs: SettingsFs;
  box: SecretBox;
  now?: () => Date;
}

// ------------------------------------------------------------------- store

export interface CredentialStatus {
  encryptionAvailable: boolean;
  backend: string;
  providers: ProviderView[];
  /** count of keys held in memory for this session only */
  sessionOnlyKeys: number;
}

/** IPC-visible settings payload: the full file with secrets stripped. */
export interface PublicSettings {
  version: number;
  app: AppPreferences;
  window: WindowLayout | null;
  panels: Record<string, PanelLayout>;
  mcp: McpPrefs;
  ai: AiPrefs;
  aiProviders: ProviderView[];
  activeProviderId: string;
  brainProviderId: string;
}

export class SettingsStore {
  private readonly file: string;
  private readonly fs: SettingsFs;
  private readonly box: SecretBox;
  private readonly now: () => Date;
  private data: SettingsFile;
  private loaded = false;

  /** session-only keys (encryption unavailable) — never persisted anywhere */
  private readonly sessionKeys = new Map<string, string>();

  constructor(opts: SettingsStoreOptions) {
    this.file = opts.file;
    this.fs = opts.fs;
    this.box = opts.box;
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

  /** IPC-safe view: secrets stripped, ciphertext NEVER included. */
  getPublic(): PublicSettings {
    this.ensureLoaded();
    return {
      version: SETTINGS_VERSION,
      app: { ...this.data.app },
      window: this.data.window ? { ...this.data.window } : null,
      panels: structuredClone(this.data.panels),
      mcp: { ...this.data.mcp },
      ai: { ...this.data.ai },
      aiProviders: this.data.aiProviders.map((p) => {
        const view = toProviderView(p);
        if (this.sessionKeys.has(p.id)) view.hasKey = true;
        return view;
      }),
      activeProviderId: this.data.activeProviderId,
      brainProviderId: this.data.brainProviderId,
    };
  }

  /** In-process read for main-process consumers (window restore, MCP host). */
  getInternal(): SettingsFile {
    this.ensureLoaded();
    return this.data;
  }

  // ---------------------------------------------------------------- update

  /** Validated preference patch (renderer → main). Secrets are NOT patchable. */
  update(patch: {
    app?: Partial<AppPreferences>;
    mcp?: Partial<McpPrefs>;
    ai?: Partial<AiPrefs>;
    panels?: Record<string, PanelLayout>;
    activeProviderId?: string;
    brainProviderId?: string;
    aiProviders?: Array<Partial<Omit<StoredProvider, 'apiKeyEnc' | 'apiKeyStoredAt' | 'apiKeySessionOnly'>> & { id: string }>;
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
    if (patch.ai) {
      const res = validateAndMigrate({ ...this.data, ai: { ...this.data.ai, ...patch.ai } });
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
    if (patch.aiProviders) {
      for (const p of patch.aiProviders) {
        if (!API_KEY_PROVIDER_RE.test(p.id)) continue;
        const idx = this.data.aiProviders.findIndex((x) => x.id === p.id);
        if (idx === -1) {
          this.data.aiProviders.push({
            id: p.id,
            label: typeof p.label === 'string' ? p.label.slice(0, 80) : p.id,
            kind: p.kind === 'zai' || p.kind === 'openai' || p.kind === 'anthropic' || p.kind === 'custom' ? p.kind : 'custom',
            baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.slice(0, 512) : '',
            model: typeof p.model === 'string' ? p.model.slice(0, 128) : '',
            enabled: p.enabled === true,
          });
        } else {
          const cur = this.data.aiProviders[idx]!;
          this.data.aiProviders[idx] = {
            ...cur,
            label: typeof p.label === 'string' ? p.label.slice(0, 80) : cur.label,
            kind:
              p.kind === 'zai' || p.kind === 'openai' || p.kind === 'anthropic' || p.kind === 'custom'
                ? p.kind
                : cur.kind,
            baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.slice(0, 512) : cur.baseUrl,
            model: typeof p.model === 'string' ? p.model.slice(0, 128) : cur.model,
            enabled: typeof p.enabled === 'boolean' ? p.enabled : cur.enabled,
          };
        }
      }
      // note: the patch type Omits secret fields (apiKeyEnc etc.) — only the
      // vault methods below may ever touch them; anything smuggled at runtime
      // through a cast is stripped by the next validateAndMigrate round-trip
      // on disk load (unknown/invalid ciphertext is dropped fail-closed).
    }
    if (patch.activeProviderId && API_KEY_PROVIDER_RE.test(patch.activeProviderId)) {
      if (this.data.aiProviders.some((p) => p.id === patch.activeProviderId)) {
        this.data.activeProviderId = patch.activeProviderId;
      }
    }
    if (patch.brainProviderId && API_KEY_PROVIDER_RE.test(patch.brainProviderId)) {
      if (this.data.aiProviders.some((p) => p.id === patch.brainProviderId)) {
        this.data.brainProviderId = patch.brainProviderId;
      }
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

  // ------------------------------------------------- credentials (C13 vault)

  private findProvider(id: string): StoredProvider | undefined {
    return this.data.aiProviders.find((p) => p.id === id);
  }

  /**
   * Ensure the provider exists in `this.data.aiProviders` before storing a
   * credential so keys saved for a newly introduced provider (e.g. `groq`)
   * are never dropped if `setApiKey` runs before `update({ aiProviders })`.
   */
  private ensureProvider(id: string): StoredProvider {
    let p = this.findProvider(id);
    if (!p) {
      const def = defaultProviders().find((d) => d.id === id);
      p = def
        ? { ...def }
        : { id, label: id, kind: 'custom', baseUrl: '', model: '', enabled: false };
      this.data.aiProviders.push(p);
    }
    return p;
  }

  /**
   * Store an API key. Plaintext goes main→cipher and is dropped; when the
   * OS keyring is unavailable the key lives in `sessionKeys` ONLY.
   * Returns whether the key is session-only.
   */
  setApiKey(providerId: string, plaintext: string): { ok: boolean; sessionOnly: boolean; error?: string } {
    this.ensureLoaded();
    const key = typeof plaintext === 'string' ? plaintext.trim() : '';
    if (!API_KEY_PROVIDER_RE.test(providerId)) {
      return { ok: false, sessionOnly: false, error: 'invalid provider id' };
    }
    if (!key) return { ok: false, sessionOnly: false, error: 'API key must not be empty' };
    if (key.length > 512) return { ok: false, sessionOnly: false, error: 'API key too long (max 512 chars)' };

    if (!this.box.isAvailable()) {
      // C13: session-only fallback — NO plaintext disk fallback, no obfuscation
      this.sessionKeys.set(providerId, key);
      const p = this.ensureProvider(providerId);
      delete p.apiKeyEnc;
      delete p.apiKeyStoredAt;
      p.apiKeySessionOnly = true;
      this.persist(); // records the sessionOnly marker only
      return { ok: true, sessionOnly: true };
    }

    try {
      const enc = this.box.encrypt(key);
      this.sessionKeys.set(providerId, key); // in-process cache for the job runner
      const p = this.ensureProvider(providerId);
      p.apiKeyEnc = enc;
      p.apiKeyStoredAt = this.now().toISOString();
      p.apiKeySessionOnly = false;
      this.persist();
      return { ok: true, sessionOnly: false };
    } catch {
      return { ok: false, sessionOnly: false, error: 'encryption failed — key not stored' };
    }
  }

  hasKey(providerId: string): boolean {
    this.ensureLoaded();
    if (this.sessionKeys.has(providerId)) return true;
    const p = this.findProvider(providerId);
    return !!p && typeof p.apiKeyEnc === 'string' && p.apiKeyEnc.length > 0;
  }

  removeKey(providerId: string): boolean {
    this.ensureLoaded();
    const p = this.findProvider(providerId);
    const hadSession = this.sessionKeys.delete(providerId);
    if (p && (p.apiKeyEnc || p.apiKeySessionOnly)) {
      delete p.apiKeyEnc;
      delete p.apiKeyStoredAt;
      delete p.apiKeySessionOnly;
      this.persist();
      return true;
    }
    return hadSession;
  }

  /**
   * Decrypt a stored key for IN-PROCESS use (AI job runner — Task 9).
   * NOT exposed over IPC. Returns null when missing/undecryptable.
   */
  revealApiKey(providerId: string): string | null {
    this.ensureLoaded();
    const session = this.sessionKeys.get(providerId);
    if (session) return session;
    const p = this.findProvider(providerId);
    if (!p || typeof p.apiKeyEnc !== 'string' || !p.apiKeyEnc) return null;
    try {
      const plain = this.box.decrypt(p.apiKeyEnc);
      if (plain === null) {
        // foreign/undecryptable ciphertext → scrub and report missing
        this.removeKey(providerId);
        return null;
      }
      return plain;
    } catch {
      this.removeKey(providerId);
      return null;
    }
  }

  credentialStatus(): CredentialStatus {
    this.ensureLoaded();
    let sessionOnlyKeys = 0;
    for (const p of this.data.aiProviders) {
      if (p.apiKeySessionOnly) sessionOnlyKeys += 1;
    }
    return {
      encryptionAvailable: this.box.isAvailable(),
      backend: this.box.backendLabel(),
      providers: this.data.aiProviders.map((p) => {
        const view = toProviderView(p);
        if (this.sessionKeys.has(p.id)) view.hasKey = true;
        return view;
      }),
      sessionOnlyKeys,
    };
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
