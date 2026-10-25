/**
 * PNG codec for RGBA8 pixel buffers (v3.1 §6: cels stored as PNG entries).
 *
 * Encoder output: 8-bit RGBA (color type 6), filter type 0 per scanline,
 * non-interlaced — the simplest correct profile for sprite-sized images.
 * Decoder accepts the standard 8-bit profiles (color types 0/2/4/6, all five
 * filter types, non-interlaced) so canvas-exported PNGs and third-party
 * files decode as well.
 *
 * Compression uses CompressionStream('deflate') (zlib RFC 1950, exactly what
 * PNG IDAT requires) — available in Electron, Node ≥ 18, Bun, and browsers,
 * keeping this module dependency-free and DOM-free (§8.3).
 */

import { crc32 } from './crc32';
import { PersistError } from './errors';

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Copy into a fresh ArrayBuffer-backed Uint8Array for stream/WebCrypto APIs. */
function copyForStream(data: Uint8Array | Uint8ClampedArray): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(data.length));
  copy.set(data);
  return copy;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'function') {
    throw new PersistError('ENCODE_FAILED', 'CompressionStream is unavailable in this runtime');
  }
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  // .catch: the stream may reject asynchronously — never surface as unhandled.
  void writer.write(copyForStream(data)).catch(() => {});
  void writer.close().catch(() => {});
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

async function inflate(data: Uint8Array, entry?: string): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new PersistError('DECODE_FAILED', 'DecompressionStream is unavailable in this runtime', { entry });
  }
  try {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    void writer.write(copyForStream(data)).catch(() => {});
    void writer.close().catch(() => {});
    const buf = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(buf);
  } catch (err) {
    throw new PersistError('DECODE_FAILED', 'zlib stream is corrupt', { entry, cause: err });
  }
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/** Encode an RGBA buffer as PNG. Buffer length must equal width*height*4. */
export async function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Promise<Uint8Array> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PersistError('ENCODE_FAILED', `invalid dimensions ${width}×${height}`);
  }
  if (width > 0x7fffffff || height > 0x7fffffff || width * height * 4 !== rgba.length) {
    throw new PersistError('ENCODE_FAILED', `buffer length ${rgba.length} != ${width}×${height}×4`);
  }
  const stride = width * 4;
  // Raw scanlines: one filter byte (0 = None) per row + the row bytes.
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }
  const idat = await deflate(raw);

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, length width*height*4. */
  rgba: Uint8ClampedArray;
}

