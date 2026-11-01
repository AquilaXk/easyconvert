import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dngHoldsRawImageData } from '../src/worker/raw-dng-image-data';
import { REDUCED_RESOLUTION, TAG, TYPE, buildTiff, imageEntries, minimalDng, type TiffDirectorySpec } from './helpers/dng-builder';

/**
 * A DNG holds its raw image when every strip or tile its raw directory lists lies inside the file, with the directory rules of rawspeed:
 * the raw image is the first full-resolution directory, chain and SubIFDs, at most 10 children per parent, 28 directories and 5 levels,
 * no two directories overlapping.
 */

const directory = mkdtempSync(path.join(os.tmpdir(), 'dng-image-data-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

let written = 0;
function holds(file: Buffer): boolean {
  written += 1;
  const filePath = path.join(directory, `${written}.dng`);
  writeFileSync(filePath, file);
  return dngHoldsRawImageData(filePath);
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
    expect(holds(minimalDng(200))).toBe(true);
    expect(holds(buildTiff(264, [{ at: 8, entries: imageEntries([[64, 200]]) }], { little: false }))).toBe(true);
  });

  it('does not when the file is one byte shorter than the strip needs', () => {
    expect(holds(minimalDng(200, 263))).toBe(false);
  });

  it('reads many strips from their arrays and finds the one that leaves the file', () => {
    const size = 400_000;
    const strips = Array.from({ length: 40_000 }, (): [number, number] => [100, 1]);
    expect(holds(buildTiff(size, [{ at: 8, entries: imageEntries(strips, { arraysAt: 100 }) }]))).toBe(true);
    strips[strips.length - 1] = [size - 10, 11];
    expect(holds(buildTiff(size, [{ at: 8, entries: imageEntries(strips, { arraysAt: 100 }) }]))).toBe(false);
  });

  it('reads tiles when the directory lists them', () => {
    expect(holds(buildTiff(SIZE, [{ at: 8, entries: imageEntries([[200, 100], [300, 100], [400, 100]], { tiles: true, arraysAt: 100 }) }]))).toBe(true);
    expect(holds(buildTiff(SIZE, [{ at: 8, entries: imageEntries([[200, 100], [300, 100], [4000, 100]], { tiles: true, arraysAt: 100 }) }]))).toBe(false);
  });

  it('does not when a strip is empty or the counts do not match the offsets', () => {
    expect(holds(minimalDng(0))).toBe(false);
    const entries = imageEntries([[200, 100]]);
    entries[3] = { tag: TAG.stripByteCounts, type: TYPE.long, values: [100, 100], at: 100 };
    expect(holds(buildTiff(SIZE, [{ at: 8, entries }]))).toBe(false);
  });

  it('does not when the array of strip offsets lies outside the file', () => {
    expect(holds(buildTiff(SIZE, [{ at: 8, entries: imageEntries([[200, 100], [300, 100]], { arraysAt: SIZE - 16 }) }]).subarray(0, SIZE - 4))).toBe(false);
  });
});

describe('where the raw image is', () => {
  it('is the full-resolution SubIFD under a preview, whose own strips do not count', () => {
    const tree = (rawStripBytes: number) => buildTiff(SIZE, [
      preview(8, 0, [subIfds([200])]),
      { at: 200, entries: imageEntries([[400, rawStripBytes]]) },
    ]);
    expect(holds(tree(3000))).toBe(true);
    expect(holds(tree(4000))).toBe(false);
    expect(holds(buildTiff(SIZE, [{ at: 8, entries: imageEntries([[400, 100]]), next: 200 }, preview(200)]).subarray(0, 3050))).toBe(true);
  });

  it('is found further down the chain', () => {
    expect(holds(buildTiff(SIZE, [preview(8, 200), { at: 200, entries: imageEntries([[400, 100]]) }]))).toBe(true);
  });

  it('is none when every directory is a preview or a transparency mask, or has no Compression', () => {
    const mask = imageEntries([[400, 100]], { subfileType: 4 });
    expect(holds(buildTiff(SIZE, [preview(8, 200), { at: 200, entries: mask }]))).toBe(false);
    const uncompressed = imageEntries([[400, 100]]).filter((entry) => entry.tag !== TAG.compression);
    expect(holds(buildTiff(SIZE, [{ at: 8, entries: uncompressed }]))).toBe(false);
  });

  it('is none when the file is not a TIFF', () => {
    const file = minimalDng(200);
    file.writeUInt16LE(43, 2);
    expect(holds(file)).toBe(false);
    expect(holds(Buffer.from('II*'))).toBe(false);
  });
});

