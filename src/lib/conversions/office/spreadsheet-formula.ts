import { PayloadLimitError } from '../../types';
import { MAX_TEXT_RESULT_LENGTH, spreadsheetFunctionTable } from './spreadsheet-functions';
import FormulaParser from './vendor/fast-formula-parser';
import type { FormulaCellRef, FormulaRangeRef } from './vendor/fast-formula-parser';

/** Maximum cells expanded in a single formula range (`A1:Z1000` = 26,000; full sheet `A1:XFD1048576` = 17.18B is refused). */
export const MAX_FORMULA_RANGE_CELLS = 100_000;
/** Maximum unique range cells expanded across one workbook/sheet formula evaluation pass. */
export const MAX_TOTAL_FORMULA_RANGE_CELLS = 250_000;
/**
 * Time one DAG pass may take. A formula costs microseconds, but a function with a huge argument (a chi-square test with two
 * billion degrees of freedom) can take a second, and 50,000 of them would take most of a day; the pass stops there.
 */
export const MAX_FORMULA_EVAL_MS = 20_000;
/** Maximum formula cells evaluated in a single DAG pass. */
export const MAX_FORMULA_CELLS = 50_000;
/** ECMA-376 SpreadsheetML maximum row and column indices (`XFD1048576`). */
const MAX_EXCEL_ROW = 1_048_576;
const MAX_EXCEL_COL = 16_384;

function colLettersToNum(col: string): number {
  let c = 0;
  for (let i = 0; i < col.length; i++) {
    const code = col.charCodeAt(i) & ~32;
    c = c * 26 + (code - 64);
  }
  return c;
}

function colNumToLetters(n: number): string {
  let s = '';
  let temp = n;
  while (temp > 0) {
    s = String.fromCharCode(65 + ((temp - 1) % 26)) + s;
    temp = Math.floor((temp - 1) / 26);
  }
  return s;
}

function parseValidatedRangeBounds(
  col1: string,
  row1Str: string,
  col2: string,
  row2Str: string,
): { minC: number; maxC: number; minR: number; maxR: number; cellCount: number } {
  const c1 = colLettersToNum(col1);
  const c2 = colLettersToNum(col2);
  const r1 = Number.parseInt(row1Str, 10);
  const r2 = Number.parseInt(row2Str, 10);
  const minC = Math.min(c1, c2);
  const maxC = Math.max(c1, c2);
  const minR = Math.min(r1, r2);
  const maxR = Math.max(r1, r2);
  if (
    !Number.isFinite(minR) ||
    !Number.isFinite(maxR) ||
    minR < 1 ||
    minC < 1 ||
    maxR > MAX_EXCEL_ROW ||
    maxC > MAX_EXCEL_COL
  ) {
    throw new PayloadLimitError(
      `Spreadsheet range ${col1}${row1Str}:${col2}${row2Str} exceeds ECMA-376 grid bounds (${MAX_EXCEL_COL}x${MAX_EXCEL_ROW}).`,
    );
  }
  const cellCount = (maxR - minR + 1) * (maxC - minC + 1);
  if (cellCount > MAX_FORMULA_RANGE_CELLS) {
    throw new PayloadLimitError(
      `Spreadsheet formula range ${col1}${row1Str}:${col2}${row2Str} spans ${cellCount} cells, exceeding limit of ${MAX_FORMULA_RANGE_CELLS}.`,
    );
  }
  return { minC, maxC, minR, maxR, cellCount };
}

