import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import { convertFont, decodeSfnt, decodeWoff2, encodeWoff2, type ParsedFont } from '../src/lib/conversions/font';
import {
  WOFF2_BROTLI_MAX_QUALITY_BYTES,
  WOFF2_MAX_DECODED_BYTES,
  WOFF2_MAX_TABLES,
  Woff2FormatError,
  Woff2LimitError,
  woff2BrotliQuality,
} from '../src/lib/conversions/font-woff2';
import { readGlyf, readSfntTables } from './helpers/font-oracles';
import { sfntFromTables, sfntHead, sfntHhea, sfntMaxp } from './helpers/woff2-builder';
import { assertWoff2Consistent, firstFlagOffset, readWoff2Reference, SFNT_FLAG_OVERLAP_SIMPLE } from './helpers/woff2-reference';

/**
 * Encoder conformance against the W3C WOFF2 Recommendation. Expected values come from the
 * reference encoder output in tests/fixtures/woff2 (PROVENANCE.txt), from a hand-written table of
 * known-tag indices, and from the independent test-side reader in tests/helpers/woff2-reference.ts.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'woff2');
const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

const HEAD_ADJUSTMENT_OFFSET = 8;
const HEAD_FLAGS_OFFSET = 16;
const HEAD_FLAGS_LOSSLESS_TRANSFORM = 0x0800; // bit 11
const HEAD_INDEX_TO_LOC_OFFSET = 50;
const RINGS_GLYPH = 7; // the glyph of synthetic-triplets that carries the overlap bit
const BROTLI_FAST_QUALITY = 5;

interface Source {
  label: string;
  file: string;
  reference: string;
  referenceDecoded: string;
  /** glyph whose overlap bit fontTools-style bitmaps carry but the 1.0.2 reference decoder drops */
  overlapGlyph: number | null;
}

const DEJAVU_SANS: Source = {
  label: 'dejavu-sans-latin',
  file: 'dejavu-sans-latin.ttf',
  reference: 'dejavu-sans-latin.reference.woff2',
  referenceDecoded: 'dejavu-sans-latin.reference-decoded.ttf',
  overlapGlyph: null,
};
const DEJAVU_SERIF: Source = {
  label: 'dejavu-serif-hinted-ascii',
  file: 'dejavu-serif-hinted-ascii.ttf',
  reference: 'dejavu-serif-hinted-ascii.reference.woff2',
  referenceDecoded: 'dejavu-serif-hinted-ascii.reference-decoded.ttf',
  overlapGlyph: null,
};
const TRIPLETS: Source = {
  label: 'synthetic-triplets',
  file: 'synthetic-triplets.ttf',
  reference: 'synthetic-triplets.reference.woff2',
  referenceDecoded: 'synthetic-triplets.reference-decoded.ttf',
  overlapGlyph: RINGS_GLYPH,
};
const CFF: Source = {
  label: 'synthetic-cff',
  file: 'synthetic-cff.otf',
  reference: 'synthetic-cff.reference.woff2',
  referenceDecoded: 'synthetic-cff.reference-decoded.otf',
  overlapGlyph: null,
};
const TRUETYPE_SOURCES = [DEJAVU_SANS, DEJAVU_SERIF, TRIPLETS];
const ALL_SOURCES = [...TRUETYPE_SOURCES, CFF];
/** Fonts without overlap flags, whose transformed glyf stream the 1.0.2 reference encoder reproduces exactly. */
const STREAM_COMPARABLE_SOURCES = [DEJAVU_SANS, DEJAVU_SERIF];

/** Known tag indices of the Recommendation for the tags the fixtures use, written out by hand. */
const KNOWN_INDEX: Record<string, number> = {
  cmap: 0, head: 1, hhea: 2, hmtx: 3, maxp: 4, name: 5, 'OS/2': 6, post: 7, 'cvt ': 8, fpgm: 9, glyf: 10,
  loca: 11, prep: 12, 'CFF ': 13, gasp: 17, GDEF: 26, GPOS: 27, GSUB: 28, EBSC: 29, MATH: 31, bloc: 41,
};
const EXPLICIT_TAG = 63;
/** hhea.numberOfHMetrics is the last field, at offset 34; the table is 36 bytes. */
const HHEA_NUMBER_OF_H_METRICS_END = 36;

