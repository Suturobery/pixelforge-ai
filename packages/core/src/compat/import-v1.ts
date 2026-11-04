/**
 * v1 → v2 project importer (v3.1 §2.4 "Migration", §13 "v1→v2 migration
 * golden files incl. loop mapping C3; forward-read refusal").
 *
 * v1 shape (prototype serialize.ts): per-frame layer stacks, each layer a
 * PNG data URL, `loop: boolean` per clip. v1 layer ids are PER-FRAME (the
 * flaw v2 fixes), so layers are matched across frames **by name** (first
 * occurrence wins; the prototype's own deleteFrame had the same constraint).
 *
 * Guarantees:
 *  - unknown-shaped input is rejected up front (never half-converted);
 *  - loop mapping per C3 (loop:false = play once, mode forward);
 *  - a layer missing from a frame becomes an ABSENT cel (= transparent, C2)
 *    with a warning;
 *  - layer property mismatches across frames adopt the first occurrence and
 *    warn;
 *  - cel PNG dimension mismatches are pad/cropped (top-left anchored) with a
 *    warning — v1 canvases were always drawn at project size, but a resized
 *    v1 file could carry stale cels;
 *  - the result passes validateSerializedProjectV2 when re-serialized.
 */

import type { Cel, Clip, Frame, Layer, Part, Project } from '../types/document';
import { ONION_MAX } from '../types/document';
import type {
  CelSourceResolver,
  V1ImportResult,
  V1SerializedClip,
  V1SerializedProject,
  V1ToV2Importer,
} from '../types/v1';
import { isSerializedProjectV1, mapV1Loop } from '../types/v1';
import { v1ClipSkeleton, v2ProjectShell } from './v1';
import { decodePng, peekPngSize } from '../persist/png';
import { base64Decode } from '../persist/base64';
import { PersistError } from '../persist/errors';

export class V1ProjectImporter implements V1ToV2Importer {
  async import(
    raw: unknown,
    resolver: CelSourceResolver,
    opts: { name?: string; id?: string | null } = {}
  ): Promise<V1ImportResult> {
    if (!isSerializedProjectV1(raw)) {
      throw new PersistError(
        'INVALID_SCHEMA',
        'input is not a v1 serialized project (version:1 with name/width/height/palette/clips)'
      );
    }
    const v1 = raw as V1SerializedProject;
    const warnings: string[] = [];
    const project = v2ProjectShell(v1, { id: opts.id ?? null });
    if (opts.name) project.name = opts.name;

    // OPTIONAL Task 6 extension: document onion-skin range. Only values in
    // 0..ONION_MAX are adopted; anything else keeps the shell default.
    const v1Onion = v1.settings?.onion;
    if (v1Onion && typeof v1Onion === 'object') {
      const ok = (n: unknown): n is number =>
        typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= ONION_MAX;
      if (ok(v1Onion.prev) || ok(v1Onion.next)) {
        project.settings.onion = {
          prev: ok(v1Onion.prev) ? v1Onion.prev : project.settings.onion.prev,
          next: ok(v1Onion.next) ? v1Onion.next : project.settings.onion.next,
        };
      } else if (v1Onion.prev !== undefined || v1Onion.next !== undefined) {
        warnings.push('project.settings.onion: invalid values ignored — using defaults');
      }
    }

    for (const v1Clip of v1.clips) {
      project.clips.push(await importClip(v1Clip, v1, resolver, warnings));
    }

    return { project, warnings };
  }
}

