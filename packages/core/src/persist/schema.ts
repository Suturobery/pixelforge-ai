/**
 * Deep structural validation of SerializedProjectV2 (v3.1 §6 / §13 "project
 * schema validation"). Read-path hardening: every structural invariant the
 * runtime model relies on is checked here so the deserializer can assume a
 * coherent document. Pure, synchronous, returns ALL issues (not just the
 * first) so corrupted-file reports are actionable in one pass.
 */

import { CANVAS_MAX, CANVAS_MIN, ONION_MAX, TRASH_CAP, type PartRect } from '../types/document';
import type {
  SerializedCelV2,
  SerializedClipV2,
  SerializedFrameV2,
  SerializedProjectV2,
  SerializedTrashEntryV2,
} from '../types/serialized';
import { PersistError, type PersistIssue } from './errors';
import { assertSafeCelSrc, isSafeId } from './paths';

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const LOOP_MODES = ['forward', 'reverse', 'pingpong'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Validate the full document; throws PersistError('INVALID_SCHEMA') with all issues. */
export function validateSerializedProjectV2OrThrow(doc: unknown): asserts doc is SerializedProjectV2 {
  const issues = validateSerializedProjectV2(doc);
  if (issues.length > 0) {
    const summary = issues
      .slice(0, 8)
      .map((i) => `${i.path}: ${i.message}`)
      .join('; ');
    throw new PersistError('INVALID_SCHEMA', `${issues.length} issue(s) — ${summary}`, { issues });
  }
}

/** Validate and return every issue found (empty array = valid). */
export function validateSerializedProjectV2(doc: unknown): PersistIssue[] {
  const issues: PersistIssue[] = [];
  const add = (path: string, message: string, code: PersistIssue['code'] = 'INVALID_SCHEMA') => {
    issues.push({ path, code, message });
  };

  if (!isRecord(doc) || doc.schemaVersion !== 2) {
    add('schemaVersion', 'must be 2');
    return issues; // cannot continue meaningfully without the version gate
  }
  const p = doc as Partial<SerializedProjectV2>;

  if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > 120) {
    add('name', 'must be a non-empty string (max 120)');
  }
  for (const key of ['width', 'height'] as const) {
    const v = p[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < CANVAS_MIN || v > CANVAS_MAX) {
      add(key, `must be an integer in ${CANVAS_MIN}..${CANVAS_MAX}`);
    }
  }
  if (!Array.isArray(p.palette)) {
    add('palette', 'must be an array');
  } else {
    p.palette.forEach((c, i) => {
      if (typeof c !== 'string' || !HEX.test(c)) add(`palette[${i}]`, 'must be a hex color');
    });
  }
  if (!isRecord(p.settings)) {
    add('settings', 'must be an object');
  } else {
    const s = p.settings as Partial<SerializedProjectV2['settings']>;
    if (typeof s.paletteEnforce !== 'boolean') add('settings.paletteEnforce', 'must be a boolean');
    if (!isRecord(s.onion)) {
      add('settings.onion', 'must be an object');
    } else {
      for (const k of ['prev', 'next'] as const) {
        const v = (s.onion as Record<string, unknown>)[k];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > ONION_MAX) {
          add(`settings.onion.${k}`, `must be an integer in 0..${ONION_MAX}`);
        }
      }
    }
  }

  const clips = Array.isArray(p.clips) ? p.clips : [];
  if (!Array.isArray(p.clips)) add('clips', 'must be an array');
  const clipIds = new Set<string>();
  clips.forEach((clip, ci) => validateClip(clip as SerializedClipV2, `clips[${ci}]`, ci, add, clipIds));
  const trash = Array.isArray(p.trash) ? p.trash : [];
  if (!Array.isArray(p.trash)) add('trash', 'must be an array');
  if (trash.length > TRASH_CAP) {
    add('trash', `exceeds cap of ${TRASH_CAP} entries`);
  }
  const trashIds = new Set<string>();
  trash.forEach((entry, ti) =>
    validateTrashEntry(entry as SerializedTrashEntryV2, `trash[${ti}]`, ti, add, trashIds)
  );

  return issues;
}

