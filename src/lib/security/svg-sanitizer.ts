/**
 * SVG Security Sanitizer & Stored XSS Defense Engine
 *
 * Implements strict sanitization against SVG-based Stored XSS, XXE, and script injection vectors:
 * - Strips DOCTYPE declarations and external entity definitions.
 * - Strips <script>, <foreignObject>, <iframe>, <object>, <embed> tags (both self-closing and block).
 * - Strips inline event handlers (onload, onclick, onerror, on*) and the form attributes action and formaction.
 * - Strips every processing instruction but the XML declaration at the start (<?xml-stylesheet?> loads a style sheet).
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

/** Lowercase, whitespace-free prefixes of URIs that execute or render active content. */
const SCRIPT_URI_PREFIXES = ['javascript:', 'vbscript:', 'data:text/html', 'data:image/svg+xml', 'data:application/javascript'] as const;

/** Lowercase, whitespace-free URI prefixes that are never allowed in href-like or animation values. */
const DANGEROUS_URI_PREFIXES = [...SCRIPT_URI_PREFIXES, 'http:', 'https:', 'file:', 'ftp:', '//', '/'] as const;

/**
 * The only `data:` URIs a link may carry (after normalization): a raster picture. Any other type is active content or markup that a
 * viewer may parse (`data:text/xml`, `data:application/xhtml+xml`), and an `<image>` takes an embedded SVG through its own path.
 */
const RASTER_DATA_URI = /^data:image\/(?:png|jpeg|gif|webp)(?:;[a-z0-9=._+-]+)*,/;
const DATA_URI_PREFIX = 'data:';
/** Attributes of an HTML form, which no SVG element has: they send a submission to an address. */
const FORM_ATTRIBUTES = new Set(['action', 'formaction']);

/** Animation elements that can retarget an attribute (including event handlers and links) at run time. */
const ANIMATION_ELEMENTS = new Set(['set', 'animate', 'animatetransform', 'animatemotion']);
/** Animation attributes carrying the value(s) written into the targeted attribute. */
const ANIMATION_VALUE_ATTRIBUTES = new Set(['to', 'from', 'by', 'values']);
const LINK_ATTRIBUTES = new Set(['href', 'src']);
/** Presentation attributes whose value is a paint, filter, mask, marker or cursor reference that may fetch a URL. */
const PRESENTATION_URL_ATTRIBUTES = new Set(['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);
/** HTML5 §13.2.6.5 foreign-content breakout tags (plus math integration) whose opening closes `<svg>` in HTML parsing. */
const HTML_BREAKOUT_ELEMENTS = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt',
  'em', 'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li',
  'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 'rp', 'rt', 'rtc', 's',
  'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
  'math', 'annotation-xml',
]);
const HTML_FONT_BREAKOUT_ATTRS = new Set(['color', 'face', 'size']);
const SVG_HTML_INTEGRATION_POINTS = new Set(['desc', 'title']);

