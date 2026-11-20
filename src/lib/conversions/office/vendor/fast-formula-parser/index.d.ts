/**
 * Types for the vendored `index.js` (written for EasyConvert; the JavaScript next to it is unmodified). Only the part the
 * formula adapter uses is declared.
 */
export interface FormulaCellRef {
  row: number;
  col: number;
  sheet?: string;
}

export interface FormulaRangeRef {
  from: { row: number; col: number };
  to: { row: number; col: number };
  sheet?: string;
}

export interface FormulaParserConfig {
  onCell?: (ref: FormulaCellRef) => unknown;
  onRange?: (ref: FormulaRangeRef) => unknown;
  functions?: Record<string, (...args: never[]) => unknown>;
}

export class FormulaError extends Error {
  static readonly DIV0: FormulaError;
  static readonly NA: FormulaError;
  static readonly NAME: FormulaError;
  static readonly NULL: FormulaError;
  static readonly NUM: FormulaError;
  static readonly REF: FormulaError;
  static readonly VALUE: FormulaError;
  constructor(error: string, msg?: string | null, details?: unknown);
  readonly error: string;
  readonly details?: unknown;
}

export default class FormulaParser {
  static readonly FormulaError: typeof FormulaError;
  static readonly MAX_ROW: number;
  static readonly MAX_COLUMN: number;
  static readonly WildCard: {
    isWildCard(value: unknown): boolean;
    /** The pattern as a whole-text, case-insensitive match. */
    toExactRegex(lookupText: string): RegExp;
  };
  constructor(config?: FormulaParserConfig);
  /** The function table: the parser looks every name up here after upper-casing it. */
  functions: Record<string, (...args: never[]) => unknown>;
  /** Names of the functions that receive the parser as their first argument. */
  funsNeedContext: string[];
  onCell: (ref: FormulaCellRef) => unknown;
  onRange: (ref: FormulaRangeRef) => unknown;
  parse(formula: string, position: { row: number; col: number; sheet?: string }): unknown;
}
