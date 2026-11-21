import { ConversionFailedError } from '../types';

/**
 * Checks CSS bound for LibreOffice and returns the exact text that was checked. Finds the
 * resources it would load: `url(...)` (quoted or not), strings inside `src()`, `image()`,
 * `image-set()`, `-webkit-image-set()` and `cross-fade()` at any depth, and `@import`.
 *
 * Readers disagree on CSS escapes, control characters and line breaks, so control characters are
 * removed first, line breaks become spaces, every escape outside a comment is decoded as CSS Syntax
 * Level 3 section 4.3.7 says and the text goes on with the decoded characters (an escape that decodes
 * to a character which cannot stand plainly where it is, and a backslash with nothing to escape, are
 * refused, except in the selector of a rule, which is left out with its block and counted; inside a
 * comment a backslash is no escape, and the comment is replaced by a space), and an
 * unterminated string or non-ASCII character outside a quoted string (some readers skip default-ignorable
 * and separator characters, so `u<U+200B>rl(` still reads as url( to them) is refused;
 * comments and `<!--`/`-->` markers become spaces in the returned text, so what LibreOffice reads
 * is what was scanned. Follows the CSS Syntax tokenizer
 * for the parts that matter in one forward pass, so the work is linear in the input.
 */

const NON_ASCII = 0x80;
const URL_FUNCTION = 'url';
const IMPORT_RULE = 'import';
/** Functions whose string arguments are URLs. */
const URL_STRING_FUNCTIONS: ReadonlySet<string> = new Set(['url', 'src', 'image', 'image-set', '-webkit-image-set', 'cross-fade']);
/** Openers of nested groups and the character that closes each. */
const GROUP_CLOSERS: ReadonlyMap<string, string> = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);
const GROUP_ENDS: ReadonlySet<string> = new Set([')', ']', '}']);
/** C0 controls other than tab, line feed, form feed and carriage return, and DEL. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g;
/** Line breaks, which some readers drop inside CSS (joining `ur` and `l(`): they become spaces before the scan. */
const LINE_BREAKS = /[\n\r\f]/g;
const COMMENT_OPEN = '/*';
const COMMENT_CLOSE = '*/';
const CDO = '<!--';
const CDC = '-->';
const BACKSLASH = '\\';
/**
 * What a quoted CSS string may hold: assigned, printable characters (letters, numbers, marks,
 * punctuation, symbols, spaces). Unassigned code points and noncharacters (U+FDD0-FDEF, U+FFFE,
 * U+FFFF) fail it.
 */
const PRINTABLE_STRING = /^[\p{L}\p{N}\p{M}\p{P}\p{S}\p{Zs}]*$/u;
/** UTF-16 surrogates: any character outside the Basic Multilingual Plane, or a lone surrogate. */
const SURROGATE = /[\uD800-\uDFFF]/;
const MARKUP_OPEN = '<';
const IMPORT_REFERENCE = '@import';
const EMPTY_URL_REFERENCE = 'url()';

const MAX_CODE_POINT = 0x10ffff;
const REPLACEMENT_CHARACTER = 0xfffd;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;
const HEX_RADIX = 16;
/** The longest run of hex digits an escape holds after its first one (1 to 6 in all). */
const HEX_DIGITS_AFTER_FIRST = 5;
const HEX_DIGIT = /^[0-9A-Fa-f]$/;
/** What an identifier is made of; an escape outside a quoted string may only stand for one of these. */
const PLAIN_NAME_CHARACTER = /^[A-Za-z0-9_-]$/;
/** Characters an escape may not produce inside a string: they would end it or open markup or a character reference. */
const UNWRITABLE_IN_STRING: ReadonlySet<string> = new Set([BACKSLASH, MARKUP_OPEN, '&']);

function isHexDigit(ch: string | undefined): boolean {
  return ch !== undefined && HEX_DIGIT.test(ch);
}

