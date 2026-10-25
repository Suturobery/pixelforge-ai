import path from 'node:path';

import { app } from 'electron';

export const isDev = !app.isPackaged;

export const SMOKE = process.env.PF_SMOKE === '1';
export const OPEN_DEVTOOLS = process.env.PF_DEVTOOLS === '1' && isDev;

export type RendererTarget =
  | { kind: 'dev-server'; url: string }
  | { kind: 'shell'; file: string };

/**
 * Resolve which renderer the shell loads (v3.1 §12 Task 1 → Task 4 transition):
 *  - PF_RENDERER=shell  → bundled static shell page (bridge smoke / prod fallback)
 *  - dev (default)      → the existing web prototype on localhost:3000 (§10 reuse plan)
 *  - packaged (prod)    → static shell until Task 4 ports the real renderer
 */
export function resolveRendererTarget(): RendererTarget {
  const shellFile = path.join(app.getAppPath(), 'static', 'shell.html');
  if (process.env.PF_RENDERER === 'shell') {
    return { kind: 'shell', file: shellFile };
  }
  if (isDev) {
    return { kind: 'dev-server', url: process.env.PF_DEV_URL ?? 'http://localhost:3000' };
  }
  return { kind: 'shell', file: shellFile };
}
