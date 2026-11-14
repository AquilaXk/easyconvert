import { ConversionFailedError, PayloadLimitError } from '../../types';

/** Maximum cells expanded in a single formula range (`A1:Z1000` = 26,000; full sheet `A1:XFD1048576` = 17.18B is refused). */
export const MAX_FORMULA_RANGE_CELLS = 100_000;
/** Maximum total range cells expanded across one workbook/sheet formula evaluation pass. */
export const MAX_TOTAL_FORMULA_RANGE_CELLS = 250_000;
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

const STICKY_NUM_RE = /(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const STICKY_RANGE_RE = /(\$?[A-Za-z]{1,3})(\$?)([0-9]{1,7}):(\$?[A-Za-z]{1,3})(\$?)([0-9]{1,7})/y;
const STICKY_OVERSIZE_RANGE_RE = /\$?[A-Za-z]+\$?[0-9]+:\$?[A-Za-z]+\$?[0-9]+/y;
const STICKY_CELL_RE = /(\$?[A-Za-z]{1,3})(\$?)([0-9]{1,7})/y;
const STICKY_IDENT_RE = /[A-Za-z_][A-Za-z0-9_.]*/y;

export type CellResolver = (cellRef: string) => any;

type FormulaTokenType =
  | 'NUMBER'
  | 'STRING'
  | 'BOOLEAN'
  | 'RANGE'
  | 'CELL_REF'
  | 'FUNCTION'
  | 'OP'
  | 'OP_COMP'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA';

interface FormulaToken {
  type: FormulaTokenType;
  val: any;
}

/**
 * Pure TypeScript Spreadsheet Formula Evaluator
 * Supports basic arithmetic (+, -, *, /, ^, %, &), comparisons (=, <>, <, <=, >, >=),
 * cell references/ranges (A1, $B$2, A1:B10), and common functions (SUM, AVERAGE, COUNT, MIN, MAX, IF).
 */
/**
 * The table argument of VLOOKUP and INDEX as rows: a two-dimensional range keeps its rows, an array of arrays is
 * the rows, any other array is one column (VLOOKUP) or one row (INDEX), and a single value is a one-cell table.
 */
function lookupGridOf(tableArg: unknown, singleArrayAs: 'column' | 'row'): unknown[][] {
  const range = (tableArg as { _range2D?: unknown[][] } | null | undefined)?._range2D;
  if (range) return range;
  if (Array.isArray(tableArg) && Array.isArray(tableArg[0])) return tableArg;
  if (Array.isArray(tableArg)) return singleArrayAs === 'column' ? tableArg.map((x) => [x]) : [tableArg];
  return [[tableArg]];
}

export class SpreadsheetFormulaEvaluator {
  private evaluatedRangeCells = 0;

  constructor(private cellLookup: CellResolver) {}

  public evaluate(formula: string): any {
    if (formula.startsWith('=')) formula = formula.slice(1);
    const tokens = this.tokenize(formula);
    let pos = 0;

    const peek = (): FormulaToken | undefined => tokens[pos];
    const consume = (expectedType?: FormulaTokenType): FormulaToken => {
      const t = tokens[pos];
      if (!t) throw new Error('Unexpected end of formula');
      if (expectedType && t.type !== expectedType) throw new Error(`Expected ${expectedType} but got ${t.type}`);
      pos++;
      return t;
    };

    const isErrorCode = (v: any): boolean => typeof v === 'string' && v.startsWith('#');

    const parseComparison = (): any => {
      let left = parseConcat();
      while (peek() && peek()!.type === 'OP_COMP') {
        const op = consume().val;
        const right = parseConcat();
        if (isErrorCode(left)) return left;
        if (isErrorCode(right)) return right;
        if (op === '=') left = left == right;
        else if (op === '<>') left = left != right;
        else if (op === '<') left = left < right;
        else if (op === '<=') left = left <= right;
        else if (op === '>') left = left > right;
        else if (op === '>=') left = left >= right;
      }
      return left;
    };

    const parseConcat = (): any => {
      let left = parseAdditive();
      while (peek() && peek()!.type === 'OP' && peek()!.val === '&') {
        consume();
        const right = parseAdditive();
        if (isErrorCode(left)) return left;
        if (isErrorCode(right)) return right;
        left = String(left ?? '') + String(right ?? '');
      }
      return left;
    };

    const parseAdditive = (): any => {
      let left = parseMultiplicative();
      while (peek() && peek()!.type === 'OP' && (peek()!.val === '+' || peek()!.val === '-')) {
        const op = consume().val;
        const right = parseMultiplicative();
        if (isErrorCode(left)) return left;
        if (isErrorCode(right)) return right;
        left = op === '+' ? Number(left) + Number(right) : Number(left) - Number(right);
      }
      return left;
    };

    const parseMultiplicative = (): any => {
      let left = parsePower();
      while (peek() && peek()!.type === 'OP' && (peek()!.val === '*' || peek()!.val === '/')) {
        const op = consume().val;
        const right = parsePower();
        if (isErrorCode(left)) return left;
        if (isErrorCode(right)) return right;
        if (op === '/') {
          if (Number(right) === 0) return '#DIV/0!';
          left = Number(left) / Number(right);
        } else {
          left = Number(left) * Number(right);
        }
      }
      return left;
    };

    const parsePower = (): any => {
      let left = parseUnary();
      while (peek() && peek()!.type === 'OP' && peek()!.val === '^') {
        consume();
        const right = parseUnary();
        if (isErrorCode(left)) return left;
        if (isErrorCode(right)) return right;
        left = Math.pow(Number(left), Number(right));
      }
      return left;
    };

    const parseUnary = (): any => {
      if (peek() && peek()!.type === 'OP' && (peek()!.val === '+' || peek()!.val === '-')) {
        const op = consume().val;
        const operand = parseUnary();
        if (isErrorCode(operand)) return operand;
        return op === '-' ? -Number(operand) : Number(operand);
      }
      let val = parsePrimary();
      if (peek() && peek()!.type === 'OP' && peek()!.val === '%') {
        consume();
        if (isErrorCode(val)) return val;
        val = Number(val) / 100;
      }
      return val;
    };

    const parsePrimary = (): any => {
      const t = peek();
      if (!t) throw new Error('Unexpected end of expression');
      if (t.type === 'NUMBER' || t.type === 'STRING' || t.type === 'BOOLEAN') {
        consume();
        return t.val;
      }
      if (t.type === 'LPAREN') {
        consume();
        const val = parseComparison();
        consume('RPAREN');
        return val;
      }
      if (t.type === 'FUNCTION') {
        return parseFunctionCall();
      }
      if (t.type === 'RANGE') {
        consume();
        const r2d = this.resolveRange2D(t.val);
        const flat = r2d.flat();
        (flat as any)._range2D = r2d;
        (flat as any)._isRange = true;
        return flat;
      }
      if (t.type === 'CELL_REF') {
        consume();
        return this.cellLookup(t.val);
      }
      throw new Error(`Unexpected token: ${t.type} (${t.val})`);
    };

    const parseFunctionCall = (): any => {
      const fnName = String(consume('FUNCTION').val).toUpperCase();
      consume('LPAREN');

      if (fnName === 'IFERROR') {
        let val: any;
        let isErr = false;
        try {
          val = parseComparison();
          if (typeof val === 'string' && val.startsWith('#')) {
            isErr = true;
          }
        } catch (err) {
          if (err instanceof PayloadLimitError) throw err;
          isErr = true;
        }
        consume('COMMA');
        const fallback = parseComparison();
        consume('RPAREN');
        return isErr ? fallback : val;
      }

      const args: any[] = [];
      if (!peek() || peek()!.type !== 'RPAREN') {
        while (true) {
          args.push(parseComparison());
          if (peek() && peek()!.type === 'COMMA') {
            consume();
          } else {
            break;
          }
        }
      }
      consume('RPAREN');
      return this.executeFunction(fnName, args);
    };

    return parseComparison();
  }

  public resolveRange2D(rangeStr: string): any[][] {
    const [start, end] = rangeStr.split(':');
    const match1 = start?.match(/^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/);
    const match2 = end?.match(/^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/);
    if (!match1 || !match2) {
      throw new PayloadLimitError(`Spreadsheet formula range ${rangeStr} is outside valid cell bounds.`);
    }

    const { minC, maxC, minR, maxR, cellCount } = parseValidatedRangeBounds(
      match1[2].toUpperCase(),
      match1[4],
      match2[2].toUpperCase(),
      match2[4],
    );
    if (this.evaluatedRangeCells + cellCount > MAX_TOTAL_FORMULA_RANGE_CELLS) {
      throw new PayloadLimitError(
        `Spreadsheet formulas exceed cumulative range cell budget of ${MAX_TOTAL_FORMULA_RANGE_CELLS}.`,
      );
    }
    this.evaluatedRangeCells += cellCount;

    const width = maxC - minC + 1;
    const colNames = new Array<string>(width);
    for (let i = 0; i < width; i++) colNames[i] = colNumToLetters(minC + i);

    const rows = new Array<any[]>(maxR - minR + 1);
    for (let r = minR; r <= maxR; r++) {
      const row = new Array<any>(width);
      for (let i = 0; i < width; i++) {
        row[i] = this.cellLookup(`${colNames[i]}${r}`);
      }
      rows[r - minR] = row;
    }
    return rows;
  }

  private resolveRange(rangeStr: string): any[] {
    return this.resolveRange2D(rangeStr).flat();
  }

  private executeFunction(name: string, args: any[]): any {
    const flattenNumbers = (arr: any[]): number[] | string => {
      const out: number[] = [];
      let err: string | null = null;
      const walk = (item: any) => {
        if (err) return;
        if (typeof item === 'string' && item.startsWith('#')) {
          err = item;
          return;
        }
        if (Array.isArray(item)) {
          item.forEach(walk);
        } else if (item !== null && item !== undefined && item !== '' && !Number.isNaN(Number(item))) {
          out.push(Number(item));
        }
      };
      walk(arr);
      return err || out;
    };

    const isCellMatch = (cellVal: any, lookupVal: any): boolean => {
      if (cellVal === undefined || cellVal === null) return false;
      if (cellVal === lookupVal) return true;
      if (String(cellVal).toLowerCase() === String(lookupVal).toLowerCase()) return true;
      const sCell = String(cellVal).trim();
      const sLookup = String(lookupVal).trim();
      if (sCell !== '' && sLookup !== '') {
        const numCell = Number(sCell);
        const numLookup = Number(sLookup);
        if (!Number.isNaN(numCell) && !Number.isNaN(numLookup)) {
          return numCell === numLookup;
        }
      }
      return false;
    };

    switch (name) {
      case 'SUM': {
        const nums = flattenNumbers(args);
        if (typeof nums === 'string') return nums;
        return nums.reduce((a, b) => a + b, 0);
      }
      case 'AVERAGE': {
        const nums = flattenNumbers(args);
        if (typeof nums === 'string') return nums;
        return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
      }
      case 'COUNT': {
        const nums = flattenNumbers(args);
        if (typeof nums === 'string') return nums;
        return nums.length;
      }
      case 'MIN': {
        const nums = flattenNumbers(args);
        if (typeof nums === 'string') return nums;
        return nums.length === 0 ? 0 : Math.min(...nums);
      }
      case 'MAX': {
        const nums = flattenNumbers(args);
        if (typeof nums === 'string') return nums;
        return nums.length === 0 ? 0 : Math.max(...nums);
      }
      case 'IF': {
        const cond = Boolean(args[0]);
        if (cond) return args[1];
        return args.length > 2 ? args[2] : false;
      }
      case 'ROUND': {
        const val = Number(args[0]);
        const digits = args.length > 1 ? Number(args[1]) : 0;
        if (Number.isNaN(val) || Number.isNaN(digits)) return '#VALUE!';
        const factor = Math.pow(10, digits);
        return Math.round(val * factor) / factor;
      }
      case 'IFERROR': {
        const v = args[0];
        if (typeof v === 'string' && v.startsWith('#')) return args[1];
        return v;
      }
      case 'CONCAT': {
        const parts: string[] = [];
        const walk = (item: any) => {
          if (Array.isArray(item)) item.forEach(walk);
          else if (item !== null && item !== undefined) parts.push(String(item));
        };
        args.forEach(walk);
        return parts.join('');
      }
      case 'LEFT': {
        const str = String(args[0] ?? '');
        const n = args.length > 1 ? Number(args[1]) : 1;
        return str.slice(0, Math.max(0, n));
      }
      case 'RIGHT': {
        const str = String(args[0] ?? '');
        const n = args.length > 1 ? Number(args[1]) : 1;
        return str.slice(Math.max(0, str.length - n));
      }
      case 'MID': {
        const str = String(args[0] ?? '');
        const start = Number(args[1]);
        const n = Number(args[2]);
        if (Number.isNaN(start) || Number.isNaN(n) || start < 1) return '#VALUE!';
        return str.substring(start - 1, start - 1 + n);
      }
      case 'DATE': {
        const y = Number(args[0]);
        const m = Number(args[1]);
        const d = Number(args[2]);
        if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return '#VALUE!';
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.toISOString().slice(0, 10);
      }
      case 'VLOOKUP': {
        const lookupVal = args[0];
        const tableArg = args[1];
        const colIdx = Number(args[2]);
        const rangeLookup = args.length > 3 ? Boolean(args[3]) : true;

        const grid: any[][] = lookupGridOf(tableArg, 'column');

        if (grid.length === 0 || colIdx < 1) return '#REF!';
        const maxCols = Math.max(...grid.map((r) => r.length));
        if (colIdx > maxCols) return '#REF!';

        if (!rangeLookup) {
          // Exact match
          for (let r = 0; r < grid.length; r++) {
            const cellVal = grid[r][0];
            if (isCellMatch(cellVal, lookupVal)) {
              return colIdx - 1 < grid[r].length ? grid[r][colIdx - 1] : '';
            }
          }
          return '#N/A';
        } else {
          // Approximate match
          let bestRow = -1;
          for (let r = 0; r < grid.length; r++) {
            const cellVal = grid[r][0];
            if (cellVal === undefined || cellVal === '') continue;
            const numCell = Number(cellVal);
            const numLookup = Number(lookupVal);
            if (!Number.isNaN(numCell) && !Number.isNaN(numLookup)) {
              if (numCell <= numLookup) bestRow = r;
            } else {
              if (String(cellVal).localeCompare(String(lookupVal)) <= 0) bestRow = r;
            }
          }
          if (bestRow === -1) return '#N/A';
          return colIdx - 1 < grid[bestRow].length ? grid[bestRow][colIdx - 1] : '';
        }
      }
      case 'HLOOKUP': {
        const lookupVal = args[0];
        const tableArg = args[1];
        const rowIdx = Number(args[2]);
        const rangeLookup = args.length > 3 ? Boolean(args[3]) : true;

        const grid: any[][] =
          (tableArg as any)?._range2D ||
          (Array.isArray(tableArg) && Array.isArray(tableArg[0]) ? tableArg : [tableArg]);

        if (grid.length === 0 || rowIdx < 1 || rowIdx > grid.length) return '#REF!';
        const firstRow = grid[0];

        if (!rangeLookup) {
          for (let c = 0; c < firstRow.length; c++) {
            const cellVal = firstRow[c];
            if (isCellMatch(cellVal, lookupVal)) {
              return c < grid[rowIdx - 1].length ? grid[rowIdx - 1][c] : '';
            }
          }
          return '#N/A';
        } else {
          let bestCol = -1;
          for (let c = 0; c < firstRow.length; c++) {
            const cellVal = firstRow[c];
            if (cellVal === undefined || cellVal === '') continue;
            const numCell = Number(cellVal);
            const numLookup = Number(lookupVal);
            if (!Number.isNaN(numCell) && !Number.isNaN(numLookup)) {
              if (numCell <= numLookup) bestCol = c;
            } else {
              if (String(cellVal).localeCompare(String(lookupVal)) <= 0) bestCol = c;
            }
          }
          if (bestCol === -1) return '#N/A';
          return bestCol < grid[rowIdx - 1].length ? grid[rowIdx - 1][bestCol] : '';
        }
      }
      case 'INDEX': {
        const tableArg = args[0];
        const rowNum = Number(args[1]);
        const colNum = args.length > 2 ? Number(args[2]) : 1;

        const grid: any[][] = lookupGridOf(tableArg, 'row');

        if (rowNum < 1 || rowNum > grid.length) return '#REF!';
        const targetRow = grid[rowNum - 1];
        if (colNum < 1 || colNum > targetRow.length) return '#REF!';
        return targetRow[colNum - 1];
      }
      case 'MATCH': {
        const lookupVal = args[0];
        const arr = Array.isArray(args[1]) ? args[1] : [args[1]];
        const matchType = args.length > 2 ? Number(args[2]) : 1;

        if (matchType === 0) {
          for (let i = 0; i < arr.length; i++) {
            if (isCellMatch(arr[i], lookupVal)) {
              return i + 1;
            }
          }
          return '#N/A';
        } else if (matchType === 1) {
          let bestIdx = -1;
          for (let i = 0; i < arr.length; i++) {
            const numA = Number(arr[i]);
            const numL = Number(lookupVal);
            if (!Number.isNaN(numA) && !Number.isNaN(numL)) {
              if (numA <= numL) bestIdx = i;
            } else if (String(arr[i]).localeCompare(String(lookupVal)) <= 0) {
              bestIdx = i;
            }
          }
          return bestIdx === -1 ? '#N/A' : bestIdx + 1;
        } else if (matchType === -1) {
          let bestIdx = -1;
          for (let i = 0; i < arr.length; i++) {
            const numA = Number(arr[i]);
            const numL = Number(lookupVal);
            if (!Number.isNaN(numA) && !Number.isNaN(numL)) {
              if (numA >= numL) bestIdx = i;
            } else if (String(arr[i]).localeCompare(String(lookupVal)) >= 0) {
              bestIdx = i;
            }
          }
          return bestIdx === -1 ? '#N/A' : bestIdx + 1;
        }
        return '#N/A';
      }
      default:
        throw new ConversionFailedError(`Unsupported spreadsheet function: ${name}`);
    }
  }

  private static readStringToken(expr: string, start: number): { val: string; next: number } {
    let str = '';
    let i = start + 1;
    while (i < expr.length) {
      if (expr[i] !== '"') {
        str += expr[i++];
        continue;
      }
      if (i + 1 < expr.length && expr[i + 1] === '"') {
        str += '"';
        i += 2;
        continue;
      }
      i++;
      break;
    }
    return { val: str, next: i };
  }

  private static readComparisonToken(expr: string, start: number): { val: string; next: number } {
    const ch = expr[start]!;
    const nextCh = expr[start + 1];
    if ((ch === '<' && (nextCh === '>' || nextCh === '=')) || (ch === '>' && nextCh === '=')) {
      return { val: ch + nextCh, next: start + 2 };
    }
    return { val: ch, next: start + 1 };
  }

  private static readWordOrRefToken(expr: string, i: number): { token: FormulaToken; next: number } | null {
    STICKY_RANGE_RE.lastIndex = i;
    const rangeMatch = STICKY_RANGE_RE.exec(expr);
    if (rangeMatch) {
      const afterRange = expr[i + rangeMatch[0].length];
      if (!afterRange || !/[A-Za-z0-9_]/.test(afterRange)) {
        return { token: { type: 'RANGE', val: rangeMatch[0] }, next: i + rangeMatch[0].length };
      }
    }
    STICKY_OVERSIZE_RANGE_RE.lastIndex = i;
    if (STICKY_OVERSIZE_RANGE_RE.exec(expr)) {
      throw new PayloadLimitError(`Spreadsheet formula range at offset ${i} exceeds ECMA-376 grid bounds.`);
    }
    STICKY_CELL_RE.lastIndex = i;
    const cellMatch = STICKY_CELL_RE.exec(expr);
    if (cellMatch) {
      const nextChar = expr[i + cellMatch[0].length];
      if (nextChar !== '(' && (!nextChar || !/[A-Za-z0-9_.]/.test(nextChar))) {
        return { token: { type: 'CELL_REF', val: cellMatch[0] }, next: i + cellMatch[0].length };
      }
    }
    STICKY_IDENT_RE.lastIndex = i;
    const fnMatch = STICKY_IDENT_RE.exec(expr);
    if (!fnMatch) return null;
    const str = fnMatch[0];
    const next = i + str.length;
    if (expr[next] === '(') return { token: { type: 'FUNCTION', val: str }, next };
    const upper = str.toUpperCase();
    if (upper === 'TRUE' || upper === 'FALSE') return { token: { type: 'BOOLEAN', val: upper === 'TRUE' }, next };
    return { token: { type: 'CELL_REF', val: str }, next };
  }

  private tokenize(expr: string): FormulaToken[] {
    const tokens: FormulaToken[] = [];
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i]!;
      if (ch <= ' ') { i++; continue; }
      if (ch === '(') { tokens.push({ type: 'LPAREN', val: '(' }); i++; continue; }
      if (ch === ')') { tokens.push({ type: 'RPAREN', val: ')' }); i++; continue; }
      if (ch === ',') { tokens.push({ type: 'COMMA', val: ',' }); i++; continue; }
      if (ch === '"') {
        const parsed = SpreadsheetFormulaEvaluator.readStringToken(expr, i);
        tokens.push({ type: 'STRING', val: parsed.val });
        i = parsed.next;
        continue;
      }
      if (ch === '<' || ch === '>' || ch === '=') {
        const parsed = SpreadsheetFormulaEvaluator.readComparisonToken(expr, i);
        tokens.push({ type: 'OP_COMP', val: parsed.val });
        i = parsed.next;
        continue;
      }
      if ('+-*/^%&'.includes(ch)) {
        tokens.push({ type: 'OP', val: ch });
        i++;
        continue;
      }
      STICKY_NUM_RE.lastIndex = i;
      const numMatch = STICKY_NUM_RE.exec(expr);
      if (numMatch) {
        tokens.push({ type: 'NUMBER', val: Number.parseFloat(numMatch[0]) });
        i += numMatch[0].length;
        continue;
      }
      const wordToken = SpreadsheetFormulaEvaluator.readWordOrRefToken(expr, i);
      if (wordToken) {
        tokens.push(wordToken.token);
        i = wordToken.next;
        continue;
      }
      throw new Error(`Unexpected character: "${ch}" at index ${i}`);
    }
    return tokens;
  }
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
      totalRangeCells += bounds.cellCount;
      if (totalRangeCells > MAX_TOTAL_FORMULA_RANGE_CELLS) {
        throw new PayloadLimitError(
          `Spreadsheet formula exceeds cumulative range cell budget of ${MAX_TOTAL_FORMULA_RANGE_CELLS}.`,
        );
      }
      ranges.push(bounds);
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
    let totalRangeCells = 0;
    for (const [ref, fc] of formulaMap.entries()) {
      const { cells, ranges } = SpreadsheetDagEngine.extractFormulaReferences(fc.formula);
      const depsForCell = new Set<string>();
      for (const r of cells) {
        if (formulaMap.has(r)) depsForCell.add(r);
      }
      for (const range of ranges) {
        totalRangeCells += range.cellCount;
        if (totalRangeCells > MAX_TOTAL_FORMULA_RANGE_CELLS) {
          throw new PayloadLimitError(
            `Spreadsheet formulas exceed cumulative range cell budget of ${MAX_TOTAL_FORMULA_RANGE_CELLS}.`,
          );
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
    rows?: string[][]
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

    for (const node of topoOrder) {
      const fc = formulaMap.get(node);
      if (!fc) continue;
      try {
        const result = evaluator.evaluate(fc.formula);
        this.cellMap[node] = result;
        SpreadsheetDagEngine.writeRowCell(rows, fc, result !== null && result !== undefined ? String(result) : '');
      } catch (err) {
        if (err instanceof PayloadLimitError) throw err;
        this.cellMap[node] = '#REF!';
        SpreadsheetDagEngine.writeRowCell(rows, fc, '#REF!');
      }
    }

    return { evaluated: this.cellMap, cycles: cyclicCells };
  }
}