/*
 * `consumeEscaped` and `decodeEscaped` follow csstree/csstree (`lib/tokenizer/utils.js` at commit f8980154f79110833bf56c391cd45fe5f9205752, SHA-256
 * 2c0087a12707b22eae4bc44dd338a8682838663872b2240387c5979ae76d44bb), which implement CSS Syntax Level 3, section 4.3.7. MIT licence:
 *
 * Copyright (C) 2016-2026 by Roman Dvornov
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

/**
 * CSS Syntax 4.3.7 "consume an escaped code point": the index after the escape whose backslash is at `at` (up to six hex digits, and one
 * whitespace after them). The next character is known to exist.
 */
function consumeEscaped(css: string, at: number): number {
  let offset = at + 2;
  if (isHexDigit(css[offset - 1])) {
    for (const maxOffset = Math.min(css.length, offset + HEX_DIGITS_AFTER_FIRST); offset < maxOffset && isHexDigit(css[offset]); offset++);
    if (isWhitespace(css[offset])) offset++;
  }
  return offset;
}

/** The character an escape stands for, given the text after its backslash: zero, a surrogate and anything past U+10FFFF are U+FFFD. */
function decodeEscaped(escaped: string): string {
  if (!isHexDigit(escaped[0])) return escaped;
  let code = Number.parseInt(escaped, HEX_RADIX);
  if (code === 0 || (code >= SURROGATE_FIRST && code <= SURROGATE_LAST) || code > MAX_CODE_POINT) code = REPLACEMENT_CHARACTER;
  return String.fromCodePoint(code);
}

/** The character an escape at `at` (the backslash) stands for and the index after it; null for a backslash that ends the text. */
function readEscape(css: string, at: number): { character: string; end: number } | null {
  if (at + 1 >= css.length) return null;
  // A character past the Basic Multilingual Plane is two UTF-16 units and stands for itself.
  const end = isHexDigit(css[at + 1]) ? consumeEscaped(css, at) : at + 1 + String.fromCodePoint(css.codePointAt(at + 1) as number).length;
  return { character: decodeEscaped(css.slice(at + 1, end)), end };
}

/**
 * Writes the CSS with every escape outside a comment replaced by the character it stands for, so the scan below reads what a reader
 * that follows CSS Syntax reads and the text handed on has no escape left for a reader that does not. Inside a quoted string any
 * printable character is written as it is except the quote, a backslash, "<" and "&"; outside one only the characters of a name are,
 * because any other would change how the text is cut into tokens. A comment is left as it is (the scan below replaces it with a space).
 */
function decodeEscapes(css: string): string {
  if (!css.includes(BACKSLASH)) return css;
  const parts: string[] = [];
  let copiedTo = 0;
  let quote: string | null = null;
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === BACKSLASH) {
      const escape = readEscape(css, i);
      if (escape === null) break;
      if (quote !== null ? escape.character === quote || UNWRITABLE_IN_STRING.has(escape.character) : !PLAIN_NAME_CHARACTER.test(escape.character)) {
        refuseEscapedCharacter(escape.character, quote !== null);
      }
      parts.push(css.slice(copiedTo, i), escape.character);
      copiedTo = escape.end;
      i = escape.end;
    } else if (quote === null && css.startsWith(COMMENT_OPEN, i)) {
      const close = css.indexOf(COMMENT_CLOSE, i + COMMENT_OPEN.length);
      i = close < 0 ? css.length : close + COMMENT_CLOSE.length;
    } else {
      if (ch === quote) quote = null;
      else if (quote === null && (ch === '"' || ch === "'")) quote = ch;
      i++;
    }
  }
  return parts.join('') + css.slice(copiedTo);
}

