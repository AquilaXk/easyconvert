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
const ANIMATION_ELEMENTS = new Set(['set', 'animate']);
/** Animation attributes carrying the value(s) written into the targeted attribute. */
const ANIMATION_VALUE_ATTRIBUTES = new Set(['to', 'from', 'by', 'values']);
const LINK_ATTRIBUTES = new Set(['href', 'src']);

/** Elements removed together with their content when a matching close tag exists. */
const PAIRED_DANGEROUS_ELEMENTS = ['script', 'foreignObject', 'iframe', 'object', 'embed'] as const;
/** Elements removed as a single opening tag. */
const VOID_DANGEROUS_ELEMENTS = ['meta', 'link', '!ENTITY'] as const;

const EXTERNAL_CSS_URL_START = /url\s*\(\s*['"]?(?:https?:|file:|ftp:|\/\/)/gi;

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

/**
 * Replaces external CSS url() references with `none`; an unterminated url( swallows the rest of the body.
 */
function stripExternalCssUrls(css: string): string {
  let out = '';
  let last = 0;
  for (const match of css.matchAll(EXTERNAL_CSS_URL_START)) {
    if (match.index < last) continue;
    out += `${css.slice(last, match.index)}none`;
    const close = css.indexOf(')', match.index + match[0].length);
    if (close === -1) {
      last = css.length;
      break;
    }
    last = close + 1;
  }
  return out + css.slice(last);
}

function sanitizeCss(css: string): string {
  return stripExternalCssUrls(css.replace(/@import[^;]*;?/gi, ''));
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
    const start = lower.indexOf('<style', search);
    if (start === -1) break;
    const afterName = start + '<style'.length;
    if (isWordCharAt(src, afterName)) {
      search = start + 1;
      continue;
    }
    parts.push(src.slice(copied, start));
    const tagEnd = findTagEnd(src, afterName);
    if (tagEnd === -1) {
      copied = src.length;
      break;
    }
    const close = findCloseTag(lower, 'style', tagEnd);
    const bodyEnd = close === null ? src.length : close[0];
    parts.push(`<style>${sanitizeCss(src.slice(tagEnd, bodyEnd))}</style>`);
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

/**
 * True for `<set>` / `<animate>` elements that would write an event handler or a dangerous URI into another
 * attribute (for example `<set attributeName="onclick" to="alert(1)"/>`).
 */
function isHostileAnimation(tag: TagToken): boolean {
  if (!ANIMATION_ELEMENTS.has(localNameOf(tag.name))) return false;
  const target = tag.attributes.find((attribute) => attribute.name.toLowerCase() === 'attributename');
  if (target === undefined) return false;
  const targetName = localNameOf(normalizeUriText(target.value));
  if (isEventHandlerName(targetName)) return true;
  if (!LINK_ATTRIBUTES.has(targetName)) return false;
  return tag.attributes.some(
    (attribute) =>
      ANIMATION_VALUE_ATTRIBUTES.has(attribute.name.toLowerCase()) &&
      attribute.value
        .split(ANIMATION_VALUE_SEPARATOR)
        .some((item) => isDangerousUri(normalizeUriText(item)))
  );
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

  // 4. Sanitize dangerous URI protocols (javascript:, vbscript:, data:text/html, data:image/svg+xml, http:, https:, file:, ftp:, //)
  result = result.replace(
    /(?:(?:xlink:)?href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (full, v1, v2, v3) => {
      const rawVal = v1 !== undefined ? v1 : (v2 !== undefined ? v2 : v3);
      const decoded = decodeHtmlEntities(rawVal).replace(/[\s\x00-\x1f]/g, '').toLowerCase();
      if (isDangerousUri(decoded)) {
        return 'href="#"';
      }
      return full;
    }
  );

  // 5. Sanitize animation values and attributes (prevent SVG animation script vectors)
  result = result.replace(
    /\b(?:values|to|from)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (full, v1, v2, v3) => {
      const rawVal = v1 !== undefined ? v1 : (v2 !== undefined ? v2 : v3);
      const decoded = decodeHtmlEntities(rawVal).replace(/[\s\x00-\x1f]/g, '').toLowerCase();
      if (isDangerousUri(decoded)) {
        return 'to="#"';
      }
      return full;
    }
  );

  // 6. Sanitize <style> blocks and inline style attributes against SSRF and data exfiltration
  result = sanitizeStyleElements(result);

  result = result.replace(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (full, s1, s2, s3) => {
    const styleBody = s1 !== undefined ? s1 : (s2 !== undefined ? s2 : s3);
    // Output is always double-quoted, so a `"` that came from a single-quoted or unquoted value must be escaped.
    return `style="${sanitizeCss(styleBody).replace(/"/g, '&quot;')}"`;
  });

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
