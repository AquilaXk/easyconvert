import { DataLimitExceededError, DataParseError, DataRepresentationError } from '../types';

/**
 * Values exchanged between the structured-data readers and writers (JSON, NDJSON, YAML, TOML,
 * XML records). Integers outside the IEEE 754 safe range are BigInt, so they survive every
 * conversion exactly; every other number is a double, as in JSON.parse.
 */
export type DataValue = null | boolean | number | bigint | string | DataValue[] | DataObject;
export interface DataObject {
  [key: string]: DataValue;
}

/** Deepest array/object nesting accepted from any structured-data input. */
export const MAX_DATA_NESTING_DEPTH = 512;

const NEWLINE = 0x0a;

export function isDataObject(value: unknown): value is DataObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own-property assignment that also stores a "__proto__" key as data. */
export function setOwn(target: DataObject, key: string, value: DataValue): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

export function positionOf(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === NEWLINE) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

// ---------------------------------------------------------------------------
// Reader (RFC 8259)
// ---------------------------------------------------------------------------

const CHAR = {
  tab: 0x09,
  lineFeed: 0x0a,
  carriageReturn: 0x0d,
  space: 0x20,
  quote: 0x22,
  plus: 0x2b,
  comma: 0x2c,
  minus: 0x2d,
  dot: 0x2e,
  zero: 0x30,
  nine: 0x39,
  colon: 0x3a,
  upperE: 0x45,
  openBracket: 0x5b,
  backslash: 0x5c,
  closeBracket: 0x5d,
  lowerE: 0x65,
  openBrace: 0x7b,
  closeBrace: 0x7d,
} as const;
const FIRST_PRINTABLE = 0x20;
const HEX_DIGITS_PER_ESCAPE = 4;
const HEX_RADIX = 16;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};
const HEX_ESCAPE = /^[0-9a-fA-F]{4}$/;

