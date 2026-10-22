import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readUnicodeCmap } from '../src/lib/conversions/truetype-cmap';

/**
 * The Unicode cmap of an embedded TrueType program, read from untrusted bytes. The real font is the DejaVu Sans subset of
 * tests/fixtures/woff2 (written by fontTools); its glyph ids below are the ones fontTools reads. The other fonts are built
 * here table by table (OpenType specification, `cmap` formats 4, 6 and 12, and `maxp`) to hold one fault each.
 */

const FONT_PROGRAM = fs.readFileSync(path.join(__dirname, 'fixtures', 'woff2', 'dejavu-sans-latin.ttf'));
/** Characters of the font with the glyph ids fontTools gives them. */
const DEJAVU_GLYPHS: ReadonlyArray<[string, number]> = [
  [' ', 0x01],
  ['!', 0x02],
  ['F', 0x27],
  ['a', 0x42],
  ['ç', 0x8a],
  ['é', 0x8c],
  ['à', 0x83],
];
const TIME_LIMIT_MS = 2_000;

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function maxp(glyphs: number): number[] {
  return [...u32(0x00005000), ...u16(glyphs)];
}

/** An sfnt of the given tables, each at the offset the directory names (tables in the order given, 4-byte aligned). */
function sfnt(tables: Array<[string, number[]]>): Buffer {
  const header = [...u32(0x00010000), ...u16(tables.length), ...u16(0), ...u16(0), ...u16(0)];
  let offset = header.length + tables.length * 16;
  const records: number[] = [];
  const bodies: number[] = [];
  for (const [tag, body] of tables) {
    records.push(...Buffer.from(tag, 'latin1'), ...u32(0), ...u32(offset), ...u32(body.length));
    const padded = [...body, ...new Array((4 - (body.length % 4)) % 4).fill(0)];
    bodies.push(...padded);
    offset += padded.length;
  }
  return Buffer.from([...header, ...records, ...bodies]);
}

/** A cmap table with one (3,1) or (3,10) record pointing at `subtable`. */
function cmap(subtable: number[], encoding = 1): number[] {
  return [...u16(0), ...u16(1), ...u16(3), ...u16(encoding), ...u32(12), ...subtable];
}

/** A format 4 subtable of the segments [start, end, delta]; the closing 0xFFFF segment is added. */
function format4(segments: Array<[number, number, number]>): number[] {
  const all = [...segments, [0xffff, 0xffff, 1] as [number, number, number]];
  const count = all.length;
  const body = [
    ...u16(count * 2),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...all.flatMap(([, end]) => u16(end)),
    ...u16(0),
    ...all.flatMap(([start]) => u16(start)),
    ...all.flatMap(([, , delta]) => u16(delta & 0xffff)),
    ...all.flatMap(() => u16(0)),
  ];
  return [...u16(4), ...u16(body.length + 6), ...u16(0), ...body];
}

function format6(first: number, glyphs: number[]): number[] {
  return [...u16(6), ...u16(10 + glyphs.length * 2), ...u16(0), ...u16(first), ...u16(glyphs.length), ...glyphs.flatMap(u16)];
}

function format12(groups: Array<[number, number, number]>): number[] {
  return [...u16(12), ...u16(0), ...u32(16 + groups.length * 12), ...u32(0), ...u32(groups.length), ...groups.flatMap(([start, end, glyph]) => [...u32(start), ...u32(end), ...u32(glyph)])];
}

function timed<T>(read: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = read();
  return { value, ms: performance.now() - started };
}

describe('the cmap of a real TrueType program', () => {
  it('gives each glyph the character the font maps to it, and each character its glyph', () => {
    const table = readUnicodeCmap(FONT_PROGRAM);
    expect(table).not.toBeNull();
    for (const [character, glyph] of DEJAVU_GLYPHS) {
      expect(String.fromCodePoint(table?.codePointOfGlyph[glyph] ?? 0)).toBe(character);
      expect(table?.glyphOfBmpCodePoint[character.codePointAt(0) as number]).toBe(glyph);
    }
  });

  it('gives no glyph a character the font does not map to it', () => {
    const table = readUnicodeCmap(FONT_PROGRAM);
    expect(table?.codePointOfGlyph[0]).toBe(0);
    expect(table?.glyphOfBmpCodePoint[0x4e00]).toBe(0);
  });
});

