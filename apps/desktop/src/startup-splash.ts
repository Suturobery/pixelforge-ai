// PixelForge AI desktop — integrated in-window startup splash.
//
// The packaged editor boots a local Next renderer server on launch. Instead of
// popping up a separate detached floating box, load `static/splash.html`
// directly inside the main studio window so the user immediately sees one
// unified dark window (with the integrated titlebar & window controls attached)
// that transitions seamlessly into the editor once ready.

import path from 'node:path';

import { app, type BrowserWindow } from 'electron';

import type { Logger } from './logger';

export async function loadStartupSplash(win: BrowserWindow, logger: Logger): Promise<void> {
  if (win.isDestroyed()) return;
  try {
    await win.loadFile(path.join(app.getAppPath(), 'static', 'splash.html'));
    logger.info('startup-splash.loaded-in-window');
  } catch (err) {
    logger.warn('startup-splash.load-failed', { error: String(err) });
  }
}
