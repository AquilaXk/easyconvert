import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { oracleTest } from './helpers/oracle-test';
import {
  duckdbRead,
  type OracleValue,
  pyarrowRead,
  pyarrowCompress,
  pyarrowSnappyCompress,
  pyarrowSnappyDecompress,
  pyarrowWrite,
  type ReferenceColumnKind,
} from './helpers/parquet-oracle';
import {
  CompressionCodec,
  compressSnappy,
  decodeParquet,
  decompressRawSnappyBlock,
  decompressSnappy,
  encodeParquet,
  isZstdWriteAvailable,
  ParquetCodecUnavailableError,
  ParquetFormatError,
  ParquetValueError,
} from '../src/lib/conversions/parquet';
import { convertData } from '../src/lib/conversions/data';
import { decodeRleHybrid, ByteSink, encodeRleHybrid } from '../src/lib/conversions/parquet-rle';
import { decompressZstd } from '../src/lib/conversions/zstd';
import { ConversionFailedError } from '../src/lib/types';

/**
 * Conformance of the Parquet writer (issue 526). Independent oracles:
 *  - pyarrow (and DuckDB when installed) read the bytes; expected values are the generated input rows.
 *  - the reference writer (pyarrow) produces the size baseline for the same data and codec.
 *  - the RLE vectors are hand-derived from the Encodings.md byte layout.
 *  - tests/fixtures/parquet holds files written by the reference writer with hand-authored contents.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'parquet');
const ZSTD_WRITE_AVAILABLE = isZstdWriteAvailable();
const SIZE_RATIO_LIMIT = 1.2;
const SIZE_FIXTURE_ROWS = 200_000;

const WRITE_CODECS: { name: string; codec: CompressionCodec; reference: 'snappy' | 'zstd' | 'none'; available: boolean }[] = [
  { name: 'UNCOMPRESSED', codec: CompressionCodec.UNCOMPRESSED, reference: 'none', available: true },
  { name: 'SNAPPY', codec: CompressionCodec.SNAPPY, reference: 'snappy', available: true },
  { name: 'ZSTD', codec: CompressionCodec.ZSTD, reference: 'zstd', available: ZSTD_WRITE_AVAILABLE },
];

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Deterministic data
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EDGE_ROWS: Row[] = [
  { id: 0, dbl: 0, txt: '', flag: true, only_null: null },
  { id: -1, dbl: -0, txt: 'plain', flag: false, only_null: null },
  { id: 9007199254740991, dbl: Number.NaN, txt: 'café', flag: null, only_null: null },
  { id: -9007199254740991, dbl: Number.POSITIVE_INFINITY, txt: '\u{1f600} astral', flag: true, only_null: null },
  { id: null, dbl: Number.NEGATIVE_INFINITY, txt: null, flag: false, only_null: null },
  { id: 42, dbl: 5e-324, txt: 'x'.repeat(5000), flag: true, only_null: null },
  { id: 4_294_967_296, dbl: 1.7976931348623157e308, txt: '\u0000nul\u007f', flag: null, only_null: null },
  { id: 4_294_967_295, dbl: null, txt: 'plain', flag: false, only_null: null },
  { id: -4_294_967_297, dbl: 0.1, txt: '', flag: null, only_null: null },
];

function expectedColumn(rows: Row[], name: string): unknown[] {
  return rows.map((r) => {
    const v = r[name];
    return v === undefined ? null : v;
  });
}

function expectColumnEquals(actual: OracleValue[], expected: unknown[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    // Object.is separates -0 from +0 and treats NaN as equal to itself.
    if (!Object.is(actual[i], expected[i])) {
      throw new Error(`row ${i}: expected ${String(expected[i])} (${typeof expected[i]}) got ${String(actual[i])} (${typeof actual[i]})`);
    }
  }
}

function sizeFixture(): { columns: Record<string, (string | number | boolean | null)[]>; rows: Row[]; schema: [string, ReferenceColumnKind][] } {
  const rand = mulberry32(526);
  const countries = Array.from({ length: 40 }, (_, i) => `country-${String(i).padStart(2, '0')}`);
  const columns: Record<string, (string | number | boolean | null)[]> = {
    id: [],
    user: [],
    country: [],
    amount: [],
    qty: [],
    active: [],
    note: [],
    score: [],
  };
  for (let i = 0; i < SIZE_FIXTURE_ROWS; i++) {
    columns.id.push(1_000_000 + i);
    columns.user.push(`user-${Math.floor(rand() * 5000)}`);
    columns.country.push(countries[Math.floor(rand() * countries.length)]);
    columns.amount.push(Math.round(rand() * 1_000_000) / 100);
    columns.qty.push(1 + Math.floor(rand() * 20));
    columns.active.push(rand() < 0.7);
    columns.note.push(rand() < 0.3 ? null : `note-${Math.floor(rand() * 2000)}`);
    columns.score.push(rand() < 0.2 ? null : [0.5, 1, 1.5][Math.floor(rand() * 3)]);
  }
  const names = Object.keys(columns);
  const rows: Row[] = [];
  for (let i = 0; i < SIZE_FIXTURE_ROWS; i++) {
    const row: Row = {};
    for (const name of names) row[name] = columns[name][i];
    rows.push(row);
  }
  const schema: [string, ReferenceColumnKind][] = [
    ['id', 'int64'],
    ['user', 'string'],
    ['country', 'string'],
    ['amount', 'double'],
    ['qty', 'int64'],
    ['active', 'bool'],
    ['note', 'string'],
    ['score', 'double'],
  ];
  return { columns, rows, schema };
}

// ---------------------------------------------------------------------------
// 1. Regression and value fidelity through the reference readers
// ---------------------------------------------------------------------------

describe('Parquet writer conformance (issue 526)', () => {
  oracleTest(
    'regression: pyarrow reads the writer output with exact values and nulls',
    ['python3'],
    () => {
      const rows = [
        { id: 1, label: 'alpha', score: 1.5, ok: true },
        { id: 2, label: null, score: null, ok: false },
        { id: null, label: 'gamma', score: 3.25, ok: null },
      ];
      const read = pyarrowRead(encodeParquet(rows));
      expect(read.numRows).toBe(3);
      expect(read.columns.id).toEqual([1, 2, null]);
      expect(read.columns.label).toEqual(['alpha', null, 'gamma']);
      expect(read.columns.score).toEqual([1.5, null, 3.25]);
      expect(read.columns.ok).toEqual([true, false, null]);
    }
  );

  for (const spec of WRITE_CODECS) {
    const register = spec.available ? oracleTest : oracleTest.skip;
    register(
      `pyarrow reads every edge value exactly with ${spec.name}${spec.available ? '' : ' (zstd unavailable in this Node runtime)'}`,
      ['python3'],
      () => {
        const read = pyarrowRead(encodeParquet(EDGE_ROWS, { codec: spec.codec }));
        expect(read.numRows).toBe(EDGE_ROWS.length);
        for (const name of ['id', 'dbl', 'txt', 'flag', 'only_null']) {
          expectColumnEquals(read.columns[name], expectedColumn(EDGE_ROWS, name));
        }
        expect(read.schema.map((f) => [f.name, f.type, f.nullable])).toEqual([
          ['id', 'int64', true],
          ['dbl', 'double', true],
          ['txt', 'string', true],
          ['flag', 'bool', true],
          ['only_null', 'string', true],
        ]);
        for (const column of read.rowGroups[0].columns) {
          expect(column.codec).toBe(spec.name);
        }
      }
    );
  }

  oracleTest('duckdb reads every edge value exactly with each available codec', ['python3'], () => {
    for (const spec of WRITE_CODECS.filter((c) => c.available)) {
      const read = duckdbRead(encodeParquet(EDGE_ROWS, { codec: spec.codec }));
      expect(read.numRows).toBe(EDGE_ROWS.length);
      for (const name of ['id', 'dbl', 'txt', 'flag']) {
        expectColumnEquals(read.columns[name], expectedColumn(EDGE_ROWS, name));
      }
    }
  });

  oracleTest('typed inference: mixed int and float widens to double, empty strings become nulls in numeric columns', ['python3'], () => {
    const rows: Row[] = [
      { n: 1, big: 2 ** 60, e: '' },
      { n: 2.5, big: 3, e: 7 },
      { n: '', big: null, e: null },
    ];
    const read = pyarrowRead(encodeParquet(rows));
    expectColumnEquals(read.columns.n, [1, 2.5, null]);
    expectColumnEquals(read.columns.big, [2 ** 60, 3, null]);
    expectColumnEquals(read.columns.e, [null, 7, null]);
    expect(read.schema.map((f) => f.type)).toEqual(['double', 'double', 'int64']);
  });

  oracleTest('a column mixing numbers, booleans and strings becomes a string column with canonical text', ['python3'], () => {
    const rows: Row[] = [{ v: 1 }, { v: 'x' }, { v: 2.5 }, { v: true }, { v: -0 }, { v: null }, { v: '' }, { v: 1e21 }, { v: false }];
    const read = pyarrowRead(encodeParquet(rows));
    expectColumnEquals(read.columns.v, ['1', 'x', '2.5', 'true', '0', null, '', '1e+21', 'false']);
    expect(read.schema.map((f) => f.type)).toEqual(['string']);
  });

  oracleTest('numbers mixed with booleans widen to strings, while int and float still widen to double', ['python3'], () => {
    const read = pyarrowRead(encodeParquet([{ a: 1, b: 1 }, { a: true, b: 2.5 }]));
    expectColumnEquals(read.columns.a, ['1', 'true']);
    expectColumnEquals(read.columns.b, [1, 2.5]);
    expect(read.schema.map((f) => f.type)).toEqual(['string', 'double']);
  });

  oracleTest('Date values become ISO-8601 strings, alone or mixed with text', ['python3'], () => {
    const rows: Row[] = [
      { d: new Date(Date.UTC(2024, 1, 29, 12, 30, 5, 123)), m: new Date(0) },
      { d: null, m: 'later' },
      { d: new Date(Date.UTC(1969, 11, 31, 23, 59, 59, 999)), m: 7 },
    ];
    const read = pyarrowRead(encodeParquet(rows));
    expectColumnEquals(read.columns.d, ['2024-02-29T12:30:05.123Z', null, '1969-12-31T23:59:59.999Z']);
    expectColumnEquals(read.columns.m, ['1970-01-01T00:00:00.000Z', 'later', '7']);
    expect(read.schema.map((f) => f.type)).toEqual(['string', 'string']);
  });

  oracleTest('a string column keeps empty strings distinct from nulls', ['python3'], () => {
    const rows: Row[] = [{ s: '' }, { s: null }, { s: 'a' }, {}];
    const read = pyarrowRead(encodeParquet(rows));
    expectColumnEquals(read.columns.s, ['', null, 'a', null]);
  });

  // -------------------------------------------------------------------------
  // 2. Layout: dictionary, fallback, row groups, pages
  // -------------------------------------------------------------------------

  oracleTest('low-cardinality columns use dictionary pages and high-cardinality doubles fall back to PLAIN', ['python3'], () => {
    const rand = mulberry32(7);
    const rows: Row[] = [];
    for (let i = 0; i < 5000; i++) {
      rows.push({ tag: `t${i % 12}`, unique: rand() * 1e6 + i, small: i % 5 });
    }
    const read = pyarrowRead(encodeParquet(rows));
    const byPath = Object.fromEntries(read.rowGroups[0].columns.map((c) => [c.path, c]));
    expect(byPath.tag.hasDictionaryPage).toBe(true);
    expect(byPath.tag.encodings).toContain('PLAIN_DICTIONARY');
    expect(byPath.small.hasDictionaryPage).toBe(true);
    expect(byPath.unique.hasDictionaryPage).toBe(false);
    expect(byPath.unique.encodings).toContain('PLAIN');
    expectColumnEquals(read.columns.tag, expectedColumn(rows, 'tag'));
    expectColumnEquals(read.columns.unique, expectedColumn(rows, 'unique'));
    expectColumnEquals(read.columns.small, expectedColumn(rows, 'small'));
  });

  oracleTest('a dictionary beyond dictionaryMaxBytes falls back to PLAIN with identical values', ['python3'], () => {
    const rows: Row[] = Array.from({ length: 3000 }, (_, i) => ({ s: `value-${i % 400}`, n: i % 300 }));
    const bounded = pyarrowRead(encodeParquet(rows, { dictionaryMaxBytes: 256 }));
    for (const column of bounded.rowGroups[0].columns) expect(column.hasDictionaryPage).toBe(false);
    expectColumnEquals(bounded.columns.s, expectedColumn(rows, 's'));
    expectColumnEquals(bounded.columns.n, expectedColumn(rows, 'n'));
    const roomy = pyarrowRead(encodeParquet(rows));
    for (const column of roomy.rowGroups[0].columns) expect(column.hasDictionaryPage).toBe(true);
  });

  oracleTest('row groups and data pages are bounded by the configured row and byte limits', ['python3'], () => {
    const rows: Row[] = Array.from({ length: 2500 }, (_, i) => ({
      id: i,
      s: i % 7 === 0 ? null : `row-${i}-${'z'.repeat(i % 50)}`,
      d: i * 0.5,
    }));
    const byRows = pyarrowRead(encodeParquet(rows, { rowGroupMaxRows: 1000, dataPageMaxRows: 128 }));
    expect(byRows.rowGroups.map((g) => g.numRows)).toEqual([1000, 1000, 500]);
    for (const name of ['id', 's', 'd']) expectColumnEquals(byRows.columns[name], expectedColumn(rows, name));

    const byBytes = pyarrowRead(encodeParquet(rows, { rowGroupMaxBytes: 20_000 }));
    expect(byBytes.numRowGroups).toBeGreaterThan(2);
    expect(byBytes.rowGroups.reduce((sum, g) => sum + g.numRows, 0)).toBe(rows.length);
    for (const name of ['id', 's', 'd']) expectColumnEquals(byBytes.columns[name], expectedColumn(rows, name));
  });

  oracleTest('a column made only of nulls and rows missing keys read back as nulls', ['python3'], () => {
    const rows: Row[] = [{ a: 1 }, { b: 'x' }, {}, { a: 3, b: null }];
    const read = pyarrowRead(encodeParquet(rows));
    expectColumnEquals(read.columns.a, [1, null, null, 3]);
    expectColumnEquals(read.columns.b, [null, 'x', null, null]);
  });

  // -------------------------------------------------------------------------
  // 3. Statistics
  // -------------------------------------------------------------------------

  oracleTest('statistics carry null_count and min/max in the logical type sort order', ['python3'], () => {
    const rows: Row[] = [
      { i: 5, d: 2.5, s: 'b', f: true, allnull: null },
      { i: -7, d: Number.NaN, s: '￿', f: false, allnull: null },
      { i: null, d: -1.5, s: '\u{1f600}', f: true, allnull: null },
      { i: 9, d: null, s: 'a', f: null, allnull: null },
    ];
    const read = pyarrowRead(encodeParquet(rows));
    const stats = Object.fromEntries(read.rowGroups[0].columns.map((c) => [c.path, c]));
    expect([stats.i.min, stats.i.max, stats.i.nullCount]).toEqual([-7, 9, 1]);
    expect([stats.d.min, stats.d.max, stats.d.nullCount]).toEqual([-1.5, 2.5, 1]);
    // UTF-8 byte order: 'a' < U+FFFF (EF BF BF) < U+1F600 (F0 9F 98 80); UTF-16 order would put U+1F600 first.
    expect([stats.s.min, stats.s.max, stats.s.nullCount]).toEqual(['a', '\u{1f600}', 0]);
    expect([stats.f.min, stats.f.max, stats.f.nullCount]).toEqual([false, true, 1]);
    expect(stats.allnull.nullCount).toBe(4);
    expect(stats.allnull.hasMinMax).toBe(false);
  });

  oracleTest('floating point statistics exclude NaN and bound signed zeros as the format requires', ['python3'], () => {
    const allNaN = pyarrowRead(encodeParquet([{ d: Number.NaN }, { d: Number.NaN }]));
    expect(allNaN.rowGroups[0].columns[0].hasMinMax).toBe(false);

    const zeros = pyarrowRead(encodeParquet([{ d: 0.0 }, { d: 0.0 }, { d: 0.5 }]));
    const zeroStats = zeros.rowGroups[0].columns[0];
    expect(Object.is(zeroStats.min, -0)).toBe(true);
    expect(zeroStats.max).toBe(0.5);

    const onlyZero = pyarrowRead(encodeParquet([{ d: -0 }, { d: 0 }, { d: 0.5 }]));
    expect(Object.is(onlyZero.rowGroups[0].columns[0].min, -0)).toBe(true);
    const negativeOnly = pyarrowRead(encodeParquet([{ d: -2 }, { d: 0 }]));
    expect(Object.is(negativeOnly.rowGroups[0].columns[0].max, 0)).toBe(true);
  });

  oracleTest('statistics are per row group', ['python3'], () => {
    const rows: Row[] = Array.from({ length: 300 }, (_, i) => ({ v: i, s: `k${String(i).padStart(3, '0')}` }));
    const read = pyarrowRead(encodeParquet(rows, { rowGroupMaxRows: 100 }));
    const ranges = read.rowGroups.map((g) => [g.columns[0].min, g.columns[0].max]);
    expect(ranges).toEqual([
      [0, 99],
      [100, 199],
      [200, 299],
    ]);
    expect(read.rowGroups.map((g) => [g.columns[1].min, g.columns[1].max])).toEqual([
      ['k000', 'k099'],
      ['k100', 'k199'],
      ['k200', 'k299'],
    ]);
  });

  // -------------------------------------------------------------------------
  // 4. Size against the reference writer (200k rows, same codec)
  // -------------------------------------------------------------------------

  for (const spec of WRITE_CODECS.filter((c) => c.codec !== CompressionCodec.UNCOMPRESSED)) {
    const register = spec.available ? oracleTest : oracleTest.skip;
    register(
      `200k-row file is within ${SIZE_RATIO_LIMIT}x of the reference writer with ${spec.name}${spec.available ? '' : ' (zstd unavailable in this Node runtime)'}`,
      ['python3'],
      () => {
        const fixture = sizeFixture();
        const ours = encodeParquet(fixture.rows, { codec: spec.codec });
        const reference = pyarrowWrite(fixture.columns, fixture.schema, spec.reference);
        const ratio = ours.length / reference.length;
        process.stdout.write(`parquet size ${spec.name}: ours=${ours.length} reference=${reference.length} ratio=${ratio.toFixed(3)}\n`);
        expect(ratio).toBeLessThanOrEqual(SIZE_RATIO_LIMIT);

        const read = pyarrowRead(ours);
        expect(read.numRows).toBe(SIZE_FIXTURE_ROWS);
        for (const [name] of fixture.schema) expectColumnEquals(read.columns[name], fixture.columns[name]);
      },
      180_000
    );
  }

  // -------------------------------------------------------------------------
  // 5. Snappy against the reference codec
  // -------------------------------------------------------------------------

  describe('snappy block codec', () => {
    const rand = mulberry32(99);
    const randomBytes = Buffer.from(Array.from({ length: 100_000 }, () => Math.floor(rand() * 256)));
    const repetitive = Buffer.from('abcabcabcabc-0123456789;'.repeat(9000));
    const textLike = Buffer.from(
      Array.from({ length: 30_000 }, (_, i) => `record-${i % 977} value=${(i * 31) % 4093} status=${i % 3 === 0 ? 'ok' : 'retry'}\n`).join('')
    );
    const payloads: [string, Buffer][] = [
      ['empty', Buffer.alloc(0)],
      ['one byte', Buffer.from([7])],
      ['14 bytes', Buffer.from('0123456789abcd')],
      ['random 100 KB', randomBytes],
      ['repetitive 216 KB', repetitive],
      ['text-like crossing 64 KiB fragments', textLike],
    ];

    for (const [label, payload] of payloads) {
      oracleTest(`pyarrow decompresses our snappy output: ${label}`, ['python3'], () => {
        const packed = compressSnappy(payload);
        expect(pyarrowSnappyDecompress(packed, payload.length).equals(payload)).toBe(true);
      });

      oracleTest(`we decompress pyarrow snappy output: ${label}`, ['python3'], () => {
        const packed = pyarrowSnappyCompress(payload);
        expect(decompressSnappy(packed).equals(payload)).toBe(true);
      });
    }

    oracleTest('compression uses copies: repetitive and text-like data shrink about as much as the reference', ['python3'], () => {
      for (const payload of [repetitive, textLike]) {
        const ours = compressSnappy(payload).length;
        const reference = pyarrowSnappyCompress(payload).length;
        expect(ours).toBeLessThan(payload.length / 3);
        expect(ours / reference).toBeLessThanOrEqual(1.1);
      }
    });

    it('rejects a block whose declared size exceeds the caller bound before allocating', () => {
      const hostile = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f, 0x00]);
      expect(() => decompressRawSnappyBlock(hostile, 1024)).toThrow(ParquetFormatError);
      expect(() => decompressRawSnappyBlock(hostile, 1024)).toThrow(/exceeds the 1024 byte limit/);
    });

    it('rejects a copy that points before the start of the output', () => {
      // length 8, literal "ab", then copy1 (len 4, offset 5) with only 2 bytes produced
      const bad = Buffer.from([0x08, 0x04, 0x61, 0x62, 0x01, 0x05]);
      expect(() => decompressRawSnappyBlock(bad)).toThrow(/invalid copy offset 5/);
    });
  });

  // -------------------------------------------------------------------------
  // 6. RLE / bit-packed hybrid against hand-derived vectors (Encodings.md layout)
  // -------------------------------------------------------------------------

  describe('RLE hybrid encoding vectors', () => {
    function encode(values: number[], width: number): number[] {
      const sink = new ByteSink();
      encodeRleHybrid(sink, values, values.length, width);
      return Array.from(sink.toBuffer());
    }

    it('bit-packs 0..7 at width 3 as the format specification lists (header 0x03, bytes 88 C6 FA)', () => {
      expect(encode([0, 1, 2, 3, 4, 5, 6, 7], 3)).toEqual([0x03, 0x88, 0xc6, 0xfa]);
    });

    it('writes a run of 100 ones at width 1 as header 200 (varint C8 01) and one value byte', () => {
      expect(encode(new Array<number>(100).fill(1), 1)).toEqual([0xc8, 0x01, 0x01]);
    });

    it('writes a run of 300 values of 2^17+5 at width 18 with a three byte value', () => {
      const v = 131_077;
      // header 300 << 1 = 600 = varint D8 04, value little endian 05 00 02
      expect(encode(new Array<number>(300).fill(v), 18)).toEqual([0xd8, 0x04, 0x05, 0x00, 0x02]);
    });

    it('keeps groups whole when a run follows pending literals: 3 literals + 13 repeats at width 1', () => {
      const values = [1, 0, 1, ...new Array<number>(13).fill(0)];
      // 3 pending + 5 borrowed repeats = one packed group (1,0,1,0,0,0,0,0 -> 0b00000101),
      // then the remaining 8 repeats as one RLE run (header 16, value 0).
      expect(encode(values, 1)).toEqual([0x03, 0x05, 0x10, 0x00]);
    });

    it('pads the final partial group with zeros: 5 alternating values at width 1', () => {
      expect(encode([1, 0, 1, 0, 1], 1)).toEqual([0x03, 0x15]);
    });

    it('decodes the format specification example back to 0..7', () => {
      const out = new Uint32Array(8);
      decodeRleHybrid(Buffer.from([0x03, 0x88, 0xc6, 0xfa]), 0, 4, 3, 8, out);
      expect(Array.from(out)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('rejects runs that claim more bit-packed groups than the buffer holds', () => {
      const out = new Uint32Array(8);
      // header (1<<30 groups)<<1|1 as a 5-byte varint, no payload
      expect(() => decodeRleHybrid(Buffer.from([0x81, 0x80, 0x80, 0x80, 0x08]), 0, 5, 3, 8, out)).toThrow(ParquetFormatError);
    });

    it('rejects a stream that ends before all values are produced', () => {
      const out = new Uint8Array(100);
      expect(() => decodeRleHybrid(Buffer.from([0x0a, 0x01]), 0, 2, 1, 100, out)).toThrow(/truncated header/);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Reader against files written by the reference writer
  // -------------------------------------------------------------------------

  describe('decoding reference-writer files', () => {
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'expected.json'), 'utf-8')) as {
      numRows: number;
      columns: Record<string, unknown[]>;
    };

    function untag(v: unknown): unknown {
      if (v !== null && typeof v === 'object' && '$f' in v) {
        return Buffer.from((v as { $f: string }).$f, 'hex').readDoubleBE(0);
      }
      return v;
    }

    const readable = [
      ['dictionary-snappy.parquet', 'dictionary pages, SNAPPY, 3 row groups, multiple pages, nulls'],
      ['plain-gzip.parquet', 'PLAIN, GZIP, nulls'],
      ['plain-uncompressed.parquet', 'PLAIN, UNCOMPRESSED, nulls'],
      ['dictionary-zstd.parquet', 'dictionary pages, ZSTD, nulls'],
    ];
    for (const [file, label] of readable) {
      it(`${file} (${label}) decodes to the hand-authored rows`, () => {
        const rows = decodeParquet(fs.readFileSync(path.join(FIXTURE_DIR, file)));
        expect(rows.length).toBe(expected.numRows);
        for (const [name, values] of Object.entries(expected.columns)) {
          const actual = rows.map((r) => r[name]);
          const want = values.map(untag);
          for (let i = 0; i < want.length; i++) {
            if (!Object.is(actual[i], want[i])) throw new Error(`${file} column ${name} row ${i}: expected ${String(want[i])} got ${String(actual[i])}`);
          }
        }
      });
    }

    oracleTest('the in-repo zstd decoder reads frames produced by the reference compressor', ['python3'], () => {
      const payload = Buffer.from(Array.from({ length: 20_000 }, (_, i) => `row-${i % 313},${(i * 17) % 1009}\n`).join(''));
      const frame = pyarrowCompress('zstd', payload);
      expect(decompressZstd(frame).equals(payload)).toBe(true);
    });

    it('rejects v2 data pages instead of misreading them', () => {
      const file = fs.readFileSync(path.join(FIXTURE_DIR, 'data-page-v2.parquet'));
      expect(() => decodeParquet(file)).toThrow(ParquetFormatError);
      expect(() => decodeParquet(file)).toThrow(/data page version 2/);
    });

    it('rejects nested schemas instead of misreading them', () => {
      const file = fs.readFileSync(path.join(FIXTURE_DIR, 'nested-struct.parquet'));
      expect(() => decodeParquet(file)).toThrow(/nested/);
    });

    it('converts a reference-writer file to JSON through convertData', async () => {
      const file = fs.readFileSync(path.join(FIXTURE_DIR, 'dictionary-snappy.parquet'));
      const json = await convertData(file, 'parquet', 'json', {}, 'fixture.parquet');
      const rows = JSON.parse(json.buffer.toString('utf-8')) as Row[];
      expect(rows.length).toBe(expected.numRows);
      expect(rows[3]).toEqual({ id: -2979, name: 'name-3', note: 'né\u{1f600}-0', score: -0.25, flag: true });
      expect(rows[5].id).toBeNull();
    });
  });

  describe('decoding our own output', () => {
    for (const spec of WRITE_CODECS.filter((c) => c.available)) {
      it(`round-trips edge rows with ${spec.name} (nulls preserved, no coercion)`, () => {
        const rows = decodeParquet(encodeParquet(EDGE_ROWS, { codec: spec.codec }));
        expect(rows.length).toBe(EDGE_ROWS.length);
        for (const name of ['id', 'dbl', 'txt', 'flag']) {
          expectColumnEquals(
            rows.map((r) => r[name]) as OracleValue[],
            expectedColumn(EDGE_ROWS, name)
          );
        }
      });
    }

    it('rejects a page whose compressed bytes are damaged', () => {
      const bytes = Buffer.from(encodeParquet(Array.from({ length: 50 }, (_, i) => ({ v: `value-${i}` }))));
      const damaged = Buffer.from(bytes);
      for (let i = 4; i < 40; i++) damaged[i] ^= 0xff;
      expect(() => decodeParquet(damaged)).toThrow(ParquetFormatError);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Fail closed
  // -------------------------------------------------------------------------

  describe('fail-closed input handling', () => {
    function expectValueError(records: unknown[], pattern: RegExp): void {
      let caught: unknown;
      try {
        encodeParquet(records as Row[]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ParquetValueError);
      expect(caught).toBeInstanceOf(ConversionFailedError);
      expect((caught as Error).message).toMatch(pattern);
    }

    it('rejects empty input and records without columns', () => {
      expectValueError([], /no records/);
      expectValueError([{}, {}], /no columns/);
    });

    it('rejects records that are not objects', () => {
      expectValueError([{ a: 1 }, 5], /record 1 is not an object/);
      expectValueError([{ a: 1 }, null], /record 1 is not an object/);
      expectValueError([[1, 2]], /record 0 is not an object/);
    });

    it('rejects nested objects, arrays and bigints with the column and row in the message', () => {
      expectValueError([{ v: { a: 1 } }], /column "v" row 0 holds a nested object/);
      expectValueError([{ v: 'x' }, { v: [1, 2] }], /column "v" row 1 holds an array/);
      expectValueError([{ v: 10n }], /holds a bigint value/);
    });

    it('rejects an invalid Date, which has no ISO-8601 text', () => {
      expectValueError([{ v: new Date(Number.NaN) }], /column "v" row 0 holds an invalid date/);
    });

    it('rejects strings with unpaired surrogates, which have no UTF-8 encoding', () => {
      expectValueError([{ v: 'ok' }, { v: 'bad\ud800' }], /unpaired UTF-16 surrogate/);
      expectValueError([{ v: '\udc00bad' }], /unpaired UTF-16 surrogate/);
    });

    it('rejects invalid options and an unsupported codec with typed errors', () => {
      const rows: Row[] = [{ a: 1 }];
      expect(() => encodeParquet(rows, { dictionaryMaxBytes: 0 })).toThrow(ParquetValueError);
      expect(() => encodeParquet(rows, { rowGroupMaxRows: 1.5 })).toThrow(/rowGroupMaxRows/);
      expect(() => encodeParquet(rows, { dataPageMaxRows: -1 })).toThrow(/dataPageMaxRows/);
      expect(() => encodeParquet(rows, { dictionaryMaxBytes: 10 * 1024 * 1024 })).toThrow(/dictionaryMaxBytes/);
      expect(() => encodeParquet(rows, { codec: CompressionCodec.BROTLI })).toThrow(ParquetCodecUnavailableError);
    });

    it.skipIf(ZSTD_WRITE_AVAILABLE)('reports ZSTD as unavailable with a typed error on runtimes without node:zlib zstd', () => {
      expect(() => encodeParquet([{ a: 1 }], { codec: CompressionCodec.ZSTD })).toThrow(ParquetCodecUnavailableError);
    });

    it('answers HTTP-400-class errors through convertData for nested JSON values', async () => {
      const json = Buffer.from(JSON.stringify([{ id: 1 }, { id: { inner: 2 } }]), 'utf-8');
      const failure = await convertData(json, 'json', 'parquet', {}, 'nested.json').then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toMatch(/column "id" row 1 holds a nested object/);
    });

    it('widens mixed-type JSON to a string column through convertData', async () => {
      const json = Buffer.from(JSON.stringify([{ id: 1 }, { id: 'A2' }]), 'utf-8');
      const parquet = await convertData(json, 'json', 'parquet', {}, 'mixed.json');
      expect(decodeParquet(parquet.buffer)).toEqual([{ id: '1' }, { id: 'A2' }]);
    });

    it('converts JSON with nulls to a Parquet file whose nulls survive a decode', async () => {
      const json = Buffer.from(JSON.stringify([{ id: 1, s: 'a' }, { id: null, s: null }, { id: 3 }]), 'utf-8');
      const parquet = await convertData(json, 'json', 'parquet', {}, 'nulls.json');
      expect(decodeParquet(parquet.buffer)).toEqual([
        { id: 1, s: 'a' },
        { id: null, s: null },
        { id: 3, s: null },
      ]);
    });

    it('decodes a hostile footer claiming more rows than the limit as a typed error', () => {
      const valid = encodeParquet([{ a: 1 }]);
      const truncated = valid.subarray(0, valid.length - 1);
      expect(() => decodeParquet(truncated)).toThrow(ParquetFormatError);
    });
  });

  describe.skipIf(!ZSTD_WRITE_AVAILABLE)('ZSTD output', () => {
    oracleTest('pyarrow and the reader agree on ZSTD pages with dictionary and plain columns', ['python3'], () => {
      const fixture = sizeFixture();
      const bytes = encodeParquet(fixture.rows.slice(0, 5000), { codec: CompressionCodec.ZSTD });
      const read = pyarrowRead(bytes);
      for (const [name] of fixture.schema) expectColumnEquals(read.columns[name], fixture.columns[name].slice(0, 5000));
      expect(decodeParquet(bytes).map((r) => r.user)).toEqual(fixture.columns.user.slice(0, 5000));
    });
  });
});
