/**
 * Runtime ⇄ serialized v2 conversion (v3.1 §6 "project.json" + cel PNGs).
 *
 * serializeProjectV2: runtime Project → { projectJson, celPngs }.
 *   - Linked layers (C2) encode ONE shared PNG per layer
 *     (cels/<clipId>/shared/<layerId>.png); every frame references it.
 *   - Trash payloads (C5/C9) serialize under trash/<entryIndex>/….
 *   - Buffer identity is deduped (same Uint8ClampedArray object encodes once).
 *
 * projectFromSerialized: { projectJson, celBytes } → runtime Project.
 *   - Decodes each PNG once per unique src (cache).
 *   - RE-SHARES linked cels: every frame of a linked layer receives the SAME
 *     buffer object, restoring "edit once applies everywhere" exactly.
 *
 * Both directions are lossless: save → load deep-equals the original
 * (verified by persist-format tests), including trash and linked identity.
 */

import type { Cel, CellBuffer, Clip, Frame, Project, TrashEntry, TrashItem } from '../types/document';
import type {
  SerializedCelV2,
  SerializedClipV2,
  SerializedFrameV2,
  SerializedLayerV2,
  SerializedProjectV2,
  SerializedTagV2,
  SerializedTrashEntryV2,
  SerializedTrashItemV2,
} from '../types/serialized';
import { decodePng, encodePng } from './png';
import { PersistError } from './errors';
import { celSrc, sharedCelSrc, trashCelSrc, trashClipCelSrc } from './paths';

export interface SerializedWithCels {
  projectJson: SerializedProjectV2;
  /** src path → PNG bytes (every src referenced by projectJson is present). */
  celPngs: Map<string, Uint8Array>;
}

// ---------------------------------------------------------------------------
// runtime → serialized
// ---------------------------------------------------------------------------

export async function serializeProjectV2(project: Project): Promise<SerializedWithCels> {
  const celPngs = new Map<string, Uint8Array>();
  /** Encode-once cache keyed by buffer object identity. */
  const encodeCache = new Map<CellBuffer, Uint8Array>();

  const encodeOnce = async (buffer: CellBuffer): Promise<Uint8Array> => {
    const hit = encodeCache.get(buffer);
    if (hit) return hit;
    const png = await encodePng(project.width, project.height, buffer);
    encodeCache.set(buffer, png);
    return png;
  };

  const put = async (src: string, buffer: CellBuffer): Promise<SerializedCelV2> => {
    // First-wins: a linked layer's shared path takes the FIRST frame's buffer
    // (runtime linked cels share one object; per-frame duplicates from
    // hand-built documents must not have the last frame overwrite the data).
    if (!celPngs.has(src)) {
      celPngs.set(src, await encodeOnce(buffer));
    }
    return { src };
  };

  const serializeCelMap = async (
    clip: { id: string; layers: { id: string; linked: boolean }[] },
    frames: Frame[],
    pathFor: (clipId: string, frameId: string, layerId: string) => string
  ): Promise<Record<string, SerializedCelV2>[]> => {
    const out: Record<string, SerializedCelV2>[] = [];
    for (const frame of frames) {
      const cels: Record<string, SerializedCelV2> = {};
      for (const layer of clip.layers) {
        const cel = frame.cels[layer.id];
        if (!cel) continue; // absent = transparent (C2)
        const src = layer.linked
          ? sharedCelSrc(clip.id, layer.id)
          : pathFor(clip.id, frame.id, layer.id);
        const entry = await put(src, cel.buffer);
        cels[layer.id] = layer.linked ? { ...entry, linked: true } : entry;
      }
      out.push(cels);
    }
    return out;
  };

  const serializeLayer = (l: { id: string; name: string; visible: boolean; opacity: number; linked: boolean }): SerializedLayerV2 => ({
    id: l.id,
    name: l.name,
    visible: l.visible,
    opacity: l.opacity,
    linked: l.linked,
  });

  const serializeClip = async (
    clip: Clip,
    pathFor: (clipId: string, frameId: string, layerId: string) => string
  ): Promise<SerializedClipV2> => ({
    id: clip.id,
    name: clip.name,
    fps: clip.fps,
    loop: clip.loop,
    loopMode: clip.loopMode,
    layers: clip.layers.map(serializeLayer),
    parts: clip.parts.map((part) => ({
      id: part.id,
      name: part.name,
      layerId: part.layerId,
      ...(part.rect ? { rect: { ...part.rect } } : {}),
      anchorFrameId: part.anchorFrameId,
      z: part.z,
    })),
    frames: await (async () => {
      const celMaps = await serializeCelMap(clip, clip.frames, pathFor);
      return clip.frames.map<SerializedFrameV2>((f, i) => ({
        id: f.id,
        durationMs: f.durationMs,
        cels: celMaps[i],
      }));
    })(),
    tags: clip.tags.map<SerializedTagV2>((t) => ({ name: t.name, from: t.from, to: t.to })),
  });

  const clips: SerializedClipV2[] = [];
  for (const clip of project.clips) {
    clips.push(await serializeClip(clip, (clipId, frameId, layerId) => celSrc(clipId, frameId, layerId)));
  }

  const trash: SerializedTrashEntryV2[] = [];
  for (let ti = 0; ti < project.trash.length; ti++) {
    trash.push(await serializeTrashEntry(project.trash[ti], ti, { serializeClip, serializeLayer, put }));
  }

  return {
    projectJson: {
      schemaVersion: 2,
      name: project.name,
      width: project.width,
      height: project.height,
      palette: [...project.palette],
      trash,
      clips,
      settings: {
        paletteEnforce: project.settings.paletteEnforce,
        onion: { prev: project.settings.onion.prev, next: project.settings.onion.next },
      },
    },
    celPngs,
  };
}

