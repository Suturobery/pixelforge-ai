/**
 * PixelForge AI — Aseprite (.ase / .aseprite) binary importer.
 *
 * Pure TypeScript, zero external dependencies, DOM-free (§8.3). Uses
 * DecompressionStream('deflate') (RFC 1950 zlib) — identical to persist/png.ts.
 *
 * Supported Aseprite spec features:
 *   • Color depths: 32bpp RGBA, 16bpp Grayscale+Alpha, 8bpp Indexed
 *   • Layer chunks (0x2004): visibility, opacity, lock, blend modes, groups skipped safely
 *   • Cel chunks (0x2005): raw (0), linked (1), zlib-compressed (2), signed (x, y) clipping
 *   • Palette chunks: new palette (0x2019) and legacy palette (0x0004), transparent index
 *   • Tags chunks (0x2018): automatically split into PixelForge Clips with loop modes
 *   • Per-frame durations (ms) preserved accurately
 */

import { uid } from '../id';
import { SCHEMA_VERSION } from '../version';
import {
  CANVAS_MAX,
  CANVAS_MIN,
  type BlendMode,
  type Cel,
  type Clip,
  type Frame,
  type Layer,
  type LoopMode,
  type Project,
  type RGBA,
} from '../types/document';

const ASE_HEADER_MAGIC = 0xa5e0;
const ASE_FRAME_MAGIC = 0xf1fa;

const CHUNK_OLD_PALETTE = 0x0004;
const CHUNK_LAYER = 0x2004;
const CHUNK_CEL = 0x2005;
const CHUNK_TAGS = 0x2018;
const CHUNK_PALETTE = 0x2019;

export interface AsepriteImportResult {
  project: Project;
  warnings: string[];
  stats: {
    width: number;
    height: number;
    colorDepth: 8 | 16 | 32;
    layers: number;
    frames: number;
    clips: number;
    paletteSize: number;
  };
}

interface ParsedLayer {
  aseIndex: number;
  type: number; // 0 = normal, 1 = group, 2 = tilemap
  isBackground: boolean;
  layer: Layer | null; // null for groups/tilemaps
}

interface ParsedTag {
  name: string;
  from: number;
  to: number;
  loopMode: LoopMode;
}

interface ParsedFrame {
  durationMs: number;
  cels: Map<number, Uint8ClampedArray>; // keyed by aseLayerIndex
}

function copyForStream(data: Uint8Array) {
  const copy = new Uint8Array(new ArrayBuffer(data.length));
  copy.set(data);
  return copy;
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('DecompressionStream is unavailable in this runtime');
  }
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  void writer.write(copyForStream(data)).catch(() => {});
  void writer.close().catch(() => {});
  const buf = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(buf);
}

function readUtf8(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder('utf-8').decode(bytes.subarray(offset, offset + length));
}

function mapBlendMode(code: number): BlendMode | undefined {
  switch (code) {
    case 0:
      return undefined; // normal
    case 1:
      return 'multiply';
    case 2:
      return 'screen';
    case 3:
      return 'overlay';
    case 4:
      return 'darken';
    case 5:
      return 'lighten';
    default:
      return undefined;
  }
}

function mapLoopMode(code: number): LoopMode {
  if (code === 1) return 'reverse';
  if (code === 2 || code === 3) return 'pingpong';
  return 'forward';
}

function rgbaToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function decodePixelsToCanvas(params: {
  raw: Uint8Array;
  celW: number;
  celH: number;
  celX: number;
  celY: number;
  celOpacity: number;
  canvasW: number;
  canvasH: number;
  colorDepth: 8 | 16 | 32;
  palette: RGBA[];
  transparentIndex: number;
  isBackground: boolean;
}): Uint8ClampedArray {
  const {
    raw,
    celW,
    celH,
    celX,
    celY,
    celOpacity,
    canvasW,
    canvasH,
    colorDepth,
    palette,
    transparentIndex,
    isBackground,
  } = params;
  const out = new Uint8ClampedArray(canvasW * canvasH * 4);
  const bpp = colorDepth === 32 ? 4 : colorDepth === 16 ? 2 : 1;
  const opacityScale = celOpacity < 255 ? celOpacity / 255 : 1;

  for (let sy = 0; sy < celH; sy++) {
    const dy = celY + sy;
    if (dy < 0 || dy >= canvasH) continue;
    for (let sx = 0; sx < celW; sx++) {
      const dx = celX + sx;
      if (dx < 0 || dx >= canvasW) continue;
      const srcIdx = (sy * celW + sx) * bpp;
      if (srcIdx + bpp > raw.length) continue;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (colorDepth === 32) {
        r = raw[srcIdx]!;
        g = raw[srcIdx + 1]!;
        b = raw[srcIdx + 2]!;
        a = raw[srcIdx + 3]!;
      } else if (colorDepth === 16) {
        const v = raw[srcIdx]!;
        r = v;
        g = v;
        b = v;
        a = raw[srcIdx + 1]!;
      } else {
        const idx = raw[srcIdx]!;
        if (idx === transparentIndex && !isBackground) {
          continue;
        }
        const entry = palette[idx];
        if (!entry) continue;
        r = entry[0];
        g = entry[1];
        b = entry[2];
        a = isBackground ? 255 : entry[3];
      }

      const finalA = opacityScale < 1 ? Math.round(a * opacityScale) : a;
      if (finalA === 0) continue;

      const dstIdx = (dy * canvasW + dx) * 4;
      out[dstIdx] = r;
      out[dstIdx + 1] = g;
      out[dstIdx + 2] = b;
      out[dstIdx + 3] = finalA;
    }
  }
  return out;
}

function extractFallbackPalette(frames: ParsedFrame[]): string[] {
  const seen = new Set<string>();
  const colors: string[] = [];
  for (const f of frames) {
    for (const buf of f.cels.values()) {
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i + 3]! === 0) continue;
        const hex = rgbaToHex(buf[i]!, buf[i + 1]!, buf[i + 2]!);
        if (!seen.has(hex)) {
          seen.add(hex);
          colors.push(hex);
          if (colors.length >= 64) return colors;
        }
      }
    }
  }
  return colors.length > 0 ? colors : ['#000000', '#ffffff', '#14b8a6', '#f59e0b'];
}

function buildClipFromRange(params: {
  name: string;
  loopMode: LoopMode;
  parsedLayers: ParsedLayer[];
  parsedFrames: ParsedFrame[];
  from: number;
  to: number;
}): Clip {
  const { name, loopMode, parsedLayers, parsedFrames, from, to } = params;
  const imageLayers = parsedLayers.filter((pl): pl is ParsedLayer & { layer: Layer } => pl.layer !== null);

  // Clone layer descriptors with fresh ids per clip (C1: per-clip layer stack)
  const aseToClipLayerId = new Map<number, string>();
  const layers: Layer[] =
    imageLayers.length > 0
      ? imageLayers.map((pl) => {
          const id = uid('ly');
          aseToClipLayerId.set(pl.aseIndex, id);
          return { ...pl.layer, id };
        })
      : [{ id: uid('ly'), name: 'Layer 1', visible: true, opacity: 1, linked: false }];

  const slice = parsedFrames.slice(from, to + 1);
  const firstMs = slice[0]?.durationMs || 125;
  const fps = Math.max(1, Math.min(60, Math.round(1000 / Math.max(16, firstMs))));

  const frames: Frame[] = slice.map((pf) => {
    const cels: Record<string, Cel> = {};
    for (const [aseIdx, buf] of pf.cels.entries()) {
      const layerId = aseToClipLayerId.get(aseIdx);
      if (!layerId) continue;
      cels[layerId] = { buffer: new Uint8ClampedArray(buf), linked: false };
    }
    return {
      id: uid('fr'),
      durationMs: pf.durationMs > 0 ? pf.durationMs : 0,
      cels,
    };
  });

  if (frames.length === 0) {
    frames.push({ id: uid('fr'), durationMs: 0, cels: {} });
  }

  return {
    id: uid('cl'),
    name,
    fps,
    loop: true,
    loopMode,
    layers,
    parts: [],
    frames,
    tags: [],
  };
}

/**
 * Parse a binary `.ase` / `.aseprite` file into a live PixelForge v2 Project.
 */
