import { describe, it, expect } from 'vitest';
import {
  createFormat4Subtable,
  createFormat12Subtable,
  createDualCmapTable,
  parseCmapTable,
  convertFont,
  parseFontToSfnt,
  extractTrueTypeGlyphs,
} from '../src/lib/conversions/font';
import {
  flattenTrueType,
  readCmap,
  readGlyf,
  readSfntTables,
  signedArea,
  unwrapWoff,
  unwrapWoff2,
} from './helpers/font-oracles';

describe('OpenType cmap Format 12 & Astral Unicode Embedding (ISO/IEC 14496-22 §5.2.4)', () => {
  describe('1. Format 4 (16-bit BMP) Subtable Generation', () => {
    it('creates standard compliant Format 4 subtable with 0xFFFF sentinel', () => {
      const bmpMappings = [
        { charCode: 0x0041, glyphId: 1 }, // 'A'
        { charCode: 0x0042, glyphId: 2 }, // 'B'
        { charCode: 0x4e00, glyphId: 3 }, // '一' (CJK BMP)
      ];

      const buf = createFormat4Subtable(bmpMappings);
      expect(buf.readUInt16BE(0)).toBe(4); // format = 4
      const length = buf.readUInt16BE(2);
      expect(length).toBe(buf.length);
      expect(buf.readUInt16BE(4)).toBe(0); // language = 0

      const segCountX2 = buf.readUInt16BE(6);
      const segCount = segCountX2 / 2;
      expect(segCount).toBeGreaterThanOrEqual(2); // At least 1 data segment + 1 sentinel segment

      // The last endCode must be 0xFFFF sentinel
      const lastEndCode = buf.readUInt16BE(14 + (segCount - 1) * 2);
      expect(lastEndCode).toBe(0xffff);
    });

    it('filters out Astral plane characters (> 0xFFFF) to preserve 16-bit BMP integrity', () => {
      const mixedMappings = [
        { charCode: 0x0041, glyphId: 1 }, // 'A' (BMP)
        { charCode: 0x20000, glyphId: 2 }, // CJK Ext B (Astral Plane 2)
        { charCode: 0x1f600, glyphId: 3 }, // Grinning Face Emoji (Astral Plane 1)
      ];

      const buf = createFormat4Subtable(mixedMappings);
      expect(buf.readUInt16BE(0)).toBe(4);

      // Parse with parseCmapTable to verify only BMP character is present in Format 4
      // Wrap Format 4 in a minimal cmap header to test
      const cmapHeader = Buffer.alloc(12);
      cmapHeader.writeUInt16BE(0, 0); // version
      cmapHeader.writeUInt16BE(1, 2); // 1 table
      cmapHeader.writeUInt16BE(3, 4); // platformID 3
      cmapHeader.writeUInt16BE(1, 6); // encodingID 1 (BMP)
      cmapHeader.writeUInt32BE(12, 8); // offset 12

      const singleCmap = Buffer.concat([cmapHeader, buf]);
      const parsed = parseCmapTable(singleCmap);

      expect(parsed.get(0x0041)).toBe(1);
      expect(parsed.has(0x20000)).toBe(false);
      expect(parsed.has(0x1f600)).toBe(false);
    });
  });

  describe('2. Format 12 (32-bit UCS-4 Segmented Coverage) Subtable Generation', () => {
    it('creates compliant Format 12 subtable with correct header and SequentialMapGroup compaction', () => {
      // Contiguous range 1: U+0041 to U+0043 (A, B, C) -> glyphs 1, 2, 3
      // Contiguous range 2: U+20000 to U+20002 (CJK Ext B) -> glyphs 10, 11, 12
      // Single character 3: U+1F600 (Emoji) -> glyph 50
      const mappings = [
        { charCode: 0x0041, glyphId: 1 },
        { charCode: 0x0042, glyphId: 2 },
        { charCode: 0x0043, glyphId: 3 },
        { charCode: 0x20000, glyphId: 10 },
        { charCode: 0x20001, glyphId: 11 },
        { charCode: 0x20002, glyphId: 12 },
        { charCode: 0x1f600, glyphId: 50 },
      ];

      const buf = createFormat12Subtable(mappings);
      expect(buf.readUInt16BE(0)).toBe(12); // format = 12
      expect(buf.readUInt16BE(2)).toBe(0); // reserved = 0
      const length = buf.readUInt32BE(4);
      expect(length).toBe(buf.length);
      expect(buf.readUInt32BE(8)).toBe(0); // language = 0

      const nGroups = buf.readUInt32BE(12);
      expect(nGroups).toBe(3); // 3 compacted groups: [A-C], [Emoji], [CJK Ext B]

      // Group 1: 0x0041 - 0x0043
      expect(buf.readUInt32BE(16)).toBe(0x0041);
      expect(buf.readUInt32BE(20)).toBe(0x0043);
      expect(buf.readUInt32BE(24)).toBe(1);

      // Group 2: 0x1F600 - 0x1F600
      expect(buf.readUInt32BE(28)).toBe(0x1f600);
      expect(buf.readUInt32BE(32)).toBe(0x1f600);
      expect(buf.readUInt32BE(36)).toBe(50);

      // Group 3: 0x20000 - 0x20002
      expect(buf.readUInt32BE(40)).toBe(0x20000);
      expect(buf.readUInt32BE(44)).toBe(0x20002);
      expect(buf.readUInt32BE(48)).toBe(10);
    });
  });

  describe('3. Dual cmap Table Architecture (Format 4 + Format 12)', () => {
    it('generates dual cmap table with Platform 3 Encoding 1 (BMP) and Encoding 10 (UCS-4)', () => {
      const mappings = [
        { charCode: 0x0041, glyphId: 1 }, // 'A' (BMP)
        { charCode: 0x4e2d, glyphId: 2 }, // '中' (BMP CJK)
        { charCode: 0x20000, glyphId: 10 }, // CJK Ext B (Astral)
        { charCode: 0x2a700, glyphId: 11 }, // CJK Ext C (Astral)
        { charCode: 0x30000, glyphId: 12 }, // CJK Ext G (Astral)
        { charCode: 0x1f980, glyphId: 20 }, // Crab Emoji (Astral)
      ];

      const dualCmap = createDualCmapTable(mappings);

      expect(dualCmap.readUInt16BE(0)).toBe(0); // version = 0
      const numTables = dualCmap.readUInt16BE(2);
      expect(numTables).toBe(2);

      // Subtable 0 header: Platform 3, Encoding 1 -> Format 4
      const p0 = dualCmap.readUInt16BE(4);
      const e0 = dualCmap.readUInt16BE(6);
      const off0 = dualCmap.readUInt32BE(8);
      expect(p0).toBe(3);
      expect(e0).toBe(1);
      expect(dualCmap.readUInt16BE(off0)).toBe(4); // Format 4

      // Subtable 1 header: Platform 3, Encoding 10 -> Format 12
      const p1 = dualCmap.readUInt16BE(12);
      const e1 = dualCmap.readUInt16BE(14);
      const off1 = dualCmap.readUInt32BE(16);
      expect(p1).toBe(3);
      expect(e1).toBe(10);
      expect(dualCmap.readUInt16BE(off1)).toBe(12); // Format 12
      expect(off1 % 4).toBe(0); // 4-byte aligned
    });

    it('achieves 100% lossless bidirectional roundtrip for BMP and Astral plane characters', () => {
      const testCodes = [
        { charCode: 0x0041, glyphId: 1 }, // 'A'
        { charCode: 0x005a, glyphId: 2 }, // 'Z'
        { charCode: 0x4e2d, glyphId: 3 }, // '中' (BMP CJK Unified Ideograph)
        { charCode: 0x6587, glyphId: 4 }, // '文'
        { charCode: 0x20000, glyphId: 10 }, // CJK Ext B (SIP Plane 2)
        { charCode: 0x20001, glyphId: 11 },
        { charCode: 0x2a700, glyphId: 12 }, // CJK Ext C
        { charCode: 0x2b740, glyphId: 13 }, // CJK Ext D
        { charCode: 0x2ceb0, glyphId: 14 }, // CJK Ext F
        { charCode: 0x30000, glyphId: 15 }, // CJK Ext G (TIP Plane 3)
        { charCode: 0x1f600, glyphId: 21 }, // Grinning Face Emoji
        { charCode: 0x1f680, glyphId: 22 }, // Rocket Emoji
      ];

      const dualCmap = createDualCmapTable(testCodes);
      const parsedMap = parseCmapTable(dualCmap);

      // Verify every single code point maps to the exact glyph ID
      for (const item of testCodes) {
        const mappedGid = parsedMap.get(item.charCode);
        expect(mappedGid).toBe(item.glyphId);
      }

      // Verify unmapped characters return undefined
      expect(parsedMap.get(0x0042)).toBeUndefined();
      expect(parsedMap.get(0x20002)).toBeUndefined();
      expect(parsedMap.get(0x1f601)).toBeUndefined();
    });
  });

  describe('4. End-to-End Font Conversion with Astral CJK & Emoji', () => {
    it('converts SVG font containing Astral CJK Ext B and Emoji to genuine TTF and WOFF with real outlines and without mojibake', async () => {
      const svgFontContent = `<?xml version="1.0" standalone="no"?>
        <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
        <svg xmlns="http://www.w3.org/2000/svg">
          <defs>
            <font id="AstralUnicodeTestFont" horiz-adv-x="1000">
              <font-face font-family="AstralUnicodeTestFont" units-per-em="1000" ascent="800" descent="-200" />
              <missing-glyph horiz-adv-x="500" d="M0 0 L500 0 L500 800 L0 800 Z" />
              <!-- BMP: 'A' -->
              <glyph unicode="A" horiz-adv-x="680" d="M30 0 L310 700 L370 700 L650 0 Z" />
              <!-- CJK Ext B: U+20000 (𠀀) as hex entity -->
              <glyph unicode="&#x20000;" horiz-adv-x="1000" d="M100 100 L900 100 L900 700 L100 700 Z" />
              <!-- Emoji: U+1F600 (😀) as decimal entity -->
              <glyph unicode="&#128512;" horiz-adv-x="800" d="M400 0 A400 400 0 1 0 400 800 A400 400 0 1 0 400 0 Z" />
            </font>
          </defs>
        </svg>`;

      const svgBuffer = Buffer.from(svgFontContent, 'utf-8');

      // 1. Convert SVG to TTF
      const ttfResult = await convertFont(svgBuffer, 'svg', 'ttf', {}, 'AstralFont.svg');
      expect(ttfResult.mimeType).toBe('font/ttf');

      // Parse resulting TTF with the engine and with the independent readers
      const parsedTtf = parseFontToSfnt(ttfResult.buffer, 'ttf', 'AstralFont');
      const parsedMap = parseCmapTable(parsedTtf.tables['cmap'].data);
      const ttfTables = readSfntTables(ttfResult.buffer);
      const independentMap = readCmap(ttfTables);

      // Verify BMP and Astral code points exist in the generated TTF cmap table
      for (const map of [parsedMap, independentMap]) {
        expect(map.get(0x0041)).toBe(1); // 'A'
        expect(map.get(0x20000)).toBe(2); // CJK Ext B U+20000
        expect(map.get(0x1f600)).toBe(3); // Emoji U+1F600
      }

      // The glyphs carry the outlines of their d attributes
      expect(readGlyf(ttfTables, 1)!.contours).toEqual([
        [
          { x: 30, y: 0, on: true },
          { x: 310, y: 700, on: true },
          { x: 370, y: 700, on: true },
          { x: 650, y: 0, on: true },
        ],
      ]);
      expect(readGlyf(ttfTables, 2)!.bbox).toEqual([100, 100, 900, 700]);
      // Two half circles of radius 400 around (400, 400): a full circle
      const [circle] = [readGlyf(ttfTables, 3)!.contours[0]].map((contour) => flattenTrueType(contour));
      expect(Math.abs(signedArea(circle))).toBeGreaterThan(Math.PI * 400 * 400 * 0.995);
      expect(Math.abs(signedArea(circle))).toBeLessThan(Math.PI * 400 * 400 * 1.005);

      // 2. Extract glyphs with extractTrueTypeGlyphs
      const extracted = extractTrueTypeGlyphs(parsedTtf);
      const unicodes = extracted.map((g) => g.unicode);

      expect(unicodes).toContain('A');
      expect(unicodes).toContain(String.fromCodePoint(0x20000)); // Authentic Astral character
      expect(unicodes).toContain(String.fromCodePoint(0x1f600)); // Authentic Emoji

      // 3. Convert SVG to WOFF and WOFF2
      const woffResult = await convertFont(svgBuffer, 'svg', 'woff', {}, 'AstralFont.svg');
      expect(woffResult.mimeType).toBe('font/woff');
      expect(woffResult.buffer.subarray(0, 4).toString('ascii')).toBe('wOFF');
      expect(readCmap(unwrapWoff(woffResult.buffer)).get(0x1f600)).toBe(3);

      const woff2Result = await convertFont(svgBuffer, 'svg', 'woff2', {}, 'AstralFont.svg');
      expect(woff2Result.mimeType).toBe('font/woff2');
      expect(woff2Result.buffer.subarray(0, 4).toString('ascii')).toBe('wOF2');
      expect(readCmap(unwrapWoff2(woff2Result.buffer)).get(0x20000)).toBe(2);
    });
  });
});
