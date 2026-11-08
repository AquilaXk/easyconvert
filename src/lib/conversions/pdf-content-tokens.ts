/** Lexical reading of a PDF content stream (ISO 32000-1 section 7.8.2), shared by the stream guard and the structure reader. */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const CHAR_OPEN_PAREN = 0x28;
const CHAR_CLOSE_PAREN = 0x29;
const CHAR_BACKSLASH = 0x5c;
const CHAR_LESS = 0x3c;
const CHAR_SLASH = 0x2f;
const CHAR_PERCENT = 0x25;
const CHAR_LINE_FEED = 0x0a;
const CHAR_CARRIAGE_RETURN = 0x0d;

/** Index just past a literal string that starts at `start` (ISO 32000-1 section 7.3.4.2: nested parentheses, escapes). */
function skipLiteralString(content: string, start: number): number {
  let depth = 0;
  for (let index = start; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if (code === CHAR_BACKSLASH) index++;
    else if (code === CHAR_OPEN_PAREN) depth++;
    else if (code === CHAR_CLOSE_PAREN && --depth === 0) return index + 1;
  }
  return content.length;
}

/** Index just past the inline image data that follows an ID operator: up to a delimited EI. */
function skipInlineImage(content: string, start: number): number {
  const end = /[\0\t\n\f\r ]EI(?=[\0\t\n\f\r ]|$)/g;
  end.lastIndex = start;
  const match = end.exec(content);
  return match === null ? content.length : match.index + match[0].length;
}

/**
 * Calls `onToken` with every regular token of a content stream (operators and numeric operands) and where it ends, in one
 * lexical pass: strings, hex strings, names, comments and inline image data are skipped, so a token inside them does not count.
 * For an `ID` operator the end given is that of its inline image data, up to a delimited EI. Linear in the stream length; the
 * pass stops when `onToken` returns true.
 */
export function forEachContentToken(content: string, onToken: (token: string, start: number, end: number) => boolean | void): void {
  let index = 0;
  while (index < content.length) {
    const code = content.charCodeAt(index);
    if (WHITESPACE.has(code)) {
      index++;
    } else if (code === CHAR_PERCENT) {
      while (index < content.length && content.charCodeAt(index) !== CHAR_LINE_FEED && content.charCodeAt(index) !== CHAR_CARRIAGE_RETURN) index++;
    } else if (code === CHAR_OPEN_PAREN) {
      index = skipLiteralString(content, index);
    } else if (code === CHAR_LESS && content.charCodeAt(index + 1) !== CHAR_LESS) {
      const close = content.indexOf('>', index);
      index = close < 0 ? content.length : close + 1;
    } else if (DELIMITERS.has(code)) {
      index++;
      if (code === CHAR_SLASH) {
        while (index < content.length && !WHITESPACE.has(content.charCodeAt(index)) && !DELIMITERS.has(content.charCodeAt(index))) index++;
      }
    } else {
      const start = index;
      while (index < content.length && !WHITESPACE.has(content.charCodeAt(index)) && !DELIMITERS.has(content.charCodeAt(index))) index++;
      const token = content.slice(start, index);
      if (token === 'ID') index = skipInlineImage(content, index);
      if (onToken(token, start, index) === true) return;
    }
  }
}
