/**
 * Fonts and PDFs that make a TrueType cmap reader do the most work for the least input (OpenType specification, `cmap`
 * formats 4 and 6, and `maxp`): a table of encoding records that all name one format 4 subtable, which covers almost every
 * code point in its first segment and is only found unreadable by its last one.
 */

import zlib from 'node:zlib';
import { extraObjectNumber, rawPdf } from './raw-pdf';

const GLYPH_COUNT = 0xffff;
const SFNT_HEADER_BYTES = 12;
const TABLE_RECORD_BYTES = 16;
const MAXP_BYTES = 6;
const CMAP_HEADER_BYTES = 4;
const ENCODING_RECORD_BYTES = 8;
const PLATFORM_WINDOWS = 3;
const WINDOWS_UNICODE_BMP = 1;
/** The glyph the valid fallback subtable gives to "a". */
export const FALLBACK_GLYPH = 7;
/** Most code points of text the fallback maps. */
const FALLBACK_FIRST = 0x61;

/** A format 4 subtable whose first segment maps U+0000 to U+FFFE and whose last has an /idRangeOffset past the table. */
function lateFailingFormat4(): Buffer {
  const subtable = Buffer.alloc(14 + 2 * 2 + 2 + 3 * 2 * 2);
  subtable.writeUInt16BE(4, 0);
  subtable.writeUInt16BE(subtable.length, 2);
  subtable.writeUInt16BE(4, 6);
  const words = [0xfffe, 0xffff, 0, 0, 0xffff, 1, 0, 0, 0xfff0];
  words.forEach((word, index) => subtable.writeUInt16BE(word, 14 + index * 2));
  return subtable;
}

function format6(): Buffer {
  const subtable = Buffer.alloc(10 + 2);
  subtable.writeUInt16BE(6, 0);
  subtable.writeUInt16BE(subtable.length, 2);
  subtable.writeUInt16BE(FALLBACK_FIRST, 6);
  subtable.writeUInt16BE(1, 8);
  subtable.writeUInt16BE(FALLBACK_GLYPH, 10);
  return subtable;
}

/**
 * A TrueType program of 65,535 glyphs whose cmap holds `records` encoding records (Windows Unicode BMP) that all name the
 * same unreadable format 4 subtable. With `fallback`, one more record names a readable format 6 subtable, placed after the
 * others.
 */
export function repeatedRecordsFont(records: number, fallback = false): Buffer {
  const broken = lateFailingFormat4();
  const readable = fallback ? format6() : Buffer.alloc(0);
  const cmapBytes = CMAP_HEADER_BYTES + (records + (fallback ? 1 : 0)) * ENCODING_RECORD_BYTES;
  const cmap = Buffer.alloc(cmapBytes);
  cmap.writeUInt16BE(records + (fallback ? 1 : 0), 2);
  const record = (index: number, offset: number): void => {
    const at = CMAP_HEADER_BYTES + index * ENCODING_RECORD_BYTES;
    cmap.writeUInt16BE(PLATFORM_WINDOWS, at);
    cmap.writeUInt16BE(WINDOWS_UNICODE_BMP, at + 2);
    cmap.writeUInt32BE(offset, at + 4);
  };
  for (let index = 0; index < records; index++) record(index, cmapBytes);
  if (fallback) record(records, cmapBytes + broken.length);

  const directoryBytes = SFNT_HEADER_BYTES + 2 * TABLE_RECORD_BYTES;
  const header = Buffer.alloc(directoryBytes);
  header.writeUInt16BE(2, 4);
  const place = (index: number, tag: string, offset: number, length: number): void => {
    const at = SFNT_HEADER_BYTES + index * TABLE_RECORD_BYTES;
    header.write(tag, at, 'latin1');
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(length, at + 12);
  };
  const cmapLength = cmapBytes + broken.length + readable.length;
  place(0, 'maxp', directoryBytes, MAXP_BYTES);
  place(1, 'cmap', directoryBytes + MAXP_BYTES, cmapLength);
  const maxp = Buffer.alloc(MAXP_BYTES);
  maxp.writeUInt16BE(GLYPH_COUNT, 4);
  return Buffer.concat([header, maxp, cmap, broken, readable]);
}

/**
 * A one-page PDF with `fontCount` Type0 fonts (Identity-H, no /ToUnicode) that share one CIDFontType2 descendant, hence one
 * /FontFile2 stream: `program` deflated.
 */
export function sharedProgramPdf(fontCount: number, program: Buffer): Buffer {
  const compressed = zlib.deflateSync(program, { level: 9 });
  const first = extraObjectNumber(1);
  const [descendant, descriptor, file, firstType0] = [first, first + 1, first + 2, first + 3];
  const objects = [
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /CIDToGIDMap /Identity >>`,
    `<< /Type /FontDescriptor /FontName /X /Flags 32 /FontBBox [0 0 1 1] /FontFile2 ${file} 0 R >>`,
    `<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n${compressed.toString('latin1')}\nendstream`,
  ];
  let fonts = '';
  for (let index = 0; index < fontCount; index++) {
    objects.push(`<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] >>`);
    fonts += `/G${index} ${firstType0 + index} 0 R `;
  }
  return rawPdf([{ width: 100, height: 100, content: 'BT /G0 12 Tf 10 10 Td <0007> Tj ET', fonts }], objects);
}