class LosslessJsonReader {
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly label: string,
    private readonly firstLine: number
  ) {}

  readDocument(): DataValue {
    this.skipWhitespace();
    const value = this.readValue(0);
    this.skipWhitespace();
    if (this.pos < this.text.length) this.fail('unexpected data after the JSON value');
    return value;
  }

  private fail(reason: string): never {
    const position = positionOf(this.text, this.pos);
    const line = position.line + this.firstLine - 1;
    throw new DataParseError(`${this.label} parsing failed: ${reason} at line ${line}, column ${position.column}.`, {
      line,
      column: position.column,
    });
  }

  private skipWhitespace(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c !== CHAR.space && c !== CHAR.tab && c !== CHAR.lineFeed && c !== CHAR.carriageReturn) return;
      this.pos++;
    }
  }

  private readValue(depth: number): DataValue {
    const c = this.text.charCodeAt(this.pos);
    if (c === CHAR.openBrace) return this.readObject(depth + 1);
    if (c === CHAR.openBracket) return this.readArray(depth + 1);
    if (c === CHAR.quote) return this.readString();
    if (c === CHAR.minus || (c >= CHAR.zero && c <= CHAR.nine)) return this.readNumber();
    if (this.text.startsWith('true', this.pos)) {
      this.pos += 'true'.length;
      return true;
    }
    if (this.text.startsWith('false', this.pos)) {
      this.pos += 'false'.length;
      return false;
    }
    if (this.text.startsWith('null', this.pos)) {
      this.pos += 'null'.length;
      return null;
    }
    if (Number.isNaN(c)) this.fail('unexpected end of input');
    this.fail(`unexpected character ${JSON.stringify(this.text[this.pos])}`);
  }

  private enter(depth: number): void {
    if (depth > MAX_DATA_NESTING_DEPTH) {
      throw new DataLimitExceededError(`${this.label} nesting exceeds ${MAX_DATA_NESTING_DEPTH} levels.`);
    }
    this.pos++;
    this.skipWhitespace();
  }

  private readObject(depth: number): DataObject {
    this.enter(depth);
    const result: DataObject = {};
    if (this.text.charCodeAt(this.pos) === CHAR.closeBrace) {
      this.pos++;
      return result;
    }
    for (;;) {
      if (this.text.charCodeAt(this.pos) !== CHAR.quote) this.fail('expected a string key');
      const key = this.readString();
      this.skipWhitespace();
      if (this.text.charCodeAt(this.pos) !== CHAR.colon) this.fail("expected ':' after the key");
      this.pos++;
      this.skipWhitespace();
      setOwn(result, key, this.readValue(depth));
      this.skipWhitespace();
      const c = this.text.charCodeAt(this.pos);
      if (c === CHAR.closeBrace) {
        this.pos++;
        return result;
      }
      if (c !== CHAR.comma) this.fail("expected ',' or '}'");
      this.pos++;
      this.skipWhitespace();
    }
  }

  private readArray(depth: number): DataValue[] {
    this.enter(depth);
    const result: DataValue[] = [];
    if (this.text.charCodeAt(this.pos) === CHAR.closeBracket) {
      this.pos++;
      return result;
    }
    for (;;) {
      result.push(this.readValue(depth));
      this.skipWhitespace();
      const c = this.text.charCodeAt(this.pos);
      if (c === CHAR.closeBracket) {
        this.pos++;
        return result;
      }
      if (c !== CHAR.comma) this.fail("expected ',' or ']'");
      this.pos++;
      this.skipWhitespace();
    }
  }

  private readString(): string {
    this.pos++;
    let out = '';
    let chunkStart = this.pos;
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c === CHAR.quote) {
        out += this.text.slice(chunkStart, this.pos);
        this.pos++;
        return out;
      }
      if (Number.isNaN(c)) this.fail('unterminated string');
      if (c < FIRST_PRINTABLE) this.fail('control character in string');
      if (c !== CHAR.backslash) {
        this.pos++;
        continue;
      }
      out += this.text.slice(chunkStart, this.pos);
      const escape = this.text[this.pos + 1];
      if (escape === 'u') {
        const hex = this.text.slice(this.pos + 2, this.pos + 2 + HEX_DIGITS_PER_ESCAPE);
        if (!HEX_ESCAPE.test(hex)) this.fail('invalid \\u escape');
        out += String.fromCharCode(parseInt(hex, HEX_RADIX));
        this.pos += 2 + HEX_DIGITS_PER_ESCAPE;
      } else if (escape !== undefined && escape in SIMPLE_ESCAPES) {
        out += SIMPLE_ESCAPES[escape];
        this.pos += 2;
      } else {
        this.fail('invalid escape sequence');
      }
      chunkStart = this.pos;
    }
  }

  private readDigits(): number {
    const start = this.pos;
    while (this.text.charCodeAt(this.pos) >= CHAR.zero && this.text.charCodeAt(this.pos) <= CHAR.nine) this.pos++;
    return this.pos - start;
  }

  private readNumber(): number | bigint {
    const start = this.pos;
    if (this.text.charCodeAt(this.pos) === CHAR.minus) this.pos++;
    if (this.text.charCodeAt(this.pos) === CHAR.zero) {
      this.pos++;
    } else if (this.readDigits() === 0) {
      this.fail('invalid number');
    }
    let integer = true;
    if (this.text.charCodeAt(this.pos) === CHAR.dot) {
      this.pos++;
      if (this.readDigits() === 0) this.fail('expected digits after the decimal point');
      integer = false;
    }
    const e = this.text.charCodeAt(this.pos);
    if (e === CHAR.lowerE || e === CHAR.upperE) {
      this.pos++;
      const sign = this.text.charCodeAt(this.pos);
      if (sign === CHAR.plus || sign === CHAR.minus) this.pos++;
      if (this.readDigits() === 0) this.fail('expected digits in the exponent');
      integer = false;
    }
    const literal = this.text.slice(start, this.pos);
    const value = Number(literal);
    if (integer) {
      return Number.isSafeInteger(value) ? value : BigInt(literal);
    }
    if (!Number.isFinite(value)) {
      throw new DataRepresentationError(
        `${this.label} number ${literal} is outside the IEEE 754 double range and cannot be represented.`
      );
    }
    return value;
  }
}

/**
 * Parses RFC 8259 JSON without losing integers: an integer literal (no fraction or exponent)
 * beyond the safe range becomes a BigInt. Syntax errors throw DataParseError with the line
 * (counted from `firstLine`) and column, nesting beyond MAX_DATA_NESTING_DEPTH throws
 * DataLimitExceededError.
 */
export function parseJsonLossless(text: string, label = 'JSON', firstLine = 1): DataValue {
  return new LosslessJsonReader(text, label, firstLine).readDocument();
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function numberLiteral(value: number): string {
  if (!Number.isFinite(value)) {
    throw new DataRepresentationError(`JSON cannot represent the number ${value}.`);
  }
  return Object.is(value, -0) ? '-0' : String(value);
}

/** Whether JSON.stringify would write this scalar differently from the lossless writer. */
function needsLosslessScalar(value: DataValue): boolean {
  if (typeof value === 'bigint') return true;
  return typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0));
}

/**
 * Containers that hold, at any depth, a value JSON.stringify cannot write faithfully (a BigInt,
 * -0 or a non-finite number). Every other container is written by JSON.stringify itself.
 */
