import * as formulajs from '@formulajs/formulajs';
import { xlookup, xmatch } from './spreadsheet-xlookup';
import FormulaParser from './vendor/fast-formula-parser';

const { FormulaError } = FormulaParser;

/** Excel's limit for the text in one cell; a longer result is #VALUE!, which also stops `REPT`-style growth. */
export const MAX_TEXT_RESULT_LENGTH = 32_767;

type FunctionTable = Record<string, (...args: never[]) => unknown>;
type SpreadsheetFunction = (...args: unknown[]) => unknown;

/**
 * Functions of the vendored parser that are never offered to a formula in an uploaded file.
 * - `WEBSERVICE` fetches a URL and `FILTERXML` reads what it returns.
 * - `INDIRECT` and `OFFSET` build a reference at run time, which no range limit or dependency graph can see.
 * - `CELL` and `INFO` report on the host and the application, not on the workbook.
 * - The `BESSEL` family loops as many times as its order argument says, which a formula can set to any number.
 */
const BLOCKED_FUNCTIONS: ReadonlySet<string> = new Set([
  'WEBSERVICE', 'FILTERXML', 'INDIRECT', 'OFFSET', 'CELL', 'INFO', 'BESSELI', 'BESSELJ', 'BESSELK', 'BESSELY',
]);

/**
 * Functions the vendored parser lists but does not implement (they answer "not implemented"), and functions it does not list
 * at all, taken from formulajs (MIT) in the same name. Dotted names are looked up through the nested objects of formulajs.
 */
const FORMULAJS_FUNCTIONS: readonly string[] = [
  // Statistics.
  'AVERAGEIFS', 'COUNTA', 'COUNTBLANK', 'COUNTIFS', 'LARGE', 'MAX', 'MAXA', 'MAXIFS', 'MEDIAN', 'MIN', 'MINA', 'MINIFS',
  'PERMUT', 'PERMUTATIONA', 'SMALL', 'SUMIFS', 'MODE.SNGL', 'PEARSON', 'PERCENTILE.EXC', 'PERCENTILE.INC',
  'PERCENTRANK.EXC', 'PERCENTRANK.INC', 'PROB', 'QUARTILE.EXC', 'QUARTILE.INC', 'RANK.AVG', 'RANK.EQ', 'RSQ', 'SKEW',
  'SKEW.P', 'SLOPE', 'STDEV.P', 'STDEV.S', 'STDEVA', 'STDEVPA', 'STEYX', 'T.TEST', 'TRIMMEAN', 'VAR.P', 'VAR.S', 'VARA',
  'VARPA', 'Z.TEST',
  // Where the vendored version is wrong (TRUNC ignores its digits, GEOMEAN and WEEKNUM give other numbers than Excel).
  'GEOMEAN', 'TRUNC', 'WEEKNUM',
  // Logical, lookup, information and text.
  'CHOOSE', 'SWITCH', 'MATCH', 'LOOKUP', 'ISODD', 'SUBSTITUTE', 'TEXTJOIN',
  // Financial.
  'PMT', 'FV', 'PV', 'NPV', 'IRR', 'RATE', 'NPER', 'IPMT', 'PPMT', 'SLN', 'SYD', 'DB', 'DDB', 'MIRR', 'EFFECT', 'NOMINAL',
  'CUMIPMT', 'CUMPRINC', 'ISPMT', 'RRI', 'FVSCHEDULE',
];

/** Names Excel keeps from before the dotted names: each reads the same way as the function it points to. */
const LEGACY_ALIASES: Readonly<Record<string, string>> = {
  STDEV: 'STDEV.S',
  STDEVP: 'STDEV.P',
  VAR: 'VAR.S',
  VARP: 'VAR.P',
  MODE: 'MODE.SNGL',
  RANK: 'RANK.EQ',
  PERCENTILE: 'PERCENTILE.INC',
  QUARTILE: 'QUARTILE.INC',
  PERCENTRANK: 'PERCENTRANK.INC',
  COVAR: 'COVARIANCE.P',
};

/**
 * Largest value of an argument that sets how much a function builds or loops, by function and zero-based argument position.
 * A formula can write any number there, so the function would allocate or run as long as the number says. A larger value is
 * `#NUM!`, as the `places` of the base conversions are in Excel (at most 10).
 */
const ARGUMENT_CEILINGS: Readonly<Record<string, Readonly<Record<number, number>>>> = {
  ...Object.fromEntries(
    ['BIN2HEX', 'BIN2OCT', 'DEC2BIN', 'DEC2HEX', 'DEC2OCT', 'HEX2BIN', 'HEX2OCT', 'OCT2BIN', 'OCT2HEX'].map((name) => [
      name,
      { 1: 10 },
    ]),
  ),
  DOLLAR: { 1: 127 },
  FIXED: { 1: 127 },
  MUNIT: { 0: 1000 },
};