function encodeFixture(name: string): Buffer {
  return encodeWoff2(decodeSfnt(fixture(name), name));
}

function referenceFileFor(name: string): string {
  return name.replace(/\.(ttf|otf)$/, '.reference.woff2');
}

/** Replaces the checkSumAdjustment of head, which depends on the table order and is checked on its own. */
function maskAdjustment(tables: Map<string, Buffer>): Map<string, Buffer> {
  const masked = new Map(tables);
  const head = Buffer.from(masked.get('head')!);
  head.writeUInt32BE(0, HEAD_ADJUSTMENT_OFFSET);
  masked.set('head', head);
  return masked;
}

function tablesOf(font: ParsedFont): Map<string, Buffer> {
  return new Map(Object.entries(font.tables).map(([tag, table]) => [tag, table.data]));
}

function expectSameTables(actual: Map<string, Buffer>, expected: Map<string, Buffer>): void {
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [tag, data] of expected) expect(actual.get(tag)!.equals(data), `table '${tag}'`).toBe(true);
}

/** The reference decoder drops the overlap bit the fontTools-style bitmap carries; clear it on both sides to compare. */
function withoutOverlapBit(tables: Map<string, Buffer>, glyphId: number): Map<string, Buffer> {
  const glyf = Buffer.from(tables.get('glyf')!);
  glyf[firstFlagOffset(tables, glyphId)] &= ~SFNT_FLAG_OVERLAP_SIMPLE;
  return new Map(tables).set('glyf', glyf);
}

function clearForComparison(tables: Map<string, Buffer>, source: Source): Map<string, Buffer> {
  const cleared = source.overlapGlyph === null ? tables : withoutOverlapBit(tables, source.overlapGlyph);
  return maskAdjustment(cleared);
}

function isComposite(tables: Map<string, Buffer>, glyphId: number): boolean {
  const loca = tables.get('loca')!;
  const long = tables.get('head')!.readInt16BE(HEAD_INDEX_TO_LOC_OFFSET) === 1;
  const start = long ? loca.readUInt32BE(glyphId * 4) : loca.readUInt16BE(glyphId * 2) * 2;
  const end = long ? loca.readUInt32BE(glyphId * 4 + 4) : loca.readUInt16BE(glyphId * 2 + 2) * 2;
  return end > start && tables.get('glyf')!.readInt16BE(start) < 0;
}

