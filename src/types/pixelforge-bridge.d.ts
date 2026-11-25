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
    uiTextScale: 'normal' | 'large';
  };
  window: { x: number; y: number; width: number; height: number; isMaximized: boolean } | null;
  panels: Record<string, { pos?: { x: number; y: number }; open?: boolean; hidden?: boolean; pillPos?: { x: number; y: number } }>;
  mcp: { agentApiEnabled: boolean; bridgeAutoConnect: boolean };
}

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
    detectClients?(): Promise<PfDetectedMcpClient[]>;
    installClient?(input: {
      clientId: PfMcpClientId;
      endpoint: string;
      token: string;
    }): Promise<PfInstallMcpClientResult>;
    uninstallClient?(input: { clientId: PfMcpClientId }): Promise<{
      ok: boolean;
      clientId: PfMcpClientId;
      removed?: boolean;
      error?: string;
    }>;
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
  /** Task 13a: versioned settings file (main side). */
  settings: {
    getAll(): Promise<PfSettingsView>;
    update(patch: {
      app?: Partial<PfSettingsView['app']>;
      mcp?: Partial<PfSettingsView['mcp']>;
      panels?: PfSettingsView['panels'];
    }): Promise<PfSettingsView>;
  };
  /** Packaging milestone: guarded software updates (no-op without a feed). */
  updates: {
    status(): Promise<PfUpdateStatus>;
    check(): Promise<PfUpdateStatus>;
    install(): Promise<{ ok: boolean }>;
    onStatus(listener: (status: PfUpdateStatus) => void): () => void;
  };
}

type PfMcpClientId = 'cursor' | 'windsurf' | 'claude-code' | 'codex' | 'antigravity';

interface PfDetectedMcpClient {
  id: PfMcpClientId;
  name: string;
  configPath: string;
  detected: boolean;
  configured: boolean;
  format: 'json' | 'toml';
}

interface PfInstallMcpClientResult {
  ok: boolean;
  clientId: PfMcpClientId;
  configPath?: string;
  backupPath?: string | null;
  error?: string;
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
