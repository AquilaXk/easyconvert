import { describe, expect, it } from 'vitest';
import { oracleTest } from './helpers/oracle-test';
import { duckdbRead, pyarrowRead } from './helpers/parquet-oracle';
import { delimitedToParquet } from '../src/lib/conversions/data-fast-paths';
import { DelimitedByteScanner, DelimitedBytesUnsupported } from '../src/lib/conversions/delimited-bytes';
import { parseDelimitedRecords } from '../src/lib/conversions/delimited-detect';
import { convertData } from '../src/lib/conversions/data';
import { encodeParquet, type ParquetWriteOptions } from '../src/lib/conversions/parquet';

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