describe.each(ALL_SOURCES)('WOFF2 encoder: $label', (source) => {
  const original = readSfntTables(fixture(source.file));
  const woff2 = encodeFixture(source.file);
  const reading = readWoff2Reference(woff2);
  const reference = readWoff2Reference(fixture(source.reference));

  it('writes a header that agrees with the file', () => {
    expect(woff2.toString('latin1', 0, 4)).toBe('wOF2');
    expect(reading.header.flavor).toBe(fixture(source.file).readUInt32BE(0));
    expect(reading.header.length).toBe(woff2.length);
    expect(woff2.length % 4).toBe(0);
    expect(reading.header.numTables).toBe(reading.directory.length);
    expect(reading.header.reserved).toBe(0);
    expect(reading.header.metaOffset + reading.header.metaLength + reading.header.metaOrigLength).toBe(0);
    expect(reading.header.privOffset + reading.header.privLength).toBe(0);
    // compressedEnd = directory end + totalCompressedSize; only the padding to four bytes may follow it
    expect(woff2.length - reading.compressedEnd).toBeGreaterThanOrEqual(0);
    expect(woff2.length - reading.compressedEnd).toBeLessThan(4);
  });

  it('announces the size of the reconstructed sfnt: header, directory and padded tables', () => {
    let size = 12 + 16 * reading.directory.length;
    for (const row of reading.directory) size += Math.ceil(row.origLength / 4) * 4;
    expect(reading.header.totalSfntSize).toBe(size);
  });

  it('lists the tables in ascending tag order with the known-tag flags of the Recommendation', () => {
    const tags = reading.directory.map((row) => row.tag);
    expect(tags).toEqual([...tags].sort());
    for (const row of reading.directory) {
      const known = KNOWN_INDEX[row.tag];
      expect(row.flags & 0x3f, `tag index of '${row.tag}'`).toBe(known === undefined ? EXPLICIT_TAG : known);
    }
  });

  it('stores tables as the Brotli stream the directory describes', () => {
    expect(reading.stream.length).toBe(reading.directory.reduce((sum, row) => sum + row.storedLength, 0));
  });

  it('sets bit 11 of head.flags to announce a lossless modifying transform', () => {
    const flags = reading.tables.get('head')!.readUInt16BE(HEAD_FLAGS_OFFSET);
    expect(flags & HEAD_FLAGS_LOSSLESS_TRANSFORM).toBe(HEAD_FLAGS_LOSSLESS_TRANSFORM);
    expect(flags & ~HEAD_FLAGS_LOSSLESS_TRANSFORM).toBe(original.get('head')!.readUInt16BE(HEAD_FLAGS_OFFSET) & ~HEAD_FLAGS_LOSSLESS_TRANSFORM);
  });

  it('rebuilds the tables the reference encoder rebuilds, glyph for glyph', () => {
    expectSameTables(clearForComparison(reading.tables, source), clearForComparison(reference.tables, source));
  });

  it('keeps every table except glyf, loca and head byte for byte', () => {
    for (const [tag, data] of original) {
      if (tag === 'glyf' || tag === 'loca' || tag === 'head') continue;
      expect(reading.tables.get(tag)!.equals(data), `table '${tag}'`).toBe(true);
    }
    const head = Buffer.from(reading.tables.get('head')!);
    const sourceHead = Buffer.from(original.get('head')!);
    for (const buffer of [head, sourceHead]) {
      buffer.writeUInt32BE(0, HEAD_ADJUSTMENT_OFFSET);
      buffer.writeUInt16BE(0, HEAD_FLAGS_OFFSET);
    }
    expect(head.equals(sourceHead)).toBe(true);
  });

  it('decodes with this engine to the font the reference decoder produces', () => {
    const decoded = tablesOf(decodeWoff2(woff2, 'fixture'));
    const referenceDecoded = readSfntTables(fixture(source.referenceDecoded));
    expectSameTables(clearForComparison(decoded, source), clearForComparison(new Map(referenceDecoded), source));
  });

  it('is stable: encoding the decoded font again gives the same file', () => {
    const again = encodeWoff2(decodeWoff2(woff2, 'fixture'));
    assertWoff2Consistent(again);
    expect(again.equals(woff2)).toBe(true);
  });
});

describe.each(TRUETYPE_SOURCES)('WOFF2 encoder glyf and loca transform: $label', (source) => {
  const original = readSfntTables(fixture(source.file));
  const woff2 = encodeFixture(source.file);
  const reading = readWoff2Reference(woff2);

  it('transforms glyf and loca (version 0) per the Recommendation', () => {
    const glyf = reading.directory.find((row) => row.tag === 'glyf');
    const loca = reading.directory.find((row) => row.tag === 'loca');
    expect(glyf?.version).toBe(0);
    expect(glyf?.transformLength).toBeGreaterThan(0);
    expect(glyf?.origLength).toBe(reading.tables.get('glyf')!.length);
    expect(loca?.version).toBe(0);
    expect(loca?.transformLength).toBe(0);
    const numGlyphs = original.get('maxp')!.readUInt16BE(4);
    const entry = reading.tables.get('head')!.readInt16BE(HEAD_INDEX_TO_LOC_OFFSET) === 1 ? 4 : 2;
    expect(loca?.origLength).toBe((numGlyphs + 1) * entry);
  });

  it('preserves the outlines of every simple glyph', () => {
    const decoded = tablesOf(decodeWoff2(woff2, 'fixture'));
    const count = original.get('maxp')!.readUInt16BE(4);
    let compared = 0;
    for (let id = 0; id < count; id++) {
      if (isComposite(original, id)) continue;
      expect(readGlyf(decoded, id), `glyph ${id}`).toEqual(readGlyf(original, id));
      compared++;
    }
    expect(compared).toBeGreaterThan(5);
  });
});

const COMPOSITE_SOURCES = [DEJAVU_SANS, TRIPLETS];