/** The closing brace of the block whose opening brace is at `open`, skipping strings, comments and escapes; the length of `css` when there is none. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (ch === BACKSLASH) {
      i = (readEscape(css, i)?.end ?? css.length) - 1;
    } else if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (css.startsWith(COMMENT_OPEN, i)) {
      const close = css.indexOf(COMMENT_CLOSE, i + COMMENT_OPEN.length);
      i = close < 0 ? css.length : close + COMMENT_CLOSE.length - 1;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return i;
    }
  }
  return css.length;
}

/**
 * Leaves out every rule whose selector (the text before its block, outside strings, comments and groups) holds an escape for a character
 * that cannot stand plainly outside a string, block included, and counts them. Such a rule (`.sm\:flex`, `.w-1\/2`) cannot be written as it
 * is (LibreOffice would read the text the scan did not) or as decoded (the selector would be another one), and LibreOffice cannot match it
 * either. Rules inside a block that is kept are found too, so a rule in an `@media` goes alone. The text that stays is scanned as any other,
 * so nothing in it is vouched for by this step; an escape in a declaration is still refused by `decodeEscapes`. One pass over the text.
 */
function omitEscapedSelectors(css: string): { css: string; omitted: number } {
  if (!css.includes(BACKSLASH)) return { css, omitted: 0 };
  const parts: string[] = [];
  let copiedTo = 0;
  let omitted = 0;
  let itemStart = 0;
  let escapedSymbol = false;
  let groups = 0;
  let quote: string | null = null;
  let i = 0;
  const nextItem = (at: number): void => {
    itemStart = at;
    escapedSymbol = false;
    groups = 0;
  };
  while (i < css.length) {
    const ch = css[i];
    if (ch === BACKSLASH) {
      const escape = readEscape(css, i);
      if (escape === null) break;
      if (quote === null && !PLAIN_NAME_CHARACTER.test(escape.character)) escapedSymbol = true;
      i = escape.end;
    } else if (quote !== null) {
      if (ch === quote) quote = null;
      i++;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
    } else if (css.startsWith(COMMENT_OPEN, i)) {
      const close = css.indexOf(COMMENT_CLOSE, i + COMMENT_OPEN.length);
      i = close < 0 ? css.length : close + COMMENT_CLOSE.length;
    } else if (ch === '(' || ch === '[') {
      groups++;
      i++;
    } else if (ch === ')' || ch === ']') {
      groups = Math.max(0, groups - 1);
      i++;
    } else if (ch === '{' && groups === 0 && escapedSymbol) {
      const end = Math.min(blockEnd(css, i) + 1, css.length);
      parts.push(css.slice(copiedTo, itemStart));
      copiedTo = end;
      omitted++;
      i = end;
      nextItem(i);
    } else if (groups === 0 && (ch === '{' || ch === '}' || ch === ';')) {
      i++;
      nextItem(i);
    } else {
      i++;
    }
  }
  return { css: parts.join('') + css.slice(copiedTo), omitted };
}

export interface CssScan {
  /** The CSS without control characters, with comments and CDO/CDC markers as spaces: the text checked. */
  readonly css: string;
  /** The first URL the CSS would load that is not allowed (anything an `@import` names), or null. */
  readonly reference: string | null;
  /** How many rules were left out for an escaped symbol in their selector. */
  readonly omittedRules: number;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isNameStart(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Za-z_]$/.test(ch);
}

function isNonAscii(ch: string): boolean {
  return ch.charCodeAt(0) >= NON_ASCII;
}

function refuseNonAscii(): never {
  throw new ConversionFailedError('HTML CSS may contain non-ASCII characters only inside quoted strings');
}

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && (isNameStart(ch) || /^[0-9-]$/.test(ch));
}

function startsIdentifier(css: string, i: number): boolean {
  if (css[i] === '-') return isNameStart(css[i + 1]) || css[i + 1] === '-';
  return isNameStart(css[i]);
}

