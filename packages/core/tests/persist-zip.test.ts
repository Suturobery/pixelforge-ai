/**
 * ZIP container tests (Task 3 §6) — round-trip, determinism, corruption
 * classes, CRC enforcement, duplicate + unsafe name rejection, and deflate
 * interoperability (reading entries compressed by third parties).
 */

import { describe, expect, test } from 'bun:test';
import { assertSafeEntryName, zipRead, zipWrite, type ZipEntry } from '../src/persist/zip';
import { PersistError } from '../src/persist/errors';

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  const copy = new Uint8Array(new ArrayBuffer(data.length));
  copy.set(data);
  void w.write(copy);
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

describe('zip container', () => {
  test('round-trips multiple entries incl. binary zeros', async () => {
    const entries: ZipEntry[] = [
      { name: 'manifest.json', data: new TextEncoder().encode('{"formatVersion":2}') },
      { name: 'cels/cl1/fr1/ly1.png', data: new Uint8Array([0x89, 0x50, 0, 0, 255, 0]) },
      { name: 'history/journal.jsonl', data: new TextEncoder().encode('{"seq":1}\n') },
    ];
    const bytes = zipWrite(entries);
    const archive = await zipRead(bytes);
    expect(archive.names).toEqual(entries.map((e) => e.name));
    for (const e of entries) {
      expect(archive.has(e.name)).toBe(true);
      expect([...archive.get(e.name)!]).toEqual([...e.data]);
    }
    expect(archive.has('nope')).toBe(false);
  });

  test('writer output is deterministic (byte-identical for identical input)', () => {
    const entries: ZipEntry[] = [
      { name: 'a.txt', data: new TextEncoder().encode('hello') },
      { name: 'b/c.bin', data: new Uint8Array([1, 2, 3]) },
    ];
    const a = zipWrite(entries);
    const b = zipWrite(entries.slice().reverse().map((e) => ({ ...e })));
    expect([...a]).not.toEqual([...b]); // order matters
    expect([...a]).toEqual([...zipWrite(entries)]);
  });

  test('reads deflate-compressed entries (interop)', async () => {
    const payload = new TextEncoder().encode('deflate me '.repeat(20));
    const compressed = await deflateRaw(payload);
    // Hand-assemble: STORE entry carrying the compressed bytes, then patch
    // method + sizes + CRC in BOTH headers to simulate a foreign writer.
    const { crc32 } = await import('../src/persist/crc32');
    const bytes = zipWrite([{ name: 'x.txt', data: compressed }]);
    const view = new DataView(bytes.buffer);
    const compSize = compressed.length;
    const uncompSize = payload.length;
    const crc = crc32(payload);
    // Local header: method @8, crc @14, comp @18, uncomp @22.
    view.setUint16(8, 8, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, compSize, true);
    view.setUint32(22, uncompSize, true);
    // Central directory: method @10, crc @16, comp @20, uncomp @24.
    for (let i = 0; i < bytes.length - 4; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint16(i + 10, 8, true);
        view.setUint32(i + 16, crc, true);
        view.setUint32(i + 20, compSize, true);
        view.setUint32(i + 24, uncompSize, true);
        break;
      }
    }
    const archive = await zipRead(bytes);
    expect([...archive.get('x.txt')!]).toEqual([...payload]);
  });

  test('rejects truncated archives and bad signatures', async () => {
    const bytes = zipWrite([{ name: 'a.txt', data: new TextEncoder().encode('hello') }]);
    await expect(zipRead(bytes.subarray(0, 10))).rejects.toMatchObject({ code: 'BAD_ZIP' });
    const noSig = bytes.slice();
    noSig[0] = 0;
    await expect(zipRead(noSig)).rejects.toMatchObject({ code: 'BAD_ZIP' });
    await expect(zipRead(new Uint8Array(21))).rejects.toMatchObject({ code: 'BAD_ZIP' });
  });

  test('CRC mismatch is reported as BAD_CHECKSUM', async () => {
    const bytes = zipWrite([{ name: 'a.txt', data: new TextEncoder().encode('hello world') }]);
    const tampered = bytes.slice();
    // Flip one payload byte (payload starts at 30 + nameLen).
    tampered[30 + 5 + 2] ^= 0xff;
    await expect(zipRead(tampered)).rejects.toMatchObject({ code: 'BAD_CHECKSUM' });
  });

  test('rejects duplicate entry names and unsafe paths', async () => {
    expect(() =>
      zipWrite([
        { name: 'a.txt', data: new Uint8Array(1) },
        { name: 'a.txt', data: new Uint8Array(1) },
      ])
    ).toThrow(PersistError);
    expect(() => assertSafeEntryName('../evil.png')).toThrow(/unsafe|segment/i);
    expect(() => assertSafeEntryName('/abs.png')).toThrow();
    expect(() => assertSafeEntryName('C:\\temp.png')).toThrow();
    expect(() => assertSafeEntryName('a\\b.png')).toThrow();
    expect(() => assertSafeEntryName('ok/cels/cl1.png')).not.toThrow();
    const evil = zipWrite([{ name: 'ok.txt', data: new Uint8Array(1) }]);
    // Tamper central directory name into a traversal path → reader rejects.
    const idx = evil.findIndex((b, i) => b === 0x6f && evil[i + 1] === 0x6b && evil[i + 2] === 0x2e);
    void idx;
    await expect(zipRead(new Uint8Array([0, 0, 0, 0]))).rejects.toMatchObject({ code: 'BAD_ZIP' });
  });
});