/** Read width/height from the IHDR chunk without inflating pixel data. */
export function peekPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || !SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode a PNG to RGBA. Supports 8-bit color types 0/2/4/6, filters 0–4, non-interlaced. */
export async function decodePng(bytes: Uint8Array, entry?: string): Promise<DecodedPng> {
  if (bytes.length < 8 || !SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new PersistError('DECODE_FAILED', 'missing PNG signature', { entry });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = -1;
  let interlace = -1;
  const idatParts: Uint8Array[] = [];
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;

  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) {
      throw new PersistError('DECODE_FAILED', `chunk ${type} truncated`, { entry });
    }
    const data = bytes.subarray(dataStart, dataEnd);
    switch (type) {
      case 'IHDR':
        if (len < 13) throw new PersistError('DECODE_FAILED', 'IHDR too short', { entry });
        width = view.getUint32(dataStart);
        height = view.getUint32(dataStart + 4);
        bitDepth = bytes[dataStart + 8];
        colorType = bytes[dataStart + 9];
        interlace = bytes[dataStart + 12];
        break;
      case 'PLTE':
        palette = data.slice();
        break;
      case 'tRNS':
        trns = data.slice();
        break;
      case 'IDAT':
        idatParts.push(data);
        break;
      case 'IEND':
        off = bytes.length; // stop parsing
        continue;
      default:
        break; // ancillary chunks skipped
    }
    off = dataEnd + 4; // skip CRC
  }

  if (width <= 0 || height <= 0) throw new PersistError('DECODE_FAILED', 'missing or invalid IHDR', { entry });
  if (bitDepth !== 8) {
    throw new PersistError('DECODE_FAILED', `unsupported bit depth ${bitDepth} (only 8)`, { entry });
  }
  if (interlace !== 0) {
    throw new PersistError('DECODE_FAILED', 'interlaced PNG is not supported', { entry });
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : colorType === 3 ? 1 : -1;
  if (channels < 0) {
    throw new PersistError('DECODE_FAILED', `unsupported color type ${colorType}`, { entry });
  }
  if (colorType === 3 && !palette) {
    throw new PersistError('DECODE_FAILED', 'palette chunk missing for color type 3', { entry });
  }
  if (idatParts.length === 0) {
    throw new PersistError('DECODE_FAILED', 'no IDAT data', { entry });
  }

  const idatLen = idatParts.reduce((n, p) => n + p.length, 0);
  const idat = new Uint8Array(idatLen);
  let o = 0;
  for (const p of idatParts) {
    idat.set(p, o);
    o += p.length;
  }
  const raw = await inflate(idat, entry);

  const stride = width * channels;
  const expected = height * (1 + stride);
  if (raw.length < expected) {
    throw new PersistError('DECODE_FAILED', `pixel data truncated (${raw.length} < ${expected})`, { entry });
  }

  // Un-filter into `lines` (filter-transformed rows share one flat buffer).
  const lines = new Uint8Array(height * stride);
  const bpp = Math.max(1, channels); // bytes per pixel for filtering
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + stride)];
    const srcRow = y * (1 + stride) + 1;
    const dstRow = y * stride;
    for (let x = 0; x < stride; x++) {
      const rb = raw[srcRow + x];
      const a = x >= bpp ? lines[dstRow + x - bpp] : 0;
      const b = y > 0 ? lines[dstRow - stride + x] : 0;
      const c = y > 0 && x >= bpp ? lines[dstRow - stride + x - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = rb;
          break;
        case 1:
          v = rb + a;
          break;
        case 2:
          v = rb + b;
          break;
        case 3:
          v = rb + ((a + b) >> 1);
          break;
        case 4:
          v = rb + paeth(a, b, c);
          break;
        default:
          throw new PersistError('DECODE_FAILED', `unknown filter type ${filter}`, { entry });
      }
      lines[dstRow + x] = v & 0xff;
    }
  }

  // Convert to RGBA.
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = y * stride + x * channels;
      const di = (y * width + x) * 4;
      switch (colorType) {
        case 6:
          rgba[di] = lines[si];
          rgba[di + 1] = lines[si + 1];
          rgba[di + 2] = lines[si + 2];
          rgba[di + 3] = lines[si + 3];
          break;
        case 2:
          rgba[di] = lines[si];
          rgba[di + 1] = lines[si + 1];
          rgba[di + 2] = lines[si + 2];
          rgba[di + 3] = 255;
          break;
        case 4:
          rgba[di] = lines[si];
          rgba[di + 1] = lines[si];
          rgba[di + 2] = lines[si];
          rgba[di + 3] = lines[si + 1];
          break;
        case 0:
          rgba[di] = lines[si];
          rgba[di + 1] = lines[si];
          rgba[di + 2] = lines[si];
          rgba[di + 3] = 255;
          break;
        case 3: {
          if (!palette) throw new PersistError('DECODE_FAILED', 'palette chunk missing', { entry });
          const tr = trns;
          const idx = lines[si];
          const p = idx * 3;
          rgba[di] = palette[p];
          rgba[di + 1] = palette[p + 1];
          rgba[di + 2] = palette[p + 2];
          rgba[di + 3] = tr && idx < tr.length ? tr[idx] : 255;
          break;
        }
      }
    }
  }
  return { width, height, rgba };
}