function lowerAscii(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

function refuseEscape(): never {
  throw new ConversionFailedError('HTML CSS has a backslash with nothing to escape');
}

function refuseEscapedCharacter(character: string, inString: boolean): never {
  const code = (character.codePointAt(0) as number).toString(16).toUpperCase();
  throw new ConversionFailedError(
    `HTML CSS has an escape for U+${code}, which cannot be written without the escape ${inString ? 'inside a quoted string' : 'outside a quoted string'}`
  );
}

function refuseMarkup(): never {
  throw new ConversionFailedError('HTML CSS may not contain "<" outside a <!-- --> marker');
}

type CssToken = { kind: 'url' | 'function' | 'open' | 'close' | 'string' | 'at' | 'other'; value: string };

class CssScanner {
  private i = 0;
  private copiedTo = 0;
  private readonly kept: string[] = [];

  constructor(private readonly css: string) {}

  get done(): boolean {
    return this.i >= this.css.length;
  }

  /** The scanned text with every skipped comment or marker replaced by one space. */
  text(): string {
    return this.kept.join('') + this.css.slice(this.copiedTo);
  }

  private replaceWithSpace(start: number, end: number): void {
    this.kept.push(this.css.slice(this.copiedTo, start), ' ');
    this.copiedTo = end;
  }

  /** Skips whitespace, comments and CDO/CDC markers. */
  skipInsignificant(): void {
    const css = this.css;
    while (this.i < css.length) {
      const start = this.i;
      if (isWhitespace(css[start])) {
        this.i++;
      } else if (css.startsWith(COMMENT_OPEN, start)) {
        const close = css.indexOf(COMMENT_CLOSE, start + COMMENT_OPEN.length);
        this.i = close < 0 ? css.length : close + COMMENT_CLOSE.length;
        this.replaceWithSpace(start, this.i);
      } else if (css.startsWith(CDO, start) || css.startsWith(CDC, start)) {
        this.i = start + (css[start] === MARKUP_OPEN ? CDO.length : CDC.length);
        this.replaceWithSpace(start, this.i);
      } else {
        return;
      }
    }
  }

  private identifier(): string {
    const start = this.i;
    while (this.i < this.css.length && isNameChar(this.css[this.i])) this.i++;
    return this.css.slice(start, this.i);
  }

  /**
   * A string token; the opening quote is at the current index. An unterminated string is refused,
   * and so is any character outside the printable Basic Multilingual Plane: some readers swallow
   * the character after U+FFFF or after a supplementary code point whose low 16 bits are below
   * 0x20, which would move the closing quote.
   */
  private string(): string {
    const css = this.css;
    const quote = css[this.i++];
    const start = this.i;
    while (this.i < css.length && css[this.i] !== quote) {
      if (css[this.i] === MARKUP_OPEN) refuseMarkup();
      if (css[this.i] === BACKSLASH) refuseEscape();
      this.i++;
    }
    if (this.i >= css.length) throw new ConversionFailedError('HTML CSS has an unterminated string');
    const value = css.slice(start, this.i++);
    if (SURROGATE.test(value) || !PRINTABLE_STRING.test(value)) {
      throw new ConversionFailedError('HTML CSS strings may contain only printable Basic Multilingual Plane characters');
    }
    return value;
  }

  /** The value of an unquoted url( token; the index is just after `url(` and any whitespace. */
  private unquotedUrl(): string {
    const css = this.css;
    const start = this.i;
    while (this.i < css.length && css[this.i] !== ')' && !isWhitespace(css[this.i])) {
      const ch = css[this.i];
      if (ch === MARKUP_OPEN) refuseMarkup();
      if (ch === BACKSLASH) refuseEscape();
      if (isNonAscii(ch)) refuseNonAscii();
      if (ch === '"' || ch === "'" || ch === '(') throw new ConversionFailedError('HTML CSS has a malformed url()');
      this.i++;
    }
    const value = css.slice(start, this.i);
    while (isWhitespace(css[this.i])) this.i++;
    if (this.i < css.length && css[this.i] !== ')') throw new ConversionFailedError('HTML CSS has a malformed url()');
    this.i++;
    return value;
  }

  /** The next significant token. */
  next(): CssToken {
    const css = this.css;
    const ch = css[this.i];
    if (ch === '"' || ch === "'") return { kind: 'string', value: this.string() };
    if (GROUP_CLOSERS.has(ch)) {
      this.i++;
      return { kind: 'open', value: ch };
    }
    if (GROUP_ENDS.has(ch)) {
      this.i++;
      return { kind: 'close', value: ch };
    }
    if (ch === MARKUP_OPEN) refuseMarkup();
    if (ch === BACKSLASH) refuseEscape();
    if (isNonAscii(ch)) refuseNonAscii();
    if (ch === '@') {
      if (!startsIdentifier(css, this.i + 1)) {
        throw new ConversionFailedError('HTML CSS may not contain "@" unless followed directly by an at-rule name');
      }
      this.i++;
      return { kind: 'at', value: lowerAscii(this.identifier()) };
    }
    if (startsIdentifier(css, this.i)) {
      const name = lowerAscii(this.identifier());
      if (css[this.i] !== '(') return { kind: 'other', value: name };
      this.i++;
      if (name === URL_FUNCTION) {
        while (isWhitespace(css[this.i])) this.i++;
        // url( followed by a quote is a function whose string argument is the URL.
        if (css[this.i] !== '"' && css[this.i] !== "'") return { kind: 'url', value: this.unquotedUrl() };
      }
      return { kind: 'function', value: name };
    }
    this.i++;
    return { kind: 'other', value: ch };
  }
}

/**
 * Scans CSS for the resources it would load, after leaving out the rules with an escaped symbol in the selector. Throws ConversionFailedError for an escape that cannot be written plainly, a
 * backslash with nothing to escape, a stray "<" or a malformed url(); returns the checked text and the first URL `isAllowedUrl`
 * rejects (an `@import` is always reported, whatever it names).
 */
export function scanCss(source: string, isAllowedUrl: (url: string) => boolean): CssScan {
  const kept = omitEscapedSelectors(source.replace(CONTROL_CHARACTERS, '').replace(LINE_BREAKS, ' '));
  const omittedRules = kept.omitted;
  const css = decodeEscapes(kept.css);
  const scanner = new CssScanner(css);
  /** Closing characters of the open groups and functions, and whether each is a URL function. */
  const groups: Array<{ closer: string; url: boolean }> = [];
  let urlGroups = 0;
  let importPending = false;
  for (scanner.skipInsignificant(); !scanner.done; scanner.skipInsignificant()) {
    const token = scanner.next();
    const isUrl = token.kind === 'url' || (token.kind === 'string' && (urlGroups > 0 || importPending));
    if (isUrl && (importPending || !isAllowedUrl(token.value.trim()))) {
      return { css, reference: token.value.trim() || (importPending ? IMPORT_REFERENCE : EMPTY_URL_REFERENCE), omittedRules };
    }
    if (importPending && !(token.kind === 'function' && token.value === URL_FUNCTION)) {
      return { css, reference: IMPORT_REFERENCE, omittedRules };
    }
    if (token.kind === 'function' || token.kind === 'open') {
      const url = token.kind === 'function' && URL_STRING_FUNCTIONS.has(token.value);
      groups.push({ closer: token.kind === 'function' ? ')' : (GROUP_CLOSERS.get(token.value) as string), url });
      if (url) urlGroups++;
    } else if (token.kind === 'close' && groups.length > 0 && groups[groups.length - 1].closer === token.value) {
      if ((groups.pop() as { url: boolean }).url) urlGroups--;
    }
    importPending = token.kind === 'at' ? token.value === IMPORT_RULE : importPending;
  }
  if (importPending) return { css, reference: IMPORT_REFERENCE, omittedRules };
  return { css: scanner.text(), reference: null, omittedRules };
}
