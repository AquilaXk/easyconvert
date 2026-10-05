import { ConversionFailedError } from '../types';

/**
 * Checks CSS bound for LibreOffice and returns the exact text that was checked. Finds the
 * resources it would load: `url(...)` (quoted or not), strings inside `src()`, `image()`,
 * `image-set()`, `-webkit-image-set()` and `cross-fade()` at any depth, and `@import`.
 *
 * Readers disagree on CSS escapes, control characters and line breaks, so control characters are
 * removed first, line breaks become spaces, and any backslash, unterminated string or non-ASCII
 * character outside a quoted string (some readers skip default-ignorable and separator characters,
 * so `u<U+200B>rl(` still reads as url( to them) is refused;
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

export interface CssScan {
  /** The CSS without control characters, with comments and CDO/CDC markers as spaces: the text checked. */
  readonly css: string;
  /** The first URL the CSS would load that is not allowed (anything an `@import` names), or null. */
  readonly reference: string | null;
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
    if (isNonAscii(ch)) refuseNonAscii();
    if (ch === '@' && startsIdentifier(css, this.i + 1)) {
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
 * Scans CSS for the resources it would load. Throws ConversionFailedError for a backslash, a
 * stray "<" or a malformed url(); returns the checked text and the first URL `isAllowedUrl`
 * rejects (an `@import` is always reported, whatever it names).
 */
export function scanCss(source: string, isAllowedUrl: (url: string) => boolean): CssScan {
  const css = source.replace(CONTROL_CHARACTERS, '').replace(LINE_BREAKS, ' ');
  if (css.includes(BACKSLASH)) {
    throw new ConversionFailedError('HTML CSS with a backslash escape is not supported; CSS readers disagree on escapes');
  }
  const scanner = new CssScanner(css);
  /** Closing characters of the open groups and functions, and whether each is a URL function. */
  const groups: Array<{ closer: string; url: boolean }> = [];
  let urlGroups = 0;
  let importPending = false;
  for (scanner.skipInsignificant(); !scanner.done; scanner.skipInsignificant()) {
    const token = scanner.next();
    const isUrl = token.kind === 'url' || (token.kind === 'string' && (urlGroups > 0 || importPending));
    if (isUrl && (importPending || !isAllowedUrl(token.value.trim()))) {
      return { css, reference: token.value.trim() || (importPending ? IMPORT_REFERENCE : EMPTY_URL_REFERENCE) };
    }
    if (importPending && !(token.kind === 'function' && token.value === URL_FUNCTION)) {
      return { css, reference: IMPORT_REFERENCE };
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
  if (importPending) return { css, reference: IMPORT_REFERENCE };
  return { css: scanner.text(), reference: null };
}