/**
 * Functions that step through one of their numbers (the trials of a binomial, the degrees of freedom of a chi-square, `x` of a
 * Poisson count, the days of `WORKDAY`): with 2,000,000,000 the call takes seconds, with 1e11 it does not end. A number past the
 * ceiling in any argument is `#NUM!`. A date serial ends at 2,958,465 (9999-12-31).
 */
const ALL_ARGUMENT_CEILINGS: ReadonlyArray<readonly [RegExp, number]> = [
  [
    /^(?:(?:BETA|BINOM|CHISQ|CONFIDENCE|EXPON|F|GAMMA|HYPGEOM|LOGNORM|NEGBINOM|NORM|POISSON|T|WEIBULL)\.|(?:GAMMA|GAMMALN|PERMUT|PERMUTATIONA|COMBIN|COMBINA|FACT|FACTDOUBLE|MULTINOMIAL)$)/,
    1_000_000,
  ],
  [/^(?:WORKDAY|NETWORKDAYS)(?:\.INTL)?$/, 10_000_000],
];

interface ReceivedArg {
  value?: unknown;
  omitted?: boolean;
  isArray?: boolean;
  isRangeRef?: boolean;
  isCellRef?: boolean;
}

/**
 * Functions that read the numbers of a list the way Excel does: in a range or a cell reference only numbers count (text,
 * booleans and empty cells are left out, an error is the result), and a number written into the argument list as text or a
 * boolean counts as that number. formulajs hands every value to its arithmetic; these arguments are cleaned before it.
 */
const NUMBER_LIST_FUNCTIONS: ReadonlySet<string> = new Set([
  'MAX', 'MIN', 'MEDIAN', 'LARGE', 'SMALL', 'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'MODE.SNGL', 'GEOMEAN', 'TRIMMEAN',
  'SKEW', 'SKEW.P', 'PERCENTILE.INC', 'PERCENTILE.EXC', 'QUARTILE.INC', 'QUARTILE.EXC', 'RANK.EQ', 'RANK.AVG',
]);

function lookupFormulajs(name: string): SpreadsheetFunction | undefined {
  let node: unknown = formulajs;
  for (const part of name.split('.')) {
    if (node === null || (typeof node !== 'object' && typeof node !== 'function')) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'function' ? (node as SpreadsheetFunction) : undefined;
}

/** The numbers a reference or array holds, or the first error in it. */
function numbersOf(value: unknown, out: number[]): Error | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = numbersOf(item, out);
      if (error) return error;
    }
  } else if (typeof value === 'number') {
    out.push(value);
  } else if (value instanceof Error) {
    return value;
  }
  return undefined;
}

/** One argument of a number-list function: a list of numbers, a number, or the error to answer with. */
function numberListArg(a: ReceivedArg): unknown {
  if (a.isRangeRef || a.isCellRef || a.isArray) {
    const out: number[] = [];
    return numbersOf(a.value, out) ?? out;
  }
  const v = a.value;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return v.trim() === '' || Number.isNaN(n) ? FormulaError.VALUE : n;
  }
  return v;
}

/**
 * formulajs spreads a list into the arguments of `Math.max`, `Math.min` and `anyError`, and a call with more than about 120,000
 * arguments overflows the stack. Two ranges of 100,000 cells are within the limits of a formula, so for `MAX` and `MIN`, whose
 * result is the same for the maximum of the maxima, the list is cut into pieces below that size.
 */
const REDUCIBLE_FUNCTIONS: ReadonlySet<string> = new Set(['MAX', 'MIN']);
const REDUCIBLE_CHUNK = 20_000;

function reduceInChunks(fn: SpreadsheetFunction, args: unknown[]): unknown {
  const numbers: unknown[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) for (const item of arg) numbers.push(item);
    else numbers.push(arg);
  }
  if (numbers.length <= REDUCIBLE_CHUNK) return fn(numbers);
  const partial: unknown[] = [];
  for (let i = 0; i < numbers.length; i += REDUCIBLE_CHUNK) partial.push(fn(numbers.slice(i, i + REDUCIBLE_CHUNK)));
  return fn(partial);
}

/** A formulajs function as the parser calls it: arguments arrive as `{ value, omitted }`, errors leave as `FormulaError`. */
function bridgeFormulajs(
  fn: SpreadsheetFunction,
  takesContext: boolean,
  numberList: boolean,
  reducible: boolean,
): (...received: unknown[]) => unknown {
  return (...received) => {
    const args = (takesContext ? received.slice(1) : received).map((arg) => {
      const a = arg as ReceivedArg | null;
      if (a === null || a.omitted) return undefined;
      return numberList ? numberListArg(a) : a.value;
    });
    const failed = args.find((arg) => arg instanceof Error);
    if (failed) return failed;
    const result = reducible ? reduceInChunks(fn, args) : fn(...args);
    if (result instanceof FormulaError) return result;
    if (result instanceof Error) return new FormulaError(result.message.startsWith('#') ? result.message : '#VALUE!');
    return result;
  };
}

