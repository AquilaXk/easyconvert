/**
 * SVG Security Sanitizer & Stored XSS Defense Engine
 *
 * Implements strict sanitization against SVG-based Stored XSS, XXE, and script injection vectors:
 * - Strips DOCTYPE declarations and external entity definitions.
 * - Strips <script>, <foreignObject>, <iframe>, <object>, <embed> tags (both self-closing and block).
 * - Strips inline event handlers (onload, onclick, onerror, on*).
 * - Sanitizes dangerous URI schemes (javascript:, vbscript:, data:text/html) in href/xlink:href/src attributes.
 * - Preserves authentic vector geometry (path, rect, circle, g, svg, text, defs, use, etc.).
 *
 * Element, comment and DOCTYPE stripping uses linear indexOf scanners instead of lazy regexes so that
 * unterminated openers cannot trigger quadratic backtracking.
 */

import { MAX_SVG_INPUT_CHARS } from '../conversions/svg-geometry';
import { SvgSanitizationError } from '../types';

const MAX_STRIP_PASSES = 16;
const ASCII_UPPER_A = 0x41;
const ASCII_UPPER_Z = 0x5a;
const ASCII_CASE_OFFSET = 0x20;
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
const COMMENT_OPEN_LENGTH = COMMENT_OPEN.length;
const DOCTYPE_OPEN = '<!doctype';
const EVENT_PREFIX = 'on';
const STYLE_ATTRIBUTE = 'style';
const STYLE_ELEMENT = 'style';
const ANIMATION_VALUE_SEPARATOR = ';';

/** Lowercase, whitespace-free URI prefixes that are never allowed in href-like or animation values. */
const DANGEROUS_URI_PREFIXES = [
  'javascript:',
  'vbscript:',
  'data:text/html',
  'data:image/svg+xml',
  'data:application/javascript',
  'http:',
  'https:',
  'file:',
  'ftp:',
  '//',
] as const;

/** Animation elements that can retarget an attribute (including event handlers and links) at run time. */
const ANIMATION_ELEMENTS = new Set(['set', 'animate', 'animatetransform', 'animatemotion']);
/** Animation attributes carrying the value(s) written into the targeted attribute. */
const ANIMATION_VALUE_ATTRIBUTES = new Set(['to', 'from', 'by', 'values']);
const LINK_ATTRIBUTES = new Set(['href', 'src']);
/** Presentation attributes whose value is a paint, filter, mask, marker or cursor reference that may fetch a URL. */
const PRESENTATION_URL_ATTRIBUTES = new Set([
  'fill',
  'stroke',
  'filter',
  'clip-path',
  'mask',
  'marker-start',
  'marker-mid',
  'marker-end',
  'cursor',
]);

/** Elements removed together with their content when a matching close tag exists. */
const PAIRED_DANGEROUS_ELEMENTS = ['script', 'foreignObject', 'iframe', 'object', 'embed'] as const;
/** Elements removed as a single opening tag. */
const VOID_DANGEROUS_ELEMENTS = ['meta', 'link', '!ENTITY'] as const;

/** ASCII tab and newlines, which URL parsers drop from anywhere inside a URL. */
const URL_IGNORED_CHARS = '[\\t\\n\\r]*';

/** Matches `word` with optional ignored characters between its letters. */
function spaced(word: string): string {
  return [...word].join(URL_IGNORED_CHARS);
}

/** An external target: an http(s)/file/ftp scheme, or a network-path reference (`//`, `/\\`, `\\/`, `\\\\`). */
const EXTERNAL_TARGET_SOURCE =
  `(?:${['https', 'http', 'file', 'ftp'].map(spaced).join('|')})${URL_IGNORED_CHARS}:` +
  `|[/\\\\]${URL_IGNORED_CHARS}[/\\\\]`;
/** Sticky: tested at the position right after the opening parenthesis of url()/src(). */
const EXTERNAL_FUNCTION_TARGET = new RegExp(`\\s*(?:['"]\\s*)?(?:${EXTERNAL_TARGET_SOURCE})`, 'iy');
/** Tested on the arguments of an image-set(): an external target after the opening parenthesis, a quote, a comma or whitespace. */
const EXTERNAL_IMAGE_SET_TARGET = new RegExp(`(?:^|[\\s'",(])(?:${EXTERNAL_TARGET_SOURCE})`, 'i');
const CSS_URL_FUNCTION_START = /(url|src|(?:-webkit-)?image-set)\s*\(/gi;
const IMAGE_SET_SUFFIX = 'image-set';
const CHAR_DOUBLE_QUOTE = 0x22;
const CHAR_SINGLE_QUOTE = 0x27;
const CHAR_OPEN_PAREN = 0x28;
const CHAR_CLOSE_PAREN = 0x29;
const CSS_EXPRESSION_PROBE = /expression\s*\(/i;
const SCRIPT_URI_PROBE = 'javascript:';
const CSS_IMPORT_RULE = /@import[^;]*;?/gi;

const CHAR_TAB = 0x09;
const CHAR_LF = 0x0a;
const CHAR_FF = 0x0c;
const CHAR_CR = 0x0d;
const CHAR_SPACE = 0x20;
const CHAR_AMPERSAND = 0x26;
const CHAR_STAR = 0x2a;
const CHAR_HASH = 0x23;
const CHAR_SEMICOLON = 0x3b;
const CHAR_LOWER_X = 0x78;
const CHAR_UPPER_X = 0x58;
const CHAR_SLASH = 0x2f;
const CHAR_BACKSLASH = 0x5c;
const CHAR_DIGIT_0 = 0x30;
const CHAR_DIGIT_9 = 0x39;
const CHAR_UPPER_F = 0x46;
const CHAR_LOWER_A = 0x61;
const CHAR_LOWER_F = 0x66;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;
const XML_VALUE_SATURATION = 0x110000;
const XML_NAME_MAX_LENGTH = 4;
const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';
const PI_OPEN = '<?';
const PI_CLOSE = '?>';
/** Predefined XML entities mapped to their code points. */
const XML_PREDEFINED_ENTITIES = new Map<string, number>([
  ['amp', 0x26],
  ['lt', 0x3c],
  ['gt', 0x3e],
  ['quot', 0x22],
  ['apos', 0x27],
]);
const HEX_LETTER_OFFSET = 10;
const CSS_ESCAPE_MAX_HEX_DIGITS = 6;
const MAX_CODE_POINT = 0x10ffff;
const BMP_MAX = 0xffff;
const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;
const HIGH_SURROGATE_BASE = 0xd800;
const LOW_SURROGATE_BASE = 0xdc00;
const SURROGATE_SHIFT = 10;
const SURROGATE_LOW_MASK = 0x3ff;

/**
 * Lowercases while keeping every index aligned with the original string. Native lowercasing is used when it
 * preserves length; otherwise only ASCII letters are folded.
 */
function lowerKeepingLength(str: string): string {
  const native = str.toLowerCase();
  if (native.length === str.length) return native;
  return str.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + ASCII_CASE_OFFSET));
}

