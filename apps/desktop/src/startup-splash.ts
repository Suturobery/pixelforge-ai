// PixelForge AI desktop — native startup splash.
//
// The packaged editor starts a local Next renderer server on first launch.
// Keep this lightweight, local HTML window visible while that server warms so
// Windows never presents a blank black app surface to the artist.

import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import type { Logger } from './logger';

export function showStartupSplash(logger: Logger): BrowserWindow {
  const splash = new BrowserWindow({
    width: 440,
    height: 270,
    minWidth: 440,
    minHeight: 270,
    maxWidth: 440,
    maxHeight: 270,
    resizable: false,
    maximizable: false,
    minimizable: false,
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#09090b',
    title: 'Starting PixelForge AI',
    icon: app.isPackaged ? undefined : path.join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  splash.setMenuBarVisibility(false);
  splash.once('ready-to-show', () => splash.show());
  splash.on('closed', () => logger.info('startup-splash.closed'));
  void splash.loadFile(path.join(app.getAppPath(), 'static', 'splash.html')).catch((err) => {
    logger.warn('startup-splash.load-failed', { error: String(err) });
    if (!splash.isDestroyed()) splash.destroy();
  });
  logger.info('startup-splash.created');
  return splash;
}

export function closeStartupSplash(splash: BrowserWindow | null, logger: Logger): void {
  if (!splash || splash.isDestroyed()) return;
  splash.destroy();
  logger.info('startup-splash.dismissed');
}
