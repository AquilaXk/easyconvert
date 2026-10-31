import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { minimumScanBytes, truncatedJpegDecodeOptions, walkJpegStream } from '../src/lib/conversions/image-jpeg-stream';
import { ConversionFailedError } from '../src/lib/types';
import { decodeRgba, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * A JPEG that ends inside its scan data converts to the part that was decoded, with the rest filled, the way the reference
 * service's decoder (libjpeg under ImageMagick) reads it: "Premature end of JPEG file" is a warning there. A stream that ends before
 * its first scan holds no pixels and is refused with the typed decode error. Oracle: ImageMagick's own decode of the complete file.
 */

const FULL = readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg'));
const RGBA_CHANNELS = 4;
const SOS_MARKER = 0xda;
const EXACT_TOP_FRACTION = 0.3;
const FRAME_BLOCKS = 18432;
const FORGED_SIDE = 8000;
const STRAY_MARKER_AT = 50000;
const CORRUPT_RUN_MAX = 16;

function startOfScan(jpeg: Buffer): number {
  for (let at = 2; at + 1 < jpeg.length; at += 1) if (jpeg[at] === 0xff && jpeg[at + 1] === SOS_MARKER) return at;
  throw new Error('the fixture has no scan');
}

async function decodePng(png: Buffer): Promise<{ width: number; height: number; data: Buffer }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function rows(image: { width: number; data: Buffer }, count: number): Buffer {
  return image.data.subarray(0, count * image.width * RGBA_CHANNELS);
}

const fail = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (error: unknown) => error);

describe.skipIf(SKIP_WITHOUT_MAGICK)('a JPEG cut inside its scan data', () => {
  const cut = FULL.subarray(0, Math.floor(FULL.length / 2));

  it.each(['png', 'jpg', 'webp', 'tiff', 'pdf'])('converts to %s with the source dimensions', async (target) => {
    const result = await convertImage(cut, target, {}, 'cut.jpg', 'jpg');
    expect(result.size).toBeGreaterThan(0);
    if (target === 'pdf') expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    else expect(await sharp(result.buffer).metadata()).toMatchObject({ width: 768, height: 512 });
  });

  it('keeps the rows that were decoded: the top of the picture equals the decode of the complete file', async () => {
    const reference = decodeRgba(FULL, 'jpg');
    const converted = await decodePng((await convertImage(cut, 'png', {}, 'cut.jpg', 'jpg')).buffer);
    expect([converted.width, converted.height]).toEqual([reference.width, reference.height]);
    const exactRows = Math.floor(reference.height * EXACT_TOP_FRACTION);
    expect(rows(converted, exactRows).equals(rows(reference, exactRows))).toBe(true);
    expect(converted.data.equals(reference.data)).toBe(false);
  });

  it('fills what the file does not hold, the way the reference decoder does', async () => {
    const reference = decodeRgba(cut, 'jpg');
    const converted = await decodePng((await convertImage(cut, 'png', {}, 'cut.jpg', 'jpg')).buffer);
    expect([converted.width, converted.height]).toEqual([reference.width, reference.height]);
    const lastRow = (image: { width: number; data: Buffer }) => image.data.subarray(image.data.length - image.width * RGBA_CHANNELS);
    expect(lastRow(converted).equals(lastRow(reference))).toBe(true);
  });
});

describe('a JPEG that ends before its first scan', () => {
  const scan = startOfScan(FULL);
  const HEADER_CUT = 100;
  const SCAN_HEADER_CUT = 5;

  it.each([
    ['inside the headers', HEADER_CUT],
    ['just before the scan header', scan],
    ['inside the scan header', scan + SCAN_HEADER_CUT],
  ])('is refused with the typed decode error (%s)', async (_label, length) => {
    const failure = await fail(convertImage(FULL.subarray(0, length), 'png', {}, 'cut.jpg', 'jpg'));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/^Invalid image: /);
  });
});

describe('which streams are opened tolerantly', () => {
  const walk = walkJpegStream(FULL, 0);
  const scan = startOfScan(FULL);
  const floor = minimumScanBytes(walk.frameBlocks);

  it('only a stream that ends inside scan data with enough of it for the frame', () => {
    expect(truncatedJpegDecodeOptions(FULL)).toEqual({});
    expect(truncatedJpegDecodeOptions(FULL.subarray(0, scan))).toEqual({});
    expect(truncatedJpegDecodeOptions(FULL.subarray(0, scan + 5))).toEqual({});
    expect(truncatedJpegDecodeOptions(FULL.subarray(0, walk.scanStart + floor))).toEqual({ failOn: 'none' });
    expect(truncatedJpegDecodeOptions(Buffer.from('not a jpeg at all'))).toEqual({});
  });

  it('a scan of one bit per 8x8 block of the frame is the fewest bytes the frame can hold', () => {
    expect(floor).toBe(FRAME_BLOCKS / 8);
    expect(truncatedJpegDecodeOptions(FULL.subarray(0, walk.scanStart + floor - 1))).toEqual({});
    expect(truncatedJpegDecodeOptions(FULL.subarray(0, walk.scanStart + floor))).toEqual({ failOn: 'none' });
  });

  it.each([
    ['lossless', 0xc3],
    ['arithmetic-coded', 0xc9],
  ])('a %s frame, which can code a block in less than one bit, keeps the strict default', (_name, sof) => {
    const cut = Buffer.from(FULL.subarray(0, walk.scanStart + floor * 4));
    const at = [0xc0, 0xc1, 0xc2].map((marker) => cut.indexOf(Buffer.from([0xff, marker]))).find((offset) => offset >= 0) ?? -1;
    expect(at).toBeGreaterThan(0);
    cut[at + 1] = sof;
    expect(walkJpegStream(cut, 0).frameBlocks).toBe(-1);
    expect(truncatedJpegDecodeOptions(cut)).toEqual({});
  });

  it('a stream with its end marker keeps the strict default, so a corrupt but complete file is still reported', () => {
    expect(walk).toMatchObject({ end: FULL.length, frameBlocks: FRAME_BLOCKS });
  });
});