function isWordCharAt(str: string, index: number): boolean {
  if (index >= str.length) return false;
  const code = str.charCodeAt(index);
  const isDigit = code >= 0x30 && code <= 0x39;
  const isUpper = code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z;
  const isLower = code >= 0x61 && code <= 0x7a;
  return isDigit || isUpper || isLower || code === 0x5f;
}

/** Takes a URI after entity decoding, whitespace/control removal and lowercasing. */
function isDangerousUri(normalized: string): boolean {
  return DANGEROUS_URI_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function normalizeUriText(raw: string): string {
  return decodeHtmlEntities(raw).replace(/[\s\x00-\x1f]/g, '').toLowerCase();
}

function isWhitespaceAt(str: string, index: number): boolean {
  return /\s/.test(str.charAt(index));
}

/**
 * Returns the index just past the '>' closing the tag whose body starts at `from`, honouring quoted
 * attribute values, or -1 when the tag (or one of its quotes) is unterminated.
 */
function findTagEnd(src: string, from: number): number {
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === '>') return i + 1;
    if (ch === '"' || ch === "'") {
      const closingQuote = src.indexOf(ch, i + 1);
      if (closingQuote === -1) return -1;
      i = closingQuote;
    }
  }
  return -1;
}

function isPrefixCharAt(str: string, index: number): boolean {
  const ch = str.charAt(index);
  return isWordCharAt(str, index) || ch === '-' || ch === '.';
}

/**
 * Given the index of an element's local name, returns the index of the '<' that opens it, accepting an
 * optional `prefix:` between the '<' (or '</' when `closing`) and the name. Returns -1 when the name is not
 * at the start of a (possibly namespace-prefixed) tag name. The walk-back only crosses prefix characters, so
 * it stays linear over the whole input.
 */
function tagOpenBefore(src: string, nameIndex: number, closing: boolean): number {
  let nameStart = nameIndex;
  if (src[nameIndex - 1] === ':') {
    let prefixStart = nameIndex - 1;
    while (prefixStart > 0 && isPrefixCharAt(src, prefixStart - 1)) prefixStart--;
    if (prefixStart === nameIndex - 1) return -1;
    nameStart = prefixStart;
  }
  if (closing) return src[nameStart - 1] === '/' && src[nameStart - 2] === '<' ? nameStart - 2 : -1;
  return src[nameStart - 1] === '<' ? nameStart - 1 : -1;
}

/**
 * Finds `</name\s*>` (optionally namespace-prefixed) at or after `from` in the lowercase view.
 * Returns [start, end) or null.
 */
function findCloseTag(lower: string, lowerName: string, from: number): [number, number] | null {
  let search = from;
  for (;;) {
    const nameIndex = lower.indexOf(lowerName, search);
    if (nameIndex === -1) return null;
    const start = tagOpenBefore(lower, nameIndex, true);
    if (start >= from) {
      let end = nameIndex + lowerName.length;
      while (end < lower.length && isWhitespaceAt(lower, end)) end++;
      if (lower[end] === '>') return [start, end + 1];
    }
    search = nameIndex + 1;
  }
}

/**
 * Removes every `<name ...>` or `<prefix:name ...>` element in linear time. Paired elements are removed
 * through their close tag; an opener without a close tag is removed alone; an opening tag that never
 * terminates is removed through the end of input (fail closed).
 */
function stripElement(src: string, name: string, paired: boolean): string {
  const lowerName = lowerKeepingLength(name);
  const lower = lowerKeepingLength(src);
  const parts: string[] = [];
  let copied = 0;
  let search = 0;
  let closeMissing = false;

  for (;;) {
    const nameIndex = lower.indexOf(lowerName, search);
    if (nameIndex === -1) break;
    const start = tagOpenBefore(lower, nameIndex, false);
    const afterName = nameIndex + lowerName.length;
    if (start < copied || isWordCharAt(src, afterName)) {
      search = nameIndex + 1;
      continue;
    }
    parts.push(src.slice(copied, start));
    const tagEnd = findTagEnd(src, afterName);
    if (tagEnd === -1) {
      copied = src.length;
      break;
    }
    let removeEnd = tagEnd;
    if (paired && !closeMissing) {
      const close = findCloseTag(lower, lowerName, tagEnd);
      if (close === null) closeMissing = true;
      else removeEnd = close[1];
    }
    copied = removeEnd;
    search = removeEnd;
  }

  if (copied === 0 && parts.length === 0) return src;
  parts.push(src.slice(copied));
  return parts.join('');
}

