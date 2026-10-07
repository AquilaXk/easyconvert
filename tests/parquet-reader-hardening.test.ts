import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { oracleTest } from './helpers/oracle-test';
import { pyarrowCompress, pyarrowRead } from './helpers/parquet-oracle';
import {
  buildHostileParquet,
  CODEC_SNAPPY,
  CODEC_UNCOMPRESSED,
  CODEC_ZSTD,
  ENC_PLAIN,
  ENC_RLE_DICTIONARY,
  pageHeader,
  PAGE_DATA,
  PAGE_DICTIONARY,
  PHYSICAL_BYTE_ARRAY,
  PHYSICAL_INT64,
  REPETITION_OPTIONAL,
  REPETITION_REQUIRED,
} from './helpers/hostile-parquet';
import { convertData } from '../src/lib/conversions/data';
import { decodeParquet, ParquetFormatError } from '../src/lib/conversions/parquet';
import { ConversionFailedError } from '../src/lib/types';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/**
 * Reader hardening: every file below is hand-assembled so that a naive reader would amplify a tiny
 * input into gigabytes of work or memory. The reader must answer with a typed error, quickly.
 */

const MIB = 1024 * 1024;
/** Hang guard only: a hostile file is refused in milliseconds; a reader that follows its claims takes seconds to minutes. */
const REJECT_HANG_GUARD_MS = 10_000;
const FILE_START = 4;

function int64Leaves(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `c${i}`,
    physicalType: PHYSICAL_INT64,
    repetition: REPETITION_REQUIRED,
  }));
}

function varint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Buffer.from(out);
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
}

function timed<T>(fn: () => T): { elapsed: number; error: unknown } {
  const start = performance.now();
  let error: unknown = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  return { elapsed: performance.now() - start, error };
}

