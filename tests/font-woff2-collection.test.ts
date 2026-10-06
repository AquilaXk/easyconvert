import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeWoff2, decodeWoff2Collection } from '../src/lib/conversions/font';
import {
  decodeWoff2Fonts,
  WOFF2_MAX_COLLECTION_BYTES,
  WOFF2_MAX_DECODED_BYTES,
  WOFF2_MAX_FONTS,
  Woff2FormatError,
  Woff2LimitError,
} from '../src/lib/conversions/font-woff2';
import {
  brotliFont,
  buildWoff2,
  collectionHeader,
  COLLECTION_FLAVOR,
  collectionTables,
  minimalTransformedFont,
  sfntHhea,
  type Woff2TableSpec,
} from './helpers/woff2-builder';
import { readWoff2Reference } from './helpers/woff2-reference';

/**
 * Collection and sharing rules of the W3C WOFF2 Recommendation: the glyf and loca of a font are adjacent
 * directory entries, and tables shared between fonts are decoded without multiplying their size.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'woff2');
const MIB = 1024 * 1024;
const HEAD_BYTES = 54;
const COLLECTION_VERSION_BYTES = 4;
const FLAVOR_BYTES = 4;

function collectionFile(tables: Woff2TableSpec[], fonts: Array<{ indices: number[] }>): Buffer {
  return buildWoff2({ flavor: COLLECTION_FLAVOR, tables, afterDirectory: collectionHeader(fonts) });
}

/** Offsets in a WOFF2 file of the one-byte table indices of each font of a collection (indices below 253). */
function fontIndexOffsets(woff2: Buffer): number[][] {
  const reading = readWoff2Reference(woff2);
  let at = reading.directoryEnd + COLLECTION_VERSION_BYTES;
  const numFonts = woff2[at++];
  const offsets: number[][] = [];
  for (let font = 0; font < numFonts; font++) {
    const count = woff2[at++];
    at += FLAVOR_BYTES;
    offsets.push(Array.from({ length: count }, (_, i) => at + i));
    at += count;
  }
  return offsets;
}

describe('WOFF2 collection: glyf and loca pairing', () => {
  const pair = fs.readFileSync(path.join(FIXTURES, 'pair.google.woff2'));
  const directory = readWoff2Reference(pair).directory;

  /** Points the given table of font `font` at directory entry `index`. */
  function retarget(font: number, tag: string, index: number): Buffer {
    const offsets = fontIndexOffsets(pair)[font];
    const mutated = Buffer.from(pair);
    const slot = offsets.find((offset) => directory[pair[offset]].tag === tag)!;
    mutated[slot] = index;
    return mutated;
  }

  const fontEntries = (font: number): number[] => fontIndexOffsets(pair)[font].map((offset) => pair[offset]);
  const indexOf = (font: number, tag: string): number => fontEntries(font).find((i) => directory[i].tag === tag)!;

  it('decodes the unmodified Google collection', () => {
    expect(decodeWoff2Collection(pair, 'pair')).toHaveLength(2);
    expect(indexOf(0, 'loca')).toBe(indexOf(0, 'glyf') + 1);
    expect(indexOf(1, 'loca')).toBe(indexOf(1, 'glyf') + 1);
  });

  it('rejects a font whose loca belongs to another font', () => {
    const mutated = retarget(1, 'loca', indexOf(0, 'loca'));
    expect(() => decodeWoff2Collection(mutated, 'pair')).toThrow(Woff2FormatError);
    expect(() => decodeWoff2Collection(mutated, 'pair')).toThrow(/loca/);
  });

  it('rejects a font whose glyf belongs to another font', () => {
    const mutated = retarget(1, 'glyf', indexOf(0, 'glyf'));
    expect(() => decodeWoff2Collection(mutated, 'pair')).toThrow(Woff2FormatError);
  });

  it('rejects glyf and loca that are not adjacent directory entries', () => {
    // glyf 0, head 1, loca 2: transformed and complete, but loca does not follow glyf directly
    const tables = collectionTables();
    const reordered = [tables[0], tables[2], tables[1], tables[3], tables[4], tables[5]];
    const file = collectionFile(reordered, [{ indices: [0, 1, 2, 3, 4, 5] }]);
    expect(() => decodeWoff2Fonts(file)).toThrow(/loca/);
  });

  it('accepts the adjacent pair of a hand built collection', () => {
    const file = collectionFile(collectionTables(), [{ indices: [0, 1, 2, 3, 4, 5] }]);
    const loca = decodeWoff2Fonts(file)[0].tables.find((t) => t.tag === 'loca')!;
    expect(loca.data.toString('hex')).toBe('00000000000c');
  });

  it('rejects a single font whose loca comes before its glyf', () => {
    const tables = minimalTransformedFont();
    const loca = tables.find((t) => t.tag === 'loca')!;
    const rest = tables.filter((t) => t.tag !== 'loca');
    expect(() => decodeWoff2(buildWoff2({ tables: [loca, ...rest] }), 'x')).toThrow(Woff2FormatError);
  });

  it('rejects a font with glyf and no loca, transformed or not', () => {
    const tables = minimalTransformedFont().filter((t) => t.tag !== 'loca');
    tables[0] = { tag: 'glyf', data: Buffer.alloc(24), version: 3 };
    expect(() => decodeWoff2(buildWoff2({ tables }), 'x')).toThrow(Woff2FormatError);
  });
});

