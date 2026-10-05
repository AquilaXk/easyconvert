/**
 * Finds the resources CSS would load: `url(...)` (quoted or not), strings inside `src()`,
 * `image-set()` and `-webkit-image-set()`, and `@import "..."`. Follows the CSS Syntax tokenizer
 * for the parts that matter (comments, strings, escapes such as `\75 rl(`, case-insensitive
 * names) in one forward pass, so the work is linear in the input; no backtracking pattern runs.
 */

const HEX_RADIX = 16;
const MAX_HEX_ESCAPE_DIGITS = 6;
const MAX_CODE_POINT = 0x10ffff;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;
const REPLACEMENT_CHARACTER = '�';
const NON_ASCII = 0x80;
const URL_FUNCTION = 'url';
const IMPORT_RULE = 'import';
/** Functions whose string arguments are URLs. */
const URL_STRING_FUNCTIONS: ReadonlySet<string> = new Set(['url', 'src', 'image-set', '-webkit-image-set']);
const DATA_URI = /^data:/i;

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isHexDigit(ch: string | undefined): boolean {
  return ch !== undefined && /^[0-9a-fA-F]$/.test(ch);
}

function isNameStart(ch: string | undefined): boolean {
  return ch !== undefined && (/^[A-Za-z_]$/.test(ch) || ch.charCodeAt(0) >= NON_ASCII);
}

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && (isNameStart(ch) || /^[0-9-]$/.test(ch));
}

/** A valid escape starts at `i`: a backslash not followed by a newline. */
function startsEscape(css: string, i: number): boolean {
  return css[i] === '\\' && i + 1 < css.length && css[i + 1] !== '\n' && css[i + 1] !== '\r' && css[i + 1] !== '\f';
}

function startsIdentifier(css: string, i: number): boolean {
  if (css[i] === '-') return isNameStart(css[i + 1]) || css[i + 1] === '-' || startsEscape(css, i + 1);
  return isNameStart(css[i]) || startsEscape(css, i);
}

function lowerAscii(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

class CssScanner {
  private i = 0;

  constructor(private readonly css: string) {}

  get done(): boolean {
    return this.i >= this.css.length;
  }

  /** Consumes an escape (the backslash is at the current index) and returns the character it stands for. */
  private escape(): string {
    this.i++;
    const css = this.css;
    if (!isHexDigit(css[this.i])) return css[this.i++] ?? REPLACEMENT_CHARACTER;
    const start = this.i;
    while (this.i - start < MAX_HEX_ESCAPE_DIGITS && isHexDigit(css[this.i])) this.i++;
    const value = Number.parseInt(css.slice(start, this.i), HEX_RADIX);
    if (css[this.i] === '\r' && css[this.i + 1] === '\n') this.i += 2;
    else if (isWhitespace(css[this.i])) this.i++;
    const invalid = value === 0 || value > MAX_CODE_POINT || (value >= SURROGATE_FIRST && value <= SURROGATE_LAST);
    return invalid ? REPLACEMENT_CHARACTER : String.fromCodePoint(value);
  }

  /** Skips whitespace and comments. */
  skipInsignificant(): void {
    const css = this.css;
    while (this.i < css.length) {
      if (isWhitespace(css[this.i])) {
        this.i++;
      } else if (css[this.i] === '/' && css[this.i + 1] === '*') {
        const close = css.indexOf('*/', this.i + 2);
        this.i = close < 0 ? css.length : close + 2;
      } else {
        return;
      }
    }
  }

  private identifier(): string {
    let name = '';
    while (this.i < this.css.length) {
      if (isNameChar(this.css[this.i])) name += this.css[this.i++];
      else if (startsEscape(this.css, this.i)) name += this.escape();
      else break;
    }
    return name;
  }

  /** A string token; the opening quote is at the current index. */
  private string(): string {
    const css = this.css;
    const quote = css[this.i++];
    let value = '';
    while (this.i < css.length && css[this.i] !== quote) {
      const ch = css[this.i];
      if (ch === '\n' || ch === '\r' || ch === '\f') break;
      if (ch === '\\') {
        const next = css[this.i + 1];
        if (next === '\n' || next === '\f') this.i += 2;
        else if (next === '\r') this.i += css[this.i + 2] === '\n' ? 3 : 2;
        else value += this.escape();
        continue;
      }
      value += ch;
      this.i++;
    }
    if (css[this.i] === quote) this.i++;
    return value;
  }

  /** The value of an unquoted url( token; the index is just after `url(` and any whitespace. */
  private unquotedUrl(): string {
    const css = this.css;
    let value = '';
    while (this.i < css.length && css[this.i] !== ')' && !isWhitespace(css[this.i])) {
      if (startsEscape(css, this.i)) value += this.escape();
      else value += css[this.i++];
    }
    return value;
  }

  /**
   * The next token that matters: `{ kind: 'url' }` for a URL the CSS loads, `'function'`/`'close'`
   * for nesting, `'string'`, `'at'` for at-keywords, or `'other'` for anything else.
   */
  next(): { kind: 'url' | 'function' | 'close' | 'string' | 'at' | 'other'; value: string } {
    const css = this.css;
    const ch = css[this.i];
    if (ch === '"' || ch === "'") return { kind: 'string', value: this.string() };
    if (ch === ')') {
      this.i++;
      return { kind: 'close', value: '' };
    }
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
 * The first URL the CSS would load from outside itself (anything but a data: URI), or null.
 * Covers `url()`, `@import`, `src()` and `image-set()`.
 */
export function findCssExternalReference(css: string): string | null {
  const scanner = new CssScanner(css);
  const functions: string[] = [];
  let afterImport = false;
  const external = (url: string): string | null => {
    const trimmed = url.trim();
    return trimmed.length > 0 && !DATA_URI.test(trimmed) ? trimmed : null;
  };
  for (scanner.skipInsignificant(); !scanner.done; scanner.skipInsignificant()) {
    const token = scanner.next();
    let found: string | null = null;
    if (token.kind === 'url') {
      found = external(token.value);
    } else if (token.kind === 'string' && (afterImport || URL_STRING_FUNCTIONS.has(functions[functions.length - 1] ?? ''))) {
      found = external(token.value);
    } else if (token.kind === 'function') {
      functions.push(token.value);
    } else if (token.kind === 'close') {
      functions.pop();
    }
    if (found) return found;
    afterImport = token.kind === 'at' && token.value === IMPORT_RULE;
  }
  return null;
}
