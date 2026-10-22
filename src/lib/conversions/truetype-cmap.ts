/**
 * The Unicode `cmap` of a TrueType program (OpenType specification, chapters `cmap` and `maxp`), read from untrusted
 * bytes: the program a PDF embeds for a composite font. Only what a text reader needs is read: the glyph count, and one
 * Unicode subtable in format 4, 6 or 12.
 *
 * Every offset and count is checked against the bytes it points into before it is followed, so the work is bounded by the
 * size of the program: a table outside the bytes, encoding records that do not fit the table, segments or groups out of
 * order or overlapping (which the specification forbids) make the subtable, or the font, unreadable, and the result is
 * null. Nothing here throws on malformed input.
 */

/** What the cmap says about each glyph and each character of the Basic Multilingual Plane. */
export interface UnicodeCmap {
  /** For each glyph id below the font's glyph count, the lowest code point of text the cmap maps to it, or 0 for none. */
  readonly codePointOfGlyph: Uint32Array;
  /** For each code point of the Basic Multilingual Plane, the glyph id the cmap maps it to, or 0 for none. */
  readonly glyphOfBmpCodePoint: Uint16Array;
}

const SFNT_HEADER_BYTES = 12;
const TABLE_RECORD_BYTES = 16;
const CMAP_HEADER_BYTES = 4;
const ENCODING_RECORD_BYTES = 8;
const MAXP_GLYPH_COUNT_OFFSET = 4;
const BMP_SIZE = 0x10000;
const MAX_CODE_POINT = 0x10ffff;
const FORMAT4_HEADER_BYTES = 14;
const FORMAT6_HEADER_BYTES = 10;
const FORMAT12_HEADER_BYTES = 16;
const FORMAT12_GROUP_BYTES = 12;
const PLATFORM_UNICODE = 0;
const PLATFORM_WINDOWS = 3;
const WINDOWS_UNICODE_BMP = 1;
const WINDOWS_UNICODE_FULL = 10;

/** Formats in the order a reader prefers them: full Unicode first. */
const FORMAT_PREFERENCE = [12, 4, 6];

/** C0 and C1 controls, surrogates, private use, noncharacters and U+FFFD: code points that are no text of a glyph. */
function isTextCodePoint(codePoint: number): boolean {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return false;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  if (codePoint >= 0xe000 && codePoint <= 0xf8ff) return false;
  if (codePoint >= 0xf0000) return false;
  if (codePoint >= 0xfdd0 && codePoint <= 0xfdef) return false;
  return (codePoint & 0xfffe) !== 0xfffe && codePoint !== 0xfffd;
}

class Bytes {
  constructor(private readonly data: Uint8Array) {}

  get length(): number {
    return this.data.length;
  }

  /** Whether `count` bytes from `offset` lie within `[start, end)` and within the data. */
  fits(offset: number, count: number, start = 0, end = this.data.length): boolean {
    return Number.isSafeInteger(offset) && offset >= start && count >= 0 && offset + count <= Math.min(end, this.data.length);
  }

  /** The four Latin-1 characters of a table tag at `offset`. */
  tag(offset: number): string {
    return String.fromCharCode(this.data[offset], this.data[offset + 1], this.data[offset + 2], this.data[offset + 3]);
  }

  u16(offset: number): number {
    return (this.data[offset] << 8) | this.data[offset + 1];
  }

  u32(offset: number): number {
    return this.u16(offset) * 0x10000 + this.u16(offset + 2);
  }
}

interface Span {
  start: number;
  end: number;
}

/** Collects the pairs a subtable maps, in increasing code point order. */
class Mapping {
  readonly codePointOfGlyph: Uint32Array;
  readonly glyphOfBmpCodePoint = new Uint16Array(BMP_SIZE);

  constructor(readonly glyphCount: number) {
    this.codePointOfGlyph = new Uint32Array(glyphCount);
  }

  add(codePoint: number, glyph: number): void {
    if (glyph === 0 || glyph >= this.glyphCount) return;
    if (codePoint < BMP_SIZE) this.glyphOfBmpCodePoint[codePoint] = glyph;
    if (this.codePointOfGlyph[glyph] === 0 && isTextCodePoint(codePoint)) this.codePointOfGlyph[glyph] = codePoint;
  }
}

function tableSpan(bytes: Bytes, tag: string): Span | null {
  if (!bytes.fits(0, SFNT_HEADER_BYTES)) return null;
  const count = bytes.u16(4);
  if (!bytes.fits(SFNT_HEADER_BYTES, count * TABLE_RECORD_BYTES)) return null;
  for (let index = 0; index < count; index++) {
    const record = SFNT_HEADER_BYTES + index * TABLE_RECORD_BYTES;
    if (bytes.tag(record) === tag) {
      const start = bytes.u32(record + 8);
      const length = bytes.u32(record + 12);
      return bytes.fits(start, length) ? { start, end: start + length } : null;
    }
  }
  return null;
}

function glyphCountOf(bytes: Bytes): number | null {
  const maxp = tableSpan(bytes, 'maxp');
  if (maxp === null || !bytes.fits(maxp.start + MAXP_GLYPH_COUNT_OFFSET, 2, maxp.start, maxp.end)) return null;
  return bytes.u16(maxp.start + MAXP_GLYPH_COUNT_OFFSET);
}