describe('a JPEG whose scan holds too little for its frame', () => {
  const walk = walkJpegStream(FULL, 0);
  const sof = FULL.indexOf(Buffer.from([0xff, 0xc0]));

  async function refusedAsInvalid(jpeg: Buffer): Promise<void> {
    const failure = await fail(convertImage(jpeg, 'png', {}, 'cut.jpg', 'jpg'));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/^Invalid image: /);
  }

  it('is refused when it ends with no scan byte at all', async () => {
    await refusedAsInvalid(FULL.subarray(0, walk.scanStart));
  });

  it('is refused when only the headers are kept and the frame is declared far larger than the file', async () => {
    const forged = Buffer.from(FULL.subarray(0, walk.scanStart));
    forged.writeUInt16BE(FORGED_SIDE, sof + 5);
    forged.writeUInt16BE(FORGED_SIDE, sof + 7);
    await refusedAsInvalid(forged);
  });

  it('is refused one byte under the floor and read from the floor on, for a frame of a single block', async () => {
    const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).jpeg({ chromaSubsampling: '4:4:4' }).toBuffer();
    const { scanStart, frameBlocks } = walkJpegStream(tiny, 0);
    expect(frameBlocks).toBe(3);
    expect(truncatedJpegDecodeOptions(tiny.subarray(0, scanStart))).toEqual({});
    expect(truncatedJpegDecodeOptions(tiny.subarray(0, scanStart + 1))).toEqual({ failOn: 'none' });
    await refusedAsInvalid(tiny.subarray(0, scanStart));
  });
});

describe('a JPEG that is damaged but still ends with its end marker', () => {
  const walk = walkJpegStream(FULL, 0);
  const SEEDS = 200;

  function seeded(seed: number): () => number {
    let state = seed;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  it('keeps the strict decode for a single stray marker inside the scan', async () => {
    const damaged = Buffer.from(FULL);
    damaged[STRAY_MARKER_AT] = 0xff;
    damaged[STRAY_MARKER_AT + 1] = 0x12;
    expect(truncatedJpegDecodeOptions(damaged)).toEqual({});
    const failure = await fail(convertImage(damaged, 'png', {}, 'damaged.jpg', 'jpg'));
    expect(failure).toBeInstanceOf(ConversionFailedError);
  });

  it('keeps the strict decode for every mid-scan corruption of a seeded set', () => {
    const next = seeded(SEEDS);
    for (let seed = 0; seed < SEEDS; seed += 1) {
      const damaged = Buffer.from(FULL);
      const at = walk.scanStart + Math.floor(next() * (FULL.length - walk.scanStart - SEEDS));
      const length = 1 + Math.floor(next() * CORRUPT_RUN_MAX);
      for (let offset = 0; offset < length; offset += 1) damaged[at + offset] = Math.floor(next() * 256);
      damaged[FULL.length - 2] = 0xff;
      damaged[FULL.length - 1] = 0xd9;
      expect(truncatedJpegDecodeOptions(damaged)).toEqual({});
    }
  });
});

describe.skipIf(SKIP_WITHOUT_MAGICK)('a progressive JPEG cut inside its scans', () => {
  const SIDE = 192;
  const PROGRESSIVE_CUT = 0.75;

  async function progressive(): Promise<Buffer> {
    const noise = Buffer.alloc(SIDE * SIDE * 3);
    let state = 7;
    for (let at = 0; at < noise.length; at += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      noise[at] = (state >>> 24) & 0xc0 | (at % 64);
    }
    return sharp(noise, { raw: { width: SIDE, height: SIDE, channels: 3 } }).jpeg({ progressive: true, quality: 90 }).toBuffer();
  }

  it('converts to the source dimensions, and is refused when it is cut before its scan holds the floor', async () => {
    const jpeg = await progressive();
    const { scanStart, frameBlocks } = walkJpegStream(jpeg, 0);
    expect(scanStart).toBeGreaterThan(0);
    const cut = jpeg.subarray(0, Math.floor(jpeg.length * PROGRESSIVE_CUT));
    expect(truncatedJpegDecodeOptions(cut)).toEqual({ failOn: 'none' });
    const converted = await convertImage(cut, 'png', {}, 'cut.jpg', 'jpg');
    expect(await sharp(converted.buffer).metadata()).toMatchObject({ width: SIDE, height: SIDE });
    const short = jpeg.subarray(0, scanStart + minimumScanBytes(frameBlocks) - 1);
    expect(truncatedJpegDecodeOptions(short)).toEqual({});
    const failure = await fail(convertImage(short, 'png', {}, 'cut.jpg', 'jpg'));
    expect(failure).toBeInstanceOf(ConversionFailedError);
  });
});

describe.skipIf(SKIP_WITHOUT_MAGICK)('a real file cut inside its scan', () => {
  it('converts to PNG with the dimensions its header declares', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'lo-tdf138950.jpeg');
    const converted = await convertImage(bytes, 'png', {}, 'lo-tdf138950.jpeg', 'jpg');
    expect(await sharp(converted.buffer).metadata()).toMatchObject({ width: 720, height: 1280 });
  });
});
