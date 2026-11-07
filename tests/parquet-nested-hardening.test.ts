import { describe, expect, it } from 'vitest';
import {
  buildNestedParquet,
  dataPage,
  int32Plain,
  INT32,
  OPTIONAL,
  REPEATED,
  REQUIRED,
  rleRun,
} from './helpers/nested-parquet';
import type { SchemaField } from './helpers/nested-parquet';
import { decodeParquet, ParquetFormatError } from '../src/lib/conversions/parquet';

/**
 * Nested files built to make a reader do work or hold memory its input does not pay for: a schema deeper than any real
 * one, run-length encoded levels that name millions of entries in a few bytes, and level streams that disagree with each
 * other or with the row group. Each must be refused with a typed error, quickly.
 */

/** Hang guard only: a hostile file is refused in milliseconds; a reader that follows its claims takes seconds. */
const REJECT_HANG_GUARD_MS = 10_000;
const MAX_NESTING = 100;
const ENTRIES_OVER_CAP = 30_000_000;
const ENTRIES_UNDER_CAP = 15_000_000;

function refusal(file: Buffer): { elapsed: number; error: unknown } {
  const start = performance.now();
  try {
    decodeParquet(file);
    return { elapsed: performance.now() - start, error: null };
  } catch (error) {
    return { elapsed: performance.now() - start, error };
  }
}

function expectRefused(file: Buffer, message: RegExp): void {
  const { elapsed, error } = refusal(file);
  expect(error).toBeInstanceOf(ParquetFormatError);
  expect((error as Error).message).toMatch(message);
  expect(elapsed).toBeLessThan(REJECT_HANG_GUARD_MS);
}

/** Groups named `g` nested to `depth` names in all, the last one an optional int32 `v`. */
function chain(depth: number): SchemaField {
  let field: SchemaField = { name: 'v', repetition: OPTIONAL, physicalType: INT32 };
  for (let level = 1; level < depth; level++) field = { name: 'g', repetition: OPTIONAL, children: [field] };
  return field;
}

function chainPath(depth: number): string[] {
  return [...Array.from({ length: depth - 1 }, () => 'g'), 'v'];
}

function chainFile(depth: number): Buffer {
  const pages = dataPage({
    numValues: 1,
    definition: [depth],
    maxRepetition: 0,
    maxDefinition: depth,
    values: int32Plain([7]),
  });
  return buildNestedParquet({
    fields: [chain(depth)],
    rowGroups: [{ numRows: 1, chunks: [{ path: chainPath(depth), physicalType: INT32, numValues: 1, pages }] }],
  });
}

const REPEATED_INT: SchemaField[] = [{ name: 'xs', repetition: REPEATED, physicalType: INT32 }];

function repeatedFile(options: { numRows: number; entries: number; repetition: Buffer | number[]; definition: Buffer | number[]; values: Buffer }): Buffer {
  const pages = dataPage({
    numValues: options.entries,
    repetition: options.repetition,
    definition: options.definition,
    maxRepetition: 1,
    maxDefinition: 1,
    values: options.values,
  });
  return buildNestedParquet({
    fields: REPEATED_INT,
    rowGroups: [{ numRows: options.numRows, chunks: [{ path: ['xs'], physicalType: INT32, numValues: options.entries, pages }] }],
  });
}

describe('schema depth', () => {
  it('reads a column nested as deep as the limit allows', () => {
    let value: unknown = { v: 7 };
    for (let level = 1; level < MAX_NESTING; level++) value = { g: value };
    const rows = decodeParquet(chainFile(MAX_NESTING));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(value);
  });

  it('refuses a column nested one level past the limit, before any page is read', () => {
    expectRefused(chainFile(MAX_NESTING + 1), /nesting deeper than 100 levels/);
  });

  it('refuses a column path longer than the limit in a chunk', () => {
    const file = buildNestedParquet({
      fields: [chain(2)],
      rowGroups: [
        {
          numRows: 1,
          chunks: [
            {
              path: chainPath(MAX_NESTING + 1),
              physicalType: INT32,
              numValues: 1,
              pages: dataPage({ numValues: 1, definition: [2], maxRepetition: 0, maxDefinition: 2, values: int32Plain([1]) }),
            },
          ],
        },
      ],
    });
    expectRefused(file, /exceeds 100 levels/);
  });
});