function validateClip(
  clip: SerializedClipV2,
  path: string,
  index: number,
  add: (path: string, message: string, code?: PersistIssue['code']) => void,
  clipIds: Set<string>,
  opts: { trashScoped?: boolean } = {}
): void {
  if (!isRecord(clip)) {
    add(path, 'must be an object');
    return;
  }
  const c = clip as Partial<SerializedClipV2>;
  if (typeof c.id !== 'string' || !isSafeId(c.id)) {
    add(`${path}.id`, 'must be a safe id (slug-like, ≤80 chars)');
  } else if (clipIds.has(c.id)) {
    add(`${path}.id`, `duplicate clip id "${c.id}"`);
  } else {
    clipIds.add(c.id);
  }
  if (typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 120) {
    add(`${path}.name`, 'must be a non-empty string');
  }
  if (typeof c.fps !== 'number' || !Number.isInteger(c.fps) || c.fps < 1 || c.fps > 60) {
    add(`${path}.fps`, 'must be an integer in 1..60');
  }
  if (typeof c.loop !== 'boolean') add(`${path}.loop`, 'must be a boolean');
  if (typeof c.loopMode !== 'string' || !(LOOP_MODES as readonly string[]).includes(c.loopMode)) {
    add(`${path}.loopMode`, 'must be forward | reverse | pingpong');
  }

  const layers = Array.isArray(c.layers) ? c.layers : [];
  if (!Array.isArray(c.layers)) add(`${path}.layers`, 'must be an array');
  const layerIds = new Set<string>();
  const linkedLayers = new Map<string, string | null>(); // layerId → expected shared src (null = trash scope: identity-only)
  layers.forEach((layer, li) => {
    const lp = `${path}.layers[${li}]`;
    if (!isRecord(layer)) {
      add(lp, 'must be an object');
      return;
    }
    const l = layer as Partial<SerializedClipV2['layers'][number]>;
    if (typeof l.id !== 'string' || !isSafeId(l.id)) {
      add(`${lp}.id`, 'must be a safe id');
    } else if (layerIds.has(l.id)) {
      add(`${lp}.id`, `duplicate layer id "${l.id}"`);
    } else {
      layerIds.add(l.id);
    }
    if (typeof l.name !== 'string' || l.name.length === 0) add(`${lp}.name`, 'must be a non-empty string');
    if (typeof l.visible !== 'boolean') add(`${lp}.visible`, 'must be a boolean');
    if (typeof l.opacity !== 'number' || l.opacity < 0 || l.opacity > 1) add(`${lp}.opacity`, 'must be in 0..1');
    if (typeof l.linked !== 'boolean') add(`${lp}.linked`, 'must be a boolean');
    else if (l.linked && l.id) {
      linkedLayers.set(l.id, opts.trashScoped ? null : `cels/${c.id}/shared/${l.id}.png`);
    }
  });

  const parts = Array.isArray(c.parts) ? c.parts : [];
  if (!Array.isArray(c.parts)) add(`${path}.parts`, 'must be an array');
  parts.forEach((part, pi) => {
    const pp = `${path}.parts[${pi}]`;
    if (!isRecord(part)) {
      add(pp, 'must be an object');
      return;
    }
    const q = part as Partial<SerializedClipV2['parts'][number]>;
    if (typeof q.id !== 'string' || !isSafeId(q.id)) add(`${pp}.id`, 'must be a safe id');
    if (typeof q.name !== 'string' || q.name.length === 0) add(`${pp}.name`, 'must be a non-empty string');
    if (typeof q.layerId !== 'string' || !layerIds.has(q.layerId)) {
      add(`${pp}.layerId`, `unknown layer "${String(q.layerId)}"`);
    }
    if (typeof q.z !== 'number' || !Number.isInteger(q.z)) add(`${pp}.z`, 'must be an integer');
    if (q.rect !== undefined && q.rect !== null) {
      if (!isRecord(q.rect)) {
        add(`${pp}.rect`, 'must be an object');
      } else {
        const r = q.rect as Partial<PartRect>;
        for (const k of ['x', 'y', 'w', 'h'] as const) {
          const v = r[k];
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) add(`${pp}.rect.${k}`, 'must be a non-negative integer');
        }
        if (typeof r.w === 'number' && typeof r.h === 'number' && (r.w < 1 || r.h < 1)) {
          add(`${pp}.rect`, 'w and h must be ≥ 1');
        }
      }
    }
    if (typeof q.anchorFrameId !== 'string') add(`${pp}.anchorFrameId`, 'must be a string');
  });

  const frames = Array.isArray(c.frames) ? c.frames : [];
  if (!Array.isArray(c.frames)) add(`${path}.frames`, 'must be an array');
  const frameIds = new Set<string>();
  const linkedSeen = new Map<string, string>();
  frames.forEach((frame, fi) => {
    const fp = `${path}.frames[${fi}]`;
    if (!isRecord(frame)) {
      add(fp, 'must be an object');
      return;
    }
    const f = frame as Partial<SerializedFrameV2>;
    if (typeof f.id !== 'string' || !isSafeId(f.id)) {
      add(`${fp}.id`, 'must be a safe id');
    } else if (frameIds.has(f.id)) {
      add(`${fp}.id`, `duplicate frame id "${f.id}"`);
    } else {
      frameIds.add(f.id);
    }
    if (typeof f.durationMs !== 'number' || !Number.isInteger(f.durationMs) || f.durationMs < 0) {
      add(`${fp}.durationMs`, 'must be a non-negative integer');
    }
    const cels = isRecord(f.cels) ? f.cels : undefined;
    if (!cels) {
      add(`${fp}.cels`, 'must be an object');
      return;
    }
    for (const [layerId, cel] of Object.entries(cels)) {
      const cp = `${fp}.cels.${layerId}`;
      if (!layerIds.has(layerId)) {
        add(cp, `cel references unknown layer "${layerId}"`);
        continue;
      }
      if (!isRecord(cel)) {
        add(cp, 'must be an object');
        continue;
      }
      const celObj = cel as Partial<SerializedCelV2>;
      if (typeof celObj.src !== 'string') {
        add(`${cp}.src`, 'must be a string path');
        continue;
      }
      try {
        assertSafeCelSrc(celObj.src);
      } catch (err) {
        add(`${cp}.src`, err instanceof Error ? err.message : 'unsafe cel path', 'UNSAFE_PATH');
        continue;
      }
      const expectedShared = linkedLayers.get(layerId);
      const celLinked = celObj.linked === true;
      if (expectedShared !== undefined) {
        // Layer is linked → every frame must reference the SAME cel.
        if (!celLinked) {
          add(`${cp}.linked`, `layer "${layerId}" is linked but this cel is not marked linked`);
        }
        if (expectedShared !== null) {
          if (celObj.src !== expectedShared) {
            add(`${cp}.src`, `linked layer "${layerId}" must reference "${expectedShared}" in every frame`);
          }
        } else {
          // Trash scope: identity enforced after the frame loop.
          const seen = linkedSeen.get(layerId);
          if (seen === undefined) linkedSeen.set(layerId, celObj.src);
          else if (seen !== celObj.src) {
            add(`${cp}.src`, `linked layer "${layerId}" must reference one shared cel across frames`);
          }
        }
      } else if (celLinked) {
        add(`${cp}.linked`, `layer "${layerId}" is not linked but the cel claims linked`);
      } else if (!opts.trashScoped) {
        const expectedFrame = `cels/${c.id}/${f.id}/${layerId}.png`;
        if (typeof c.id === 'string' && typeof f.id === 'string' && celObj.src !== expectedFrame) {
          add(`${cp}.src`, `expected "${expectedFrame}" for unlinked cel`);
        }
      }
    }
  });

  const tags = Array.isArray(c.tags) ? c.tags : [];
  if (!Array.isArray(c.tags)) add(`${path}.tags`, 'must be an array');
  tags.forEach((tag, gi) => {
    const tp = `${path}.tags[${gi}]`;
    if (!isRecord(tag)) {
      add(tp, 'must be an object');
      return;
    }
    const t = tag as Partial<SerializedClipV2['tags'][number]>;
    if (typeof t.name !== 'string' || t.name.length === 0) add(`${tp}.name`, 'must be a non-empty string');
    if (typeof t.from !== 'number' || !Number.isInteger(t.from) || t.from < 0) add(`${tp}.from`, 'must be ≥ 0');
    if (typeof t.to !== 'number' || !Number.isInteger(t.to) || t.to < 0) add(`${tp}.to`, 'must be ≥ 0');
    if (
      typeof t.from === 'number' &&
      typeof t.to === 'number' &&
      t.from > t.to
    ) {
      add(`${tp}`, 'from must be ≤ to');
    }
    if (typeof t.to === 'number' && frames.length > 0 && t.to >= frames.length) {
      add(`${tp}.to`, `frame range out of bounds (${frames.length} frames)`);
    }
  });
}