interface SerializeCtx {
  serializeClip: (clip: Clip, pathFor: (clipId: string, frameId: string, layerId: string) => string) => Promise<SerializedClipV2>;
  serializeLayer: (l: { id: string; name: string; visible: boolean; opacity: number; linked: boolean }) => SerializedLayerV2;
  put: (src: string, buffer: CellBuffer) => Promise<SerializedCelV2>;
}

async function serializeTrashEntry(
  entry: TrashEntry,
  index: number,
  ctx: SerializeCtx
): Promise<SerializedTrashEntryV2> {
  const item = entry.item;

  if (item.kind === 'frame') {
    const cels: Record<string, SerializedCelV2> = {};
    for (const layer of Object.keys(item.frame.cels)) {
      const cel = item.frame.cels[layer];
      cels[layer] = await ctx.put(trashCelSrc(index, item.frame.id, layer), cel.buffer);
    }
    const frame: SerializedFrameV2 = {
      id: item.frame.id,
      durationMs: item.frame.durationMs,
      cels,
    };
    return {
      id: entry.id,
      label: entry.label,
      deletedAt: entry.deletedAt,
      item: { kind: 'frame', clipId: item.clipId, frameIndex: item.frameIndex, frame },
    };
  }

  if (item.kind === 'layer') {
    const celsByFrameId: Record<string, SerializedCelV2> = {};
    for (const [frameId, cel] of Object.entries(item.celsByFrameId)) {
      celsByFrameId[frameId] = await ctx.put(trashCelSrc(index, frameId, item.layer.id), cel.buffer);
    }
    return {
      id: entry.id,
      label: entry.label,
      deletedAt: entry.deletedAt,
      item: {
        kind: 'layer',
        clipId: item.clipId,
        layerIndex: item.layerIndex,
        layer: ctx.serializeLayer(item.layer),
        celsByFrameId,
      },
    };
  }

  // kind === 'clip' — serialize as a self-contained clip under trash/<i>/.
  const pseudo: Clip = { ...item.clip };
  const clipJson = await ctx.serializeClip(pseudo, (_clipId, frameId, layerId) =>
    trashClipCelSrc(index, item.clip.id, frameId, layerId)
  );
  const trashItem: SerializedTrashItemV2 = { kind: 'clip', clipIndex: item.clipIndex, clip: clipJson };
  return { id: entry.id, label: entry.label, deletedAt: entry.deletedAt, item: trashItem };
}