function readFormat4(bytes: Bytes, at: number, table: Span, mapping: Mapping): boolean {
  if (!bytes.fits(at, FORMAT4_HEADER_BYTES, table.start, table.end)) return false;
  const segments = bytes.u16(at + 6) / 2;
  const ends = at + FORMAT4_HEADER_BYTES;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  if (!Number.isInteger(segments) || segments === 0 || !bytes.fits(ends, segments * 8 + 2, table.start, table.end)) return false;
  let previousEnd = -1;
  for (let segment = 0; segment < segments; segment++) {
    const start = bytes.u16(starts + segment * 2);
    const end = bytes.u16(ends + segment * 2);
    if (start > end || start <= previousEnd) return false;
    previousEnd = end;
  }
  for (let segment = 0; segment < segments; segment++) {
    const start = bytes.u16(starts + segment * 2);
    const end = bytes.u16(ends + segment * 2);
    const delta = bytes.u16(deltas + segment * 2);
    const rangeOffsetAt = rangeOffsets + segment * 2;
    const rangeOffset = bytes.u16(rangeOffsetAt);
    for (let code = start; code <= end; code++) {
      if (rangeOffset === 0) {
        mapping.add(code, (code + delta) & 0xffff);
        continue;
      }
      const glyphAt = rangeOffsetAt + rangeOffset + (code - start) * 2;
      if (!bytes.fits(glyphAt, 2, table.start, table.end)) return false;
      const glyph = bytes.u16(glyphAt);
      if (glyph !== 0) mapping.add(code, (glyph + delta) & 0xffff);
    }
  }
  return true;
}

function readFormat6(bytes: Bytes, at: number, table: Span, mapping: Mapping): boolean {
  if (!bytes.fits(at, FORMAT6_HEADER_BYTES, table.start, table.end)) return false;
  const first = bytes.u16(at + 6);
  const count = bytes.u16(at + 8);
  if (first + count > BMP_SIZE || !bytes.fits(at + FORMAT6_HEADER_BYTES, count * 2, table.start, table.end)) return false;
  for (let index = 0; index < count; index++) mapping.add(first + index, bytes.u16(at + FORMAT6_HEADER_BYTES + index * 2));
  return true;
}

function readFormat12(bytes: Bytes, at: number, table: Span, mapping: Mapping): boolean {
  if (!bytes.fits(at, FORMAT12_HEADER_BYTES, table.start, table.end)) return false;
  const groups = bytes.u32(at + 12);
  const first = at + FORMAT12_HEADER_BYTES;
  if (!bytes.fits(first, groups * FORMAT12_GROUP_BYTES, table.start, table.end)) return false;
  let previousEnd = -1;
  for (let group = 0; group < groups; group++) {
    const start = bytes.u32(first + group * FORMAT12_GROUP_BYTES);
    const end = bytes.u32(first + group * FORMAT12_GROUP_BYTES + 4);
    if (start > end || end > MAX_CODE_POINT || start <= previousEnd) return false;
    previousEnd = end;
  }
  for (let group = 0; group < groups; group++) {
    const start = bytes.u32(first + group * FORMAT12_GROUP_BYTES);
    const end = bytes.u32(first + group * FORMAT12_GROUP_BYTES + 4);
    const startGlyph = bytes.u32(first + group * FORMAT12_GROUP_BYTES + 8);
    // A group maps its code points to consecutive glyphs, so only the ones below the glyph count are read.
    const last = Math.min(end, start + Math.max(0, mapping.glyphCount - 1 - startGlyph));
    for (let code = start; code <= last; code++) mapping.add(code, startGlyph + (code - start));
  }
  return true;
}

const SUBTABLE_READERS: Record<number, (bytes: Bytes, at: number, table: Span, mapping: Mapping) => boolean> = {
  4: readFormat4,
  6: readFormat6,
  12: readFormat12,
};

function isUnicodeEncoding(platform: number, encoding: number): boolean {
  return platform === PLATFORM_UNICODE || (platform === PLATFORM_WINDOWS && (encoding === WINDOWS_UNICODE_BMP || encoding === WINDOWS_UNICODE_FULL));
}

/** Offsets of the Unicode subtables, best format first; null when the encoding records do not fit the table. */
function unicodeSubtables(bytes: Bytes, cmap: Span): number[] | null {
  if (!bytes.fits(cmap.start, CMAP_HEADER_BYTES, cmap.start, cmap.end)) return null;
  const records = bytes.u16(cmap.start + 2);
  if (!bytes.fits(cmap.start + CMAP_HEADER_BYTES, records * ENCODING_RECORD_BYTES, cmap.start, cmap.end)) return null;
  const found: Array<{ at: number; rank: number }> = [];
  for (let index = 0; index < records; index++) {
    const record = cmap.start + CMAP_HEADER_BYTES + index * ENCODING_RECORD_BYTES;
    if (!isUnicodeEncoding(bytes.u16(record), bytes.u16(record + 2))) continue;
    const at = cmap.start + bytes.u32(record + 4);
    if (!bytes.fits(at, 2, cmap.start, cmap.end)) continue;
    const rank = FORMAT_PREFERENCE.indexOf(bytes.u16(at));
    if (rank >= 0) found.push({ at, rank });
  }
  return found.sort((a, b) => a.rank - b.rank).map((subtable) => subtable.at);
}

/** The Unicode cmap of the TrueType program `font`, or null when it has none that reads. */
export function readUnicodeCmap(font: Uint8Array): UnicodeCmap | null {
  const bytes = new Bytes(font);
  const glyphCount = glyphCountOf(bytes);
  const cmap = tableSpan(bytes, 'cmap');
  if (glyphCount === null || glyphCount === 0 || cmap === null) return null;
  for (const at of unicodeSubtables(bytes, cmap) ?? []) {
    const mapping = new Mapping(glyphCount);
    if (SUBTABLE_READERS[bytes.u16(at)](bytes, at, cmap, mapping)) return mapping;
  }
  return null;
}
