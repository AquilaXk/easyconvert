import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { ConversionFailedError } from '../src/lib/types';
import {
  decode255UInt16,
  decodeUIntBase128,
  encode255UInt16,
  encodeUIntBase128,
  WOFF2_KNOWN_TAGS,
  Woff2FormatError,
} from '../src/lib/conversions/font-woff2';
import { WOFF2_KNOWN_TAGS as FACADE_KNOWN_TAGS } from '../src/lib/conversions/font';
import { oracleTest } from './helpers/oracle-test';
import { OracleToolMissingError, requireOracleTool } from './helpers/differential-oracle';

/**
 * WOFF2 Recommendation: the known table tags of the table directory format, and the UIntBase128 and
 * 255UInt16 data types.
 * The expectations are hand-written from the specification text and cross-checked against the
 * fontTools implementation when it is installed.
 */

const SPEC_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

const KNOWN_TAG_COUNT = 63;

describe('WOFF2 known table tags', () => {
  it('lists the 63 tags of the specification in index order', () => {
    expect([...WOFF2_KNOWN_TAGS]).toEqual(SPEC_KNOWN_TAGS);
    expect(WOFF2_KNOWN_TAGS).toHaveLength(KNOWN_TAG_COUNT);
  });

  it('places EBSC at 29 and bloc at 41 and has no bhed entry', () => {
    expect(WOFF2_KNOWN_TAGS[29]).toBe('EBSC');
    expect(WOFF2_KNOWN_TAGS[30]).toBe('JSTF');
    expect(WOFF2_KNOWN_TAGS[41]).toBe('bloc');
    expect(WOFF2_KNOWN_TAGS[62]).toBe('Sill');
    expect(WOFF2_KNOWN_TAGS).not.toContain('bhed');
  });

  it('is the table the font facade exports', () => {
    expect([...FACADE_KNOWN_TAGS]).toEqual(SPEC_KNOWN_TAGS);
  });

  oracleTest('matches the fontTools known-tag table', ['python3'], () => {
    const probe = spawnSync(
      requireOracleTool('python3'),
      ['-c', 'import json; from fontTools.ttLib.woff2 import woff2KnownTags as t; print(json.dumps(list(t)))'],
      { encoding: 'utf8' },
    );
    if (probe.status !== 0) throw new OracleToolMissingError('fontTools', 'python3 fontTools is not importable');
    expect(JSON.parse(probe.stdout)).toEqual([...WOFF2_KNOWN_TAGS]);
  });
});

describe('UIntBase128', () => {
  const vectors: Array<[number, number[]]> = [
    [0, [0x00]],
    [63, [0x3f]],
    [127, [0x7f]],
    [128, [0x81, 0x00]],
    [16383, [0xff, 0x7f]],
    [16384, [0x81, 0x80, 0x00]],
    [2097151, [0xff, 0xff, 0x7f]],
    [2097152, [0x81, 0x80, 0x80, 0x00]],
    [268435456, [0x81, 0x80, 0x80, 0x80, 0x00]],
    [0xffffffff, [0x8f, 0xff, 0xff, 0xff, 0x7f]],
  ];

  it.each(vectors)('encodes %i as the shortest big-endian base-128 sequence', (value, bytes) => {
    expect(encodeUIntBase128(value)).toEqual(bytes);
  });

  it.each(vectors)('decodes the sequence of %i and consumes exactly its bytes', (value, bytes) => {
    const cursor = { offset: 1 };
    const buffer = Buffer.from([0xaa, ...bytes, 0xbb]);
    expect(decodeUIntBase128(buffer, cursor)).toBe(value);
    expect(cursor.offset).toBe(1 + bytes.length);
  });

  it('rejects a leading 0x80 byte, which would encode a redundant zero group', () => {
    expect(() => decodeUIntBase128(Buffer.from([0x80, 0x01]), { offset: 0 })).toThrow(Woff2FormatError);
  });

  it('rejects a value that does not fit 32 bits', () => {
    expect(() => decodeUIntBase128(Buffer.from([0x90, 0x80, 0x80, 0x80, 0x00]), { offset: 0 })).toThrow(Woff2FormatError);
  });

  it('rejects a sequence of more than five bytes', () => {
    expect(() => decodeUIntBase128(Buffer.from([0x81, 0x80, 0x80, 0x80, 0x80, 0x00]), { offset: 0 })).toThrow(Woff2FormatError);
  });

  it('rejects a truncated sequence', () => {
    expect(() => decodeUIntBase128(Buffer.from([0x81, 0x80]), { offset: 0 })).toThrow(Woff2FormatError);
  });

  it('refuses to encode a value outside the unsigned 32-bit range', () => {
    expect(() => encodeUIntBase128(0x100000000)).toThrow(Woff2FormatError);
    expect(() => encodeUIntBase128(-1)).toThrow(Woff2FormatError);
    expect(() => encodeUIntBase128(1.5)).toThrow(Woff2FormatError);
  });

  it('reports malformed input as a conversion failure (HTTP 400 at the API)', () => {
    expect(() => decodeUIntBase128(Buffer.from([0x80]), { offset: 0 })).toThrow(ConversionFailedError);
  });
});

describe('255UInt16', () => {
  const vectors: Array<[number, number[]]> = [
    [0, [0]],
    [252, [252]],
    [253, [255, 0]],
    [505, [255, 252]],
    [506, [254, 0]],
    [761, [254, 255]],
    [762, [253, 0x02, 0xfa]],
    [65535, [253, 0xff, 0xff]],
  ];

  it.each(vectors)('encodes %i', (value, bytes) => {
    expect(encode255UInt16(value)).toEqual(bytes);
  });

  it.each(vectors)('decodes the sequence of %i and consumes exactly its bytes', (value, bytes) => {
    const cursor = { offset: 2 };
    const buffer = Buffer.from([0xaa, 0xbb, ...bytes, 0xcc]);
    expect(decode255UInt16(buffer, cursor)).toBe(value);
    expect(cursor.offset).toBe(2 + bytes.length);
  });

  it('accepts a longer than necessary encoding', () => {
    expect(decode255UInt16(Buffer.from([253, 0, 5]), { offset: 0 })).toBe(5);
  });

  it('rejects truncated sequences', () => {
    expect(() => decode255UInt16(Buffer.from([253, 1]), { offset: 0 })).toThrow(Woff2FormatError);
    expect(() => decode255UInt16(Buffer.from([255]), { offset: 0 })).toThrow(Woff2FormatError);
    expect(() => decode255UInt16(Buffer.alloc(0), { offset: 0 })).toThrow(Woff2FormatError);
  });

  it('refuses to encode a value that does not fit 16 bits', () => {
    expect(() => encode255UInt16(65536)).toThrow(Woff2FormatError);
    expect(() => encode255UInt16(-1)).toThrow(Woff2FormatError);
  });
});
