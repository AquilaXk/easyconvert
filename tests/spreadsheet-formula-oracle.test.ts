import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpreadsheetDagEngine } from '../src/lib/conversions/office/spreadsheet-formula';
import { ORACLE_FORMULAS, ORACLE_INPUTS } from './fixtures/formula-oracle/cases';

/**
 * The formula engine against LibreOffice. `tests/fixtures/formula-oracle/expected.json` holds the value LibreOffice
 * computed for every formula of `cases.ts` in one workbook without cached values (`generate.mts` writes it). Each formula is
 * evaluated here by the DAG engine over the same cells and has to give the same value, except for the cases listed in
 * `DEVIATIONS`, where this engine follows Excel and LibreOffice does not.
 */
interface Expected {
  id: string;
  t: 'n' | 's' | 'b' | 'e';
  v: number | string | boolean;
}

const expectedFile = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/formula-oracle/expected.json'), 'utf8'),
) as { libreoffice: string; values: Record<string, Expected> };

/** Where this engine answers as Excel does and LibreOffice answers otherwise: id -> the value of this engine. */
const DEVIATIONS: Record<string, { ours: number | string | boolean; reason: string }> = {
  'op-concat-number': { ours: 'a1TRUE', reason: 'Excel joins TRUE as text; LibreOffice joins 1' },
  'math-sum-text-literal': { ours: 6, reason: 'Excel counts a number written as text in the argument list; LibreOffice gives #VALUE!' },
  'stat-max-text-literal': { ours: 30, reason: 'same as above, for MAX' },
  'math-sqrt-neg': { ours: '#NUM!', reason: 'Excel gives #NUM!; LibreOffice exports its Err:502 as #VALUE!' },
  'stat-sum-bool-range': { ours: 2, reason: 'Excel skips a boolean cell inside a range; LibreOffice counts it as 1' },
  'stat-count-bool-range': { ours: 1, reason: 'same as above, for COUNT' },
  'lookup-vlookup-col-out': { ours: '#REF!', reason: 'Excel gives #REF! for a column past the table; LibreOffice gives #VALUE!' },
  'logic-if-text-cond': { ours: 'a', reason: 'the vendored IF takes any text as TRUE; Excel and LibreOffice give #VALUE!' },
  'logic-and-text': { ours: true, reason: 'the vendored AND takes any text as TRUE; Excel and LibreOffice give #VALUE!' },
};

const cells = ORACLE_FORMULAS.map((c, i) => ({ ref: `H${i + 1}`, formula: `=${c.formula}`, id: c.id }));
const { evaluated, cycles } = new SpreadsheetDagEngine({ ...ORACLE_INPUTS }).evaluateWithDag(cells);

function same(expected: Expected, got: unknown): boolean {
  if (expected.t === 'n') {
    const want = expected.v as number;
    return typeof got === 'number' && Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want));
  }
  return got === expected.v;
}

describe('formula engine against LibreOffice', () => {
  it('records the LibreOffice version the values came from', () => {
    expect(expectedFile.libreoffice).toMatch(/^LibreOffice \d+\.\d+/);
    expect(Object.keys(expectedFile.values)).toHaveLength(ORACLE_FORMULAS.length);
    expect(cycles).toEqual([]);
  });

  it.each(cells.filter((c) => !(c.id in DEVIATIONS)).map((c) => [c.id, c.ref, c.formula] as const))(
    '%s: %s %s',
    (id, ref) => {
      const expected = expectedFile.values[ref]!;
      expect(expected.id).toBe(id);
      expect({ id, value: evaluated[ref] }).toEqual({
        id,
        value: expected.t === 'n' ? expect.closeTo(expected.v as number, 9) : expected.v,
      });
    },
  );

  it.each(cells.filter((c) => c.id in DEVIATIONS).map((c) => [c.id, c.ref] as const))(
    'deviation %s differs from LibreOffice on purpose',
    (id, ref) => {
      const expected = expectedFile.values[ref]!;
      const deviation = DEVIATIONS[id]!;
      expect(evaluated[ref]).toBe(deviation.ours);
      expect(same(expected, evaluated[ref])).toBe(false);
      expect(deviation.reason.length).toBeGreaterThan(10);
    },
  );
});