async function importClip(
  v1Clip: V1SerializedClip,
  v1: V1SerializedProject,
  resolver: CelSourceResolver,
  warnings: string[]
): Promise<Clip> {
  const clip = v1ClipSkeleton(v1Clip);

  // OPTIONAL Task 6 extension: preserve the playback direction when the
  // exporter stored it. Anything else (absent/unknown) stays the C3 default.
  if (v1Clip.loopMode !== undefined) {
    if (v1Clip.loopMode === 'forward' || v1Clip.loopMode === 'reverse' || v1Clip.loopMode === 'pingpong') {
      clip.loopMode = v1Clip.loopMode;
    } else {
      warnings.push(
        `clip "${v1Clip.name}": unknown loopMode "${String(v1Clip.loopMode)}" — using forward`
      );
    }
  }

  // Union of layers across frames, matched by name, first occurrence wins.
  const layerNames: string[] = [];
  const layerProps = new Map<
    string,
    { id: string; visible: boolean; opacity: number; locked: boolean; blend?: 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' }
  >();
  for (const frame of v1Clip.frames) {
    for (const layer of frame.layers) {
      if (!layerProps.has(layer.name)) {
        layerNames.push(layer.name);
        layerProps.set(layer.name, {
          id: layer.id,
          visible: layer.visible,
          opacity: layer.opacity,
          locked: layer.locked === true,
          ...(layer.blend && layer.blend !== 'normal' ? { blend: layer.blend } : {}),
        });
      } else {
        const first = layerProps.get(layer.name)!;
        if (first.visible !== layer.visible || Math.abs(first.opacity - layer.opacity) > 1e-9) {
          warnings.push(
            `clip "${v1Clip.name}": layer "${layer.name}" has differing visibility/opacity across frames — keeping the first occurrence`
          );
        }
        if (first.id !== layer.id) {
          warnings.push(
            `clip "${v1Clip.name}": layer "${layer.name}" has per-frame ids (v1 model) — matched by name`
          );
        }
      }
    }
  }

  const layers: Layer[] = layerNames.map((name) => {
    const props = layerProps.get(name)!;
    return {
      id: props.id,
      name,
      visible: props.visible,
      opacity: props.opacity,
      linked: false, // v1 has no linked concept
      ...(props.locked ? { locked: true } : {}),
      ...(props.blend ? { blend: props.blend } : {}),
    };
  });
  clip.layers = layers;
  const byName = new Map(layers.map((l) => [l.name, l]));
  // parts reference layer ids — resolves against the first-occurrence ids
  // (v1 files with per-frame differing ids already warn about name matching)
  const byId = new Map(layers.map((l) => [l.id, l]));

  const frames: Frame[] = [];
  for (const v1Frame of v1Clip.frames) {
    const cels: Record<string, Cel> = {};
    for (const v1Layer of v1Frame.layers) {
      const layer = byName.get(v1Layer.name);
      if (!layer) {
        warnings.push(`clip "${v1Clip.name}" frame "${v1Frame.id}": layer "${v1Layer.name}" not in stack — skipped`);
        continue;
      }
      let buffer: Uint8ClampedArray;
      try {
        // Dimension mismatch detection (top-left crop/pad in the resolver).
        const marker = 'base64,';
        const mIdx = v1Layer.png.indexOf(marker);
        const raw = base64Decode(mIdx >= 0 ? v1Layer.png.slice(mIdx + marker.length) : v1Layer.png);
        const size = peekPngSize(raw);
        if (size && (size.width !== v1.width || size.height !== v1.height)) {
          warnings.push(
            `clip "${v1Clip.name}" frame "${v1Frame.id}" layer "${v1Layer.name}": PNG is ${size.width}×${size.height}, project is ${v1.width}×${v1.height} — top-left crop/pad applied`
          );
        }
        buffer = await resolver.resolve(v1Layer.png, v1.width, v1.height);
      } catch (err) {
        warnings.push(
          `clip "${v1Clip.name}" frame "${v1Frame.id}" layer "${v1Layer.name}": PNG decode failed (${err instanceof Error ? err.message : String(err)}) — cel dropped (transparent)`
        );
        continue;
      }
      if (buffer.length !== v1.width * v1.height * 4) {
        // Defensive: a conforming resolver always returns the exact size.
        warnings.push(`clip "${v1Clip.name}" frame "${v1Frame.id}": buffer size mismatch — cel dropped`);
        continue;
      }
      cels[layer.id] = { buffer, linked: false };
    }
    // Warn once per frame about layers absent from this frame (transparent).
    for (const layer of layers) {
      if (!v1Frame.layers.some((l) => l.name === layer.name)) {
        warnings.push(
          `clip "${v1Clip.name}" frame "${v1Frame.id}": layer "${layer.name}" absent — cel left transparent`
        );
      }
    }
    // OPTIONAL Task 6 extension: per-frame duration override (0 = inherit).
    // Invalid values fall back to 0 (fps-inherited) with a warning instead of
    // producing a zero-length playback interval.
    let durationMs = 0;
    const raw = (v1Frame as { durationMs?: unknown }).durationMs;
    if (raw !== undefined) {
      if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 60_000) {
        durationMs = raw;
      } else {
        warnings.push(
          `clip "${v1Clip.name}" frame "${v1Frame.id}": invalid durationMs ${String(raw)} — using the clip fps`
        );
      }
    }
    frames.push({ id: v1Frame.id, durationMs, cels });
  }
  clip.frames = frames;

  // OPTIONAL Task 10 extension: motion parts (v3.1 §4.1). Only well-formed
  // entries are adopted; anything invalid warns and is skipped so a corrupt
  // field can never produce a half-usable composer state.
  if (Array.isArray(v1Clip.parts)) {
    const parts: Part[] = [];
    const seenNames = new Set<string>();
    v1Clip.parts.forEach((raw, i) => {
      const what = `clip "${v1Clip.name}" parts[${i}]`;
      if (!raw || typeof raw !== 'object') {
        warnings.push(`${what}: not an object — skipped`);
        return;
      }
      const p = raw as unknown as Record<string, unknown>;
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      if (!name || name.length > 40) {
        warnings.push(`${what}: invalid name — skipped`);
        return;
      }
      const key = name.toLowerCase();
      if (seenNames.has(key)) {
        warnings.push(`${what}: duplicate name "${name}" — skipped`);
        return;
      }
      const layer = typeof p.layerId === 'string' ? byId.get(p.layerId) : undefined;
      if (!layer) {
        warnings.push(`${what}: layerId not found — skipped`);
        return;
      }
      let rect: Part['rect'];
      if (p.rect !== undefined) {
        const r = p.rect as Record<string, unknown>;
        const x = r.x,
          y = r.y,
          w = r.w,
          h = r.h;
        const ints =
          typeof x === 'number' && Number.isInteger(x) &&
          typeof y === 'number' && Number.isInteger(y) &&
          typeof w === 'number' && Number.isInteger(w) && w >= 1 &&
          typeof h === 'number' && Number.isInteger(h) && h >= 1;
        if (!ints || x < 0 || y < 0 || x + (w as number) > v1.width || y + (h as number) > v1.height) {
          warnings.push(`${what}: rect out of bounds — skipped`);
          return;
        }
        rect = { x, y, w: w as number, h: h as number };
      }
      const anchorFrameId =
        typeof p.anchorFrameId === 'string' && frames.some((f) => f.id === p.anchorFrameId)
          ? p.anchorFrameId
          : frames[0]?.id;
      if (p.anchorFrameId !== undefined && anchorFrameId !== p.anchorFrameId) {
        warnings.push(`${what}: anchor frame not found — using frame 1`);
      }
      const z = typeof p.z === 'number' && Number.isInteger(p.z) ? Math.max(-99, Math.min(99, p.z)) : parts.length;
      seenNames.add(key);
      parts.push({ id: `pt_${i}_${name.replace(/[^a-z0-9_-]/gi, '')}`, name, layerId: layer.id, ...(rect ? { rect } : {}), anchorFrameId, z });
    });
    clip.parts = parts;
  }

  return clip;
}

