import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { convertData } from '../src/lib/conversions/data';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { decodeParquet } from '../src/lib/conversions/parquet';

/**
 * Nested files: the files of the Apache parquet-testing corpus (commit 56653c43) that hold LIST, MAP, STRUCT or
 * repeated fields, the one nested file the repository already carried, and three files written by pyarrow 26 from
 * closed-form rows (list of struct, map of lists, nulls at every level, empty lists, several pages and row groups).
 * nested-expected.json holds the rows pyarrow 26 reads from each file, in the representation the converter writes;
 * see tests/fixtures/parquet/PROVENANCE.md. No expected value comes from this repository's reader.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'parquet');

/** How a table target cuts a column into cells: a map is one JSON cell, a struct one column per field, the rest one cell. */
type Shape = 'plain' | 'map' | { [field: string]: Shape };

interface Expectation {
  columns: string[];
  shapes: Record<string, Shape>;
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

  it('writes a struct as dotted columns and a list or map as one cell of compact JSON text', async () => {
    const result = await convertData(load(name), 'parquet', 'csv', { bom: false }, `${name}.parquet`);
    const parsed = Papa.parse<Record<string, string>>(result.buffer.toString('utf-8'), { header: true, skipEmptyLines: false });
    const header = want.columns.flatMap((column) => cellNames(column, want.shapes[column]));
    expect(parsed.meta.fields).toEqual(header);
    const table = parsed.data.filter((row) => Object.keys(row).length === header.length);
    expect(table.length).toBe(want.rows.length);
    want.rows.forEach((row, r) => {
      const cells = new Map(want.columns.flatMap((column) => cellsOf(column, row[column], want.shapes[column])));
      for (const [column, value] of cells) {
        const cell = table[r][column];
        if (value === null) {
          expect(cell).toBe('');
        } else if (isTicks(value)) {
          // The text of a year past 9999 starts with "+", which the csv writer's formula guard prefixes with a quote.
          const text = cell.replace(/^'/, '');
          expect(resolveTicks(value, text)).toBe(text);
        } else if (typeof value === 'object') {
          const got = JSON.parse(cell) as unknown;
          expect(got).toEqual(resolveTicks(value, got));
          expect(JSON.stringify(got)).toBe(cell);
        } else {
          expect(cell).toBe(String(resolveTicks(value, cell)));
        }
      }
    });
  });
});

/** The names of the columns a column is cut into: a struct gives one per field, whether or not a row holds the struct. */
function cellNames(name: string, shape: Shape): string[] {
  if (typeof shape === 'string') return [name];
  return Object.entries(shape).flatMap(([field, inner]) => cellNames(`${name}.${field}`, inner));
}

/** The cells of one row's value: a null struct leaves every one of its columns null. */
function cellsOf(name: string, value: unknown, shape: Shape): [string, unknown][] {
  if (typeof shape === 'string') return [[name, value]];
  const fields = (value ?? {}) as Record<string, unknown>;
  return Object.entries(shape).flatMap(([field, inner]) => cellsOf(`${name}.${field}`, fields[field] ?? null, inner));
}

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

  it('cuts a sheet the way csv is cut: one column per struct field, one cell for a list or a map', async () => {
    const name = 'nested/nullable.impala';
    const result = await convertData(load(name), 'parquet', 'xlsx', {}, 'nullable.impala.parquet');
    const [sheet] = await parseAllXlsxWorksheets(result.buffer);
    const header = expected[name].columns.flatMap((column) => cellNames(column, expected[name].shapes[column]));
    expect(sheet.rows[0]).toEqual(header);
    expect(header).toContain('nested_struct.C.d');
    expect(header).not.toContain('nested_struct');
    const column = (title: string): string[] => sheet.rows.slice(1).map((row) => row[header.indexOf(title)]);
    expect(column('id')).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(JSON.parse(column('int_map')[0])).toEqual({ k1: 1, k2: 100 });
    expect(JSON.parse(column('nested_struct.g')[0])).toEqual({ foo: { H: { i: [1.1] } } });
    expect(JSON.parse(column('nested_struct.b')[0])).toEqual([1]);
    // Row 3 holds a null for the field A of the struct and an empty map for its field g.
    expect(column('nested_struct.A')[2]).toBe('');
    expect(column('nested_struct.g')[2]).toBe('{}');
  });
});