/**
 * Removes DOCTYPE declarations including internal subsets in linear time. An unterminated declaration is
 * removed through the end of input.
 */
function stripDoctype(src: string): string {
  const lower = lowerKeepingLength(src);
  const parts: string[] = [];
  let copied = 0;
  let search = 0;

  for (;;) {
    const start = lower.indexOf(DOCTYPE_OPEN, search);
    if (start === -1) break;
    const afterName = start + DOCTYPE_OPEN.length;
    if (isWordCharAt(src, afterName)) {
      search = start + 1;
      continue;
    }
    parts.push(src.slice(copied, start));
    let end = -1;
    let i = afterName;
    while (i < src.length && src[i] !== '>' && src[i] !== '[') i++;
    if (src[i] === '>') {
      end = i + 1;
    } else if (src[i] === '[') {
      let bracket = src.indexOf(']', i + 1);
      while (bracket !== -1 && end === -1) {
        let k = bracket + 1;
        while (k < src.length && isWhitespaceAt(src, k)) k++;
        if (src[k] === '>') end = k + 1;
        else bracket = src.indexOf(']', bracket + 1);
      }
    }
    if (end === -1) {
      copied = src.length;
      break;
    }
    copied = end;
    search = end;
  }

  if (copied === 0 && parts.length === 0) return src;
  parts.push(src.slice(copied));
  return parts.join('');
}

/**
 * Removes XML comments in linear time; an unterminated comment is removed through the end of input.
 */
function stripComments(src: string): string {
  const parts: string[] = [];
  let copied = 0;
  for (;;) {
    const start = src.indexOf(COMMENT_OPEN, copied);
    if (start === -1) break;
    parts.push(src.slice(copied, start));
    const close = src.indexOf(COMMENT_CLOSE, start + COMMENT_OPEN_LENGTH);
    if (close === -1) {
      copied = src.length;
      break;
    }
    copied = close + COMMENT_CLOSE.length;
  }
  if (copied === 0 && parts.length === 0) return src;
  parts.push(src.slice(copied));
  return parts.join('');
}

interface CssEdit {
  /** Start of the replaced range in the decoded text. */
  start: number;
  /** End (exclusive) of the replaced range in the decoded text. */
  end: number;
  replacement: string;
}

/** CSS text with comments removed and escapes decoded, plus the original span of every decoded code unit. */
interface DecodedCss {
  text: string;
  starts: Uint32Array;
  ends: Uint32Array;
  /** 1 for a unit produced by a CSS escape: it never acts as a quote or parenthesis in the CSS. */
  escaped: Uint8Array;
}

function isHexDigitCode(code: number): boolean {
  return (
    (code >= CHAR_DIGIT_0 && code <= CHAR_DIGIT_9) ||
    (code >= CHAR_LOWER_A && code <= CHAR_LOWER_F) ||
    (code >= ASCII_UPPER_A && code <= CHAR_UPPER_F)
  );
}

function hexDigitValue(code: number): number {
  if (code <= CHAR_DIGIT_9) return code - CHAR_DIGIT_0;
  if (code >= CHAR_LOWER_A) return code - CHAR_LOWER_A + HEX_LETTER_OFFSET;
  return code - ASCII_UPPER_A + HEX_LETTER_OFFSET;
}

function isCssNewlineCode(code: number): boolean {
  return code === CHAR_LF || code === CHAR_CR || code === CHAR_FF;
}

function isCssWhitespaceCode(code: number): boolean {
  return isCssNewlineCode(code) || code === CHAR_SPACE || code === CHAR_TAB;
}

/** Length of the newline starting at `index` (CRLF counts as one), assuming one is there. */
function cssNewlineLength(css: string, index: number): number {
  return css.charCodeAt(index) === CHAR_CR && css.charCodeAt(index + 1) === CHAR_LF ? 2 : 1;
}

/** Fixed-capacity buffer of decoded UTF-16 units that remembers the source span of every unit. */
class DecodeBuffer {
  private readonly units: Uint16Array;
  private readonly starts: Uint32Array;
  private readonly ends: Uint32Array;
  private readonly escaped: Uint8Array;
  private count = 0;

  constructor(capacity: number) {
    this.units = new Uint16Array(capacity);
    this.starts = new Uint32Array(capacity);
    this.ends = new Uint32Array(capacity);
    this.escaped = new Uint8Array(capacity);
  }

  push(unit: number, start: number, end: number, escaped = false): void {
    this.units[this.count] = unit;
    this.starts[this.count] = start;
    this.ends[this.count] = end;
    this.escaped[this.count] = escaped ? 1 : 0;
    this.count++;
  }

  /** Appends a code point (two units when astral). Invalid code points fail closed. */
  pushCodePoint(codePoint: number, start: number, end: number, what: string, escaped = false): void {
    const isSurrogate = codePoint >= SURROGATE_MIN && codePoint <= SURROGATE_MAX;
    if (codePoint === 0 || isSurrogate || codePoint > MAX_CODE_POINT) {
      throw new SvgSanitizationError(`SVG contains ${what} that decodes to an invalid code point.`);
    }
    if (codePoint <= BMP_MAX) {
      this.push(codePoint, start, end, escaped);
      return;
    }
    const offset = codePoint - BMP_MAX - 1;
    this.push(HIGH_SURROGATE_BASE + (offset >> SURROGATE_SHIFT), start, end, escaped);
    this.push(LOW_SURROGATE_BASE + (offset & SURROGATE_LOW_MASK), start, end, escaped);
  }

