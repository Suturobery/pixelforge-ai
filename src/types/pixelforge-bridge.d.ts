/**
 * Ambient types for the desktop preload bridge (`window.pixelforge`).
 *
 * Present ONLY when the web app runs inside the PixelForge Electron shell;
 * in a plain browser this stays `undefined` — always optional-chain.
 *
 * Canonical source: apps/desktop/src/shared/bridge-types.ts (Task 1 + Task 4).
 * Self-contained copy for the web renderer — keep in sync when the bridge grows.
 */

interface PfFileFilter {
  name: string;
  extensions: string[];
}

interface PfDialogOpenOptions {
  filters?: PfFileFilter[];
  multiSelections?: boolean;
  defaultPath?: string;
}

interface PfDialogOpenResult {
  canceled: boolean;
  paths: string[];
}

interface PfDialogSaveOptions {
  filters?: PfFileFilter[];
  defaultPath?: string;
}

interface PfDialogSaveResult {
  canceled: boolean;
  path: string | null;
}

interface PfRegisterResult {
  ok: boolean;
  root: string | null;
}

interface PfStatResult {
  mtimeMs: number;
  size: number;
}

interface PfExportDirResult {
  canceled: boolean;
  dir: string | null;
}

interface PfProjectBridge {
  pickOpen(options?: PfDialogOpenOptions): Promise<PfDialogOpenResult>;
  pickSave(options?: PfDialogSaveOptions): Promise<PfDialogSaveResult>;
  openRecent(path: string): Promise<PfRegisterResult>;
  forgetRecent(path: string): Promise<void>;
  trashRecent(path: string): Promise<{ trashed: boolean }>;
  rememberCurrentPath(path: string): Promise<PfRegisterResult>;
  /** Native warning confirm (Electron has no window.confirm). True = OK. */
  confirm(message: string, detail?: string): Promise<boolean>;
  fs: {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    listDir(path: string): Promise<string[]>;
    stat(path: string): Promise<PfStatResult | null>;
  };
}

interface PfAppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  isDev: boolean;
  locale: string;
}

// ------------------- settings namespace (Task 13a) --------------------------

interface PfProviderView {
  id: string;
  label: string;
  kind: 'zai' | 'openai' | 'custom';
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasKey: boolean;
  sessionOnly: boolean;
  apiKeyStoredAt: string | null;
}

interface PfSettingsView {
  version: number;
  app: {
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
  };
  window: { x: number; y: number; width: number; height: number; isMaximized: boolean } | null;
  panels: Record<string, { pos?: { x: number; y: number }; open?: boolean; hidden?: boolean; pillPos?: { x: number; y: number } }>;
  mcp: { agentApiEnabled: boolean; bridgeAutoConnect: boolean };
  ai: { monthlyLimitUsd: number; warnUsd: number; cacheEnabled: boolean };
  aiProviders: PfProviderView[];
  activeProviderId: string;
  credentials: {
    encryptionAvailable: boolean;
    backend: string;
    sessionOnlyKeys: number;
    providers: Array<{ id: string; hasKey: boolean; sessionOnly: boolean; apiKeyStoredAt: string | null }>;
  };
}

// ------------------------- AI namespace (Task 9) ----------------------------

interface PfAiJobRequest {
  prompt: string;
  providerId: string;
  width: number;
  height: number;
  count?: number;
  seed?: number;
  clientId?: string;
}

interface PfAiJobView {
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
  costEstimateUsd: number | null;
  cacheHit: boolean;
  error: { code: string; message: string } | null;
  images: Array<{ base64: string }>;
  queuePosition: number | null;
}

interface PfAiUsageRecord {
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

interface PfAiConnectionTest {
  ok: boolean;
  latencyMs: number;
  note?: string;
  error?: string;
}

type PfAiEvent =
  | { type: 'job'; job: PfAiJobView }
  | { type: 'spend_warning'; spentUsd: number; warnUsd: number; limitUsd: number };

interface PixelForgeBridge {
  readonly bridgeVersion: 5;
  ping(): Promise<'pong'>;
  app: {
    getInfo(): Promise<PfAppInfo>;
    /** OS notification (background events while minimized); click focuses. */
    notify(title: string, body?: string): Promise<{ ok: boolean; reason?: string }>;
    /** Read-only tail (last 200 lines / 48 KB) of today's main log. */
    logsTail(): Promise<{ ok: boolean; text?: string; file?: string; error?: string }>;
  };
  clipboard: {
    writeText(text: string): Promise<void>;
  };
  mcp: {
    status(): Promise<{ ready: boolean; endpoint: string | null }>;
  };
  dialog: {
    openFile(options?: PfDialogOpenOptions): Promise<PfDialogOpenResult>;
    saveFile(options?: PfDialogSaveOptions): Promise<PfDialogSaveResult>;
  };
  project: PfProjectBridge;
  /** Task 7: export destinations (multi-file). Single files use project.pickSave. */
  exports: {
    /** Native directory picker; registers the chosen dir for session fs access. */
    pickDir(): Promise<PfExportDirResult>;
  };
  /** Task 13a: versioned settings file + C13 credential vault (main side). */
  settings: {
    getAll(): Promise<PfSettingsView>;
    update(patch: {
      app?: Partial<PfSettingsView['app']>;
      mcp?: Partial<PfSettingsView['mcp']>;
      ai?: Partial<PfSettingsView['ai']>;
      panels?: PfSettingsView['panels'];
      activeProviderId?: string;
      aiProviders?: Array<{
        id: string;
        label?: string;
        kind?: 'zai' | 'openai' | 'custom';
        baseUrl?: string;
        model?: string;
        enabled?: boolean;
      }>;
    }): Promise<PfSettingsView>;
    /** WRITE-ONLY key submission — the plaintext never comes back. */
    setApiKey(providerId: string, plaintext: string): Promise<{ ok: boolean; sessionOnly: boolean }>;
    hasKey(providerId: string): Promise<boolean>;
    removeKey(providerId: string): Promise<boolean>;
    credentialStatus(): Promise<PfSettingsView['credentials']>;
  };
  /** Task 9: AI job runner lives in MAIN — the renderer never sees key material. */
  ai: {
    submit(request: PfAiJobRequest): Promise<{ jobId: string }>;
    cancel(jobId: string): Promise<boolean>;
    status(jobId: string): Promise<PfAiJobView | null>;
    list(): Promise<PfAiJobView[]>;
    usage(): Promise<{ records: PfAiUsageRecord[]; monthSpendUsd: number }>;
    testConnection(providerId: string): Promise<PfAiConnectionTest>;
    onEvent(listener: (event: PfAiEvent) => void): () => void;
  };
  /** Packaging milestone: guarded software updates (no-op without a feed). */
  updates: {
    status(): Promise<PfUpdateStatus>;
    check(): Promise<PfUpdateStatus>;
    install(): Promise<{ ok: boolean }>;
    onStatus(listener: (status: PfUpdateStatus) => void): () => void;
  };
}

interface PfUpdateStatus {
  state: 'no-feed' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  info?: string;
  version?: string;
  progress?: number;
}

interface Window {
  readonly pixelforge?: PixelForgeBridge;
}
