/**
 * A TrueType font written for the warm-up document (pdf-text-warmup.ts): one square glyph for every character the document
 * shows (none for a space), so that the document can embed a font program the way the documents of users do, and the reader's
 * font loading is part of what a replacement thread warms. It is a valid font (every table, with checksums) and draws squares.
 */

const UNITS_PER_EM = 1000;
const ADVANCE_WIDTH = 600;
const SQUARE_LEFT = 50;
const SQUARE_RIGHT = 550;
const SQUARE_TOP = 700;
const ASCENDER = 800;
const DESCENDER = -200;
const SFNT_VERSION = 0x00010000;
/** `head.indexToLocFormat` for 32-bit glyph offsets. */
const LONG_LOCA = 1;
const REGULAR_WEIGHT = 400;
const MEDIUM_WIDTH = 5;
const FS_SELECTION_REGULAR = 0x40;
const HEAD_MAGIC = 0x5f0f3cf5;
const CHECKSUM_ADJUSTMENT_BASE = 0xb1b0afba;
const SPACE = 0x20;
const WINDOWS_PLATFORM = 3;
const UNICODE_BMP_ENCODING = 1;
const LAST_CODE = 0xffff;
const FLAG_ON_CURVE = 1;
/** The version of a `post` table that stores no glyph names. */
const POST_VERSION_WITHOUT_NAMES = 0x00030000;

type Table = { tag: string; data: Buffer };

function u16(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => out.writeUInt16BE(value & 0xffff, index * 2));
  return out;
}

function u32(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => out.writeUInt32BE(value >>> 0, index * 4));
  return out;
}

function i16(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => out.writeInt16BE(value, index * 2));
  return out;
}

/** Sum of the 32-bit big-endian words of `data`, padded with zeros to a multiple of four bytes. */
function checksum(data: Buffer): number {
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  let sum = 0;
  for (let at = 0; at < padded.length; at += 4) sum = (sum + padded.readUInt32BE(at)) >>> 0;
  return sum;
}

/** A square of four on-curve points: header, end point, no instructions, flags, x deltas and y deltas, padded to a multiple of four bytes. */
function squareGlyph(): Buffer {
  const xs = [SQUARE_LEFT, SQUARE_RIGHT - SQUARE_LEFT, 0, SQUARE_LEFT - SQUARE_RIGHT];
  const ys = [0, 0, SQUARE_TOP, 0];
  return Buffer.concat([
    i16(1, SQUARE_LEFT, 0, SQUARE_RIGHT, SQUARE_TOP),
    u16(3, 0),
    Buffer.alloc(4, FLAG_ON_CURVE),
    i16(...xs),
    i16(...ys),
    Buffer.alloc(2),
  ]);
}

/** The `cmap` table: Windows Unicode BMP, format 4, with one segment for each run of consecutive characters (glyphs follow the order of `codes`). */
function cmapTable(codes: readonly number[]): Buffer {
  const segments: Array<{ start: number; end: number; delta: number }> = [];
  codes.forEach((code, index) => {
    const glyph = index + 1;
    const last = segments.at(-1);
    if (last && last.end + 1 === code) last.end = code;
    else segments.push({ start: code, end: code, delta: glyph - code });
  });
  segments.push({ start: LAST_CODE, end: LAST_CODE, delta: 1 });
  const count = segments.length;
  const searchRange = 2 * 2 ** Math.floor(Math.log2(count));
  const subtable = Buffer.concat([
    u16(4, 16 + count * 8, 0, count * 2, searchRange, Math.log2(searchRange / 2), count * 2 - searchRange),
    u16(...segments.map((segment) => segment.end)),
    u16(0),
    u16(...segments.map((segment) => segment.start)),
    u16(...segments.map((segment) => segment.delta)),
    u16(...segments.map(() => 0)),
  ]);
  return Buffer.concat([u16(0, 1, WINDOWS_PLATFORM, UNICODE_BMP_ENCODING), u32(12), subtable]);
}

