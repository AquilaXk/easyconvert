import { describe, expect, it } from 'vitest';
import { oracleTest } from './helpers/oracle-test';
import { duckdbRead, pyarrowRead, pyarrowWrite } from './helpers/parquet-oracle';
import {
  delimitedToParquet,
  jsonLinesToDelimited,
  parquetToDelimited,
  parquetToJson,
} from '../src/lib/conversions/data-fast-paths';
import { chunkScratchLength, DelimitedByteScanner, DelimitedBytesUnsupported } from '../src/lib/conversions/delimited-bytes';
import { groupScratchRows } from '../src/lib/conversions/parquet-text-writer';
import { ChunkedOutput } from '../src/lib/conversions/chunked-output';
import { parseDelimitedRecords } from '../src/lib/conversions/delimited-detect';
import { convertData } from '../src/lib/conversions/data';
import { decodeParquet, encodeParquet, type ParquetWriteOptions } from '../src/lib/conversions/parquet';
import { parseJsonLossless, stringifyJsonLossless } from '../src/lib/conversions/data-json';
import { DataEncodingError, DataLimitExceededError, DataParseError, DataRepresentationError } from '../src/lib/types';

/**
 * The direct data routes (data-fast-paths.ts) write what the general route writes. The oracle of each case is the
 * general route itself, built from parts the direct route does not use: papaparse for reading delimited text and
 * encodeParquet for writing records. Inputs the direct route does not handle must come back as null, so the general
 * route reports them.
 */

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

const WORDS = ['alpha', 'Müller, Anna', '李小龍', 'São Paulo', 'say "hi"', 'two\nlines', 'cr\r\nlf', ' padded ', '', '1e5', '007', '😀 emoji', '=SUM(A1)', 'x'.repeat(300)];

function quoteIfNeeded(cell: string, delimiter: string, forceQuote: boolean): string {
  const needs = forceQuote || cell.includes(delimiter) || /["\r\n]/.test(cell);
  return needs ? `"${cell.replace(/"/g, '""')}"` : cell;
}

function csvText(rows: string[][], options: { delimiter?: string; newline?: string; trailing?: boolean; random?: () => number } = {}): string {
  const delimiter = options.delimiter ?? ',';
  const newline = options.newline ?? '\n';
  const random = options.random ?? (() => 0);
  const lines = rows.map((row) => row.map((cell) => quoteIfNeeded(cell, delimiter, random() < 0.1)).join(delimiter));
  return lines.join(newline) + (options.trailing === false ? '' : newline);
}

function generatedRows(seed: number, columns: number, rows: number): string[][] {
  const random = mulberry32(seed);
  const header = Array.from({ length: columns }, (_, c) => `col${c}`);
  const body = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => {
      const kind = (r + c + seed) % 5;
      if (kind === 0) return String(r);
      if (kind === 1) return WORDS[Math.floor(random() * WORDS.length)];
      if (kind === 2) return `v${Math.floor(random() * 7)}`;
      if (kind === 3) return random() < 0.3 ? '' : `unique-${r}-${c}`;
      return (random() * 1000).toFixed(3);
    })
  );
  return [header, ...body];
}

/** The general route: papaparse, then the record writer. */
function generalParquet(text: string, delimiter: string, options: ParquetWriteOptions = {}): Buffer {
  const { records } = parseDelimitedRecords(text, delimiter, 'csv');
  return encodeParquet(records, options);
}

function direct(text: string, options: ParquetWriteOptions = {}, delimiter?: string): Buffer | null {
  return delimitedToParquet(Buffer.from(text, 'utf8'), 'csv', delimiter === undefined ? {} : { delimiter }, options);
}

