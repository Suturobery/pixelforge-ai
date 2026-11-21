import path from 'node:path';

import { app } from 'electron';

export const isDev = !app.isPackaged;

export const SMOKE = process.env.PF_SMOKE === '1';
export const OPEN_DEVTOOLS = process.env.PF_DEVTOOLS === '1' && isDev;

export type RendererTarget =
  | { kind: 'dev-server'; url: string }
  | { kind: 'shell'; file: string };

/** Internal port of the embedded Next standalone renderer (Task 4). */
export const RENDERER_PORT = (() => {
  const parsed = Number(process.env.PF_RENDERER_PORT ?? 3131);
  // a NaN/garbage PF_RENDERER_PORT would flow into PORT=NaN and the child
  // would never bind — fall back and let the operator see it in the log
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3131;
})();

/**
 * Resolve which renderer the shell loads (v3.1 §12 Task 1 → Task 4):
 *  - PF_RENDERER=shell  → bundled static shell page (bridge smoke / diagnostic)
 *  - dev (default)      → the existing web prototype on localhost:3000 (§10 reuse plan)
 *  - packaged (prod)    → the embedded Next standalone renderer on a private
 *                         loopback port (started by RenderServer in main)
 */
export function resolveRendererTarget(): RendererTarget {
  const shellFile = path.join(app.getAppPath(), 'static', 'shell.html');
  if (process.env.PF_RENDERER === 'shell') {
    return { kind: 'shell', file: shellFile };
  }
  if (isDev) {
    return { kind: 'dev-server', url: process.env.PF_DEV_URL ?? 'http://localhost:3000' };
  }
  return { kind: 'dev-server', url: `http://127.0.0.1:${RENDERER_PORT}` };
}
