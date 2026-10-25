/**
 * PixelForge AI — preload bridge contract (v3.1 Plan §8.2; Task 1 + Task 4).
 *
 * This is the single canonical type source for the bridge surface:
 *   - main process  (src/bridge/handlers.ts) — validates payloads, returns these shapes
 *   - preload       (src/preload/index.ts)   — exposes exactly this object
 *   - web renderer  (src/types/pixelforge-bridge.d.ts) — self-contained ambient copy
 *
 * Task 4 adds the `project` namespace: native open/save dialogs for
 * .pixelforgeproj files plus a DIRECTORY-ALLOWLISTED file-transport the
 * renderer feeds into @pixelforge/core's persistence (FileFs adapter) — the
 * core stays the single persistence implementation (atomic write, backups,
 * journal, recovery); main only performs raw primitive I/O on paths the user
 * (or a registered flow) picked in THIS session.
 *
 * Task 7 adds the `exports` namespace: a native directory picker for
 * multi-file exports. The picked directory is registered into the SAME
 * session allowlist, so export writes ride the exact same validated
 * pf:fs-* transport (path-traversal proof, user-approved locations only).
 * Single-file exports reuse project.pickSave directly.
 *
 * Task 13a adds the `settings` namespace: versioned settings-file I/O plus
 * the C13 credential vault. Plaintext API keys cross the bridge exactly
 * ONCE (setApiKey → main), are safeStorage-encrypted in the main process,
 * and are NEVER returned — the renderer only sees `hasKey` booleans and
 * credential metadata. Later tasks extend the SAME object (ai → Task 9,
 * mcp → Task 8); they must never widen it with loose `any` channels.
 */

export interface BridgeAppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  isDev: boolean;
  locale: string;
}

export interface BridgeFileFilter {
  name: string;
  /** Extension list WITHOUT dots, e.g. ["png", "pixelforgeproj"]. */
  extensions: string[];
}

export interface BridgeDialogOpenOptions {
  filters?: BridgeFileFilter[];
  multiSelections?: boolean;
  defaultPath?: string;
}

export interface BridgeDialogOpenResult {
  canceled: boolean;
  paths: string[];
}

export interface BridgeDialogSaveOptions {
  filters?: BridgeFileFilter[];
  defaultPath?: string;
}

export interface BridgeDialogSaveResult {
  canceled: boolean;
  path: string | null;
}

/** Result of registering a path for fs access (pick flows do it implicitly). */
export interface BridgeRegisterResult {
  ok: boolean;
  /** The normalized absolute root that was registered (directory). */
  root: string | null;
}

export interface BridgeStatResult {
  mtimeMs: number;
  size: number;
}

/** Result of the native directory picker for multi-file exports (Task 7). */
export interface BridgeExportDirResult {
  canceled: boolean;
  dir: string | null;
}

// ------------------------- settings (Task 13a) ------------------------------