describe('delimited text to Parquet, direct route', () => {
  const cases: { name: string; text: string; options?: ParquetWriteOptions; delimiter?: string }[] = [
    { name: 'a small mixed table', text: csvText(generatedRows(1, 6, 40)) },
    { name: 'CRLF line breaks and quoted line breaks', text: csvText(generatedRows(2, 5, 60), { newline: '\r\n' }) },
    { name: 'no trailing line break', text: csvText(generatedRows(3, 4, 25), { trailing: false }) },
    { name: 'quoted cells everywhere', text: csvText(generatedRows(4, 4, 30), { random: () => 0 }).replace(/^/, '') },
    { name: 'a UTF-8 byte-order mark', text: `﻿${csvText(generatedRows(5, 3, 20))}` },
    { name: 'blank lines between records', text: 'a,b\n1,2\n\n3,4\n\n\n5,6\n' },
    { name: 'empty cells and an empty last cell', text: 'a,b,c\n,,\n1,,\n,2,3\n4,5,\n' },
    { name: 'duplicate header names', text: 'a,a,b,a_1\n1,2,3,4\n5,6,7,8\n' },
    { name: 'a semicolon delimiter named by the caller', text: csvText(generatedRows(6, 4, 30), { delimiter: ';' }), delimiter: ';' },
    { name: 'a tab delimiter named by the caller', text: csvText(generatedRows(7, 4, 30), { delimiter: '\t' }), delimiter: '\t' },
    { name: 'one wide column with a long value', text: `id,text\n1,${'y'.repeat(3000)}\n2,short\n` },
    { name: 'high-cardinality columns that fall back to PLAIN', text: csvText(generatedRows(8, 4, 3000)) },
    { name: 'a header only records column that is __proto__', text: '__proto__,constructor\n1,2\n3,4\n' },
    { name: 'tiny row groups and pages', text: csvText(generatedRows(9, 5, 200)), options: { rowGroupMaxRows: 33, dataPageMaxRows: 10 } },
    { name: 'row groups closed by a byte budget', text: csvText(generatedRows(10, 5, 200)), options: { rowGroupMaxBytes: 4000 } },
    { name: 'a dictionary too small to keep', text: csvText(generatedRows(11, 5, 300)), options: { dictionaryMaxBytes: 64 } },
    { name: 'no compression', text: csvText(generatedRows(12, 5, 120)), options: { codec: 0 } },
    { name: 'the bench-shaped table', text: csvText(generatedRows(13, 9, 2500)) },
  ];

  for (const item of cases) {
    it(`writes the bytes the general route writes: ${item.name}`, () => {
      const delimiter = item.delimiter ?? ',';
      const expected = generalParquet(item.text.replace(/^﻿/, ''), delimiter, item.options);
      const actual = direct(item.text, item.options, item.delimiter);
      expect(actual).not.toBeNull();
      expect((actual as Buffer).equals(expected)).toBe(true);
    });
  }

  describe('files larger than the line-break guess window', () => {
    const bigRows = (cell: (r: number) => string): string[][] => [['id', 'text', 'tail'], ...Array.from({ length: 9000 }, (_, r) => [String(r), cell(r), `t${r % 13}`])];

    const bigCases: { name: string; newline: string; cell: (r: number) => string }[] = [
      { name: 'LF records with CRLF inside quoted cells', newline: '\n', cell: (r) => `line ${'x'.repeat(100)}\r\nsecond ${r}` },
      { name: 'CRLF records with a bare LF inside quoted cells', newline: '\r\n', cell: (r) => `line ${'y'.repeat(100)}\nsecond ${r}` },
      { name: 'CRLF records without cell line breaks', newline: '\r\n', cell: (r) => `plain ${'z'.repeat(100)} ${r}` },
      { name: 'LF records with multi-byte text', newline: '\n', cell: (r) => `${'李'.repeat(40)} ${r}` },
    ];
    for (const item of bigCases) {
      it(`reads ${item.name} as the general route does`, () => {
        const text = csvText(bigRows(item.cell), { newline: item.newline });
        expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
        const actual = direct(text);
        expect(actual).not.toBeNull();
        expect((actual as Buffer).equals(generalParquet(text, ','))).toBe(true);
      });
    }
  });

  it('does not touch the input buffer when a cell holds doubled quotes', () => {
    const input = Buffer.from('a,b\n"say ""hi""",2\n"x",3\n', 'utf8');
    const before = Buffer.from(input);
    expect(delimitedToParquet(input, 'csv', {})).not.toBeNull();
    expect(input.equals(before)).toBe(true);
  });

  const declined: { name: string; bytes: Buffer; options?: { delimiter?: string; encoding?: string } }[] = [
    { name: 'a quote inside an unquoted cell', bytes: Buffer.from('a,b\nx"y,2\n') },
    { name: 'text after a closing quote', bytes: Buffer.from('a,b\n"x"y,2\n') },
    { name: 'an unterminated quote', bytes: Buffer.from('a,b\n"x,2\n3,4\n') },
    { name: 'a record with too many fields', bytes: Buffer.from('a,b\n1,2,3\n') },
    { name: 'a record with too few fields', bytes: Buffer.from('a,b\n1\n3,4\n') },
    { name: 'mixed line breaks', bytes: Buffer.from('a,b\r\n1,2\n3,4\r\n') },
    { name: 'a lone carriage return', bytes: Buffer.from('a,b\r1,2\r3,4\r') },
    { name: 'a header without records', bytes: Buffer.from('a,b\n') },
    { name: 'empty input', bytes: Buffer.alloc(0) },
    { name: 'text in another encoding', bytes: Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xe9, 0x2c, 0x32, 0x0a]) },
    { name: 'UTF-16 text', bytes: Buffer.from('﻿a,b\n1,2\n', 'utf16le') },
    { name: 'a one-column table, whose delimiter must be detected', bytes: Buffer.from('a\n1\n2\n') },
    { name: 'a header that names array indices', bytes: Buffer.from('b,10,2\n1,2,3\n') },
    { name: 'an encoding named by the caller', bytes: Buffer.from('a,b\n1,2\n'), options: { encoding: 'utf-8' } },
  ];
  for (const item of declined) {
    it(`declines ${item.name}`, () => {
      expect(delimitedToParquet(item.bytes, 'csv', item.options ?? {})).toBeNull();
    });
  }

  it('reads the same cells as the general reader across random tables', () => {
    for (let seed = 100; seed < 130; seed++) {
      const random = mulberry32(seed);
      const columns = 1 + Math.floor(random() * 8);
      const rows = 1 + Math.floor(random() * 80);
      const newline = random() < 0.3 ? '\r\n' : '\n';
      const text = csvText(generatedRows(seed, columns + 1, rows), { newline, random });
      const expected = generalParquet(text, ',');
      const actual = direct(text);
      expect(actual, `seed ${seed}`).not.toBeNull();
      expect((actual as Buffer).equals(expected), `seed ${seed}`).toBe(true);
    }
  });

  it('keeps the conversion result of convertData identical to the general route', async () => {
    const text = csvText(generatedRows(21, 7, 150));
    const result = await convertData(Buffer.from(text), 'csv', 'parquet', {}, 'table.csv');
    expect(result.buffer.equals(generalParquet(text, ','))).toBe(true);
    expect(result.mimeType).toBe('application/vnd.apache.parquet');
    expect(result.filename).toBe('table.parquet');
  });

  it('scans a header and chunks of records', () => {
    const scanner = DelimitedByteScanner.open(Buffer.from('a,b\n1,2\n3,4\n5,6\n'), ',', true);
    expect(scanner.header).toEqual(['a', 'b']);
    const first = scanner.nextChunk(2, Number.MAX_SAFE_INTEGER);
    expect(first?.rows).toBe(2);
    const second = scanner.nextChunk(2, Number.MAX_SAFE_INTEGER);
    expect(second?.rows).toBe(1);
    expect(scanner.nextChunk(2, Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(() => DelimitedByteScanner.open(Buffer.from('a,b\n1,2,3\n'), ',', true).nextChunk(5, 1000)).toThrow(DelimitedBytesUnsupported);
  });

  oracleTest('pyarrow and DuckDB read every cell of the direct output', ['python3'], () => {
    const rows = generatedRows(31, 6, 400);
    const text = csvText(rows);
    const output = direct(text) as Buffer;
    const expected = rows.slice(1);
    for (const columns of [pyarrowRead(output).columns, duckdbRead(output).columns]) {
      expect(Object.keys(columns)).toEqual(rows[0]);
      rows[0].forEach((name, c) => {
        expect(columns[name]).toEqual(expected.map((row) => row[c]));
      });
    }
  });
});