describe('repetition levels that claim more than the file holds', () => {
  it('refuses a chunk that declares more entries than the cell limit before reading a page', () => {
    const file = repeatedFile({
      numRows: 1,
      entries: ENTRIES_OVER_CAP,
      repetition: rleRun(ENTRIES_OVER_CAP, 0, 1),
      definition: rleRun(ENTRIES_OVER_CAP, 1, 1),
      values: Buffer.alloc(0),
    });
    expectRefused(file, /repeated columns hold more than 20000000 values/);
  });

  it('refuses a few bytes of levels that name millions of values the page does not hold', () => {
    const repetition = Buffer.concat([rleRun(1, 0, 1), rleRun(ENTRIES_UNDER_CAP - 1, 1, 1)]);
    const file = repeatedFile({
      numRows: 1,
      entries: ENTRIES_UNDER_CAP,
      repetition,
      definition: rleRun(ENTRIES_UNDER_CAP, 1, 1),
      values: int32Plain([1, 2, 3]),
    });
    expect(file.length).toBeLessThan(1024);
    expectRefused(file, /truncated int32 data/);
  });
});

describe('levels that do not match the page or the row group', () => {
  it('refuses repetition levels that end before the entries the page declares', () => {
    const file = repeatedFile({ numRows: 1, entries: 10, repetition: rleRun(4, 0, 1), definition: rleRun(10, 1, 1), values: int32Plain([1]) });
    expectRefused(file, /RLE/);
  });

  it('refuses a column whose records are fewer than the rows of its row group', () => {
    const file = repeatedFile({ numRows: 3, entries: 3, repetition: [0, 1, 1], definition: [1, 1, 1], values: int32Plain([1, 2, 3]) });
    expectRefused(file, /holds 1 records for a row group of 3 rows/);
  });

  it('refuses a column whose first entry continues a record that never began', () => {
    const file = repeatedFile({ numRows: 1, entries: 2, repetition: [1, 0], definition: [1, 1], values: int32Plain([1, 2]) });
    expectRefused(file, /holds 1 records|records for a row group/);
  });

  it('refuses a definition level above the column maximum', () => {
    const fields: SchemaField[] = [{ name: 'g', repetition: OPTIONAL, children: [{ name: 'v', repetition: OPTIONAL, physicalType: INT32 }] }];
    const pages = dataPage({ numValues: 2, definition: [2, 3], maxRepetition: 0, maxDefinition: 2, values: int32Plain([1, 2]) });
    const file = buildNestedParquet({
      fields,
      rowGroups: [{ numRows: 2, chunks: [{ path: ['g', 'v'], physicalType: INT32, numValues: 2, pages }] }],
    });
    expectRefused(file, /definition level 3 out of range/);
  });

  it('refuses a repetition level above the column maximum', () => {
    const fields: SchemaField[] = [{ name: 'a', repetition: REPEATED, children: [{ name: 'b', repetition: REPEATED, physicalType: INT32 }] }];
    const pages = dataPage({ numValues: 2, repetition: [0, 3], definition: [2, 2], maxRepetition: 2, maxDefinition: 2, values: int32Plain([1, 2]) });
    const file = buildNestedParquet({
      fields,
      rowGroups: [{ numRows: 1, chunks: [{ path: ['a', 'b'], physicalType: INT32, numValues: 2, pages }] }],
    });
    expectRefused(file, /repetition level 3 out of range/);
  });

  describe('two columns of one repeated group', () => {
    const fields: SchemaField[] = [
      {
        name: 'items',
        repetition: REPEATED,
        children: [
          { name: 'p', repetition: REQUIRED, physicalType: INT32 },
          { name: 'q', repetition: REQUIRED, physicalType: INT32 },
        ],
      },
    ];

    function twoColumns(pEntries: number[], qEntries: number[]): Buffer {
      const page = (repetition: number[], values: number[]): Buffer =>
        dataPage({ numValues: repetition.length, repetition, maxRepetition: 1, maxDefinition: 1, definition: repetition.map(() => 1), values: int32Plain(values) });
      return buildNestedParquet({
        fields,
        rowGroups: [
          {
            numRows: 1,
            chunks: [
              { path: ['items', 'p'], physicalType: INT32, numValues: pEntries.length, pages: page(pEntries, pEntries.map((_, i) => i)) },
              { path: ['items', 'q'], physicalType: INT32, numValues: qEntries.length, pages: page(qEntries, qEntries.map((_, i) => i)) },
            ],
          },
        ],
      });
    }

    it('reads columns that agree', () => {
      expect(decodeParquet(twoColumns([0, 1, 1], [0, 1, 1]))).toEqual([{ items: [{ p: 0, q: 0 }, { p: 1, q: 1 }, { p: 2, q: 2 }] }]);
    });

    it('refuses a column that ends before its sibling', () => {
      expectRefused(twoColumns([0, 1, 1], [0, 1]), /ends before all rows are present/);
    });

    it('refuses a column that holds entries its sibling never reads', () => {
      expectRefused(twoColumns([0, 1], [0, 1, 1]), /holds entries beyond the rows/);
    });
  });
});
