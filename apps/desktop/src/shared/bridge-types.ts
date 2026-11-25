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
 * Task 13a adds the `settings` namespace: versioned settings-file I/O. The
 * legacy credential vault (write-only API keys, safeStorage ciphertext) was
 * removed together with the in-app AI provider stack — agents reason in the
 * artist's IDE over MCP. Later tasks extend the SAME object; they must never
 * widen it with loose `any` channels.
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
  uiTextScale: 'normal' | 'large';
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

/** Full settings view returned by pf:settings-get / pf:settings-update. */
export interface BridgeSettingsView {
  version: number;
  app: BridgeAppPreferences;
  window: BridgeWindowLayout | null;
  panels: Record<string, BridgePanelLayout>;
  mcp: BridgeMcpPrefs;
}

/** Preference patch (validated on both sides). */
export interface BridgeSettingsUpdate {
  app?: Partial<BridgeAppPreferences>;
  mcp?: Partial<BridgeMcpPrefs>;
  panels?: Record<string, BridgePanelLayout>;
}

// ------------------------------- updates ------------------------------------
export interface PixelForgeBridge {
  readonly bridgeVersion: 5;
  /** Round-trip smoke check: main answers `pong`. */
  ping(): Promise<'pong'>;
  app: {
    getInfo(): Promise<BridgeAppInfo>;
    /** OS notification for background events (approval requests, finished
     *  AI jobs) while the window is minimized. Clicking focuses the window. */
    notify(title: string, body?: string): Promise<{ ok: boolean; reason?: string }>;
    /** Read-only tail (last 200 lines / 48 KB) of today's main log. */
    logsTail(): Promise<{ ok: boolean; text?: string; file?: string; error?: string }>;
  };
  /** Native clipboard write for desktop windows where navigator.clipboard is unavailable. */
  clipboard: {
    writeText(text: string): Promise<void>;
  };
  /** Desktop-owned MCP endpoint + 1-click IDE config installer. */
  mcp: {
    status(): Promise<{ ready: boolean; endpoint: string | null }>;
    detectClients(): Promise<BridgeDetectedMcpClient[]>;
    installClient(input: {
      clientId: BridgeMcpClientId;
      endpoint: string;
      token: string;
    }): Promise<BridgeInstallMcpClientResult>;
    uninstallClient(input: { clientId: BridgeMcpClientId }): Promise<{
      ok: boolean;
      clientId: BridgeMcpClientId;
      removed?: boolean;
      error?: string;
    }>;
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
    /** Re-open only a path previously chosen through a native picker. */
    openRecent(path: string): Promise<BridgeRegisterResult>;
    /** Remove a file from Recents without touching the user's disk file. */
    forgetRecent(path: string): Promise<void>;
    /** Move a picker-approved recent file to the OS Recycle Bin/Trash. */
    trashRecent(path: string): Promise<{ trashed: boolean }>;
    /** Remember a renamed file only when it remains inside an approved root. */
    rememberCurrentPath(path: string): Promise<BridgeRegisterResult>;
    /**
     * Native warning confirm (Electron has no window.confirm). True = OK.
     */
    confirm(message: string, detail?: string): Promise<boolean>;
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
  /** Task 13a: versioned settings file (main side). */
  settings: {
    /** Full settings view. */
    getAll(): Promise<BridgeSettingsView>;
    /** Validated preference patch; returns the updated view. */
    update(patch: BridgeSettingsUpdate): Promise<BridgeSettingsView>;
  };
  /** Packaging milestone: guarded software updates (no-op without a feed). */
  updates: {
    status(): Promise<UpdateStatusView>;
    check(): Promise<UpdateStatusView>;
    install(): Promise<{ ok: boolean }>;
    onStatus(listener: (status: UpdateStatusView) => void): () => void;
  };
}

export type BridgeMcpClientId = 'cursor' | 'windsurf' | 'claude-code' | 'codex' | 'antigravity';

export interface BridgeDetectedMcpClient {
  id: BridgeMcpClientId;
  name: string;
  configPath: string;
  detected: boolean;
  configured: boolean;
  format: 'json' | 'toml';
}

export interface BridgeInstallMcpClientResult {
  ok: boolean;
  clientId: BridgeMcpClientId;
  configPath?: string;
  backupPath?: string | null;
  error?: string;
}

export interface UpdateStatusView {
  state:
    | 'no-feed'
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  info?: string;
  version?: string;
  progress?: number;
}
