import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { truncatedJpegDecodeOptions, walkJpegStream } from '../src/lib/conversions/image-jpeg-stream';
import { ConversionFailedError } from '../src/lib/types';
import { decodeRgba, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

/**
 * A JPEG that ends inside its scan data converts to the part that was decoded, with the rest filled, the way the reference
 * service's decoder (libjpeg under ImageMagick) reads it: "Premature end of JPEG file" is a warning there. A stream that ends before
 * its first scan holds no pixels and is refused with the typed decode error. Oracle: ImageMagick's own decode of the complete file.
 */

const FULL = readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg'));
const RGBA_CHANNELS = 4;
const SOS_MARKER = 0xda;
const SCAN_HEADER_BYTES = 12;
const EXACT_TOP_FRACTION = 0.3;

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
  const scan = startOfScan(FULL);

  it('only a stream that ends inside scan data', () => {
    expect(truncatedJpegDecodeOptions(FULL)).toEqual({});
    expect(truncatedJpegDecodeOptions(FULL.subarray(0, scan))).toEqual({});
    expect(truncatedJpegDecodeOptions(FULL.subarray(0, scan + 5))).toEqual({});
    expect(truncatedJpegDecodeOptions(FULL.subarray(0, scan + SCAN_HEADER_BYTES + 100))).toEqual({ failOn: 'none' });
    expect(truncatedJpegDecodeOptions(Buffer.from('not a jpeg at all'))).toEqual({});
  });

  it('a stream with its end marker keeps the strict default, so a corrupt but complete file is still reported', () => {
    expect(walkJpegStream(FULL, 0)).toMatchObject({ end: FULL.length, scanStarted: true });
  });
});
