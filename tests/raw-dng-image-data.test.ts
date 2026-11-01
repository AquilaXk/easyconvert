import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dngRawImageData, type ImageSize } from '../src/worker/raw-dng-image-data';
import {
  COMPRESSION, PHOTOMETRIC, RAW_SIZE, REDUCED_RESOLUTION, TAG, TYPE, buildTiff, imageEntries, minimalDng, type TiffDirectorySpec,
} from './helpers/dng-builder';

/**
 * A DNG holds its raw image when every strip or tile its raw directory lists lies inside the file, with the directory rules of rawspeed:
 * the raw image is the first full-resolution directory, chain and SubIFDs, in a compression rawspeed decodes and, as LibRaw requires,
 * a CFA or Linear Raw image; at most 10 children per parent, 28 directories and 5 levels, no two directories overlapping. The raw image
 * must also be the size of the picture the decoder wrote.
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

  it('does not when a strip is empty or the counts do not match the offsets', () => {
    expect(check(minimalDng(0))).toBe('unreadable-layout');
    const entries = imageEntries([[200, 100]]).map((entry) => (entry.tag === TAG.stripByteCounts ? { ...entry, values: [100, 100], at: 100 } : entry));
    expect(check(buildTiff(SIZE, [{ at: 8, entries }]))).toBe('unreadable-layout');
  });

  it('does not when the array of strip offsets lies outside the file', () => {
    expect(check(buildTiff(SIZE, [{ at: 8, entries: imageEntries([[200, 100], [300, 100]], { arraysAt: SIZE - 16 }) }]).subarray(0, SIZE - 4))).toBe('unreadable-layout');
  });
});

describe('the size of the raw image', () => {
  it('is its ImageWidth and ImageLength, in either orientation, and must be that of the decoded picture', () => {
    expect(check(minimalDng(200), { width: RAW_SIZE.height, height: RAW_SIZE.width })).toBe('whole');
    expect(check(minimalDng(200), { width: RAW_SIZE.width, height: RAW_SIZE.height - 1 })).toBe('dimensions');
  });

  it('is its ActiveArea when it has one', () => {
    const area = { tag: TAG.activeArea, type: TYPE.short, values: [2, 4, 82, 54], at: 200 };
    const file = buildTiff(SIZE, [{ at: 8, entries: [...imageEntries([[400, 100]]), area] }]);
    expect(check(file, { width: 50, height: 80 })).toBe('whole');
    expect(check(file)).toBe('dimensions');
  });

  it('is unknown without ImageLength', () => {
    const entries = imageEntries([[400, 100]]).filter((entry) => entry.tag !== TAG.imageLength);
    expect(check(buildTiff(SIZE, [{ at: 8, entries }]))).toBe('dimensions');
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

  it('skips a CFA directory whose compression the raw decoder does not read', () => {
    const tree = (rawStripBytes: number) => buildTiff(SIZE, [
      { at: 8, entries: [...imageEntries([[2000, 1000]], { compression: COMPRESSION.jpeg }), subIfds([200])] },
      { at: 200, entries: imageEntries([[3000, rawStripBytes]], { photometric: PHOTOMETRIC.linearRaw }) },
    ]);
    expect(check(tree(1000))).toBe('whole');
    expect(check(tree(1200))).toBe('outside-file');
  });

  it('is found further down the chain', () => {
    expect(check(buildTiff(SIZE, [preview(8, 200), { at: 200, entries: imageEntries([[400, 100]]) }]))).toBe('whole');
  });

  it('is none when every directory is a preview or a transparency mask, has no Compression or no PhotometricInterpretation', () => {
    const mask = imageEntries([[400, 100]], { subfileType: 4 });
    expect(check(buildTiff(SIZE, [preview(8, 200), { at: 200, entries: mask }]))).toBe('no-raw-image');
    for (const tag of [TAG.compression, TAG.photometric]) {
      const entries = imageEntries([[400, 100]]).filter((entry) => entry.tag !== tag);
      expect(check(buildTiff(SIZE, [{ at: 8, entries }]))).toBe('no-raw-image');
    }
  });

  it('is none when the file is not a classic TIFF, BigTIFF included', () => {
    const bigTiff = minimalDng(200);
    bigTiff.writeUInt16LE(43, 2);
    expect(check(bigTiff)).toBe('not-classic-tiff');
    expect(check(Buffer.from('II*'))).toBe('not-classic-tiff');
  });
});

describe('directories laid out to make the reader loop or explode', () => {
  it('stops at a chain that points back at itself', () => {
    expect(check(buildTiff(SIZE, [preview(8, 8)]))).toBe('no-raw-image');
  });

  it('stops at a SubIFD that points at its parent or overlaps a directory read before', () => {
    expect(check(buildTiff(SIZE, [preview(8, 0, [subIfds([8])])]))).toBe('no-raw-image');
    expect(check(buildTiff(SIZE, [preview(8, 0, [subIfds([12])])]))).toBe('no-raw-image');
  });

  it('reads no directory from a SubIFD offset below 8, inside the header, nor the SubIFDs listed after it', () => {
    const raw = { at: 200, entries: imageEntries([[400, 100]]) };
    expect(check(buildTiff(SIZE, [preview(8, 0, [subIfds([200], 150)]), raw]))).toBe('whole');
    for (const offset of [0, 2, 4, 6]) expect(check(buildTiff(SIZE, [preview(8, 0, [subIfds([offset, 200], 150)]), raw]))).toBe('no-raw-image');
  });

  it('does not read a directory twice, so a chain that reaches a SubIFD already read ends there', () => {
    const raw = { at: 300, entries: imageEntries([[400, 100]]) };
    expect(check(buildTiff(SIZE, [preview(8, 200), preview(200, 300), raw]))).toBe('whole');
    expect(check(buildTiff(SIZE, [preview(8, 200, [subIfds([200])]), preview(200, 300), raw]))).toBe('no-raw-image');
  });

  it('follows 10 SubIFDs of one directory and not an 11th', () => {
    const tree = (rawIndex: number) => {
      const offsets = Array.from({ length: 12 }, (_, index) => 400 + index * 100);
      const children = offsets.map((at, index): TiffDirectorySpec => (index === rawIndex
        ? { at, entries: imageEntries([[3000, 100]]) }
        : preview(at)));
      return buildTiff(SIZE, [preview(8, 0, [subIfds(offsets, 200)]), ...children]);
    };
    expect(check(tree(9))).toBe('whole');
    expect(check(tree(10))).toBe('no-raw-image');
  });

  it('follows 10 directories of the chain and not an 11th', () => {
    const chain = (length: number) => Array.from({ length }, (_, index): TiffDirectorySpec => {
      const at = 8 + index * 100;
      return index === length - 1 ? { at, entries: imageEntries([[3000, 100]]) } : preview(at, at + 100);
    });
    expect(check(buildTiff(SIZE, chain(10)))).toBe('whole');
    expect(check(buildTiff(SIZE, chain(11)))).toBe('no-raw-image');
  });

  it('nests 5 levels and not a 6th', () => {
    const nested = (levels: number) => Array.from({ length: levels }, (_, index): TiffDirectorySpec => {
      const at = 8 + index * 200;
      return index === levels - 1 ? { at, entries: imageEntries([[3000, 100]]) } : preview(at, 0, [subIfds([at + 200])]);
    });
    expect(check(buildTiff(SIZE, nested(5)))).toBe('whole');
    expect(check(buildTiff(SIZE, nested(6)))).toBe('no-raw-image');
  });

  it('reads at most 28 directories in the file', () => {
    const size = 16_384;
    const chain = [8, 1508, 3008];
    const tree = (rawChild: number) => buildTiff(size, chain.flatMap((at, index): TiffDirectorySpec[] => {
      const children = Array.from({ length: 9 }, (_, child) => at + 300 + child * 100);
      return [
        preview(at, chain[index + 1] ?? 0, [subIfds(children, at + 200)]),
        ...children.map((childAt, child) => (index === 2 && child === rawChild ? { at: childAt, entries: imageEntries([[12_000, 100]]) } : preview(childAt))),
      ];
    }));
    // In reading order the third chain directory is the 21st, so its seventh child is the 28th and its eighth the 29th.
    expect(check(tree(6))).toBe('whole');
    expect(check(tree(7))).toBe('no-raw-image');
  });

  it('stops at a SubIFD tag that claims a million directories, all of them its parent', () => {
    const offsets = Array.from({ length: 1_000_000 }, () => 8);
    const file = buildTiff(4_100_000, [preview(8, 0, [subIfds(offsets, 200)])]);
    expect(check(file)).toBe('no-raw-image');
  });
});
