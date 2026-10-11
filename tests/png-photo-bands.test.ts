import { afterAll, describe, expect, it } from 'vitest';
import type { CreateRaw } from 'sharp';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';
import { combineAdler32, filterBand, recompressStoredPng16 } from '../src/lib/conversions/png-photo-bands';
import { ConversionFailedError } from '../src/lib/types';
import { shutdownCpuPool } from '../src/lib/workers/cpu-pool';
import { SeededRandom } from './helpers/archive-corpus';

/**
 * The band writer of 16-bit photographs against independent decoders: libpng (through the image library) reads the
 * result back sample for sample, and an unfilter written here from the PNG specification (section 9, filter types
 * 0-4) reads the scanlines out of a zlib stream that Node's inflater has checked end to end, Adler-32 included.
 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterAll(async () => {
  await shutdownCpuPool();
});

interface PngChunk {
  type: string;
  data: Buffer;
}

function readChunks(png: Buffer): PngChunk[] {
  expect(png.subarray(0, 8).equals(SIGNATURE)).toBe(true);
  const chunks: PngChunk[] = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    expect(png.readUInt32BE(at + 8 + length), `${type} CRC`).toBe(zlib.crc32(png.subarray(at + 4, at + 8 + length)));
    chunks.push({ type, data });
    at += 12 + length;
  }
  return chunks;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reads the scanlines of a 16-bit PNG: the pixels as written, and the filter type of each row. */
function unfilter(png: Buffer, channels: number): { pixels: Buffer; filters: number[]; width: number; height: number } {
  const chunks = readChunks(png);
  const header = chunks[0].data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  expect(header[8]).toBe(16);
  const bpp = channels * 2;
  const rowBytes = width * bpp;
  // inflateSync verifies the zlib header, every deflate block and the Adler-32 of the whole stream.
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  expect(raw.length).toBe(height * (rowBytes + 1));
  const pixels = Buffer.alloc(height * rowBytes);
  const filters: number[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    filters.push(filter);
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[y * (rowBytes + 1) + 1 + i];
      const a = i >= bpp ? pixels[y * rowBytes + i - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * rowBytes + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[(y - 1) * rowBytes + i - bpp] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) predicted = paeth(a, b, c);
      else if (filter !== 0) throw new Error(`invalid filter type ${filter}`);
      pixels[y * rowBytes + i] = (x + predicted) & 0xff;
    }
  }
  return { pixels, filters, width, height };
}

/** Mulberry32: a 32-bit generator whose high bits are well mixed (the low bits of a linear congruential generator repeat with a short period, which string matching would find). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A photograph-like 16-bit picture: gradients with sensor noise (`grain` levels of it). With grain in the thousands the
 * low bytes are noise; with fewer than a thousand the picture has structure too: a sharp edge, a flat patch, a stripe.
 */
function photograph(width: number, height: number, channels: number, seed: number, grain = 4000): Uint16Array {
  const structure = grain < 1000;
  const rng = mulberry32(seed);
  const samples = new Uint16Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        let v = 3000 + (x * 30000) / width + (y * 8000) / height + c * 500 + Math.floor(rng() * grain);
        if (structure && x > width / 2 && y > height / 3 && y < height / 2) v = 60000 - c * 3000 + Math.floor(rng() * 40);
        if (structure && x < width / 8 && y > (height * 3) / 4) v = 32768;
        if (structure && x % 17 === 0) v = 100 + c;
        samples[(y * width + x) * channels + c] = Math.max(0, Math.min(65535, Math.round(v)));
      }
    }
  }
  return samples;
}

const COLOUR_TYPE: Record<number, number> = { 1: 0, 2: 4, 3: 2, 4: 6 };

function chunkOf(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** The samples as the bytes of the scanlines of a PNG: big-endian, a zero filter byte in front of every row. */
function scanlinesOf(samples: Uint16Array, width: number, height: number, channels: number): Buffer {
  const rowSamples = width * channels;
  const out = Buffer.alloc(height * (rowSamples * 2 + 1));
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < rowSamples; i++) out.writeUInt16BE(samples[y * rowSamples + i], y * (rowSamples * 2 + 1) + 1 + i * 2);
  }
  return out;
}

/**
 * The picture as the image library writes it at compression level 0, built here from the specification: stored deflate
 * blocks of at most 65535 bytes in several IDAT chunks, after a colour profile and a resolution chunk.
 */