/** Elements removed together with their content when a matching close tag exists. */
const PAIRED_DANGEROUS_ELEMENTS = ['script', 'foreignObject', 'iframe', 'object', 'embed', 'form'] as const;
/** Elements removed as a single opening tag. */
const VOID_DANGEROUS_ELEMENTS = ['meta', 'link', '!ENTITY'] as const;
const RE_HAS_SPECIAL = /["']|--|<!\[CDATA\[|\?/;
const RE_OTHER_DANGEROUS = /foreignobject|iframe|object|embed|form|meta|link|!entity/;
const RE_EVENT_PREFILTER = /--|on|set|animate/;

/** ASCII tab and newlines, which URL parsers drop from anywhere inside a URL. */
const CSS_URL_FUNCTION_START = /(url|src|(?:-webkit-)?image-set)\s*\(/gi;
const IMAGE_SET_SUFFIX = 'image-set';
const SAFE_FRAGMENT_ID = /^#[A-Za-z0-9_.:-]+$/;
const SAFE_IMAGE_SET_DESCRIPTOR = /^(?:\d+(?:\.\d+)?(?:x|dppx|dpi|dpcm))$/i;
const IMAGE_SET_URL_AT = /url\s*\(/iy;
const CSS_EXPRESSION_PROBE = /expression\s*\(/i;
const SCRIPT_URI_PROBE = 'javascript:';

const CHAR_TAB = 0x09, CHAR_LF = 0x0a, CHAR_FF = 0x0c, CHAR_CR = 0x0d, CHAR_SPACE = 0x20;
const CHAR_BANG = 0x21, CHAR_DOUBLE_QUOTE = 0x22, CHAR_HASH = 0x23, CHAR_AMPERSAND = 0x26, CHAR_SINGLE_QUOTE = 0x27;
const CHAR_OPEN_PAREN = 0x28, CHAR_CLOSE_PAREN = 0x29, CHAR_STAR = 0x2a, CHAR_HYPHEN = 0x2d, CHAR_DOT = 0x2e;
const CHAR_SLASH = 0x2f, CHAR_DIGIT_0 = 0x30, CHAR_DIGIT_9 = 0x39, CHAR_COLON = 0x3a, CHAR_SEMICOLON = 0x3b;
const CHAR_LT = 0x3c, CHAR_EQUALS = 0x3d, CHAR_GT = 0x3e, CHAR_QUESTION = 0x3f;
const CHAR_UPPER_F = 0x46, CHAR_UPPER_X = 0x58, CHAR_LBRACKET = 0x5b, CHAR_BACKSLASH = 0x5c, CHAR_RBRACKET = 0x5d;
const CHAR_UNDERSCORE = 0x5f, CHAR_LOWER_A = 0x61, CHAR_LOWER_F = 0x66, CHAR_LOWER_G = 0x67, CHAR_LOWER_L = 0x6c;
const CHAR_LOWER_Q = 0x71, CHAR_LOWER_X = 0x78, CHAR_LOWER_Z = 0x7a;
const HEX_RADIX = 16, DECIMAL_RADIX = 10, XML_VALUE_SATURATION = 0x110000, XML_NAME_MAX_LENGTH = 4;
const CDATA_OPEN = '<![CDATA[', CDATA_CLOSE = ']]>', PI_OPEN = '<?', PI_CLOSE = '?>';
const XML_DECLARATION_OPEN = '<?xml', BYTE_ORDER_MARK = 0xfeff;
const XML_PREDEFINED_ENTITIES = new Map<string, number>([['amp', 0x26], ['lt', 0x3c], ['gt', 0x3e], ['quot', 0x22], ['apos', 0x27]]);
const HEX_LETTER_OFFSET = 10, CSS_ESCAPE_MAX_HEX_DIGITS = 6, MAX_CODE_POINT = 0x10ffff, BMP_MAX = 0xffff;
const SURROGATE_MIN = 0xd800, SURROGATE_MAX = 0xdfff, HIGH_SURROGATE_BASE = 0xd800, LOW_SURROGATE_BASE = 0xdc00;
const SURROGATE_SHIFT = 10, SURROGATE_LOW_MASK = 0x3ff;

/**
 * Lowercases while keeping every index aligned with the original string. Native lowercasing is used when it
 * preserves length; otherwise only ASCII letters are folded.
 */
function lowerKeepingLength(str: string): string {
  const native = str.toLowerCase();
  if (native.length === str.length) return native;
  return str.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + ASCII_CASE_OFFSET));
}

function isAsciiAlphaCode(code: number): boolean {
  return (code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z) || (code >= CHAR_LOWER_A && code <= CHAR_LOWER_Z);
}
const isAsciiAlphaAt = (str: string, index: number): boolean => index < str.length && isAsciiAlphaCode(str.charCodeAt(index));

function isWhitespaceCode(code: number): boolean {
  if (code <= CHAR_SPACE) return code === CHAR_SPACE || (code >= CHAR_TAB && code <= CHAR_CR);
  if (code < 0xa0) return false;
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}
const isWhitespaceAt = (str: string, index: number): boolean => isWhitespaceCode(str.charCodeAt(index));

function isWordCharCode(code: number): boolean {
  if (code >= 0x80) return !isWhitespaceCode(code);
  return (code >= CHAR_DIGIT_0 && code <= CHAR_DIGIT_9) || isAsciiAlphaCode(code) || code === CHAR_UNDERSCORE;
}
const isWordCharAt = (str: string, index: number): boolean => index < str.length && isWordCharCode(str.charCodeAt(index));

/** Takes a URI after entity decoding, whitespace/control removal and lowercasing; true for script-capable URIs. */
const isScriptUri = (normalized: string): boolean => SCRIPT_URI_PREFIXES.some((prefix) => normalized.startsWith(prefix));
/** Takes a URI after entity decoding, whitespace/control removal and lowercasing. */
const isDangerousUri = (normalized: string): boolean => DANGEROUS_URI_PREFIXES.some((prefix) => normalized.startsWith(prefix));
/** The same for what a link (href, src) may point to: also refuses every `data:` URI that is not a raster picture. */
const isDangerousLinkUri = (normalized: string): boolean =>
  isDangerousUri(normalized) || (normalized.startsWith(DATA_URI_PREFIX) && !RASTER_DATA_URI.test(normalized));
const normalizeUriText = (raw: string): string => decodeHtmlEntities(raw).replace(/[\s\x00-\x1f]/g, '').toLowerCase();

function skipTokenUntil(src: string, from: number, stopSlash: boolean, stopEq: boolean, stopOnLt: boolean): number {
  let i = from;
  for (const len = src.length; i < len; i++) {
    const code = src.charCodeAt(i);
    if (isWhitespaceCode(code) || code === CHAR_GT || (stopSlash && code === CHAR_SLASH) || (stopEq && code === CHAR_EQUALS) || (stopOnLt && code === CHAR_LT)) break;
  }
  return i;
}

function findTailLtOrEnd(src: string, from: number): number {
  const lt = src.indexOf('<', from);
  return lt === -1 ? src.length : lt;
}

/** Scans tag attributes: returns >0 (end pos) when closed by `>`, -1 when unclosed with stopOnLt=false, or ~nextPos (<0) when unclosed with stopOnLt=true. */
function scanTagAttributesEnd(src: string, from: number, stopOnLt: boolean): number {
  const len = src.length;
  for (let i = from; i < len; ) {
    while (i < len && (isWhitespaceCode(src.charCodeAt(i)) || src.charCodeAt(i) === CHAR_SLASH)) i++;
    if (i >= len) return stopOnLt ? ~len : -1;
    const code = src.charCodeAt(i);
    if (code === CHAR_GT) return i + 1;
    if (stopOnLt && code === CHAR_LT) return ~i;
    i = skipTokenUntil(src, i + 1, true, true, stopOnLt);
    const afterName = skipWhitespace(src, i);
    if (afterName >= len || src.charCodeAt(afterName) !== CHAR_EQUALS) { i = afterName; continue; }
    const valueStart = skipWhitespace(src, afterName + 1);
    if (valueStart >= len) return stopOnLt ? ~len : -1;
    const quote = src.charCodeAt(valueStart);
    if (quote === CHAR_DOUBLE_QUOTE || quote === CHAR_SINGLE_QUOTE) {
      const close = src.indexOf(quote === CHAR_DOUBLE_QUOTE ? '"' : "'", valueStart + 1);
      if (close === -1) return stopOnLt ? ~findTailLtOrEnd(src, valueStart + 1) : -1;
      i = close + 1;
    } else {
      i = skipTokenUntil(src, valueStart, false, false, stopOnLt);
    }
  }
  return stopOnLt ? ~len : -1;
}

/** Past `>` closing the tag whose body starts at `from`, honouring `=`-quoted values, or -1 if unterminated. */
const findTagEnd = (src: string, from: number): number => scanTagAttributesEnd(src, from, false);

function advanceOtherTag(src: string, lt: number): number {
  const nameEnd = skipTokenUntil(src, lt + 1, true, false, true);
  if (nameEnd < src.length && src.charCodeAt(nameEnd) === CHAR_LT) return ~nameEnd;
  return scanTagAttributesEnd(src, nameEnd, true);
}

function isPrefixCharCode(code: number): boolean {
  return isWordCharCode(code) || code === CHAR_HYPHEN || code === CHAR_DOT;
}

/** Given an element local name index, returns the opening `<` index accepting an optional `prefix:`, or -1. */
function tagOpenBefore(src: string, nameIndex: number, closing: boolean): number {
  let nameStart = nameIndex;
  if (src.charCodeAt(nameIndex - 1) === CHAR_COLON) {
    let prefixStart = nameIndex - 1;
    while (prefixStart > 0 && isPrefixCharCode(src.charCodeAt(prefixStart - 1))) prefixStart--;
    if (prefixStart === nameIndex - 1) return -1;
    nameStart = prefixStart;
  }
  if (closing) return src.charCodeAt(nameStart - 1) === CHAR_SLASH && src.charCodeAt(nameStart - 2) === CHAR_LT ? nameStart - 2 : -1;
  return src.charCodeAt(nameStart - 1) === CHAR_LT ? nameStart - 1 : -1;
}

function isTagEndDelimiterAt(src: string, index: number): boolean {
  if (index >= src.length) return true;
  const code = src.charCodeAt(index);
  return code === CHAR_SLASH || code === CHAR_GT || isWhitespaceCode(code);
}

function advanceScannerAtOtherLt(src: string, lt: number, currentlyUnclosed: boolean): number {
  if (isTagNameStart(src, lt + 1)) return advanceOtherTag(src, lt);
  const nextCode = src.charCodeAt(lt + 1);
  if (nextCode === CHAR_SLASH) {
    if (isAsciiAlphaAt(src, lt + 2)) return advanceOtherTag(src, lt + 1);
    if (src.charCodeAt(lt + 2) === CHAR_GT) return lt + 3;
    return ~(lt + 2);
  }
  if (nextCode === CHAR_BANG) return ~(lt + 2);
  return currentlyUnclosed ? ~(lt + 1) : lt + 1;
}

function skipTagEndOnly(src: string, lt: number): number {
  let i = lt + 1;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (isWhitespaceCode(c) || c === CHAR_SLASH || c === CHAR_GT) break;
    i++;
  }
  const end = findTagEnd(src, i);
  return end === -1 ? src.length : end;
}

function skipClosingOrBogusMarkup(src: string, lt: number): number {
  const next = src.charCodeAt(lt + 1);
  if (next === CHAR_BANG) { const gt = src.indexOf('>', lt + 2); return gt === -1 ? src.length : gt + 1; }
  if (next !== CHAR_SLASH) return -1;
  if (isAsciiAlphaAt(src, lt + 2)) return skipTagEndOnly(src, lt + 1);
  const gt = src.indexOf('>', lt + 2);
  return gt === -1 ? src.length : gt + 1;
}

/** Finds `</name ...>` (optionally namespace-prefixed) at or after `from`, returning [start, end) or null. */
function findCloseTag(lower: string, lowerName: string, from: number): [number, number] | null {
  let search = from;
  for (;;) {
    const nameIndex = lower.indexOf(lowerName, search);
    if (nameIndex === -1) return null;
    const start = tagOpenBefore(lower, nameIndex, true);
    const afterName = nameIndex + lowerName.length;
    if (start >= from && isTagEndDelimiterAt(lower, afterName)) {
      const end = findTagEnd(lower, afterName);
      return end === -1 ? null : [start, end];
    }
    search = nameIndex + 1;
  }
}

function isMatchedTagEnd(src: string, afterIdx: number, closing: boolean): boolean {
  return closing ? isTagEndDelimiterAt(src, afterIdx) : !isWordCharAt(src, afterIdx);
}

/** Matches `<name`, `<prefix:name`, or closing `</...name` at `<` index `lt`; returns index right after name, or -1. */
function matchQualifiedTagAt(
  src: string,
  lower: string,
  lt: number,
  lowerName: string,
  closing: boolean,
  mayHavePrefix: boolean
): number {
  let pos = lt + 1;
  if (closing) {
    if (src.charCodeAt(pos) !== CHAR_SLASH) return -1;
    pos++;
  }
  const directEnd = pos + lowerName.length;
  if (lower.startsWith(lowerName, pos) && isMatchedTagEnd(src, directEnd, closing)) return directEnd;
  if (!mayHavePrefix) return -1;
  let colon = pos;
  while (colon < src.length && isPrefixCharCode(src.charCodeAt(colon))) colon++;
  const afterPrefixed = colon + 1 + lowerName.length;
  return colon > pos && src.charCodeAt(colon) === CHAR_COLON && lower.startsWith(lowerName, colon + 1) && isMatchedTagEnd(src, afterPrefixed, closing)
    ? afterPrefixed
    : -1;
}

const SPECIAL_NEEDLES = ['"', "'", COMMENT_OPEN, CDATA_OPEN, PI_OPEN] as const;

function nextSpecialPos(src: string, from: number, cached: Int32Array): number {
  const len = src.length;
  let best = len;
  for (let i = 0; i < 5; i++) {
    let pos = cached[i];
    if (pos < from) { pos = src.indexOf(SPECIAL_NEEDLES[i], from); cached[i] = pos === -1 ? len : pos; pos = cached[i]; }
    if (pos < best) best = pos;
  }
  return best;
}

function indexOfOrLen(haystack: string, needle: string, from: number): number {
  const idx = haystack.indexOf(needle, from);
  return idx === -1 ? haystack.length : idx;
}

function fastJumpBefore(src: string, lt: number, stop: number): number {
  if (stop - lt <= 64) return -1;
  const prevLt = src.lastIndexOf('<', stop - 1);
  const prevGt = src.lastIndexOf('>', stop - 1);
  if (prevGt >= lt && prevGt > prevLt) return stop;
  if (prevLt > lt) {
    const code = src.charCodeAt(prevLt + 1);
    if (isTagNameStart(src, prevLt + 1) || code === CHAR_SLASH || code === CHAR_BANG) return ~prevLt;
  }
  return -1;
}

/** Pushes matched open/close span and returns >0 next search pos, <0 (~nextPos) when unclosed, or 0 to break on EOF open tag. */
function scanMatchedElement(
  src: string,
  lt: number,
  afterName: number,
  starts: number[],
  ends: number[],
  isClose: boolean[],
): number {
  if (src.charCodeAt(lt + 1) === CHAR_SLASH) {
    const closeStep = scanTagAttributesEnd(src, afterName, true);
    if (closeStep <= 0) return closeStep;
    starts.push(lt);
    ends.push(closeStep);
    isClose.push(true);
    return closeStep;
  }
  const tagEnd = findTagEnd(src, afterName);
  starts.push(lt);
  ends.push(tagEnd === -1 ? src.length : tagEnd);
  isClose.push(false);
  return tagEnd === -1 ? 0 : tagEnd;
}

/** The cursor and caches of one `collectElementSpans` pass; created once per pass, never per element. */
interface ElementScan {
  src: string; lower: string; lowerName: string; paired: boolean;
  mayHavePrefix: boolean; firstCode: number; len: number; cachedSpecial: Int32Array | null;
  nextCand: number; search: number; unclosedTag: boolean; cachedGt: number;
  starts: number[]; ends: number[]; isClose: boolean[];
}

/** Moves the cursor from a step code: >0 is the next search position, <0 (~nextPos) means the tag stayed unclosed. */
function applyScanStep(scan: ElementScan, step: number): void {
  scan.unclosedTag = step < 0;
  scan.search = step < 0 ? ~step : step;
}

/** The position just after the name of an element at `lt` that the scan is looking for, or -1. */
function matchedNameEnd(scan: ElementScan, lt: number, nextCode: number): number {
  const { src, lower, lowerName, mayHavePrefix } = scan;
  const isCloseTag = nextCode === CHAR_SLASH;
  const mayMatch = (!isCloseTag || scan.paired) && (mayHavePrefix || lower.charCodeAt(lt + (isCloseTag ? 2 : 1)) === scan.firstCode);
  return mayMatch ? matchQualifiedTagAt(src, lower, lt, lowerName, isCloseTag, mayHavePrefix) : -1;
}

/** Clears `unclosedTag` once the `>` that ends the unclosed tag lies before `lt`. */
function refreshUnclosedTag(scan: ElementScan, lt: number): void {
  if (!scan.unclosedTag) return;
  if (scan.cachedGt < scan.search) scan.cachedGt = indexOfOrLen(scan.src, '>', scan.search);
  if (scan.cachedGt < lt) scan.unclosedTag = false;
}

/** Runs one step of the pass; returns false when the pass is over. */
function stepElementScan(scan: ElementScan): boolean {
  const { src, lower, lowerName, len } = scan;
  const lt = src.indexOf('<', scan.search);
  if (lt === -1) return false;
  if (scan.nextCand < lt) scan.nextCand = indexOfOrLen(lower, lowerName, lt);
  const nextSpec = scan.cachedSpecial === null ? len : nextSpecialPos(src, lt, scan.cachedSpecial);
  if (scan.nextCand >= len && nextSpec >= len) return false;
  const jump = fastJumpBefore(src, lt, Math.min(scan.nextCand, nextSpec));
  if (jump >= 0) { scan.unclosedTag = false; scan.search = jump; return true; }
  if (jump <= -2) { scan.search = ~jump; return true; }
  refreshUnclosedTag(scan, lt);
  const nextCode = src.charCodeAt(lt + 1);
  if (!scan.unclosedTag && (nextCode === CHAR_BANG || nextCode === CHAR_QUESTION)) {
    const skipTo = skipNonTagMarkup(src, lt);
    if (skipTo !== -1) { scan.search = skipTo; return true; }
  }
  const afterName = matchedNameEnd(scan, lt, nextCode);
  if (afterName === -1) {
    applyScanStep(scan, advanceScannerAtOtherLt(src, lt, scan.unclosedTag));
    return true;
  }
  const spanStep = scanMatchedElement(src, lt, afterName, scan.starts, scan.ends, scan.isClose);
  if (spanStep === 0) return false;
  applyScanStep(scan, spanStep);
  return true;
}

function collectElementSpans(src: string, lower: string, lowerName: string, paired: boolean): [number[], number[], boolean[]] {
  const scan: ElementScan = {
    src, lower, lowerName, paired,
    mayHavePrefix: lower.includes(`:${lowerName}`), firstCode: lowerName.charCodeAt(0), len: src.length,
    cachedSpecial: RE_HAS_SPECIAL.test(src) ? new Int32Array(5).fill(-1) : null,
    nextCand: -1, search: 0, unclosedTag: false, cachedGt: -1, starts: [], ends: [], isClose: [],
  };
  // Each step advances `search`; the pass ends at the end of the source or when a step reports it is over.
  while (scan.search < scan.len && stepElementScan(scan));
  return [scan.starts, scan.ends, scan.isClose];
}

/** Removes `<name>` or `<prefix:name>` elements in linear time, skipping comments, CDATA, PIs, and quoted attributes. */
function stripElement(src: string, lower: string, lowerName: string, paired: boolean): string {
  if (!lower.includes(lowerName)) return src;
  const [starts, ends, isClose] = collectElementSpans(src, lower, lowerName, paired);
  if (starts.length === 0) return src;

  const spanEnds = new Int32Array(starts.length).fill(-1);
  const openStack: number[] = [];
  for (let t = 0; t < starts.length; t++) {
    if (!paired || !isClose[t]) {
      spanEnds[t] = ends[t];
      if (paired && ends[t] < src.length) openStack.push(t);
    } else if (openStack.length > 0) spanEnds[openStack.pop()!] = ends[t];
    else spanEnds[t] = ends[t];
  }

  const parts: string[] = [];
  let copied = 0;
  for (let t = 0; t < starts.length; t++) {
    if (spanEnds[t] === -1 || starts[t] < copied) continue;
    parts.push(src.slice(copied, starts[t]));
    copied = spanEnds[t];
  }
  parts.push(src.slice(copied));
  return parts.join('');
}

/** Advances past a quoted literal, comment, or subset PI inside DOCTYPE; returns -1 if unterminated, null otherwise. */
function skipDoctypeToken(src: string, pos: number, allowPi: boolean, code: number): number | null {
  if (code === CHAR_DOUBLE_QUOTE || code === CHAR_SINGLE_QUOTE) {
    const close = src.indexOf(code === CHAR_DOUBLE_QUOTE ? '"' : "'", pos + 1);
    return close === -1 ? -1 : close + 1;
  }
  if (code === CHAR_LT) {
    if (src.startsWith(COMMENT_OPEN, pos)) {
      const close = src.indexOf(COMMENT_CLOSE, pos + COMMENT_OPEN_LENGTH);
      return close === -1 ? -1 : close + COMMENT_CLOSE.length;
    }
    if (allowPi && src.startsWith(PI_OPEN, pos)) {
      const close = src.indexOf(PI_CLOSE, pos + PI_OPEN.length);
      return close === -1 ? -1 : close + PI_CLOSE.length;
    }
  }
  return null;
}

function findDoctypeEnd(src: string, afterName: number): number {
  let pos = afterName;
  let depth = 0;
  const len = src.length;
  while (pos < len) {
    const code = src.charCodeAt(pos);
    if (code === CHAR_DOUBLE_QUOTE || code === CHAR_SINGLE_QUOTE || code === CHAR_LT) {
      const jumped = skipDoctypeToken(src, pos, depth > 0, code);
      if (jumped !== null) {
        if (jumped === -1) return -1;
        pos = jumped; continue;
      }
    }
    if (code === CHAR_LBRACKET) depth++;
    else if (depth > 0 && code === CHAR_RBRACKET && --depth === 0) {
      const k = skipWhitespace(src, pos + 1);
      return src.charCodeAt(k) === CHAR_GT ? k + 1 : -1;
    } else if (depth === 0 && code === CHAR_GT) {
      return pos + 1;
    }
    pos++;
  }
  return -1;
}

/** Removes DOCTYPE declarations including quoted literals, comments, and internal subsets in linear time (fail closed on EOF). */
function stripDoctype(src: string, lower: string = lowerKeepingLength(src)): string {
  if (!lower.includes('doctype')) return src;
  const parts: string[] = [];
  let copied = 0, search = 0, unclosedTag = false, cachedGt = -1;
  while (search < src.length) {
    const lt = src.indexOf('<', search);
    if (lt === -1) break;
    if (unclosedTag) {
      if (cachedGt < search) { const gt = src.indexOf('>', search); cachedGt = gt === -1 ? src.length : gt; }
      if (cachedGt < lt) unclosedTag = false;
    }
    const afterName = lt + DOCTYPE_OPEN.length;
    if (lower.startsWith(DOCTYPE_OPEN, lt) && !isWordCharAt(src, afterName)) {
      unclosedTag = false; parts.push(src.slice(copied, lt));
      const end = findDoctypeEnd(src, afterName);
      if (end === -1) return parts.join('');
      copied = end; search = end; continue;
    }
    if (!unclosedTag) {
      const nextCode = src.charCodeAt(lt + 1);
      if (nextCode === CHAR_BANG || nextCode === CHAR_QUESTION) {
        const skipTo = skipNonTagMarkup(src, lt, false);
        if (skipTo !== -1) { search = skipTo; continue; }
      }
    }
    const step = advanceScannerAtOtherLt(src, lt, unclosedTag);
    unclosedTag = step < 0; search = step < 0 ? ~step : step;
  }
  if (copied === 0 && parts.length === 0) return src;
  parts.push(src.slice(copied));
  return parts.join('');
}

/** Removes processing instructions in linear time except a safe start XML declaration (BOM allowed); unterminated ones strip to EOF. */
function stripProcessingInstructions(src: string): string {
  if (!src.includes('?')) return src;
  const parts: string[] = [];
  let copied = 0, search = 0;
  for (;;) {
    const lt = src.indexOf('<', search);
    if (lt === -1) break;
    if (!src.startsWith(PI_OPEN, lt)) {
      const skipTo = skipNonTagMarkup(src, lt);
      if (skipTo !== -1) { search = skipTo; continue; }
      const bogusEnd = skipClosingOrBogusMarkup(src, lt);
      if (bogusEnd !== -1) {
        search = bogusEnd;
      } else {
        search = isTagNameStart(src, lt + 1) ? skipTagEndOnly(src, lt) : lt + 1;
      }
      continue;
    }
    const close = src.indexOf(PI_CLOSE, lt + PI_OPEN.length);
    const end = close === -1 ? src.length : close + PI_CLOSE.length;
    if (!isXmlDeclarationAt(src, lt, close)) { parts.push(src.slice(copied, lt)); copied = end; }
    search = end;
  }
  if (copied === 0 && parts.length === 0) return src;
  parts.push(src.slice(copied));
  return parts.join('');
}

/** True for `<?xml` followed by white space or `?>` at document start without embedded `<`/`>` (BOM may come first). */
function isXmlDeclarationAt(src: string, lt: number, close: number): boolean {
  if (close === -1 || (lt !== 0 && !(lt === 1 && src.charCodeAt(0) === BYTE_ORDER_MARK))) return false;
  const afterTarget = lt + XML_DECLARATION_OPEN.length;
  if (!src.startsWith(XML_DECLARATION_OPEN, lt)) return false;
  if (!isWhitespaceAt(src, afterTarget) && afterTarget !== close) return false;
  const body = src.slice(afterTarget, close);
  return !body.includes('<') && !body.includes('>');
}

/** Removes XML comments in linear time; an unterminated comment is removed through the end of input. */
function stripComments(src: string): string {
  const parts: string[] = [];
  let copied = 0;
  for (;;) {
    const start = src.indexOf(COMMENT_OPEN, copied);
    if (start === -1) break;
    parts.push(src.slice(copied, start));
    const close = src.indexOf(COMMENT_CLOSE, start + COMMENT_OPEN_LENGTH);
    if (close === -1) { copied = src.length; break; }
    copied = close + COMMENT_CLOSE.length;
  }
  if (copied === 0 && parts.length === 0) return src;
  parts.push(src.slice(copied));
  return parts.join('');
}

interface CssEdit { start: number; end: number; replacement: string; }

/** CSS text with comments removed and escapes decoded, plus the original span of every decoded code unit. */
interface DecodedCss { text: string; starts: Uint32Array; ends: Uint32Array; escaped: Uint8Array; }

function isHexDigitCode(code: number): boolean {
  return (code >= CHAR_DIGIT_0 && code <= CHAR_DIGIT_9) || (code >= CHAR_LOWER_A && code <= CHAR_LOWER_F) || (code >= ASCII_UPPER_A && code <= CHAR_UPPER_F);
}
function hexDigitValue(code: number): number {
  if (code <= CHAR_DIGIT_9) return code - CHAR_DIGIT_0;
  return code >= CHAR_LOWER_A ? code - CHAR_LOWER_A + HEX_LETTER_OFFSET : code - ASCII_UPPER_A + HEX_LETTER_OFFSET;
}
const isCssNewlineCode = (code: number): boolean => code === CHAR_LF || code === CHAR_CR || code === CHAR_FF;
const isCssWhitespaceCode = (code: number): boolean => isCssNewlineCode(code) || code === CHAR_SPACE || code === CHAR_TAB;
const cssNewlineLength = (css: string, index: number): number => (css.charCodeAt(index) === CHAR_CR && css.charCodeAt(index + 1) === CHAR_LF ? 2 : 1);

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
    this.units[this.count] = unit; this.starts[this.count] = start; this.ends[this.count] = end;
    this.escaped[this.count++] = escaped ? 1 : 0;
  }

  /** Appends a code point (two units when astral). Invalid code points fail closed. */
  pushCodePoint(codePoint: number, start: number, end: number, what: string, escaped = false): void {
    if (codePoint === 0 || (codePoint >= SURROGATE_MIN && codePoint <= SURROGATE_MAX) || codePoint > MAX_CODE_POINT) {
      throw new SvgSanitizationError(`SVG contains ${what} that decodes to an invalid code point.`);
    }
    if (codePoint <= BMP_MAX) { this.push(codePoint, start, end, escaped); return; }
    const offset = codePoint - BMP_MAX - 1;
    this.push(HIGH_SURROGATE_BASE + (offset >> SURROGATE_SHIFT), start, end, escaped);
    this.push(LOW_SURROGATE_BASE + (offset & SURROGATE_LOW_MASK), start, end, escaped);
  }

  finish(): DecodedCss {
    const text = Buffer.from(this.units.buffer, 0, this.count * Uint16Array.BYTES_PER_ELEMENT).toString('utf16le');
    return { text, starts: this.starts.subarray(0, this.count), ends: this.ends.subarray(0, this.count), escaped: this.escaped.subarray(0, this.count) };
  }

  /** True when the decoded units just emitted spell an ASCII `url` identifier token (CSS Syntax Level 3 §4.3.3). */
  endsWithUrlIdent(): boolean {
    if (this.count < 3) return false;
    if ((this.units[this.count - 3] | ASCII_CASE_OFFSET) !== 0x75 || (this.units[this.count - 2] | ASCII_CASE_OFFSET) !== 0x72 || (this.units[this.count - 1] | ASCII_CASE_OFFSET) !== 0x6c) return false;
    if (this.count === 3) return true;
    if (this.escaped[this.count - 4] === 1) return false;
    const prev = this.units[this.count - 4];
    return !((prev >= CHAR_DIGIT_0 && prev <= CHAR_DIGIT_9) || (prev >= ASCII_UPPER_A && prev <= ASCII_UPPER_Z) || (prev >= CHAR_LOWER_A && prev <= 0x7a) || prev === 0x5f || prev === 0x2d || prev >= 0x80);
  }
}

