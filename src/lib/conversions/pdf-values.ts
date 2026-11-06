/**
 * The lexical layer of a PDF (ISO 32000-1 section 7.2 and 7.3): white space and comments, the value types, and a bounded parser
 * for one value (names, strings, numbers, references, arrays and dictionaries) from the text of a file. `pdf-document.ts` re-exports
 * what other readers import.
 */

import { ConversionFailedError } from '../types';

/** Malformed or over-complex PDF structure (cycles, runaway nesting, unterminated streams). Maps to HTTP 400. */
export class PdfStructureError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'PdfStructureError';
  }
}

export const MAX_OBJECT_NUMBER_DIGITS = 10;
export const MAX_GENERATION_DIGITS = 5;

/** Nesting of arrays and dictionaries inside one object. */
export const MAX_PDF_PARSE_DEPTH = 32;

export const CHAR_NUL = 0;
export const CHAR_TAB = 9;
export const CHAR_LF = 10;
export const CHAR_FF = 12;
export const CHAR_CR = 13;
export const CHAR_SPACE = 32;
export const CHAR_0 = 48;
export const CHAR_9 = 57;
export const CHAR_PERCENT = 37;
export const CHAR_LEFT_PAREN = 40;
export const CHAR_RIGHT_PAREN = 41;
export const CHAR_PLUS = 43;
export const CHAR_MINUS = 45;
export const CHAR_DOT = 46;
export const CHAR_SLASH = 47;
export const CHAR_LESS = 60;
export const CHAR_GREATER = 62;
export const CHAR_UPPER_R = 82;
export const CHAR_LEFT_BRACKET = 91;
export const CHAR_BACKSLASH = 92;
export const CHAR_RIGHT_BRACKET = 93;
export const CHAR_LEFT_BRACE = 123;
export const CHAR_RIGHT_BRACE = 125;

export type PdfValue = null | boolean | number | PdfName | PdfRef | PdfDict | PdfArray | PdfOpaque;
export interface PdfName {
  kind: 'name';
  value: string;
}
export interface PdfRef {
  kind: 'ref';
  num: number;
}
export interface PdfDict {
  kind: 'dict';
  entries: Map<string, PdfValue>;
}
export interface PdfArray {
  kind: 'array';
  items: PdfValue[];
}
export interface PdfOpaque {
  kind: 'string' | 'keyword';
  value: string;
}

export function isWhite(code: number): boolean {
  return (
    code === CHAR_SPACE || code === CHAR_LF || code === CHAR_CR || code === CHAR_TAB || code === CHAR_FF || code === CHAR_NUL
  );
}

const DELIMITER_CODES = new Set<number>([
  CHAR_LEFT_PAREN,
  CHAR_RIGHT_PAREN,
  CHAR_LESS,
  CHAR_GREATER,
  CHAR_LEFT_BRACKET,
  CHAR_RIGHT_BRACKET,
  CHAR_LEFT_BRACE,
  CHAR_RIGHT_BRACE,
  CHAR_SLASH,
  CHAR_PERCENT,
]);

export function isRegular(code: number): boolean {
  return !Number.isNaN(code) && !isWhite(code) && !DELIMITER_CODES.has(code);
}

export function isDigit(code: number): boolean {
  return code >= CHAR_0 && code <= CHAR_9;
}

/**
 * The first position at or after `from` that is not white space or a comment (section 7.2.3: a comment runs from `%` to the
 * end of the line), or `limit` when the text up to there holds nothing else: a comment with no line end ends at `limit`.
 */
export function skipWhite(src: string, from: number, limit = src.length): number {
  let pos = from;
  while (pos < limit) {
    const code = src.charCodeAt(pos);
    if (isWhite(code)) {
      pos++;
    } else if (code === CHAR_PERCENT) {
      while (pos < limit && src.charCodeAt(pos) !== CHAR_LF && src.charCodeAt(pos) !== CHAR_CR) pos++;
    } else {
      break;
    }
  }
  return pos;
}

