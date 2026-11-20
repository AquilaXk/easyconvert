/* eslint-disable camelcase -- the identifiers are those of the Python source */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  cells_to_tables,
  cluster_list,
  edges_to_intersections,
  filter_edges,
  intersections_to_cells,
  join_edge_group,
  merge_edges,
  snap_edges,
  TableFinder,
  TableSettings,
  words_to_edges_h,
  words_to_edges_v,
  type T_bbox,
  type T_obj,
  type T_table_settings,
} from '../src/lib/conversions/pdfplumber-table';

/*
 * The table finder of pdfplumber (src/lib/conversions/pdfplumber-table.ts) against pdfplumber itself. Each case of
 * tests/fixtures/pdfplumber-table/cases.json.gz is a page of a real PDF of the real-world corpus (the government files govdocs1-*) as
 * pdfplumber 0.11.10 reads it: the page's edges (`page.edges`), its words when the settings use the text strategy, and what
 * `TableFinder` of that version answered for the settings (the merged edges, the number of crossings, the cells, the tables, and the
 * rows and columns of the first). The translation has to answer the same, number for number. `make-cases.py` writes the file.
 * The error cases are those of `test_orientation_errors` and `test_table_settings_errors` in tests/test_table.py of pdfplumber
 * (commit 4c64b92d5caccd71c645e98e0fabb0c4dba7ff45, MIT, Copyright (c) 2015, Jeremy Singer-Vine; see NOTICE and docs/licensing.md).
 */

interface Case {
  name: string;
  settings: Record<string, unknown>;
  bbox: T_bbox;
  edges: T_obj[];
  words: T_obj[] | null;
  expected: {
    edges: T_obj[];
    intersections: number;
    cells: T_bbox[];
    tables: T_bbox[][];
    rows: (T_bbox | null)[][][];
    columns: (T_bbox | null)[][][];
  };
}

const CASES: Case[] = JSON.parse(gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/pdfplumber-table/cases.json.gz'))).toString('utf8'));

function pageOf(testCase: Case): ConstructorParameters<typeof TableFinder>[0] {
  return { bbox: testCase.bbox, edges: testCase.edges, extract_words: () => testCase.words ?? [] };
}

describe('TableFinder against pdfplumber 0.11.10', () => {
  for (const testCase of CASES) {
    describe(testCase.name, () => {
      const finder = new TableFinder(pageOf(testCase), testCase.settings as T_table_settings);

      it('merges the edges as pdfplumber does', () => {
        expect(finder.edges).toEqual(testCase.expected.edges);
      });

      it('finds the same crossings and cells', () => {
        expect(finder.intersections.size).toBe(testCase.expected.intersections);
        expect(finder.cells).toEqual(testCase.expected.cells);
      });

      it('groups the cells into the same tables, rows and columns', () => {
        expect(finder.tables.map((table) => table.cells)).toEqual(testCase.expected.tables);
        expect(finder.tables.slice(0, 2).map((table) => table.rows.map((row) => row.cells))).toEqual(testCase.expected.rows);
        expect(finder.tables.slice(0, 1).map((table) => table.columns.map((column) => column.cells))).toEqual(testCase.expected.columns);
      });
    });
  }
});

describe('the pieces of the finder', () => {
  const horizontal = (x0: number, x1: number, top: number): T_obj => ({ x0, x1, top, bottom: top, width: x1 - x0, orientation: 'h', object_type: 'line' });
  const vertical = (x0: number, top: number, bottom: number): T_obj => ({ x0, x1: x0, top, bottom, height: bottom - top, orientation: 'v', object_type: 'line' });

  it('test_orientation_errors', () => {
    expect(() => join_edge_group([], 'x')).toThrow(/Orientation must be/);
    expect(() => filter_edges([], 'x')).toThrow(/Orientation must be/);
  });

  it('test_table_settings_errors', () => {
    const page = { bbox: [0, 0, 100, 100] as T_bbox, edges: [] };
    expect(() => new TableFinder(page, [] as unknown as T_table_settings)).toThrow(/Cannot resolve settings/);
    expect(() => new TableFinder(page, { vertical_strategy: 'x' })).toThrow(/vertical_strategy must be one of/);
    expect(() => new TableFinder(page, { vertical_strategy: 'explicit', explicit_vertical_lines: [] })).toThrow(/two or more/);
    expect(() => new TableFinder(page, { join_tolerance: -1 })).toThrow(/cannot be negative/);
    expect(() => new TableFinder(page, { strategy: 'x' } as unknown as T_table_settings)).toThrow(TypeError);
  });

  it('resolves the tolerances that are left out from their base, and the text settings from the keys that start with text_', () => {
    const settings = TableSettings.resolve({ snap_tolerance: 5, text_tolerance: 2, text_keep_blank_chars: true } as unknown as T_table_settings);
    expect([settings.snap_x_tolerance, settings.snap_y_tolerance, settings.join_x_tolerance, settings.intersection_y_tolerance]).toEqual([5, 5, 3, 3]);
    expect(settings.text_settings).toEqual({ keep_blank_chars: true, x_tolerance: 2, y_tolerance: 2 });
  });

  it('snaps edges within the tolerance to their average and joins edges on one line that are within the tolerance', () => {
    const snapped = snap_edges([vertical(10, 0, 50), vertical(11, 0, 50), horizontal(0, 30, 5), horizontal(0, 30, 7.5)], 3, 3);
    expect(snapped.filter((edge) => edge.orientation === 'v').map((edge) => edge.x0)).toEqual([10.5, 10.5]);
    expect(snapped.filter((edge) => edge.orientation === 'h').map((edge) => edge.top)).toEqual([6.25, 6.25]);
    const merged = merge_edges([horizontal(0, 10, 5), horizontal(12, 20, 5), horizontal(30, 40, 5)], 3, 3, 3, 3);
    expect(merged.map((edge) => [edge.x0, edge.x1])).toEqual([
      [0, 20],
      [30, 40],
    ]);
  });

  it('finds the cells of a grid and the tables they make', () => {
    const edges = [horizontal(0, 20, 0), horizontal(0, 20, 10), horizontal(0, 20, 20), vertical(0, 0, 20), vertical(10, 0, 20), vertical(20, 0, 20)];
    const cells = intersections_to_cells(edges_to_intersections(edges, 1, 1));
    expect(cells).toEqual([
      [0, 0, 10, 10],
      [0, 10, 10, 20],
      [10, 0, 20, 10],
      [10, 10, 20, 20],
    ]);
    expect(cells_to_tables([...cells, [100, 100, 110, 110]])).toEqual([cells]);
  });

  it('puts imaginary edges on words that share a top, and on words that share a side or a centre', () => {
    const word = (x0: number, x1: number, top: number): T_obj => ({ x0, x1, top, bottom: top + 10 });
    const words = [word(0, 10, 0), word(30, 40, 0), word(0, 12, 20), word(30, 44, 20), word(0, 8, 40), word(30, 38, 40)];
    expect(words_to_edges_h(words, 1).map((edge) => edge.top)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(words_to_edges_v(words, 3).map((edge) => edge.x0)).toEqual([0, 30, 44]);
    expect(words_to_edges_v([], 3)).toEqual([]);
  });

  it('clusters sorted numbers within a tolerance of the last one', () => {
    expect(cluster_list([5, 1, 2, 9, 10], 2)).toEqual([[1, 2], [5], [9, 10]]);
    expect(cluster_list([3, 1], 0)).toEqual([[1], [3]]);
  });
});