export async function importAseprite(
  bytes: Uint8Array,
  options?: { name?: string },
): Promise<AsepriteImportResult> {
  if (bytes.byteLength < 128) {
    throw new Error('File is too small to be a valid Aseprite document.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint16(4, true);
  if (magic !== ASE_HEADER_MAGIC) {
    throw new Error('Not a valid Aseprite file (bad header magic).');
  }

  const frameCount = view.getUint16(6, true);
  const rawWidth = view.getUint16(8, true);
  const rawHeight = view.getUint16(10, true);
  const colorDepth = view.getUint16(12, true);
  const headerFlags = view.getUint32(14, true);
  const legacySpeed = view.getUint16(18, true);
  const transparentIndex = view.getUint8(28);
  const layerOpacityValid = (headerFlags & 1) !== 0;

  if (frameCount === 0) {
    throw new Error('Aseprite file contains zero frames.');
  }
  if (rawWidth < 1 || rawHeight < 1) {
    throw new Error(`Invalid Aseprite dimensions (${rawWidth}×${rawHeight}).`);
  }
  if (rawWidth > CANVAS_MAX || rawHeight > CANVAS_MAX) {
    throw new Error(
      `Aseprite canvas ${rawWidth}×${rawHeight} exceeds PixelForge's ${CANVAS_MAX}×${CANVAS_MAX} maximum.`,
    );
  }
  if (colorDepth !== 8 && colorDepth !== 16 && colorDepth !== 32) {
    throw new Error(`Unsupported Aseprite color depth (${colorDepth} bpp).`);
  }

  const warnings: string[] = [];
  const canvasW = Math.max(CANVAS_MIN, rawWidth);
  const canvasH = Math.max(CANVAS_MIN, rawHeight);
  if (canvasW !== rawWidth || canvasH !== rawHeight) {
    warnings.push(`Padded small ${rawWidth}×${rawHeight} sprite onto a ${canvasW}×${canvasH} canvas.`);
  }

  const paletteRgba: RGBA[] = Array.from({ length: 256 }, () => [0, 0, 0, 255] as RGBA);
  let hasPaletteChunk = false;
  let paletteCount = 0;

  const parsedLayers: ParsedLayer[] = [];
  const parsedTags: ParsedTag[] = [];
  const parsedFrames: ParsedFrame[] = [];

  let offset = 128;

  for (let f = 0; f < frameCount; f++) {
    if (offset + 16 > bytes.byteLength) {
      warnings.push(`File ended early at frame ${f + 1} of ${frameCount}.`);
      break;
    }
    const frameSize = view.getUint32(offset, true);
    const frameMagic = view.getUint16(offset + 4, true);
    if (frameMagic !== ASE_FRAME_MAGIC || frameSize < 16) {
      throw new Error(`Corrupt frame header at frame ${f + 1}.`);
    }
    const oldChunks = view.getUint16(offset + 6, true);
    const duration = view.getUint16(offset + 8, true) || legacySpeed || 125;
    const newChunks = view.getUint32(offset + 12, true);
    const chunkCount = newChunks > 0 ? newChunks : oldChunks;

    const frameEnd = Math.min(bytes.byteLength, offset + frameSize);
    let chunkOff = offset + 16;

    const frameCels = new Map<number, Uint8ClampedArray>();
    const pendingCels: Array<{
      layerIndex: number;
      x: number;
      y: number;
      opacity: number;
      celType: number;
      linkedFrame?: number;
      w?: number;
      h?: number;
      raw?: Uint8Array;
    }> = [];

    for (let c = 0; c < chunkCount; c++) {
      if (chunkOff + 6 > frameEnd) break;
      const chunkSize = view.getUint32(chunkOff, true);
      const chunkType = view.getUint16(chunkOff + 4, true);
      if (chunkSize < 6 || chunkOff + chunkSize > frameEnd) break;

      const dataStart = chunkOff + 6;
      const dataEnd = chunkOff + chunkSize;

      if (chunkType === CHUNK_LAYER && dataStart + 18 <= dataEnd) {
        const flags = view.getUint16(dataStart, true);
        const layerType = view.getUint16(dataStart + 2, true);
        const blendCode = view.getUint16(dataStart + 10, true);
        const rawOpacity = view.getUint8(dataStart + 12);
        const nameLen = view.getUint16(dataStart + 16, true);
        const name =
          dataStart + 18 + nameLen <= dataEnd
            ? readUtf8(bytes, dataStart + 18, nameLen).trim() || `Layer ${parsedLayers.length + 1}`
            : `Layer ${parsedLayers.length + 1}`;

        const visible = (flags & 1) !== 0;
        const editable = (flags & 2) !== 0;
        const isBackground = (flags & 8) !== 0;
        const opacity = layerOpacityValid ? Math.round((rawOpacity / 255) * 100) / 100 : 1;
        const aseIndex = parsedLayers.length;

        if (layerType === 0) {
          parsedLayers.push({
            aseIndex,
            type: layerType,
            isBackground,
            layer: {
              id: uid('ly'),
              name,
              visible,
              opacity,
              linked: false,
              ...(editable ? {} : { locked: true }),
              ...(mapBlendMode(blendCode) ? { blend: mapBlendMode(blendCode) } : {}),
            },
          });
        } else {
          if (layerType === 2) {
            warnings.push(`Skipped tilemap layer "${name}" (not supported yet).`);
          }
          parsedLayers.push({ aseIndex, type: layerType, isBackground, layer: null });
        }
      } else if (chunkType === CHUNK_PALETTE && dataStart + 20 <= dataEnd) {
        const totalSize = view.getUint32(dataStart, true);
        const firstIdx = view.getUint32(dataStart + 4, true);
        const lastIdx = view.getUint32(dataStart + 8, true);
        let pOff = dataStart + 20;
        paletteCount = Math.max(paletteCount, Math.min(256, totalSize));
        hasPaletteChunk = true;
        for (let idx = firstIdx; idx <= lastIdx && idx < 256; idx++) {
          if (pOff + 6 > dataEnd) break;
          const entryFlags = view.getUint16(pOff, true);
          const r = view.getUint8(pOff + 2);
          const g = view.getUint8(pOff + 3);
          const b = view.getUint8(pOff + 4);
          const a = view.getUint8(pOff + 5);
          paletteRgba[idx] = [r, g, b, a];
          pOff += 6;
          if ((entryFlags & 1) !== 0 && pOff + 2 <= dataEnd) {
            const nameLen = view.getUint16(pOff, true);
            pOff += 2 + nameLen;
          }
        }
      } else if (chunkType === CHUNK_OLD_PALETTE && !hasPaletteChunk && dataStart + 2 <= dataEnd) {
        const packets = view.getUint16(dataStart, true);
        let pOff = dataStart + 2;
        let idx = 0;
        for (let p = 0; p < packets && pOff + 2 <= dataEnd; p++) {
          idx += view.getUint8(pOff);
          let count = view.getUint8(pOff + 1);
          pOff += 2;
          if (count === 0) count = 256;
          for (let k = 0; k < count && idx < 256 && pOff + 3 <= dataEnd; k++, idx++) {
            paletteRgba[idx] = [view.getUint8(pOff), view.getUint8(pOff + 1), view.getUint8(pOff + 2), 255];
            pOff += 3;
          }
          paletteCount = Math.max(paletteCount, idx);
        }
      } else if (chunkType === CHUNK_TAGS && dataStart + 10 <= dataEnd) {
        const numTags = view.getUint16(dataStart, true);
        let tOff = dataStart + 10;
        for (let t = 0; t < numTags && tOff + 19 <= dataEnd; t++) {
          const from = view.getUint16(tOff, true);
          const to = view.getUint16(tOff + 2, true);
          const dir = view.getUint8(tOff + 4);
          // 2 bytes repeat + 6 reserved + 3 rgb + 1 extra = 12 bytes -> name at +17
          const nameLen = view.getUint16(tOff + 17, true);
          const nameStart = tOff + 19;
          const tagName =
            nameStart + nameLen <= dataEnd
              ? readUtf8(bytes, nameStart, nameLen).trim() || `clip-${t + 1}`
              : `clip-${t + 1}`;
          parsedTags.push({
            name: tagName,
            from,
            to,
            loopMode: mapLoopMode(dir),
          });
          tOff = nameStart + nameLen;
        }
      } else if (chunkType === CHUNK_CEL && dataStart + 16 <= dataEnd) {
        const layerIndex = view.getUint16(dataStart, true);
        const x = view.getInt16(dataStart + 2, true);
        const y = view.getInt16(dataStart + 4, true);
        const opacity = view.getUint8(dataStart + 6);
        const celType = view.getUint16(dataStart + 7, true);
        // 7 reserved bytes -> payload starts at dataStart + 16
        const payload = dataStart + 16;

        if (celType === 1 && payload + 2 <= dataEnd) {
          const linkedFrame = view.getUint16(payload, true);
          pendingCels.push({ layerIndex, x, y, opacity, celType, linkedFrame });
        } else if ((celType === 0 || celType === 2) && payload + 4 <= dataEnd) {
          const w = view.getUint16(payload, true);
          const h = view.getUint16(payload + 2, true);
          const slice = bytes.subarray(payload + 4, dataEnd);
          const raw = celType === 2 ? await inflateZlib(slice) : slice;
          pendingCels.push({ layerIndex, x, y, opacity, celType, w, h, raw });
        }
      }

      chunkOff += chunkSize;
    }

    // Resolve cels after reading all chunks in this frame (palette chunk may follow cel chunks)
    for (const cel of pendingCels) {
      const layerMeta = parsedLayers[cel.layerIndex];
      if (!layerMeta || !layerMeta.layer) continue;
      if (cel.celType === 1 && cel.linkedFrame !== undefined) {
        const target = parsedFrames[cel.linkedFrame]?.cels.get(cel.layerIndex);
        if (target) {
          frameCels.set(cel.layerIndex, new Uint8ClampedArray(target));
        }
      } else if (cel.raw && cel.w && cel.h) {
        const buf = decodePixelsToCanvas({
          raw: cel.raw,
          celW: cel.w,
          celH: cel.h,
          celX: cel.x,
          celY: cel.y,
          celOpacity: cel.opacity,
          canvasW,
          canvasH,
          colorDepth,
          palette: paletteRgba,
          transparentIndex,
          isBackground: layerMeta.isBackground,
        });
        frameCels.set(cel.layerIndex, buf);
      }
    }

    parsedFrames.push({ durationMs: duration, cels: frameCels });
    offset = frameEnd;
  }

  // Build project palette from palette chunk or pixel fallback
  let palette: string[] = [];
  if (paletteCount > 0) {
    const seen = new Set<string>();
    for (let i = 0; i < Math.min(256, paletteCount); i++) {
      const entry = paletteRgba[i]!;
      if (colorDepth === 8 && i === transparentIndex) continue;
      const hex = rgbaToHex(entry[0], entry[1], entry[2]);
      if (!seen.has(hex)) {
        seen.add(hex);
        palette.push(hex);
      }
    }
  }
  if (palette.length === 0) {
    palette = extractFallbackPalette(parsedFrames);
  }

  // Build Clips: one clip per valid tag, or one clip containing all frames
  const validTags = parsedTags.filter(
    (t) => t.from >= 0 && t.to >= t.from && t.to < parsedFrames.length,
  );
  const clips: Clip[] =
    validTags.length > 0
      ? validTags.map((t) =>
          buildClipFromRange({
            name: t.name,
            loopMode: t.loopMode,
            parsedLayers,
            parsedFrames,
            from: t.from,
            to: t.to,
          }),
        )
      : [
          buildClipFromRange({
            name: 'idle',
            loopMode: 'forward',
            parsedLayers,
            parsedFrames,
            from: 0,
            to: Math.max(0, parsedFrames.length - 1),
          }),
        ];

  const projectName = (options?.name ?? 'imported-sprite')
    .replace(/\.(aseprite|ase)$/i, '')
    .trim() || 'imported-sprite';

  const project: Project = {
    id: null,
    schemaVersion: SCHEMA_VERSION,
    name: projectName,
    width: canvasW,
    height: canvasH,
    palette,
    settings: {
      paletteEnforce: false,
      onion: { prev: 1, next: 1 },
    },
    clips,
    trash: [],
  };

  const imageLayerCount = parsedLayers.filter((l) => l.layer !== null).length;

  return {
    project,
    warnings,
    stats: {
      width: canvasW,
      height: canvasH,
      colorDepth,
      layers: Math.max(1, imageLayerCount),
      frames: parsedFrames.length,
      clips: clips.length,
      paletteSize: palette.length,
    },
  };
}