describe.each(COMPOSITE_SOURCES)('WOFF2 encoder composite glyphs: $label', (source) => {
  const original = readSfntTables(fixture(source.file));
  const woff2 = encodeFixture(source.file);

  it('keeps composite glyph records, with their instructions, byte for byte', () => {
    const decoded = tablesOf(decodeWoff2(woff2, 'fixture'));
    const count = original.get('maxp')!.readUInt16BE(4);
    const at = (tables: Map<string, Buffer>, id: number): [number, number] => {
      const loca = tables.get('loca')!;
      const long = tables.get('head')!.readInt16BE(HEAD_INDEX_TO_LOC_OFFSET) === 1;
      return long ? [loca.readUInt32BE(id * 4), loca.readUInt32BE(id * 4 + 4)] : [loca.readUInt16BE(id * 2) * 2, loca.readUInt16BE(id * 2 + 2) * 2];
    };
    let composites = 0;
    for (let id = 0; id < count; id++) {
      if (!isComposite(original, id)) continue;
      const [from, to] = at(original, id);
      const [decodedFrom, decodedTo] = at(decoded, id);
      const expected = original.get('glyf')!.subarray(from, to);
      const actual = decoded.get('glyf')!.subarray(decodedFrom, decodedTo);
      expect(actual.subarray(0, expected.length).equals(expected), `composite glyph ${id}`).toBe(true);
      composites++;
    }
    expect(composites).toBeGreaterThan(0);
  });
});

describe.each(STREAM_COMPARABLE_SOURCES)('WOFF2 encoder against the reference encoder: $label', (source) => {
  it('produces the same transformed glyf stream', () => {
    const ours = readWoff2Reference(encodeFixture(source.file));
    const theirs = readWoff2Reference(fixture(source.reference));
    expect(ours.stored.get('glyf')!.equals(theirs.stored.get('glyf')!)).toBe(true);
  });
});

describe('WOFF2 encoder: a font with CFF outlines', () => {
  it('has no glyf or loca to transform and stores every table as is', () => {
    const reading = readWoff2Reference(encodeFixture(CFF.file));
    expect(reading.directory.map((row) => row.tag)).toContain('CFF ');
    expect(reading.directory.every((row) => row.version === 0 && row.transformLength === undefined)).toBe(true);
  });
});

