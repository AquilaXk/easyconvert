import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { usesOldStyleJpeg } from '../src/lib/conversions/image-tiff-directories';
import { findMagick, MAGICK_PATH_ENV } from '../src/lib/conversions/image-magick-cli';
import { decodeRgba } from './helpers/image-pixels';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';
import { psnrDb } from './helpers/zimg-oracle';

/**
 * A TIFF whose directory declares old-style JPEG compression (Compression = 6, TIFF 6.0 section 22) converts through
 * ImageMagick's libtiff, which is built with the decoder; the image library's libtiff is not (#783: "Old-style JPEG
 * compression support is not configured"). Which files take that route is decided from the directories, built here by hand.
 * The real file is checked against the JPEG stream it carries (below), which a JPEG decoder reads without libtiff.
 */

const TAG_COMPRESSION = 259;
const TAG_IMAGE_WIDTH = 256;
const COMPRESSION_NONE = 1;
const COMPRESSION_OLD_STYLE_JPEG = 6;
const COMPRESSION_JPEG = 7;

interface DirectoryEntry {
  tag: number;
  value: number;
}

/** A classic TIFF whose directories hold the given SHORT entries, linked in order; `littleEndian` picks the byte order. */
function buildTiff(directories: readonly (readonly DirectoryEntry[])[], littleEndian: boolean): Buffer {
  const u16 = (value: number): Buffer => {
    const b = Buffer.alloc(2);
    if (littleEndian) b.writeUInt16LE(value);
    else b.writeUInt16BE(value);
    return b;
  };
  const u32 = (value: number): Buffer => {
    const b = Buffer.alloc(4);
    if (littleEndian) b.writeUInt32LE(value);
    else b.writeUInt32BE(value);
    return b;
  };
  const sizes = directories.map((entries) => 2 + entries.length * 12 + 4);
  const starts = sizes.map((_, index) => 8 + sizes.slice(0, index).reduce((sum, size) => sum + size, 0));
  const parts: Buffer[] = [Buffer.from(littleEndian ? 'II' : 'MM', 'ascii'), u16(42), u32(starts[0])];
  directories.forEach((entries, index) => {
    parts.push(u16(entries.length));
    for (const entry of entries) {
      parts.push(u16(entry.tag), u16(3), u32(1), u16(entry.value), Buffer.alloc(2));
    }
    parts.push(u32(index + 1 < directories.length ? starts[index + 1] : 0));
  });
  return Buffer.concat(parts);
}