/**
 * CelSourceResolver for v1 PNG data URLs (data:image/png;base64,…).
 * Dimension mismatches are top-left anchored: crop overflow, pad (transparent)
 * shortfall — deterministic and lossless for conforming v1 files.
 */
export const pngDataUrlResolver: CelSourceResolver = {
  async resolve(src: string, width: number, height: number): Promise<Uint8ClampedArray> {
    const marker = 'base64,';
    const idx = src.indexOf(marker);
    const b64 = idx >= 0 ? src.slice(idx + marker.length) : src;
    let bytes: Uint8Array;
    try {
      bytes = base64Decode(b64);
    } catch (err) {
      throw new PersistError('DECODE_FAILED', 'data URL base64 is invalid', { cause: err });
    }
    const png = await decodePng(bytes);
    const out = new Uint8ClampedArray(width * height * 4);
    const copyW = Math.min(width, png.width);
    const copyH = Math.min(height, png.height);
    for (let y = 0; y < copyH; y++) {
      out.set(
        png.rgba.subarray(y * png.width * 4, y * png.width * 4 + copyW * 4),
        y * width * 4
      );
    }
    return out;
  },
};

/** Convenience singleton (matches the V1ToV2Importer contract). */
export const v1Importer: V1ToV2Importer = new V1ProjectImporter();
