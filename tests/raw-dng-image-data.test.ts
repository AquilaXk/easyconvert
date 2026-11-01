import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dngRawImageData, type ImageSize } from '../src/worker/raw-dng-image-data';
import {
  COMPRESSION, PHOTOMETRIC, RAW_SIZE, REDUCED_RESOLUTION, TAG, TYPE, buildTiff, imageEntries, minimalDng, type TiffDirectorySpec, type TiffEntrySpec,
} from './helpers/dng-builder';

/**
 * A DNG holds its raw image when every strip or tile of the directory LibRaw develops lies inside the file. LibRaw reads at most 10
 * directories, a parent before its SubIFDs, and with the engine's options develops the first of NewSubFileType 0 whose width and height
 * are 1 to 65535 and which is a CFA or Linear Raw image. The picture it writes is that directory's size, at most 23 pixels smaller on each
 * axis, stretched by DefaultScale and turned when the first Orientation that turns or flips says so.
 */

const directory = mkdtempSync(path.join(os.tmpdir(), 'dng-image-data-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

let written = 0;
function check(file: Buffer, decoded: ImageSize = RAW_SIZE): string {
  written += 1;
  const filePath = path.join(directory, `${written}.dng`);
  writeFileSync(filePath, file);
  return dngRawImageData(filePath, decoded);
}

const SIZE = 4096;
const preview = (at: number, next = 0, extra: TiffDirectorySpec['entries'] = []): TiffDirectorySpec => ({
  at,
  entries: [...imageEntries([[3000, 100]], { subfileType: REDUCED_RESOLUTION }), ...extra],
  next,
});
const subIfds = (offsets: number[], at = 0) => ({ tag: TAG.subIfds, type: TYPE.ifd, values: offsets, at });

describe('a DNG whose raw image is in its first directory', () => {
  it('holds it when the strip ends at the last byte of the file, in either byte order', () => {
    expect(check(minimalDng(200))).toBe('whole');
    expect(check(minimalDng(200, undefined, { little: false }))).toBe('whole');
  });

  it('does not when the file is one byte shorter than the strip needs, in either byte order', () => {
    expect(check(minimalDng(200, minimalDng(200).length - 1))).toBe('outside-file');
    expect(check(minimalDng(200, minimalDng(200).length - 1, { little: false }))).toBe('outside-file');
  });

  it('reads many strips from their arrays and finds the one that leaves the file', () => {
    const size = 400_000;
    const strips = Array.from({ length: 40_000 }, (): [number, number] => [100, 1]);
    expect(check(buildTiff(size, [{ at: 8, entries: imageEntries(strips, { arraysAt: 100 }) }]))).toBe('whole');
    strips[strips.length - 1] = [size - 10, 11];
    expect(check(buildTiff(size, [{ at: 8, entries: imageEntries(strips, { arraysAt: 100 }) }]))).toBe('outside-file');
  });

  it.each([true, false])('reads SHORT strip arrays inline and out of line (little-endian %s)', (little) => {
    const inline = (end: number) => buildTiff(SIZE, [{ at: 8, entries: imageEntries([[200, 100], [300, end - 300]], { arrayType: TYPE.short }) }], { little });
    expect(check(inline(SIZE))).toBe('whole');
    expect(check(inline(SIZE + 1))).toBe('outside-file');
    const outOfLine = (end: number) => buildTiff(SIZE, [{
      at: 8,
      entries: imageEntries([[200, 100], [300, 100], [400, end - 400]], { arrayType: TYPE.short, arraysAt: 100 }),
    }], { little });
    expect(check(outOfLine(SIZE))).toBe('whole');
    expect(check(outOfLine(SIZE + 1))).toBe('outside-file');
  });

  it('reads tiles when the directory lists them', () => {
    expect(check(buildTiff(SIZE, [{ at: 8, entries: imageEntries([[200, 100], [300, 100], [400, 100]], { tiles: true, arraysAt: 100 }) }]))).toBe('whole');
    expect(check(buildTiff(SIZE, [{ at: 8, entries: imageEntries([[200, 100], [300, 100], [4000, 100]], { tiles: true, arraysAt: 100 }) }]))).toBe('outside-file');
  });

  it('does not when a strip is empty, the arrays list none or the counts do not match the offsets', () => {
    expect(check(minimalDng(0))).toBe('unreadable-layout');
    expect(check(buildTiff(SIZE, [{ at: 8, entries: imageEntries([]) }]))).toBe('unreadable-layout');
    const entries = imageEntries([[200, 100]]).map((entry) => (entry.tag === TAG.stripByteCounts ? { ...entry, values: [100, 100], at: 100 } : entry));
    expect(check(buildTiff(SIZE, [{ at: 8, entries }]))).toBe('unreadable-layout');
  });

  it('does not when the array of strip offsets lies outside the file', () => {
    expect(check(buildTiff(SIZE, [{ at: 8, entries: imageEntries([[200, 100], [300, 100]], { arraysAt: SIZE - 16 }) }]).subarray(0, SIZE - 4))).toBe('unreadable-layout');
  });
});

const orientation = (value: number): TiffEntrySpec => ({ tag: TAG.orientation, type: TYPE.short, values: [value] });
const defaultScale = (horizontal: number, vertical: number, at: number): TiffEntrySpec => ({
  tag: TAG.defaultScale, type: TYPE.rational, values: [horizontal, 1, vertical, 1], at,
});
const raw = (at: number, extra: TiffEntrySpec[] = []): TiffDirectorySpec => ({ at, entries: [...imageEntries([[3000, 100]]), ...extra] });

describe('the size of the raw image', () => {
  it('is that of the decoded picture or at most 23 pixels smaller on each axis, never larger, so a preview is not taken for it', () => {
    expect(check(minimalDng(200))).toBe('whole');
    expect(check(minimalDng(200), { width: RAW_SIZE.width - 23, height: RAW_SIZE.height - 23 })).toBe('whole');
    for (const decoded of [
      { width: RAW_SIZE.width - 24, height: RAW_SIZE.height },
      { width: RAW_SIZE.width, height: RAW_SIZE.height - 24 },
      { width: RAW_SIZE.width + 1, height: RAW_SIZE.height },
      { width: RAW_SIZE.width, height: RAW_SIZE.height + 1 },
      { width: RAW_SIZE.width / 2, height: RAW_SIZE.height / 2 },
    ]) expect(check(minimalDng(200), decoded), `${decoded.width} x ${decoded.height}`).toBe('dimensions');
  });

  it('is turned only when the first Orientation that turns or flips the picture says so, as LibRaw writes it', () => {
    const turned = { width: RAW_SIZE.height, height: RAW_SIZE.width };
    expect(check(minimalDng(200), turned)).toBe('dimensions');
    for (const value of [5, 6, 7, 8]) {
      const file = buildTiff(SIZE, [raw(8, [orientation(value)])]);
      expect(check(file, turned), `Orientation ${value}`).toBe('whole');
      expect(check(file), `Orientation ${value}`).toBe('dimensions');
    }
    const below = (parent: number) => buildTiff(SIZE, [preview(8, 0, [orientation(parent), subIfds([200])]), raw(200, [orientation(6)])]);
    expect(check(below(1), turned)).toBe('whole');
    expect(check(below(3))).toBe('whole');
    expect(check(below(3), turned)).toBe('dimensions');
  });

  it('is its ActiveArea when it has one, and ImageWidth or ImageLength where the area is empty', () => {
    const withArea = (values: number[]) => buildTiff(SIZE, [{ at: 8, entries: [...imageEntries([[400, 100]]), { tag: TAG.activeArea, type: TYPE.short, values, at: 200 }] }]);
    expect(check(withArea([2, 4, 82, 54]), { width: 50, height: 80 })).toBe('whole');
    expect(check(withArea([2, 4, 82, 54]))).toBe('dimensions');
    expect(check(withArea([0, 0, 0, 0]))).toBe('whole');
  });

  it('is stretched by DefaultScale, taller when its pixels are narrower and wider when they are wider, and not within half a percent of square', () => {
    const scaled = (horizontal: number, vertical: number) => buildTiff(SIZE, [raw(8, [defaultScale(horizontal, vertical, 200)])]);
    expect(check(scaled(1, 2), { width: RAW_SIZE.width, height: RAW_SIZE.height * 2 })).toBe('whole');
    expect(check(scaled(1, 2))).toBe('dimensions');
    expect(check(scaled(2, 1), { width: RAW_SIZE.width * 2, height: RAW_SIZE.height })).toBe('whole');
    expect(check(scaled(2, 1))).toBe('dimensions');
    const tall = buildTiff(SIZE, [raw(8, [defaultScale(996, 1000, 200), { tag: TAG.activeArea, type: TYPE.short, values: [0, 0, 1000, 64], at: 300 }])]);
    expect(check(tall, { width: RAW_SIZE.width, height: 1000 })).toBe('whole');
    expect(check(tall, { width: RAW_SIZE.width, height: 1004 })).toBe('dimensions');
  });

  it('is stretched by the DefaultScale LibRaw reads last, a parent\'s own after those of the SubIFDs it lists before it', () => {
    const file = buildTiff(SIZE, [
      preview(8, 0, [subIfds([200]), defaultScale(1, 1, 150)]),
      raw(200, [defaultScale(1, 2, 400)]),
    ]);
    expect(check(file)).toBe('whole');
    expect(check(file, { width: RAW_SIZE.width, height: RAW_SIZE.height * 2 })).toBe('dimensions');
  });
});

describe('where the raw image is', () => {
  it('is the full-resolution SubIFD under a preview, whose own strips do not count', () => {
    const tree = (rawStripBytes: number) => buildTiff(SIZE, [
      preview(8, 0, [subIfds([200])]),
      { at: 200, entries: imageEntries([[400, rawStripBytes]]) },
    ]);
    expect(check(tree(3000))).toBe('whole');
    expect(check(tree(4000))).toBe('outside-file');
    expect(check(buildTiff(SIZE, [{ at: 8, entries: imageEntries([[400, 100]]), next: 200 }, preview(200)]).subarray(0, 3050))).toBe('whole');
  });

  it('skips a full-resolution IFD0 that is no CFA or Linear Raw image, and refuses the raw SubIFD below it when cut inside its strips', () => {
    const tree = (rawStripBytes: number) => buildTiff(SIZE, [
      { at: 8, entries: [...imageEntries([[2000, 1000]], { photometric: PHOTOMETRIC.yCbCr }), subIfds([200])] },
      { at: 200, entries: imageEntries([[3000, rawStripBytes]]) },
    ]);
    expect(check(tree(1000))).toBe('whole');
    expect(check(tree(1200))).toBe('outside-file');
  });

  it('is a directory of NewSubFileType 0 only, so an enhanced image (16) before it is not the one checked', () => {
    const tree = buildTiff(SIZE, [
      { at: 8, entries: [...imageEntries([[2000, 4000]], { subfileType: 16 }), subIfds([200])] },
      { at: 200, entries: imageEntries([[3000, 1000]], { photometric: PHOTOMETRIC.linearRaw }) },
    ]);
    expect(check(tree)).toBe('whole');
  });

  it('is taken whatever its Compression, as LibRaw chooses it before it looks for a decoder', () => {
    const tree = buildTiff(SIZE, [
      { at: 8, entries: [...imageEntries([[2000, 4000]], { compression: COMPRESSION.jpeg }), subIfds([200])] },
      { at: 200, entries: imageEntries([[3000, 1000]], { photometric: PHOTOMETRIC.linearRaw }) },
    ]);
    expect(check(tree)).toBe('outside-file');
  });

  it('skips a directory with no width or height, or one above 65535', () => {
    const sized = (entries: TiffEntrySpec[]) => buildTiff(SIZE, [
      { at: 8, entries: [...entries, subIfds([200])] },
      { at: 200, entries: imageEntries([[3000, 1000]]) },
    ]);
    const cut = imageEntries([[2000, 4000]]);
    expect(check(sized(cut))).toBe('outside-file');
    expect(check(sized(cut.filter((entry) => entry.tag !== TAG.imageLength)))).toBe('whole');
    expect(check(sized(cut.map((entry) => (entry.tag === TAG.imageWidth ? { ...entry, values: [65_536] } : entry))))).toBe('whole');
  });

  it('is found further down the chain', () => {
    expect(check(buildTiff(SIZE, [preview(8, 200), { at: 200, entries: imageEntries([[400, 100]]) }]))).toBe('whole');
  });

  it('is none when every directory is a preview, a transparency mask or an enhanced image, or has no PhotometricInterpretation', () => {
    for (const subfileType of [4, 16]) {
      expect(check(buildTiff(SIZE, [preview(8, 200), { at: 200, entries: imageEntries([[400, 100]], { subfileType }) }]))).toBe('no-raw-image');
    }
    const entries = imageEntries([[400, 100]]).filter((entry) => entry.tag !== TAG.photometric);
    expect(check(buildTiff(SIZE, [{ at: 8, entries }]))).toBe('no-raw-image');
  });

  it('is none when the file is not a classic TIFF, BigTIFF included', () => {
    const bigTiff = minimalDng(200);
    bigTiff.writeUInt16LE(43, 2);
    expect(check(bigTiff)).toBe('not-classic-tiff');
    expect(check(Buffer.from('II*'))).toBe('not-classic-tiff');
  });
});

describe('directories laid out to make the reader loop or explode', () => {
  it('reads 10 directories in all, so a chain that points back at itself ends', () => {
    expect(check(buildTiff(SIZE, [preview(8, 8)]))).toBe('no-raw-image');
  });

  it('reads a SubIFD that points at its parent or into it as a directory of its own, until the 10 are read', () => {
    expect(check(buildTiff(SIZE, [preview(8, 0, [subIfds([8])])]))).toBe('no-raw-image');
    expect(check(buildTiff(SIZE, [preview(8, 0, [subIfds([12])])]))).toBe('no-raw-image');
  });

  it('ends the SubIFD list at offset 0, whose byte order reads as more than 512 entries, and reads the header bytes at 2, 4 and 6 as a directory', () => {
    const rawAt200 = { at: 200, entries: imageEntries([[400, 100]]) };
    expect(check(buildTiff(SIZE, [preview(8, 0, [subIfds([200], 150)]), rawAt200]))).toBe('whole');
    expect(check(buildTiff(SIZE, [preview(8, 0, [subIfds([0, 200], 150)]), rawAt200]))).toBe('no-raw-image');
    for (const offset of [2, 4, 6]) expect(check(buildTiff(SIZE, [preview(8, 0, [subIfds([offset, 200], 150)]), rawAt200])), `offset ${offset}`).toBe('whole');
  });

  it('counts a directory of more than 512 entries, or one past the end of the file, and ends its list there', () => {
    const size = 16_384;
    const filler = (count: number): TiffDirectorySpec => ({ at: 1000, entries: Array.from({ length: count }, () => ({ tag: 0x8000, type: TYPE.short, values: [0] })) });
    const tree = (offsets: number[], count: number) => buildTiff(size, [preview(8, 0, [subIfds(offsets, 150)]), raw(200), filler(count)]);
    expect(check(tree([1000, 200], 512))).toBe('whole');
    expect(check(tree([1000, 200], 513))).toBe('no-raw-image');
    expect(check(tree([size + 8, 200], 0))).toBe('no-raw-image');
    expect(check(tree([200, size + 8], 0))).toBe('whole');
  });

  it('reads a value past the end of the file as 0xff bytes, and skips an entry of more than 8 values that would end past twice the file size', () => {
    const size = 2000;
    const tree = (kind: TiffEntrySpec) => buildTiff(5 * size, [
      { at: 8, entries: [kind, ...imageEntries([[1000, 4000]]).slice(1), subIfds([200])] },
      { at: 200, entries: imageEntries([[1000, 100]]) },
    ]).subarray(0, size);
    expect(check(tree({ tag: TAG.newSubfileType, type: TYPE.long, values: [0, 0], at: size + 100 }))).toBe('whole');
    expect(check(tree({ tag: TAG.newSubfileType, type: TYPE.long, values: Array(9).fill(0), at: 2 * size - 8 }))).toBe('outside-file');
  });

  it('reads a directory again when the chain reaches a SubIFD already read', () => {
    const rawAt300 = raw(300);
    expect(check(buildTiff(SIZE, [preview(8, 200), preview(200, 300), rawAt300]))).toBe('whole');
    expect(check(buildTiff(SIZE, [preview(8, 200, [subIfds([200])]), preview(200, 300), rawAt300]))).toBe('whole');
  });

  it('reads 10 directories in all: a parent and 9 of its SubIFDs, not a 10th', () => {
    const tree = (rawIndex: number) => {
      const offsets = Array.from({ length: 12 }, (_, index) => 400 + index * 100);
      const children = offsets.map((at, index): TiffDirectorySpec => (index === rawIndex ? raw(at) : preview(at)));
      return buildTiff(SIZE, [preview(8, 0, [subIfds(offsets, 200)]), ...children]);
    };
    expect(check(tree(8))).toBe('whole');
    expect(check(tree(9))).toBe('no-raw-image');
  });

  it('follows 10 directories of the chain and not an 11th', () => {
    const chain = (length: number) => Array.from({ length }, (_, index): TiffDirectorySpec => {
      const at = 8 + index * 100;
      return index === length - 1 ? raw(at) : preview(at, at + 100);
    });
    expect(check(buildTiff(SIZE, chain(10)))).toBe('whole');
    expect(check(buildTiff(SIZE, chain(11)))).toBe('no-raw-image');
  });

  it('nests 10 levels and not an 11th', () => {
    const nested = (levels: number) => Array.from({ length: levels }, (_, index): TiffDirectorySpec => {
      const at = 8 + index * 250;
      return index === levels - 1 ? { at, entries: imageEntries([[3900, 100]]) } : preview(at, 0, [subIfds([at + 250])]);
    });
    expect(check(buildTiff(SIZE, nested(10)))).toBe('whole');
    expect(check(buildTiff(SIZE, nested(11)))).toBe('no-raw-image');
  });

  it('stops at a SubIFD tag that claims a million directories, all of them its parent', () => {
    const offsets = Array.from({ length: 1_000_000 }, () => 8);
    const file = buildTiff(4_100_000, [preview(8, 0, [subIfds(offsets, 200)])]);
    expect(check(file)).toBe('no-raw-image');
  });
});
