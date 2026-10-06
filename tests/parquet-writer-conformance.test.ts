import { describe, expect, it } from 'vitest';
import { oracleTest } from './helpers/oracle-test';
import { pyarrowRead } from './helpers/parquet-oracle';
import { encodeParquet } from '../src/lib/conversions/parquet';

describe('Parquet writer conformance (issue 526)', () => {
  oracleTest(
    'regression: pyarrow reads the writer output with exact values and nulls',
    ['python3'],
    () => {
      const rows = [
        { id: 1, label: 'alpha', score: 1.5, ok: true },
        { id: 2, label: null, score: null, ok: false },
        { id: null, label: 'gamma', score: 3.25, ok: null },
      ];
      const read = pyarrowRead(encodeParquet(rows));
      expect(read.numRows).toBe(3);
      expect(read.columns.id).toEqual([1, 2, null]);
      expect(read.columns.label).toEqual(['alpha', null, 'gamma']);
      expect(read.columns.score).toEqual([1.5, null, 3.25]);
      expect(read.columns.ok).toEqual([true, false, null]);
    }
  );
});
