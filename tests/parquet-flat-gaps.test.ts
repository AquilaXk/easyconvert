import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertData } from '../src/lib/conversions/data';
import { decodeParquet } from '../src/lib/conversions/parquet';

/**
 * Flat files from the Apache parquet-testing corpus (commit 56653c43) that the reader used to refuse.
 * The expected values in parquet-testing-expected.json were written from pyarrow 26 reading the same
 * files (first rows and the last row, binary as UTF-8 text or base64, geospatial always base64); see
 * tests/fixtures/parquet/PROVENANCE.md.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'parquet');

interface Expectation {
  rows: number;
  columns: string[];
  pick: number[];
  values: Record<string, unknown[]>;
}

const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'parquet-testing-expected.json'), 'utf-8')) as Record<
  string,
  Expectation
>;

function load(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.parquet`));
}

describe.each(Object.keys(expected))('%s', (name) => {
  const want = expected[name];

  it('reads the rows pyarrow reads', () => {
    const rows = decodeParquet(load(name));
    expect(rows.length).toBe(want.rows);
    expect(Object.keys(rows[0])).toEqual(want.columns);
    for (const column of want.columns) {
      expect(want.pick.map((i) => rows[i][column])).toEqual(want.values[column]);
    }
  });

  it('writes the same values to csv and json', async () => {
    const json = await convertData(load(name), 'parquet', 'json', {}, `${name}.parquet`);
    const rows = JSON.parse(json.buffer.toString('utf-8')) as Record<string, unknown>[];
    expect(rows.length).toBe(want.rows);
    for (const column of want.columns) {
      expect(want.pick.map((i) => rows[i][column])).toEqual(want.values[column]);
    }
    const csv = await convertData(load(name), 'parquet', 'csv', {}, `${name}.parquet`);
    expect(csv.buffer.toString('utf-8').split('\n')[0]).toContain(want.columns[0]);
  });
});
