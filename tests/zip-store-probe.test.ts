import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { createZipBuffer, looksIncompressible, ZIP_STORE_PROBE_MIN_BYTES, type ZipDeflater } from '../src/lib/conversions/zip-writer';
import { proseText, SeededRandom, sha256Hex } from './helpers/archive-corpus';

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Entry name to method and bytes, read by a reader that is not the writer's. */
async function readBack(archive: Buffer): Promise<Map<string, { method: number; data: Buffer }>> {
  const zip = await JSZip.loadAsync(archive);
  const out = new Map<string, { method: number; data: Buffer }>();
  for (const [name, entry] of Object.entries(zip.files)) {
    const compression = (entry as unknown as { _data: { compression: { magic: string } } })._data.compression.magic;
    out.set(name, { method: compression === '\x00\x00' ? METHOD_STORE : METHOD_DEFLATE, data: await entry.async('nodebuffer') });
  }
  return out;
}

/** Raw deflate bytes of text: no magic number and no extension says it is compressed. */
function compressedPayload(length: number, seed: number): Buffer {
  return zlib.deflateRawSync(proseText(length * 3, seed)).subarray(0, length);
}

describe('looksIncompressible', () => {
  it('is true for random bytes and for raw deflate output, whatever their length above the probe floor', () => {
    expect(looksIncompressible(new SeededRandom(1).bytes(ZIP_STORE_PROBE_MIN_BYTES))).toBe(true);
    expect(looksIncompressible(new SeededRandom(2).bytes(3 * MEBIBYTE + 17))).toBe(true);
    expect(looksIncompressible(compressedPayload(2 * MEBIBYTE, 3))).toBe(true);
  });

  it('is false for text, zeros and a repeating pattern longer than the probe window', () => {
    expect(looksIncompressible(proseText(2 * MEBIBYTE, 4))).toBe(false);
    expect(looksIncompressible(Buffer.alloc(2 * MEBIBYTE))).toBe(false);
    const block = new SeededRandom(5).bytes(20 * KIBIBYTE);
    expect(looksIncompressible(Buffer.concat(Array.from({ length: 40 }, () => block)))).toBe(false);
  });

  it('is false below the floor, where a deflate attempt is cheap, even for random bytes', () => {
    expect(looksIncompressible(new SeededRandom(6).bytes(ZIP_STORE_PROBE_MIN_BYTES - 1))).toBe(false);
  });

  it('sees a compressible stretch of a quarter of a large entry wherever it lies, not only at its ends', () => {
    const noise = new SeededRandom(7);
    for (const stretchAt of [0, 9, 18]) {
      const parts = Array.from({ length: 24 }, (_, index) => (index >= stretchAt && index < stretchAt + 6 ? Buffer.alloc(MEBIBYTE) : noise.bytes(MEBIBYTE)));
      expect(looksIncompressible(Buffer.concat(parts))).toBe(false);
    }
  });

  it('is the same answer on every call for the same bytes', () => {
    const data = Buffer.concat([new SeededRandom(8).bytes(MEBIBYTE), proseText(MEBIBYTE, 9)]);
    const answers = new Set(Array.from({ length: 5 }, () => looksIncompressible(data)));
    expect(answers.size).toBe(1);
  });
});

describe('ZIP entries of unknown kind', () => {
  it('stores an entry that probes as incompressible without deflating it, and returns its bytes', async () => {
    const blob = compressedPayload(2 * MEBIBYTE, 10);
    const deflated: number[] = [];
    const deflate: ZipDeflater = async (data, level) => {
      deflated.push(data.length);
      return zlib.deflateRawSync(data, { level });
    };
    const archive = await createZipBuffer([{ name: 'upload.dat', data: blob }], { deflate });
    expect(deflated).toEqual([]);
    const entry = (await readBack(archive)).get('upload.dat')!;
    expect(entry.method).toBe(METHOD_STORE);
    expect(sha256Hex(entry.data)).toBe(sha256Hex(blob));
  });

  it('still deflates text of the same length', async () => {
    const text = proseText(2 * MEBIBYTE, 11);
    const archive = await createZipBuffer([{ name: 'notes.log', data: text }]);
    const entry = (await readBack(archive)).get('notes.log')!;
    expect(entry.method).toBe(METHOD_DEFLATE);
    expect(archive.length).toBeLessThan(text.length * 0.8);
    expect(sha256Hex(entry.data)).toBe(sha256Hex(text));
  });

  it('deflates an explicit method=deflate request even when the bytes look incompressible', async () => {
    const noise = new SeededRandom(12).bytes(ZIP_STORE_PROBE_MIN_BYTES * 2);
    const deflated: number[] = [];
    await createZipBuffer([{ name: 'noise.dat', data: noise, method: 'deflate' }], {
      deflate: async (data, level) => {
        deflated.push(data.length);
        return zlib.deflateRawSync(data, { level });
      },
    });
    expect(deflated).toEqual([noise.length]);
  });

  it('keeps small random entries on the old path: deflated first, then stored because it did not shrink', async () => {
    const noise = new SeededRandom(13).bytes(8 * KIBIBYTE);
    const deflated: number[] = [];
    const archive = await createZipBuffer([{ name: 'tiny.dat', data: noise }], {
      deflate: async (data, level) => {
        deflated.push(data.length);
        return zlib.deflateRawSync(data, { level });
      },
    });
    expect(deflated).toEqual([noise.length]);
    expect((await readBack(archive)).get('tiny.dat')!.method).toBe(METHOD_STORE);
  });
});