/** The tables of the font; the glyph of `codes[n]` is n + 1, and glyph 0 is a square too. */
function tablesOf(codes: readonly number[]): Table[] {
  const glyphCount = codes.length + 1;
  const outlines = [squareGlyph(), ...codes.map((code) => (code === SPACE ? Buffer.alloc(0) : squareGlyph()))];
  const offsets = [0];
  for (const outline of outlines) offsets.push(offsets.at(-1)! + outline.length);
  const head = Buffer.concat([
    u32(SFNT_VERSION, 0, 0, HEAD_MAGIC), // version, font revision, checksum adjustment (set last), magic number
    u16(0, UNITS_PER_EM), // flags, units per em
    Buffer.alloc(16), // created, modified
    i16(0, 0, ADVANCE_WIDTH, SQUARE_TOP), // bounding box
    u16(0, 8, 2), // Mac style, smallest readable size in pixels, direction hint
    i16(LONG_LOCA, 0), // loca format, glyph data format
  ]);
  const hhea = Buffer.concat([
    u32(SFNT_VERSION),
    i16(ASCENDER, DESCENDER, 0), // ascender, descender, line gap
    u16(ADVANCE_WIDTH), // widest advance
    i16(0, 0, ADVANCE_WIDTH), // smallest left and right side bearing, widest extent
    i16(1, 0, 0), // caret slope (rise, run) and offset
    i16(0, 0, 0, 0, 0), // four reserved values, metric data format
    u16(glyphCount),
  ]);
  const os2 = Buffer.concat([
    u16(0), // version 0
    i16(ADVANCE_WIDTH), // average character width
    u16(REGULAR_WEIGHT, MEDIUM_WIDTH, 0), // weight, width, embedding permissions
    i16(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), // sub- and superscript and strikeout sizes and positions, family class
    Buffer.alloc(10), // PANOSE
    Buffer.alloc(16), // Unicode ranges
    Buffer.from('WARM'), // vendor
    u16(FS_SELECTION_REGULAR, codes[0] ?? SPACE, codes.at(-1) ?? SPACE), // selection, first and last character
    i16(ASCENDER, DESCENDER, 0), // typographic ascender, descender, line gap
    u16(ASCENDER, -DESCENDER), // Windows ascent and descent
  ]);
  return [
    { tag: 'OS/2', data: os2 },
    { tag: 'cmap', data: cmapTable(codes) },
    { tag: 'glyf', data: Buffer.concat(outlines) },
    { tag: 'head', data: head },
    { tag: 'hhea', data: hhea },
    { tag: 'hmtx', data: Buffer.concat(Array.from({ length: glyphCount }, () => Buffer.concat([u16(ADVANCE_WIDTH), i16(SQUARE_LEFT)]))) },
    { tag: 'loca', data: u32(...offsets) },
    { tag: 'maxp', data: Buffer.concat([u32(SFNT_VERSION), u16(glyphCount, 4, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0)]) }, // glyphs, points, contours, then composite limits, zones and instruction limits
    { tag: 'name', data: u16(0, 0, 6) }, // format 0, no records, strings at offset 6
    { tag: 'post', data: Buffer.concat([u32(POST_VERSION_WITHOUT_NAMES, 0), i16(-100, 50), u32(0, 0, 0, 0, 0)]) }, // version, italic angle, underline position and thickness, not fixed pitch, memory limits
  ];
}

/** The font file: a TrueType font with a glyph for each of `codes` (sorted Unicode code points below U+FFFF; glyph n+1 is code n). */
export function warmupFontFile(codes: readonly number[]): Buffer {
  const tables = tablesOf(codes).sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const count = tables.length;
  const searchRange = 16 * 2 ** Math.floor(Math.log2(count));
  const header = Buffer.concat([u32(SFNT_VERSION), u16(count, searchRange, Math.log2(searchRange / 16), count * 16 - searchRange)]);
  const bodies: Buffer[] = [];
  let offset = header.length + count * 16;
  const entries = tables.map((table) => {
    const entry = Buffer.concat([Buffer.from(table.tag, 'latin1'), u32(checksum(table.data), offset, table.data.length)]);
    const padded = Buffer.concat([table.data, Buffer.alloc((4 - (table.data.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
    return entry;
  });
  const file = Buffer.concat([header, ...entries, ...bodies]);
  // head.checkSumAdjustment makes the checksum of the whole file CHECKSUM_ADJUSTMENT_BASE.
  const headAt = file.indexOf(Buffer.from('head', 'latin1'));
  const headOffset = file.readUInt32BE(headAt + 8);
  file.writeUInt32BE((CHECKSUM_ADJUSTMENT_BASE - checksum(file)) >>> 0, headOffset + 8);
  return file;
}