describe('WOFF2 encoder: specific encodings', () => {
  it('sets the overlap bitmap flag and the overlap bit when a glyph carries it', () => {
    const file = encodeFixture('synthetic-triplets.ttf');
    const reading = assertWoff2Consistent(file);
    expect(reading.stored.get('glyf')!.readUInt16BE(2) & 1).toBe(1);
    const decoded = tablesOf(decodeWoff2(file, 'fixture'));
    expect(decoded.get('glyf')![firstFlagOffset(decoded, RINGS_GLYPH)] & SFNT_FLAG_OVERLAP_SIMPLE).toBe(SFNT_FLAG_OVERLAP_SIMPLE);
  });

  it('emits no overlap bitmap when no glyph needs it', () => {
    const reading = readWoff2Reference(encodeFixture('dejavu-serif-hinted-ascii.ttf'));
    expect(reading.stored.get('glyf')!.readUInt16BE(2)).toBe(0);
  });

  it('applies the hmtx transform (version 1) when side bearings equal xMin, as the fontTools encoder decides', () => {
    for (const name of ['dejavu-sans-latin.ttf', 'synthetic-triplets.ttf']) {
      const row = readWoff2Reference(encodeFixture(name)).directory.find((r) => r.tag === 'hmtx')!;
      const fontTools = readWoff2Reference(fixture(name.replace('.ttf', '.fonttools-hmtx.woff2'))).directory.find((r) => r.tag === 'hmtx')!;
      expect(row.version).toBe(1);
      expect(row.version).toBe(fontTools.version);
      expect(row.transformLength).toBe(fontTools.transformLength);
      expect(row.origLength).toBe(fontTools.origLength);
    }
  });

  it('leaves hmtx stored when both side bearing arrays are needed', () => {
    const tables = readSfntTables(fixture('synthetic-triplets.ttf'));
    const hmtx = Buffer.from(tables.get('hmtx')!);
    const numHMetrics = tables.get('hhea')!.readUInt16BE(34);
    const numGlyphs = tables.get('maxp')!.readUInt16BE(4);
    expect(numHMetrics).toBeLessThan(numGlyphs); // the font has a monospaced tail
    hmtx.writeInt16BE(hmtx.readInt16BE(numHMetrics * 4) + 7, numHMetrics * 4); // break a tail bearing...
    hmtx.writeInt16BE(hmtx.readInt16BE(2) + 7, 2); // ...and a proportional one
    tables.set('hmtx', hmtx);
    const file = encodeWoff2(decodeSfnt(sfntFromTables(0x00010000, tables), 'x'));
    const row = assertWoff2Consistent(file).directory.find((r) => r.tag === 'hmtx')!;
    expect(row.version).toBe(0);
    expect(row.transformLength).toBeUndefined();
    expect(decodeWoff2(file, 'x').tables['hmtx'].data.equals(hmtx)).toBe(true);
  });

  it('names tables outside the known list with an explicit tag and drops DSIG', () => {
    const tables = readSfntTables(fixture('dejavu-serif-hinted-ascii.ttf'));
    tables.set('ZZZZ', Buffer.from('custom table'));
    tables.set('DSIG', Buffer.alloc(8));
    tables.set('bloc', Buffer.alloc(16));
    const file = encodeWoff2(decodeSfnt(sfntFromTables(0x00010000, tables), 'x'));
    const reading = assertWoff2Consistent(file);
    const row = (tag: string) => reading.directory.find((r) => r.tag === tag);
    expect(row('DSIG')).toBeUndefined();
    expect(row('ZZZZ')!.flags & 0x3f).toBe(EXPLICIT_TAG);
    expect(row('bloc')!.flags & 0x3f).toBe(41);
    expect(reading.tables.get('ZZZZ')!.toString('latin1')).toBe('custom table');
    expect(reading.header.numTables).toBe(reading.directory.length);
    expect(reading.directory.length).toBe(tables.size - 1);
  });

  it('compresses at least as tightly as the reference encoder', () => {
    const ours = encodeFixture('dejavu-serif-hinted-ascii.ttf');
    const theirs = fixture('dejavu-serif-hinted-ascii.reference.woff2');
    expect(ours.length).toBeLessThanOrEqual(theirs.length);
  });

  it('uses the strongest Brotli setting rather than a fast one', () => {
    const reading = readWoff2Reference(encodeFixture('dejavu-serif-hinted-ascii.ttf'));
    const fast = brotliCompressSync(reading.stream, {
      params: { [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_FONT, [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_FAST_QUALITY },
    });
    expect(reading.header.totalCompressedSize).toBeLessThan(fast.length);
    expect(brotliDecompressSync(fast).equals(reading.stream)).toBe(true);
  });

  it('writes the same file through convertFont as through the codec', async () => {
    const result = await convertFont(fixture('dejavu-sans-latin.ttf'), 'ttf', 'woff2', {}, 'dejavu.ttf');
    expect(result.mimeType).toBe('font/woff2');
    expect(result.buffer.equals(encodeFixture('dejavu-sans-latin.ttf'))).toBe(true);
  });

  it('converts WOFF2 to WOFF2 through the decoder and the encoder without changing the file', async () => {
    const result = await convertFont(fixture('dejavu-serif-hinted-ascii.reference.woff2'), 'woff2', 'woff2', {}, 'serif.woff2');
    const before = readWoff2Reference(fixture('dejavu-serif-hinted-ascii.reference.woff2')).tables;
    const after = readWoff2Reference(result.buffer).tables;
    expectSameTables(maskAdjustment(after), maskAdjustment(before));
  });
});

describe('WOFF2 encoder: glyf edge cases', () => {
  const TRIANGLE = '0001' + '0000' + '0000' + '0014' + '000a' + '0002' + '0000' + '371723' + '0a0a14' + '0a0a'; // 22 bytes

  /** A font whose glyph n is the triangle with n * 4 + extra instruction bytes; glyph 0 is empty. */
  function fontWithGlyphs(glyphs: Buffer[], indexToLocFormat: number, overrides: Record<string, Buffer | null> = {}): ParsedFont {
    const count = glyphs.length;
    const glyf = Buffer.concat(glyphs.map((g) => Buffer.concat([g, Buffer.alloc(indexToLocFormat === 1 ? (4 - (g.length % 4)) % 4 : g.length % 2)])));
    const loca = Buffer.alloc((count + 1) * (indexToLocFormat === 1 ? 4 : 2));
    let offset = 0;
    for (let i = 0; i <= count; i++) {
      if (indexToLocFormat === 1) loca.writeUInt32BE(offset, i * 4);
      else loca.writeUInt16BE(offset / 2, i * 2);
      if (i < count) offset += glyphs[i].length + (indexToLocFormat === 1 ? (4 - (glyphs[i].length % 4)) % 4 : glyphs[i].length % 2);
    }
    const hmtx = Buffer.alloc(count * 4);
    const tables = new Map<string, Buffer>([
      ['head', sfntHead(indexToLocFormat)],
      ['hhea', sfntHhea(count)],
      ['hmtx', hmtx],
      ['maxp', sfntMaxp(count)],
      ['glyf', glyf],
      ['loca', loca],
    ]);
    for (const [tag, data] of Object.entries(overrides)) {
      if (data === null) tables.delete(tag);
      else tables.set(tag, data);
    }
    return decodeSfnt(sfntFromTables(0x00010000, tables), 'edge');
  }

  /** The triangle with extra instruction bytes (and so a different length). */
  function triangle(extraInstructions = 0): Buffer {
    const base = Buffer.from(TRIANGLE, 'hex');
    const instructionLengthAt = 12; // after the 10 byte header and the one end point
    const withInstructions = Buffer.concat([base.subarray(0, instructionLengthAt + 2), Buffer.alloc(extraInstructions, 0x00), base.subarray(instructionLengthAt + 2)]);
    withInstructions.writeUInt16BE(extraInstructions, instructionLengthAt);
    return withInstructions;
  }

  it('preserves a glyph whose stored bounding box differs from its points', () => {
    const odd = triangle();
    odd.writeInt16BE(-50, 2); // xMin
    odd.writeInt16BE(900, 8); // yMax
    const font = fontWithGlyphs([Buffer.alloc(0), odd], 0);
    const file = encodeWoff2(font);
    assertWoff2Consistent(file);
    const decoded = tablesOf(decodeWoff2(file, 'x'));
    const box = decoded.get('glyf')!.subarray(2, 10);
    expect([box.readInt16BE(0), box.readInt16BE(2), box.readInt16BE(4), box.readInt16BE(6)]).toEqual([-50, 0, 20, 900]);
  });

  it('records the 32-bit loca format of the source', () => {
    const font = fontWithGlyphs([Buffer.alloc(0), triangle(), triangle(1)], 1);
    const file = encodeWoff2(font);
    const reading = assertWoff2Consistent(file);
    expect(reading.stored.get('glyf')!.readUInt16BE(6)).toBe(1);
    expect(reading.directory.find((r) => r.tag === 'loca')!.origLength).toBe(16);
    expect(decodeWoff2(file, 'x').tables['head'].data.readInt16BE(HEAD_INDEX_TO_LOC_OFFSET)).toBe(1);
  });

  it('switches to the 32-bit loca format when four-byte glyph alignment outgrows 16-bit offsets', () => {
    const ODD_GLYPH_INSTRUCTIONS = 108; // 22 + 108 = 130 bytes: even, so a short loca fits, but 132 once padded to four
    const GLYPHS = 1000; // 130 000 bytes unpadded (below the 131 070 limit), 132 000 padded
    const glyphs = [Buffer.alloc(0), ...Array.from({ length: GLYPHS - 1 }, () => triangle(ODD_GLYPH_INSTRUCTIONS))];
    const font = fontWithGlyphs(glyphs, 0);
    expect(font.tables['glyf'].data.length).toBeLessThan(0x1fffe);
    const file = encodeWoff2(font);
    const reading = assertWoff2Consistent(file);
    expect(reading.stored.get('glyf')!.readUInt16BE(6)).toBe(1);
    const decoded = tablesOf(decodeWoff2(file, 'x'));
    expect(decoded.get('head')!.readInt16BE(HEAD_INDEX_TO_LOC_OFFSET)).toBe(1);
    expect(decoded.get('loca')!.length).toBe((GLYPHS + 1) * 4);
    expect(readGlyf(decoded, GLYPHS - 1)).toEqual(readGlyf(tablesOf(font), GLYPHS - 1));
  });

  it('stores a zero-contour glyph with an all-zero box as the empty glyph it draws', () => {
    const font = fontWithGlyphs([Buffer.alloc(0), Buffer.alloc(10)], 0);
    const file = encodeWoff2(font);
    const decoded = tablesOf(decodeWoff2(file, 'x'));
    expect(assertWoff2Consistent(file).directory.find((r) => r.tag === 'glyf')!.origLength).toBe(0);
    expect(decoded.get('loca')!.toString('hex')).toBe('000000000000');
  });

  it('encodes a single empty glyph', () => {
    const font = fontWithGlyphs([Buffer.alloc(0)], 0);
    const file = encodeWoff2(font);
    assertWoff2Consistent(file);
    const decoded = tablesOf(decodeWoff2(file, 'x'));
    expect(decoded.get('glyf')!.length).toBe(0);
    expect(decoded.get('loca')!.length).toBe(4);
  });

  const fails = (label: string, make: () => ParsedFont, error: typeof Woff2FormatError = Woff2FormatError): void => {
    it(label, () => {
      expect(() => encodeWoff2(make())).toThrow(error);
    });
  };

  describe('rejects fonts the transform cannot represent', () => {
    fails('glyf without loca', () => fontWithGlyphs([Buffer.alloc(0), triangle()], 0, { loca: null }));
    fails('loca without glyf', () => fontWithGlyphs([Buffer.alloc(0), triangle()], 0, { glyf: null }));
    fails('glyf without head', () => fontWithGlyphs([Buffer.alloc(0), triangle()], 0, { head: null }));
    fails('glyf without maxp', () => fontWithGlyphs([Buffer.alloc(0), triangle()], 0, { maxp: null }));
    fails('a head table too short for indexToLocFormat', () => fontWithGlyphs([Buffer.alloc(0), triangle()], 0, { head: Buffer.alloc(40) }));
    fails('an unknown indexToLocFormat', () => fontWithGlyphs([Buffer.alloc(0), triangle()], 0, { head: sfntHead(2) }));
    fails('a loca table shorter than the glyph count needs', () => fontWithGlyphs([Buffer.alloc(0), triangle()], 0, { loca: Buffer.alloc(4) }));
    fails('decreasing loca offsets', () => {
      const loca = Buffer.alloc(6);
      loca.writeUInt16BE(11, 2);
      loca.writeUInt16BE(5, 4);
      return fontWithGlyphs([Buffer.alloc(0), triangle()], 0, { loca });
    });
    fails('a loca offset past the end of glyf', () => {
      const loca = Buffer.alloc(6);
      loca.writeUInt16BE(500, 4);
      return fontWithGlyphs([Buffer.alloc(0), triangle()], 0, { loca });
    });
    fails('a glyph shorter than its header', () => fontWithGlyphs([Buffer.alloc(0), Buffer.alloc(6, 1)], 0));
    fails('a glyph whose end points do not increase', () => {
      const twoContours = Buffer.concat([Buffer.from('0002' + '0000000000000000' + '0005' + '0003' + '0000', 'hex'), Buffer.alloc(16)]);
      return fontWithGlyphs([Buffer.alloc(0), twoContours], 0);
    });
    fails('a glyph whose flags stop before the last point', () => {
      const FLAGS_AT = 14;
      const glyph = triangle().subarray(0, FLAGS_AT + 2); // two of the three flags
      return fontWithGlyphs([Buffer.alloc(0), glyph], 0);
    });
    fails('a glyph whose repeat count runs past its last point', () => {
      const glyph = triangle();
      const FLAGS_AT = 14;
      glyph[FLAGS_AT] |= 0x08; // the first flag repeats...
      glyph[FLAGS_AT + 1] = 200; // ...200 times, for three points
      return fontWithGlyphs([Buffer.alloc(0), glyph], 0);
    });
    fails('a glyph whose instructions run past the glyph', () => {
      const glyph = triangle();
      glyph.writeUInt16BE(500, 12);
      return fontWithGlyphs([Buffer.alloc(0), glyph], 0);
    });
    it('compresses at the highest quality up to the large-font bound, then at a faster one', () => {
      expect(woff2BrotliQuality(WOFF2_BROTLI_MAX_QUALITY_BYTES)).toBe(zlibConstants.BROTLI_MAX_QUALITY);
      expect(woff2BrotliQuality(WOFF2_BROTLI_MAX_QUALITY_BYTES + 1)).toBeLessThan(zlibConstants.BROTLI_MAX_QUALITY);
    });
    fails('an hhea table too short for numberOfHMetrics', () =>
      fontWithGlyphs([Buffer.alloc(0), triangle()], 0, { hhea: sfntHhea(2).subarray(0, HHEA_NUMBER_OF_H_METRICS_END - 1) })
    );
    it('names the limit for a contour of more than 65535 points', () => {
      const POINTS = 65536;
      const FLAGS_PER_RUN = 256; // a flag byte plus a repeat count of 255
      // on curve, repeated, x and y both "same", so the points carry no coordinate bytes
      const SAME_XY_REPEATED_ON_CURVE = 0x39;
      const header = Buffer.alloc(14);
      header.writeInt16BE(1, 0);
      header.writeUInt16BE(POINTS - 1, 10);
      const flags = Buffer.alloc((POINTS / FLAGS_PER_RUN) * 2);
      for (let i = 0; i < flags.length; i += 2) {
        flags[i] = SAME_XY_REPEATED_ON_CURVE;
        flags[i + 1] = FLAGS_PER_RUN - 1;
      }
      const font = fontWithGlyphs([Buffer.alloc(0), Buffer.concat([header, flags])], 1);
      expect(() => encodeWoff2(font)).toThrow(/more than 65535 points/);
    });
    fails('a zero-contour glyph that carries a bounding box', () => {
      const zeroContours = Buffer.alloc(12); // numberOfContours 0, then a box of (5, 5, 10, 10)
      zeroContours.writeInt16BE(5, 2);
      zeroContours.writeInt16BE(5, 4);
      zeroContours.writeInt16BE(10, 6);
      zeroContours.writeInt16BE(10, 8);
      return fontWithGlyphs([Buffer.alloc(0), zeroContours], 0);
    });
    fails('a glyph that declares an unsupported negative contour count', () => {
      const glyph = triangle();
      glyph.writeInt16BE(-2, 0);
      return fontWithGlyphs([Buffer.alloc(0), glyph], 0);
    });
    fails('a composite glyph cut short', () => {
      const composite = Buffer.concat([Buffer.from('ffff00000000000a000a', 'hex'), Buffer.from('002100', 'hex')]);
      return fontWithGlyphs([Buffer.alloc(0), composite], 0);
    });
    fails('a composite glyph that refers to a missing glyph', () => {
      const composite = Buffer.concat([Buffer.from('ffff00000000000a000a', 'hex'), Buffer.from('0002' + '0009' + '0000', 'hex')]);
      return fontWithGlyphs([Buffer.alloc(0), composite], 0);
    });
  });

  describe('rejects fonts that cannot be written as WOFF2', () => {
    fails('a font without tables', () => ({ sfntVersion: 0x00010000, flavor: 'TrueType', numTables: 0, tables: {}, fontFamily: 'x' }));
    fails('a head table that is not 54 bytes', () => {
      const font = fontWithGlyphs([Buffer.alloc(0), triangle()], 0);
      font.tables['head'] = { tag: 'head', checkSum: 0, offset: 0, length: 55, data: Buffer.alloc(55) };
      return font;
    });
    fails('a table tag with a non-printable character', () => {
      const font = fontWithGlyphs([Buffer.alloc(0), triangle()], 0);
      font.tables['bad\u0001'] = { tag: 'bad\u0001', checkSum: 0, offset: 0, length: 1, data: Buffer.alloc(1) };
      return font;
    });
    fails('more tables than the engine limit', () => {
      const font = fontWithGlyphs([Buffer.alloc(0), triangle()], 0);
      for (let i = 0; i <= WOFF2_MAX_TABLES; i++) {
        const tag = `T${i.toString(36).padStart(3, '0').toUpperCase()}`;
        font.tables[tag] = { tag, checkSum: 0, offset: 0, length: 1, data: Buffer.alloc(1) };
      }
      return font;
    }, Woff2LimitError);
    fails('more table data than the engine limit', () => {
      const font = fontWithGlyphs([Buffer.alloc(0), triangle()], 0);
      const data = Buffer.alloc(WOFF2_MAX_DECODED_BYTES + 1);
      font.tables['ZZZZ'] = { tag: 'ZZZZ', checkSum: 0, offset: 0, length: data.length, data };
      return font;
    }, Woff2LimitError);
  });
});