// ---------------------------------------------------------------------------
// serialized → runtime
// ---------------------------------------------------------------------------

/** Supplies PNG bytes for a cel src (from a ZIP archive or any source). */
export type CelBytesProvider = (src: string) => Uint8Array | undefined;

export async function projectFromSerialized(
  doc: SerializedProjectV2,
  celBytes: CelBytesProvider,
  opts: { id?: string | null } = {}
): Promise<Project> {
  const decodeCache = new Map<string, Uint8ClampedArray>();

  const decode = async (src: string, expectedCel: Cel | undefined): Promise<CellBuffer> => {
    const cached = decodeCache.get(src);
    if (cached) return cached;
    const bytes = celBytes(src);
    if (!bytes) {
      throw new PersistError('MISSING_ENTRY', `cel "${src}" referenced by project.json is absent from the archive`, {
        entry: src,
      });
    }
    const png = await decodePng(bytes, src);
    if (png.width !== doc.width || png.height !== doc.height) {
      throw new PersistError(
        'DECODE_FAILED',
        `cel "${src}" is ${png.width}×${png.height} but the project is ${doc.width}×${doc.height}`,
        { entry: src }
      );
    }
    const buffer: CellBuffer = expectedCel && expectedCel.linked ? png.rgba : png.rgba;
    decodeCache.set(src, buffer);
    return buffer;
  };

  const restoreCelMap = async (
    clipId: string,
    layers: SerializedLayerV2[],
    frame: SerializedFrameV2,
    frameIndex: number
  ): Promise<Record<string, Cel>> => {
    const cels: Record<string, Cel> = {};
    for (const layer of layers) {
      const entry = frame.cels[layer.id];
      if (!entry) continue;
      const buffer = await decode(entry.src, { buffer: new Uint8ClampedArray(0), linked: layer.linked });
      cels[layer.id] = { buffer, linked: entry.linked === true };
    }
    void clipId;
    void frameIndex;
    return cels;
  };

  const clips: Clip[] = [];
  for (const clipJson of doc.clips) {
    // Decode pass 1: materialize every frame's cels (unique srcs decoded once).
    const frames: Frame[] = [];
    for (let fi = 0; fi < clipJson.frames.length; fi++) {
      const frameJson = clipJson.frames[fi];
      frames.push({
        id: frameJson.id,
        durationMs: frameJson.durationMs,
        cels: await restoreCelMap(clipJson.id, clipJson.layers, frameJson, fi),
      });
    }

    // Linked re-share (C2): all frames of a linked layer must reference ONE
    // shared src — decode it once and assign the SAME buffer object.
    for (const layer of clipJson.layers) {
      if (!layer.linked) continue;
      const sharedSrc = sharedCelSrc(clipJson.id, layer.id);
      const bytes = celBytes(sharedSrc);
      if (!bytes) {
        throw new PersistError(
          'MISSING_ENTRY',
          `linked layer "${layer.id}" of clip "${clipJson.id}" expects "${sharedSrc}" which is absent`,
          { entry: sharedSrc }
        );
      }
      const png = await decodePng(bytes, sharedSrc);
      if (png.width !== doc.width || png.height !== doc.height) {
        throw new PersistError('DECODE_FAILED', `shared cel "${sharedSrc}" dimensions mismatch`, {
          entry: sharedSrc,
        });
      }
      const sharedBuffer: CellBuffer = png.rgba;
      for (const frame of frames) {
        const cel = frame.cels[layer.id];
        if (cel) {
          cel.buffer = sharedBuffer;
          cel.linked = true;
        } else {
          frame.cels[layer.id] = { buffer: sharedBuffer, linked: true };
        }
      }
    }

    clips.push({
      id: clipJson.id,
      name: clipJson.name,
      fps: clipJson.fps,
      loop: clipJson.loop,
      loopMode: clipJson.loopMode,
      layers: clipJson.layers.map((l) => ({ ...l })),
      parts: clipJson.parts.map((p) => ({ ...p, ...(p.rect ? { rect: { ...p.rect } } : {}) })),
      frames,
      tags: clipJson.tags.map((t) => ({ ...t })),
    });
  }

  const trash: TrashEntry[] = [];
  for (let ti = 0; ti < doc.trash.length; ti++) {
    trash.push(await trashEntryFromSerialized(doc.trash[ti], ti, celBytes, decodeCache, doc));
  }

  return {
    id: opts.id ?? null,
    schemaVersion: 2,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    palette: [...doc.palette],
    settings: {
      paletteEnforce: doc.settings.paletteEnforce,
      onion: { prev: doc.settings.onion.prev, next: doc.settings.onion.next },
    },
    clips,
    trash,
  };
}