describe('WOFF2 collection: tables shared between fonts', () => {
  const sharedFile = (fonts: number, bytes: number): Buffer => {
    const tables: Woff2TableSpec[] = [
      { tag: 'head', data: Buffer.alloc(HEAD_BYTES) },
      { tag: 'name', data: Buffer.alloc(bytes) },
    ];
    return collectionFile(tables, Array.from({ length: fonts }, () => ({ indices: [0, 1] })));
  };

  it('refuses a head table that is not 54 bytes before inflating anything', () => {
    const BOMB_BYTES = 32 * MIB;
    const FONTS = 16;
    const tables: Woff2TableSpec[] = [{ tag: 'head', data: Buffer.alloc(BOMB_BYTES) }];
    const file = collectionFile(tables, Array.from({ length: FONTS }, () => ({ indices: [0] })));
    expect(file.length).toBeLessThan(64 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    const started = process.hrtime.bigint();
    expect(() => decodeWoff2Fonts(file)).toThrow(/head/);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(500);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(8 * MIB);
  });

  it.each([53, 55])('refuses a head table of %i bytes', (length) => {
    const file = buildWoff2({ tables: [{ tag: 'head', data: Buffer.alloc(length) }] });
    expect(() => decodeWoff2Fonts(file)).toThrow(Woff2FormatError);
  });

  it('caps the table bytes of all fonts of a collection together, before inflating', () => {
    expect(WOFF2_MAX_COLLECTION_BYTES).toBe(WOFF2_MAX_DECODED_BYTES);
    const SHARED_BYTES = 2 * MIB;
    const file = sharedFile(WOFF2_MAX_FONTS, SHARED_BYTES); // 256 fonts x 2 MiB share one 2 MiB table
    expect(SHARED_BYTES * WOFF2_MAX_FONTS).toBeGreaterThan(WOFF2_MAX_COLLECTION_BYTES);
    const before = process.memoryUsage().arrayBuffers;
    expect(() => decodeWoff2Fonts(file)).toThrow(Woff2LimitError);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(SHARED_BYTES);
  });

  it('accepts a collection whose fonts together stay below the cap', () => {
    const fonts = decodeWoff2Fonts(sharedFile(8, MIB));
    expect(fonts).toHaveLength(8);
    expect(fonts.every((font) => font.tables.find((t) => t.tag === 'name')!.data.length === MIB)).toBe(true);
  });

  it('decodes only the first font when a single font is requested', () => {
    // font 1 lists a transformed hmtx without hhea, which decoding all fonts rejects
    const tables = collectionTables();
    const hmtx = { ...tables[4], version: 1, origLength: 8, transformLength: 5, data: Buffer.from([0b11, 1, 0xf4, 2, 0x58]) };
    tables[4] = hmtx;
    const file = collectionFile(tables, [{ indices: [0, 1, 2, 3, 4, 5] }, { indices: [0, 1, 2, 4, 5] }]);
    expect(decodeWoff2(file, 'x').tables['hmtx'].data.toString('hex')).toBe('01f40000' + '02580000');
    expect(decodeWoff2Fonts(file, { firstFontOnly: true })).toHaveLength(1);
    expect(() => decodeWoff2Collection(file, 'x')).toThrow(Woff2FormatError);
  });
});

describe('WOFF2 collection: a transformed hmtx shared by fonts with different metrics', () => {
  // directory: 0 glyf, 1 loca, 2 head, 3 hhea (2 metrics), 4 hhea (1 metric), 5 hmtx, 6 maxp
  function sharedHmtxFile(secondFontMetrics: number): Buffer {
    const base = collectionTables();
    const hmtx: Woff2TableSpec = { tag: 'hmtx', version: 1, origLength: 8, transformLength: 5, data: Buffer.from([0b11, 1, 0xf4, 2, 0x58]) };
    const tables = [base[0], base[1], base[2], base[3], { tag: 'hhea', data: sfntHhea(secondFontMetrics) }, hmtx, base[5]];
    return collectionFile(tables, [{ indices: [0, 1, 2, 3, 5, 6] }, { indices: [0, 1, 2, 4, 5, 6] }]);
  }

  it('rebuilds the table for each font from its own hhea when the metrics agree', () => {
    const fonts = decodeWoff2Fonts(sharedHmtxFile(2));
    const hmtx = fonts.map((font) => font.tables.find((t) => t.tag === 'hmtx')!.data.toString('hex'));
    expect(hmtx).toEqual(['01f40000' + '02580000', '01f40000' + '02580000']);
  });

  it('does not hand the first font hmtx to a font whose hhea disagrees with it', () => {
    expect(() => decodeWoff2Fonts(sharedHmtxFile(1))).toThrow(Woff2FormatError);
  });
});

describe('WOFF2 decoded size relative to the compressed size', () => {
  it('refuses a directory that announces far more data than the compressed stream could carry', () => {
    const DECLARED = 64 * MIB;
    const file = buildWoff2({ tables: [{ tag: 'name', data: Buffer.alloc(DECLARED) }] });
    expect(file.length).toBeLessThan(64 * 1024);
    expect(() => decodeWoff2Fonts(file)).toThrow(Woff2LimitError);
    expect(() => decodeWoff2Fonts(file)).toThrow(/ratio/);
  });

  it('accepts a compressible table below the ratio floor', () => {
    const font = decodeWoff2Fonts(buildWoff2({ tables: [{ tag: 'name', data: Buffer.alloc(MIB) }] }))[0];
    expect(font.tables[0].data.length).toBe(MIB);
    expect(brotliFont(Buffer.alloc(MIB)).length).toBeLessThan(MIB / 1000);
  });
});
