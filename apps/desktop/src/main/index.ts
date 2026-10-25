import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, dialog } from 'electron';

import { registerBridgeHandlers } from '../bridge/handlers';
import { registerSettingsHandlers } from '../bridge/settings-handlers';
import { AiService } from '../ai/service';
import { SMOKE } from '../config';
import { createLogger, type Logger } from '../logger';
import { installApplicationMenu } from './menu';
import { runSmokeTest } from '../smoke';
import { installSessionHardening } from '../security';
import { createSafeStorageBox } from '../settings/secret-box';
import { SettingsStore } from '../settings/store';
import { createMainWindow, getMainWindow, loadRenderer, persistWindowLayout } from '../window';

// Fix the product name before anything reads userData paths (logs live there).
app.setName('PixelForge AI');

// Linux dev/CI containers often run without user namespaces; never applied to
// packaged builds. PF_DISABLE_GPU is for headless xvfb runs (screenshots still work).
if (process.platform === 'linux' && !app.isPackaged) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}
if (process.env.PF_DISABLE_GPU === '1') {
  app.commandLine.appendSwitch('disable-gpu');
}

// Force the Chromium sandbox for ALL renderers (defense in depth beyond the
// per-window webPreferences; must run before app ready).
app.enableSandbox();

const logger: Logger = createLogger();

/**
 * Settings file + C13 credential vault — one instance for the app lifetime.
 * app.getPath('userData') is valid before `ready` once app.setName ran.
 */
const settingsStore: SettingsStore = new SettingsStore({
  file: path.join(app.getPath('userData'), 'settings.json'),
  fs: fs as unknown as import('../settings/store').SettingsFs,
  box: createSafeStorageBox(),
});
const settingsLoad = settingsStore.load();
if (settingsLoad.recovered) {
  logger.warn('settings.load.recovered', { notes: settingsLoad.notes });
}

/**
 * Task 9: AI job runner — lives in MAIN (plan §3.1). Credentials are
 * decrypted in-process from the vault; usage is persisted next to the
 * settings file; PF_AI_MOCK=1 (smokes/CI) swaps in the offline mock adapter.
 */
const aiService: AiService = new AiService({
  settings: settingsStore,
  logger,
  usageFile: path.join(app.getPath('userData'), 'ai-usage.json'),
  fs: fs as unknown as import('../ai/service').AiServiceOptions['fs'],
});

function installProcessErrorHandlers(): void {
  let fatalDialogShown = false;
  process.on('uncaughtException', (err) => {
    logger.error('main.uncaughtException', { stack: err?.stack ?? String(err) });
    if (!fatalDialogShown && !SMOKE) {
      fatalDialogShown = true;
      dialog.showErrorBox('PixelForge AI — unexpected error', String(err?.message ?? err));
    }
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('main.unhandledRejection', { reason: String(reason) });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A second launch just focuses the running instance (standard desktop behavior).
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    logger.info('app.ready', {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      isDev: !app.isPackaged,
      logFile: logger.file,
    });
    installProcessErrorHandlers();
    registerBridgeHandlers(logger);
    registerSettingsHandlers(settingsStore, logger);
    aiService.register(() => BrowserWindow.getAllWindows().map((w) => w.webContents));
    installApplicationMenu();

    const win = createMainWindow(logger, settingsStore);
    installSessionHardening(win, logger); // must precede the first navigation

    if (SMOKE) {
      // Attaches did-finish-load/did-fail-load race BEFORE loading starts.
      void runSmokeTest(win, logger);
    }
    void loadRenderer(win, logger);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Task 13a: persist the window layout before the process goes down.
  app.on('before-quit', () => {
    persistWindowLayout(settingsStore, logger);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) {
      const win = createMainWindow(logger, settingsStore);
      installSessionHardening(win, logger);
      void loadRenderer(win, logger);
    }
  });

  logger.info('main.boot', { entry: path.basename(__filename) });
}