function startsQuotedUrlArg(css: string, afterOpenParen: number): boolean {
  let k = afterOpenParen;
  while (k < css.length && isCssWhitespaceCode(css.charCodeAt(k))) k++;
  if (k >= css.length) return false;
  const code = css.charCodeAt(k);
  return code === CHAR_DOUBLE_QUOTE || code === CHAR_SINGLE_QUOTE;
}

/**
 * Decodes CSS comments and escapes (CSS Syntax 4.3.7) in one linear pass so keywords can be matched the way a
 * CSS parser sees them, honouring quoted strings (`<string-token>` / `<bad-string-token>`, CSS Syntax 4.3.4) and
 * unquoted `url(...)` tokens (`<url-token>` / `<bad-url-token>`, CSS Syntax 4.3.6 & 4.3.14) so comment markers or
 * stray quotes inside literals cannot mask later rules. Returns null when the text has neither `\` nor `/*`.
 * Escapes that decode to NUL, a surrogate or a code point above U+10FFFF throw (fail closed).
 */
function decodeCss(css: string): DecodedCss | null {
  if (!css.includes('\\') && !css.includes('/*')) return null;
  const length = css.length;
  const out = new DecodeBuffer(length);

  let quote = 0;
  let inUnquotedUrl = false;
  let i = 0;
  while (i < length) {
    const code = css.charCodeAt(i);
    if (quote === 0 && !inUnquotedUrl && code === CHAR_SLASH && css.charCodeAt(i + 1) === CHAR_STAR) {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? length : close + 2;
      continue;
    }
    if (code !== CHAR_BACKSLASH) {
      if (quote !== 0) {
        if (code === quote || isCssNewlineCode(code)) quote = 0;
      } else if (inUnquotedUrl) {
        if (code === CHAR_CLOSE_PAREN) inUnquotedUrl = false;
      } else if (code === CHAR_DOUBLE_QUOTE || code === CHAR_SINGLE_QUOTE) {
        quote = code;
      } else if (code === CHAR_OPEN_PAREN && out.endsWithUrlIdent() && !startsQuotedUrlArg(css, i + 1)) {
        inUnquotedUrl = true;
      }
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
  if (i >= length) return null;
  const first = text.charCodeAt(i);
  if (first === CHAR_HASH) {
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
  if (first !== CHAR_LOWER_A && first !== CHAR_LOWER_G && first !== CHAR_LOWER_L && first !== CHAR_LOWER_Q) return null;
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
function findClosingParen(text: string, from: number, escaped: Uint8Array | null, allowQuotes = true): number {
  let depth = 1;
  let quote = 0;
  for (let i = from; i < text.length; i++) {
    if (escaped !== null && escaped[i] === 1) continue;
    const code = text.charCodeAt(i);
    if (quote !== 0) {
      if (code === quote) quote = 0;
    } else if (allowQuotes && (code === CHAR_DOUBLE_QUOTE || code === CHAR_SINGLE_QUOTE)) {
      quote = code;
    } else if (code === CHAR_OPEN_PAREN) {
      depth++;
    } else if (code === CHAR_CLOSE_PAREN && --depth === 0) {
      return i + 1;
    }
  }
  return text.length;
}

/** Strict allowlist: clean `#fragment` IDs and safe raster `data:image/(png|jpeg|gif|webp)` URIs only. */
function isAllowedCssTarget(text: string, from: number, to: number, escaped: Uint8Array | null): boolean {
  const raw = text.slice(from, to), s = raw.trim();
  if (!s) return false;
  let token: string | null = s;
  const q = s.charCodeAt(0), lead = raw.indexOf(s);
  const esc = escaped !== null && (escaped[from + lead] === 1 || escaped[from + lead + s.length - 1] === 1);
  if ((q === CHAR_DOUBLE_QUOTE || q === CHAR_SINGLE_QUOTE) && !esc && s.length >= 2 && s.charCodeAt(s.length - 1) === q) {
    token = s.slice(1, -1).includes(s[0]) ? null : s.slice(1, -1).trim();
  }
  if (!token) return false;
  if (SAFE_FRAGMENT_ID.test(token)) return true;
  // eslint-disable-next-line no-control-regex -- strip ignored ASCII control characters before checking data URI scheme
  const stripped = token.replace(/[\x00-\x1f\x7f]/g, ''), comma = stripped.indexOf(',');
  return comma >= 0 && RASTER_DATA_URI.test(stripped.slice(0, comma + 1).toLowerCase()) && !/[<>"'()\\]/.test(stripped.slice(comma + 1));
}
function isAllowedImageSetItem(text: string, from: number, to: number, escaped: Uint8Array | null): boolean {
  const slice = text.slice(from, to), trimmed = slice.trimStart();
  if (!trimmed) return false;
  let pos = from + (slice.length - trimmed.length), code = text.charCodeAt(pos);
  if ((code === CHAR_DOUBLE_QUOTE || code === CHAR_SINGLE_QUOTE) && escaped?.[pos] !== 1) {
    let qEnd = pos + 1;
    while (qEnd < to && (text.charCodeAt(qEnd) !== code || escaped?.[qEnd] === 1)) qEnd++;
    if (qEnd >= to || !isAllowedCssTarget(text, pos, qEnd + 1, escaped)) return false;
    pos = qEnd + 1;
  } else {
    IMAGE_SET_URL_AT.lastIndex = pos;
    const match = IMAGE_SET_URL_AT.exec(text), argsAt = match ? pos + match[0].length : -1;
    const uEnd = argsAt >= 0 ? findClosingParen(text, argsAt, escaped) : -1;
    if (uEnd < 0 || uEnd > to || text.charCodeAt(uEnd - 1) !== CHAR_CLOSE_PAREN || !isAllowedCssTarget(text, argsAt, uEnd - 1, escaped)) return false;
    pos = uEnd;
  }
  const tail = text.slice(pos, to).trim();
  return tail.length === 0 || SAFE_IMAGE_SET_DESCRIPTOR.test(tail);
}
function isAllowedImageSet(text: string, from: number, to: number, escaped: Uint8Array | null): boolean {
  for (let i = from, depth = 0, quote = 0, itemStart = from; i <= to; i++) {
    if (i === to) return quote === 0 && depth === 0 && isAllowedImageSetItem(text, itemStart, to, escaped);
    if (escaped?.[i] === 1) continue;
    const c = text.charCodeAt(i);
    if (quote !== 0) { if (c === quote) quote = 0; continue; }
    if (c === CHAR_DOUBLE_QUOTE || c === CHAR_SINGLE_QUOTE) quote = c;
    else if (c === CHAR_OPEN_PAREN) depth++;
    else if (c === CHAR_CLOSE_PAREN) { if (depth-- === 0) return false; }
    else if (c === 0x2c && depth === 0) { if (!isAllowedImageSetItem(text, itemStart, i, escaped)) return false; itemStart = i + 1; }
  }
  return false;
}
/** Neutralize every url(), src(), and image-set() call outside the `#fragment` + safe raster `data:` allowlist to `none`. */
function collectExternalReferenceEdits(text: string, escaped: Uint8Array | null): CssEdit[] {
  const edits: CssEdit[] = [];
  for (let scanned = 0, it = text.matchAll(CSS_URL_FUNCTION_START), step = it.next(); !step.done; step = it.next()) {
    const match = step.value;
    if (match.index < scanned) continue;
    const argsStart = match.index + match[0].length, isImageSet = match[1].toLowerCase().endsWith(IMAGE_SET_SUFFIX);
    let p = argsStart;
    while (!isImageSet && p < text.length && text.charCodeAt(p) <= CHAR_SPACE) p++;
    const allowQuotes = isImageSet || ((text.charCodeAt(p) === CHAR_DOUBLE_QUOTE || text.charCodeAt(p) === CHAR_SINGLE_QUOTE) && escaped?.[p] !== 1);
    const end = scanned = findClosingParen(text, argsStart, escaped, allowQuotes);
    const ok = end > argsStart && text.charCodeAt(end - 1) === CHAR_CLOSE_PAREN && (isImageSet ? isAllowedImageSet(text, argsStart, end - 1, escaped) : isAllowedCssTarget(text, argsStart, end - 1, escaped));
    if (!ok) edits.push({ start: match.index, end, replacement: 'none' });
  }
  return edits;
}

const CSS_IMPORT_KEYWORD = /@import/gi;
const CHAR_CLOSE_BRACE = 0x7d;

/** Finds the end of an `@import` rule starting at `from`, skipping `;` inside quotes or parentheses. */
function findImportRuleEnd(text: string, from: number, escaped: Uint8Array | null): number {
  let quote = 0, parenDepth = 0;
  for (let i = from; i < text.length; i++) {
    if (escaped !== null && escaped[i] === 1) continue;
    const code = text.charCodeAt(i);
    if (quote !== 0) { if (code === quote || isCssNewlineCode(code)) quote = 0; }
    else if (code === CHAR_DOUBLE_QUOTE || code === CHAR_SINGLE_QUOTE) quote = code;
    else if (code === CHAR_OPEN_PAREN) parenDepth++;
    else if (code === CHAR_CLOSE_PAREN) { if (parenDepth > 0) parenDepth--; }
    else if (parenDepth === 0 && code === CHAR_SEMICOLON) return i + 1;
    else if (parenDepth === 0 && code === CHAR_CLOSE_BRACE) return i;
  }
  return text.length;
}

function collectImportEdits(text: string, escaped: Uint8Array | null): CssEdit[] {
  const edits: CssEdit[] = [];
  let scanned = 0;
  for (const match of text.matchAll(CSS_IMPORT_KEYWORD)) {
    if (match.index < scanned) continue;
    const end = findImportRuleEnd(text, match.index + match[0].length, escaped);
    edits.push({ start: match.index, end, replacement: '' }); scanned = end;
  }
  return edits;
}

/** Finds the `@import` rules and external references in already decoded CSS. */
function collectCssEdits(text: string, escaped: Uint8Array | null): CssEdit[] {
  const edits: CssEdit[] = [];
  let lastEnd = 0;
  for (const edit of [...collectImportEdits(text, escaped), ...collectExternalReferenceEdits(text, escaped)].sort((a, b) => a.start - b.start)) {
    if (edit.start < lastEnd) continue;
    edits.push(edit); lastEnd = edit.end;
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

/** Rewrites every <style> element so its body is sanitized; an unterminated element is closed at end of input. */
function sanitizeStyleElements(src: string, lower: string = lowerKeepingLength(src)): string {
  if (!lower.includes('yle')) return src;
  const parts: string[] = [];
  let copied = 0, search = 0;

  for (;;) {
    const nameIndex = lower.indexOf(STYLE_ELEMENT, search);
    if (nameIndex === -1) break;
    const start = tagOpenBefore(lower, nameIndex, false), afterName = nameIndex + STYLE_ELEMENT.length;
    if (start < copied || isWordCharAt(src, afterName)) { search = nameIndex + 1; continue; }
    parts.push(src.slice(copied, start));
    const tagEnd = findTagEnd(src, afterName);
    if (tagEnd === -1) { copied = src.length; break; }
    // The qualified name (including any namespace prefix) is kept so the element stays in its namespace.
    const qualifiedName = src.slice(start + 1, afterName);
    const { close, openCdata } = findStyleCloseTag(src, lower, tagEnd);
    const bodyEnd = close === null ? src.length : close[0];
    // An unterminated CDATA section is closed so that the output is a fixed point of this rewrite.
    const cdataTerminator = openCdata ? CDATA_CLOSE : '';
    parts.push(`<${qualifiedName}>${sanitizeCss(src.slice(tagEnd, bodyEnd), true)}${cdataTerminator}</${qualifiedName}>`);
    copied = close === null ? src.length : close[1];
    search = copied;
  }
  if (copied === 0 && parts.length === 0) return src;
  parts.push(src.slice(copied));
  return parts.join('');
}

interface TagAttribute { name: string; start: number; end: number; value: string; }
interface TagToken { name: string; attributes: TagAttribute[]; end: number; terminated: boolean; }

function isTagNameStart(src: string, index: number): boolean {
  if (index >= src.length) return false;
  const code = src.charCodeAt(index);
  return code >= 0x80 ? !isWhitespaceCode(code) : code === CHAR_UNDERSCORE || code === CHAR_COLON || isAsciiAlphaCode(code);
}

function skipWhitespace(src: string, from: number): number {
  let i = from;
  while (i < src.length && isWhitespaceCode(src.charCodeAt(i))) i++;
  return i;
}

/** Returns tag end (>0) when the tag at `lt` has no attributes, or -1 if attributes may follow. */
function trySkipEmptyTagEnd(src: string, lt: number): number {
  const len = src.length;
  let i = lt + 1;
  while (i < len) { const c = src.charCodeAt(i); if (isWhitespaceCode(c) || c === CHAR_SLASH || c === CHAR_GT) break; i++; }
  while (i < len && (isWhitespaceCode(src.charCodeAt(i)) || src.charCodeAt(i) === CHAR_SLASH)) i++;
  if (i >= len) return len;
  return src.charCodeAt(i) === CHAR_GT ? i + 1 : -1;
}

/**
 * Tokenizes the tag opening at `lt` the way an HTML/XML parser does: whitespace, '/' and the end of a quoted
 * value all separate attributes, so `<svg/onload=x>` and `<svg a="b"onload=x>` expose an `onload` attribute.
 */
function readTag(src: string, lt: number): TagToken {
  const length = src.length;
  let i = lt + 1;
  while (i < length) { const c = src.charCodeAt(i); if (isWhitespaceCode(c) || c === CHAR_SLASH || c === CHAR_GT) break; i++; }
  const name = src.slice(lt + 1, i), attributes: TagAttribute[] = [];

  for (;;) {
    while (i < length && (isWhitespaceCode(src.charCodeAt(i)) || src.charCodeAt(i) === CHAR_SLASH)) i++;
    if (i >= length) return { name, attributes, end: length, terminated: false };
    if (src.charCodeAt(i) === CHAR_GT) return { name, attributes, end: i + 1, terminated: true };

    const start = i;
    i++;
    while (i < length) { const c = src.charCodeAt(i); if (isWhitespaceCode(c) || c === CHAR_SLASH || c === CHAR_GT || c === CHAR_EQUALS) break; i++; }
    const attrName = src.slice(start, i), afterName = skipWhitespace(src, i);
    if (afterName >= length || src.charCodeAt(afterName) !== CHAR_EQUALS) { attributes.push({ name: attrName, start, end: i, value: '' }); continue; }

    const valueStart = skipWhitespace(src, afterName + 1);
    if (valueStart >= length) { attributes.push({ name: attrName, start, end: length, value: '' }); return { name, attributes, end: length, terminated: false }; }
    const quote = src.charCodeAt(valueStart);
    if (quote === CHAR_DOUBLE_QUOTE || quote === CHAR_SINGLE_QUOTE) {
      const close = src.indexOf(quote === CHAR_DOUBLE_QUOTE ? '"' : "'", valueStart + 1);
      if (close === -1) { attributes.push({ name: attrName, start, end: length, value: src.slice(valueStart + 1) }); return { name, attributes, end: length, terminated: false }; }
      attributes.push({ name: attrName, start, end: close + 1, value: src.slice(valueStart + 1, close) }); i = close + 1;
    } else {
      let valueEnd = valueStart;
      while (valueEnd < length && !isWhitespaceCode(src.charCodeAt(valueEnd)) && src.charCodeAt(valueEnd) !== CHAR_GT) valueEnd++;
      attributes.push({ name: attrName, start, end: valueEnd, value: src.slice(valueStart, valueEnd) }); i = valueEnd;
    }
  }
}

/**
 * When the markup at `lt` is a comment, CDATA section or processing instruction, returns the index just past
 * its terminator (the end of input when unterminated), so its contents are never tokenized as tags. Returns -1
 * for anything else. The HTML-only shorthands `<!-->` and `<!--->` are parsed differently by XML and HTML
 * parsers, so they are rejected (fail closed).
 */
function skipNonTagMarkup(src: string, lt: number, rejectShorthand = true): number {
  const next = src.charCodeAt(lt + 1);
  if (next === CHAR_BANG) {
    if (src.startsWith(COMMENT_OPEN, lt)) {
      const bodyStart = lt + COMMENT_OPEN_LENGTH;
      if (rejectShorthand && (src.startsWith('>', bodyStart) || src.startsWith('->', bodyStart))) {
        throw new SvgSanitizationError('SVG contains a malformed comment that parsers disagree on.');
      }
      const close = src.indexOf(COMMENT_CLOSE, bodyStart);
      return close === -1 ? src.length : close + COMMENT_CLOSE.length;
    }
    if (src.startsWith(CDATA_OPEN, lt)) {
      const close = src.indexOf(CDATA_CLOSE, lt + CDATA_OPEN.length);
      return close === -1 ? src.length : close + CDATA_CLOSE.length;
    }
    return -1;
  }
  if (next === CHAR_QUESTION && src.startsWith(PI_OPEN, lt)) {
    const close = src.indexOf(PI_CLOSE, lt + PI_OPEN.length);
    return close === -1 ? src.length : close + PI_CLOSE.length;
  }
  return -1;
}

/** True for an on* event handler or a form attribute (`action`, `formaction`), by its local name whatever the prefix. */
function isForbiddenAttributeName(attributeName: string): boolean {
  const lowered = attributeName.replace(/^["'=]+/, '').toLowerCase();
  const local = lowered.slice(lowered.lastIndexOf(':') + 1);
  return (local.length > EVENT_PREFIX.length && local.startsWith(EVENT_PREFIX)) || FORM_ATTRIBUTES.has(local);
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
  return hasCssReference || CSS_EXPRESSION_PROBE.test(text) || text.replace(/[\s\x00-\x1f]/g, '').toLowerCase().includes(SCRIPT_URI_PROBE);
}

/** True when a value written into a presentation attribute holds an external url(), src() or image-set(). */
function hasExternalReference(raw: string): boolean {
  try {
    return sanitizeCss(raw, false) !== raw;
  } catch (error) {
    if (error instanceof SvgSanitizationError) return true;
    throw error;
  }
}

/** True when any `;`-separated item of an animation value is a dangerous URI (entities decoded before split). */
function hasDangerousUriItem(raw: string, isDangerous: (normalized: string) => boolean = isDangerousUri): boolean {
  return decodeHtmlEntities(raw).split(ANIMATION_VALUE_SEPARATOR).some((item) => isDangerous(normalizeUriText(item)));
}

/** True when any `;`-separated item of an animation value is a script-capable URI, whatever attribute it targets. */
function hasScriptUriItem(raw: string): boolean {
  return decodeHtmlEntities(raw).split(ANIMATION_VALUE_SEPARATOR).some((item) => isScriptUri(normalizeUriText(item)));
}

/** True when `isHostile` accepts the raw value of any to/from/by/values attribute. */
function hasAnimationValue(tag: TagToken, isHostile: (value: string) => boolean): boolean {
  return tag.attributes.some((attribute) => ANIMATION_VALUE_ATTRIBUTES.has(attribute.name.toLowerCase()) && isHostile(attribute.value));
}

/** True for animation elements targeting event handlers or dangerous URIs (e.g. `<set attributeName="onclick" to="alert(1)"/>`). */
function isHostileAnimation(tag: TagToken): boolean {
  if (tag.attributes.length === 0 || !ANIMATION_ELEMENTS.has(localNameOf(tag.name))) return false;
  const target = tag.attributes.find((attribute) => attribute.name.toLowerCase() === 'attributename');
  if (target === undefined) return hasAnimationValue(tag, hasScriptUriItem);
  const targetName = localNameOf(normalizeUriText(target.value));
  if (isForbiddenAttributeName(targetName)) return true;
  if (targetName === STYLE_ATTRIBUTE) return hasAnimationValue(tag, isHostileStyleValue);
  if (PRESENTATION_URL_ATTRIBUTES.has(targetName)) return hasAnimationValue(tag, (v) => hasExternalReference(v) || hasScriptUriItem(v));
  if (LINK_ATTRIBUTES.has(targetName)) return hasAnimationValue(tag, (value) => hasDangerousUriItem(value, isDangerousLinkUri));
  return hasAnimationValue(tag, hasScriptUriItem);
}

/** Removes every on* and form attribute and hostile animation element in linear time while leaving non-tag text untouched. */
function stripEventHandlerAttributes(src: string, lower: string): string {
  if (!RE_EVENT_PREFILTER.test(lower)) return src;
  const parts: string[] = [];
  let copied = 0, search = 0;
  for (;;) {
    const lt = src.indexOf('<', search);
    if (lt === -1) break;
    const skipTo = skipNonTagMarkup(src, lt);
    if (skipTo !== -1) { search = skipTo; continue; }
    const bogusEnd = skipClosingOrBogusMarkup(src, lt);
    if (bogusEnd !== -1) { search = bogusEnd; continue; }
    if (!isTagNameStart(src, lt + 1)) { search = lt + 1; continue; }
    const emptyEnd = trySkipEmptyTagEnd(src, lt);
    if (emptyEnd !== -1) { search = emptyEnd; continue; }
    const tag = readTag(src, lt);
    if (isHostileAnimation(tag)) { parts.push(src.slice(copied, lt)); copied = tag.end; search = tag.end; continue; }
    for (const attribute of tag.attributes) {
      if (!isForbiddenAttributeName(attribute.name)) continue;
      let removeStart = attribute.start;
      while (removeStart > copied && isWhitespaceCode(src.charCodeAt(removeStart - 1))) removeStart--;
      parts.push(src.slice(copied, removeStart));
      copied = attribute.end;
    }
    search = tag.end;
  }
  if (copied === 0 && parts.length === 0) return src;
  parts.push(src.slice(copied));
  return parts.join('');
}

const IMAGE_ELEMENT = 'image';
const HREF_ATTRIBUTE = 'href';
const DATA_SVG_MIME_PREFIX = 'data:image/svg+xml';
const MAX_EMBEDDED_SVG_DEPTH = 2;
const MAX_EMBEDDED_SVG_COUNT = 32;
const MAX_TOTAL_EMBEDDED_SVG_CHARS = MAX_SVG_INPUT_CHARS;
const BASE64_PAYLOAD_PATTERN = /^[A-Za-z0-9+/]+=*$/;

interface EmbeddedSvgBudget {
  count: number;
  totalChars: number;
  /** Canonical `data:image/svg+xml;base64,...` attribute values already sanitized in this run. */
  sanitizedValues: Set<string>;
}

function attributeLocalName(attributeName: string): string {
  return localNameOf(attributeName.replace(/^["'=]+/, ''));
}

/** Decodes the body of a `data:image/svg+xml` URI (base64 or URL-encoded text), or returns null when malformed. */
function decodeEmbeddedSvgPayload(rawValue: string): string | null {
  const decodedValue = decodeHtmlEntities(rawValue).trim();
  const comma = decodedValue.indexOf(',');
  if (comma === -1) return null;
  const header = decodedValue.slice(0, comma).replace(/[\s\x00-\x1f]/g, '').toLowerCase();
  if (!header.startsWith(DATA_SVG_MIME_PREFIX)) return null;
  const suffix = header.slice(DATA_SVG_MIME_PREFIX.length);
  if (suffix !== '' && !suffix.startsWith(';')) return null;

  const rawPayload = decodedValue.slice(comma + 1);
  const params = suffix.split(';').filter(Boolean);
  if (params.includes('base64')) {
    const cleanBase64 = rawPayload.replace(/[\s\x00-\x1f]+/g, '');
    if (cleanBase64.length === 0 || cleanBase64.length > MAX_SVG_INPUT_CHARS * 2 || !BASE64_PAYLOAD_PATTERN.test(cleanBase64)) return null;
    return Buffer.from(cleanBase64, 'base64').toString('utf-8');
  }
  try { return rawPayload.includes('%') ? decodeURIComponent(rawPayload) : rawPayload; } catch { return null; }
}

/** Sanitizes an embedded `data:image/svg+xml` URI on an `<image>` element, or neutralizes it to `href="#"`. */
function sanitizeEmbeddedSvgHref(attribute: TagAttribute, depth: number, budget: EmbeddedSvgBudget): string | null {
  if (budget.sanitizedValues.has(attribute.value)) return null;
  if (depth >= MAX_EMBEDDED_SVG_DEPTH || budget.count >= MAX_EMBEDDED_SVG_COUNT) return 'href="#"';
  const innerSvg = decodeEmbeddedSvgPayload(attribute.value);
  if (innerSvg === null || innerSvg.length === 0 || innerSvg.length > MAX_SVG_INPUT_CHARS || budget.totalChars + innerSvg.length > MAX_TOTAL_EMBEDDED_SVG_CHARS || !isSvg(innerSvg)) {
    return 'href="#"';
  }
  budget.count += 1;
  budget.totalChars += innerSvg.length;
  const cleanInner = sanitizeSvgStringAtDepth(innerSvg, depth + 1, budget);
  if (!isSvg(cleanInner)) return 'href="#"';
  const encodedValue = `data:image/svg+xml;base64,${Buffer.from(cleanInner, 'utf-8').toString('base64')}`;
  budget.sanitizedValues.add(encodedValue);
  const canonicalName = /^xlink:href$/i.test(attribute.name) ? attribute.name : HREF_ATTRIBUTE;
  return `${canonicalName}="${encodedValue}"`;
}

/** Replacement for an attribute whose value is a dangerous URI, or null when it is left alone. */
function neutralizedAttribute(attribute: TagAttribute, tagName: string, depth: number, src: string, budget: EmbeddedSvgBudget): string | null {
  const local = attributeLocalName(attribute.name);
  if (LINK_ATTRIBUTES.has(local)) {
    const normalizedUri = normalizeUriText(attribute.value);
    if (local === HREF_ATTRIBUTE && localNameOf(tagName) === IMAGE_ELEMENT && normalizedUri.startsWith(DATA_SVG_MIME_PREFIX)) {
      const rewritten = sanitizeEmbeddedSvgHref(attribute, depth, budget);
      return rewritten === null || rewritten === src.slice(attribute.start, attribute.end) ? null : rewritten;
    }
    return isDangerousLinkUri(normalizedUri) ? 'href="#"' : null;
  }
  if (ANIMATION_VALUE_ATTRIBUTES.has(local)) return hasDangerousUriItem(attribute.value) ? `${local}="#"` : null;
  if (PRESENTATION_URL_ATTRIBUTES.has(local)) {
    const sanitized = sanitizeCss(attribute.value, false);
    return sanitized === attribute.value ? null : `${attribute.name}="${sanitized.replace(/"/g, '&quot;')}"`;
  }
  if (local === STYLE_ATTRIBUTE) {
    // Output is always double-quoted, so a `"` that came from a single-quoted or unquoted value must be escaped.
    const sanitized = sanitizeCss(attribute.value, false);
    if (
      sanitized === attribute.value &&
      src.startsWith('style="', attribute.start) &&
      attribute.end === attribute.start + 8 + attribute.value.length &&
      src.charCodeAt(attribute.end - 1) === CHAR_DOUBLE_QUOTE
    ) return null;
    return `style="${sanitized.replace(/"/g, '&quot;')}"`;
  }
  return null;
}

/** Rewrites href/src, animation value, presentation and style attributes on real tags while leaving non-tag text untouched. */
function rewriteAttributes(src: string, lower: string, depth: number, budget: EmbeddedSvgBudget): string {
  if (!src.includes('--') && !src.includes('=') && !lower.includes('yle')) return src;
  const parts: string[] = [];
  let copied = 0, search = 0;
  for (;;) {
    const lt = src.indexOf('<', search);
    if (lt === -1) break;
    const skipTo = skipNonTagMarkup(src, lt);
    if (skipTo !== -1) { search = skipTo; continue; }
    const bogusEnd = skipClosingOrBogusMarkup(src, lt);
    if (bogusEnd !== -1) { search = bogusEnd; continue; }
    if (!isTagNameStart(src, lt + 1)) { search = lt + 1; continue; }
    const emptyEnd = trySkipEmptyTagEnd(src, lt);
    if (emptyEnd !== -1) { search = emptyEnd; continue; }
    const tag = readTag(src, lt);
    for (const attribute of tag.attributes) {
      const replacement = neutralizedAttribute(attribute, tag.name, depth, src, budget);
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

interface CdataHtmlState { svgDepth: number; integrationDepth: number; htmlInIntegration: boolean }

function advanceCdataTagState(src: string, lt: number, state: CdataHtmlState): number {
  const tag = readTag(src, lt), lower = tag.name.toLowerCase();
  const lastEnd = tag.attributes.length > 0 ? tag.attributes[tag.attributes.length - 1].end : lt + 1 + tag.name.length;
  const selfClosing = tag.terminated && src.charCodeAt(tag.end - 2) === CHAR_SLASH && lastEnd <= tag.end - 2;
  if (state.svgDepth === 0) { if (lower === 'svg' && !selfClosing) state.svgDepth = 1; return tag.end; }
  if (state.integrationDepth > 0) { state.htmlInIntegration = true; return tag.end; }
  const isFontBreakout = lower === 'font' && tag.attributes.some((a) => HTML_FONT_BREAKOUT_ATTRS.has(a.name.toLowerCase()));
  if (HTML_BREAKOUT_ELEMENTS.has(lower) || isFontBreakout) { state.svgDepth = 0; state.integrationDepth = 0; state.htmlInIntegration = false; }
  else if (SVG_HTML_INTEGRATION_POINTS.has(lower) && !selfClosing) state.integrationDepth++;
  else if (lower === 'svg' && !selfClosing) state.svgDepth++;
  return tag.end;
}

function advanceCdataCloseState(src: string, lt: number, state: CdataHtmlState): number {
  if (!isAsciiAlphaAt(src, lt + 2)) { const gt = src.indexOf('>', lt + 2); return gt === -1 ? src.length : gt + 1; }
  const tag = readTag(src, lt + 1), lower = tag.name.toLowerCase();
  if (state.svgDepth > 0 && (lower === 'p' || lower === 'br')) { state.svgDepth = 0; state.integrationDepth = 0; state.htmlInIntegration = false; }
  else if (lower === 'svg' && state.svgDepth > 0) { if (!state.htmlInIntegration && --state.svgDepth === 0) state.integrationDepth = 0; }
  else if (state.integrationDepth > 0 && SVG_HTML_INTEGRATION_POINTS.has(lower)) state.integrationDepth--;
  return tag.end;
}

/** Rejects CDATA outside safe SVG foreign content (HTML5 §13.2.6.2, §13.2.6.5) so XML/HTML differentials fail closed. */
function assertSafeCdataContext(src: string): void {
  if (!src.includes('[')) return;
  const state: CdataHtmlState = { svgDepth: 0, integrationDepth: 0, htmlInIntegration: false };
  for (let search = 0; search < src.length; ) {
    const lt = src.indexOf('<', search);
    if (lt === -1) break;
    if (src.startsWith(CDATA_OPEN, lt)) {
      if (state.svgDepth <= 0 || state.htmlInIntegration) throw new SvgSanitizationError('SVG contains a CDATA section outside safe SVG foreign content.');
      const close = src.indexOf(CDATA_CLOSE, lt + CDATA_OPEN.length);
      search = close === -1 ? src.length : close + CDATA_CLOSE.length;
      continue;
    }
    const skipTo = skipNonTagMarkup(src, lt);
    if (skipTo !== -1) { search = skipTo; continue; }
    if (src.charCodeAt(lt + 1) === CHAR_BANG) { const gt = src.indexOf('>', lt + 2); search = gt === -1 ? src.length : gt + 1; }
    else if (src.charCodeAt(lt + 1) === CHAR_SLASH) search = advanceCdataCloseState(src, lt, state);
    else if (isAsciiAlphaAt(src, lt + 1)) search = advanceCdataTagState(src, lt, state);
    else search = lt + 1;
  }
}

const OTHER_DANGEROUS_LOWER_NAMES = [
  ...PAIRED_DANGEROUS_ELEMENTS.slice(1).map((n) => n.toLowerCase()),
  ...VOID_DANGEROUS_ELEMENTS.map((n) => n.toLowerCase()),
];

/** One pass of dangerous markup removal; callers repeat until stable to defeat split-opener tricks. */
function stripDangerousMarkupPass(input: string): { result: string; lower: string } {
  let result = input;
  let lower = lowerKeepingLength(result);
  let lowerDirty = false;
  const syncLower = () => {
    if (lowerDirty) { lower = lowerKeepingLength(result); lowerDirty = false; }
    return lower;
  };
  const afterDoctype = stripDoctype(result, lower);
  if (afterDoctype !== result) { result = afterDoctype; lowerDirty = true; }
  const afterPi = stripProcessingInstructions(result);
  if (afterPi !== result) { result = afterPi; lowerDirty = true; }
  const afterScript = stripElement(result, syncLower(), 'script', true);
  if (afterScript !== result) { result = afterScript; lowerDirty = true; }
  if (RE_OTHER_DANGEROUS.test(syncLower())) {
    for (let i = 0; i < OTHER_DANGEROUS_LOWER_NAMES.length; i++) {
      const next = stripElement(result, syncLower(), OTHER_DANGEROUS_LOWER_NAMES[i], i < PAIRED_DANGEROUS_ELEMENTS.length - 1);
      if (next !== result) { result = next; lowerDirty = true; }
    }
  }
  const afterEvents = stripEventHandlerAttributes(result, syncLower());
  if (afterEvents !== result) { result = afterEvents; lowerDirty = true; }
  assertSafeCdataContext(result);
  return { result, lower: syncLower() };
}

const HTML_ENTITY_PATTERN = /&(?:#x([0-9a-fA-F]+);|#([0-9]+);|(quot|apos|lt|gt|amp);)/gi;
const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };

/** Decodes standard and numerical HTML entities (hex and decimal) in a single linear pass. */
export function decodeHtmlEntities(str: string): string {
  return str.replace(HTML_ENTITY_PATTERN, (full, hex?: string, dec?: string, named?: string) => {
    if (named) return NAMED_HTML_ENTITIES[named.toLowerCase()] ?? full;
    const codePoint = hex ? Number.parseInt(hex, 16) : Number.parseInt(dec!, 10);
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > MAX_CODE_POINT || (codePoint >= SURROGATE_MIN && codePoint <= SURROGATE_MAX)) {
      return '\uFFFD';
    }
    return String.fromCodePoint(codePoint);
  });
}

/** How much of a payload `isSvg` inspects: large binary images must not be decoded into strings. */
const SVG_SNIFF_BYTES = 256 * 1024;
const SVG_SNIFF_CHARS = SVG_SNIFF_BYTES;
/** Bytes decoded first to see whether a payload can be markup at all; a longer run of whitespace falls through to the full sniff. */
const SVG_HEAD_BYTES = 64;

/** True when a payload starts with the signature of a raster format: such a payload is never SVG text. */
function startsWithRasterSignature(input: Buffer): boolean {
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return true; // JPG
  if (input.length >= 8 && input[0] === 0x89 && input[1] === 0x50 && input[2] === 0x4e && input[3] === 0x47) return true; // PNG
  return input.length >= 4 && input[0] === 0x47 && input[1] === 0x49 && input[2] === 0x46 && input[3] === 0x38; // GIF
}

/** False when the head after whitespace does not start with `<`: a raster or non-markup payload never decodes all 256 KiB. */
function mayBeMarkup(input: Buffer): boolean {
  const head = input.toString('utf-8', 0, SVG_HEAD_BYTES).trim();
  return head === '' || head.startsWith('<');
}

/** Checks whether the given buffer or text represents an SVG document. */
export function isSvg(input: string | Buffer): boolean {
  if (!input) return false;
  // Raster payloads are turned away from their signature and their first character, before any of them is decoded as text.
  if (typeof input !== 'string' && (startsWithRasterSignature(input) || !mayBeMarkup(input))) return false;
  // The root element follows only an XML declaration, comments and a doctype, so the start decides.
  const str = typeof input === 'string' ? input.slice(0, SVG_SNIFF_CHARS) : input.toString('utf-8', 0, SVG_SNIFF_BYTES);
  const trimmed = str.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false; // JSON
  if (trimmed.startsWith('GIF87a') || trimmed.startsWith('GIF89a')) return false;
  // Strip leading XML declaration, DOCTYPE/internal subsets, then comments so `"<!--"` in DOCTYPE doesn't mask the document.
  const stripped = stripComments(stripDoctype(trimmed.replace(/^<\?xml(?:\s[^<>]*)?\?>/i, ''))).trim();
  return /^<svg\b/i.test(stripped);
}

/** One full sanitation pass: dangerous markup removal followed by URI and style rewrites. */
function sanitizePass(input: string, depth: number, budget: EmbeddedSvgBudget): string {
  // 1-3. Strip DOCTYPE/ENTITY declarations, executable and embedding elements, and on* event handlers.
  const stripped = stripDangerousMarkupPass(input);
  // 4-6. Rewrite href-like, animation value and style attributes of real tags against dangerous URIs, SSRF and
  // data exfiltration, then clean <style> element bodies.
  const afterAttrs = rewriteAttributes(stripped.result, stripped.lower, depth, budget);
  const lower = afterAttrs === stripped.result ? stripped.lower : lowerKeepingLength(afterAttrs);
  return sanitizeStyleElements(afterAttrs, lower);
}

function sanitizeSvgStringAtDepth(svg: string, depth: number, budget: EmbeddedSvgBudget): string {
  if (!svg || typeof svg !== 'string') return '';
  // Every pass strips dangerous markup and then rewrites URIs and styles. A rewrite can join fragments into
  // new dangerous markup (for example `<scr@import x;ipt>` inside <style>), so the pipeline repeats until its
  // output is a fixed point; payloads that need more passes than any real document are rejected (fail closed).
  let result = svg;
  let stable = false;
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const next = sanitizePass(result, depth, budget);
    if (next === result) { stable = true; break; }
    result = next;
  }
  if (!stable) throw new SvgSanitizationError('SVG contains nested markup that cannot be sanitized safely.');
  return result.trim();
}

/** Sanitizes an SVG string by stripping dangerous tags, attributes, and script execution vectors. */
export function sanitizeSvgString(svg: string): string {
  return sanitizeSvgStringAtDepth(svg, 0, { count: 0, totalChars: 0, sanitizedValues: new Set() });
}

function sanitizeWithin(svg: string, maxChars: number): string {
  if (typeof svg === 'string' && svg.length > maxChars) {
    throw new SvgSanitizationError(`SVG input exceeds the ${maxChars}-character limit.`);
  }
  return sanitizeSvgString(svg);
}

/** Sanitizes an SVG document after enforcing `MAX_SVG_INPUT_CHARS`; generic XML callers use {@link sanitizeSvgString}. */
export function sanitizeSvgDocument(svg: string): string {
  return sanitizeWithin(svg, MAX_SVG_INPUT_CHARS);
}

/**
 * The largest SVG a program of this service writes: the output bound of the raster tracer, three times its measured 16 MP
 * poster trace (docs/policy-decisions.md, entry 142).
 */
export const MAX_GENERATED_SVG_CHARS = 32 * 1024 * 1024;

/** Sanitizes an SVG that a program run by this service wrote, after enforcing {@link MAX_GENERATED_SVG_CHARS}. */
export function sanitizeGeneratedSvg(svg: string): string {
  return sanitizeWithin(svg, MAX_GENERATED_SVG_CHARS);
}

/** Sanitizes an SVG buffer and returns a sanitized Buffer. */
export function sanitizeSvgBuffer(buffer: Buffer): Buffer {
  return Buffer.from(sanitizeSvgDocument(buffer.toString('utf-8')), 'utf-8');
}
