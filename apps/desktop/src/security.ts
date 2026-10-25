import type { BrowserWindow, Session } from 'electron';

import type { Logger } from './logger';

/**
 * Report-Only CSP for the dev-server origin (v3.1 §12 Task 1).
 *
 * A hard-enforcing CSP here would break the Next dev server (HMR relies on
 * inline scripts + eval). Strict ENFORCING CSP arrives with the bundled
 * renderer in Task 4; until then violations are visible in DevTools without
 * breaking the prototype. The bundled static shell already enforces a strict
 * CSP via <meta> in static/shell.html.
 */
const DEV_CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i;

export function installSessionHardening(win: BrowserWindow, logger: Logger): void {
  const ses: Session = win.webContents.session;

  // Deny every powerful permission (media, geolocation, notifications, ...).
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    logger.warn('permission.denied', { permission });
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);

  // CSP visibility for the dev server (Report-Only; see docstring above).
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (LOCAL_ORIGIN.test(details.url + '/')) {
      const headers = { ...(details.responseHeaders ?? {}) };
      headers['Content-Security-Policy-Report-Only'] = [DEV_CSP_REPORT_ONLY];
      callback({ responseHeaders: headers });
      return;
    }
    callback({});
  });

  // The prototype exports via anchor-click downloads. Keep Electron's default
  // save flow, but log the audit trail (v3.1 §5.5 audit-log spirit, shell scope).
  ses.on('will-download', (_event, item) => {
    logger.info('download.start', { file: item.getFilename(), url: item.getURL() });
    item.once('done', (_e, state) => logger.info('download.done', { file: item.getFilename(), state }));
  });

  logger.info('session.hardened', { windowId: win.id });
}