describe('which TIFF files take the old-style JPEG route', () => {
  const entries = (compression: number): DirectoryEntry[] => [
    { tag: TAG_IMAGE_WIDTH, value: 8 },
    { tag: TAG_COMPRESSION, value: compression },
  ];

  it.each([true, false])('answers true for old-style JPEG compression, little-endian %s', (littleEndian) => {
    expect(usesOldStyleJpeg(buildTiff([entries(COMPRESSION_OLD_STYLE_JPEG)], littleEndian))).toBe(true);
  });

  it.each([COMPRESSION_NONE, COMPRESSION_JPEG, 5, 8])('answers false for compression %i', (compression) => {
    expect(usesOldStyleJpeg(buildTiff([entries(compression)], true))).toBe(false);
  });

  it('looks at every directory of a multi-page file', () => {
    const pages = [entries(COMPRESSION_NONE), entries(COMPRESSION_JPEG), entries(COMPRESSION_OLD_STYLE_JPEG)];
    expect(usesOldStyleJpeg(buildTiff(pages, true))).toBe(true);
    expect(usesOldStyleJpeg(buildTiff(pages.slice(0, 2), true))).toBe(false);
  });

  it('ends on a chain of directories that points back at itself', () => {
    const tiff = buildTiff([entries(COMPRESSION_NONE)], true);
    tiff.writeUInt32LE(8, tiff.length - 4);
    expect(usesOldStyleJpeg(tiff)).toBe(false);
  });

  it('answers false when the first directory lies beyond the end of the file', () => {
    const tiff = buildTiff([entries(COMPRESSION_OLD_STYLE_JPEG)], true);
    tiff.writeUInt32LE(tiff.length, 4);
    expect(usesOldStyleJpeg(tiff)).toBe(false);
    tiff.writeUInt32LE(tiff.length - 1, 4);
    expect(usesOldStyleJpeg(tiff)).toBe(false);
    tiff.writeUInt32LE(0, 4);
    expect(usesOldStyleJpeg(tiff)).toBe(false);
  });

  it('answers false for a file that is not a classic TIFF or ends inside a directory', () => {
    expect(usesOldStyleJpeg(Buffer.from('not a tiff at all'))).toBe(false);
    expect(usesOldStyleJpeg(Buffer.alloc(0))).toBe(false);
    const bigTiff = buildTiff([entries(COMPRESSION_OLD_STYLE_JPEG)], true);
    bigTiff.writeUInt16LE(43, 2);
    expect(usesOldStyleJpeg(bigTiff)).toBe(false);
    const whole = buildTiff([entries(COMPRESSION_OLD_STYLE_JPEG)], true);
    expect(usesOldStyleJpeg(whole.subarray(0, whole.length - 10))).toBe(false);
    // The directory is whole but the offset of the next directory is cut short: the file is damaged, not a TIFF to route.
    expect(usesOldStyleJpeg(whole.subarray(0, whole.length - 1))).toBe(false);
    expect(usesOldStyleJpeg(whole)).toBe(true);
  });
});

const needsMagick = skipUnless('ImageMagick (magick or convert)', findMagick() !== null);
const WIDTH = 4160;
const HEIGHT = 870;

/**
 * Where the one strip of the real file lies: the directory says StripOffsets 768 and StripByteCounts 212992 (`tiffinfo`), and
 * JpegInterchangeFormat 768 says the strip is a whole JFIF file (the TIFF 6.0 section 22 variant that keeps the tables in the stream).
 */
const STRIP_OFFSET = 768;
const STRIP_BYTES = 212992;
/** Lowest PSNR (dB) against the strip decoded as a JPEG file. PNG and TIFF carry the decode itself; the least measured on a Linux and a macOS run is 53.7 dB, the gap being the transform and upsampling of two JPEG decoders. */
const MIN_DECODE_PSNR_DB = 50;
/** The same for a target that encodes again; the least measured is 43.3 dB (AVIF). */
const MIN_REENCODED_PSNR_DB = 40;
const DECODE_TARGETS = ['png', 'tiff'];

describe.skipIf(needsMagick)('a TIFF with old-style JPEG compression', () => {
  it.for(['png', 'tiff', 'jpg', 'webp', 'avif', 'gif'])('converts to %s, the picture its JPEG stream decodes to', { timeout: 60_000 }, async (target, ctx) => {
    const sample = await requireRealworldSample(ctx, 'opf-old-style-jpeg-compression.tif');
    expect(usesOldStyleJpeg(sample.bytes)).toBe(true);
    const stream = sample.bytes.subarray(STRIP_OFFSET, STRIP_OFFSET + STRIP_BYTES);
    expect(stream.toString('latin1', 0, 4)).toBe('\xff\xd8\xff\xe0');
    expect(await sharp(stream).metadata()).toMatchObject({ format: 'jpeg', width: WIDTH, height: HEIGHT });
    const reference = (await sharp(stream).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
    const converted = await sharp((await dispatchConversion(sample.bytes, 'tif', target, {}, 'scan.tif')).buffer)
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([converted.info.width, converted.info.height]).toEqual([WIDTH, HEIGHT]);
    const minimum = DECODE_TARGETS.includes(target) ? MIN_DECODE_PSNR_DB : MIN_REENCODED_PSNR_DB;
    expect(psnrDb(converted.data, reference)).toBeGreaterThanOrEqual(minimum);
  });
});