describe('Parquet reader decompression amplification', () => {
  oracleTest('64 column chunks pointing at one 256 MiB ZSTD page are rejected without decompressing', ['python3'], () => {
    const frame = pyarrowCompress('zstd', Buffer.alloc(256 * MIB));
    const header = pageHeader({ type: PAGE_DATA, uncompressed: 256 * MIB, compressed: frame.length, numValues: 1000 });
    const body = Buffer.concat([header, frame]);
    const leaves = int64Leaves(64);
    const file = buildHostileParquet({
      body,
      leaves,
      rowGroups: [
        {
          numRows: 1000,
          chunks: leaves.map((leaf) => ({
            name: leaf.name,
            physicalType: PHYSICAL_INT64,
            codec: CODEC_ZSTD,
            numValues: 1000,
            dataPageOffset: FILE_START,
            totalCompressedSize: body.length,
          })),
        },
      ],
    });
    expect(file.length).toBeLessThan(MIB);
    const { elapsed, error } = timed(() => decodeParquet(file));
    expect(error).toBeInstanceOf(ParquetFormatError);
    expect((error as Error).message).toMatch(/overlap/);
    expect(elapsed).toBeLessThan(REJECT_HANG_GUARD_MS);
  });

  it('a column chunk over a zero-filled region fails on the missing page header, quickly', () => {
    const body = Buffer.alloc(4096);
    const file = buildHostileParquet({
      body,
      leaves: int64Leaves(1),
      rowGroups: [
        {
          numRows: 10,
          chunks: [
            { name: 'c0', physicalType: PHYSICAL_INT64, codec: CODEC_UNCOMPRESSED, numValues: 10, dataPageOffset: FILE_START, totalCompressedSize: 4096 },
          ],
        },
      ],
    });
    const { elapsed, error } = timed(() => decodeParquet(file));
    expect(error).toBeInstanceOf(ParquetFormatError);
    expect((error as Error).message).toMatch(/page header is missing/);
    expect(elapsed).toBeLessThan(REJECT_HANG_GUARD_MS);
  });

  it('charges every page against one decompression budget before decompressing any of them', () => {
    const header = pageHeader({ type: PAGE_DATA, uncompressed: 256 * MIB, compressed: 10, numValues: 10 });
    const page = Buffer.concat([header, Buffer.alloc(10, 0x41)]);
    const leaves = int64Leaves(5);
    const file = buildHostileParquet({
      body: Buffer.concat(leaves.map(() => page)),
      leaves,
      rowGroups: [
        {
          numRows: 10,
          chunks: leaves.map((leaf, i) => ({
            name: leaf.name,
            physicalType: PHYSICAL_INT64,
            codec: CODEC_SNAPPY,
            numValues: 10,
            dataPageOffset: FILE_START + i * page.length,
            totalCompressedSize: page.length,
          })),
        },
      ],
    });
    const { elapsed, error } = timed(() => decodeParquet(file));
    expect(error).toBeInstanceOf(ParquetFormatError);
    expect((error as Error).message).toMatch(/decompress to more than/);
    expect(elapsed).toBeLessThan(REJECT_HANG_GUARD_MS);
  });

  function singleChunkFile(pageBytes: Buffer, totalCompressedSize = pageBytes.length, numValues = 10) {
    return buildHostileParquet({
      body: pageBytes,
      leaves: int64Leaves(1),
      rowGroups: [
        {
          numRows: numValues,
          chunks: [
            { name: 'c0', physicalType: PHYSICAL_INT64, codec: CODEC_UNCOMPRESSED, numValues, dataPageOffset: FILE_START, totalCompressedSize },
          ],
        },
      ],
    });
  }

  it('requires the page header to declare its type and both sizes', () => {
    const noCompressed = Buffer.concat([pageHeader({ type: PAGE_DATA, uncompressed: 80, numValues: 10 }), Buffer.alloc(80)]);
    expect(() => decodeParquet(singleChunkFile(noCompressed))).toThrow(/compressed_page_size/);
    const noUncompressed = Buffer.concat([pageHeader({ type: PAGE_DATA, compressed: 80, numValues: 10 }), Buffer.alloc(80)]);
    expect(() => decodeParquet(singleChunkFile(noUncompressed))).toThrow(/uncompressed_page_size/);
  });

  it('rejects empty page bodies and data pages without values', () => {
    const emptyBody = pageHeader({ type: PAGE_DATA, uncompressed: 0, compressed: 0, numValues: 10 });
    expect(() => decodeParquet(singleChunkFile(emptyBody))).toThrow(/empty page/);
    const noValues = Buffer.concat([pageHeader({ type: PAGE_DATA, uncompressed: 8, compressed: 8, numValues: 0 }), Buffer.alloc(8)]);
    expect(() => decodeParquet(singleChunkFile(noValues))).toThrow(/no values/);
  });

  it('rejects chunk ranges that leave the data section', () => {
    const page = Buffer.concat([pageHeader({ type: PAGE_DATA, uncompressed: 80, compressed: 80, numValues: 10 }), Buffer.alloc(80)]);
    expect(() => decodeParquet(singleChunkFile(page, page.length + 5000))).toThrow(/outside the data section/);
    expect(() => decodeParquet(singleChunkFile(page, 0))).toThrow(/total_compressed_size/);
  });

  it('requires every row group to carry every schema column exactly once', () => {
    const page = Buffer.concat([pageHeader({ type: PAGE_DATA, uncompressed: 80, compressed: 80, numValues: 10 }), Buffer.alloc(80)]);
    const leaves = int64Leaves(2);
    const chunk = (name: string, offset: number) => ({
      name,
      physicalType: PHYSICAL_INT64,
      codec: CODEC_UNCOMPRESSED,
      numValues: 10,
      dataPageOffset: offset,
      totalCompressedSize: page.length,
    });
    const missing = buildHostileParquet({ body: page, leaves, rowGroups: [{ numRows: 10, chunks: [chunk('c0', FILE_START)] }] });
    expect(() => decodeParquet(missing)).toThrow(/exactly once/);
    const duplicate = buildHostileParquet({
      body: Buffer.concat([page, page]),
      leaves,
      rowGroups: [{ numRows: 10, chunks: [chunk('c0', FILE_START), chunk('c0', FILE_START + page.length)] }],
    });
    expect(() => decodeParquet(duplicate)).toThrow(/exactly once/);
  });

  it('reads a well-formed hand-assembled file (the builder itself is sound)', () => {
    const values = Buffer.alloc(80);
    for (let i = 0; i < 10; i++) values.writeBigInt64LE(BigInt(i * 3 - 4), i * 8);
    const page = Buffer.concat([pageHeader({ type: PAGE_DATA, uncompressed: 80, compressed: 80, numValues: 10 }), values]);
    const rows = decodeParquet(singleChunkFile(page));
    expect(rows.map((r) => r.c0)).toEqual([-4, -1, 2, 5, 8, 11, 14, 17, 20, 23]);
  });
});

