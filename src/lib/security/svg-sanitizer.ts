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

/** Elements removed together with their content when a matching close tag exists. */
const PAIRED_DANGEROUS_ELEMENTS = ['script', 'foreignObject', 'iframe', 'object', 'embed'] as const;
/** Elements removed as a single opening tag. */
const VOID_DANGEROUS_ELEMENTS = ['meta', 'link', '!ENTITY'] as const;

const EXTERNAL_CSS_URL_START = /url\s*\(\s*['"]?(?:https?:|file:|ftp:|\/\/)/gi;
const EXTERNAL_CSS_URL_PROBE = /url\s*\(\s*['"]?(?:https?:|file:|ftp:|\/\/)/i;
const CSS_IMPORT_PROBE = /@import/i;
const CSS_EXPRESSION_PROBE = /expression\s*\(/i;
const SCRIPT_URI_PROBE = 'javascript:';
const CSS_IMPORT_RULE = /@import[^;]*;?/gi;

const CHAR_TAB = 0x09;
const CHAR_LF = 0x0a;
const CHAR_FF = 0x0c;
const CHAR_CR = 0x0d;
const CHAR_SPACE = 0x20;
const CHAR_STAR = 0x2a;
const CHAR_SLASH = 0x2f;
const CHAR_BACKSLASH = 0x5c;
const CHAR_DIGIT_0 = 0x30;
const CHAR_DIGIT_9 = 0x39;
const CHAR_UPPER_F = 0x46;
const CHAR_LOWER_A = 0x61;
const CHAR_LOWER_F = 0x66;
const HEX_RADIX = 16;
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

/**
 * Decodes CSS comments and escapes (CSS Syntax 4.3.7) in one linear pass so keywords can be matched the way a
 * CSS parser sees them. Returns null when the text has neither, so the caller can match the original directly.
 * Escapes that decode to NUL, a surrogate or a code point above U+10FFFF throw (fail closed).
 */
function decodeCss(css: string): DecodedCss | null {
  if (!css.includes('\\') && !css.includes('/*')) return null;
  const length = css.length;
  const units = new Uint16Array(length);
  const starts = new Uint32Array(length);
  const ends = new Uint32Array(length);
  let count = 0;
  const push = (unit: number, start: number, end: number): void => {
    units[count] = unit;
    starts[count] = start;
    ends[count] = end;
    count++;
  };

  let i = 0;
  while (i < length) {
    const code = css.charCodeAt(i);
    if (code === CHAR_SLASH && css.charCodeAt(i + 1) === CHAR_STAR) {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? length : close + 2;
      continue;
    }
    if (code !== CHAR_BACKSLASH) {
      push(code, i, i + 1);
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
      push(next, escapeStart, i + 1);
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
    const isSurrogate = codePoint >= SURROGATE_MIN && codePoint <= SURROGATE_MAX;
    if (codePoint === 0 || isSurrogate || codePoint > MAX_CODE_POINT) {
      throw new SvgSanitizationError('SVG contains a CSS escape that decodes to an invalid code point.');
    }
    if (codePoint > BMP_MAX) {
      const offset = codePoint - BMP_MAX - 1;
      push(HIGH_SURROGATE_BASE + (offset >> SURROGATE_SHIFT), escapeStart, i);
      push(LOW_SURROGATE_BASE + (offset & SURROGATE_LOW_MASK), escapeStart, i);
    } else {
      push(codePoint, escapeStart, i);
    }
  }

  const text = Buffer.from(units.buffer, 0, count * Uint16Array.BYTES_PER_ELEMENT).toString('utf16le');
  return { text, starts, ends };
}

/** Finds the `@import` rules and external url() references in already decoded CSS. */
function collectCssEdits(text: string): CssEdit[] {
  const imports = [...text.matchAll(CSS_IMPORT_RULE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    replacement: '',
  }));
  const urls: CssEdit[] = [];
  let urlEnd = 0;
  for (const match of text.matchAll(EXTERNAL_CSS_URL_START)) {
    if (match.index < urlEnd) continue;
    const close = text.indexOf(')', match.index + match[0].length);
    urlEnd = close === -1 ? text.length : close + 1;
    urls.push({ start: match.index, end: urlEnd, replacement: 'none' });
  }
  const edits: CssEdit[] = [];
  let lastEnd = 0;
  for (const edit of [...imports, ...urls].sort((a, b) => a.start - b.start)) {
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
function sanitizeCss(css: string): string {
  const decoded = decodeCss(css);
  const edits = collectCssEdits(decoded === null ? css : decoded.text);
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
    const close = findCloseTag(lower, STYLE_ELEMENT, tagEnd);
    const bodyEnd = close === null ? src.length : close[0];
    parts.push(`<${qualifiedName}>${sanitizeCss(src.slice(tagEnd, bodyEnd))}</${qualifiedName}>`);
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
  const entityDecoded = decodeHtmlEntities(raw);
  let text = entityDecoded;
  try {
    text = decodeCss(entityDecoded)?.text ?? entityDecoded;
  } catch (error) {
    if (error instanceof SvgSanitizationError) return true;
    throw error;
  }
  return (
    CSS_IMPORT_PROBE.test(text) ||
    EXTERNAL_CSS_URL_PROBE.test(text) ||
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
  if (local === STYLE_ATTRIBUTE) {
    // Output is always double-quoted, so a `"` that came from a single-quoted or unquoted value must be escaped.
    return `style="${sanitizeCss(attribute.value).replace(/"/g, '&quot;')}"`;
  }
  return null;
}

/**
 * Rewrites href/src, animation value and style attributes, but only where the tokenizer finds a real attribute
 * inside a real tag; text, comments and attribute values that merely mention them are left untouched.
 */
function rewriteAttributes(src: string): string {
  const parts: string[] = [];
  let copied = 0;
  let search = 0;

  for (;;) {
    const lt = src.indexOf('<', search);
    if (lt === -1) break;
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