function storedPng(samples: Uint16Array, width: number, height: number, channels: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 16;
  header[9] = COLOUR_TYPE[channels];
  const resolution = Buffer.alloc(9);
  resolution.writeUInt32BE(11811, 0);
  resolution.writeUInt32BE(11811, 4);
  resolution[8] = 1;
  const profile = Buffer.concat([Buffer.from('test profile\0\0', 'latin1'), zlib.deflateSync(Buffer.from('profile-bytes-'.repeat(30)))]);
  const stream = zlib.deflateSync(scanlinesOf(samples, width, height, channels), { level: 0 });
  const idat: Buffer[] = [];
  for (let at = 0; at < stream.length; at += 8192) idat.push(chunkOf('IDAT', stream.subarray(at, at + 8192)));
  return Buffer.concat([SIGNATURE, chunkOf('IHDR', header), chunkOf('iCCP', profile), chunkOf('pHYs', resolution), ...idat, chunkOf('IEND', Buffer.alloc(0))]);
}

function bigEndian(samples: Uint16Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) out.writeUInt16BE(samples[i], i * 2);
  return out;
}

async function decoded(png: Buffer): Promise<Buffer> {
  return sharp(png).raw({ depth: 'ushort' }).toBuffer();
}

async function rewritten(stored: Buffer): Promise<Buffer> {
  const png = await recompressStoredPng16(stored);
  if (png === null) throw new Error('the picture was handed back to the general encoder');
  return png;
}

/** The chunk types of a PNG with a run of IDAT chunks counted as one. */
function chunkTypes(png: Buffer): string[] {
  return readChunks(png)
    .map((chunk) => chunk.type)
    .filter((type, index, all) => type !== 'IDAT' || all[index - 1] !== 'IDAT');
}