function validateTrashEntry(
  entry: SerializedTrashEntryV2,
  path: string,
  index: number,
  add: (path: string, message: string, code?: PersistIssue['code']) => void,
  trashIds: Set<string>
): void {
  if (!isRecord(entry)) {
    add(path, 'must be an object');
    return;
  }
  const e = entry as Partial<SerializedTrashEntryV2>;
  if (typeof e.id !== 'string' || e.id.length === 0) add(`${path}.id`, 'must be a non-empty string');
  else if (trashIds.has(e.id)) add(`${path}.id`, `duplicate trash id "${e.id}"`);
  else trashIds.add(e.id);
  if (typeof e.label !== 'string') add(`${path}.label`, 'must be a string');
  if (typeof e.deletedAt !== 'number' || !Number.isFinite(e.deletedAt)) add(`${path}.deletedAt`, 'must be a number');

  const item = e.item;
  if (!isRecord(item)) {
    add(`${path}.item`, 'must be an object');
    return;
  }
  const it = item as Partial<SerializedTrashEntryV2['item']>;
  if (it.kind === 'frame') {
    if (typeof it.clipId !== 'string') add(`${path}.item.clipId`, 'must be a string');
    if (typeof it.frameIndex !== 'number' || !Number.isInteger(it.frameIndex) || it.frameIndex < 0) {
      add(`${path}.item.frameIndex`, 'must be a non-negative integer');
    }
    validateFrameShape(it.frame, `${path}.item.frame`, index, add, false);
  } else if (it.kind === 'layer') {
    if (typeof it.clipId !== 'string') add(`${path}.item.clipId`, 'must be a string');
    if (typeof it.layerIndex !== 'number' || !Number.isInteger(it.layerIndex) || it.layerIndex < 0) {
      add(`${path}.item.layerIndex`, 'must be a non-negative integer');
    }
    const layer = it.layer as Partial<SerializedClipV2['layers'][number]> | undefined;
    if (!isRecord(layer)) add(`${path}.item.layer`, 'must be an object');
    const celsByFrameId = it.celsByFrameId;
    if (!isRecord(celsByFrameId)) {
      add(`${path}.item.celsByFrameId`, 'must be an object');
    } else {
      for (const [frameId, cel] of Object.entries(celsByFrameId)) {
        validateCelSrcOnly(cel, `${path}.item.celsByFrameId.${frameId}`, `trash/${index}/cels/${frameId}/`, add);
      }
    }
  } else if (it.kind === 'clip') {
    if (typeof it.clipIndex !== 'number' || !Number.isInteger(it.clipIndex) || it.clipIndex < 0) {
      add(`${path}.item.clipIndex`, 'must be a non-negative integer');
    }
    // Trash clips keep their own id namespace (trash-prefixed srcs).
    const ids = new Set<string>();
    validateClip(it.clip as SerializedClipV2, `${path}.item.clip`, -1, add, ids, { trashScoped: true });
  } else {
    add(`${path}.item.kind`, 'must be frame | layer | clip');
  }
}

