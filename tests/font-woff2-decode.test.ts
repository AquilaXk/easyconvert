import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { convertFont, decodeWoff2, decodeWoff2Collection, type ParsedFont } from '../src/lib/conversions/font';
import {
  WOFF2_MAX_DECODED_BYTES,
  WOFF2_MAX_TABLES,
  Woff2FormatError,
  Woff2LimitError,
} from '../src/lib/conversions/font-woff2';
import { fcScan, HAS_FC_SCAN, readGlyf, readSfntTables, requireStrictFcScan } from './helpers/font-oracles';

requireStrictFcScan('WOFF2 decode');
import { firstFlagOffset, SFNT_FLAG_OVERLAP_SIMPLE } from './helpers/woff2-reference';
import {
  brotliFont,
  buildWoff2,
  glyfLoca,
  minimalTransformedFont,
  sfntHhea,
  sfntMaxp,
  TRIANGLE_GLYF_LENGTH,
  u255,
  type Woff2TableSpec,
} from './helpers/woff2-builder';

/**
 * Decoder conformance against the W3C WOFF2 Recommendation. The reference files in
 * tests/fixtures/woff2 were written by the Google woff2 reference encoder and by fontTools; their
 * "*-decoded.*" companions are the output of the Google reference decoder (see PROVENANCE.txt).
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'woff2');
const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

const SFNT_HEADER_BYTES = 12;
const SFNT_RECORD_BYTES = 16;
const TTC_HEADER_BYTES = 12;
const SFNT_MAGIC_SUM = 0xb1b0afba;
const HEAD_ADJUSTMENT_OFFSET = 8;

interface SfntRecord {
  checkSum: number;
  data: Buffer;
}

function readRecords(font: Buffer, directoryAt = 0): Map<string, SfntRecord> {
  const records = new Map<string, SfntRecord>();
  const numTables = font.readUInt16BE(directoryAt + 4);
  for (let i = 0; i < numTables; i++) {
    const at = directoryAt + SFNT_HEADER_BYTES + i * SFNT_RECORD_BYTES;
    const offset = font.readUInt32BE(at + 8);
    const length = font.readUInt32BE(at + 12);
    records.set(font.toString('latin1', at, at + 4), { checkSum: font.readUInt32BE(at + 4), data: font.subarray(offset, offset + length) });
  }
  return records;
}

function readCollection(ttc: Buffer): Array<Map<string, SfntRecord>> {
  expect(ttc.toString('latin1', 0, 4)).toBe('ttcf');
  const numFonts = ttc.readUInt32BE(8);
  const fonts: Array<Map<string, SfntRecord>> = [];
  for (let i = 0; i < numFonts; i++) fonts.push(readRecords(ttc, ttc.readUInt32BE(TTC_HEADER_BYTES + i * 4)));
  return fonts;
}

/** The sfnt table checksum of the specification: the sum of big-endian words of the zero padded table. */
function checksum(data: Buffer): number {
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

/**
 * head.checkSumAdjustment depends on the physical order of the tables, which the reference decoder takes
 * from the WOFF2 directory and this engine fixes to ascending tag order; it is checked separately.
 */
function withoutAdjustment(tag: string, data: Buffer): Buffer {
  if (tag !== 'head') return data;
  const copy = Buffer.from(data);
  copy.writeUInt32BE(0, HEAD_ADJUSTMENT_OFFSET);
  return copy;
}

function expectTablesEqual(font: ParsedFont, reference: Map<string, SfntRecord>, normalise: (tag: string, data: Buffer) => Buffer = (_tag, data) => data): void {
  expect(Object.keys(font.tables).sort()).toEqual([...reference.keys()].sort());
  for (const [tag, record] of reference) {
    const decoded = font.tables[tag];
    expect(withoutAdjustment(tag, normalise(tag, decoded.data)).equals(withoutAdjustment(tag, record.data)), `table '${tag}' differs from the reference decoder`).toBe(true);
    expect(decoded.length).toBe(record.data.length);
    if (normalise(tag, decoded.data) === decoded.data) expect(decoded.checkSum, `checksum of '${tag}'`).toBe(record.checkSum);
  }
}

const RINGS_GLYPH = 7; // the glyph of synthetic-triplets that carries the overlap bit

const SINGLE_FONT_FIXTURES = [
  ['dejavu-sans-latin', 'dejavu-sans-latin.google.woff2', 'dejavu-sans-latin.google-decoded.ttf'],
  ['dejavu-serif-hinted-ascii', 'dejavu-serif-hinted-ascii.google.woff2', 'dejavu-serif-hinted-ascii.google-decoded.ttf'],
  ['synthetic-triplets', 'synthetic-triplets.google.woff2', 'synthetic-triplets.google-decoded.ttf'],
  ['synthetic-cff', 'synthetic-cff.google.woff2', 'synthetic-cff.google-decoded.otf'],
  ['dejavu-sans-latin with hmtx transform (fontTools)', 'dejavu-sans-latin.fonttools-hmtx.woff2', 'dejavu-sans-latin.fonttools-hmtx.google-decoded.ttf'],
  ['synthetic-triplets with hmtx transform (fontTools)', 'synthetic-triplets.fonttools-hmtx.woff2', 'synthetic-triplets.fonttools-hmtx.google-decoded.ttf'],
] as const;

describe('WOFF2 decoder: reference files from independent encoders', () => {
  it.each(SINGLE_FONT_FIXTURES)('%s: every table equals the Google reference decoder output', (_label, woff2, decoded) => {
    const font = decodeWoff2(fixture(woff2), 'fixture');
    const reference = readRecords(fixture(decoded));
    if (woff2 === 'synthetic-triplets.fonttools-hmtx.woff2') {
      // fontTools writes an overlapSimple bitmap; the 1.0.2 Google decoder predates it and drops the bit
      const tables = new Map(Object.entries(font.tables).map(([tag, t]) => [tag, t.data]));
      const flagAt = firstFlagOffset(tables, RINGS_GLYPH);
      expect(font.tables['glyf'].data[flagAt] & SFNT_FLAG_OVERLAP_SIMPLE).toBe(SFNT_FLAG_OVERLAP_SIMPLE);
      expectTablesEqual(font, reference, (tag, data) => {
        if (tag !== 'glyf') return data;
        const cleared = Buffer.from(data);
        cleared[flagAt] &= ~SFNT_FLAG_OVERLAP_SIMPLE;
        return cleared;
      });
    } else {
      expectTablesEqual(font, reference);
    }
    expect(font.sfntVersion).toBe(fixture(decoded).readUInt32BE(0));
  });

  it.each(SINGLE_FONT_FIXTURES)('%s: the reconstructed font satisfies the sfnt checksum rule', (_label, woff2) => {
    const font = decodeWoff2(fixture(woff2), 'fixture');
    const head = font.tables['head'].data;
    // head's own checksum is taken with checkSumAdjustment zeroed; the sum of all table checksums and of the
    // directory then equals 0xB1B0AFBA minus the adjustment
    const zeroed = Buffer.from(head);
    zeroed.writeUInt32BE(0, HEAD_ADJUSTMENT_OFFSET);
    expect(font.tables['head'].checkSum).toBe(checksum(zeroed));
    for (const table of Object.values(font.tables)) {
      if (table.tag !== 'head') expect(table.checkSum).toBe(checksum(table.data));
    }
    const tags = Object.keys(font.tables).sort();
    const directory = Buffer.alloc(SFNT_HEADER_BYTES + SFNT_RECORD_BYTES * tags.length);
    directory.writeUInt32BE(font.sfntVersion, 0);
    directory.writeUInt16BE(tags.length, 4);
    const entrySelector = Math.floor(Math.log2(tags.length));
    directory.writeUInt16BE((1 << entrySelector) * 16, 6);
    directory.writeUInt16BE(entrySelector, 8);
    directory.writeUInt16BE(tags.length * 16 - (1 << entrySelector) * 16, 10);
    let offset = directory.length;
    tags.forEach((tag, i) => {
      const at = SFNT_HEADER_BYTES + i * SFNT_RECORD_BYTES;
      directory.write(tag, at, 'latin1');
      directory.writeUInt32BE(font.tables[tag].checkSum, at + 4);
      directory.writeUInt32BE(offset, at + 8);
      directory.writeUInt32BE(font.tables[tag].data.length, at + 12);
      offset += (font.tables[tag].data.length + 3) & ~3;
    });
    let total = checksum(directory);
    for (const tag of tags) total = (total + font.tables[tag].checkSum) >>> 0;
    expect((total + head.readUInt32BE(HEAD_ADJUSTMENT_OFFSET)) >>> 0).toBe(SFNT_MAGIC_SUM);
  });

  it('reconstructs the outlines of the source font point by point', () => {
    const source = readSfntTables(fixture('synthetic-triplets.ttf'));
    const decoded = decodeWoff2(fixture('synthetic-triplets.google.woff2'), 'fixture');
    const tables = new Map(Object.entries(decoded.tables).map(([tag, t]) => [tag, t.data]));
    const COMPOSITE_GLYPHS = new Set([10, 11]);
    const EMPTY_GLYPH = 1;
    let compared = 0;
    for (let glyphId = 0; glyphId < source.get('maxp')!.readUInt16BE(4); glyphId++) {
      if (COMPOSITE_GLYPHS.has(glyphId)) continue;
      expect(readGlyf(tables, glyphId), `glyph ${glyphId}`).toEqual(readGlyf(source, glyphId));
      if (glyphId !== EMPTY_GLYPH) compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(8);
  });

  it('keeps the composite glyph records, including their instructions, byte for byte', () => {
    const source = readSfntTables(fixture('synthetic-triplets.ttf'));
    const decoded = decodeWoff2(fixture('synthetic-triplets.google.woff2'), 'fixture');
    const slice = (tables: Map<string, Buffer>, id: number): Buffer => {
      const loca = tables.get('loca')!;
      const long = tables.get('head')!.readInt16BE(50) === 1;
      const at = (i: number): number => (long ? loca.readUInt32BE(i * 4) : loca.readUInt16BE(i * 2) * 2);
      return tables.get('glyf')!.subarray(at(id), at(id + 1));
    };
    const tables = new Map(Object.entries(decoded.tables).map(([tag, t]) => [tag, t.data]));
    for (const id of [10, 11]) {
      const original = slice(source, id);
      const rebuilt = slice(tables, id);
      expect(rebuilt.subarray(0, original.length).equals(original), `composite glyph ${id}`).toBe(true);
    }
  });

  it('decodes a WOFF2 collection: every font equals the Google reference decoder output', () => {
    const fonts = decodeWoff2Collection(fixture('pair.google.woff2'), 'pair');
    const reference = readCollection(fixture('pair.google-decoded.ttc'));
    expect(fonts).toHaveLength(2);
    expect(reference).toHaveLength(2);
    fonts.forEach((font, i) => expectTablesEqual(font, reference[i]));
    expect(fonts[0].fontFamily).toBe('DejaVu Sans');
    expect(fonts[1].fontFamily).toBe('Conformance Triplets');
  });

  it('decodes the first font of a collection when a single font is requested', () => {
    const first = decodeWoff2(fixture('pair.google.woff2'), 'pair');
    expect(first.fontFamily).toBe('DejaVu Sans');
  });
});

describe.skipIf(!HAS_FC_SCAN)('WOFF2 decoder: fontconfig reads the converted reference file (needs fc-scan)', () => {
  it('converts a reference WOFF2 to TTF with the family and coverage of the source font', async () => {
    const result = await convertFont(fixture('dejavu-sans-latin.google.woff2'), 'woff2', 'ttf', {}, 'dejavu.woff2');
    const converted = fcScan(result.buffer, 'ttf');
    const source = fcScan(fixture('dejavu-sans-latin.ttf'), 'ttf');
    expect(converted.family).toBe('DejaVu Sans');
    expect(converted.family).toBe(source.family);
    expect(converted.charset).toBe(source.charset);
  });
});

describe('WOFF2 decoder: a minimal hand built font', () => {
  const expectedGlyf = Buffer.from(
    '0001' + '0000' + '0000' + '0014' + '000a' + '0002' + '0000' + '371723' + '0a0a14' + '0a0a' + '0000',
    'hex',
  );

  it('reconstructs the glyf and loca of the glyf transform exactly', () => {
    const font = decodeWoff2(buildWoff2({ tables: minimalTransformedFont() }), 'minimal');
    expect(font.tables['glyf'].data.equals(expectedGlyf)).toBe(true);
    expect(font.tables['loca'].data.toString('hex')).toBe('00000000000c');
  });

  it('restores the glyph padding and records indexFormat 1 in head', () => {
    const tables = minimalTransformedFont({ indexFormat: 1 });
    tables[4].origLength = 12;
    const font = decodeWoff2(buildWoff2({ tables }), 'minimal');
    expect(font.tables['loca'].data.toString('hex')).toBe('000000000000000000000018');
    expect(font.tables['head'].data.readInt16BE(50)).toBe(1);
  });

  const fails = (label: string, make: () => Buffer, error: typeof Woff2FormatError = Woff2FormatError): void => {
    it(label, () => {
      expect(() => decodeWoff2(make(), 'bad')).toThrow(error);
    });
  };

  describe('header and table directory', () => {
    const valid = (): Buffer => buildWoff2({ tables: minimalTransformedFont() });

    fails('rejects a file that is not WOFF2', () => Buffer.alloc(64));
    fails('rejects a file shorter than the 48 byte header', () => valid().subarray(0, 47));
    fails('rejects a header length that differs from the file size', () => buildWoff2({ tables: minimalTransformedFont(), lengthOverride: 9999 }));
    fails('rejects a font without tables', () => buildWoff2({ tables: [] }));
    fails('rejects a directory that stops early', () => valid().subarray(0, 52));
    fails('rejects a table count that exceeds the engine limit', () =>
      buildWoff2({ tables: minimalTransformedFont(), numTables: WOFF2_MAX_TABLES + 1 }), Woff2LimitError);
    fails('rejects a compressed size larger than the file', () => buildWoff2({ tables: minimalTransformedFont(), totalCompressedSize: 1 << 20 }));
    fails('rejects a redundant leading zero group in a UIntBase128', () => {
      const tables = minimalTransformedFont();
      tables[3] = { ...tables[3], rawEntry: [3, 0x80, 8] };
      return buildWoff2({ tables });
    });
    fails('rejects a duplicate table tag', () => {
      const tables = minimalTransformedFont();
      tables.push({ ...tables[1] });
      return buildWoff2({ tables });
    });
    fails('rejects transform version 1 of glyf', () => {
      const tables = minimalTransformedFont();
      tables[0].version = 1;
      return buildWoff2({ tables });
    });
    fails('rejects transform version 2 of hmtx', () => {
      const tables = minimalTransformedFont();
      tables[3] = { ...tables[3], version: 2, transformLength: 8 };
      return buildWoff2({ tables });
    });
    fails('rejects a transform on a table that defines none', () => {
      const tables = minimalTransformedFont();
      tables[1] = { ...tables[1], version: 1, transformLength: 54 };
      return buildWoff2({ tables });
    });
    fails('rejects a transformed loca whose transformLength is not 0', () => {
      const tables = minimalTransformedFont();
      tables[4] = { ...tables[4], data: Buffer.from([0]), transformLength: 1 };
      return buildWoff2({ tables });
    });
    fails('rejects a transformed glyf without a transformed loca', () => {
      const tables = minimalTransformedFont();
      tables[4] = { tag: 'loca', data: glyfLoca([0, 24], false), version: 3 };
      return buildWoff2({ tables });
    });
    fails('rejects a transformed loca without a transformed glyf', () => {
      const tables = minimalTransformedFont();
      tables[0] = { tag: 'glyf', data: expectedGlyfBytes(), version: 3 };
      return buildWoff2({ tables });
    });
    fails('rejects tables whose declared sizes exceed the decoded size limit', () => {
      const tables = minimalTransformedFont();
      tables[1] = { ...tables[1], origLength: WOFF2_MAX_DECODED_BYTES + 1 };
      return buildWoff2({ tables });
    }, Woff2LimitError);
    fails('rejects a collection header with an unknown version', () => collectionFile({ version: 0x00030000 }));
    fails('rejects a collection without fonts', () => collectionFile({ numFonts: 0 }));
    fails('rejects a collection font that names a table outside the directory', () => collectionFile({ indices: [0, 1, 2, 3, 4, 99] }));
  });

  describe('compressed stream', () => {
    fails('rejects a zlib stream where Brotli is required', () => {
      const tables = minimalTransformedFont();
      const raw = Buffer.concat(tables.map((t) => t.data));
      return buildWoff2({ tables, compressed: deflateSync(raw) });
    });

    fails('rejects a Brotli stream that holds a whole sfnt instead of the table data', () => {
      const tables = minimalTransformedFont();
      const sfnt = Buffer.concat([Buffer.from('00010000000100000000000000000000', 'hex'), Buffer.alloc(200)]);
      return buildWoff2({ tables, compressed: brotliFont(sfnt) });
    });

    fails('rejects a stream shorter than the sizes of the directory', () => {
      const tables = minimalTransformedFont();
      return buildWoff2({ tables, compressed: brotliFont(Buffer.concat(tables.map((t) => t.data)).subarray(2)) });
    });

    fails('rejects a stream longer than the sizes of the directory', () => {
      const tables = minimalTransformedFont();
      return buildWoff2({ tables, compressed: brotliFont(Buffer.concat([...tables.map((t) => t.data), Buffer.from([1, 2, 3])])) });
    });

    it('stops a stream that expands far beyond the directory instead of inflating it', () => {
      const BOMB_BYTES = 64 * 1024 * 1024;
      const tables = minimalTransformedFont();
      const bomb = brotliFont(Buffer.alloc(BOMB_BYTES));
      const file = buildWoff2({ tables, compressed: bomb });
      const before = process.memoryUsage().arrayBuffers;
      expect(() => decodeWoff2(file, 'bomb')).toThrow(Woff2FormatError);
      expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(BOMB_BYTES / 4);
    });

    fails('rejects a corrupted Brotli stream', () => {
      const file = buildWoff2({ tables: minimalTransformedFont() });
      const corrupted = Buffer.from(file);
      corrupted.fill(0xff, corrupted.length - 12, corrupted.length - 4);
      return corrupted;
    });
  });

  describe('metadata and private data blocks', () => {
    it('accepts well formed blocks and ignores them', () => {
      const file = buildWoff2({
        tables: minimalTransformedFont(),
        meta: { length: brotliFont(Buffer.alloc(20)).length, origLength: 20 },
        priv: { data: Buffer.from('private') },
      });
      expect(decodeWoff2(file, 'blocks').tables['glyf'].data.equals(expectedGlyf)).toBe(true);
    });

    fails('rejects a metadata block that starts inside the font data', () =>
      buildWoff2({ tables: minimalTransformedFont(), meta: { offset: 60, length: 8, origLength: 20 } }));
    fails('rejects a metadata block that runs past the end of the file', () =>
      buildWoff2({ tables: minimalTransformedFont(), meta: { length: 4096, origLength: 20 } }));
    fails('rejects a private block that starts inside the font data', () =>
      buildWoff2({ tables: minimalTransformedFont(), priv: { offset: 50, data: Buffer.from('private') } }));
    fails('rejects bytes after the last block', () => {
      const file = Buffer.concat([buildWoff2({ tables: minimalTransformedFont() }), Buffer.alloc(8)]);
      file.writeUInt32BE(file.length, 8);
      return file;
    });
  });

  describe('glyf transform', () => {
    const withGlyf = (overrides: Parameters<typeof minimalTransformedFont>[0], origLength = TRIANGLE_GLYF_LENGTH): (() => Buffer) => () => {
      const tables = minimalTransformedFont(overrides);
      tables[0].origLength = origLength;
      return buildWoff2({ tables });
    };

    it('accepts the baseline these cases are derived from', () => {
      expect(decodeWoff2(withGlyf({})(), 'ok').tables['glyf'].data.equals(expectedGlyf)).toBe(true);
    });

    fails('rejects a version other than 0', withGlyf({ version: 1 }));
    fails('rejects reserved option flag bits', withGlyf({ optionFlags: 0x0002 }));
    fails('rejects an index format other than 0 and 1', withGlyf({ indexFormat: 2 }));
    fails('rejects a stream size table that does not add up to the table', withGlyf({ sizeOverrides: { glyph: 3 } }));
    fails('rejects a transformed table shorter than its header', () => {
      const tables = minimalTransformedFont();
      tables[0] = { ...tables[0], data: Buffer.alloc(20), transformLength: 20 };
      return buildWoff2({ tables });
    });
    fails('rejects nContour data of the wrong size', withGlyf({ nContour: [0, 1, 0] }));
    fails('rejects a flag stream that stops before the last point', withGlyf({ flags: [23, 21] }));
    fails('rejects a glyph stream that stops inside a coordinate triplet', withGlyf({ glyph: [0x99, 0x99] }));
    fails('rejects a point count stream that stops early', withGlyf({ nPoints: [] }));
    fails('rejects a glyph with more than 65536 points', withGlyf({ nPoints: u255(65535).concat(u255(2)), nContour: [0, 2] }), Woff2LimitError);
    fails('rejects a glyph with a negative contour count other than -1', withGlyf({ nContour: [0, -2] }));
    fails('rejects a contour without points', withGlyf({ nPoints: u255(0) }));
    fails('rejects an empty glyph that carries a bounding box', withGlyf({ bbox: [0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }));
    fails('rejects a composite glyph without an explicit bounding box', withGlyf({
      nContour: [0, -1],
      nPoints: [],
      flags: [],
      glyph: [],
      composite: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    }));
    fails('rejects a bounding box bitmap that is too small', withGlyf({ bbox: [0] }));
    fails('rejects coordinates outside the signed 16 bit range', withGlyf({
      nPoints: u255(2),
      // flag 127 is the four byte form with both steps positive: 0xFFFF each, past the int16 range
      flags: [127, 127],
      glyph: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0],
    }));
    fails('rejects instruction data that stops early', withGlyf({ glyph: [0x99, 0x99, 20, 5] }));
    it('takes the reconstructed glyf length, not the directory origLength, because encoders pack flags differently', () => {
      const glyf = decodeWoff2(withGlyf({}, 32)(), 'length').tables['glyf'].data;
      expect(glyf.equals(expectedGlyf)).toBe(true);
    });
    describe('a glyph larger than a short loca can address', () => {
      const POINTS = 36000;
      const STEP_HI = 0x3e;
      const STEP_LO = 0x80; // steps of +-16000 keep every coordinate inside the int16 range
      const GLYPH_HEADER_AND_COUNTS = 14; // 10 byte header, one end point, instruction length
      const BYTES_PER_POINT = 4; // two 16-bit coordinates; the identical flags run-length pack into 2 bytes per 256 points
      const FLAG_RUN = 256;
      const RECONSTRUCTED_BYTES = GLYPH_HEADER_AND_COUNTS + 2 * Math.ceil(POINTS / FLAG_RUN) + BYTES_PER_POINT * POINTS;
      const bigGlyph = (indexFormat: number): Buffer => {
        const flags: number[] = [];
        const glyph: number[] = [];
        for (let i = 0; i < POINTS; i++) {
          flags.push(i % 2 === 0 ? 127 : 124);
          glyph.push(STEP_HI, STEP_LO, STEP_HI, STEP_LO);
        }
        glyph.push(0);
        const tables = minimalTransformedFont({ indexFormat, nPoints: u255(POINTS), flags, glyph });
        tables[0].origLength = RECONSTRUCTED_BYTES;
        tables[4].origLength = indexFormat === 1 ? 12 : 6;
        return buildWoff2({ tables });
      };

      fails('rejects the glyph when loca uses 16 bit offsets', () => bigGlyph(0));

      it('decodes it when loca uses 32 bit offsets', () => {
        const font = decodeWoff2(bigGlyph(1), 'big');
        expect(font.tables['glyf'].data.length).toBe(RECONSTRUCTED_BYTES);
        expect(font.tables['loca'].data.readUInt32BE(8)).toBe(RECONSTRUCTED_BYTES);
      });
    });
    fails('rejects a glyph count that differs from maxp', () => {
      const tables = minimalTransformedFont();
      tables[5] = { tag: 'maxp', data: sfntMaxp(3) };
      return buildWoff2({ tables });
    });
    fails('rejects a loca length that differs from the reconstructed table', () => {
      const tables = minimalTransformedFont();
      tables[4].origLength = 8;
      return buildWoff2({ tables });
    });
    fails('rejects a transformed glyf without head', () => buildWoff2({ tables: minimalTransformedFont().filter((t) => t.tag !== 'head') }));
    fails('rejects a transformed glyf without maxp', () => buildWoff2({ tables: minimalTransformedFont().filter((t) => t.tag !== 'maxp') }));

    it('copies a composite glyph with its instructions and the explicit bounding box', () => {
      // glyph 1 is composite: component glyph 0 at offset (5, 6) with byte arguments, WE_HAVE_INSTRUCTIONS, 2 instruction bytes
      const COMPOSITE_FLAGS = 0x0100 | 0x0002; // WE_HAVE_INSTRUCTIONS | ARGS_ARE_XY_VALUES
      const COMPOSITE_BYTES = 20;
      const tables = minimalTransformedFont({
        nContour: [0, -1],
        nPoints: [],
        flags: [],
        glyph: [2],
        composite: [COMPOSITE_FLAGS >> 8, COMPOSITE_FLAGS & 0xff, 0, 0, 5, 6],
        bbox: [0x40, 0, 0, 0, 0, 1, 0, 2, 0, 3, 0, 4],
        instruction: [0xb0, 0x01],
      });
      tables[0].origLength = COMPOSITE_BYTES;
      const font = decodeWoff2(buildWoff2({ tables }), 'composite');
      expect(font.tables['glyf'].data.toString('hex')).toBe('ffff' + '0001000200030004' + '0102' + '0000' + '0506' + '0002' + 'b001');
    });

    it('sets the overlap flag of the glyphs the overlapSimple bitmap marks', () => {
      const tables = minimalTransformedFont({ optionFlags: 1, overlap: [0x40] });
      const glyf = decodeWoff2(buildWoff2({ tables }), 'overlap').tables['glyf'].data;
      const FIRST_FLAG_AT = 14; // 10 byte header, 2 byte end point, 2 byte instruction length, then the flags
      expect(glyf[FIRST_FLAG_AT]).toBe(0x37 | 0x40);
      expect(glyf[FIRST_FLAG_AT + 1]).toBe(0x17);
    });
  });

  describe('hmtx transform', () => {
    const hmtxFile = (flags: number, payload: number[], origLength = 8): Buffer => {
      const tables = minimalTransformedFont();
      tables[3] = { tag: 'hmtx', data: Buffer.from([flags, ...payload]), version: 1, origLength, transformLength: payload.length + 1 };
      return buildWoff2({ tables });
    };

    it('rebuilds lsb from the glyph bounding boxes when bit 0 is set', () => {
      // bits 0 and 1 set: neither lsb[] nor leftSideBearing[] is stored, only the two advance widths
      const font = decodeWoff2(hmtxFile(0b11, [0x01, 0xf4, 0x02, 0x58]), 'hmtx');
      // glyph 0 is empty (xMin 0), glyph 1 has xMin 0: both lsb values are 0
      expect(font.tables['hmtx'].data.toString('hex')).toBe('01f40000' + '02580000');
    });

    it('reads explicit lsb values when bit 0 is clear', () => {
      const font = decodeWoff2(hmtxFile(0b10, [0x01, 0xf4, 0x02, 0x58, 0x00, 0x07, 0xff, 0xfe]), 'hmtx');
      expect(font.tables['hmtx'].data.toString('hex')).toBe('01f40007' + '0258fffe');
    });

    fails('rejects flags that leave both side bearing arrays in place', () => hmtxFile(0b00, [0x01, 0xf4, 0x02, 0x58, 0, 0, 0, 0]));
    fails('rejects reserved flag bits', () => hmtxFile(0b100, [0x01, 0xf4, 0x02, 0x58]));
    fails('rejects a payload of the wrong size', () => hmtxFile(0b11, [0x01, 0xf4, 0x02]));
    fails('rejects an origLength different from the rebuilt table', () => hmtxFile(0b11, [0x01, 0xf4, 0x02, 0x58], 12));
    fails('rejects a numberOfHMetrics larger than the glyph count', () => {
      const tables = minimalTransformedFont();
      tables[2] = { tag: 'hhea', data: sfntHhea(3) };
      tables[3] = { tag: 'hmtx', data: Buffer.from([0b11, 0, 0, 0, 0, 0, 0]), version: 1, origLength: 8, transformLength: 7 };
      return buildWoff2({ tables });
    });
    fails('rejects a transformed hmtx without hhea', () => {
      const tables = minimalTransformedFont().filter((t) => t.tag !== 'hhea');
      tables[2] = { tag: 'hmtx', data: Buffer.from([0b11, 1, 0xf4, 2, 0x58]), version: 1, origLength: 8, transformLength: 5 };
      return buildWoff2({ tables });
    });
  });
});

function expectedGlyfBytes(): Buffer {
  return Buffer.alloc(TRIANGLE_GLYF_LENGTH);
}

function collectionFile(options: { version?: number; numFonts?: number; indices?: number[] }): Buffer {
  const indices = options.indices ?? [0, 1, 2, 3, 4, 5];
  const version = options.version ?? 0x00010000;
  const numFonts = options.numFonts ?? 1;
  const SFNT_TRUETYPE = [0x00, 0x01, 0x00, 0x00];
  const header = [version >>> 24, (version >> 16) & 0xff, (version >> 8) & 0xff, version & 0xff, ...u255(numFonts)];
  for (let i = 0; i < numFonts; i++) {
    header.push(...u255(indices.length), ...SFNT_TRUETYPE);
    for (const index of indices) header.push(...u255(index));
  }
  return buildWoff2({ flavor: 0x74746366, tables: minimalTransformedFont(), afterDirectory: header });
}
