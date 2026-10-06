import { DataParseError } from '../types';
import { positionOf } from './data-json';

/**
 * TOML v1.0.0 rules that smol-toml relaxes (it also reads TOML 1.1), checked in one linear pass
 * before parsing so that a 1.0 document is never silently reinterpreted:
 *
 * - calendar validity of dates (February 29 only in leap years, no February 30 that would roll
 *   into March) and times (hour 0-23, minute 0-59, second 0-60, offset hour 0-23);
 * - seconds are required in times (17:45 is TOML 1.1 only);
 * - no newline and no trailing comma inside an inline table (1.1 allows both);
 * - basic strings accept only the 1.0 escapes \b \t \n \f \r \" \\ \uXXXX \UXXXXXXXX (no \e, \xHH).
 *
 * The scanner skips comments and every kind of string, and checks dates and times only in value
 * position, so a bare key such as 2001-02-03 is not mistaken for a date. Everything else is left
 * to the parser.
 */

type Bracket = '{' | '[' | 'header';

/** Date, optional time and optional offset of an offset/local date-time or local date, at a value start. */
const DATE_TIME = /(\d{4})-(\d{2})-(\d{2})(?:([Tt ])(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[Zz]|[+-](\d{2}):(\d{2}))?)?/y;
/** A local time at a value start. */
const LOCAL_TIME = /(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?/y;
/** Characters that continue a bare key or a number, so a date cannot start right after them. */
const TOKEN_CHAR = /[A-Za-z0-9_.+\-:]/;
const WHITESPACE = new Set([' ', '\t', '\r']);
const SIMPLE_ESCAPES = new Set(['b', 't', 'n', 'f', 'r', '"', '\\']);
const SHORT_UNICODE_DIGITS = 4;
const LONG_UNICODE_DIGITS = 8;
const HEX_DIGITS = /^[0-9A-Fa-f]+$/;
/** Quotes that open and close a multi-line string. */
const MULTILINE_QUOTES = 3;
/** A multi-line string may end with up to two quotes right before its three-quote delimiter. */
const MAX_MULTILINE_CLOSING_QUOTES = 5;

const MAX_MONTH = 12;
const MAX_HOUR = 23;
const MAX_MINUTE = 59;
/** RFC 3339 allows 60 for a leap second. */
const MAX_SECOND = 60;
const FEBRUARY = 2;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const LEAP_DAY_COUNT = 29;
const GREGORIAN_LEAP_EVERY = 4;
const GREGORIAN_CENTURY = 100;
const GREGORIAN_LEAP_CENTURY = 400;

function isLeapYear(year: number): boolean {
  return year % GREGORIAN_LEAP_EVERY === 0 && (year % GREGORIAN_CENTURY !== 0 || year % GREGORIAN_LEAP_CENTURY === 0);
}

function daysInMonth(year: number, month: number): number {
  return month === FEBRUARY && isLeapYear(year) ? LEAP_DAY_COUNT : DAYS_IN_MONTH[month - 1];
}

class Toml10Scanner {
  private pos = 0;
  private readonly stack: Bracket[] = [];
  /** After '=' or inside an array: the next token is a value, not a key. */
  private valueContext = false;
  /** Last character outside whitespace, comments and line breaks (strings count as '"'). */
  private lastSignificant = '';

  constructor(private readonly text: string) {}

  private fail(index: number, reason: string): never {
    const { line, column } = positionOf(this.text, index);
    throw new DataParseError(`TOML parsing failed: ${reason} (TOML 1.0) at line ${line}, column ${column}.`, { line, column });
  }

  scan(): void {
    const { text } = this;
    while (this.pos < text.length) {
      const c = text[this.pos];
      if (c === '#') {
        const end = text.indexOf('\n', this.pos);
        this.pos = end === -1 ? text.length : end;
      } else if (c === '"' || c === "'") {
        this.skipString();
        this.lastSignificant = '"';
      } else if (c === '\n') {
        this.lineBreak();
      } else if (WHITESPACE.has(c)) {
        this.pos++;
      } else {
        this.structural(c);
      }
    }
  }

  private lineBreak(): void {
    if (this.stack[this.stack.length - 1] === '{') this.fail(this.pos, 'a line break inside an inline table is not allowed');
    if (this.stack.length === 0) this.valueContext = false;
    this.pos++;
  }

  private structural(c: string): void {
    const top = this.stack[this.stack.length - 1];
    if (c === '[') {
      this.stack.push(this.valueContext ? '[' : 'header');
    } else if (c === '{') {
      this.stack.push('{');
      this.valueContext = false;
    } else if (c === ']' || c === '}') {
      if (c === '}' && top === '{' && this.lastSignificant === ',') {
        this.fail(this.pos, 'a trailing comma inside an inline table is not allowed');
      }
      this.stack.pop();
      const outer = this.stack[this.stack.length - 1];
      this.valueContext = outer === '[' || (outer === undefined && top !== 'header');
    } else if (c === '=') {
      this.valueContext = true;
    } else if (c === ',') {
      this.valueContext = top === '[';
    } else if (this.valueContext && top !== 'header' && /\d/.test(c) && !TOKEN_CHAR.test(this.text[this.pos - 1] ?? ' ')) {
      if (this.checkTemporal()) return;
    }
    this.lastSignificant = c;
    this.pos++;
  }

  /** Validates a date or time starting here; returns whether one was consumed. */
  private checkTemporal(): boolean {
    DATE_TIME.lastIndex = this.pos;
    const date = DATE_TIME.exec(this.text);
    if (date) {
      const [, year, month, day, separator, hour, minute, second, offsetHour, offsetMinute] = date;
      this.checkDate(Number(year), Number(month), Number(day));
      if (separator !== undefined && hour !== undefined) this.checkTime(hour, minute, second);
      if (offsetHour !== undefined && (Number(offsetHour) > MAX_HOUR || Number(offsetMinute) > MAX_MINUTE)) {
        this.fail(this.pos, 'the time offset is out of range');
      }
      this.advance(date[0]);
      return true;
    }
    LOCAL_TIME.lastIndex = this.pos;
    const time = LOCAL_TIME.exec(this.text);
    if (time) {
      this.checkTime(time[1], time[2], time[3]);
      this.advance(time[0]);
      return true;
    }
    return false;
  }

  private advance(token: string): void {
    this.lastSignificant = token[token.length - 1];
    this.pos += token.length;
  }

  private checkDate(year: number, month: number, day: number): void {
    if (month < 1 || month > MAX_MONTH) this.fail(this.pos, 'the month is out of range');
    if (day < 1 || day > daysInMonth(year, month)) {
      this.fail(this.pos, `${year}-${String(month).padStart(2, '0')} has no day ${day}`);
    }
  }

  private checkTime(hour: string, minute: string, second: string | undefined): void {
    if (second === undefined) this.fail(this.pos, 'a time must include seconds');
    if (Number(hour) > MAX_HOUR || Number(minute) > MAX_MINUTE || Number(second) > MAX_SECOND) {
      this.fail(this.pos, 'the time is out of range');
    }
  }

  private skipString(): void {
    const { text } = this;
    const quote = text[this.pos];
    const delimiter = quote.repeat(MULTILINE_QUOTES);
    const multiline = text.startsWith(delimiter, this.pos);
    this.pos += multiline ? MULTILINE_QUOTES : 1;
    while (this.pos < text.length) {
      const c = text[this.pos];
      if (c === quote && (!multiline || text.startsWith(delimiter, this.pos))) {
        let end = this.pos + (multiline ? MULTILINE_QUOTES : 1);
        while (multiline && text[end] === quote && end - this.pos < MAX_MULTILINE_CLOSING_QUOTES) end++;
        this.pos = end;
        return;
      }
      if (c === '\n' && !multiline) return;
      if (c === '\\' && quote === '"') {
        this.checkEscape(multiline);
        continue;
      }
      this.pos++;
    }
  }

  private checkEscape(multiline: boolean): void {
    const next = this.text[this.pos + 1] ?? '';
    if (SIMPLE_ESCAPES.has(next)) {
      this.pos += 2;
      return;
    }
    if (next === 'u' || next === 'U') {
      const digits = next === 'u' ? SHORT_UNICODE_DIGITS : LONG_UNICODE_DIGITS;
      const hex = this.text.slice(this.pos + 2, this.pos + 2 + digits);
      if (hex.length !== digits || !HEX_DIGITS.test(hex)) this.fail(this.pos, 'malformed unicode escape');
      this.pos += 2 + digits;
      return;
    }
    if (multiline && /[ \t\r\n]/.test(next)) {
      // Line-ending backslash: only whitespace may follow it up to the line break.
      this.pos++;
      return;
    }
    this.fail(this.pos, `the escape \\${next} is not a TOML 1.0 escape`);
  }
}

/** Throws DataParseError when the text uses syntax TOML 1.0 does not allow but smol-toml would accept. */
export function assertToml10Syntax(text: string): void {
  new Toml10Scanner(text).scan();
}