function validateFrameShape(
  frame: unknown,
  path: string,
  trashIndex: number,
  add: (path: string, message: string, code?: PersistIssue['code']) => void,
  trashClipScoped: boolean
): void {
  if (!isRecord(frame)) {
    add(path, 'must be an object');
    return;
  }
  const f = frame as Partial<SerializedFrameV2>;
  if (typeof f.id !== 'string' || f.id.length === 0) add(`${path}.id`, 'must be a non-empty string');
  if (typeof f.durationMs !== 'number' || !Number.isInteger(f.durationMs) || f.durationMs < 0) {
    add(`${path}.durationMs`, 'must be a non-negative integer');
  }
  if (!isRecord(f.cels)) {
    add(`${path}.cels`, 'must be an object');
    return;
  }
  for (const [layerId, cel] of Object.entries(f.cels)) {
    const prefix = trashIndex >= 0 ? (trashClipScoped ? `trash/${trashIndex}/cels/` : `trash/${trashIndex}/cels/${f.id ?? ''}/`) : 'cels/';
    void prefix;
    validateCelSrcOnly(cel, `${path}.cels.${layerId}`, `trash/${Math.max(trashIndex, 0)}/`, add);
  }
}

function validateCelSrcOnly(
  cel: unknown,
  path: string,
  _expectedPrefix: string,
  add: (path: string, message: string, code?: PersistIssue['code']) => void
): void {
  if (!isRecord(cel)) {
    add(path, 'must be an object');
    return;
  }
  const src = (cel as Partial<SerializedCelV2>).src;
  if (typeof src !== 'string') {
    add(`${path}.src`, 'must be a string path');
    return;
  }
  try {
    assertSafeCelSrc(src);
  } catch (err) {
    add(`${path}.src`, err instanceof Error ? err.message : 'unsafe cel path', 'UNSAFE_PATH');
  }
}