describe('Parquet to delimited text and JSON, direct routes', () => {
  const sampleRecords: Record<string, unknown>[] = [
    {
      id: 1,
      code: '00001',
      name: 'Müller, Anna',
      city: 'São Paulo',
      amount: 7506060,
      score: 153.375,
      active: false,
      note: 'say "hi"\ntwo lines',
      formula: '=SUM(A1)',
      minusExpr: '-2+3',
      negativeGrouped: '-566,000',
      padded: ' padded ',
    },
    {
      id: 2,
      code: '1e4',
      name: '李小龍',
      city: 'Osaka',
      amount: 0,
      score: -0.5,
      active: true,
      note: null,
      formula: '@cmd',
      minusExpr: '+A1',
      negativeGrouped: '-42.5',
      padded: '',
    },
    {
      id: 3,
      code: 'K-255',
      name: '😀 emoji',
      city: 'Nairobi',
      amount: -999999,
      score: 0,
      active: null,
      note: 'plain\ttab\r\ncrlf',
      formula: '\tleading tab',
      minusExpr: '- prose bullet',
      negativeGrouped: '+1,234.56',
      padded: 'trailing ',
    },
  ];

  it('writes the exact CSV and TSV bytes for mixed typed Parquet columns and options', async () => {
    const parquetBytes = encodeParquet(sampleRecords, { rowGroupMaxRows: 2 });
    for (const target of ['csv', 'tsv'] as const) {
      for (const bom of [undefined, true, false]) {
        for (const escapeFormulas of [undefined, true, false]) {
          const opts = {
            ...(bom === undefined ? {} : { bom }),
            ...(escapeFormulas === undefined ? {} : { escapeFormulas }),
          };
          const directBuf = parquetToDelimited(parquetBytes, target, opts);
          expect(directBuf).not.toBeNull();
          const general = await generalTable(parquetBytes, target, opts);
          expect((directBuf as Buffer).equals(general)).toBe(true);
        }
      }
    }
  });

  it('quotes an empty cell in a one-column Parquet table', () => {
    const parquetBytes = encodeParquet([{ only: 'alpha' }, { only: null }, { only: '' }, { only: 'beta' }]);
    const csvBuf = parquetToDelimited(parquetBytes, 'csv', { bom: false });
    expect(csvBuf).not.toBeNull();
    expect((csvBuf as Buffer).toString('utf8')).toBe('only\r\nalpha\r\n""\r\n""\r\nbeta');
  });

  it('writes the exact JSON bytes for Parquet tables including integer-named and __proto__ columns', () => {
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      const row: Record<string, unknown> = {};
      Object.defineProperty(row, 'z', { value: `row-${i}`, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(row, '10', { value: i * 10, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(row, '2', { value: i % 2 === 0 ? null : 'two\nlines "quoted"', enumerable: true, writable: true, configurable: true });
      Object.defineProperty(row, '__proto__', { value: i % 3 === 0, enumerable: true, writable: true, configurable: true });
      records.push(row);
    }
    const parquetBytes = encodeParquet(records, { rowGroupMaxRows: 15 });
    const directJson = parquetToJson(parquetBytes);
    expect(directJson).not.toBeNull();
    const expectedJson = stringifyJsonLossless(decodeParquet(parquetBytes) as never, 2);
    expect((directJson as Buffer).toString('utf8')).toBe(expectedJson);
  });

  it('writes non-finite doubles to CSV as the general route does, without a formula guard', async () => {
    const parquetBytes = encodeParquet([{ v: Number.NEGATIVE_INFINITY, w: 'a' }, { v: Number.POSITIVE_INFINITY, w: 'b' }, { v: Number.NaN, w: 'c' }]);
    const direct = parquetToDelimited(parquetBytes, 'csv', { bom: false });
    expect(direct).not.toBeNull();
    expect((direct as Buffer).toString('utf8')).toBe('v,w\r\n-Infinity,a\r\nInfinity,b\r\nNaN,c');
    const viaDecode = await convertData(parquetBytes, 'parquet', 'csv', { bom: false }, 'table.parquet');
    expect((direct as Buffer).equals(viaDecode.buffer)).toBe(true);
  });

  /** The general route for a Parquet file: its records, written as JSON, then read by the JSON-to-table route. */
  async function generalTable(parquetBytes: Buffer, target: 'csv' | 'tsv', options = {}): Promise<Buffer> {
    const json = stringifyJsonLossless(decodeParquet(parquetBytes) as never, 2);
    return (await convertData(Buffer.from(json, 'utf8'), 'json', target, options, 'table.json')).buffer;
  }

  it('reads many row groups and pages, with nulls, as the general route does', async () => {
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < 700; i++) {
      records.push({
        id: i,
        city: i % 5 === 0 ? null : ['São Paulo', 'Osaka', '李小龍', 'say "hi"', ' padded '][i % 5],
        unique: `row-${i}-${(i * 7919) % 1000}`,
        score: i % 9 === 0 ? null : (i % 800) / 8 + (i % 3) / 30,
        flag: i % 4 === 0 ? null : i % 3 === 0,
        wide: i % 11 === 0 ? 2 ** 40 + i : -i,
      });
    }
    const parquetBytes = encodeParquet(records, { rowGroupMaxRows: 130, dataPageMaxRows: 37 });
    for (const target of ['csv', 'tsv'] as const) {
      const direct = parquetToDelimited(parquetBytes, target, {});
      expect(direct).not.toBeNull();
      expect((direct as Buffer).equals(await generalTable(parquetBytes, target))).toBe(true);
    }
    expect(parquetToJson(parquetBytes).toString('utf8')).toBe(stringifyJsonLossless(decodeParquet(parquetBytes) as never, 2));
  });

  it('writes a string that needs a JSON escape and holds a non-ASCII letter', () => {
    const records = [{ s: 'ctl\u001d\u06fc "q" \\ é' }, { s: 'pair 😀 and \ttab' }, { s: 'plain' }];
    const parquetBytes = encodeParquet(records);
    expect(parquetToJson(parquetBytes).toString('utf8')).toBe(stringifyJsonLossless(decodeParquet(parquetBytes) as never, 2));
  });

  oracleTest('reads pages that end at different rows in each column, as the general route does', ['python3'], async () => {
    const rows = 260_000;
    const columns = {
      id: Array.from({ length: rows }, (_, i) => i),
      text: Array.from({ length: rows }, (_, i) => (i % 17 === 0 ? null : `unique text of row ${i} ${(i * 2654435761) % 1000003}`)),
      flag: Array.from({ length: rows }, (_, i) => i % 3 === 0),
      measure: Array.from({ length: rows }, (_, i) => (i % 1000) / 8),
    };
    const parquetBytes = pyarrowWrite(
      columns,
      [
        ['id', 'int64'],
        ['text', 'string'],
        ['flag', 'bool'],
        ['measure', 'double'],
      ],
      'snappy'
    );
    const direct = parquetToDelimited(parquetBytes, 'csv', {});
    expect(direct).not.toBeNull();
    expect((direct as Buffer).equals(await generalTable(parquetBytes, 'csv'))).toBe(true);
  }, 120_000);

  it('preserves -0 and rejects non-finite numbers in parquetToJson', () => {
    const negZeroParquet = encodeParquet([{ v: -0 }, { v: 1.5 }]);
    const directNegZero = parquetToJson(negZeroParquet);
    expect(directNegZero).not.toBeNull();
    expect((directNegZero as Buffer).toString('utf8')).toContain('-0');

    const nanParquet = encodeParquet([{ v: Number.NaN }]);
    expect(() => parquetToJson(nanParquet)).toThrow(DataRepresentationError);
  });
});

describe('JSON Lines to delimited text, direct route', () => {
  it('writes the exact CSV and TSV bytes for flat JSON Lines with escapes, big integers, and formulas', async () => {
    const lines = [
      '{"id":1,"big":90071992547409931234567890,"negZero":-0,"float":153.375,"active":true,"note":"say \\"hi\\"\\ntwo\\tlines","formula":"=SUM(A1)","grouped":"-566,000","empty":null}',
      '   ',
      '{"id":2,"big":-90071992547409931234567890,"negZero":0,"float":1e-7,"active":false,"note":"Müller, Anna","formula":"-2+3","grouped":"- prose","empty":""}',
      '{"id":3,"big":42,"negZero":-0.0,"float":20,"active":null,"note":" padded ","formula":"+A1","grouped":"1e4","empty":"slash \\\\ and \\/ and \\b\\f\\r"}',
    ];
    const input = Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
    const parsed = lines
      .filter((l) => l.trim().length > 0)
      .map((l, idx) => parseJsonLossless(l, 'JSONL', idx + 1) as Record<string, unknown>);
    const csvDirect = jsonLinesToDelimited(input, 'jsonl', 'csv', {});
    expect(csvDirect).not.toBeNull();
    const text = (csvDirect as Buffer).toString('utf8');
    expect(text.startsWith('\uFEFFid,big,negZero,float,active,note,formula,grouped,empty\r\n')).toBe(true);
    const general = (target: 'csv' | 'tsv') =>
      convertData(Buffer.from(stringifyJsonLossless(parsed as never, 2), 'utf8'), 'json', target, {}, 'table.json');
    expect((csvDirect as Buffer).equals((await general('csv')).buffer)).toBe(true);

    const tsvDirect = jsonLinesToDelimited(input, 'jsonl', 'tsv', {});
    expect(tsvDirect).not.toBeNull();
    expect((tsvDirect as Buffer).equals((await general('tsv')).buffer)).toBe(true);
  });

  it('handles rows that omit keys or reorder keys known from the first record', () => {
    const input = Buffer.from('{"a":1,"b":"two","c":true}\n{"c":false,"a":2}\n{"b":"three"}\n', 'utf8');
    const csvDirect = jsonLinesToDelimited(input, 'jsonl', 'csv', { bom: false });
    expect(csvDirect).not.toBeNull();
    expect((csvDirect as Buffer).toString('utf8')).toBe('a,b,c\r\n1,two,true\r\n2,,false\r\n,three,');
  });

  it('writes the rows of a file larger than one output chunk as the general route does', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 140_000; i++) {
      lines.push(`{"id":${i},"name":"${i % 7 === 0 ? 'Müller, Anna' : 'plain name'}","amount":${(i * 37) % 1000}.5,"ok":${i % 2 === 0},"note":${i % 5 === 0 ? 'null' : `"row ${i}"`}}`);
    }
    const input = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    expect(input.length).toBeGreaterThan(8 * 1024 * 1024);
    const direct = jsonLinesToDelimited(input, 'jsonl', 'csv', {});
    expect(direct).not.toBeNull();
    const records = lines.map((line, i) => parseJsonLossless(line, 'JSONL', i + 1));
    const general = await convertData(Buffer.from(stringifyJsonLossless(records as never, 2), 'utf8'), 'json', 'csv', {}, 'table.json');
    expect((direct as Buffer).equals(general.buffer)).toBe(true);
  }, 60_000);

  const declinedJsonl: { name: string; bytes: Buffer; error?: new (...args: never[]) => Error }[] = [
    { name: 'nested objects', bytes: Buffer.from('{"a":{"b":1}}\n') },
    { name: 'nested arrays', bytes: Buffer.from('{"a":[1,2]}\n') },
    { name: 'a new column appearing in a later row', bytes: Buffer.from('{"a":1}\n{"a":2,"b":3}\n') },
    { name: 'duplicate keys in the same object', bytes: Buffer.from('{"a":1,"a":2}\n') },
    { name: 'an empty object', bytes: Buffer.from('{}\n') },
    { name: 'a non-object record', bytes: Buffer.from('[1,2,3]\n') },
    { name: 'a \\uXXXX escape', bytes: Buffer.from('{"a":"\\u0041"}\n') },
    { name: 'an unpaired surrogate \\uD800', bytes: Buffer.from('{"a":"\\uD800"}\n'), error: DataRepresentationError },
    { name: 'an integer literal over 4096 digits', bytes: Buffer.from(`{"a":${'9'.repeat(4100)}}\n`), error: DataLimitExceededError },
    { name: 'a float outside IEEE 754 double range', bytes: Buffer.from('{"a":1e309}\n'), error: DataRepresentationError },
    { name: 'invalid JSON syntax', bytes: Buffer.from('{"a":1\n'), error: DataParseError },
    { name: 'empty input', bytes: Buffer.from('   \n  \n'), error: DataParseError },
    { name: 'UTF-16 input', bytes: Buffer.from('\uFEFF{"a":1}\n', 'utf16le'), error: DataEncodingError },
    { name: 'a digit-headed key name', bytes: Buffer.from('{"z":1,"0":2}\n') },
  ];

  for (const item of declinedJsonl) {
    it(`declines ${item.name} so the general route handles it`, async () => {
      expect(jsonLinesToDelimited(item.bytes, 'jsonl', 'csv', {})).toBeNull();
      if (item.error) {
        await expect(convertData(item.bytes, 'jsonl', 'csv', {}, 'in.jsonl')).rejects.toThrow(item.error);
      }
    });
  }
});


