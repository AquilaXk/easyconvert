import { describe, expect, it } from 'vitest';
import { warmupFontFile } from '../src/lib/conversions/pdf-text-warmup-font';
import { HAS_FC_SCAN, fcScan, readCmap, readGlyf, readGlyphCount, readHmtx, readSfntTables, requireStrictFcScan, requireTable } from './helpers/font-oracles';

/**
 * The font program that the warm-up document embeds (see pdf-text-warmup.ts), read by the independent sfnt readers of
 * tests/helpers/font-oracles.ts (written from the OpenType specification) and by FreeType through fontconfig.
 */

requireStrictFcScan('warm-up font');

const CODES = [0x20, 0x41, 0x42, 0x43, 0x61, 0x62, 0x3b1, 0x3b2, 0x416, 0x3053, 0x4e00];
const WHOLE_FILE_CHECKSUM = 0xb1b0afba;
const HEAD_CHECKSUM_ADJUSTMENT_OFFSET = 8;
const SFNT_HEADER_BYTES = 12;
const DIRECTORY_ENTRY_BYTES = 16;
const FIXED_ADVANCE = 600;
const SQUARE_CORNERS = 4;

/** The checksum of the specification: the sum of the file's big-endian 32-bit words, the last one padded with zeros. */
function sfntChecksum(data: Buffer): number {
  let sum = 0;
  for (let at = 0; at < data.length; at += 4) {
    const word = Buffer.alloc(4);
    data.copy(word, 0, at, Math.min(at + 4, data.length));
    sum = (sum + word.readUInt32BE(0)) >>> 0;
  }
  return sum;
}

describe('the font of the warm-up document', () => {
  const font = warmupFontFile(CODES);
  const tables = readSfntTables(font);

  it('has the tables of a TrueType font with outlines', () => {
    expect([...tables.keys()].sort()).toEqual(['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']);
    expect(font.readUInt32BE(0)).toBe(0x00010000);
  });

  it('maps each character to the glyph after the one for the character before it, and nothing else', () => {
    const mapped = readCmap(tables);
    expect([...mapped.entries()].sort((a, b) => a[0] - b[0])).toEqual(CODES.map((code, index) => [code, index + 1]));
    expect(readGlyphCount(tables)).toBe(CODES.length + 1);
  });

  it('draws a square for every character but the space, which has no outline', () => {
    const mapped = readCmap(tables);
    for (const [code, glyph] of mapped) {
      const outline = readGlyf(tables, glyph);
      if (code === 0x20) {
        expect(outline).toBeNull();
        continue;
      }
      expect(outline?.contours).toHaveLength(1);
      expect(outline?.contours[0]).toHaveLength(SQUARE_CORNERS);
      expect(outline?.bbox).toEqual([50, 0, 550, 700]);
    }
    expect(readGlyf(tables, 0)?.contours).toHaveLength(1);
  });

  it('gives every glyph the same advance', () => {
    for (let glyph = 0; glyph <= CODES.length; glyph++) expect(readHmtx(tables, glyph).advance).toBe(FIXED_ADVANCE);
  });

  it('has the checksums the specification asks for: each table, and the whole file through the head adjustment', () => {
    const count = font.readUInt16BE(4);
    for (let entry = 0; entry < count; entry++) {
      const base = SFNT_HEADER_BYTES + entry * DIRECTORY_ENTRY_BYTES;
      const tag = font.toString('latin1', base, base + 4);
      const stored = font.readUInt32BE(base + 4);
      const data = Buffer.from(requireTable(tables, tag));
      // The head checksum is taken with its adjustment field zero.
      if (tag === 'head') data.writeUInt32BE(0, HEAD_CHECKSUM_ADJUSTMENT_OFFSET);
      expect(stored, tag).toBe(sfntChecksum(data));
    }
    expect(sfntChecksum(font)).toBe(WHOLE_FILE_CHECKSUM);
  });

  // skip-ok: requireStrictFcScan at the top of this file throws before the suite is collected when fc-scan is missing under ORACLE_STRICT_MODE.
  it.skipIf(!HAS_FC_SCAN)('is read by FreeType, which lists the characters it maps', () => {
    const scanned = fcScan(font, 'ttf');
    expect(scanned.fontformat).toBe('TrueType');
    // fontconfig writes the character set as hexadecimal ranges: 20 41-43 61-62 3b1-3b2 416 3053 4e00.
    expect(scanned.charset.trim().split(/\s+/)).toEqual(['20', '41-43', '61-62', '3b1-3b2', '416', '3053', '4e00']);
  });
});