export function decodeNameEscapes(raw: string): string {
  return raw.includes('#') ? raw.replace(/#([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))) : raw;
}

/** End of a literal string starting at `pos` (which holds the opening parenthesis). */
function endOfLiteralString(src: string, pos: number): number {
  let depth = 0;
  let i = pos;
  while (i < src.length) {
    const code = src.charCodeAt(i);
    if (code === CHAR_BACKSLASH) {
      i += 2;
      continue;
    }
    if (code === CHAR_LEFT_PAREN) depth++;
    if (code === CHAR_RIGHT_PAREN) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return src.length;
}

/** End of the value that starts at `from`, without building it. */
export function skipValue(src: string, from: number): number {
  let pos = skipWhite(src, from);
  if (pos >= src.length) return pos;
  let depth = 0;
  do {
    pos = skipWhite(src, pos);
    if (pos >= src.length) return pos;
    const code = src.charCodeAt(pos);
    if (code === CHAR_LESS && src.charCodeAt(pos + 1) === CHAR_LESS) {
      depth++;
      pos += 2;
    } else if (code === CHAR_GREATER && src.charCodeAt(pos + 1) === CHAR_GREATER) {
      depth--;
      pos += 2;
    } else if (code === CHAR_LEFT_BRACKET) {
      depth++;
      pos++;
    } else if (code === CHAR_RIGHT_BRACKET) {
      depth--;
      pos++;
    } else if (code === CHAR_LEFT_PAREN) {
      pos = endOfLiteralString(src, pos);
    } else if (code === CHAR_LESS) {
      const close = src.indexOf('>', pos);
      pos = close === -1 ? src.length : close + 1;
    } else if (code === CHAR_SLASH) {
      pos++;
      while (isRegular(src.charCodeAt(pos))) pos++;
    } else if (isRegular(code)) {
      while (isRegular(src.charCodeAt(pos))) pos++;
    } else {
      pos++;
    }
    if (depth > MAX_PDF_PARSE_DEPTH) throw new PdfStructureError('PDF object is nested too deeply.');
  } while (depth > 0);
  return pos;
}

/** Reads a reference tail ("<gen> R") after an object number, returning its end or -1. */
function referenceTailEnd(src: string, from: number): number {
  let pos = skipWhite(src, from);
  const genStart = pos;
  while (isDigit(src.charCodeAt(pos)) && pos - genStart < MAX_GENERATION_DIGITS) pos++;
  if (pos === genStart) return -1;
  pos = skipWhite(src, pos);
  if (src.charCodeAt(pos) === CHAR_UPPER_R && !isRegular(src.charCodeAt(pos + 1))) return pos + 1;
  return -1;
}

type Parsed = { value: PdfValue; end: number };

/** The dictionary whose `<<` is at `pos`. */
function parseDictionary(src: string, pos: number, depth: number): Parsed {
  const entries = new Map<string, PdfValue>();
  let cursor = pos + 2;
  while (true) {
    cursor = skipWhite(src, cursor);
    if (cursor >= src.length) break;
    if (src.charCodeAt(cursor) === CHAR_GREATER && src.charCodeAt(cursor + 1) === CHAR_GREATER) {
      cursor += 2;
      break;
    }
    const key = parseValue(src, cursor, depth + 1);
    cursor = key.end;
    if (isName(key.value)) {
      const valueAt = skipWhite(src, cursor);
      if (src.charCodeAt(valueAt) === CHAR_GREATER && src.charCodeAt(valueAt + 1) === CHAR_GREATER) {
        entries.set(key.value.value, null);
      } else {
        const value = parseValue(src, valueAt, depth + 1);
        cursor = value.end;
        entries.set(key.value.value, value.value);
      }
    }
  }
  return { value: { kind: 'dict', entries }, end: cursor };
}

/** The array whose `[` is at `pos`. */
function parseArray(src: string, pos: number, depth: number): Parsed {
  const items: PdfValue[] = [];
  let cursor = pos + 1;
  while (true) {
    cursor = skipWhite(src, cursor);
    if (cursor >= src.length) break;
    if (src.charCodeAt(cursor) === CHAR_RIGHT_BRACKET) {
      cursor++;
      break;
    }
    const item = parseValue(src, cursor, depth + 1);
    if (item.end <= cursor) break;
    cursor = item.end;
    items.push(item.value);
  }
  return { value: { kind: 'array', items }, end: cursor };
}

/** A number, or the reference "n g R" that a leading integer may begin. */
function parseNumberOrReference(src: string, pos: number): Parsed {
  let end = pos + 1;
  while (isDigit(src.charCodeAt(end)) || src.charCodeAt(end) === CHAR_DOT) end++;
  const text = src.slice(pos, end);
  const number = Number(text);
  if (/^\d+$/.test(text) && text.length <= MAX_OBJECT_NUMBER_DIGITS) {
    const refEnd = referenceTailEnd(src, end);
    if (refEnd !== -1) return { value: { kind: 'ref', num: number }, end: refEnd };
  }
  return { value: Number.isNaN(number) ? 0 : number, end };
}

/** A keyword or the constants `true`, `false` and `null`. */
function parseWord(src: string, pos: number): Parsed {
  let end = pos;
  while (isRegular(src.charCodeAt(end))) end++;
  if (end === pos) return { value: null, end: pos + 1 };
  const word = src.slice(pos, end);
  if (word === 'true') return { value: true, end };
  if (word === 'false') return { value: false, end };
  if (word === 'null') return { value: null, end };
  return { value: { kind: 'keyword', value: word }, end };
}

export function parseValue(src: string, from: number, depth: number): Parsed {
  if (depth > MAX_PDF_PARSE_DEPTH) throw new PdfStructureError('PDF object is nested too deeply.');
  const pos = skipWhite(src, from);
  if (pos >= src.length) return { value: null, end: pos };
  const code = src.charCodeAt(pos);

  if (code === CHAR_LESS && src.charCodeAt(pos + 1) === CHAR_LESS) return parseDictionary(src, pos, depth);
  if (code === CHAR_LEFT_BRACKET) return parseArray(src, pos, depth);
  if (code === CHAR_LEFT_PAREN) {
    const end = endOfLiteralString(src, pos);
    return { value: { kind: 'string', value: src.slice(pos + 1, end - 1) }, end };
  }
  if (code === CHAR_LESS) {
    const close = src.indexOf('>', pos);
    const end = close === -1 ? src.length : close + 1;
    return { value: { kind: 'string', value: src.slice(pos + 1, end - 1) }, end };
  }
  if (code === CHAR_SLASH) {
    let end = pos + 1;
    while (isRegular(src.charCodeAt(end))) end++;
    return { value: { kind: 'name', value: decodeNameEscapes(src.slice(pos + 1, end)) }, end };
  }
  if (isDigit(code) || code === CHAR_PLUS || code === CHAR_MINUS || code === CHAR_DOT) return parseNumberOrReference(src, pos);
  return parseWord(src, pos);
}

export function isName(value: PdfValue | undefined, name?: string): value is PdfName {
  return typeof value === 'object' && value !== null && value.kind === 'name' && (name === undefined || value.value === name);
}
export function isDict(value: PdfValue | undefined): value is PdfDict {
  return typeof value === 'object' && value !== null && value.kind === 'dict';
}
export function isArray(value: PdfValue | undefined): value is PdfArray {
  return typeof value === 'object' && value !== null && value.kind === 'array';
}
export function isRef(value: PdfValue | undefined): value is PdfRef {
  return typeof value === 'object' && value !== null && value.kind === 'ref';
}
