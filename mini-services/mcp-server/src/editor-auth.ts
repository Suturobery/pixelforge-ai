/**
 * PixelForge AI — editor-link authentication secret.
 *
 * The MCP server generates a random editor token at first start and stores
 * it in <dataDir>/editor-auth.json. The PixelForge editor page obtains the
 * SAME token through the app's own guarded API (/api/mcp/editor-key, local
 * connections only) and presents it in the WS hello. Connections without
 * the token can never seize the editor slot, drive the ctrl channel, or
 * answer approval requests.
 *
 * Residual (documented): a DELIBERATE same-user process can read the token
 * file — the same trust level as reading the project database. This fix
 * eliminates accidental/blanket seizure (stray tabs, null-origin drives)
 * and makes editor control require deliberate possession of the secret.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function getOrCreateEditorToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'editor-auth.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown };
    if (typeof parsed.token === 'string' && parsed.token.length >= 32) return parsed.token;
  } catch {
    /* missing/corrupt — regenerate below */
  }
  const token = randomBytes(32).toString('hex');
  // atomic-ish write (tmp + rename) so a crash never leaves a half file
  const tmp = join(dataDir, `editor-auth.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify({ token }, null, 2));
  try {
    renameSync(tmp, file);
  } catch {
    // rename can fail on Windows if a reader holds the target — fall back
    writeFileSync(file, JSON.stringify({ token }, null, 2));
    try {
      require('node:fs').unlinkSync(tmp);
    } catch {
      /* tmp leftover is harmless */
    }
  }
  return token;
}

/** Constant-time string comparison (length-safe). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