describe('directories laid out to make the reader loop or explode', () => {
  it('stops at a chain that points back at itself', () => {
    expect(holds(buildTiff(SIZE, [preview(8, 8)]))).toBe(false);
  });

  it('stops at a SubIFD that points at its parent or overlaps a directory read before', () => {
    expect(holds(buildTiff(SIZE, [preview(8, 0, [subIfds([8])])]))).toBe(false);
    expect(holds(buildTiff(SIZE, [preview(8, 0, [subIfds([12])])]))).toBe(false);
  });

  it('does not read a directory twice, so a chain that reaches a SubIFD already read ends there', () => {
    const raw = { at: 300, entries: imageEntries([[400, 100]]) };
    expect(holds(buildTiff(SIZE, [preview(8, 200), preview(200, 300), raw]))).toBe(true);
    expect(holds(buildTiff(SIZE, [preview(8, 200, [subIfds([200])]), preview(200, 300), raw]))).toBe(false);
  });

  it('follows 10 SubIFDs of one directory and not an 11th', () => {
    const tree = (rawIndex: number) => {
      const offsets = Array.from({ length: 12 }, (_, index) => 400 + index * 100);
      const children = offsets.map((at, index): TiffDirectorySpec => (index === rawIndex
        ? { at, entries: imageEntries([[3000, 100]]) }
        : preview(at)));
      return buildTiff(SIZE, [preview(8, 0, [subIfds(offsets, 200)]), ...children]);
    };
    expect(holds(tree(9))).toBe(true);
    expect(holds(tree(10))).toBe(false);
  });

  it('follows 10 directories of the chain and not an 11th', () => {
    const chain = (length: number) => Array.from({ length }, (_, index): TiffDirectorySpec => {
      const at = 8 + index * 100;
      return index === length - 1 ? { at, entries: imageEntries([[3000, 100]]) } : preview(at, at + 100);
    });
    expect(holds(buildTiff(SIZE, chain(10)))).toBe(true);
    expect(holds(buildTiff(SIZE, chain(11)))).toBe(false);
  });

  it('nests 5 levels and not a 6th', () => {
    const nested = (levels: number) => Array.from({ length: levels }, (_, index): TiffDirectorySpec => {
      const at = 8 + index * 200;
      return index === levels - 1 ? { at, entries: imageEntries([[3000, 100]]) } : preview(at, 0, [subIfds([at + 200])]);
    });
    expect(holds(buildTiff(SIZE, nested(5)))).toBe(true);
    expect(holds(buildTiff(SIZE, nested(6)))).toBe(false);
  });

  it('reads at most 28 directories in the file', () => {
    const size = 16_384;
    const chain = [8, 1008, 2008];
    const tree = (rawChild: number) => buildTiff(size, chain.flatMap((at, index): TiffDirectorySpec[] => {
      const children = Array.from({ length: 9 }, (_, child) => at + 300 + child * 70);
      return [
        preview(at, chain[index + 1] ?? 0, [subIfds(children, at + 200)]),
        ...children.map((childAt, child) => (index === 2 && child === rawChild ? { at: childAt, entries: imageEntries([[12_000, 100]]) } : preview(childAt))),
      ];
    }));
    // In reading order the third chain directory is the 21st, so its seventh child is the 28th and its eighth the 29th.
    expect(holds(tree(6))).toBe(true);
    expect(holds(tree(7))).toBe(false);
  });

  it('stops at a SubIFD tag that claims a million directories, all of them its parent', () => {
    const offsets = Array.from({ length: 1_000_000 }, () => 8);
    const file = buildTiff(4_100_000, [preview(8, 0, [subIfds(offsets, 200)])]);
    expect(holds(file)).toBe(false);
  });
});
