import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { BmpDecodeError, decodeBmp } from '../src/lib/conversions/bmp';
import { IcnsDecodeError, IcoDecodeError, decodeIco, decodeIcns } from '../src/lib/conversions/ico';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { ConversionFailedError } from '../src/lib/types';
import { craftBmp, craftIco, dibOfBmp, packIndexed, storedRowBytes } from './helpers/bmp-craft';
import { decodeRgba, runConvert, runIdentify, SKIP_WITHOUT_MAGICK, withTempImage } from './helpers/imagemagick';

/**
 * BMP and ICO decoding. The expected pixels are what ImageMagick decodes from the same bytes (8-bit RGBA); the
 * palette, RLE, bit-field, top-down and icon files are either written by ImageMagick or hand-assembled by
 * tests/helpers/bmp-craft.ts from the Microsoft layout, never by the code under test.
 */

const WIDTH = 13;
const HEIGHT = 9;
const BYTE_MAX = 255;
const NOISE_MULTIPLIER = 2654435761;
const REJECT_BUDGET_MS = 10;
const REJECT_TRIES = 9;
const MIB = 1024 * 1024;
/** Two lcms builds may round a colour transform one level apart. */
const PROFILE_CONVERSION_TOLERANCE = 2;

function noise(index: number): number {
  return (Math.imul(index + 1, NOISE_MULTIPLIER) >>> 11) & BYTE_MAX;
}

/** Interleaved 8-bit samples of a deterministic textured picture. */
function pictureSamples(channels: 3 | 4, width = WIDTH, height = HEIGHT): Buffer {
  const out = Buffer.alloc(width * height * channels);
  for (let i = 0; i < out.length; i += 1) out[i] = noise(i);
  return out;
}