describe('cmap subtable formats', () => {
  it('reads format 4 segments with a delta, giving a glyph the lowest code point that maps to it', () => {
    const table = readUnicodeCmap(sfnt([['maxp', maxp(10)], ['cmap', cmap(format4([[0x41, 0x43, -0x40], [0xa0, 0xa0, -0x9f]]))]]));
    expect([1, 2, 3].map((glyph) => String.fromCodePoint(table?.codePointOfGlyph[glyph] ?? 0))).toEqual(['A', 'B', 'C']);
  });

  it('reads a format 6 trimmed table', () => {
    const table = readUnicodeCmap(sfnt([['maxp', maxp(10)], ['cmap', cmap(format6(0x61, [5, 6, 0, 7]))]]));
    expect([5, 6, 7].map((glyph) => String.fromCodePoint(table?.codePointOfGlyph[glyph] ?? 0))).toEqual(['a', 'b', 'd']);
  });

  it('reads format 12 groups beyond the Basic Multilingual Plane', () => {
    const table = readUnicodeCmap(sfnt([['maxp', maxp(10)], ['cmap', cmap(format12([[0x1f600, 0x1f601, 4]]), 10)]]));
    expect(table?.codePointOfGlyph[4]).toBe(0x1f600);
    expect(table?.codePointOfGlyph[5]).toBe(0x1f601);
  });

  it('gives no glyph a control code or a private-use character', () => {
    const table = readUnicodeCmap(sfnt([['maxp', maxp(10)], ['cmap', cmap(format4([[0x0d, 0x0d, -0x0c], [0xe000, 0xe000, -0xdffe]]))]]));
    expect(table?.codePointOfGlyph[1]).toBe(0);
    expect(table?.codePointOfGlyph[2]).toBe(0);
  });
});

describe('hostile font tables', () => {
  it('reads nothing from a font without a cmap or a maxp', () => {
    expect(readUnicodeCmap(sfnt([['maxp', maxp(10)]]))).toBeNull();
    expect(readUnicodeCmap(sfnt([['cmap', cmap(format6(0x61, [1]))]]))).toBeNull();
  });

  it('reads nothing from bytes that are cut off inside the cmap', () => {
    const font = sfnt([['maxp', maxp(10)], ['cmap', cmap(format4([[0x41, 0x5a, -0x40]]))]]);
    for (const cut of [8, 40, font.length - 30]) expect(readUnicodeCmap(font.subarray(0, cut))).toBeNull();
  });

  it('reads nothing from format 4 segments out of order', () => {
    const font = sfnt([['maxp', maxp(10)], ['cmap', cmap(format4([[0x61, 0x7a, -0x60], [0x41, 0x5a, -0x40]]))]]);
    expect(readUnicodeCmap(font)).toBeNull();
  });

  it('reads nothing from a cmap that claims 65,535 encoding records, and stops at once', () => {
    const table = cmap(format6(0x61, [1]));
    table.splice(2, 2, ...u16(0xffff));
    const { value, ms } = timed(() => readUnicodeCmap(sfnt([['maxp', maxp(10)], ['cmap', table]])));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(TIME_LIMIT_MS);
  });

  it('reads nothing from a subtable whose offset points outside the cmap', () => {
    const table = cmap(format6(0x61, [1]));
    table.splice(8, 4, ...u32(0x7fffffff));
    expect(readUnicodeCmap(sfnt([['maxp', maxp(10)], ['cmap', table]]))).toBeNull();
  });

  it('reads nothing from tables whose directory places them past the end of the bytes', () => {
    const font = sfnt([['maxp', maxp(10)], ['cmap', cmap(format6(0x61, [1]))]]);
    font.writeUInt32BE(0xfffffff0, 12 + 16 + 8);
    expect(readUnicodeCmap(font)).toBeNull();
  });

  it('reads tables that overlap each other as the bytes they share say', () => {
    const font = sfnt([['maxp', maxp(10)], ['cmap', cmap(format6(0x61, [1]))]]);
    // maxp now starts where cmap does: its glyph count is the cmap's first platform id, 3.
    font.writeUInt32BE(font.readUInt32BE(12 + 16 + 8), 12 + 8);
    const table = readUnicodeCmap(font);
    expect(table?.codePointOfGlyph.length).toBe(3);
    expect(String.fromCodePoint(table?.codePointOfGlyph[1] ?? 0)).toBe('a');
  });

  it('maps a format 12 group over every code point only to the glyphs the font has, quickly', () => {
    const { value, ms } = timed(() => readUnicodeCmap(sfnt([['maxp', maxp(10)], ['cmap', cmap(format12([[0x20, 0x10ffff, 1]]), 10)]])));
    expect(value?.codePointOfGlyph.length).toBe(10);
    expect(String.fromCodePoint(value?.codePointOfGlyph[1] ?? 0)).toBe(' ');
    expect(ms).toBeLessThan(TIME_LIMIT_MS);
  });

  it('reads nothing from format 12 groups that overlap', () => {
    expect(readUnicodeCmap(sfnt([['maxp', maxp(10)], ['cmap', cmap(format12([[0x41, 0x50, 1], [0x45, 0x46, 2]]), 10)]]))).toBeNull();
  });
});