describe('recompressStoredPng16', () => {
  const cases: Array<[string, number, number, number]> = [
    ['grey', 1, 301, 190],
    ['RGB', 3, 301, 190],
    ['RGBA', 4, 129, 263],
    ['a single column', 3, 1, 400],
    ['a narrow picture', 3, 7, 300],
  ];

  for (const [name, channels, width, height] of cases) {
    it(`writes ${name} pixels exactly, as one zlib stream across bands`, async () => {
      const samples = photograph(width, height, channels, 5 + channels);
      const stored = storedPng(samples, width, height, channels);
      const png = await rewritten(stored);
      const read = unfilter(png, channels);
      expect(read.width).toBe(width);
      expect(read.height).toBe(height);
      // The scanlines unfilter to the samples the picture was built from, byte for byte.
      expect(read.pixels.equals(bigEndian(samples))).toBe(true);
      // libpng reads the rewritten picture to the samples of the picture it was handed.
      expect((await decoded(png)).equals(await decoded(stored))).toBe(true);
      const types = chunkTypes(png);
      expect(types[0]).toBe('IHDR');
      expect(types[types.length - 1]).toBe('IEND');
      expect(types).toEqual(chunkTypes(stored));
    });
  }

  it('chooses among the filter types by the sum of absolute differences and writes the noise as small as libpng does', async () => {
    const width = 640;
    const height = 480;
    const stored = storedPng(photograph(width, height, 3, 11), width, height, 3);
    const png = await rewritten(stored);
    expect(new Set(unfilter(png, 3).filters).size).toBeGreaterThanOrEqual(3);
    const libpng = await sharp(stored).toColourspace('rgb16').png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
    expect(png.length).toBeLessThan(libpng.length * 1.03);
    expect(png.length).toBeLessThan(stored.length * 0.9);
  });

  it('hands a picture with structure back, because string matching writes it smaller', async () => {
    const width = 200;
    const height = 300;
    const rng = mulberry32(5);
    const tile = Uint16Array.from({ length: 13 * 5 * 3 }, () => Math.floor(rng() * 65536));
    const samples = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) samples[(y * width + x) * 3 + c] = tile[((y % 5) * 13 + (x % 13)) * 3 + c];
    }
    expect(await recompressStoredPng16(storedPng(samples, width, height, 3))).toBeNull();
  });

  it('keeps the colour profile and the other chunks of the picture in their place', async () => {
    const stored = storedPng(photograph(200, 120, 3, 3), 200, 120, 3);
    const before = readChunks(stored);
    const after = readChunks(await rewritten(stored));
    for (const type of ['IHDR', 'iCCP', 'sRGB', 'gAMA', 'cHRM', 'pHYs']) {
      expect(after.filter((chunk) => chunk.type === type).map((chunk) => chunk.data.toString('hex'))).toEqual(
        before.filter((chunk) => chunk.type === type).map((chunk) => chunk.data.toString('hex'))
      );
    }
    expect(after.some((chunk) => chunk.type === 'iCCP' || chunk.type === 'sRGB')).toBe(true);
  });

  it('refuses a picture that is not 16-bit, not stored or not a picture, with the reason', async () => {
    const failure = async (png: Buffer): Promise<string> => {
      const error = await recompressStoredPng16(png).then(() => new Error('accepted'), (rejected: unknown) => rejected);
      expect(error).toBeInstanceOf(ConversionFailedError);
      return (error as Error).message;
    };
    const eightBit = await sharp(Buffer.alloc(30 * 20 * 3, 7), { raw: { width: 30, height: 20, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(await failure(eightBit)).toBe('16-bit PNG: only a non-interlaced greyscale, grey-alpha, RGB or RGBA picture of 16 bits per sample is rewritten');
    const compressed = await sharp(Buffer.from(photograph(30, 20, 3, 1).buffer), { raw: { width: 30, height: 20, channels: 3, depth: 'ushort' } as CreateRaw })
      .toColourspace('rgb16')
      .png({ compressionLevel: 6 })
      .toBuffer();
    expect(await failure(compressed)).toBe('16-bit PNG: the pixel stream is not stored');
    expect(await failure(Buffer.concat([SIGNATURE, Buffer.from([0, 0, 0, 40, 73, 72, 68, 82])]))).toBe('16-bit PNG: the picture ends inside a chunk');
  });
});

describe('combineAdler32', () => {
  it('equals the Adler-32 of the joined runs, for lengths around the modulus', () => {
    const rng = new SeededRandom(99);
    const adler = (bytes: Uint8Array, start = 1): number => {
      let a = start & 0xffff;
      let b = start >>> 16;
      for (const byte of bytes) {
        a = (a + byte) % 65521;
        b = (b + a) % 65521;
      }
      return ((b << 16) | a) >>> 0;
    };
    for (const [first, second] of [[1, 1], [100, 65521], [65521, 3], [70000, 140000], [5552, 5553]]) {
      const one = Uint8Array.from({ length: first }, () => rng.below(256));
      const two = Uint8Array.from({ length: second }, () => rng.below(256));
      const joined = new Uint8Array(first + second);
      joined.set(one);
      joined.set(two, first);
      expect(combineAdler32(adler(one), adler(two), second), `${first}+${second}`).toBe(adler(joined));
    }
  });
});

describe('filterBand', () => {
  it('writes a filter type per row that the specification unfilter reverses, in any band of the picture', () => {
    const width = 70;
    const height = 33;
    const bytesPerPixel = 6;
    const rowBytes = width * bytesPerPixel;
    const samples = photograph(width, height, 3, 21);
    const scanlines = new Uint8Array(height * (rowBytes + 1));
    for (let y = 0; y < height; y++) {
      for (let i = 0; i < width * 3; i++) {
        const sample = samples[y * width * 3 + i];
        scanlines[y * (rowBytes + 1) + 1 + i * 2] = sample >> 8;
        scanlines[y * (rowBytes + 1) + 2 + i * 2] = sample & 0xff;
      }
    }
    const layout = { rowBytes, bytesPerPixel, height };
    const whole = filterBand(layout, scanlines, 0, height);
    const lower = filterBand(layout, scanlines, 10, 25);
    // A band reads the row above its first row from the whole picture, so it filters like the same rows of the whole.
    expect(Buffer.from(lower).equals(Buffer.from(whole.subarray(10 * (rowBytes + 1), 25 * (rowBytes + 1))))).toBe(true);
  });
});

describe('a noisy 16-bit photograph converted to PNG', () => {
  it('keeps every sample and is no larger than the general encoder writes it', async () => {
    const width = 400;
    const height = 300;
    const samples = photograph(width, height, 3, 77);
    const source = storedPng(samples, width, height, 3);
    const result = await convertFile(source, 'png', 'png', {}, 'photo.png');
    const read = unfilter(result.buffer, 3);
    expect(read.pixels.equals(bigEndian(samples))).toBe(true);
    expect(new Set(read.filters).size).toBeGreaterThanOrEqual(2);
    const general = await sharp(source).toColourspace('rgb16').png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
    expect(result.buffer.length).toBeLessThan(general.length * 1.03);
    expect(readChunks(result.buffer).filter((chunk) => chunk.type === 'IDAT').length).toBeGreaterThan(1);
  }, 60_000);
});