/** Encodes the textured picture with ImageMagick; coders such as BMP4 and ICO need a seekable file, not a pipe. */
function magickWrite(spec: string[], channels: 3 | 4 = 3, samples = pictureSamples(channels), size = `${WIDTH}x${HEIGHT}`): Buffer {
  const layout = channels === 3 ? 'rgb' : 'rgba';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bmp-fixture-'));
  try {
    const target = path.join(dir, 'out');
    const format = spec[spec.length - 1];
    runConvert(['-size', size, '-depth', '8', `${layout}:-`, ...spec.slice(0, -1), `${format.split(':')[0]}:${target}`], samples);
    return readFileSync(target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectSameAsMagick(bmp: Buffer): { width: number; height: number } {
  const expected = decodeRgba(bmp, 'bmp');
  const actual = decodeBmp(bmp);
  expect({ width: actual.width, height: actual.height }).toEqual({ width: expected.width, height: expected.height });
  expect(Buffer.compare(actual.raw, expected.data)).toBe(0);
  return { width: actual.width, height: actual.height };
}

describe.skipIf(SKIP_WITHOUT_MAGICK)('BMP variants decode bit-exactly against ImageMagick', () => {
  it.each([
    ['OS/2 core header, 24 bit', ['-type', 'TrueColor', 'BMP2:-']],
    ['Windows info header, 24 bit', ['-type', 'TrueColor', 'BMP3:-']],
    ['1-bit palette', ['-colors', '2', '-type', 'palette', 'BMP3:-']],
    ['4-bit palette', ['-colors', '16', '-type', 'palette', 'BMP3:-']],
    ['8-bit palette', ['-colors', '200', '-type', 'palette', 'BMP3:-']],
    ['8-bit palette, RLE8', ['-colors', '200', '-type', 'palette', '-compress', 'RLE', 'BMP3:-']],
    ['RGB555', ['-type', 'TrueColor', '-define', 'bmp:subtype=RGB555', 'BMP:-']],
    ['RGB565', ['-type', 'TrueColor', '-define', 'bmp:subtype=RGB565', 'BMP:-']],
    ['32-bit bit-fields with alpha (V5 header)', ['-type', 'TrueColorAlpha', 'BMP:-']],
  ] as const)('%s', (_name, spec) => {
    const bmp = magickWrite([...spec], spec.includes('TrueColorAlpha') ? 4 : 3);
    expectSameAsMagick(bmp);
  });

  it('keeps the alpha of a 32-bit bit-field bitmap', () => {
    const bmp = magickWrite(['-type', 'TrueColorAlpha', 'BMP:-'], 4);
    const decoded = decodeBmp(bmp);
    expect(decoded.hasAlpha).toBe(true);
    const alphas = new Set<number>();
    for (let i = 3; i < decoded.raw.length; i += 4) alphas.add(decoded.raw[i]);
    expect(alphas.size).toBeGreaterThan(1);
  });

  it('widens every 5- and 6-bit sample the way ImageMagick does', () => {
    const values = Array.from({ length: 64 }, (_, g) => g);
    const row = Buffer.alloc(storedRowBytes(values.length, 16));
    values.forEach((g, i) => row.writeUInt16LE((g << 5) | (g >> 1), i * 2));
    const bmp = craftBmp({
      width: values.length,
      height: 1,
      bitCount: 16,
      compression: 3,
      masks: [0xf800, 0x07e0, 0x001f, 0],
      pixels: row,
    });
    expectSameAsMagick(bmp);
  });

  it('decodes a top-down 24-bit bitmap (negative height)', () => {
    const rows = HEIGHT;
    const stride = storedRowBytes(WIDTH, 24);
    const pixels = new Uint8Array(stride * rows);
    for (let y = 0; y < rows; y += 1) for (let x = 0; x < WIDTH * 3; x += 1) pixels[y * stride + x] = noise(y * 100 + x);
    expectSameAsMagick(craftBmp({ width: WIDTH, height: -rows, bitCount: 24, pixels }));
  });

  it('honours biClrUsed for a 4-bit table of 5 colours', () => {
    const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [9, 8, 7]] as const;
    const rows = Array.from({ length: 4 }, (_, y) => Array.from({ length: 7 }, (_, x) => (x + y) % 5));
    const bmp = craftBmp({ width: 7, height: 4, bitCount: 4, palette, pixels: packIndexed(rows, 4) });
    expectSameAsMagick(bmp);
  });

  it('decodes RLE8 with encoded runs, absolute runs, odd lengths, deltas and end-of-line escapes', () => {
    const palette = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 16, (i * 37) & BYTE_MAX] as const);
    const stream = [
      5, 3, //                      row 0: 5 pixels of index 3
      0, 3, 1, 2, 3, 0, //          absolute run of 3 (odd: one pad byte)
      0, 2, 2, 0, //                delta: 2 right, same row
      2, 7,
      0, 0, //                      end of line
      0, 4, 9, 8, 7, 6, //          row 1: absolute run of 4 (even)
      4, 5,
      0, 2, 0, 1, //                delta: 0 right, 1 up (row 2)
      4, 12, //                    row 2 is only half written: its first 8 pixels keep index 0
      0, 0,
      12, 1, //                     row 3: one run across the whole width
      0, 0,
      3, 9, //                      row 4
      0, 0,
      0, 1,
    ];
    const bmp = craftBmp({ width: 12, height: 5, bitCount: 8, compression: 1, palette, pixels: Uint8Array.from(stream) });
    expectSameAsMagick(bmp);
  });

  it('decodes RLE4 with encoded runs, absolute runs and an odd-length run', () => {
    const palette = Array.from({ length: 16 }, (_, i) => [i * 16, (i * 53) & BYTE_MAX, 255 - i * 16] as const);
    const stream = [
      6, 0x12, //                   row 0: 6 pixels alternating nibbles 1,2
      0, 5, 0xab, 0xcd, 0xe0, 0, // absolute run of 5 nibbles (3 data bytes + pad)
      0, 0,
      0, 4, 0x34, 0x56, //          row 1: absolute run of 4 nibbles
      7, 0x9f, //                   odd run of 7 pixels
      0, 0,
      9, 0x55, //                   row 2: 9 pixels
      0, 0,
      0, 0, //                      row 3 is never written
      0, 1,
    ];
    const bmp = craftBmp({ width: 11, height: 4, bitCount: 4, compression: 2, palette, pixels: Uint8Array.from(stream) });
    expectSameAsMagick(bmp);
  });

  it('reads the ICC profile of a V5 header, and the converter colour-manages the pixels with it', async () => {
    const profileOf = async (name: 'p3' | 'srgb'): Promise<Buffer> => {
      const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).withIccProfile(name).png().toBuffer();
      return (await sharp(png).metadata()).icc as Buffer;
    };
    const p3 = await profileOf('p3');
    const srgb = await profileOf('srgb');
    const colours = [[250, 20, 20], [20, 200, 40], [30, 60, 240], [128, 128, 128]];
    const stride = storedRowBytes(colours.length, 24);
    const pixels = new Uint8Array(stride);
    colours.forEach(([r, g, b], x) => pixels.set([b, g, r], x * 3));
    const bmp = craftBmp({ header: 124, width: colours.length, height: 1, bitCount: 24, pixels, icc: p3 });

    expectSameAsMagick(bmp);
    expect(Buffer.compare(decodeBmp(bmp).icc as Buffer, p3)).toBe(0);

    // ImageMagick assigns the Display P3 profile to the same samples and converts them to sRGB with lcms.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bmp-icc-'));
    try {
      writeFileSync(path.join(dir, 'p3.icc'), p3);
      writeFileSync(path.join(dir, 'srgb.icc'), srgb);
      const expected = runConvert(
        ['-size', `${colours.length}x1`, '-depth', '8', 'rgb:-', '-profile', path.join(dir, 'p3.icc'), '-profile', path.join(dir, 'srgb.icc'), '-depth', '8', 'rgb:-'],
        Buffer.from(colours.flat())
      );
      const converted = await convertImage(bmp, 'png', {}, 'tagged.bmp', 'bmp');
      const { data } = await sharp(converted.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(data.length).toBe(expected.length);
      const worst = Math.max(...Array.from(data, (v, i) => Math.abs(v - expected[i])));
      expect(worst).toBeLessThanOrEqual(PROFILE_CONVERSION_TOLERANCE);
      // The profile matters: without it the same samples would stay where they are.
      expect(Math.max(...Array.from(data, (v, i) => Math.abs(v - colours.flat()[i])))).toBeGreaterThan(PROFILE_CONVERSION_TOLERANCE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('converts a palette BMP to the PNG ImageMagick would decode', async () => {
    const bmp = magickWrite(['-colors', '16', '-type', 'palette', 'BMP3:-']);
    const expected = decodeRgba(bmp, 'bmp');
    const converted = await convertImage(bmp, 'png', {}, 'palette.bmp', 'bmp');
    const { data } = await sharp(converted.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(Buffer.compare(data, expected.data)).toBe(0);
  });
});

describe('BMP validation rejects bad files with a typed error before allocating', () => {
  const stride24 = storedRowBytes(WIDTH, 24);
  const goodPixels = new Uint8Array(stride24 * HEIGHT).fill(7);
  const good = craftBmp({ width: WIDTH, height: HEIGHT, bitCount: 24, pixels: goodPixels });

  function bestRejectMs(bytes: Buffer): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < REJECT_TRIES; i += 1) {
      const start = performance.now();
      try {
        decodeBmp(bytes);
      } catch {
        // timing the rejection only
      }
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  const palette256 = Array.from({ length: 256 }, (_, i) => [i, i, i] as const);
  const cases: Array<[string, () => Buffer, RegExp]> = [
    ['a file cut short in its pixel data', () => good.subarray(0, good.length - 5), /pixel data/],
    ['a header size larger than the file', () => craftBmp({ width: 4, height: 4, bitCount: 24, pixels: new Uint8Array(64), overrideHeaderSize: 0x10000000 }), /header size/],
    ['an unknown header size', () => craftBmp({ width: 4, height: 4, bitCount: 24, pixels: new Uint8Array(64), overrideHeaderSize: 41 }), /header size/],
    [
      'a colour table that runs past the end of the file',
      () => craftBmp({ width: 4, height: 4, bitCount: 8, palette: palette256, pixels: new Uint8Array(16) }).subarray(0, 14 + 40 + 100),
      /colour table/,
    ],
    ['a biSizeImage larger than the data', () => craftBmp({ width: WIDTH, height: HEIGHT, bitCount: 24, pixels: goodPixels, sizeImage: 0x7fffffff }), /declares/],
    ['a pixel data offset past the end of the file', () => craftBmp({ width: 2, height: 2, bitCount: 24, pixels: new Uint8Array(16), overridePixelOffset: 4096 }), /pixel data offset/],
    ['a bit depth no BMP has', () => craftBmp({ width: 2, height: 2, bitCount: 12, pixels: new Uint8Array(16) }), /bits per pixel/],
    ['an unknown compression', () => craftBmp({ width: 2, height: 2, bitCount: 24, compression: 9, pixels: new Uint8Array(16) }), /compression/],
    ['a colour table larger than the depth can index', () => craftBmp({ width: 2, height: 2, bitCount: 4, palette: palette256, clrUsed: 200, pixels: new Uint8Array(8) }), /colour table/],
    ['a top-down RLE bitmap', () => craftBmp({ width: 2, height: -2, bitCount: 8, compression: 1, palette: palette256, pixels: Uint8Array.from([2, 1, 0, 1]) }), /top-down/],
    ['a 10000x10000 canvas declared by a 4-byte RLE stream', () => craftBmp({ width: 10000, height: 10000, bitCount: 8, compression: 1, palette: palette256, pixels: Uint8Array.from([0, 1]) }), /cannot describe/],
    ['a bit-field bitmap with an empty mask', () => craftBmp({ width: 2, height: 2, bitCount: 16, compression: 3, masks: [0, 0x7e0, 0x1f, 0], pixels: new Uint8Array(8) }), /mask/],
    ['an RLE run that leaves the bitmap', () => craftBmp({ width: 4, height: 1, bitCount: 8, compression: 1, palette: palette256, pixels: Uint8Array.from([200, 1, 0, 1]) }), /leaves the bitmap/],
    ['a pixel that indexes past a 2-entry table', () => craftBmp({ width: 4, height: 1, bitCount: 8, palette: palette256.slice(0, 2), pixels: Uint8Array.from([0, 1, 2, 0]) }), /colour index/],
  ];

  it.each(cases)('%s answers BmpDecodeError (400) quickly, allocating nothing like the declared canvas', (_name, make, message) => {
    const bytes = make();
    const before = process.memoryUsage().arrayBuffers;
    let error: unknown;
    try {
      decodeBmp(bytes);
    } catch (caught) {
      error = caught;
    }
    const grown = process.memoryUsage().arrayBuffers - before;
    expect(error).toBeInstanceOf(BmpDecodeError);
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as Error).message).toMatch(message);
    expect(grown).toBeLessThan(bytes.length + MIB);
    expect(bestRejectMs(bytes)).toBeLessThan(REJECT_BUDGET_MS);
  });

  it('answers the pixel limit (413) for a canvas over the input limit, not a 400', () => {
    const huge = craftBmp({ width: 20000, height: 20000, bitCount: 24, pixels: new Uint8Array(16) });
    expect(() => decodeBmp(huge)).toThrow(InputPixelLimitError);
  });

  it('refuses a file that is not a BMP', () => {
    expect(() => decodeBmp(Buffer.from('not a bitmap at all, just text'))).toThrow(BmpDecodeError);
  });
});

describe.skipIf(SKIP_WITHOUT_MAGICK)('ICO and CUR files', () => {
  function pngOf(side: number): Promise<Buffer> {
    return sharp({ create: { width: side, height: side, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 1 } } }).png().toBuffer();
  }

  it('decodes a 32-bit DIB entry with an AND mask, alpha from the mask for a palette entry', () => {
    // 4-bit palette icon 6x6: pixels index 1, mask makes the left half transparent.
    const side = 6;
    const palette = [[0, 0, 0], [200, 40, 90]] as const;
    const rows = Array.from({ length: side }, () => Array.from({ length: side }, () => 1));
    const colour = craftBmp({ width: side, height: side, bitCount: 4, palette, pixels: packIndexed(rows, 4) });
    const maskRows = Array.from({ length: side }, () => Array.from({ length: side }, (_, x) => (x < side / 2 ? 1 : 0)));
    const mask = packIndexed(maskRows, 1);
    const ico = craftIco([{ width: side, height: side, bitCount: 4, data: dibOfBmp(colour, true, mask) }]);
    const expected = decodeRgba(ico, 'ico');
    const decoded = decodeIco(ico);
    expect(decoded.kind).toBe('raster');
    if (decoded.kind !== 'raster') return;
    expect(decoded.bitmap.hasAlpha).toBe(true);
    expect(Buffer.compare(decoded.bitmap.raw, expected.data)).toBe(0);
    expect(decoded.bitmap.raw[3]).toBe(0);
    expect(decoded.bitmap.raw[(side - 1) * 4 + 3]).toBe(BYTE_MAX);
  });

  it('decodes a 32-bit DIB entry using its own alpha channel', () => {
    const side = 5;
    const stride = side * 4;
    const pixels = new Uint8Array(stride * side);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = i % 4 === 3 ? 60 + (i % 7) * 20 : noise(i);
    const colour = craftBmp({ width: side, height: side, bitCount: 32, pixels });
    const mask = new Uint8Array(storedRowBytes(side, 1) * side);
    const ico = craftIco([{ width: side, height: side, bitCount: 32, data: dibOfBmp(colour, true, mask) }]);
    const expected = decodeRgba(ico, 'ico');
    const decoded = decodeIco(ico);
    if (decoded.kind !== 'raster') throw new Error('expected a DIB entry');
    expect(Buffer.compare(decoded.bitmap.raw, expected.data)).toBe(0);
  });

  it('reads an icon ImageMagick wrote with two sizes and picks the larger by default', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ico-fixture-'));
    try {
      const small = path.join(dir, 'small.png');
      const large = path.join(dir, 'large.png');
      const target = path.join(dir, 'two.ico');
      writeFileSync(small, await pngOf(16));
      writeFileSync(large, await pngOf(48));
      runConvert([small, large, `ico:${target}`]);
      const ico = readFileSync(target);
      const decoded = decodeIco(ico);
      const sizes = runIdentify(['-format', '%w,', target]).trim().split(',').filter(Boolean).map(Number);
      expect(sizes.sort((a, b) => a - b)).toEqual([16, 48]);
      const width = decoded.kind === 'png' ? (await sharp(decoded.png).metadata()).width : decoded.bitmap.width;
      expect(width).toBe(48);
      if (decoded.kind === 'raster') {
        const index = runIdentify(['-format', '%w,', target]).trim().split(',').filter(Boolean).map(Number).indexOf(48);
        expect(Buffer.compare(decoded.bitmap.raw, decodeRgba(ico, 'ico', index).data)).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('chooses the smallest entry that covers a requested size, else the largest', async () => {
    const entries = [16, 32, 64].map((side) => ({ side, png: pngOf(side) }));
    const images = await Promise.all(entries.map(async (e) => ({ width: e.side, height: e.side, bitCount: 32, data: await e.png })));
    const ico = craftIco(images);
    const width = async (request?: { width?: number; height?: number }): Promise<number | undefined> => {
      const chosen = decodeIco(ico, request);
      return chosen.kind === 'png' ? (await sharp(chosen.png).metadata()).width : chosen.bitmap.width;
    };
    expect(await width()).toBe(64);
    expect(await width({ width: 20, height: 20 })).toBe(32);
    expect(await width({ width: 16 })).toBe(16);
    expect(await width({ width: 500, height: 500 })).toBe(64);
  });

  it('converts an ICO with a DIB entry to PNG with the alpha ImageMagick reads', async () => {
    const side = 8;
    const stride = side * 4;
    const pixels = new Uint8Array(stride * side);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = i % 4 === 3 ? 90 + (i % 5) * 30 : noise(i + 99);
    const colour = craftBmp({ width: side, height: side, bitCount: 32, pixels });
    const ico = craftIco([{ width: side, height: side, bitCount: 32, data: dibOfBmp(colour, true, new Uint8Array(storedRowBytes(side, 1) * side)) }]);
    const expected = decodeRgba(ico, 'ico');
    const converted = await convertImage(ico, 'png', {}, 'icon.ico', 'ico');
    const { data } = await sharp(converted.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(Buffer.compare(data, expected.data)).toBe(0);
  });
});

describe('ICO and ICNS validation', () => {
  it('rejects a directory whose entry points outside the file', () => {
    const ico = craftIco([{ width: 4, height: 4, bitCount: 32, data: new Uint8Array(40) }]);
    ico.writeUInt32LE(5000, 6 + 12);
    expect(() => decodeIco(ico)).toThrow(IcoDecodeError);
  });

  it('rejects a directory that declares more entries than fit', () => {
    const ico = craftIco([{ width: 4, height: 4, bitCount: 32, data: new Uint8Array(40) }]);
    ico.writeUInt16LE(5000, 4);
    expect(() => decodeIco(ico)).toThrow(/do not fit/);
  });

  it('rejects an entry that is neither PNG nor a DIB with IcoDecodeError', () => {
    const ico = craftIco([{ width: 4, height: 4, bitCount: 32, data: Uint8Array.from({ length: 64 }, (_, i) => i) }]);
    expect(() => decodeIco(ico)).toThrow(IcoDecodeError);
  });

  it('answers a typed 400 through the converter, not a 500', async () => {
    const ico = craftIco([{ width: 4, height: 4, bitCount: 32, data: Uint8Array.from({ length: 64 }, (_, i) => i) }]);
    const run = convertImage(ico, 'png', {}, 'bad.ico', 'ico');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/ICO/);
  });

  function icns(chunks: Array<{ type: string; data: Buffer }>): Buffer {
    const body = Buffer.concat(chunks.map((c) => Buffer.concat([Buffer.from(c.type, 'ascii'), Buffer.from(new Uint8Array(new Uint32Array([0]).buffer)), c.data])));
    let at = 8;
    for (const c of chunks) {
      body.writeUInt32BE(8 + c.data.length, at - 8 + 4);
      at += 8 + c.data.length;
    }
    const header = Buffer.alloc(8);
    header.write('icns', 0, 'ascii');
    header.writeUInt32BE(8 + body.length, 4);
    return Buffer.concat([header, body]);
  }

  it('returns the largest PNG chunk of an ICNS file', async () => {
    const small = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#f00' } }).png().toBuffer();
    const large = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#0f0' } }).png().toBuffer();
    const file = icns([
      { type: 'is32', data: Buffer.from([1, 2, 3, 4]) },
      { type: 'icp4', data: small },
      { type: 'ic12', data: large },
    ]);
    expect(Buffer.compare(decodeIcns(file), large)).toBe(0);
  });

  it('never guesses: no PNG or JPEG chunk, a chunk past the end, or a short file is an IcnsDecodeError', () => {
    expect(() => decodeIcns(icns([{ type: 'is32', data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) }]))).toThrow(IcnsDecodeError);
    const lying = icns([{ type: 'ic08', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]) }]);
    lying.writeUInt32BE(5000, 12);
    expect(() => decodeIcns(lying)).toThrow(/past the end/);
    const short = icns([{ type: 'ic08', data: Buffer.alloc(16) }]);
    expect(() => decodeIcns(short.subarray(0, 12))).toThrow(IcnsDecodeError);
  });
});

afterEach(() => {
  delete process.env.EASYCONVERT_MAX_INPUT_PIXELS;
});
