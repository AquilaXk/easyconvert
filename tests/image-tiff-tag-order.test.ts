import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { withSortedTiffTags } from '../src/lib/conversions/image-tiff-directories';
import { decodeRgba } from './helpers/image-pixels';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * A TIFF directory whose tags are not in ascending order, or repeat one (TIFF 6.0 section 2: "The entries in an IFD must be
 * sorted in ascending order by tag"; libtiff warns "tags are not sorted in ascending order" for both), was refused whole
 * because the image library treats every decoder warning as a failure (#783: wc-psalm-44.tiff, which repeats the Orientation
 * entry with the same value in its first directory). The directory is put in order and the repeat of an identical entry is
 * dropped before the file is read; the warning level stays where it is, so every other warning, and every error, still refuses.
 *
 * The expected pixels of the real file are the ones Pillow 11.1.0 decodes from its two pages (`Image.seek(n)`, `python3 -I`, Debian 13).
 * A TIFF of several pages converts to a ZIP with one image per page.
 */

const PSALM = 'wc-psalm-44.tiff';
/**
 * Page 1 carries an embedded profile ("Generic RGB Profile", tag 34675) that the converter applies to reach sRGB; the reference is
 * Pillow's `ImageCms.profileToProfile(page, embedded profile, sRGB)` (littlecms 2), read at these pixels. Two libraries round the
 * transform alike to within one level of a sample. Page 2 has no profile, so its digest is the raw decode.
 */
const PSALM_FIRST_PAGE = {
  width: 398,
  height: 259,
  pixels: [
    { x: 0, y: 0, rgb: [255, 244, 211] },
    { x: 397, y: 258, rgb: [255, 252, 223] },
    { x: 199, y: 129, rgb: [255, 244, 216] },
    { x: 50, y: 200, rgb: [255, 245, 223] },
    { x: 300, y: 40, rgb: [57, 41, 0] },
    { x: 120, y: 90, rgb: [144, 125, 86] },
    { x: 250, y: 150, rgb: [249, 249, 221] },
    { x: 75, y: 30, rgb: [243, 225, 187] },
    { x: 350, y: 220, rgb: [55, 33, 0] },
    { x: 10, y: 128, rgb: [191, 171, 138] },
  ],
};
const PSALM_SECOND_PAGE = { width: 160, height: 104, digest: '3443100715c7ecf504cca593f2161fd5aff4aefc949165a8f82608651dbe977e' };
const PROFILE_ROUNDING_TOLERANCE = 1;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const TIFF_HEADER_BYTES = 8;
const COUNT_BYTES = 2;
const ENTRY_BYTES = 12;
const TAG_ORIENTATION = 274;
const TYPE_SHORT = 3;

/** An uncompressed 4 x 2 picture: the first row red, the second row green, as libvips writes it (classic TIFF, little-endian, Orientation 1 among its 15 tags). */
async function twoRowTiff(): Promise<Buffer> {
  const rows = Buffer.from([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0]);
  return sharp(rows, { raw: { width: 4, height: 2, channels: 3 } }).tiff({ compression: 'none' }).toBuffer();
}
const TWO_ROWS = [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255];

/** Offsets of the first directory of a little-endian classic TIFF: where its entries start and how many it has. */
function firstDirectory(tiff: Buffer): { entriesAt: number; count: number } {
  expect(tiff.toString('ascii', 0, 2)).toBe('II');
  const at = tiff.readUInt32LE(4);
  expect(at).toBeGreaterThanOrEqual(TIFF_HEADER_BYTES);
  return { entriesAt: at + COUNT_BYTES, count: tiff.readUInt16LE(at) };
}

function entriesOf(tiff: Buffer): Buffer[] {
  const { entriesAt, count } = firstDirectory(tiff);
  return Array.from({ length: count }, (_, index) => tiff.subarray(entriesAt + index * ENTRY_BYTES, entriesAt + (index + 1) * ENTRY_BYTES));
}

const tagsOf = (tiff: Buffer): number[] => entriesOf(tiff).map((entry) => entry.readUInt16LE(0));

/** The same file with the entries of its first directory in the order `reorder` gives (the entry bytes and every offset stay as they are). */
function withEntriesReordered(tiff: Buffer, reorder: (entries: Buffer[]) => Buffer[]): Buffer {
  const { entriesAt, count } = firstDirectory(tiff);
  const reordered = reorder(entriesOf(tiff).map((entry) => Buffer.from(entry)));
  expect(reordered.length).toBe(count);
  const copy = Buffer.from(tiff);
  reordered.forEach((entry, index) => entry.copy(copy, entriesAt + index * ENTRY_BYTES));
  return copy;
}

const orientationEntry = (value: number): Buffer => {
  const entry = Buffer.alloc(ENTRY_BYTES);
  entry.writeUInt16LE(TAG_ORIENTATION, 0);
  entry.writeUInt16LE(TYPE_SHORT, 2);
  entry.writeUInt32LE(1, 4);
  entry.writeUInt16LE(value, 8);
  return entry;
};

/** The file with one more entry in its first directory, which grows by 12 bytes: the directory moves to the end of the file, where it has room. */
function withEntryAppended(tiff: Buffer, entry: Buffer): Buffer {
  const { entriesAt, count } = firstDirectory(tiff);
  const entries = entriesOf(tiff);
  const next = tiff.readUInt32LE(entriesAt + count * ENTRY_BYTES);
  const moved = Buffer.concat([Buffer.from([0, 0]), ...entries, entry, Buffer.alloc(4)]);
  moved.writeUInt16LE(count + 1, 0);
  moved.writeUInt32LE(next, moved.length - 4);
  const copy = Buffer.concat([tiff, moved]);
  copy.writeUInt32LE(tiff.length, 4);
  return copy;
}

/** The files of the ZIP a multi-page TIFF converts to (one image per page, named `<name>-p001.<extension>`), by name. */
async function pagesOf(result: Buffer): Promise<Map<string, Buffer>> {
  const zip = await JSZip.loadAsync(result);
  return new Map(await Promise.all(Object.keys(zip.files).sort().map(async (name) => [name, await zip.files[name].async('nodebuffer')] as const)));
}

describe('the real TIFF whose first directory repeats a tag', () => {
  it('converts both pages to PNG with the pixels Pillow decodes', { timeout: 60_000 }, async (ctx) => {
    const sample = await requireRealworldSample(ctx, PSALM);
    const pages = await pagesOf((await dispatchConversion(sample.bytes, 'tiff', 'png', {}, PSALM)).buffer);
    expect([...pages.keys()]).toEqual(['wc-psalm-44-p001.png', 'wc-psalm-44-p002.png']);
    const [first, second] = await Promise.all([...pages.values()].map((png) => decodeRgba(png)));
    expect([first.width, first.height]).toEqual([PSALM_FIRST_PAGE.width, PSALM_FIRST_PAGE.height]);
    for (const { x, y, rgb } of PSALM_FIRST_PAGE.pixels) {
      const at = (y * first.width + x) * 4;
      rgb.forEach((expected, channel) => expect(Math.abs(first.data[at + channel] - expected)).toBeLessThanOrEqual(PROFILE_ROUNDING_TOLERANCE));
    }
    expect({ width: second.width, height: second.height, digest: sha256(second.data) }).toEqual(PSALM_SECOND_PAGE);
  });

  it.for([
    ['jpg', 'JPEG', 0xffd8],
    ['ico', 'ICO', 0x0000],
    ['odd', 'ZIP', 0x504b],
    ['ps', 'PS', 0x2521],
  ] as const)('converts both pages to %s', { timeout: 60_000 }, async ([target, , signature], ctx) => {
    const sample = await requireRealworldSample(ctx, PSALM);
    const pages = await pagesOf((await dispatchConversion(sample.bytes, 'tiff', target, {}, PSALM)).buffer);
    expect([...pages.keys()]).toEqual([`wc-psalm-44-p001.${target}`, `wc-psalm-44-p002.${target}`]);
    expect([...pages.values()].map((page) => page.readUInt16BE(0))).toEqual([signature, signature]);
  });

  it('is still refused when it is cut inside its pixel data', { timeout: 60_000 }, async (ctx) => {
    const sample = await requireRealworldSample(ctx, PSALM);
    const cut = sample.bytes.subarray(0, Math.floor(sample.bytes.length / 2));
    await expect(dispatchConversion(cut, 'tiff', 'png', {}, PSALM)).rejects.toMatchObject({ name: 'ConversionFailedError' });
  });
});

describe('a TIFF directory put in order before the file is read', () => {
  it('converts a directory written in descending tag order to the pixels of the same picture in order', async () => {
    const ordered = await twoRowTiff();
    const descending = withEntriesReordered(ordered, (entries) => [...entries].reverse());
    expect(tagsOf(descending)).toEqual([...tagsOf(ordered)].reverse());
    const decoded = await decodeRgba((await dispatchConversion(descending, 'tif', 'png', {}, 'rows.tif')).buffer);
    expect([decoded.width, decoded.height, ...decoded.data]).toEqual([4, 2, ...TWO_ROWS]);
  });

  it('converts a directory that repeats an entry with the same value', async () => {
    const repeated = withEntryAppended(await twoRowTiff(), orientationEntry(1));
    const tags = tagsOf(repeated);
    expect(tags.filter((tag) => tag === TAG_ORIENTATION)).toHaveLength(2);
    const decoded = await decodeRgba((await dispatchConversion(repeated, 'tiff', 'png', {}, 'rows.tiff')).buffer);
    expect([decoded.width, decoded.height, ...decoded.data]).toEqual([4, 2, ...TWO_ROWS]);
  });

  it('still refuses a directory that gives one tag two values, because it cannot tell which one is meant', async () => {
    const conflicting = withEntryAppended(await twoRowTiff(), orientationEntry(6));
    await expect(dispatchConversion(conflicting, 'tiff', 'png', {}, 'rows.tiff')).rejects.toMatchObject({ name: 'ConversionFailedError' });
  });

  it('still refuses a file whose pixel data is cut short, in order or not', async () => {
    const descending = withEntriesReordered(await twoRowTiff(), (entries) => [...entries].reverse());
    const cut = descending.subarray(0, TIFF_HEADER_BYTES + 6);
    await expect(dispatchConversion(cut, 'tif', 'png', {}, 'rows.tif')).rejects.toMatchObject({ name: 'ConversionFailedError' });
  });
});

describe('withSortedTiffTags', () => {
  it('returns the same bytes, not a copy, for a directory that is in order and has no repeat', async () => {
    const ordered = await twoRowTiff();
    expect(withSortedTiffTags(ordered)).toBe(ordered);
  });

  it('puts the entries in ascending order, keeps each entry whole and leaves the rest of the file as it was', async () => {
    const ordered = await twoRowTiff();
    const shuffled = withEntriesReordered(ordered, (entries) => [...entries].reverse());
    const repaired = withSortedTiffTags(shuffled);
    expect(repaired).toEqual(ordered);
    expect(repaired).not.toBe(shuffled);
    expect(tagsOf(shuffled)).not.toEqual(tagsOf(ordered));
  });

  it('drops the second of two identical entries and keeps the directory chain intact', async () => {
    const ordered = await twoRowTiff();
    const repaired = withSortedTiffTags(withEntryAppended(ordered, orientationEntry(1)));
    const tags = tagsOf(repaired);
    expect(tags).toEqual([...new Set(tags)].sort((a, b) => a - b));
    expect(tags).toContain(TAG_ORIENTATION);
    const { entriesAt, count } = firstDirectory(repaired);
    expect(repaired.readUInt32LE(entriesAt + count * ENTRY_BYTES)).toBe(0);
  });

  it('keeps both entries of a repeated tag whose values differ', async () => {
    const conflicting = withEntryAppended(await twoRowTiff(), orientationEntry(6));
    const repaired = withSortedTiffTags(conflicting);
    expect(tagsOf(repaired).filter((tag) => tag === TAG_ORIENTATION)).toHaveLength(2);
  });

  it.each([
    ['bytes that are no TIFF', Buffer.from('this is not a tiff file at all')],
    ['an empty buffer', Buffer.alloc(0)],
  ])('returns %s as they are', (_label, bytes) => {
    expect(withSortedTiffTags(bytes)).toBe(bytes);
  });
});