function containersNeedingLosslessWrite(root: DataValue): Set<object> {
  const marked = new Set<object>();
  const visit = (value: DataValue, depth: number): boolean => {
    if (value === null || typeof value !== 'object') return needsLosslessScalar(value);
    if (depth > MAX_DATA_NESTING_DEPTH) {
      throw new DataLimitExceededError(`Data nesting exceeds ${MAX_DATA_NESTING_DEPTH} levels.`);
    }
    let needed = false;
    const children: DataValue[] = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      if (visit(child, depth + 1)) needed = true;
    }
    if (needed) marked.add(value);
    return needed;
  };
  visit(root, 0);
  return marked;
}

class LosslessJsonWriter {
  private readonly out: string[] = [];

  constructor(
    private readonly indent: string,
    private readonly lossless: Set<object>
  ) {}

  write(value: DataValue, prefix: string): void {
    if (value === null || typeof value !== 'object') {
      this.out.push(this.scalar(value));
      return;
    }
    if (!this.lossless.has(value)) {
      const text = JSON.stringify(value, null, this.indent);
      // JSON text never holds a raw line break inside a string, so every newline is indentation.
      this.out.push(this.indent && prefix ? text.replace(/\n/g, `\n${prefix}`) : text);
      return;
    }
    const keys = Array.isArray(value) ? null : Object.keys(value);
    const items: DataValue[] = Array.isArray(value) ? value : Object.values(value);
    const [open, close] = keys ? ['{', '}'] : ['[', ']'];
    if (items.length === 0) {
      this.out.push(open, close);
      return;
    }
    const inner = prefix + this.indent;
    this.out.push(open);
    items.forEach((item, index) => {
      if (index > 0) this.out.push(',');
      if (this.indent) this.out.push('\n', inner);
      if (keys) this.out.push(JSON.stringify(keys[index]), this.indent ? ': ' : ':');
      this.write(item, inner);
    });
    if (this.indent) this.out.push('\n', prefix);
    this.out.push(close);
  }

  private scalar(value: DataValue): string {
    if (typeof value === 'number') return numberLiteral(value);
    if (typeof value === 'bigint') return value.toString();
    return JSON.stringify(value);
  }

  text(): string {
    return this.out.join('');
  }
}

/**
 * Serializes like JSON.stringify(value, null, indent), but writes BigInt integers as exact
 * literals, keeps -0, and refuses non-finite numbers instead of turning them into null.
 */
export function stringifyJsonLossless(value: DataValue, indent = 0): string {
  const writer = new LosslessJsonWriter(' '.repeat(indent), containersNeedingLosslessWrite(value));
  writer.write(value, '');
  return writer.text();
}

// ---------------------------------------------------------------------------
// Normalization of values produced by other readers
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  /** Most values the result may hold; aliases that share a subtree count once per occurrence. */
  maxValues: number;
  /** Source description used in error messages, e.g. "YAML document". */
  label: string;
}

/**
 * Copies a reader's output into a fresh DataValue tree: safe-range BigInts become numbers,
 * dates become their ISO text, null-prototype objects become plain objects. A value that
 * contains itself, nests deeper than MAX_DATA_NESTING_DEPTH or expands past `maxValues`
 * throws DataLimitExceededError; a value of any other type throws DataRepresentationError.
 */
export function normalizeDataValue(input: unknown, options: NormalizeOptions): DataValue {
  const ancestors = new Set<object>();
  let produced = 0;

  const visit = (value: unknown, depth: number): DataValue => {
    produced++;
    if (produced > options.maxValues) {
      throw new DataLimitExceededError(`${options.label} expands to more than ${options.maxValues} values.`);
    }
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
    if (typeof value === 'bigint') {
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new DataRepresentationError(`${options.label} contains an invalid date.`);
      return value.toISOString();
    }
    if (typeof value !== 'object') {
      throw new DataRepresentationError(`${options.label} contains a value of unsupported type ${typeof value}.`);
    }
    if (depth >= MAX_DATA_NESTING_DEPTH) {
      throw new DataLimitExceededError(`${options.label} nesting exceeds ${MAX_DATA_NESTING_DEPTH} levels.`);
    }
    if (ancestors.has(value)) {
      throw new DataLimitExceededError(`${options.label} refers to itself and expands without bound.`);
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new DataRepresentationError(`${options.label} contains an unsupported ${value.constructor?.name ?? 'object'} value.`);
      }
      const result: DataObject = {};
      for (const key of Object.keys(value)) {
        setOwn(result, key, visit((value as Record<string, unknown>)[key], depth + 1));
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };

  return visit(input, 0);
}