  finish(): DecodedCss {
    const text = Buffer.from(this.units.buffer, 0, this.count * Uint16Array.BYTES_PER_ELEMENT).toString('utf16le');
    return {
      text,
      starts: this.starts.subarray(0, this.count),
      ends: this.ends.subarray(0, this.count),
      escaped: this.escaped.subarray(0, this.count),
    };
  }
}

/**
 * Decodes CSS comments and escapes (CSS Syntax 4.3.7) in one linear pass so keywords can be matched the way a
 * CSS parser sees them. Returns null when the text has neither, so the caller can match the original directly.
 * Escapes that decode to NUL, a surrogate or a code point above U+10FFFF throw (fail closed).
 */
function decodeCss(css: string): DecodedCss | null {
  if (!css.includes('\\') && !css.includes('/*')) return null;
  const length = css.length;
  const out = new DecodeBuffer(length);

  let i = 0;
  while (i < length) {
    const code = css.charCodeAt(i);
    if (code === CHAR_SLASH && css.charCodeAt(i + 1) === CHAR_STAR) {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? length : close + 2;
      continue;
    }
    if (code !== CHAR_BACKSLASH) {
      out.push(code, i, i + 1);
      i++;
      continue;
    }

    const escapeStart = i;
    i++;
    if (i >= length) break;
    const next = css.charCodeAt(i);
    if (isCssNewlineCode(next)) {
      i += cssNewlineLength(css, i);
      continue;
    }
    if (!isHexDigitCode(next)) {
      out.push(next, escapeStart, i + 1, true);
      i++;
      continue;
    }

    let codePoint = 0;
    let digits = 0;
    while (digits < CSS_ESCAPE_MAX_HEX_DIGITS && i < length && isHexDigitCode(css.charCodeAt(i))) {
      codePoint = codePoint * HEX_RADIX + hexDigitValue(css.charCodeAt(i));
      i++;
      digits++;
    }
    if (i < length && isCssWhitespaceCode(css.charCodeAt(i))) {
      i += isCssNewlineCode(css.charCodeAt(i)) ? cssNewlineLength(css, i) : 1;
    }
    out.pushCodePoint(codePoint, escapeStart, i, 'a CSS escape', true);
  }
  return out.finish();
}

/**
 * Parses an XML character reference or predefined entity whose `&` is at `amp`. Returns the code point and the
 * index just past the `;`, or null when the text there is not a well-formed reference (it then stays literal).
 * A numeric value is saturated above the Unicode range so huge digit runs stay linear and are rejected later.
 */
function readXmlReference(text: string, amp: number): { codePoint: number; end: number } | null {
  const length = text.length;
  let i = amp + 1;
  if (text.charCodeAt(i) === CHAR_HASH) {
    i++;
    const hex = text.charCodeAt(i) === CHAR_LOWER_X || text.charCodeAt(i) === CHAR_UPPER_X;
    if (hex) i++;
    const digitsStart = i;
    let value = 0;
    while (i < length) {
      const code = text.charCodeAt(i);
      const isDigit = hex ? isHexDigitCode(code) : code >= CHAR_DIGIT_0 && code <= CHAR_DIGIT_9;
      if (!isDigit) break;
      value = Math.min(value * (hex ? HEX_RADIX : DECIMAL_RADIX) + hexDigitValue(code), XML_VALUE_SATURATION);
      i++;
    }
    if (i === digitsStart || text.charCodeAt(i) !== CHAR_SEMICOLON) return null;
    return { codePoint: value, end: i + 1 };
  }
  // Bounded look-ahead: an unbounded indexOf here would rescan the rest of the text for every '&'.
  const nameLimit = Math.min(i + XML_NAME_MAX_LENGTH, length - 1);
  let semicolon = i;
  while (semicolon <= nameLimit && text.charCodeAt(semicolon) !== CHAR_SEMICOLON) semicolon++;
  if (semicolon > nameLimit) return null;
  const replacement = XML_PREDEFINED_ENTITIES.get(text.slice(i, semicolon));
  return replacement === undefined ? null : { codePoint: replacement, end: semicolon + 1 };
}

/**
 * Resolves XML character and predefined entity references the way a parser does for element text or an
 * attribute value, in one linear pass. With `cdata`, `<![CDATA[ ... ]]>` sections are literal (markers removed,
 * content copied verbatim). Returns null when there is nothing to resolve.
 */
function decodeXmlText(text: string, cdata: boolean): DecodedCss | null {
  const hasCdata = cdata && text.includes(CDATA_OPEN);
  if (!hasCdata && !text.includes('&')) return null;
  const length = text.length;
  const out = new DecodeBuffer(length);

  let i = 0;
  while (i < length) {
    if (hasCdata && text.startsWith(CDATA_OPEN, i)) {
      const contentStart = i + CDATA_OPEN.length;
      const close = text.indexOf(CDATA_CLOSE, contentStart);
      const contentEnd = close === -1 ? length : close;
      for (let k = contentStart; k < contentEnd; k++) out.push(text.charCodeAt(k), k, k + 1);
      i = close === -1 ? length : close + CDATA_CLOSE.length;
      continue;
    }
    const code = text.charCodeAt(i);
    const reference = code === CHAR_AMPERSAND ? readXmlReference(text, i) : null;
    if (reference === null) {
      out.push(code, i, i + 1);
      i++;
      continue;
    }
    out.pushCodePoint(reference.codePoint, i, reference.end, 'an XML character reference');
    i = reference.end;
  }
  return out.finish();
}