/** App preferences (renderer-mirrored). No secret fields, ever. */
export interface BridgeAppPreferences {
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

export interface BridgeWindowLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface BridgePanelLayout {
  pos?: { x: number; y: number };
  open?: boolean;
  hidden?: boolean;
  pillPos?: { x: number; y: number };
}

export interface BridgeMcpPrefs {
  agentApiEnabled: boolean;
  bridgeAutoConnect: boolean;
}

/** Provider profile as seen by the renderer: hasKey boolean, NEVER key material. */
export interface BridgeProviderView {
  id: string;
  label: string;
  kind: 'zai' | 'openai' | 'anthropic' | 'custom';
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasKey: boolean;
  sessionOnly: boolean;
  apiKeyStoredAt: string | null;
}

export interface BridgeCredentialStatus {
  encryptionAvailable: boolean;
  backend: string;
  sessionOnlyKeys: number;
  providers: Array<{
    id: string;
    hasKey: boolean;
    sessionOnly: boolean;
    apiKeyStoredAt: string | null;
  }>;
}

/** Full settings view returned by pf:settings-get / pf:settings-update. */
export interface BridgeSettingsView {
  version: number;
  app: BridgeAppPreferences;
  window: BridgeWindowLayout | null;
  panels: Record<string, BridgePanelLayout>;
  mcp: BridgeMcpPrefs;
  ai: { monthlyLimitUsd: number; warnUsd: number; cacheEnabled: boolean };
  aiProviders: BridgeProviderView[];
  activeProviderId: string;
  credentials: BridgeCredentialStatus;
}

/** Preference patch (validated on both sides). Secret fields are not present. */
export interface BridgeSettingsUpdate {
  app?: Partial<BridgeAppPreferences>;
  mcp?: Partial<BridgeMcpPrefs>;
  ai?: Partial<{ monthlyLimitUsd: number; warnUsd: number; cacheEnabled: boolean }>;
  panels?: Record<string, BridgePanelLayout>;
  activeProviderId?: string;
  aiProviders?: Array<{
    id: string;
    label?: string;
    kind?: 'zai' | 'openai' | 'anthropic' | 'custom';
    baseUrl?: string;
    model?: string;
    enabled?: boolean;
  }>;
}

export interface BridgeSetApiKeyResult {
  ok: boolean;
  /** true when the OS keyring was unavailable and the key is session-only */
  sessionOnly: boolean;
}

// --------------------------- AI (Task 9) -------------------------------------

/** Renderer → main AI job request (NO key material — providerId references the vault). */
export interface BridgeAiJobRequest {
  prompt: string;
  providerId: string;
  width: number;
  height: number;
  count?: number;
  seed?: number;
  clientId?: string;
}

export interface BridgeAiJobImage {
  base64: string;
}

export interface BridgeAiJobView {
  jobId: string;
  clientId: string | null;
  status: 'queued' | 'generating' | 'done' | 'error' | 'cancelled';
  prompt: string;
  providerId: string;
  providerLabel: string;
  model: string;
  requestSize: string;
  count: number;
  seed: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** ESTIMATE from the price table; null = unknown — never an exact charge */
  costEstimateUsd: number | null;
  cacheHit: boolean;
  error: { code: string; message: string } | null;
  images: BridgeAiJobImage[];
  queuePosition: number | null;
}

export interface BridgeAiUsageRecord {
  jobId: string;
  providerId: string;
  providerLabel: string;
  model: string;
  promptLength: number;
  requestSize: string;
  count: number;
  status: string;
  cacheHit: boolean;
  durationMs: number | null;
  costEstimateUsd: number | null;
  finishedAt: string;
}

export type BridgeAiEvent =
  | { type: 'job'; job: BridgeAiJobView }
  | { type: 'spend_warning'; spentUsd: number; warnUsd: number; limitUsd: number };

export interface PixelForgeBridge {
  readonly bridgeVersion: 5;
  /** Round-trip smoke check: main answers `pong`. */
  ping(): Promise<'pong'>;
  app: {
    getInfo(): Promise<BridgeAppInfo>;
  };
  dialog: {
    openFile(options?: BridgeDialogOpenOptions): Promise<BridgeDialogOpenResult>;
    saveFile(options?: BridgeDialogSaveOptions): Promise<BridgeDialogSaveResult>;
  };
  project: {
    /**
     * Native Open dialog for a project file. On success the file's directory
     * is registered for fs access in this session and the picked path is
     * returned. Never returns file content — the renderer reads via fs.
     */
    pickOpen(options?: BridgeDialogOpenOptions): Promise<BridgeDialogOpenResult>;
    /**
     * Native Save dialog. On success the target's directory is registered
     * and the chosen path returned (null when canceled).
     */
    pickSave(options?: BridgeDialogSaveOptions): Promise<BridgeDialogSaveResult>;
    /**
     * Programmatic path registration (recent files, dev/CI harnesses).
     * Registers the file's parent directory; the file itself is NOT opened.
     */
    registerPath(path: string): Promise<BridgeRegisterResult>;
    /**
     * Primitive file transport restricted to directories registered in this
     * session. @pixelforge/core's FileFs adapters over these — atomicity,
     * backups, journals and recovery all remain core implementations.
     */
    fs: {
      readFile(path: string): Promise<Uint8Array>;
      writeFile(path: string, data: Uint8Array): Promise<void>;
      rename(from: string, to: string): Promise<void>;
      unlink(path: string): Promise<void>;
      exists(path: string): Promise<boolean>;
      mkdir(path: string): Promise<void>;
      listDir(path: string): Promise<string[]>;
      stat(path: string): Promise<BridgeStatResult | null>;
    };
  };
  /** Task 7: export destinations (multi-file). Single files use project.pickSave. */
  exports: {
    /**
     * Native directory picker (openDirectory + createDirectory). On success
     * the chosen directory is registered for session fs access and returned.
     * No content flows through this call — writes go via project.fs.
     */
    pickDir(): Promise<BridgeExportDirResult>;
  };
  /** Task 13a: versioned settings file + C13 credential vault (main side). */
  settings: {
    /** Full settings view (secrets stripped — hasKey booleans only). */
    getAll(): Promise<BridgeSettingsView>;
    /** Validated preference patch; returns the updated view. */
    update(patch: BridgeSettingsUpdate): Promise<BridgeSettingsView>;
    /**
     * Submit an API key (WRITE-ONLY): the plaintext crosses the bridge once,
     * is encrypted via safeStorage in main, and is never returned.
     */
    setApiKey(providerId: string, plaintext: string): Promise<BridgeSetApiKeyResult>;
    /** True when a usable key exists (persisted ciphertext or session-only). */
    hasKey(providerId: string): Promise<boolean>;
    /** Remove a stored credential. Returns true when something was removed. */
    removeKey(providerId: string): Promise<boolean>;
    /** Keyring availability + per-provider credential metadata. */
    credentialStatus(): Promise<BridgeCredentialStatus>;
  };
  /**
   * Task 9: AI generation jobs. All provider I/O and credential decryption
   * happen in the MAIN process; the renderer only sees job views (provenance
   * + status + result images) — key material NEVER crosses the bridge.
   */
  ai: {
    /** Queue a generation job. Throws AiJobError-shaped rejections (spend_limit etc). */
    submit(request: BridgeAiJobRequest): Promise<{ jobId: string }>;
    cancel(jobId: string): Promise<boolean>;
    status(jobId: string): Promise<BridgeAiJobView | null>;
    list(): Promise<BridgeAiJobView[]>;
    /** Usage history + ESTIMATED month spend (for the meter; cache hits are $0). */
    usage(): Promise<{ records: BridgeAiUsageRecord[]; monthSpendUsd: number }>;
    /** Subscribe to job/spend events pushed from main. Returns an unsubscriber. */
    onEvent(listener: (event: BridgeAiEvent) => void): () => void;
  };
}
