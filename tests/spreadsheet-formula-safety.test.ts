import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_FORMULA_CELLS,
  SpreadsheetDagEngine,
  SpreadsheetFormulaEvaluator,
} from '../src/lib/conversions/office/spreadsheet-formula';
import { spreadsheetFunctionTable } from '../src/lib/conversions/office/spreadsheet-functions';
import { PayloadLimitError } from '../src/lib/types';
import { expectNoHang } from './helpers/timing';

/** What a hostile formula can and cannot do: the function allowlist, the ceilings, the limits and the error mapping. */

const cells: Record<string, unknown> = { A1: 1, A2: 2, A3: 3, B1: 'x' };
const evaluate = (formula: string): unknown => new SpreadsheetFormulaEvaluator((ref) => cells[ref]).evaluate(formula);

describe('function allowlist', () => {
  it.each(['WEBSERVICE("http://127.0.0.1/")', 'FILTERXML("<a/>","/a")', 'INDIRECT("A1")', 'OFFSET(A1,1,0)', 'CELL("filename")', 'INFO("directory")', 'BESSELI(1,2)'])(
    '%s is not offered',
    (formula) => {
      expect(evaluate(formula)).toBe('#NAME?');
    },
  );

  it('does not reach members of Object.prototype through a function name', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(evaluate(`${name}(1)`)).toBe('#NAME?');
    }
    expect(Object.getPrototypeOf(spreadsheetFunctionTable().functions)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('covers the 40 functions of the audit and the ones that were missing', () => {
    const names = Object.keys(spreadsheetFunctionTable().functions);
    for (const name of [
      'SUM', 'AVERAGE', 'IF', 'ROUND', 'VLOOKUP', 'CONCAT', 'MAX', 'MIN', 'SUMIF', 'COUNTIF', 'ABS', 'UPPER', 'LEN', 'TEXT',
      'AND', 'OR', 'CONCATENATE', 'SUMPRODUCT', 'IFERROR', 'DATE', 'MID', 'COUNTA', 'MEDIAN', 'LOWER', 'TRIM', 'INDEX', 'MATCH',
      'POWER', 'SQRT', 'MOD', 'INT', 'SUMIFS', 'YEAR', 'XLOOKUP', 'FIND', 'SUBSTITUTE', 'PMT', 'RANK', 'STDEV',
    ]) {
      expect(names, name).toContain(name);
    }
  });
});

describe('ceilings on arguments that set how much a function builds or loops', () => {
  it.each([
    'REPT("a",1E11)',
    'REPT("",99999999999)',
    'REPT("abcdefghij",5000)',
    'BIN2HEX(0,99999999999)',
    'DEC2BIN(5,11)',
    'DOLLAR(1,2147483647)',
    'FIXED(1,2147483647)',
    'MUNIT(99999999999)',
    'POISSON.DIST(2147483647,5,FALSE)',
    'CHISQ.DIST.RT(5,2147483647)',
    'COMBIN(1E9,5E8)',
    'WORKDAY(0,99999999999)',
  ])('%s ends at once with an error', async (formula) => {
    const result = await expectNoHang(formula, () => evaluate(formula));
    expect(String(result)).toMatch(/^#(NUM|VALUE)!$/);
  });

  it('still answers inside the ceilings', () => {
    expect(evaluate('REPT("ab",3)')).toBe('ababab');
    expect(evaluate('DEC2BIN(5,8)')).toBe('00000101');
  });

  it('answers #VALUE! for a text longer than a cell holds, whatever builds it', () => {
    const big = 'x'.repeat(20_000);
    const result = new SpreadsheetFormulaEvaluator(() => big).evaluate('A1&A1');
    expect(result).toBe('#VALUE!');
  });
});

describe('what a failing or hostile formula becomes', () => {
  it('maps a parse failure, an unknown function and a bad reference to Excel errors', () => {
    expect(evaluate('SUM(1,')).toBe('#VALUE!');
    expect(evaluate('NOSUCH(1)')).toBe('#NAME?');
    expect(evaluate('Sheet2!A1')).toBe('#REF!');
    expect(evaluate('SUM(Sheet2!A1:B2)')).toBe('#REF!');
    expect(evaluate('SUM(A:A)')).toBe('#REF!');
    expect(evaluate('SUM(1:3)')).toBe('#REF!');
    expect(evaluate('1/0')).toBe('#DIV/0!');
    expect(evaluate('')).toBe('#VALUE!');
  });

  it('does not take a whole-column look-alike inside a string for a reference', () => {
    expect(evaluate('"A:A"&"1:3"')).toBe('A:A1:3');
  });

  it('refuses a formula longer than Excel allows', () => {
    expect(evaluate(`1${'+1'.repeat(5000)}`)).toBe('#VALUE!');
  });

  it('does not overflow the stack on deep nesting', () => {
    expect(evaluate(`${'('.repeat(20_000)}1${')'.repeat(20_000)}`)).toBe('#VALUE!');
    expect(evaluate(`${'-'.repeat(5000)}1`)).toBeTypeOf('number');
  });

  it('lets a PayloadLimitError out through IFERROR, nested calls and the DAG', () => {
    const dag = new SpreadsheetDagEngine({ A1: 1 });
    expect(() =>
      dag.evaluateWithDag([{ ref: 'B1', formula: '=IFERROR(IF(TRUE,SUM(A1:A99999,B1:B99999,C1:C99999)),0)' }]),
    ).toThrow(PayloadLimitError);
    const evaluator = new SpreadsheetFormulaEvaluator(() => 1);
    evaluator.evaluate('SUM(A1:A90000)');
    evaluator.evaluate('SUM(B1:B90000)');
    expect(() => evaluator.evaluate('IFERROR(SUM(C1:C90000),0)')).toThrow(PayloadLimitError);
  });

  it('refuses more formulas than the limit and stops a pass that runs out of time', () => {
    const many = Array.from({ length: MAX_FORMULA_CELLS + 1 }, (_, i) => ({ ref: `A${i + 1}`, formula: '=1' }));
    expect(() => new SpreadsheetDagEngine({}).evaluateWithDag(many)).toThrow(PayloadLimitError);
    expect(() =>
      new SpreadsheetDagEngine({}).evaluateWithDag([{ ref: 'A1', formula: '=1' }], undefined, -1),
    ).toThrow(PayloadLimitError);
  });

  it('marks cycles and evaluates the rest in dependency order', () => {
    const { evaluated, cycles } = new SpreadsheetDagEngine({}).evaluateWithDag([
      { ref: 'A1', formula: '=B1+1' },
      { ref: 'B1', formula: '=A1+1' },
      { ref: 'C1', formula: '=D1*2' },
      { ref: 'D1', formula: '=ROW()+COLUMN()' },
    ]);
    expect(cycles.sort()).toEqual(['A1', 'B1']);
    expect(evaluated).toMatchObject({ A1: '#CYCLE!', B1: '#CYCLE!', D1: 5, C1: 10 });
  });
});

describe('what the engine returns for dates and stored errors', () => {
  it('gives a date at the top of a formula as text from evaluate and as a serial from evaluateValue', () => {
    const evaluator = new SpreadsheetFormulaEvaluator(() => 0);
    expect(evaluator.evaluate('=DATE(2026, 9, 27)')).toBe('2026-09-27');
    expect(evaluator.evaluateValue('=DATE(2026, 9, 27)')).toBe(46292);
    expect(evaluator.evaluate('=DATE(2026, 9, 27)+1')).toBe(46293);
  });

  it('passes a stored #CYCLE! or #DIV/0! through operators and functions unchanged', () => {
    const stored: Record<string, string> = { A1: '#CYCLE!', B1: '#DIV/0!' };
    const evaluator = new SpreadsheetFormulaEvaluator((ref) => stored[ref] ?? 10);
    expect(evaluator.evaluate('=A1*2')).toBe('#CYCLE!');
    expect(evaluator.evaluate('=-A1')).toBe('#CYCLE!');
    expect(evaluator.evaluate('=A1&"x"')).toBe('#CYCLE!');
    expect(evaluator.evaluate('=SUM(B1,1)')).toBe('#DIV/0!');
    expect(evaluator.evaluate('=IFERROR(A1+1,0)')).toBe(0);
  });
});

describe('no code is built from text', () => {
  const roots = [
    'src/lib/conversions/office/vendor/fast-formula-parser',
    'src/lib/conversions/office/spreadsheet-formula.ts',
    'src/lib/conversions/office/spreadsheet-functions.ts',
    'src/lib/conversions/office/spreadsheet-xlookup.ts',
  ];
  const files = (target: string): string[] => {
    const full = path.join(__dirname, '..', target);
    if (!statSync(full).isDirectory()) return [full];
    return readdirSync(full).flatMap((entry) => files(path.join(target, entry)));
  };

  it.each(roots)('%s has no eval, Function constructor, dynamic import or process access', (root) => {
    // web.js holds WEBSERVICE, which is blocked and never reached; its `fetch` is the one match the rule would find
    for (const file of files(root).filter((f) => /\.(js|ts)$/.test(f) && !f.endsWith('formulas/functions/web.js'))) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(\s*['"`]|\bimport\s*\(|child_process|\bprocess\.(?:env|binding)|\bfetch\s*\(|XMLHttpRequest/);
    }
  });
});