/**
 * Decodes what a browser sees: XML references first, then CSS comments and escapes. The result maps every
 * decoded unit back to its span in the original text. Returns null when the text needs no decoding.
 */
function decodeForMatching(raw: string, cdata: boolean): DecodedCss | null {
  const entities = decodeXmlText(raw, cdata);
  const css = decodeCss(entities === null ? raw : entities.text);
  if (css === null) return entities;
  if (entities === null) return css;
  const starts = new Uint32Array(css.starts.length);
  const ends = new Uint32Array(css.ends.length);
  for (let k = 0; k < starts.length; k++) {
    starts[k] = entities.starts[css.starts[k]];
    ends[k] = entities.ends[css.ends[k] - 1];
  }
  return { text: css.text, starts, ends, escaped: css.escaped };
}

/**
 * Index just past the parenthesis closing the one opened right before `from`, or the end of text when it never
 * closes. Quoted strings are skipped; quotes and parentheses produced by CSS escapes are plain characters.
 */
function findClosingParen(text: string, from: number, escaped: Uint8Array | null): number {
  let depth = 1;
  let quote = 0;
  for (let i = from; i < text.length; i++) {
    if (escaped !== null && escaped[i] === 1) continue;
    const code = text.charCodeAt(i);
    if (quote !== 0) {
      if (code === quote) quote = 0;
    } else if (code === CHAR_DOUBLE_QUOTE || code === CHAR_SINGLE_QUOTE) {
      quote = code;
    } else if (code === CHAR_OPEN_PAREN) {
      depth++;
    } else if (code === CHAR_CLOSE_PAREN && --depth === 0) {
      return i + 1;
    }
  }
  return text.length;
}

/** Replacements for external url(), src() and image-set() references; a reference swallows what it contains. */
function collectExternalReferenceEdits(text: string, escaped: Uint8Array | null): CssEdit[] {
  const edits: CssEdit[] = [];
  let scanned = 0;
  for (const match of text.matchAll(CSS_URL_FUNCTION_START)) {
    if (match.index < scanned) continue;
    const argsStart = match.index + match[0].length;
    if (match[1].toLowerCase().endsWith(IMAGE_SET_SUFFIX)) {
      const end = findClosingParen(text, argsStart, escaped);
      scanned = end;
      if (EXTERNAL_IMAGE_SET_TARGET.test(text.slice(argsStart, end))) {
        edits.push({ start: match.index, end, replacement: 'none' });
      }
      continue;
    }
    EXTERNAL_FUNCTION_TARGET.lastIndex = argsStart;
    if (!EXTERNAL_FUNCTION_TARGET.test(text)) continue;
    const close = text.indexOf(')', argsStart);
    scanned = close === -1 ? text.length : close + 1;
    edits.push({ start: match.index, end: scanned, replacement: 'none' });
  }
  return edits;
}

/** Finds the `@import` rules and external references in already decoded CSS. */
function collectCssEdits(text: string, escaped: Uint8Array | null): CssEdit[] {
  const imports = [...text.matchAll(CSS_IMPORT_RULE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    replacement: '',
  }));
  const edits: CssEdit[] = [];
  let lastEnd = 0;
  for (const edit of [...imports, ...collectExternalReferenceEdits(text, escaped)].sort((a, b) => a.start - b.start)) {
    if (edit.start < lastEnd) continue;
    edits.push(edit);
    lastEnd = edit.end;
  }
  return edits;
}

/**
 * Removes `@import` rules and replaces external url() references with `none`. Matching runs on the comment-free,
 * escape-decoded text, but the edits are applied to the original so benign CSS is returned byte-for-byte.
 */
function sanitizeCss(css: string, cdata: boolean): string {
  const decoded = decodeForMatching(css, cdata);
  const edits = collectCssEdits(decoded === null ? css : decoded.text, decoded === null ? null : decoded.escaped);
  if (edits.length === 0) return css;
  let out = '';
  let last = 0;
  for (const edit of edits) {
    const start = decoded === null ? edit.start : decoded.starts[edit.start];
    const end = decoded === null ? edit.end : decoded.ends[edit.end - 1];
    out += css.slice(last, start) + edit.replacement;
    last = end;
  }
  return out + css.slice(last);
}

interface StyleClose {
  close: [number, number] | null;
  /** True when the body ends inside a CDATA section that never terminates. */
  openCdata: boolean;
}

/**
 * Finds the close tag of a style element whose body starts at `from`, ignoring close tags inside CDATA
 * sections. A CDATA section that never terminates runs to the end of input, so no close tag is found. Each
 * region of the input is searched at most once, so the scan stays linear.
 */
function findStyleCloseTag(src: string, lower: string, from: number): StyleClose {
  let close = findCloseTag(lower, STYLE_ELEMENT, from);
  let position = from;
  while (close !== null) {
    const cdataStart = src.indexOf(CDATA_OPEN, position);
    if (cdataStart === -1 || close[0] < cdataStart) return { close, openCdata: false };
    const cdataClose = src.indexOf(CDATA_CLOSE, cdataStart + CDATA_OPEN.length);
    if (cdataClose === -1) return { close: null, openCdata: true };
    position = cdataClose + CDATA_CLOSE.length;
    if (close[0] < position) close = findCloseTag(lower, STYLE_ELEMENT, position);
  }
  // No close tag: a CDATA section opened after the last one that was skipped would still be open at the end.
  const trailingCdata = src.indexOf(CDATA_OPEN, position);
  const openCdata = trailingCdata !== -1 && src.indexOf(CDATA_CLOSE, trailingCdata + CDATA_OPEN.length) === -1;
  return { close: null, openCdata };
}

