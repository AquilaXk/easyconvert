import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dngRawImageData, type ImageSize } from '../src/worker/raw-dng-image-data';
import {
  COMPRESSION, PHOTOMETRIC, RAW_SIZE, REDUCED_RESOLUTION, TAG, TYPE, asciiEntry, buildTiff, imageEntries, minimalDng, type TiffDirectorySpec, type TiffEntrySpec,
} from './helpers/dng-builder';
import { rawSamplePath, skipWithoutRawSamples } from './helpers/strict-skip';

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

  it('is refused when an ActiveArea extent is negative or above 65535, which LibRaw keeps in 16 bits, and read up to 65535', () => {
    const withArea = (values: number[]) => buildTiff(SIZE, [{
      at: 8, entries: [...imageEntries([[400, 100]]), { tag: TAG.activeArea, type: TYPE.long, values, at: 200 }],
    }]);
    expect(check(withArea([0, 0, 65_535, 64]), { width: 64, height: 65_535 })).toBe('whole');
    expect(check(withArea([0, 0, 65_536, 64]))).toBe('unreadable-area');
    expect(check(withArea([0, 0, 100, 65_536]))).toBe('unreadable-area');
    expect(check(withArea([100, 0, 50, 64]))).toBe('unreadable-area');
    expect(check(withArea([0, 64, 100, 32]))).toBe('unreadable-area');
    expect(check(withArea([0xffff_ff9c, 0, 100, 64]), { width: 64, height: 100 })).toBe('unreadable-area');
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

const fujiTable = (offset: number): TiffEntrySpec => ({ tag: TAG.fujiTable, type: TYPE.long, values: [offset] });
const cut = (at: number): TiffDirectorySpec => ({ at, entries: imageEntries([[3000, 2000]]) });
const longEntry = (tag: number, value: number): TiffEntrySpec => ({ tag, type: TYPE.long, values: [value] });

describe('a directory reached through tag 0xf000, which LibRaw parses from the offset in its first value', () => {
  it('takes the next place, before the directory the chain lists next', () => {
    const tree = (first: (at: number) => TiffDirectorySpec, second: (at: number) => TiffDirectorySpec) =>
      buildTiff(SIZE, [preview(8, 300, [fujiTable(200)]), first(200), second(300)]);
    expect(check(tree(raw, cut))).toBe('whole');
    expect(check(tree(cut, raw))).toBe('outside-file');
  });

  it('is read where its entry is met among the SubIFDs of its parent', () => {
    const tree = (entries: TiffEntrySpec[]) => buildTiff(SIZE, [preview(8, 0, entries), cut(200), raw(300)]);
    expect(check(tree([fujiTable(200), subIfds([300], 150)]))).toBe('outside-file');
    expect(check(tree([subIfds([300], 150), fujiTable(200)]))).toBe('whole');
  });

  it('does not end the SubIFD list after it, whatever it returns', () => {
    const tree = (fuji: number) => buildTiff(SIZE, [preview(8, 0, [fujiTable(fuji), subIfds([200], 150)]), raw(200)]);
    expect(check(tree(SIZE + 8))).toBe('whole');
    expect(check(tree(0))).toBe('whole');
  });

  it('lists SubIFDs of its own and counts toward the 10 directories, so one that points at its own directory ends', () => {
    expect(check(buildTiff(SIZE, [preview(8, 0, [fujiTable(8)])]))).toBe('no-raw-image');
    const nested = (levels: number) => Array.from({ length: levels }, (_, index): TiffDirectorySpec => {
      const at = 8 + index * 250;
      return index === levels - 1 ? { at, entries: imageEntries([[3900, 100]]) } : preview(at, 0, [fujiTable(at + 250)]);
    });
    expect(check(buildTiff(SIZE, nested(10)))).toBe('whole');
    expect(check(buildTiff(SIZE, nested(11)))).toBe('no-raw-image');
  });

  it('sets the width and height of its directory as ImageWidth and ImageLength do, the entry read last winning', () => {
    const sized = (entries: TiffEntrySpec[]) => buildTiff(SIZE, [{ at: 8, entries }]);
    const strips = imageEntries([[400, 100]]);
    const fuji = [longEntry(TAG.fujiWidth, 32), longEntry(TAG.fujiHeight, 50)];
    const small = { width: 32, height: 50 };
    expect(check(sized([...strips, ...fuji]), small)).toBe('whole');
    expect(check(sized([...strips, ...fuji]))).toBe('dimensions');
    expect(check(sized([...fuji, ...strips]))).toBe('whole');
    expect(check(sized([...fuji, ...strips]), small)).toBe('dimensions');
    const unsized = strips.filter((entry) => entry.tag !== TAG.imageWidth && entry.tag !== TAG.imageLength);
    expect(check(sized([...unsized, ...fuji]), small)).toBe('whole');
  });
});

describe('a Canon DNG with tag 0xf000 in its first directory, as LibRaw chooses the directory it decodes', () => {
  const noSample = skipWithoutRawSamples('dng');
  const DECODED = { width: 960, height: 540 };
  const SAMPLES_PER_PIXEL = 277;
  const NEXT_AFTER_ENTRIES = (entries: number) => 2 + entries * 12;

  function entryAt(file: Buffer, directory: number, tag: number): number {
    const count = file.readUInt16LE(directory);
    for (let index = 0; index < count; index += 1) {
      const at = directory + 2 + index * 12;
      if (file.readUInt16LE(at) === tag) return at;
    }
    throw new Error(`no entry ${tag} in the directory at ${directory}`);
  }

  /** The sample with two copies of its first directory appended: IFD0 points at the first by tag 0xf000 and at the second as its next. */
  function withFujiTable(original: Buffer, edit: (file: Buffer, first: number, second: number) => void): Buffer {
    expect(original.toString('latin1', 0, 2)).toBe('II');
    const count = original.readUInt16LE(8);
    const length = NEXT_AFTER_ENTRIES(count) + 4;
    const padding = original.length % 2;
    const first = original.length + padding;
    const second = first + length;
    const file = Buffer.concat([original, Buffer.alloc(padding), original.subarray(8, 8 + length), original.subarray(8, 8 + length)]);
    file.writeUInt32LE(0, first + NEXT_AFTER_ENTRIES(count));
    file.writeUInt32LE(0, second + NEXT_AFTER_ENTRIES(count));
    file.writeUInt32LE(1, entryAt(file, 8, TAG.newSubfileType) + 8);
    const table = entryAt(file, 8, 50_714);
    file.writeUInt16LE(TAG.fujiTable, table);
    file.writeUInt32LE(first, table + 8);
    file.writeUInt32LE(second, 8 + NEXT_AFTER_ENTRIES(count));
    edit(file, first, second);
    return file;
  }

  const pastEnd = (file: Buffer, directory: number) => {
    const at = entryAt(file, directory, 279) + 8;
    file.writeUInt32LE(file.readUInt32LE(at) + 1000, at);
  };
  const crafted = (edit: (file: Buffer, first: number, second: number) => void) => {
    const source = readFileSync(rawSamplePath('dng'));
    return withFujiTable(source, edit);
  };

  it.skipIf(noSample)('develops the directory 0xf000 names, whose strips are whole, though the next one lists a strip past the end', () => {
    expect(check(crafted((file, _first, second) => pastEnd(file, second)), DECODED)).toBe('whole');
  });

  it.skipIf(noSample)('develops it by its size, not the size of the next directory, which has another width and no ActiveArea', () => {
    const file = crafted((copy, _first, second) => {
      pastEnd(copy, second);
      copy.writeUInt32LE(944, entryAt(copy, second, TAG.imageWidth) + 8);
      copy.writeUInt16LE(0x9999, entryAt(copy, second, TAG.activeArea));
    });
    expect(check(file, DECODED)).toBe('whole');
  });

  it.skipIf(noSample)('refuses the file when the directory 0xf000 names lists a strip past the end, though the next one is whole', () => {
    expect(check(crafted((file, first) => pastEnd(file, first)), DECODED)).toBe('outside-file');
  });

  /**
   * IFD0 made a preview whose tag 0xc61a becomes a tag 0x7250 naming an MRM block, whose TTW block holds a TIFF of one 950 x 530 CFA
   * directory with its strip 100 MB past the end, and the chain going on to a copy of IFD0 as it was. LibRaw develops the nested
   * directory (950 x 530), which a walk that skips the tag would take for the whole 960 x 540 copy trimmed.
   */
  function withMinoltaBlock(original: Buffer): Buffer {
    const u32 = (value: number) => {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32LE(value);
      return bytes;
    };
    const nested = buildTiff(122, [{
      at: 8,
      entries: [
        longEntry(TAG.newSubfileType, 0), longEntry(TAG.imageWidth, 950), longEntry(TAG.imageLength, 530),
        { tag: TAG.bitsPerSample, type: TYPE.short, values: [14] }, { tag: TAG.compression, type: TYPE.short, values: [COMPRESSION.losslessJpeg] },
        { tag: TAG.photometric, type: TYPE.short, values: [PHOTOMETRIC.cfa] }, longEntry(TAG.stripOffsets, 100),
        { tag: SAMPLES_PER_PIXEL, type: TYPE.short, values: [1] }, longEntry(TAG.stripByteCounts, 100_000_000),
      ],
    }]);
    const ttw = Buffer.concat([Buffer.from('\0TTW', 'latin1'), u32(nested.length), nested]);
    const block = Buffer.concat([Buffer.from('\0MRI', 'latin1'), u32(ttw.length + 8), ttw]);
    const count = original.readUInt16LE(8);
    const ifd0 = original.subarray(8, 8 + NEXT_AFTER_ENTRIES(count) + 4);
    const blockAt = original.length + (original.length % 2);
    const copyAt = blockAt + block.length + (block.length % 2);
    const file = Buffer.concat([original, Buffer.alloc(blockAt - original.length), block, Buffer.alloc(copyAt - blockAt - block.length), ifd0]);
    file.writeUInt32LE(0, copyAt + NEXT_AFTER_ENTRIES(count));
    file.writeUInt32LE(1, entryAt(file, 8, TAG.newSubfileType) + 8);
    const minolta = entryAt(file, 8, 50_714);
    file.writeUInt16LE(TAG.sonyMinolta, minolta);
    file.writeUInt16LE(TYPE.undefined, minolta + 2);
    file.writeUInt32LE(block.length, minolta + 4);
    file.writeUInt32LE(blockAt, minolta + 8);
    file.writeUInt32LE(copyAt, 8 + NEXT_AFTER_ENTRIES(count));
    return file;
  }

  it.skipIf(noSample)('refuses the file when IFD0 holds tag 0x7250, whose nested TIFF LibRaw develops in place of the chain', () => {
    expect(check(withMinoltaBlock(readFileSync(rawSamplePath('dng'))), { width: 950, height: 530 })).toBe('unmodelled-layout');
  });
});

const dngVersion = (...bytes: number[]): TiffEntrySpec => ({ tag: TAG.dngVersion, type: TYPE.byte, values: bytes });
const privateData = (): TiffEntrySpec => ({ tag: TAG.dngPrivateData, type: TYPE.byte, values: [0, 0, 0, 0, 0, 0, 0, 0], at: 1000 });
const panasonicFlag = (value: number, count = 4): TiffEntrySpec => ({
  tag: TAG.panasonicFlag, type: TYPE.long, values: Array.from({ length: count }, (_, index) => (index === 0 ? value : 0)), at: 1200,
});
const EXIF_AT = 2000;
const exifPointer = (): TiffEntrySpec => ({ tag: TAG.exifIfd, type: TYPE.long, values: [EXIF_AT] });
const make = (text: string, at = 1400): TiffEntrySpec => asciiEntry(TAG.make, text, at);
const exifDirectory = (tags: number[]): TiffDirectorySpec => ({ at: EXIF_AT, entries: tags.map((tag) => ({ tag, type: TYPE.long, values: [0] })) });
const rawBelow = (entries: TiffEntrySpec[], exifTags: number[] = [TAG.makerNote]) =>
  buildTiff(SIZE, [preview(8, 0, [...entries, subIfds([200], 150)]), raw(200), exifDirectory(exifTags)]);

describe('an entry through which LibRaw reads a directory the walk does not follow', () => {
  it('is Hasselblad tag 0xc51b, which restores the directory count, whatever the make says', () => {
    const entry = longEntry(TAG.hasselblad, 200);
    expect(check(rawBelow([entry]))).toBe('unmodelled-layout');
    expect(check(rawBelow([make('Hasselblad'), entry]))).toBe('unmodelled-layout');
    expect(check(rawBelow([]))).toBe('whole');
  });

  it('is the Hasselblad SubIFD branch, which needs tag 0xc51b before it and so is refused there, while a make alone reads the SubIFDs as any other', () => {
    expect(check(rawBelow([make('Hasselblad')]))).toBe('whole');
    expect(check(rawBelow([make('Hasselblad'), longEntry(TAG.hasselblad, 200)]))).toBe('unmodelled-layout');
  });

  it('is the SubIFD tag of a directory 3872 pixels wide, which the DSLR-A100 branch reads as one offset of raw data', () => {
    const wide = (width: number) => buildTiff(SIZE, [{
      at: 8,
      entries: [...imageEntries([[400, 100]]).map((entry) => (entry.tag === TAG.imageWidth ? { ...entry, values: [width] } : entry)), subIfds([200], 150)],
    }, raw(200)]);
    expect(check(wide(3872), { width: 3872, height: RAW_SIZE.height })).toBe('unmodelled-layout');
    expect(check(wide(3871), { width: 3871, height: RAW_SIZE.height })).toBe('whole');
    expect(check(wide(3873), { width: 3873, height: RAW_SIZE.height })).toBe('whole');
  });

  it('is a tag 0x0001 of 4 values holding a number, which turns LibRaw to its Panasonic tags, and not one of another count or holding 0', () => {
    expect(check(rawBelow([panasonicFlag(1)]))).toBe('unmodelled-layout');
    expect(check(rawBelow([panasonicFlag(0x0100_0000)]))).toBe('unmodelled-layout');
    expect(check(rawBelow([panasonicFlag(0)]))).toBe('whole');
    expect(check(rawBelow([panasonicFlag(1, 2)]))).toBe('whole');
    expect(check(rawBelow([panasonicFlag(1, 5)]))).toBe('whole');
    const inRaw = buildTiff(SIZE, [preview(8, 0, [subIfds([200], 150)]), raw(200, [panasonicFlag(1)])]);
    expect(check(inRaw)).toBe('unmodelled-layout');
  });

  it('is tag 0x7250 in any directory, which LibRaw reads with parse_minolta, whose TTW block parses a TIFF', () => {
    const minolta = longEntry(TAG.sonyMinolta, 0);
    expect(check(rawBelow([minolta]))).toBe('unmodelled-layout');
    expect(check(buildTiff(SIZE, [preview(8, 0, [subIfds([200], 150)]), raw(200, [minolta])]))).toBe('unmodelled-layout');
    expect(check(buildTiff(SIZE, [preview(8, 0, [fujiTable(300)]), preview(300, 0, [minolta]), raw(500)]))).toBe('unmodelled-layout');
  });

  it('is DNGPrivateData when no DNGVersion has been read before it, and not after a DNGVersion that is not zero', () => {
    expect(check(rawBelow([privateData()]))).toBe('unmodelled-layout');
    expect(check(rawBelow([dngVersion(0, 0, 0, 0), privateData()]))).toBe('unmodelled-layout');
    expect(check(rawBelow([privateData(), dngVersion(1, 4, 0, 0)]))).toBe('unmodelled-layout');
    expect(check(rawBelow([dngVersion(1, 4, 0, 0), privateData()]))).toBe('whole');
    expect(check(rawBelow([dngVersion(0, 0, 0, 1), privateData()]))).toBe('whole');
    expect(check(rawBelow([dngVersion(0, 0, 0, 0), dngVersion(1, 4, 0, 0), privateData()]))).toBe('whole');
    expect(check(rawBelow([dngVersion(1, 4, 0, 0), dngVersion(0, 0, 0, 0), privateData()]))).toBe('unmodelled-layout');
  });

  it('is the Nikon makernote, reached from DNGPrivateData or from an EXIF directory that lists tag 0x927c, while the make is NIKON', () => {
    const nikon = make('NIKON CORPORATION');
    expect(check(rawBelow([nikon, exifPointer()]))).toBe('unmodelled-layout');
    expect(check(rawBelow([nikon, exifPointer()], [0x9000, TAG.makerNote]))).toBe('unmodelled-layout');
    expect(check(rawBelow([nikon, dngVersion(1, 4, 0, 0), privateData()], []))).toBe('unmodelled-layout');
    expect(check(rawBelow([nikon, exifPointer()], [0x9000, 0x9003]))).toBe('whole');
    expect(check(rawBelow([nikon, exifPointer()], []))).toBe('whole');
    expect(check(rawBelow([nikon]))).toBe('whole');
    expect(check(rawBelow([make('Canon'), exifPointer()]))).toBe('whole');
    expect(check(rawBelow([exifPointer()]))).toBe('whole');
    expect(check(rawBelow([exifPointer(), nikon]))).toBe('whole');
  });

  it('takes the Make read last, which LibRaw writes over the make, and refuses after any UniqueCameraModel of NIKON, which LibRaw copies only while no Model is read', () => {
    const unique = (text: string) => asciiEntry(TAG.uniqueCameraModel, text, 1600);
    expect(check(rawBelow([make('NIKON'), make('Canon', 1440), exifPointer()]))).toBe('whole');
    expect(check(rawBelow([make('Canon'), make('NIKON', 1440), exifPointer()]))).toBe('unmodelled-layout');
    expect(check(rawBelow([unique('NIKON D80'), make('Canon'), exifPointer()]))).toBe('whole');
    expect(check(rawBelow([unique('NIKON D80'), exifPointer()]))).toBe('unmodelled-layout');
    expect(check(rawBelow([make('NIKON'), unique('Canon EOS'), exifPointer()]))).toBe('unmodelled-layout');
    expect(check(rawBelow([make('Canon'), unique('Canon EOS'), exifPointer()]))).toBe('whole');
  });

  it('reads at most 65535 EXIF entries in all, refusing a file whose EXIF tags list more, as a NIKON file would', () => {
    const size = 1_000_000;
    const exif = (at: number): TiffEntrySpec => ({ tag: TAG.exifIfd, type: TYPE.long, values: [at] });
    const claims = (at: number, count: number) => (file: Buffer) => file.writeUInt16LE(count, at);
    const tree = (pointers: number[], edits: Array<(file: Buffer) => void>) => {
      const file = buildTiff(size, [preview(8, 0, [make('NIKON'), ...pointers.map(exif), subIfds([200], 150)]), raw(200)]);
      edits.forEach((edit) => edit(file));
      return file;
    };
    expect(check(tree([10_000], [claims(10_000, 65_535)]))).toBe('whole');
    expect(check(tree([10_000, 10_000], [claims(10_000, 65_535)]))).toBe('unmodelled-layout');
    expect(check(tree([10_000, 900_000], [claims(10_000, 65_534), claims(900_000, 1)]))).toBe('whole');
    expect(check(tree([10_000, 900_000], [claims(10_000, 65_534), claims(900_000, 2)]))).toBe('unmodelled-layout');
  });

  it.each([[TAG.stripOffsets], [513], [0xf007]])('is the JPEG stream at the offset of tag %i in a directory with no BitsPerSample yet, which LibRaw reads as a TIFF', (tag) => {
    const bitsPerSample: TiffEntrySpec = { tag: TAG.bitsPerSample, type: TYPE.short, values: [12] };
    const strips = imageEntries([[tag === TAG.stripOffsets ? 300 : 400, 100]]);
    const extra = tag === TAG.stripOffsets ? [] : [longEntry(tag, 300)];
    const probe = (entries: TiffEntrySpec[], jpeg: boolean): string => {
      const file = buildTiff(SIZE, [{ at: 8, entries }]);
      if (jpeg) file.writeUInt16BE(0xffd8, 300);
      return check(file);
    };
    expect(probe([...strips, ...extra], true)).toBe('unmodelled-layout');
    expect(probe([...strips, ...extra], false)).toBe('whole');
    expect(probe([bitsPerSample, ...strips, ...extra], true)).toBe('whole');
    expect(probe([...strips, ...extra, bitsPerSample], true)).toBe('unmodelled-layout');
    expect(probe([{ ...bitsPerSample, tag: TAG.fujiBitsPerSample }, ...strips, ...extra], true)).toBe('whole');
    expect(probe([{ ...bitsPerSample, values: [0] }, ...strips, ...extra], true)).toBe('unmodelled-layout');
  });

  it('is a Phase One marker in the first 32 bytes, which runs a second parser before the TIFF one', () => {
    const junk = (value: number) => longEntry(0x8000, value);
    const marked = (...junks: number[]) => buildTiff(SIZE, [{ at: 8, entries: [...junks.map(junk), ...imageEntries([[400, 100]])] }]);
    expect(check(marked(0x4949_4949))).toBe('unmodelled-layout');
    expect(check(marked(0x4d4d_4d4d))).toBe('unmodelled-layout');
    expect(check(marked(0x4949_494d))).toBe('whole');
    expect(check(marked(0, 0, 0x4949_4949))).toBe('whole');
  });

  it('is HEAPCCDR at byte 6, where identify parses the file as a CIFF and reads none of its TIFF directories', () => {
    const at = 0x4845;
    const file = (signature: string) => {
      const tiff = buildTiff(at + 200, [{ at, entries: imageEntries([[3000, 100]]) }], { little: false });
      tiff.write(signature, 8, 'latin1');
      return tiff;
    };
    expect(file('APCCDR').toString('latin1', 6, 14)).toBe('HEAPCCDR');
    expect(check(file('APCCDR'))).toBe('unmodelled-layout');
    expect(check(file('APCCDS'))).toBe('whole');
  });
});

describe('a DNG is a file whose directories carry a DNGVersion, when the check is asked for it', () => {
  function checkVersioned(file: Buffer): string {
    written += 1;
    const filePath = path.join(directory, `versioned-${written}.dng`);
    writeFileSync(filePath, file);
    return dngRawImageData(filePath, RAW_SIZE, { requireDngVersion: true });
  }
  const withVersion = (...bytes: number[]) => buildTiff(SIZE, [{ at: 8, entries: [...imageEntries([[400, 100]]), dngVersion(...bytes)] }]);

  it('takes a version in IFD0, in either byte order, and any version that is not four zero bytes', () => {
    expect(checkVersioned(withVersion(1, 4, 0, 0))).toBe('whole');
    expect(checkVersioned(withVersion(0, 0, 0, 1))).toBe('whole');
    expect(checkVersioned(buildTiff(SIZE, [{ at: 8, entries: [...imageEntries([[400, 100]]), dngVersion(1, 4, 0, 0)] }], { little: false }))).toBe('whole');
  });

  it('takes a version that sits in a SubIFD, as `dng_version` of LibRaw is kept across the directories it reads', () => {
    const file = buildTiff(SIZE, [preview(8, 0, [subIfds([200], 150)]), { at: 200, entries: [...imageEntries([[400, 100]]), dngVersion(1, 6, 0, 0)] }]);
    expect(checkVersioned(file)).toBe('whole');
  });

  it.each([
    ['no tag', imageEntries([[400, 100]])],
    ['four zero bytes', [...imageEntries([[400, 100]]), dngVersion(0, 0, 0, 0)]],
    ['a version zeroed by a later tag, as LibRaw shifts the last four bytes in', [...imageEntries([[400, 100]]), dngVersion(1, 4, 0, 0), dngVersion(0, 0, 0, 0)]],
  ])('refuses a file with %s, which the decoder does not read as a DNG', (_, entries) => {
    expect(checkVersioned(buildTiff(SIZE, [{ at: 8, entries }]))).toBe('no-dng-version');
  });

  it('leaves the other findings to a file that has no version only when the check is not asked for', () => {
    expect(check(buildTiff(SIZE, [{ at: 8, entries: imageEntries([[400, 100]]) }]))).toBe('whole');
    expect(checkVersioned(buildTiff(SIZE, [{ at: 8, entries: imageEntries([[400, 100]]) }]))).toBe('no-dng-version');
  });
});