async function trashEntryFromSerialized(
  entry: SerializedTrashEntryV2,
  index: number,
  celBytes: CelBytesProvider,
  _decodeCache: Map<string, Uint8ClampedArray>,
  doc: SerializedProjectV2
): Promise<TrashEntry> {
  const decodeTrash = async (src: string): Promise<CellBuffer> => {
    const bytes = celBytes(src);
    if (!bytes) {
      throw new PersistError('MISSING_ENTRY', `trash cel "${src}" is absent from the archive`, { entry: src });
    }
    const png = await decodePng(bytes, src);
    if (png.width !== doc.width || png.height !== doc.height) {
      throw new PersistError('DECODE_FAILED', `trash cel "${src}" dimensions mismatch`, { entry: src });
    }
    return png.rgba;
  };

  const item = entry.item;

  if (item.kind === 'frame') {
    const cels: Record<string, Cel> = {};
    for (const [layerId, celJson] of Object.entries(item.frame.cels)) {
      cels[layerId] = { buffer: await decodeTrash(celJson.src), linked: celJson.linked === true };
    }
    return {
      id: entry.id,
      label: entry.label,
      deletedAt: entry.deletedAt,
      item: {
        kind: 'frame',
        clipId: item.clipId,
        frameIndex: item.frameIndex,
        frame: { id: item.frame.id, durationMs: item.frame.durationMs, cels },
      },
    };
  }

  if (item.kind === 'layer') {
    const celsByFrameId: Record<string, Cel> = {};
    for (const [frameId, celJson] of Object.entries(item.celsByFrameId)) {
      celsByFrameId[frameId] = { buffer: await decodeTrash(celJson.src), linked: celJson.linked === true };
    }
    return {
      id: entry.id,
      label: entry.label,
      deletedAt: entry.deletedAt,
      item: {
        kind: 'layer',
        clipId: item.clipId,
        layerIndex: item.layerIndex,
        layer: { ...item.layer },
        celsByFrameId,
      },
    };
  }

  // kind === 'clip' — materialize the self-contained trash clip.
  const clipJson = item.clip;
  const frames: Frame[] = [];
  for (const frameJson of clipJson.frames) {
    const cels: Record<string, Cel> = {};
    for (const [layerId, celJson] of Object.entries(frameJson.cels)) {
      cels[layerId] = { buffer: await decodeTrash(celJson.src), linked: celJson.linked === true };
    }
    frames.push({ id: frameJson.id, durationMs: frameJson.durationMs, cels });
  }
  // Re-share linked layers within the trash clip.
  for (const layer of clipJson.layers) {
    if (!layer.linked) continue;
    let shared: CellBuffer | null = null;
    for (const frame of frames) {
      const cel = frame.cels[layer.id];
      if (cel) {
        if (!shared) shared = cel.buffer;
        cel.buffer = shared;
        cel.linked = true;
      }
    }
  }
  return {
    id: entry.id,
    label: entry.label,
    deletedAt: entry.deletedAt,
    item: {
      kind: 'clip',
      clipIndex: item.clipIndex,
      clip: {
        id: clipJson.id,
        name: clipJson.name,
        fps: clipJson.fps,
        loop: clipJson.loop,
        loopMode: clipJson.loopMode,
        layers: clipJson.layers.map((l) => ({ ...l })),
        parts: clipJson.parts.map((p) => ({ ...p, ...(p.rect ? { rect: { ...p.rect } } : {}) })),
        frames,
        tags: clipJson.tags.map((t) => ({ ...t })),
      },
    },
  };
}