/**
 * Rewrites every <style> element so its body is sanitized; an unterminated element is closed at end of input.
 */
function sanitizeStyleElements(src: string): string {
  const lower = lowerKeepingLength(src);
  const parts: string[] = [];
  let copied = 0;
  let search = 0;

  for (;;) {
    const nameIndex = lower.indexOf(STYLE_ELEMENT, search);
    if (nameIndex === -1) break;
    const start = tagOpenBefore(lower, nameIndex, false);
    const afterName = nameIndex + STYLE_ELEMENT.length;
    if (start < copied || isWordCharAt(src, afterName)) {
      search = nameIndex + 1;
      continue;
    }
    parts.push(src.slice(copied, start));
    const tagEnd = findTagEnd(src, afterName);
    if (tagEnd === -1) {
      copied = src.length;
      break;
    }
    // The qualified name (including any namespace prefix) is kept so the element stays in its namespace.
    const qualifiedName = src.slice(start + 1, afterName);
    const { close, openCdata } = findStyleCloseTag(src, lower, tagEnd);
    const bodyEnd = close === null ? src.length : close[0];
    // An unterminated CDATA section is closed so that the output is a fixed point of this rewrite.
    const cdataTerminator = openCdata ? CDATA_CLOSE : '';
    parts.push(
      `<${qualifiedName}>${sanitizeCss(src.slice(tagEnd, bodyEnd), true)}${cdataTerminator}</${qualifiedName}>`
    );
    copied = close === null ? src.length : close[1];
    search = copied;
  }

  if (copied === 0 && parts.length === 0) return src;
  parts.push(src.slice(copied));
  return parts.join('');
}

interface TagAttribute {
  name: string;
  /** Index of the first character of the attribute name. */
  start: number;
  /** Index just past the attribute value (or name when it has none); the input length when a quote is unterminated. */
  end: number;
  /** Raw value without surrounding quotes. */
  value: string;
}

interface TagToken {
  name: string;
  attributes: TagAttribute[];
  /** Index just past the closing '>', or the input length when the tag is unterminated. */
  end: number;
  terminated: boolean;
}

function isTagNameStart(src: string, index: number): boolean {
  const ch = src.charAt(index);
  return ch === '_' || ch === ':' || /[A-Za-z]/.test(ch);
}

function skipWhitespace(src: string, from: number): number {
  let i = from;
  while (i < src.length && isWhitespaceAt(src, i)) i++;
  return i;
}

/**
 * Tokenizes the tag opening at `lt` the way an HTML/XML parser does: whitespace, '/' and the end of a quoted
 * value all separate attributes, so `<svg/onload=x>` and `<svg a="b"onload=x>` expose an `onload` attribute.
 * Runs in time linear in the tag length.
 */
function readTag(src: string, lt: number): TagToken {
  const length = src.length;
  let i = lt + 1;
  while (i < length && !isWhitespaceAt(src, i) && src[i] !== '/' && src[i] !== '>') i++;
  const name = src.slice(lt + 1, i);
  const attributes: TagAttribute[] = [];

  for (;;) {
    while (i < length && (isWhitespaceAt(src, i) || src[i] === '/')) i++;
    if (i >= length) return { name, attributes, end: length, terminated: false };
    if (src[i] === '>') return { name, attributes, end: i + 1, terminated: true };

    const start = i;
    i++;
    while (i < length && !isWhitespaceAt(src, i) && src[i] !== '/' && src[i] !== '>' && src[i] !== '=') i++;
    const attrName = src.slice(start, i);
    const afterName = skipWhitespace(src, i);
    if (src[afterName] !== '=') {
      attributes.push({ name: attrName, start, end: i, value: '' });
      continue;
    }

    const valueStart = skipWhitespace(src, afterName + 1);
    const quote = src.charAt(valueStart);
    if (quote === '"' || quote === "'") {
      const close = src.indexOf(quote, valueStart + 1);
      if (close === -1) {
        attributes.push({ name: attrName, start, end: length, value: src.slice(valueStart + 1) });
        return { name, attributes, end: length, terminated: false };
      }
      attributes.push({ name: attrName, start, end: close + 1, value: src.slice(valueStart + 1, close) });
      i = close + 1;
    } else {
      let valueEnd = valueStart;
      while (valueEnd < length && !isWhitespaceAt(src, valueEnd) && src[valueEnd] !== '>') valueEnd++;
      attributes.push({ name: attrName, start, end: valueEnd, value: src.slice(valueStart, valueEnd) });
      i = valueEnd;
    }
  }
}

/**
 * When the markup at `lt` is a comment, CDATA section or processing instruction, returns the index just past
 * its terminator (the end of input when unterminated), so its contents are never tokenized as tags. Returns -1
 * for anything else. The HTML-only shorthands `<!-->` and `<!--->` are parsed differently by XML and HTML
 * parsers, so they are rejected (fail closed).
 */
