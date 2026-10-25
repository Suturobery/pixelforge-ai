/**
 * Test helpers: deep document comparison used to assert DETERMINISTIC
 * editor state after undo/redo (content equality, not object identity).
 */

import type { Cel, Clip, Frame, Project } from '../src/types/document';

export function celBufferEquals(a: Cel, b: Cel): boolean {
  if (a.linked !== b.linked) return false;
  if (a.buffer === b.buffer) return true;
  if (a.buffer.length !== b.buffer.length) return false;
  for (let i = 0; i < a.buffer.length; i++) {
    if (a.buffer[i] !== b.buffer[i]) return false;
  }
  return true;
}

export function frameEquals(a: Frame, b: Frame): boolean {
  if (a.id !== b.id || a.durationMs !== b.durationMs) return false;
  const ka = Object.keys(a.cels);
  const kb = Object.keys(b.cels);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    const ca = a.cels[key];
    const cb = b.cels[key];
    if (!ca || !cb) return false;
    if (!celBufferEquals(ca, cb)) return false;
  }
  return true;
}

export function clipEquals(a: Clip, b: Clip): boolean {
  if (
    a.id !== b.id ||
    a.name !== b.name ||
    a.fps !== b.fps ||
    a.loop !== b.loop ||
    a.loopMode !== b.loopMode ||
    a.layers.length !== b.layers.length ||
    a.frames.length !== b.frames.length ||
    a.parts.length !== b.parts.length ||
    a.tags.length !== b.tags.length
  ) {
    return false;
  }
  for (let i = 0; i < a.layers.length; i++) {
    const la = a.layers[i];
    const lb = b.layers[i];
    if (
      la.id !== lb.id ||
      la.name !== lb.name ||
      la.visible !== lb.visible ||
      la.opacity !== lb.opacity ||
      la.linked !== lb.linked
    ) {
      return false;
    }
  }
  for (let i = 0; i < a.frames.length; i++) {
    if (!frameEquals(a.frames[i], b.frames[i])) return false;
  }
  return true;
}

export function projectEquals(a: Project, b: Project): boolean {
  if (
    a.name !== b.name ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.schemaVersion !== b.schemaVersion ||
    a.palette.length !== b.palette.length ||
    a.clips.length !== b.clips.length ||
    a.trash.length !== b.trash.length
  ) {
    return false;
  }
  for (let i = 0; i < a.palette.length; i++) {
    if (a.palette[i] !== b.palette[i]) return false;
  }
  for (let i = 0; i < a.clips.length; i++) {
    if (!clipEquals(a.clips[i], b.clips[i])) return false;
  }
  return true;
}

/** Read the RGBA byte of a cel pixel (0,0,0,0 when cel missing). */
export function pixelAt(
  frame: Frame,
  layerId: string,
  width: number,
  x: number,
  y: number
): [number, number, number, number] {
  const cel = frame.cels[layerId];
  if (!cel) return [0, 0, 0, 0];
  const i = (y * width + x) * 4;
  return [cel.buffer[i], cel.buffer[i + 1], cel.buffer[i + 2], cel.buffer[i + 3]];
}

/** Simple deterministic LCG so memory tests get reproducible stroke data. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
