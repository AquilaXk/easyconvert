import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildHostileParquet,
  CODEC_UNCOMPRESSED,
  ENC_PLAIN,
  pageHeader,
  PAGE_DATA,
  PHYSICAL_BYTE_ARRAY,
  PHYSICAL_INT32,
  PHYSICAL_INT64,
  REPETITION_REQUIRED,
} from './helpers/hostile-parquet';
import { convertData } from '../src/lib/conversions/data';
import { decodeParquet, ParquetFormatError, ParquetUnsupportedError } from '../src/lib/conversions/parquet';
import { ConversionFailedError } from '../src/lib/types';

/**
 * Reading keeps every value exact: integers beyond 2^53 and decimals become decimal strings, dates and
 * times become ISO-8601 text, binary that is not UTF-8 becomes base64. The expected strings are
 * hand-written literals in tests/helpers/parquet_oracle.py (fixtures were written by the reference
 * writer); nothing here is computed by the module under test.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'parquet');
const CONVERTED_UTF8 = 0;
const CONVERTED_DECIMAL = 5;
const CONVERTED_DATE = 6;
const CONVERTED_TIME_MILLIS = 7;
const CONVERTED_TIMESTAMP_MILLIS = 9;
const CONVERTED_UINT_8 = 11;
const CONVERTED_INTERVAL = 21;
const PHYSICAL_INT96 = 3;
const PHYSICAL_FIXED = 7;
const FILE_START = 4;

const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'logical-expected.json'), 'utf-8')) as Record<
  string,
  (string | number | null)[]
>;

describe('logical types read from reference-writer files', () => {
  for (const file of ['logical-types.parquet', 'logical-types-plain.parquet']) {
    describe(file, () => {
      const rows = decodeParquet(fs.readFileSync(path.join(FIXTURE_DIR, file)));

      it('has one row per authored value', () => {
        expect(rows.length).toBe(7);
      });

      for (const [column, want] of Object.entries(expected)) {
        it(`column ${column} matches the hand-written exact values`, () => {
          expect(rows.map((r) => r[column])).toEqual(want);
        });
      }
    });
  }

  it('keeps 64-bit integers exact through a conversion to JSON text', async () => {
    const file = fs.readFileSync(path.join(FIXTURE_DIR, 'logical-types.parquet'));
    const json = await convertData(file, 'parquet', 'json', {}, 'logical.parquet');
    const rows = JSON.parse(json.buffer.toString('utf-8')) as Record<string, unknown>[];
    expect(rows.map((r) => [r.i64, r.u64, r.dec20_4, r.ts_us_utc])).toEqual([
      ['9223372036854775807', '18446744073709551615', '-123456789012345.6789', '2024-05-06T07:08:09.123456Z'],
      ['-9223372036854775808', '9007199254740993', '0.0001', '1969-12-31T23:59:59.999999Z'],
      ['9007199254740993', 9007199254740991, '12.0000', '1970-01-01T00:00:00Z'],
      [9007199254740991, 5, null, null],
      [-9007199254740991, 0, '-0.0001', '2000-02-29T12:00:00.500000Z'],
      [0, null, '0.0000', '0001-01-01T00:00:00Z'],
      [null, 1, '9999999999999999.9999', '9999-12-31T23:59:59Z'],
    ]);
  });

  it('returns a safe 64-bit integer as a Number and an unsafe one as its decimal digits', () => {
    const rows = decodeParquet(fs.readFileSync(path.join(FIXTURE_DIR, 'logical-types.parquet')));
    expect(typeof rows[3].i64).toBe('number');
    expect(rows[3].i64).toBe(9007199254740991);
    expect(typeof rows[2].i64).toBe('string');
  });
});

describe('logical types hand-assembled over narrow physical types', () => {
  function singleColumn(
    physicalType: number,
    leaf: { convertedType?: number; scale?: number; precision?: number; typeLength?: number },
    values: Buffer,
    numValues: number
  ): Buffer {
    const page = Buffer.concat([
      pageHeader({ type: PAGE_DATA, uncompressed: values.length, compressed: values.length, numValues, encoding: ENC_PLAIN }),
      values,
    ]);
    return buildHostileParquet({
      body: page,
      leaves: [{ name: 'v', physicalType, repetition: REPETITION_REQUIRED, ...leaf }],
      rowGroups: [
        {
          numRows: numValues,
          chunks: [
            { name: 'v', physicalType, codec: CODEC_UNCOMPRESSED, numValues, dataPageOffset: FILE_START, totalCompressedSize: page.length },
          ],
        },
      ],
    });
  }

  function int32s(...values: number[]): Buffer {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeInt32LE(v, i * 4));
    return b;
  }

  function int64s(...values: bigint[]): Buffer {
    const b = Buffer.alloc(values.length * 8);
    values.forEach((v, i) => b.writeBigInt64LE(v, i * 8));
    return b;
  }

  it('reads DECIMAL stored in INT32 and INT64 as exact decimal strings', () => {
    const narrow = singleColumn(PHYSICAL_INT32, { convertedType: CONVERTED_DECIMAL, scale: 2, precision: 9 }, int32s(-123456, 5, 0, 700), 4);
    expect(decodeParquet(narrow).map((r) => r.v)).toEqual(['-1234.56', '0.05', '0.00', '7.00']);
    const wide = singleColumn(
      PHYSICAL_INT64,
      { convertedType: CONVERTED_DECIMAL, scale: 3, precision: 18 },
      int64s(-123456789012345678n, 1n, -1n),
      3
    );
    expect(decodeParquet(wide).map((r) => r.v)).toEqual(['-123456789012345.678', '0.001', '-0.001']);
  });

  it('reads DATE, TIME_MILLIS, TIMESTAMP_MILLIS and UINT_8 from their legacy converted types', () => {
    const date = singleColumn(PHYSICAL_INT32, { convertedType: CONVERTED_DATE }, int32s(0, -1, 19_782, -719_162), 4);
    expect(decodeParquet(date).map((r) => r.v)).toEqual(['1970-01-01', '1969-12-31', '2024-02-29', '0001-01-01']);
    const time = singleColumn(PHYSICAL_INT32, { convertedType: CONVERTED_TIME_MILLIS }, int32s(3_723_004, 0), 2);
    expect(decodeParquet(time).map((r) => r.v)).toEqual(['01:02:03.004', '00:00:00']);
    const stamp = singleColumn(
      PHYSICAL_INT64,
      { convertedType: CONVERTED_TIMESTAMP_MILLIS },
      int64s(1_714_979_289_123n, -1n),
      2
    );
    expect(decodeParquet(stamp).map((r) => r.v)).toEqual(['2024-05-06T07:08:09.123Z', '1969-12-31T23:59:59.999Z']);
    const small = singleColumn(PHYSICAL_INT32, { convertedType: CONVERTED_UINT_8 }, int32s(255, 1), 2);
    expect(decodeParquet(small).map((r) => r.v)).toEqual([255, 1]);
  });

  it('rejects a time of day outside one day', () => {
    const time = singleColumn(PHYSICAL_INT32, { convertedType: CONVERTED_TIME_MILLIS }, int32s(86_400_000), 1);
    expect(() => decodeParquet(time)).toThrow(/outside one day/);
  });

  it('rejects invalid UTF-8 in a column annotated as text', () => {
    const text = Buffer.concat([Buffer.from([2, 0, 0, 0, 0xff, 0xfe])]);
    const file = singleColumn(PHYSICAL_BYTE_ARRAY, { convertedType: CONVERTED_UTF8 }, text, 1);
    expect(() => decodeParquet(file)).toThrow(/invalid UTF-8/);
  });

  it('reads INT96 timestamps (nanosecond time of day + Julian day) as ISO-8601 UTC strings', () => {
    const buf = Buffer.alloc(36);
    buf.writeBigInt64LE(0n, 0);
    buf.writeInt32LE(2_440_588, 8);
    buf.writeBigInt64LE(45_296_123_456_789n, 12);
    buf.writeInt32LE(2_460_437, 20);
    buf.writeBigInt64LE(86_399_999_999_999n, 24);
    buf.writeInt32LE(2_440_587, 32);
    const int96 = singleColumn(PHYSICAL_INT96, {}, buf, 3);
    expect(decodeParquet(int96).map((r) => r.v)).toEqual([
      '1970-01-01T00:00:00Z',
      '2024-05-06T12:34:56.123456789Z',
      '1969-12-31T23:59:59.999999999Z',
    ]);
  });

  it('reads FLOAT16 logical type on FIXED_LEN_BYTE_ARRAY(2) as IEEE-754 numbers', () => {
    const values = Buffer.alloc(12);
    // 0x0000 -> +0, 0x8000 -> -0, 0x3c00 -> 1.0, 0xc100 -> -2.5, 0x0001 -> 2^-24, 0x7c00 -> +Infinity
    [0x0000, 0x8000, 0x3c00, 0xc100, 0x0001, 0x7c00].forEach((bits, i) => values.writeUInt16LE(bits, i * 2));
    const base = singleColumn(PHYSICAL_FIXED, { typeLength: 2 }, values, 6);
    // Replace the leaf SchemaElement end-of-struct after name "v" (0x18 0x01 0x76 0x00) with field 10 LogicalType.FLOAT16 (0x6c 0xfc 0x00 0x00 0x00)
    const leafTail = Buffer.from([0x18, 0x01, 0x76, 0x00]);
    const idx = base.lastIndexOf(leafTail);
    expect(idx).toBeGreaterThan(0);
    const withFloat16 = Buffer.concat([
      base.subarray(0, idx),
      Buffer.from([0x18, 0x01, 0x76, 0x6c, 0xfc, 0x00, 0x00, 0x00]),
      base.subarray(idx + leafTail.length),
    ]);
    withFloat16.writeUInt32LE(base.readUInt32LE(base.length - 8) + 4, withFloat16.length - 8);
    const decoded = decodeParquet(withFloat16).map((r) => r.v);
    expect(Object.is(decoded[0], 0)).toBe(true);
    expect(Object.is(decoded[1], -0)).toBe(true);
    expect(decoded.slice(2)).toEqual([1, -2.5, 2 ** -24, Number.POSITIVE_INFINITY]);
  });

  it('keeps unknown annotations as typed unsupported errors', () => {
    const interval = singleColumn(PHYSICAL_FIXED, { convertedType: CONVERTED_INTERVAL, typeLength: 12 }, Buffer.alloc(12), 1);
    let caught: unknown;
    try {
      decodeParquet(interval);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ParquetUnsupportedError);
    expect(caught).toBeInstanceOf(ConversionFailedError);
    expect((caught as Error).message).toMatch(/INTERVAL/);
  });

  it('rejects an annotation that contradicts the physical type as malformed', () => {
    const wrong = singleColumn(PHYSICAL_INT64, { convertedType: CONVERTED_DATE }, int64s(1n), 1);
    expect(() => decodeParquet(wrong)).toThrow(ParquetFormatError);
    expect(() => decodeParquet(wrong)).toThrow(/does not apply/);
  });
});
