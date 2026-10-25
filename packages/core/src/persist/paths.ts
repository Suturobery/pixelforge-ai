/**
 * Cel source path helpers (v3.1 §6 layout):
 *
 *   cels/<clipId>/<frameId>/<layerId>.png        — per-frame cel
 *   cels/<clipId>/shared/<layerId>.png           — linked cel, stored once (C2)
 *   trash/<entryIndex>/…                          — trash payload cels
 *
 * Paths are always forward-slash, always relative, and validated on read —
 * the same traversal rules as ZIP entry names apply (§9.4).
 */

import { PersistError } from './errors';
import { assertSafeEntryName } from './zip';

/** Matches a safe single path segment (ZIP-safe, slug-like). */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when the id is safe to embed in a cel path. */
export function isSafeId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 80 && SEGMENT.test(id);
}

export function celSrc(clipId: string, frameId: string, layerId: string): string {
  return `cels/${clipId}/${frameId}/${layerId}.png`;
}

export function sharedCelSrc(clipId: string, layerId: string): string {
  return `cels/${clipId}/shared/${layerId}.png`;
}

export function trashCelSrc(entryIndex: number, frameId: string, layerId: string): string {
  return `trash/${entryIndex}/cels/${frameId}/${layerId}.png`;
}

export function trashClipCelSrc(entryIndex: number, clipId: string, frameId: string, layerId: string): string {
  return `trash/${entryIndex}/cels/${clipId}/${frameId}/${layerId}.png`;
}

export const JOURNAL_ENTRY = 'history/journal.jsonl';
export const PROJECT_ENTRY = 'project.json';
export const MANIFEST_ENTRY = 'manifest.json';

/** Validate a cel src from an untrusted document (read path). */
export function assertSafeCelSrc(src: string): void {
  if (typeof src !== 'string' || src.length === 0 || src.length > 400) {
    throw new PersistError('UNSAFE_PATH', `cel src "${String(src)}" is not a safe path`);
  }
  if (!src.endsWith('.png')) {
    throw new PersistError('UNSAFE_PATH', `cel src "${src}" must point to a .png entry`);
  }
  assertSafeEntryName(src);
  if (!/^(cels|trash)\//.test(src)) {
    throw new PersistError('UNSAFE_PATH', `cel src "${src}" must live under cels/ or trash/`);
  }
}