describe('Parquet reader output amplification', () => {
  const DICTIONARY_ENTRY_BYTES = 100;
  const BOMB_ROWS = 10_000_000;
  const RSS_GROWTH_LIMIT = 300 * MIB;

  function dictionaryBomb(): Buffer {
    const dictBody = Buffer.concat([u32(DICTIONARY_ENTRY_BYTES), Buffer.alloc(DICTIONARY_ENTRY_BYTES, 0x61)]);
    const dictHeader = pageHeader({ type: PAGE_DICTIONARY, uncompressed: dictBody.length, compressed: dictBody.length, numValues: 1, encoding: ENC_PLAIN });
    const levelRun = Buffer.concat([varint(BOMB_ROWS * 2), Buffer.from([1])]);
    const indexRun = Buffer.concat([Buffer.from([1]), varint(BOMB_ROWS * 2), Buffer.from([0])]);
    const dataBody = Buffer.concat([u32(levelRun.length), levelRun, indexRun]);
    const dataHeader = pageHeader({
      type: PAGE_DATA,
      uncompressed: dataBody.length,
      compressed: dataBody.length,
      numValues: BOMB_ROWS,
      encoding: ENC_RLE_DICTIONARY,
    });
    const body = Buffer.concat([dictHeader, dictBody, dataHeader, dataBody]);
    return buildHostileParquet({
      body,
      leaves: [{ name: 's', physicalType: PHYSICAL_BYTE_ARRAY, repetition: REPETITION_OPTIONAL }],
      rowGroups: [
        {
          numRows: BOMB_ROWS,
          chunks: [
            {
              name: 's',
              physicalType: PHYSICAL_BYTE_ARRAY,
              codec: CODEC_UNCOMPRESSED,
              numValues: BOMB_ROWS,
              dictionaryPageOffset: FILE_START,
              dataPageOffset: FILE_START + dictHeader.length + dictBody.length,
              totalCompressedSize: body.length,
            },
          ],
        },
      ],
    });
  }

  it('a few hundred bytes cannot expand into ten million repeated dictionary strings', () => {
    const file = dictionaryBomb();
    expect(file.length).toBeLessThan(512);
    const rssBefore = process.memoryUsage().rss;
    const { error } = timed(() => decodeParquet(file));
    expect(error).toBeInstanceOf(ParquetFormatError);
    expect((error as Error).message).toMatch(/decoded values exceed/);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(RSS_GROWTH_LIMIT);
  });

  it('answers a typed 400-class error through convertData for every parquet target', async () => {
    const file = dictionaryBomb();
    for (const target of ['json', 'csv', 'ndjson']) {
      const failure = await convertData(file, 'parquet', target, {}, 'bomb.parquet').then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toMatch(/decoded values exceed/);
    }
  });
});