describe('scratch space of the delimited text to Parquet route', () => {
  it('returns to its initial size after a large conversion and after a failed one', () => {
    const initialChunk = chunkScratchLength();
    expect(groupScratchRows()).toBeLessThanOrEqual(4096);
    const rows = ['a,b,c,d'];
    for (let i = 0; i < 30000; i++) rows.push(`${i},v${i % 97},w${i},${i * 7}`);
    const big = Buffer.from(`${rows.join('\n')}\n`, 'utf8');
    const parquet = delimitedToParquet(big, 'csv', {});
    expect(parquet).not.toBeNull();
    expect(decodeParquet(parquet as Buffer)).toHaveLength(30000);
    expect(chunkScratchLength()).toBe(initialChunk);
    expect(groupScratchRows()).toBeLessThanOrEqual(4096);

    const oversized = Buffer.from(`${rows.join('\n')}\n`, 'utf8');
    expect(() => delimitedToParquet(oversized, 'csv', {}, { rowGroupMaxRows: 0 })).toThrow();
    expect(chunkScratchLength()).toBe(initialChunk);
    expect(groupScratchRows()).toBeLessThanOrEqual(4096);
  });
});

describe('ChunkedOutput size accounting', () => {
  it('accepts a write that fills maxBytes exactly and rejects one byte more', () => {
    const exact = new ChunkedOutput({ maxBytes: 10 });
    exact.writeUtf8('é'.repeat(5));
    expect(exact.length).toBe(10);
    expect(exact.toBuffer().toString('utf8')).toBe('é'.repeat(5));

    const over = new ChunkedOutput({ maxBytes: 10 });
    expect(() => over.writeUtf8('é'.repeat(5) + 'a')).toThrow(DataLimitExceededError);
    const overByMultibyte = new ChunkedOutput({ maxBytes: 9 });
    expect(() => overByMultibyte.writeUtf8('é'.repeat(5))).toThrow(DataLimitExceededError);
  });

  it('counts a three-byte character as three bytes, not as the worst case per UTF-16 unit', () => {
    const output = new ChunkedOutput({ maxBytes: 6 });
    output.writeUtf8('日本');
    expect(output.length).toBe(6);
    expect(output.toBuffer().equals(Buffer.from('日本', 'utf8'))).toBe(true);
  });

  it('does not keep a backing buffer larger than the bytes written beyond one chunk', () => {
    const chunkBytes = 64 * 1024;
    const output = new ChunkedOutput({ chunkBytes, expectedBytes: chunkBytes });
    const text = 'x'.repeat(200 * 1024);
    output.writeUtf8(text);
    output.writeUtf8('日本語');
    const joined = output.toBuffer();
    expect(joined.length).toBe(text.length + 9);
    expect(joined.buffer.byteLength - joined.length).toBeLessThan(chunkBytes);
  });
});
