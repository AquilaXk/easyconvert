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

/**
 * Finds `</name\s*>` at or after `from` in the lowercase view. Returns [start, end) or null.
 */
function findCloseTag(lower: string, lowerName: string, from: number): [number, number] | null {
  const needle = `</${lowerName}`;
  let search = from;
  for (;;) {
    const start = lower.indexOf(needle, search);
    if (start === -1) return null;
    let end = start + needle.length;
    while (end < lower.length && isWhitespaceAt(lower, end)) end++;
    if (lower[end] === '>') return [start, end + 1];
    search = start + 1;
  }
}

/**
 * Removes every `<name ...>` element in linear time. Paired elements are removed through their close
 * tag; an opener without a close tag is removed alone; an opening tag that never terminates is removed
 * through the end of input (fail closed).
 */
function stripElement(src: string, name: string, paired: boolean): string {
  const lowerName = lowerKeepingLength(name);
  const lower = lowerKeepingLength(src);
  const open = `<${lowerName}`;
  const parts: string[] = [];
  let copied = 0;
  let search = 0;
  let closeMissing = false;

  for (;;) {
    const start = lower.indexOf(open, search);
    if (start === -1) break;
    const afterName = start + open.length;
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
  return stripExternalCssUrls(css.replace(/@import\s+[^;]+;?/gi, ''));
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

/**
 * One pass of dangerous markup removal; callers repeat until stable to defeat split-opener tricks.
 */
function stripDangerousMarkupPass(input: string): string {
  let result = stripDoctype(input);
  for (const name of PAIRED_DANGEROUS_ELEMENTS) result = stripElement(result, name, true);
  for (const name of VOID_DANGEROUS_ELEMENTS) result = stripElement(result, name, false);
  return result.replace(/\son[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
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
      if (
        decoded.startsWith('javascript:') ||
        decoded.startsWith('vbscript:') ||
        decoded.startsWith('data:text/html') ||
        decoded.startsWith('data:image/svg+xml') ||
        decoded.startsWith('data:application/javascript') ||
        decoded.startsWith('http:') ||
        decoded.startsWith('https:') ||
        decoded.startsWith('file:') ||
        decoded.startsWith('ftp:') ||
        decoded.startsWith('//')
      ) {
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
      if (
        decoded.startsWith('javascript:') ||
        decoded.startsWith('vbscript:') ||
        decoded.startsWith('data:text/html') ||
        decoded.startsWith('data:image/svg+xml') ||
        decoded.startsWith('data:application/javascript') ||
        decoded.startsWith('http:') ||
        decoded.startsWith('https:') ||
        decoded.startsWith('file:') ||
        decoded.startsWith('ftp:') ||
        decoded.startsWith('//')
      ) {
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
