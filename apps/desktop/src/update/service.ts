// PixelForge AI desktop — software updates (packaging milestone).
//
// electron-updater, fail-safe by design:
//   • NO-OP unless packaged AND an update feed is configured
//     (PF_UPDATE_PUBLISH env = generic provider base URL, or the
//     electron-builder.yml `publish` block when releases live on GitHub).
//   • Without a feed, check() answers { state: 'no-feed' } — the Settings
//     card shows an honest message instead of pretending.
//   • Never auto-installs: the renderer shows "Restart to update" and the
//     user decides (quitAndInstall).
//
// When a feed exists: checkForUpdates → downloading → update-downloaded →
// pf:app-update-status pushes progress to the renderer for the button state.

import { app, BrowserWindow, ipcMain } from 'electron';

import type { Logger } from '../logger';

export interface UpdateStatus {
  state: 'no-feed' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  info?: string;
  version?: string;
  progress?: number;
}

export class UpdateService {
  private autoUpdater: import('electron-updater').AppUpdater | null = null;
  private status: UpdateStatus = { state: 'no-feed', info: 'not packaged' };
  private listeners = new Set<(s: UpdateStatus) => void>();

  constructor(private readonly logger: Logger) {}

  /** True when a feed exists — electron-updater only initializes then.
   *  Feed sources: the app-update.yml electron-builder embedded (built via
   *  scripts/dist.cjs with PF_UPDATE_URL / GH_REPO) or the runtime override. */
  private feedConfigured(): boolean {
    if (!app.isPackaged) return false;
    if (process.env.PF_UPDATE_PUBLISH) return true;
    // packaged-with-feed detection: electron-updater reads resources/app-update.yml
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      const path = require('node:path') as typeof import('node:path');
      const yml = path.join(process.resourcesPath, 'app-update.yml');
      return fs.existsSync(yml);
    } catch {
      return false;
    }
  }

  /** Delayed startup check + periodic 4h poll so long sessions still get updates. */
  scheduleStartupCheck(): void {
    if (!this.feedConfigured()) return;
    setTimeout(() => {
      void this.check();
    }, 10_000).unref();
    setInterval(() => {
      if (this.status.state === 'checking' || this.status.state === 'downloading' || this.status.state === 'downloaded') {
        return;
      }
      void this.check();
    }, 4 * 60 * 60 * 1000).unref();
  }

  private async ensureUpdater(): Promise<import('electron-updater').AppUpdater | null> {
    if (this.autoUpdater) return this.autoUpdater;
    if (!this.feedConfigured()) return null;
    try {
      const { autoUpdater } = await import('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
      autoUpdater.on('update-available', (i) =>
        this.set({ state: 'available', version: i?.version, info: `update ${i?.version} available` }),
      );
      autoUpdater.on('update-not-available', () => this.set({ state: 'not-available', info: 'you are up to date' }));
      autoUpdater.on('download-progress', (p) =>
        this.set({ state: 'downloading', progress: Math.round(p.percent) }),
      );
      autoUpdater.on('update-downloaded', (i) =>
        this.set({ state: 'downloaded', version: i?.version, info: `update ${i?.version} ready — restart to install` }),
      );
      autoUpdater.on('error', (e) => this.set({ state: 'error', info: String(e?.message ?? e).slice(0, 200) }));
      this.autoUpdater = autoUpdater;
      return autoUpdater;
    } catch (err) {
      this.logger.error('update.init.failed', { err: String(err) });
      return null;
    }
  }

  private set(next: UpdateStatus): void {
    this.status = next;
    this.logger.info('update.status', next);
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('pf:app-update-status', next);
    }
    for (const fn of this.listeners) fn(next);
  }

  onUpdateStatus(fn: (s: UpdateStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  current(): UpdateStatus {
    return this.status;
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.set({ state: 'no-feed', info: 'dev build — updates apply to packaged installs' });
      return this.status;
    }
    if (!this.feedConfigured()) {
      this.set({ state: 'no-feed', info: 'no update feed configured (set PF_UPDATE_PUBLISH or publish block)' });
      return this.status;
    }
    const updater = await this.ensureUpdater();
    if (!updater) {
      this.set({ state: 'error', info: 'updater init failed' });
      return this.status;
    }
    try {
      await updater.checkForUpdates();
    } catch (err) {
      this.set({ state: 'error', info: String(err instanceof Error ? err.message : err).slice(0, 200) });
    }
    return this.status;
  }

  install(): void {
    if (this.status.state !== 'downloaded') return;
    this.autoUpdater?.quitAndInstall();
  }

  register(): void {
    ipcMain.handle('pf:app-update-status', () => this.current());
    ipcMain.handle('pf:app-update-check', async () => await this.check());
    ipcMain.handle('pf:app-update-install', () => {
      this.install();
      return { ok: this.status.state === 'downloaded' };
    });
  }
}
