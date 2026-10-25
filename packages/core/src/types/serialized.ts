/**
 * Serialized project v2 (v3.1 §6 "project.json") — the JSON form of the
 * document. Cel `src` ⇄ in-memory cel 1:1; encoding/decoding of PNG bytes
 * and the .pixelforgeproj ZIP container belong to Task 3; this module defines
 * the contract + structural validation only (pure, DOM-free).
 */

import type { DocumentSettings, LoopMode, PartRect } from './document';
import { CANVAS_MAX, CANVAS_MIN } from './document';

export interface SerializedCelV2 {
  /** Path inside the .pixelforgeproj ZIP, e.g. "cels/cl1/fr1/ly1.png".
   * Linked cels point at "cels/<clipId>/shared/<layerId>.png" (C2). */
  src: string;
  /** True when this entry references the shared cel of a linked layer. */
  linked?: boolean;
}

export interface SerializedFrameV2 {
  id: string;
  /** 0 = inherit clip fps. */
  durationMs: number;
  /** Cel per layer id; absent key = fully transparent (C2). */
  cels: Record<string, SerializedCelV2>;
}

export interface SerializedLayerV2 {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  linked: boolean;
}

export interface SerializedPartV2 {
  id: string;
  name: string;
  layerId: string;
  rect?: PartRect;
  anchorFrameId: string;
  z: number;
}

export interface SerializedTagV2 {
  name: string;
  from: number;
  to: number;
}

export interface SerializedClipV2 {
  id: string;
  name: string;
  fps: number;
  loop: boolean;
  loopMode: LoopMode;
  /** Stack lives PER CLIP, bottom → top (C1). */
  layers: SerializedLayerV2[];
  parts: SerializedPartV2[];
  frames: SerializedFrameV2[];
  tags: SerializedTagV2[];
}

export type SerializedTrashItemV2 =
  | { kind: 'frame'; clipId: string; frameIndex: number; frame: SerializedFrameV2 }
  | {
      kind: 'layer';
      clipId: string;
      layerIndex: number;
      layer: SerializedLayerV2;
      celsByFrameId: Record<string, SerializedCelV2>;
    }
  | { kind: 'clip'; clipIndex: number; clip: SerializedClipV2 };

export interface SerializedTrashEntryV2 {
  id: string;
  label: string;
  deletedAt: number;
  item: SerializedTrashItemV2;
}

export interface SerializedProjectV2 {
  schemaVersion: 2;
  name: string;
  width: number;
  height: number;
  palette: string[];
  trash: SerializedTrashEntryV2[];
  clips: SerializedClipV2[];
  settings: DocumentSettings;
}

export function isSerializedProjectV2(v: unknown): v is SerializedProjectV2 {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<SerializedProjectV2>;
  return (
    p.schemaVersion === 2 &&
    typeof p.name === 'string' &&
    typeof p.width === 'number' &&
    p.width >= CANVAS_MIN &&
    p.width <= CANVAS_MAX &&
    typeof p.height === 'number' &&
    p.height >= CANVAS_MIN &&
    p.height <= CANVAS_MAX &&
    Array.isArray(p.palette) &&
    Array.isArray(p.clips) &&
    Array.isArray(p.trash) &&
    !!p.settings &&
    typeof p.settings === 'object' &&
    Array.isArray(p.clips)
  );
}
