import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The direct table routes (data-fast-paths.ts) hold their input and output as byte buffers, which live outside the
 * V8 heap, and keep only a window of the table as JavaScript values. Each case runs in a child process whose heap is
 * capped far below the size of the table: a route that keeps a string per row, or per cell, of the table cannot finish.
 */

const CHILD = path.resolve(__dirname, 'data-columnar-memory-child.ts');
const HEAP_LIMIT_MIB = 128;
const CASE_TIMEOUT_MS = 240_000;

function runChild(scenario: string, rows: number): string {
  return execFileSync(process.execPath, [`--max-old-space-size=${HEAP_LIMIT_MIB}`, '--import', 'tsx', CHILD, scenario, String(rows)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CASE_TIMEOUT_MS,
  });
}

describe('direct table routes keep the V8 heap bounded', () => {
  const cases: { scenario: string; rows: number; what: string }[] = [
    { scenario: 'jsonl-to-csv', rows: 1_500_000, what: 'a 190 MB JSON Lines file to CSV' },
    { scenario: 'csv-to-parquet', rows: 1_500_000, what: 'a 110 MB CSV file to Parquet' },
    { scenario: 'parquet-to-csv', rows: 1_500_000, what: 'a 12-million-cell Parquet file to CSV' },
    { scenario: 'parquet-to-json', rows: 1_500_000, what: 'a 12-million-cell Parquet file to JSON' },
  ];
  for (const item of cases) {
    it(`converts ${item.what} inside a ${HEAP_LIMIT_MIB} MiB heap`, () => {
      expect(runChild(item.scenario, item.rows)).toMatch(/^ok /);
    }, CASE_TIMEOUT_MS + 10_000);
  }
});