function skipNonTagMarkup(src: string, lt: number): number {
  if (src.startsWith(COMMENT_OPEN, lt)) {
    const bodyStart = lt + COMMENT_OPEN_LENGTH;
    if (src.startsWith('>', bodyStart) || src.startsWith('->', bodyStart)) {
      throw new SvgSanitizationError('SVG contains a malformed comment that parsers disagree on.');
    }
    const close = src.indexOf(COMMENT_CLOSE, bodyStart);
    return close === -1 ? src.length : close + COMMENT_CLOSE.length;
  }
  if (src.startsWith(CDATA_OPEN, lt)) {
    const close = src.indexOf(CDATA_CLOSE, lt + CDATA_OPEN.length);
    return close === -1 ? src.length : close + CDATA_CLOSE.length;
  }
  if (src.startsWith(PI_OPEN, lt)) {
    const close = src.indexOf(PI_CLOSE, lt + PI_OPEN.length);
    return close === -1 ? src.length : close + PI_CLOSE.length;
  }
  return -1;
}

function isEventHandlerName(attributeName: string): boolean {
  const lowered = attributeName.replace(/^["'=]+/, '').toLowerCase();
  const local = lowered.slice(lowered.lastIndexOf(':') + 1);
  return local.length > EVENT_PREFIX.length && local.startsWith(EVENT_PREFIX);
}

function localNameOf(qualified: string): string {
  const lowered = qualified.toLowerCase();
  return lowered.slice(lowered.lastIndexOf(':') + 1);
}

/** True when a value written into `style` would import, fetch externally or execute once parsed as CSS. */
function isHostileStyleValue(raw: string): boolean {
  let text = raw;
  let hasCssReference = false;
  try {
    const decoded = decodeForMatching(raw, false);
    text = decoded?.text ?? raw;
    hasCssReference = collectCssEdits(text, decoded === null ? null : decoded.escaped).length > 0;
  } catch (error) {
    if (error instanceof SvgSanitizationError) return true;
    throw error;
  }
  return (
    hasCssReference ||
    CSS_EXPRESSION_PROBE.test(text) ||
    text.replace(/[\s\x00-\x1f]/g, '').toLowerCase().includes(SCRIPT_URI_PROBE)
  );
}

/**
 * True when any `;`-separated item of an animation value is a dangerous URI. Entities are decoded before
 * splitting so an encoded `;` (`&#59;`) cannot hide the item boundary.
 */
function hasDangerousUriItem(raw: string): boolean {
  return decodeHtmlEntities(raw)
    .split(ANIMATION_VALUE_SEPARATOR)
    .some((item) => isDangerousUri(normalizeUriText(item)));
}

/** True when `isHostile` accepts the raw value of any to/from/by/values attribute. */
function hasAnimationValue(tag: TagToken, isHostile: (value: string) => boolean): boolean {
  return tag.attributes.some(
    (attribute) => ANIMATION_VALUE_ATTRIBUTES.has(attribute.name.toLowerCase()) && isHostile(attribute.value)
  );
}

/**
 * True for animation elements that would write an event handler or a dangerous URI into another
 * attribute (for example `<set attributeName="onclick" to="alert(1)"/>`).
 */
function isHostileAnimation(tag: TagToken): boolean {
  if (!ANIMATION_ELEMENTS.has(localNameOf(tag.name))) return false;
  const target = tag.attributes.find((attribute) => attribute.name.toLowerCase() === 'attributename');
  if (target === undefined) return false;
  const targetName = localNameOf(normalizeUriText(target.value));
  if (isEventHandlerName(targetName)) return true;
  if (targetName === STYLE_ATTRIBUTE) return hasAnimationValue(tag, isHostileStyleValue);
  if (!LINK_ATTRIBUTES.has(targetName)) return false;
  return hasAnimationValue(tag, hasDangerousUriItem);
}

/**
 * Removes every on* attribute (and every animation element retargeting one) from every tag in linear time, wherever the attribute sits in the tag
 * (after whitespace, '/', or the closing quote of the previous value). Text outside tags is untouched.
 */
function stripEventHandlerAttributes(src: string): string {
  const parts: string[] = [];
  let copied = 0;
  let search = 0;

  for (;;) {
    const lt = src.indexOf('<', search);
    if (lt === -1) break;
    const skipTo = skipNonTagMarkup(src, lt);
    if (skipTo !== -1) {
      search = skipTo;
      continue;
    }
    if (!isTagNameStart(src, lt + 1)) {
      search = lt + 1;
      continue;
    }
    const tag = readTag(src, lt);
    if (isHostileAnimation(tag)) {
      parts.push(src.slice(copied, lt));
      copied = tag.end;
      search = tag.end;
      continue;
    }
    for (const attribute of tag.attributes) {
      if (!isEventHandlerName(attribute.name)) continue;
      let removeStart = attribute.start;
      while (removeStart > copied && isWhitespaceAt(src, removeStart - 1)) removeStart--;
      parts.push(src.slice(copied, removeStart));
      copied = attribute.end;
    }
    search = tag.end;
  }

  if (copied === 0 && parts.length === 0) return src;
  parts.push(src.slice(copied));
  return parts.join('');
}

function attributeLocalName(attributeName: string): string {
  return localNameOf(attributeName.replace(/^["'=]+/, ''));
}

/** Replacement for an attribute whose value is a dangerous URI, or null when it is left alone. */
function neutralizedAttribute(attribute: TagAttribute): string | null {
  const local = attributeLocalName(attribute.name);
  if (LINK_ATTRIBUTES.has(local)) {
    return isDangerousUri(normalizeUriText(attribute.value)) ? 'href="#"' : null;
  }
  if (ANIMATION_VALUE_ATTRIBUTES.has(local)) {
    return hasDangerousUriItem(attribute.value) ? `${local}="#"` : null;
  }
  if (PRESENTATION_URL_ATTRIBUTES.has(local)) {
    const sanitized = sanitizeCss(attribute.value, false);
    if (sanitized === attribute.value) return null;
    return `${attribute.name}="${sanitized.replace(/"/g, '&quot;')}"`;
  }
  if (local === STYLE_ATTRIBUTE) {
    // Output is always double-quoted, so a `"` that came from a single-quoted or unquoted value must be escaped.
    return `style="${sanitizeCss(attribute.value, false).replace(/"/g, '&quot;')}"`;
  }
  return null;
}

/**
 * Rewrites href/src, animation value, presentation and style attributes, but only where the tokenizer finds a real attribute
 * inside a real tag; text, comments and attribute values that merely mention them are left untouched.
 */
function rewriteAttributes(src: string): string {
  const parts: string[] = [];
  let copied = 0;
  let search = 0;

  for (;;) {
    const lt = src.indexOf('<', search);
    if (lt === -1) break;
    const skipTo = skipNonTagMarkup(src, lt);
    if (skipTo !== -1) {
      search = skipTo;
      continue;
    }
    if (!isTagNameStart(src, lt + 1)) {
      search = lt + 1;
      continue;
    }
    const tag = readTag(src, lt);
    for (const attribute of tag.attributes) {
      const replacement = neutralizedAttribute(attribute);
      if (replacement === null) continue;
      parts.push(src.slice(copied, attribute.start), replacement);
      copied = attribute.end;
    }
    search = tag.end;
  }

  if (copied === 0 && parts.length === 0) return src;
  parts.push(src.slice(copied));
  return parts.join('');
}

/**
 * One pass of dangerous markup removal; callers repeat until stable to defeat split-opener tricks.
 */
function stripDangerousMarkupPass(input: string): string {
  let result = stripDoctype(input);
  for (const name of PAIRED_DANGEROUS_ELEMENTS) result = stripElement(result, name, true);
  for (const name of VOID_DANGEROUS_ELEMENTS) result = stripElement(result, name, false);
  return stripEventHandlerAttributes(result);
}

/**
 * Decodes standard and numerical HTML entities (hex and decimal).
 */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/**
 * Checks whether the given buffer or text represents an SVG document.
 */
export function isSvg(input: string | Buffer): boolean {
  if (!input) return false;
  const str = typeof input === 'string' ? input : input.toString('utf-8');

  // Guard against binary files
  if (typeof input !== 'string') {
    if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return false; // JPG
    if (input.length >= 8 && input[0] === 0x89 && input[1] === 0x50 && input[2] === 0x4e && input[3] === 0x47) return false; // PNG
    if (input.length >= 4 && input[0] === 0x47 && input[1] === 0x49 && input[2] === 0x46 && input[3] === 0x38) return false; // GIF
  }

  const trimmed = str.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false; // JSON
  if (trimmed.startsWith('GIF87a') || trimmed.startsWith('GIF89a')) return false;

  // Strip XML declaration, comments, and doctypes (including internal subsets) to verify root element
  const stripped = stripDoctype(stripComments(trimmed.replace(/^<\?xml[^>]*\?>/i, ''))).trim();

  return /^<svg\b/i.test(stripped);
}

/**
 * One full sanitation pass: dangerous markup removal followed by URI and style rewrites.
 */
function sanitizePass(input: string): string {
  // 1-3. Strip DOCTYPE/ENTITY declarations, executable and embedding elements, and on* event handlers.
  let result = stripDangerousMarkupPass(input);

  // 4-6. Rewrite href-like, animation value and style attributes of real tags against dangerous URIs, SSRF and
  // data exfiltration, then clean <style> element bodies.
  result = rewriteAttributes(result);
  result = sanitizeStyleElements(result);

  return result;
}

/**
 * Sanitizes an SVG string by stripping dangerous tags, attributes, and script execution vectors.
 */
export function sanitizeSvgString(svg: string): string {
  if (!svg || typeof svg !== 'string') return '';

  // Every pass strips dangerous markup and then rewrites URIs and styles. A rewrite can join fragments into
  // new dangerous markup (for example `<scr@import x;ipt>` inside <style>), so the pipeline repeats until its
  // output is a fixed point; payloads that need more passes than any real document are rejected (fail closed).
  let result = svg;
  let stable = false;
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const next = sanitizePass(result);
    if (next === result) {
      stable = true;
      break;
    }
    result = next;
  }
  if (!stable) {
    throw new SvgSanitizationError('SVG contains nested markup that cannot be sanitized safely.');
  }
  return result.trim();
}

/**
 * Sanitizes an SVG document after enforcing the SVG input size cap. SVG entry points use this; callers that
 * run the sanitizer over arbitrary XML use {@link sanitizeSvgString}, which has no size cap.
 */
export function sanitizeSvgDocument(svg: string): string {
  if (typeof svg === 'string' && svg.length > MAX_SVG_INPUT_CHARS) {
    throw new SvgSanitizationError(`SVG input exceeds the ${MAX_SVG_INPUT_CHARS}-character limit.`);
  }
  return sanitizeSvgString(svg);
}

/**
 * Sanitizes an SVG buffer and returns a sanitized Buffer.
 */
export function sanitizeSvgBuffer(buffer: Buffer): Buffer {
  const svgText = buffer.toString('utf-8');
  const cleanText = sanitizeSvgDocument(svgText);
  return Buffer.from(cleanText, 'utf-8');
}
