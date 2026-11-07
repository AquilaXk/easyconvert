import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { convertData } from '../src/lib/conversions/data';
import { decodeParquet } from '../src/lib/conversions/parquet';

/**
 * Nested files: the files of the Apache parquet-testing corpus (commit 56653c43) that hold LIST, MAP, STRUCT or
 * repeated fields, the one nested file the repository already carried, and three files written by pyarrow 26 from
 * closed-form rows (list of struct, map of lists, nulls at every level, empty lists, several pages and row groups).
 * nested-expected.json holds the rows pyarrow 26 reads from each file, in the representation the converter writes;
 * see tests/fixtures/parquet/PROVENANCE.md. No expected value comes from this repository's reader.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'parquet');

interface Expectation {
  columns: string[];
  rows: Record<string, unknown>[];
}

const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'nested-expected.json'), 'utf-8')) as Record<string, Expectation>;

function load(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.parquet`));
}

interface Ticks {
  $ticks: string;
  unit: 'us' | 'ms' | 'ns';
}

const TICKS_PER_MILLISECOND: Record<Ticks['unit'], bigint> = { ms: 1n, us: 1000n, ns: 1_000_000n };

function isTicks(value: unknown): value is Ticks {
  return typeof value === 'object' && value !== null && '$ticks' in value;
}

/**
 * A timestamp whose year Python cannot hold is expected as its integer ticks. The converter writes its text; the text
 * stands for the same instant when the engine's own date parser reads it back to those ticks.
 */
function resolveTicks(want: unknown, got: unknown): unknown {
  if (isTicks(want)) {
    if (typeof got !== 'string') return want;
    return BigInt(Date.parse(got)) * TICKS_PER_MILLISECOND[want.unit] === BigInt(want.$ticks) ? got : want;
  }
  if (Array.isArray(want) && Array.isArray(got)) return want.map((item, i) => resolveTicks(item, got[i]));
  if (typeof want === 'object' && want !== null && typeof got === 'object' && got !== null && !Array.isArray(got)) {
    const record = got as Record<string, unknown>;
    return Object.fromEntries(Object.entries(want).map(([key, value]) => [key, resolveTicks(value, record[key])]));
  }
  return want;
}

function resolveRows(want: Record<string, unknown>[], got: Record<string, unknown>[]): Record<string, unknown>[] {
  return want.map((row, i) => resolveTicks(row, got[i]) as Record<string, unknown>);
}

const names = Object.keys(expected);

describe.each(names)('%s', (name) => {
  const want = expected[name];

  it('reads the rows pyarrow reads', () => {
    const rows = decodeParquet(load(name));
    expect(rows.length).toBe(want.rows.length);
    expect(Object.keys(rows[0])).toEqual(want.columns);
    expect(rows).toEqual(resolveRows(want.rows, rows));
  });

  it('writes the same rows to json, keeping the nesting', async () => {
    const result = await convertData(load(name), 'parquet', 'json', {}, `${name}.parquet`);
    const rows = JSON.parse(result.buffer.toString('utf-8')) as Record<string, unknown>[];
    expect(rows).toEqual(resolveRows(want.rows, rows));
  });

  it('writes a nested value to one csv cell as compact JSON text', async () => {
    const result = await convertData(load(name), 'parquet', 'csv', { bom: false }, `${name}.parquet`);
    const parsed = Papa.parse<Record<string, string>>(result.buffer.toString('utf-8'), { header: true, skipEmptyLines: false });
    const table = parsed.data.filter((row) => Object.keys(row).length === want.columns.length);
    expect(parsed.meta.fields).toEqual(want.columns);
    expect(table.length).toBe(want.rows.length);
    want.rows.forEach((row, r) => {
      for (const column of want.columns) {
        const cell = table[r][column];
        const value = row[column];
        if (value === null) {
          expect(cell).toBe('');
        } else if (typeof value === 'object') {
          const got = JSON.parse(cell) as unknown;
          expect(got).toEqual(resolveTicks(value, got));
          expect(JSON.stringify(got)).toBe(cell);
        } else {
          expect(cell).toBe(String(value));
        }
      }
    });
  });
});

describe('a map whose key fields are optional', () => {
  // pyarrow refuses this file ("Map keys must be annotated as required"), so its values come from DuckDB 2.0.
  it('reads the map the writer meant', () => {
    const rows = decodeParquet(load('nested/incorrect_map_schema'));
    expect(rows).toEqual([{ my_map: { name: 'report', parent: 'another' } }]);
  });
});

describe('nested representation', () => {
  it('writes a map with string keys as an object and any other map as an array of key and value', () => {
    const rows = decodeParquet(load('nested/nested-mixed-v1'));
    expect(rows[1].attrs).toEqual({});
    expect(Array.isArray(rows[1].imap)).toBe(true);
    expect(rows[1].imap).toEqual([{ key: 100, value: 'v1_0' }]);
  });

  it('leaves the flat columns of a nested file as they are', () => {
    const rows = decodeParquet(load('nested/datapage_v2.snappy'));
    expect(rows[0]).toMatchObject({ a: 'abc', b: 1, c: 2, d: true, e: [1, 2, 3] });
  });
});