function parseCellCoord(cleanRef: string): { col: number; row: number } | null {
  let i = 0;
  while (i < cleanRef.length) {
    const code = cleanRef.charCodeAt(i);
    if (code >= 65 && code <= 90) i++;
    else break;
  }
  if (i === 0 || i > 3 || i === cleanRef.length || cleanRef.length - i > 7) return null;
  const col = colLettersToNum(cleanRef.slice(0, i));
  let row = 0;
  for (let j = i; j < cleanRef.length; j++) {
    const d = cleanRef.charCodeAt(j) - 48;
    if (d < 0 || d > 9) return null;
    row = row * 10 + d;
  }
  if (col < 1 || col > MAX_EXCEL_COL || row < 1 || row > MAX_EXCEL_ROW) return null;
  return { col, row };
}
function canonicalRangeKey(bounds: { minC: number; minR: number; maxC: number; maxR: number }): string {
  return `${bounds.minC}:${bounds.minR}:${bounds.maxC}:${bounds.maxR}`;
}

export type CellResolver = (cellRef: string) => any;

/** Excel's own limit for the text of one formula; a longer one is not a formula a workbook can hold. */
const MAX_FORMULA_LENGTH = 8192;
const ERROR_CODES: ReadonlySet<string> = new Set([
  '#DIV/0!', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#VALUE!', '#CYCLE!',
]);
const STRING_LITERAL_RE = /"(?:[^"]|"")*"/g;
/** `A:A`, `$A:$C`, `2:3`: a whole column or row, which reaches the last cell of the grid. */
const WHOLE_AXIS_REFERENCE_RE =
  /(?:^|[^A-Za-z0-9_.!$'])(?:\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}(?![A-Za-z0-9_(])|\$?[0-9]{1,7}:\$?[0-9]{1,7}(?![A-Za-z0-9_.(]))/;
const { FormulaError } = FormulaParser;

interface CachedRangeEntry {
  minC: number;
  maxC: number;
  minR: number;
  maxR: number;
  rows: unknown[][];
}

/**
 * Evaluates one formula over the cells `cellLookup` returns. The grammar, the operators and the functions are those of the
 * vendored fast-formula-parser (functions it lacks come from formulajs, see `spreadsheet-functions.ts`); this class holds
 * what EasyConvert adds around them: the range limits, the grid bounds, the function allowlist, and the mapping of every
 * library failure to an Excel error. A formula that cannot be evaluated gives an error code (`#NAME?` for a function that is
 * not offered, `#REF!` for a reference outside this sheet), and only a `PayloadLimitError` is thrown.
 */
export class SpreadsheetFormulaEvaluator {
  private evaluatedRangeCells = 0;
  private seenRangeKeys = new Set<string>();
  private range2DCache = new Map<string, CachedRangeEntry>();
  private readonly parser: FormulaParser;

  constructor(private cellLookup: CellResolver) {
    this.parser = new FormulaParser({ onCell: (ref) => this.readCell(ref), onRange: (ref) => this.readRange(ref) });
    this.parser.functions = spreadsheetFunctionTable().functions;
  }

  public invalidateCell(ref: string): void {
    if (this.range2DCache.size === 0) return;
    const coord = parseCellCoord(ref.replace(/\$/g, '').toUpperCase());
    if (!coord) {
      this.range2DCache.clear();
      return;
    }
    for (const [key, entry] of this.range2DCache.entries()) {
      if (
        coord.col >= entry.minC &&
        coord.col <= entry.maxC &&
        coord.row >= entry.minR &&
        coord.row <= entry.maxR
      ) {
        this.range2DCache.delete(key);
      }
    }
  }

  /**
   * The text form of a formula result: a formula whose outermost call returns a date gives `yyyy-mm-dd`, as `DATE` always
   * has. `position` is the cell that holds the formula, for `ROW()` and `COLUMN()` without an argument.
   */
  public evaluate(formula: string, position: { row: number; col: number } = { row: 1, col: 1 }): any {
    const result = this.evaluateValue(formula, position);
    return typeof result === 'number' ? formatDateResult(formula, result) ?? result : result;
  }

  /** The value of a formula as the sheet holds it: a date is its serial number. */
  public evaluateValue(
    formula: string,
    position: { row: number; col: number } = { row: 1, col: 1 },
  ): string | number | boolean {
    const text = formula.startsWith('=') ? formula.slice(1) : formula;
    if (text.length === 0 || text.length > MAX_FORMULA_LENGTH) return '#VALUE!';
    if (text.includes(':') && WHOLE_AXIS_REFERENCE_RE.test(text.replace(STRING_LITERAL_RE, '""'))) return '#REF!';
    try {
      return SpreadsheetFormulaEvaluator.toCellValue(this.parser.parse(text, { row: position.row, col: position.col, sheet: '' }));
    } catch (err) {
      const cause = err instanceof FormulaError && err.details !== undefined ? err.details : err;
      if (cause instanceof PayloadLimitError) throw cause;
      return cause instanceof FormulaError && cause.error !== '#ERROR!' ? cause.error : '#VALUE!';
    }
  }

  private static toCellValue(result: unknown): string | number | boolean {
    if (result instanceof FormulaError) return result.error;
    if (result === null || result === undefined) return 0;
    if (typeof result === 'string') return result.length > MAX_TEXT_RESULT_LENGTH ? '#VALUE!' : result;
    if (typeof result === 'number' || typeof result === 'boolean') return result;
    if (Array.isArray(result)) return SpreadsheetFormulaEvaluator.toCellValue((result as unknown[][])[0]?.[0]);
    return '#VALUE!';
  }

  /** An empty cell is `null`; a stored error code is the error, so `ISERROR` and `IFERROR` see it. */
  private static toFormulaValue(value: unknown): unknown {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string') return ERROR_CODES.has(value) ? new FormulaError(value) : value;
    return typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
  }

  private readCell(ref: FormulaCellRef): unknown {
    if (ref.sheet || ref.col < 1 || ref.col > MAX_EXCEL_COL || ref.row < 1 || ref.row > MAX_EXCEL_ROW) {
      return FormulaError.REF;
    }
    return SpreadsheetFormulaEvaluator.toFormulaValue(this.cellLookup(`${colNumToLetters(ref.col)}${ref.row}`));
  }

  private readRange(ref: FormulaRangeRef): unknown[][] {
    if (ref.sheet) throw FormulaError.REF;
    const bounds = parseValidatedRangeBounds(
      colNumToLetters(Math.max(ref.from.col, 1)),
      String(ref.from.row),
      colNumToLetters(Math.max(ref.to.col, 1)),
      String(ref.to.row),
    );
    const { minC, maxC, minR, maxR, cellCount } = bounds;
    const rangeKey = canonicalRangeKey(bounds);
    const cached = this.range2DCache.get(rangeKey);
    if (cached) return cached.rows;
    if (!this.seenRangeKeys.has(rangeKey)) {
      if (this.evaluatedRangeCells + cellCount > MAX_TOTAL_FORMULA_RANGE_CELLS) {
        throw new PayloadLimitError(
          `Spreadsheet formulas exceed cumulative range cell budget of ${MAX_TOTAL_FORMULA_RANGE_CELLS}.`,
        );
      }
      this.seenRangeKeys.add(rangeKey);
      this.evaluatedRangeCells += cellCount;
    }

    const width = maxC - minC + 1;
    const colNames = new Array<string>(width);
    for (let i = 0; i < width; i++) colNames[i] = colNumToLetters(minC + i);
    const rows = new Array<unknown[]>(maxR - minR + 1);
    for (let r = minR; r <= maxR; r++) {
      const row = new Array<unknown>(width);
      for (let i = 0; i < width; i++) {
        row[i] = SpreadsheetFormulaEvaluator.toFormulaValue(this.cellLookup(`${colNames[i]}${r}`));
      }
      rows[r - minR] = row;
    }
    this.range2DCache.set(rangeKey, { minC, maxC, minR, maxR, rows });
    return rows;
  }
}

/** A formula whose outermost call returns a date shows as `yyyy-mm-dd`, as `DATE` always has in the text of a sheet. */
const DATE_RESULT_FUNCTION_RE = /^=?\s*(?:_xlfn\.)?(?:DATE|TODAY|EDATE|EOMONTH|WORKDAY(?:\.INTL)?)\s*\(/i;
/** Serial 61 is 1900-03-01, the first day on which the 1900 and 1899-12-30 epochs agree. */
const FIRST_UNAMBIGUOUS_SERIAL = 61;
const MS_PER_DAY = 86_400_000;
const SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);

/** True when the call that opens the formula closes at its last character (`DATE(1,2,3)` yes, `DATE(1,2,3)+1` no). */
function isOneCall(formula: string): boolean {
  const open = formula.indexOf('(');
  let depth = 0;
  let inString = false;
  for (let i = open; i < formula.length; i++) {
    const ch = formula[i];
    if (ch === '"') inString = !inString;
    else if (!inString && ch === '(') depth++;
    else if (!inString && ch === ')' && --depth === 0) return formula.slice(i + 1).trim() === '';
  }
  return false;
}

function formatDateResult(formula: string, serial: number): string | undefined {
  if (serial < FIRST_UNAMBIGUOUS_SERIAL || !DATE_RESULT_FUNCTION_RE.test(formula) || !isOneCall(formula)) return undefined;
  return new Date(SERIAL_EPOCH_MS + Math.floor(serial) * MS_PER_DAY).toISOString().slice(0, 10);
}

function formulaResultText(formula: string, result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'boolean') return result ? 'TRUE' : 'FALSE';
  if (typeof result === 'number') return formatDateResult(formula, result) ?? String(result);
  return String(result);
}

export interface FormulaCellInfo {
  ref: string;
  formula: string;
  rowIdx?: number;
  colIdx?: number;
}

/**
 * Directed Acyclic Graph (DAG) Dependency Topological Sorter & Circular Reference Engine
 * Solves multi-layer cell dependencies, evaluates formulas in correct topological order,
 * and detects cycles safely without recursion stack overflow, assigning #CYCLE! standard error codes.
 */
export class SpreadsheetDagEngine {
  private formulaCells: FormulaCellInfo[] = [];

  constructor(private cellMap: Record<string, any> = {}) {}

  public setCell(ref: string, value: any): void {
    const cleanRef = ref.replace(/\$/g, '').toUpperCase();
    this.formulaCells = this.formulaCells.filter((fc) => fc.ref !== cleanRef);
    if (typeof value === 'string' && value.startsWith('=')) {
      this.formulaCells.push({ ref: cleanRef, formula: value });
      delete this.cellMap[cleanRef];
    } else {
      this.cellMap[cleanRef] = value;
    }
  }

  public getCellValue(ref: string): any {
    const cleanRef = ref.replace(/\$/g, '').toUpperCase();
    return this.cellMap[cleanRef];
  }

  public evaluate(rows?: string[][]): { evaluated: Record<string, any>; cycles: string[] } {
    return this.evaluateWithDag(this.formulaCells, rows);
  }

  private static extractFormulaReferences(formula: string): {
    cells: string[];
    ranges: Array<{ minC: number; maxC: number; minR: number; maxR: number; cellCount: number }>;
  } {
    if (!formula) return { cells: [], ranges: [] };
    if (formula.startsWith('=')) formula = formula.slice(1);
    const stripped = formula.replace(/"(?:[^"\\]|\\.)*"/g, '');
    const ranges: Array<{ minC: number; maxC: number; minR: number; maxR: number; cellCount: number }> = [];
    const seenRanges = new Set<string>();
    let totalRangeCells = 0;

    const rangeRegex = /(\$?)([A-Za-z]+)(\$?)([0-9]+)\s*:\s*(\$?)([A-Za-z]+)(\$?)([0-9]+)/g;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = rangeRegex.exec(stripped)) !== null) {
      if (rMatch[2].length > 3 || rMatch[6].length > 3 || rMatch[4].length > 7 || rMatch[8].length > 7) {
        throw new PayloadLimitError(`Spreadsheet formula range ${rMatch[0]} exceeds ECMA-376 grid bounds.`);
      }
      const bounds = parseValidatedRangeBounds(
        rMatch[2].toUpperCase(),
        rMatch[4],
        rMatch[6].toUpperCase(),
        rMatch[8],
      );
      const rangeKey = canonicalRangeKey(bounds);
      if (!seenRanges.has(rangeKey)) {
        seenRanges.add(rangeKey);
        totalRangeCells += bounds.cellCount;
        if (totalRangeCells > MAX_TOTAL_FORMULA_RANGE_CELLS) {
          throw new PayloadLimitError(
            `Spreadsheet formula exceeds cumulative range cell budget of ${MAX_TOTAL_FORMULA_RANGE_CELLS}.`,
          );
        }
        ranges.push(bounds);
      }
    }

    const strippedWithoutRanges = stripped.replace(rangeRegex, ' ');
    const cellSet = new Set<string>();
    const cellRegex = /\b(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})\b/g;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = cellRegex.exec(strippedWithoutRanges)) !== null) {
      let afterIdx = cMatch.index + cMatch[0].length;
      while (afterIdx < strippedWithoutRanges.length && strippedWithoutRanges.charCodeAt(afterIdx) <= 32) {
        afterIdx++;
      }
      if (strippedWithoutRanges[afterIdx] === '(') continue;
      cellSet.add(`${cMatch[2].toUpperCase()}${cMatch[4]}`);
    }

    return { cells: Array.from(cellSet), ranges };
  }

  /**
   * Extracts dependent cell references and ranges from formula expression.
   */
  public static extractDependencies(formula: string): string[] {
    const { cells, ranges } = SpreadsheetDagEngine.extractFormulaReferences(formula);
    const refs = new Set<string>(cells);
    for (const { minC, maxC, minR, maxR } of ranges) {
      const width = maxC - minC + 1;
      const cols = new Array<string>(width);
      for (let i = 0; i < width; i++) cols[i] = colNumToLetters(minC + i);
      for (let r = minR; r <= maxR; r++) {
        for (let i = 0; i < width; i++) {
          refs.add(`${cols[i]}${r}`);
        }
      }
    }
    return Array.from(refs);
  }

  private static buildFormulaDag(formulaCells: FormulaCellInfo[]): {
    formulaMap: Map<string, FormulaCellInfo>;
    inDegree: Map<string, number>;
    reverseDeps: Map<string, Set<string>>;
  } {
    if (formulaCells.length > MAX_FORMULA_CELLS) {
      throw new PayloadLimitError(
        `Spreadsheet contains ${formulaCells.length} formulas, exceeding limit of ${MAX_FORMULA_CELLS}.`,
      );
    }
    const formulaMap = new Map<string, FormulaCellInfo>();
    const formulaCoords: Array<{ ref: string; col: number; row: number }> = [];
    for (const fc of formulaCells) {
      if (!fc.ref) continue;
      const cleanRef = fc.ref.toUpperCase();
      formulaMap.set(cleanRef, fc);
      const coord = parseCellCoord(cleanRef);
      if (coord) formulaCoords.push({ ref: cleanRef, col: coord.col, row: coord.row });
    }

    const inDegree = new Map<string, number>();
    const reverseDeps = new Map<string, Set<string>>();
    const seenRanges = new Set<string>();
    let totalRangeCells = 0;
    for (const [ref, fc] of formulaMap.entries()) {
      const { cells, ranges } = SpreadsheetDagEngine.extractFormulaReferences(fc.formula);
      const depsForCell = new Set<string>();
      for (const r of cells) {
        if (formulaMap.has(r)) depsForCell.add(r);
      }
      for (const range of ranges) {
        const rangeKey = canonicalRangeKey(range);
        if (!seenRanges.has(rangeKey)) {
          seenRanges.add(rangeKey);
          totalRangeCells += range.cellCount;
          if (totalRangeCells > MAX_TOTAL_FORMULA_RANGE_CELLS) {
            throw new PayloadLimitError(
              `Spreadsheet formulas exceed cumulative range cell budget of ${MAX_TOTAL_FORMULA_RANGE_CELLS}.`,
            );
          }
        }
        SpreadsheetDagEngine.collectCoordsInRange(formulaCoords, range, depsForCell);
      }
      for (const r of depsForCell) {
        let rev = reverseDeps.get(r);
        if (!rev) {
          rev = new Set();
          reverseDeps.set(r, rev);
        }
        rev.add(ref);
      }
      inDegree.set(ref, depsForCell.size);
    }
    return { formulaMap, inDegree, reverseDeps };
  }

  private static collectCoordsInRange(
    formulaCoords: ReadonlyArray<{ ref: string; col: number; row: number }>,
    range: { minC: number; maxC: number; minR: number; maxR: number },
    out: Set<string>,
  ): void {
    for (let i = 0; i < formulaCoords.length; i++) {
      const c = formulaCoords[i]!;
      if (c.col >= range.minC && c.col <= range.maxC && c.row >= range.minR && c.row <= range.maxR) {
        out.add(c.ref);
      }
    }
  }

  private static writeRowCell(rows: string[][] | undefined, fc: FormulaCellInfo | undefined, value: string): void {
    if (rows && fc && fc.rowIdx !== undefined && fc.colIdx !== undefined && rows[fc.rowIdx]) {
      rows[fc.rowIdx][fc.colIdx] = value;
    }
  }

  /**
   * Evaluates all formula cells in topological dependency order.
   * Detects cycles and safely sets #CYCLE! error codes without stack overflows.
   */
  public evaluateWithDag(
    formulaCells: FormulaCellInfo[],
    rows?: string[][],
    timeBudgetMs: number = MAX_FORMULA_EVAL_MS,
  ): { evaluated: Record<string, any>; cycles: string[] } {
    const { formulaMap, inDegree, reverseDeps } = SpreadsheetDagEngine.buildFormulaDag(formulaCells);

    const topoOrder: string[] = [];
    for (const [node, deg] of inDegree.entries()) {
      if (deg === 0) topoOrder.push(node);
    }

    let qHead = 0;
    while (qHead < topoOrder.length) {
      const curr = topoOrder[qHead++]!;
      const dependents = reverseDeps.get(curr);
      if (!dependents) continue;
      for (const dep of dependents) {
        const newDeg = (inDegree.get(dep) || 1) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) topoOrder.push(dep);
      }
    }

    const cyclicCells: string[] = [];
    for (const [cRef, deg] of inDegree.entries()) {
      if (deg > 0) {
        cyclicCells.push(cRef);
        this.cellMap[cRef] = '#CYCLE!';
        SpreadsheetDagEngine.writeRowCell(rows, formulaMap.get(cRef), '#CYCLE!');
      }
    }

    const evaluator = new SpreadsheetFormulaEvaluator((ref) => {
      const cleanRef = ref.replace(/\$/g, '').toUpperCase();
      const val = this.cellMap[cleanRef];
      return val === undefined || val === null ? '' : val;
    });

    const deadline = performance.now() + timeBudgetMs;
    for (const node of topoOrder) {
      const fc = formulaMap.get(node);
      if (!fc) continue;
      if (performance.now() > deadline) {
        throw new PayloadLimitError(`Spreadsheet formulas took longer than ${timeBudgetMs} ms to evaluate.`);
      }
      const result = evaluator.evaluateValue(fc.formula, parseCellCoord(node) ?? undefined);
      this.cellMap[node] = result;
      evaluator.invalidateCell(node);
      SpreadsheetDagEngine.writeRowCell(rows, fc, formulaResultText(fc.formula, result));
    }

    return { evaluated: this.cellMap, cycles: cyclicCells };
  }
}