/** `fn` that answers `#NUM!` when an argument is past its ceiling: `ceilings` by position, or `all` for every argument. */
function withCeilings(
  fn: (...a: never[]) => unknown,
  ceilings: Readonly<Record<number, number>>,
  all?: number,
): (...a: never[]) => unknown {
  const limits = Object.entries(ceilings).map(([position, ceiling]) => [Number(position), ceiling] as const);
  return (...received) => {
    for (const [position, ceiling] of limits) {
      const value = (received[position] as ReceivedArg | null | undefined)?.value;
      if (typeof value === 'number' && value > ceiling) return FormulaError.NUM;
    }
    if (all !== undefined) {
      for (const arg of received) {
        const value = (arg as ReceivedArg | null | undefined)?.value;
        if (typeof value === 'number' && Math.abs(value) > all) return FormulaError.NUM;
      }
    }
    return fn(...received);
  };
}

/**
 * The vendored aggregates skip an error found in a cell or range they read (`SUM(B1,1)` with `#DIV/0!` in B1 gave 1); Excel
 * answers the error. These names get the first error among their arguments before they run.
 */
const ERROR_PROPAGATING_FUNCTIONS: readonly string[] = ['SUM', 'PRODUCT', 'SUMSQ', 'AVERAGE', 'AVERAGEA'];

function firstError(value: unknown): Error | undefined {
  if (value instanceof Error) return value;
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const found = firstError(item);
    if (found) return found;
  }
  return undefined;
}

function withErrorPropagation(fn: (...a: never[]) => unknown): (...a: never[]) => unknown {
  return (...received) => {
    for (const arg of received) {
      const found = firstError((arg as ReceivedArg | null | undefined)?.value);
      if (found) return found;
    }
    return fn(...received);
  };
}

/** `REPT` that does not build a text past the cell limit (`REPT("a",1E11)` would fill the memory). */
function withBoundedRepeat(fn: (...a: never[]) => unknown): (...a: never[]) => unknown {
  return (...received) => {
    const text = (received[0] as ReceivedArg | null | undefined)?.value;
    const times = (received[1] as ReceivedArg | null | undefined)?.value;
    if (
      typeof times === 'number' &&
      (times > MAX_TEXT_RESULT_LENGTH || String(text ?? '').length * Math.floor(times) > MAX_TEXT_RESULT_LENGTH)
    ) {
      return FormulaError.VALUE;
    }
    return fn(...received);
  };
}

let cachedTable: { functions: FunctionTable; takesContext: ReadonlySet<string> } | undefined;

/** The functions a formula may call, built once from the vendored table, formulajs and the legacy names. */
export function spreadsheetFunctionTable(): { functions: FunctionTable; takesContext: ReadonlySet<string> } {
  if (cachedTable) return cachedTable;
  const base = new FormulaParser({});
  const takesContext = new Set(base.funsNeedContext);
  const functions: FunctionTable = Object.create(null) as FunctionTable;
  for (const [name, fn] of Object.entries(base.functions)) {
    if (!BLOCKED_FUNCTIONS.has(name)) functions[name] = fn;
  }
  for (const name of FORMULAJS_FUNCTIONS) {
    const fn = lookupFormulajs(name);
    if (fn) functions[name] = bridgeFormulajs(fn, takesContext.has(name), NUMBER_LIST_FUNCTIONS.has(name), REDUCIBLE_FUNCTIONS.has(name)) as FunctionTable[string];
  }
  for (const [legacy, current] of Object.entries(LEGACY_ALIASES)) {
    const fn = functions[current];
    if (fn) functions[legacy] = fn;
  }
  for (const name of Object.keys(functions)) {
    const ceilings = ARGUMENT_CEILINGS[name];
    const all = ALL_ARGUMENT_CEILINGS.find(([pattern]) => pattern.test(name))?.[1];
    if (ceilings || all !== undefined) functions[name] = withCeilings(functions[name]!, ceilings ?? {}, all);
  }
  for (const name of ERROR_PROPAGATING_FUNCTIONS) {
    if (functions[name]) functions[name] = withErrorPropagation(functions[name]!);
  }
  if (functions.REPT) functions.REPT = withBoundedRepeat(functions.REPT);
  functions.XLOOKUP = xlookup as FunctionTable[string];
  functions.XMATCH = xmatch as FunctionTable[string];
  const numberValue = functions.NUMBERVALUE as SpreadsheetFunction | undefined;
  if (numberValue) {
    // VALUE reads text as NUMBERVALUE does with the point as the decimal mark and the comma as the group mark.
    functions.VALUE = ((text: unknown) =>
      numberValue(text, { value: '.', isArray: false }, { value: ',', isArray: false })) as FunctionTable[string];
  }
  cachedTable = { functions, takesContext };
  return cachedTable;
}