describe('Parquet reader hostile structures', () => {
  const HOSTILE_ROWS = 10_000_001;

  function dictionaryFile(indexBitWidth: number, indexRun: Buffer, entries = 2): Buffer {
    const parts: Buffer[] = [];
    for (let i = 0; i < entries; i++) parts.push(u32(1), Buffer.from(String.fromCharCode(0x61 + i)));
    const dictBody = Buffer.concat(parts);
    const dictHeader = pageHeader({ type: PAGE_DICTIONARY, uncompressed: dictBody.length, compressed: dictBody.length, numValues: entries, encoding: ENC_PLAIN });
    const dataBody = Buffer.concat([Buffer.from([indexBitWidth]), indexRun]);
    const dataHeader = pageHeader({ type: PAGE_DATA, uncompressed: dataBody.length, compressed: dataBody.length, numValues: 1, encoding: ENC_RLE_DICTIONARY });
    const body = Buffer.concat([dictHeader, dictBody, dataHeader, dataBody]);
    return buildHostileParquet({
      body,
      leaves: [{ name: 's', physicalType: PHYSICAL_BYTE_ARRAY, repetition: REPETITION_REQUIRED }],
      rowGroups: [
        {
          numRows: 1,
          chunks: [
            {
              name: 's',
              physicalType: PHYSICAL_BYTE_ARRAY,
              codec: CODEC_UNCOMPRESSED,
              numValues: 1,
              dictionaryPageOffset: FILE_START,
              dataPageOffset: FILE_START + dictHeader.length + dictBody.length,
              totalCompressedSize: body.length,
            },
          ],
        },
      ],
    });
  }

  it('reads a well-formed dictionary file (the builder is sound)', () => {
    // RLE run of one value: header 1<<1, value 1 -> second entry
    expect(decodeParquet(dictionaryFile(1, Buffer.from([0x02, 0x01]))).map((r) => r.s)).toEqual(['b']);
  });

  it('rejects a dictionary index past the end of the dictionary', () => {
    const file = dictionaryFile(2, Buffer.from([0x02, 0x03]));
    expect(() => decodeParquet(file)).toThrow(ParquetFormatError);
    expect(() => decodeParquet(file)).toThrow(/dictionary index 3 out of range \(2 entries\)/);
  });

  it('rejects a dictionary index bit width above 32', () => {
    expect(() => decodeParquet(dictionaryFile(33, Buffer.from([0x02, 0x01])))).toThrow(/bit width 33/);
  });

  it('rejects a dictionary-encoded page whose dictionary page is missing', () => {
    const dataBody = Buffer.from([1, 0x02, 0x00]);
    const dataHeader = pageHeader({ type: PAGE_DATA, uncompressed: dataBody.length, compressed: dataBody.length, numValues: 1, encoding: ENC_RLE_DICTIONARY });
    const body = Buffer.concat([dataHeader, dataBody]);
    const file = buildHostileParquet({
      body,
      leaves: [{ name: 's', physicalType: PHYSICAL_BYTE_ARRAY, repetition: REPETITION_REQUIRED }],
      rowGroups: [
        {
          numRows: 1,
          chunks: [{ name: 's', physicalType: PHYSICAL_BYTE_ARRAY, codec: CODEC_UNCOMPRESSED, numValues: 1, dataPageOffset: FILE_START, totalCompressedSize: body.length }],
        },
      ],
    });
    expect(() => decodeParquet(file)).toThrow(/without a dictionary/);
  });

  it('rejects a footer declaring more rows than the engine limit', () => {
    const file = buildHostileParquet({ body: Buffer.alloc(0), leaves: int64Leaves(1), rowGroups: [], numRows: HOSTILE_ROWS });
    expect(() => decodeParquet(file)).toThrow(ParquetFormatError);
    expect(() => decodeParquet(file)).toThrow(/10000001 rows exceed the limit/);
  });

  function withFooter(footer: Buffer): Buffer {
    const length = u32(footer.length);
    return Buffer.concat([Buffer.from('PAR1'), footer, length, Buffer.from('PAR1')]);
  }

  it('rejects a footer list that claims a hundred million schema elements', () => {
    // field 2 (list, delta 2), list header: size >= 15 with struct elements, varint 100,000,000
    const footer = Buffer.concat([Buffer.from([0x29, 0xfc]), varint(100_000_000), Buffer.from([0x00])]);
    expect(() => decodeParquet(withFooter(footer))).toThrow(/list size 100000000 exceeds remaining buffer bytes/);
  });

  it('rejects a footer whose unknown field nests structs beyond the depth limit', () => {
    // field 5 (struct, delta 5) followed by 40 nested structs (field delta 1, struct)
    const footer = Buffer.concat([Buffer.from([0x5c]), Buffer.alloc(40, 0x1c), Buffer.alloc(41, 0x00)]);
    expect(() => decodeParquet(withFooter(footer))).toThrow(/nesting deeper than 32 levels/);
  });

  it('rejects a footer that ends in the middle of a struct', () => {
    const footer = Buffer.from([0x15, 0x02]);
    expect(() => decodeParquet(withFooter(footer))).toThrow(/unexpected EOF/);
  });
});

describe('Parquet files written by earlier easyconvert versions', () => {
  const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'parquet');
  const legacy = fs.readFileSync(path.join(FIXTURE_DIR, 'legacy-writer.parquet'));

  it('still decode to the rows they were written from', () => {
    expect(decodeParquet(legacy)).toEqual([
      { id: 1, name: 'alpha', score: 1.5, ok: true },
      { id: 2, name: 'beta', score: 2.25, ok: false },
      { id: 3, name: 'gamma', score: -0.5, ok: true },
      { id: 4, name: 'caf\u00e9 \u{1f600}', score: 1000000.125, ok: false },
    ]);
  });

  oracleTest('are the invalid layout that issue 526 describes (the reference reader rejects them)', ['python3'], () => {
    expect(() => pyarrowRead(legacy)).toThrow(/Unknown encoding type for levels/);
  });
});
