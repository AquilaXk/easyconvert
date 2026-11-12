import { ConversionFailedError } from '../../types';

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
        } catch {
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
    const match1 = start.match(/^(\$?)([A-Za-z]+)(\$?)([0-9]+)$/);
    const match2 = end.match(/^(\$?)([A-Za-z]+)(\$?)([0-9]+)$/);
    if (!match1 || !match2) return [];

    const colToNum = (s: string): number => {
      let c = 0;
      for (let i = 0; i < s.length; i++) c = c * 26 + (s.charCodeAt(i) - 64);
      return c;
    };

    const c1 = colToNum(match1[2].toUpperCase());
    const r1 = Number.parseInt(match1[4], 10);
    const c2 = colToNum(match2[2].toUpperCase());
    const r2 = Number.parseInt(match2[4], 10);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);

    const rows: any[][] = [];
    for (let r = minR; r <= maxR; r++) {
      const row: any[] = [];
      for (let c = minC; c <= maxC; c++) {
        let colName = '';
        let temp = c;
        while (temp > 0) {
          colName = String.fromCharCode(65 + ((temp - 1) % 26)) + colName;
          temp = Math.floor((temp - 1) / 26);
        }
        row.push(this.cellLookup(`${colName}${r}`));
      }
      rows.push(row);
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

  private tokenize(expr: string): FormulaToken[] {
    const tokens: FormulaToken[] = [];
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '(') { tokens.push({ type: 'LPAREN', val: '(' }); i++; continue; }
      if (ch === ')') { tokens.push({ type: 'RPAREN', val: ')' }); i++; continue; }
      if (ch === ',') { tokens.push({ type: 'COMMA', val: ',' }); i++; continue; }
      if (ch === '"') {
        let str = '';
        i++;
        while (i < expr.length) {
          if (expr[i] === '"') {
            if (i + 1 < expr.length && expr[i + 1] === '"') { str += '"'; i += 2; }
            else { i++; break; }
          } else { str += expr[i++]; }
        }
        tokens.push({ type: 'STRING', val: str });
        continue;
      }
      if (ch === '<' || ch === '>' || ch === '=') {
        let op = ch;
        if (i + 1 < expr.length && ((ch === '<' && (expr[i + 1] === '>' || expr[i + 1] === '=')) || (ch === '>' && expr[i + 1] === '='))) {
          op += expr[i + 1];
          i += 2;
        } else {
          i++;
        }
        tokens.push({ type: 'OP_COMP', val: op });
        continue;
      }
      if ('+-*/^%&'.includes(ch)) {
        tokens.push({ type: 'OP', val: ch });
        i++;
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(expr[i + 1]))) {
        const match = expr.slice(i).match(/^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/)!;
        tokens.push({ type: 'NUMBER', val: Number.parseFloat(match[0]) });
        i += match[0].length;
        continue;
      }
      const rangeMatch = expr.slice(i).match(/^(\$?[A-Za-z]+)(\$?)([0-9]+):(\$?[A-Za-z]+)(\$?)([0-9]+)/);
      if (rangeMatch) {
        tokens.push({ type: 'RANGE', val: rangeMatch[0] });
        i += rangeMatch[0].length;
        continue;
      }
      const cellMatch = expr.slice(i).match(/^(\$?[A-Za-z]+)(\$?)([0-9]+)/);
      if (cellMatch && expr[i + cellMatch[0].length] !== '(') {
        tokens.push({ type: 'CELL_REF', val: cellMatch[0] });
        i += cellMatch[0].length;
        continue;
      }
      const fnMatch = expr.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
      if (fnMatch) {
        const str = fnMatch[0];
        const nextChar = expr[i + str.length];
        if (nextChar === '(') {
          tokens.push({ type: 'FUNCTION', val: str });
        } else if (str.toUpperCase() === 'TRUE') {
          tokens.push({ type: 'BOOLEAN', val: true });
        } else if (str.toUpperCase() === 'FALSE') {
          tokens.push({ type: 'BOOLEAN', val: false });
        } else {
          tokens.push({ type: 'CELL_REF', val: str });
        }
        i += str.length;
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

  /**
   * Extracts dependent cell references and ranges from formula expression.
   */
  public static extractDependencies(formula: string): string[] {
    if (!formula) return [];
    if (formula.startsWith('=')) formula = formula.slice(1);
    // Remove string literals to avoid false positives
    const stripped = formula.replace(/"(?:[^"\\]|\\.)*"/g, '');
    const refs = new Set<string>();

    const colToNum = (s: string): number => {
      let c = 0;
      for (let i = 0; i < s.length; i++) c = c * 26 + (s.charCodeAt(i) - 64);
      return c;
    };
    const numToCol = (n: number): string => {
      let s = '';
      let temp = n;
      while (temp > 0) {
        s = String.fromCharCode(65 + ((temp - 1) % 26)) + s;
        temp = Math.floor((temp - 1) / 26);
      }
      return s;
    };

    // 1. Ranges like A1:B5 or $A$1:$B$5 (supporting whitespace around colon)
    const rangeRegex = /(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)\s*:\s*(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)/g;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = rangeRegex.exec(stripped)) !== null) {
      const c1 = rMatch[2].toUpperCase();
      const row1 = parseInt(rMatch[4], 10);
      const c2 = rMatch[6].toUpperCase();
      const row2 = parseInt(rMatch[8], 10);

      const startC = Math.min(colToNum(c1), colToNum(c2));
      const endC = Math.max(colToNum(c1), colToNum(c2));
      const startR = Math.min(row1, row2);
      const endR = Math.max(row1, row2);

      for (let r = startR; r <= endR; r++) {
        for (let c = startC; c <= endC; c++) {
          refs.add(`${numToCol(c)}${r}`);
        }
      }
    }

    // Replace all extracted ranges with spaces to avoid duplicate endpoint matches
    const strippedWithoutRanges = stripped.replace(rangeRegex, ' ');

    // 2. Individual cell references like A1, $B$2
    const cellRegex = /\b(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)\b/g;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = cellRegex.exec(strippedWithoutRanges)) !== null) {
      const afterIdx = cMatch.index + cMatch[0].length;
      const afterStr = strippedWithoutRanges.slice(afterIdx).trimStart();
      if (afterStr.startsWith('(')) {
        continue; // Function name
      }
      const ref = `${cMatch[2].toUpperCase()}${cMatch[4]}`;
      refs.add(ref);
    }

    return Array.from(refs);
  }

  /**
   * Evaluates all formula cells in topological dependency order.
   * Detects cycles and safely sets #CYCLE! error codes without stack overflows.
   */
  public evaluateWithDag(
    formulaCells: FormulaCellInfo[],
    rows?: string[][]
  ): { evaluated: Record<string, any>; cycles: string[] } {
    const formulaMap = new Map<string, FormulaCellInfo>();
    for (const fc of formulaCells) {
      if (fc.ref) {
        formulaMap.set(fc.ref.toUpperCase(), fc);
      }
    }

    // Build dependency graph among formula cells and compute in-degrees for Kahn's algorithm
    const inDegree = new Map<string, number>();
    const reverseDeps = new Map<string, Set<string>>(); // who depends on me
    for (const [ref, fc] of formulaMap.entries()) {
      const referenced = SpreadsheetDagEngine.extractDependencies(fc.formula);
      let deg = 0;
      for (const r of referenced) {
        if (formulaMap.has(r)) {
          deg++;
          let rev = reverseDeps.get(r);
          if (!rev) {
            rev = new Set();
            reverseDeps.set(r, rev);
          }
          rev.add(ref);
        }
      }
      inDegree.set(ref, deg);
    }

    const topoOrder: string[] = [];
    for (const [node, deg] of inDegree.entries()) {
      if (deg === 0) {
        topoOrder.push(node);
      }
    }

    let qHead = 0;
    while (qHead < topoOrder.length) {
      const curr = topoOrder[qHead++]!;
      const dependents = reverseDeps.get(curr);
      if (!dependents) continue;
      for (const dep of dependents) {
        const newDeg = (inDegree.get(dep) || 1) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) {
          topoOrder.push(dep);
        }
      }
    }

    // Any node whose in-degree did not reach 0 is part of or downstream of a cycle
    const cyclicCells: string[] = [];
    for (const [cRef, deg] of inDegree.entries()) {
      if (deg > 0) {
        cyclicCells.push(cRef);
        this.cellMap[cRef] = '#CYCLE!';
        const fc = formulaMap.get(cRef);
        if (fc && rows && fc.rowIdx !== undefined && fc.colIdx !== undefined && rows[fc.rowIdx]) {
          rows[fc.rowIdx][fc.colIdx] = '#CYCLE!';
        }
      }
    }

    // Evaluate in topological order
    const evaluator = new SpreadsheetFormulaEvaluator((ref) => {
      const cleanRef = ref.replace(/\$/g, '').toUpperCase();
      const val = this.cellMap[cleanRef];
      if (val === undefined || val === null) return '';
      return val;
    });

    for (const node of topoOrder) {
      const fc = formulaMap.get(node);
      if (!fc) continue;
      try {
        const result = evaluator.evaluate(fc.formula);
        this.cellMap[node] = result;
        const strResult = result !== null && result !== undefined ? String(result) : '';
        if (rows && fc.rowIdx !== undefined && fc.colIdx !== undefined && rows[fc.rowIdx]) {
          rows[fc.rowIdx][fc.colIdx] = strResult;
        }
      } catch {
        this.cellMap[node] = '#REF!';
        if (rows && fc.rowIdx !== undefined && fc.colIdx !== undefined && rows[fc.rowIdx]) {
          rows[fc.rowIdx][fc.colIdx] = '#REF!';
        }
      }
    }

    return {
      evaluated: this.cellMap,
      cycles: cyclicCells,
    };
  }
}
