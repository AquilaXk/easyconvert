import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { usesOldStyleJpeg } from '../src/lib/conversions/image-external-source';
import { findMagick } from '../src/lib/conversions/image-magick-cli';
import { decodeRgba, maxSampleDifference } from './helpers/image-pixels';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';

/**
 * A TIFF whose directory declares old-style JPEG compression (Compression = 6, TIFF 6.0 section 22) converts through
 * ImageMagick's libtiff, which is built with the decoder; the image library's libtiff is not (#783: "Old-style JPEG
 * compression support is not configured"). Which files take that route is decided from the directories, built here by hand.
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

  it('answers false for a file that is not a classic TIFF or ends inside a directory', () => {
    expect(usesOldStyleJpeg(Buffer.from('not a tiff at all'))).toBe(false);
    expect(usesOldStyleJpeg(Buffer.alloc(0))).toBe(false);
    const bigTiff = buildTiff([entries(COMPRESSION_OLD_STYLE_JPEG)], true);
    bigTiff.writeUInt16LE(43, 2);
    expect(usesOldStyleJpeg(bigTiff)).toBe(false);
    const whole = buildTiff([entries(COMPRESSION_OLD_STYLE_JPEG)], true);
    expect(usesOldStyleJpeg(whole.subarray(0, whole.length - 10))).toBe(false);
  });
});

const needsMagick = skipUnless('ImageMagick (magick or convert)', findMagick() !== null);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ojpeg-tiff-'));
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));
const WIDTH = 4160;
const HEIGHT = 870;

describe.skipIf(needsMagick)('a TIFF with old-style JPEG compression', () => {
  it.for(['png', 'jpg', 'webp', 'tiff'])('converts to %s, the picture ImageMagick decodes', { timeout: 60_000 }, async (target, ctx) => {
    const sample = await requireRealworldSample(ctx, 'opf-old-style-jpeg-compression.tif');
    expect(usesOldStyleJpeg(sample.bytes)).toBe(true);
    const converted = await decodeRgba((await dispatchConversion(sample.bytes, 'tif', target, {}, 'scan.tif')).buffer);
    expect([converted.width, converted.height]).toEqual([WIDTH, HEIGHT]);
    if (target !== 'png') return;
    const reference = path.join(workDir, 'reference.png');
    execFileSync(findMagick() as string, [sample.path, reference], { stdio: 'pipe' });
    expect(maxSampleDifference(converted, await decodeRgba(fs.readFileSync(reference)))).toBe(0);
  });
});
