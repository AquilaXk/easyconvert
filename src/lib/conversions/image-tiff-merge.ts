import { ConversionFailedError } from '../types';

/**
 * Joins single-page classic TIFF files (as libvips writes them) into one multi-page TIFF without touching
 * the compressed pixel data: every file is appended whole and the file offsets inside its directory are
 * shifted to where it landed, then the directories are chained through their "next IFD" pointers.
 */

const TIFF_MAGIC = 42;
const HEADER_BYTES = 8;
const ENTRY_BYTES = 12;
const COUNT_BYTES = 2;
const NEXT_POINTER_BYTES = 4;
const INLINE_VALUE_BYTES = 4;
const WORD_ALIGNMENT = 2;
const UINT32_LIMIT = 0xffffffff;

const TAG_STRIP_OFFSETS = 273;
const TAG_TILE_OFFSETS = 324;
/** Tags whose value is the offset of a nested directory: not produced for the pages this joins. */
const NESTED_DIRECTORY_TAGS: ReadonlySet<number> = new Set([330, 34665, 34853, 40965]);

const TYPE_SIZE: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
const TYPE_LONG = 4;
const TYPE_SHORT = 3;

function fail(detail: string): ConversionFailedError {
  return new ConversionFailedError(`Cannot join TIFF pages: ${detail}`);
}

/** Shifts every file offset of the directory at `ifd` inside `page` (already placed at `base`) by `base`. */
function relocateDirectory(page: Buffer, ifd: number, base: number): number {
  if (ifd < HEADER_BYTES || ifd + COUNT_BYTES > page.length) throw fail('a page directory lies outside its file');
  const count = page.readUInt16LE(ifd);
  const entriesEnd = ifd + COUNT_BYTES + count * ENTRY_BYTES;
  if (entriesEnd + NEXT_POINTER_BYTES > page.length) throw fail('a page directory runs past its file');
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + COUNT_BYTES + index * ENTRY_BYTES;
    const tag = page.readUInt16LE(entry);
    const type = page.readUInt16LE(entry + 2);
    const valueCount = page.readUInt32LE(entry + 4);
    const size = (TYPE_SIZE[type] ?? 0) * valueCount;
    if (NESTED_DIRECTORY_TAGS.has(tag)) throw fail(`tag ${tag} points to a nested directory`);
    const isOffsetTable = tag === TAG_STRIP_OFFSETS || tag === TAG_TILE_OFFSETS;
    if (size > INLINE_VALUE_BYTES) {
      const valueAt = page.readUInt32LE(entry + 8);
      if (valueAt + size > page.length) throw fail(`tag ${tag} points outside its file`);
      if (isOffsetTable) shiftOffsetTable(page, valueAt, type, valueCount, base);
      page.writeUInt32LE(valueAt + base, entry + 8);
    } else if (isOffsetTable) {
      shiftOffsetTable(page, entry + 8, type, valueCount, base);
    }
  }
  return entriesEnd;
}

function shiftOffsetTable(page: Buffer, at: number, type: number, count: number, base: number): void {
  if (type !== TYPE_LONG && type !== TYPE_SHORT) throw fail('strip offsets are neither SHORT nor LONG');
  const width = TYPE_SIZE[type];
  for (let index = 0; index < count; index += 1) {
    const position = at + index * width;
    const value = type === TYPE_LONG ? page.readUInt32LE(position) : page.readUInt16LE(position);
    const shifted = value + base;
    if (shifted > UINT32_LIMIT || (type === TYPE_SHORT && shifted > 0xffff)) throw fail('the joined file is too large for classic TIFF offsets');
    if (type === TYPE_LONG) page.writeUInt32LE(shifted, position);
    else page.writeUInt16LE(shifted, position);
  }
}

/** One multi-page TIFF made of `pages`, each a complete single-page little-endian classic TIFF. */
export function joinTiffPages(pages: Buffer[]): Buffer {
  if (pages.length === 0) throw fail('there are no pages');
  const parts: Buffer[] = [];
  const chain: Array<{ ifdAt: number; nextPointerAt: number }> = [];
  let size = 0;
  for (const original of pages) {
    if (original.length < HEADER_BYTES || original.toString('latin1', 0, 2) !== 'II' || original.readUInt16LE(2) !== TIFF_MAGIC) {
      throw fail('a page is not a little-endian classic TIFF');
    }
    const page = Buffer.from(original);
    const base = size;
    const ifd = page.readUInt32LE(4);
    const entriesEnd = relocateDirectory(page, ifd, base);
    if (page.readUInt32LE(entriesEnd) !== 0) throw fail('a page already has a following directory');
    chain.push({ ifdAt: base + ifd, nextPointerAt: base + entriesEnd });
    parts.push(page);
    size += page.length;
    if (size % WORD_ALIGNMENT !== 0) {
      parts.push(Buffer.alloc(1));
      size += 1;
    }
    if (size > UINT32_LIMIT) throw fail('the joined file is too large for classic TIFF offsets');
  }
  const joined = Buffer.concat(parts);
  for (let index = 1; index < chain.length; index += 1) {
    joined.writeUInt32LE(chain[index].ifdAt, chain[index - 1].nextPointerAt);
  }
  return joined;
}
