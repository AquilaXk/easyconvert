import iconv from 'iconv-lite';
import { ConversionFailedError } from '../../types';
import { escapeMarkupAttribute, escapeMarkupText } from '../../text/escape';
import { decodeHtmlCharacterReferences } from '../html-blocks';
import { decodeHtmlInput } from '../html-encoding';
import { assertReadableAsText } from './text-source-guard';
import { htmlToText } from './html-text';

/**
 * Bounded RFC 5322 / MIME (RFC 2045-2047) email (.eml) reader.
 * Decodes folded headers, RFC 2047 encoded words, multipart trees, quoted-printable and base64 bodies,
 * and attachment listings without spawning external mail tools.
 */

const MAX_MIME_DEPTH = 16;
const MAX_MIME_PARTS = 256;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_DECODED_BYTES = 32 * 1024 * 1024;

export interface EmlAttachment {
  name: string;
  contentType: string;
  bytes: number;
}

export interface EmlMessage {
  subject: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  date: string;
  textBody: string;
  htmlBody: string;
  attachments: EmlAttachment[];
}

interface MimeWalkState {
  partCount: number;
  decodedBytes: number;
  textParts: string[];
  htmlParts: string[];
  attachments: EmlAttachment[];
}

function findHeaderBodySplit(raw: string): { head: string; body: string } {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  if (crlf === -1 && lf === -1) return { head: raw, body: '' };
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { head: raw.slice(0, crlf), body: raw.slice(crlf + 4) };
  }
  return { head: raw.slice(0, lf), body: raw.slice(lf + 2) };
}

function parseHeaders(headerSection: string): Map<string, string> {
  if (Buffer.byteLength(headerSection, 'utf-8') > MAX_HEADER_BYTES) {
    throw new ConversionFailedError(`Invalid EML message: header block exceeds ${MAX_HEADER_BYTES} bytes.`);
  }
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    const existing = headers.get(name);
    headers.set(name, existing ? `${existing}, ${val}` : val);
  }
  return headers;
}

function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const normalized = (charset || 'utf-8').trim().toLowerCase();
  if (normalized === 'utf-8' || normalized === 'utf8' || normalized === 'us-ascii' || normalized === 'ascii') {
    return bytes.toString('utf-8');
  }
  if (iconv.encodingExists(normalized)) {
    return iconv.decode(bytes, normalized);
  }
  return bytes.toString('utf-8');
}

function isHexDigitCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function hexDigitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  return code - 0x57;
}

function decodeQuotedPrintableBytes(raw: string, maxBytes = MAX_DECODED_BYTES): Buffer {
  let buf = Buffer.allocUnsafe(Math.min(Math.max(raw.length, 16), Math.max(16, maxBytes)));
  let written = 0;

  const ensureCapacity = (extra: number): void => {
    if (written + extra > maxBytes) {
      throw new ConversionFailedError(`EML message exceeds ${MAX_DECODED_BYTES} decoded bytes.`);
    }
    if (written + extra > buf.length) {
      const nextSize = Math.min(maxBytes, Math.max(buf.length * 2, written + extra));
      const next = Buffer.allocUnsafe(nextSize);
      buf.copy(next, 0, 0, written);
      buf = next;
    }
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charCodeAt(i);
    if (ch === 0x3d /* '=' */) {
      if (raw.charCodeAt(i + 1) === 0x0d && raw.charCodeAt(i + 2) === 0x0a) {
        i += 2;
        continue;
      }
      if (raw.charCodeAt(i + 1) === 0x0a) {
        i += 1;
        continue;
      }
      if (i + 2 < raw.length && isHexDigitCode(raw.charCodeAt(i + 1)) && isHexDigitCode(raw.charCodeAt(i + 2))) {
        ensureCapacity(1);
        buf[written++] = (hexDigitValue(raw.charCodeAt(i + 1)) << 4) | hexDigitValue(raw.charCodeAt(i + 2));
        i += 2;
        continue;
      }
    }
    if (ch <= 0xff) {
      ensureCapacity(1);
      buf[written++] = ch;
    } else {
      const cp = raw.codePointAt(i) as number;
      const charLen = cp > 0xffff ? 2 : 1;
      const utf8 = Buffer.from(raw.slice(i, i + charLen), 'utf-8');
      ensureCapacity(utf8.length);
      utf8.copy(buf, written);
      written += utf8.length;
      if (charLen === 2) i += 1;
    }
  }
  return buf.subarray(0, written);
}

function decodeEncodedWords(value: string): string {
  // Collapse linear whitespace strictly between consecutive RFC 2047 encoded words per RFC 2047 §6.2.
  const adjacentJoined = value.replace(/(\?=)[ \t]+(=\?)/g, '$1$2');
  return adjacentJoined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_full, charset: string, enc: string, payload: string) => {
    try {
      if (enc.toUpperCase() === 'B') {
        const bytes = Buffer.from(payload, 'base64');
        return decodeCharset(bytes, charset);
      }
      const qBytes = decodeQuotedPrintableBytes(payload.replace(/_/g, ' '));
      return decodeCharset(qBytes, charset);
    } catch {
      return _full;
    }
  });
}

function decodeRfc5987Param(headerVal: string | undefined, paramName: string): string | undefined {
  if (!headerVal) return undefined;
  const escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const extMatch = new RegExp(`(?:^|;)\\s*${escaped}\\*\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;\\s]+))`, 'i').exec(headerVal);
  const rawExt = (extMatch?.[1] ?? extMatch?.[2] ?? extMatch?.[3])?.trim();
  if (!rawExt) return undefined;
  const parts = /^([^']*)'[^']*'(.*)$/.exec(rawExt);
  if (!parts) return undefined;
  const charset = parts[1] || 'utf-8';
  const value = parts[2];
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '%' && i + 2 < value.length && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(value[i], 'utf-8')) bytes.push(b);
    }
  }
  return decodeCharset(Buffer.from(bytes), charset);
}

function extractParam(headerVal: string | undefined, paramName: string): string | undefined {
  if (!headerVal) return undefined;
  const extVal = decodeRfc5987Param(headerVal, paramName);
  if (extVal) return extVal;
  const escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|;)\\s*${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;\\s]+))`, 'i').exec(headerVal);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw ? decodeEncodedWords(raw.trim()) : undefined;
}

function mediaTypeOf(contentType: string | undefined): string {
  if (!contentType) return 'text/plain';
  return contentType.split(';', 1)[0].trim().toLowerCase() || 'text/plain';
}

function decodeBodyBytes(rawBody: string, encoding: string | undefined, state: MimeWalkState): Buffer {
  const cte = asciiLower((encoding || '7bit').trim());
  const remaining = MAX_DECODED_BYTES - state.decodedBytes;
  let decoded: Buffer;
  if (cte === 'base64') {
    const compact = rawBody.replace(/[\r\n\s]+/g, '');
    let pad = 0;
    if (compact.endsWith('==')) pad = 2;
    else if (compact.endsWith('=')) pad = 1;
    const expected = Math.max(0, Math.floor((compact.length * 3) / 4) - pad);
    if (expected > remaining) {
      throw new ConversionFailedError(`EML message exceeds ${MAX_DECODED_BYTES} decoded bytes.`);
    }
    decoded = Buffer.from(compact, 'base64');
  } else if (cte === 'quoted-printable') {
    decoded = decodeQuotedPrintableBytes(rawBody, remaining);
  } else {
    if (rawBody.length > remaining) {
      throw new ConversionFailedError(`EML message exceeds ${MAX_DECODED_BYTES} decoded bytes.`);
    }
    decoded = Buffer.from(rawBody, 'latin1');
  }
  state.decodedBytes += decoded.length;
  if (state.decodedBytes > MAX_DECODED_BYTES) {
    throw new ConversionFailedError(`EML message exceeds ${MAX_DECODED_BYTES} decoded bytes.`);
  }
  return decoded;
}

function splitMultipartParts(body: string, boundary: string): string[] {
  const delim = `--${boundary}`;
  const closeDelim = `${delim}--`;
  const lines = body.split(/\r?\n/);
  const parts: string[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed === closeDelim) {
      if (current !== null) parts.push(current.join('\r\n'));
      break;
    }
    if (trimmed === delim) {
      if (current !== null) parts.push(current.join('\r\n'));
      current = [];
      continue;
    }
    if (current !== null) current.push(line);
  }
  return parts;
}

function walkMimeEntity(rawEntity: string, depth: number, state: MimeWalkState, topHeadersOut?: Map<string, string>): void {
  if (depth > MAX_MIME_DEPTH) {
    throw new ConversionFailedError(`Invalid EML message: MIME nesting exceeds ${MAX_MIME_DEPTH} levels.`);
  }
  state.partCount += 1;
  if (state.partCount > MAX_MIME_PARTS) {
    throw new ConversionFailedError(`Invalid EML message: MIME part count exceeds ${MAX_MIME_PARTS}.`);
  }

  const { head, body } = findHeaderBodySplit(rawEntity);
  const headers = parseHeaders(head);
  if (topHeadersOut && depth === 0) {
    for (const [k, v] of headers) topHeadersOut.set(k, v);
  }

  const contentType = headers.get('content-type');
  const mime = mediaTypeOf(contentType);
  const disposition = (headers.get('content-disposition') || '').toLowerCase();
  const isAttachment = disposition.startsWith('attachment');

  if (mime.startsWith('multipart/')) {
    const boundary = extractParam(contentType, 'boundary');
    if (!boundary) {
      throw new ConversionFailedError(`Invalid EML message: ${mime} part is missing its boundary.`);
    }
    const children = splitMultipartParts(body, boundary);
    for (const child of children) {
      walkMimeEntity(child, depth + 1, state);
    }
    return;
  }

  const bytes = decodeBodyBytes(body, headers.get('content-transfer-encoding'), state);
  const fileName = extractParam(headers.get('content-disposition'), 'filename') ?? extractParam(contentType, 'name');

  if (isAttachment || (!mime.startsWith('text/') && fileName)) {
    state.attachments.push({
      name: fileName || `attachment-${state.attachments.length + 1}`,
      contentType: mime,
      bytes: bytes.length,
    });
    return;
  }

  const charset = extractParam(contentType, 'charset');
  if (mime === 'text/html') {
    const decoded = charset ? decodeCharset(bytes, charset) : decodeHtmlInput(bytes);
    if (decoded.trim() !== '') state.htmlParts.push(decoded);
    return;
  }

  if (mime.startsWith('text/')) {
    const decoded = decodeCharset(bytes, charset).replace(/\r\n?/g, '\n');
    if (decoded.trim() !== '') state.textParts.push(decoded);
  } else if (fileName || bytes.length > 0) {
    state.attachments.push({
      name: fileName || `part-${state.attachments.length + 1}`,
      contentType: mime,
      bytes: bytes.length,
    });
  }
}

export function readEmlMessage(input: Buffer): EmlMessage {
  assertReadableAsText(input, 'eml');
  const raw = input.toString('latin1');
  const topHeaders = new Map<string, string>();
  const state: MimeWalkState = {
    partCount: 0,
    decodedBytes: 0,
    textParts: [],
    htmlParts: [],
    attachments: [],
  };
  walkMimeEntity(raw, 0, state, topHeaders);

  const headerValue = (name: string): string => {
    const val = topHeaders.get(name);
    if (!val) return '';
    // Raw Latin-1 bytes of RFC 5322 headers -> decode strictly as UTF-8 when valid, otherwise Windows-1252, then decode RFC 2047
    const rawBytes = Buffer.from(val, 'latin1');
    let decodedRaw: string;
    try {
      decodedRaw = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
    } catch {
      decodedRaw = decodeCharset(rawBytes, 'windows-1252');
    }
    return decodeEncodedWords(decodedRaw);
  };

  return {
    subject: headerValue('subject'),
    from: headerValue('from'),
    to: headerValue('to'),
    cc: headerValue('cc'),
    bcc: headerValue('bcc'),
    date: headerValue('date'),
    textBody: state.textParts.join('\n\n').trim(),
    htmlBody: state.htmlParts.join('\n').trim(),
    attachments: state.attachments,
  };
}

function headerLine(label: string, value: string): string[] {
  return value ? [`${label}: ${value}`] : [];
}

/** Readable plain-text rendering of an EML message, matching `outlookMessageText`. */
export function emlMessageText(message: EmlMessage): string {
  const lines = [
    ...headerLine('From', message.from),
    ...headerLine('To', message.to),
    ...headerLine('Cc', message.cc),
    ...headerLine('Bcc', message.bcc),
    ...headerLine('Date', message.date),
    ...headerLine('Subject', message.subject),
  ];
  const bodyText = message.textBody || (message.htmlBody ? htmlToText(message.htmlBody) : '');
  const parts = [lines.join('\n'), bodyText].filter((p) => p !== '');
  if (message.attachments.length > 0) {
    parts.push(['Attachments:', ...message.attachments.map((a) => `- ${a.name} (${a.bytes} bytes)`)].join('\n'));
  }
  return parts.join('\n\n');
}

export const UNTRUSTED_HTML_CSP =
  "default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const MAX_HTML_STACK_DEPTH = 512;

export const SAFE_HTML_TAGS: ReadonlySet<string> = new Set([
  'div', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'span', 'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins',
  'code', 'kbd', 'samp', 'sub', 'sup', 'small', 'mark', 'img',
]);

const SAFE_VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img']);

export const RAW_HTML_TEXT_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'title', 'textarea', 'xmp', 'noembed', 'noframes',
]);

const SUPPRESSED_CONTAINER_TAGS: ReadonlySet<string> = new Set([
  ...RAW_HTML_TEXT_TAGS,
  'svg', 'math', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'template', 'head',
]);

const PARAGRAPH_CLOSERS: ReadonlySet<string> = new Set([
  'div', 'p', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'blockquote', 'pre', 'table',
]);

const SAFE_LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel']);
const DATA_RASTER_IMAGE_URI = /^data:image\/(?:png|gif|jpe?g|webp)[;,]/i;
const IMG_DIMENSION_PATTERN = /^\d{1,4}$/;
const CELL_SPAN_PATTERN = /^\d{1,3}$/;
const SURROUNDING_QUOTES = /^["']+|["']+$/g;
// eslint-disable-next-line no-control-regex
const URI_CONTROL_AND_SPACE = /[\u0000-\u0020\u007f-\u009f]+/g;
// eslint-disable-next-line no-control-regex
const ATTR_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;
const URI_ENTITY_PATTERN = /&#(?:x([0-9a-fA-F]+)|([0-9]+));?|&(colon|tab|newline|amp|quot|apos|nbsp);/gi;

const NAMED_URI_ENTITIES: Readonly<Record<string, string>> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function isHtmlWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

export function isHtmlTagTerminator(code: number): boolean {
  return Number.isNaN(code) || isHtmlWhitespace(code) || code === 0x2f /* '/' */ || code === 0x3e /* '>' */;
}

export function isAsciiLetterCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

export function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

export function matchesAsciiTagAt(html: string, at: number, lowerTag: string): boolean {
  if (at + lowerTag.length > html.length) return false;
  for (let i = 0; i < lowerTag.length; i += 1) {
    const code = html.charCodeAt(at + i);
    const lower = code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
    if (lower !== lowerTag.charCodeAt(i)) return false;
  }
  return isHtmlTagTerminator(html.charCodeAt(at + lowerTag.length));
}

export function matchesCdataOpen(html: string, lt: number): boolean {
  if (lt + 9 > html.length || html.charCodeAt(lt + 1) !== 0x21 || html.charCodeAt(lt + 2) !== 0x5b) return false;
  return asciiLower(html.slice(lt + 3, lt + 9)) === 'cdata[';
}

export function findHtmlCommentEnd(html: string, from: number): number {
  if (html.charCodeAt(from) === 0x3e /* '>' */) return from + 1;
  if (html.charCodeAt(from) === 0x2d /* '-' */ && html.charCodeAt(from + 1) === 0x3e /* '>' */) return from + 2;
  let dashes = html.indexOf('--', from);
  while (dashes !== -1) {
    const after = html.charCodeAt(dashes + 2);
    if (after === 0x3e /* '>' */) return dashes + 3;
    if (after === 0x21 /* '!' */ && html.charCodeAt(dashes + 3) === 0x3e /* '>' */) return dashes + 4;
    dashes = html.indexOf('--', dashes + 1);
  }
  return html.length;
}

export interface ParsedTagEnd {
  attrs: ReadonlyMap<string, string>;
  end: number;
  selfClosing: boolean;
  closed: boolean;
}

export function scanTagNameEnd(html: string, start: number): number {
  let i = start;
  while (i < html.length && !isHtmlTagTerminator(html.charCodeAt(i))) i += 1;
  return i;
}

function skipHtmlWhitespace(html: string, from: number): number {
  let i = from;
  while (i < html.length && isHtmlWhitespace(html.charCodeAt(i))) i += 1;
  return i;
}

function readTagAttributeValue(
  html: string,
  from: number,
  collect: boolean
): { value: string; next: number; unclosed: boolean } {
  const len = html.length;
  let i = skipHtmlWhitespace(html, from);
  if (i >= len) return { value: '', next: len, unclosed: false };
  const q = html.charCodeAt(i);
  if (q === 0x22 /* '"' */ || q === 0x27 /* "'" */) {
    i += 1;
    const vStart = i;
    while (i < len && html.charCodeAt(i) !== q) i += 1;
    const value = collect ? html.slice(vStart, i) : '';
    if (i < len) return { value, next: i + 1, unclosed: false };
    return { value, next: len, unclosed: true };
  }
  const vStart = i;
  while (i < len && !isHtmlWhitespace(html.charCodeAt(i)) && html.charCodeAt(i) !== 0x3e) i += 1;
  return { value: collect ? html.slice(vStart, i) : '', next: i, unclosed: false };
}

function readOneTagAttribute(
  html: string,
  from: number,
  collect: boolean
): { name: string; value: string; next: number; unclosed: boolean } {
  const len = html.length;
  let i = from;
  while (i < len) {
    const c = html.charCodeAt(i);
    if (isHtmlWhitespace(c) || c === 0x2f || c === 0x3e || c === 0x3d) break;
    i += 1;
  }
  const name = collect ? asciiLower(html.slice(from, i)) : '';
  i = skipHtmlWhitespace(html, i);
  if (i >= len || html.charCodeAt(i) !== 0x3d /* '=' */) {
    return { name, value: '', next: i, unclosed: false };
  }
  const val = readTagAttributeValue(html, i + 1, collect);
  return { name, value: val.value, next: val.next, unclosed: val.unclosed };
}

export function findHtmlTagEnd(html: string, from: number, collectAttrs = false): ParsedTagEnd {
  const attrs = new Map<string, string>();
  const len = html.length;
  let i = from;
  while (i < len) {
    const gapStart = i;
    while (i < len && (isHtmlWhitespace(html.charCodeAt(i)) || html.charCodeAt(i) === 0x2f)) i += 1;
    if (i >= len) return { attrs, end: len, selfClosing: false, closed: false };
    if (html.charCodeAt(i) === 0x3e /* '>' */) {
      return { attrs, end: i, selfClosing: i > gapStart && html.charCodeAt(i - 1) === 0x2f, closed: true };
    }
    const attr = readOneTagAttribute(html, i, collectAttrs);
    i = attr.next;
    if (collectAttrs && attr.name !== '' && !attrs.has(attr.name)) {
      attrs.set(attr.name, attr.value);
    }
    if (attr.unclosed) return { attrs, end: len, selfClosing: false, closed: false };
  }
  return { attrs, end: len, selfClosing: false, closed: false };
}

export function findRawTextEndTagRange(
  html: string,
  lowerTag: string,
  from: number
): { contentEnd: number; afterClose: number } {
  let cursor = from;
  while (cursor < html.length) {
    const lt = html.indexOf('<', cursor);
    if (lt === -1) return { contentEnd: html.length, afterClose: html.length };
    if (html.charCodeAt(lt + 1) === 0x2f /* '/' */ && matchesAsciiTagAt(html, lt + 2, lowerTag)) {
      const endInfo = findHtmlTagEnd(html, lt + 2 + lowerTag.length, false);
      return {
        contentEnd: lt,
        afterClose: endInfo.closed ? endInfo.end + 1 : html.length,
      };
    }
    cursor = lt + 1;
  }
  return { contentEnd: html.length, afterClose: html.length };
}

function skipCommentCdataOrDecl(html: string, lt: number): number {
  if (html.startsWith('<!--', lt)) return findHtmlCommentEnd(html, lt + 4);
  if (matchesCdataOpen(html, lt)) {
    const cdataEnd = html.indexOf(']]>', lt + 9);
    return cdataEnd === -1 ? html.length : cdataEnd + 3;
  }
  const gt = html.indexOf('>', lt + 2);
  return gt === -1 ? html.length : gt + 1;
}

function findSuppressedContainerEnd(html: string, containerTag: string, from: number, xmlSelfClosing: boolean): number {
  const isForeign = containerTag === 'svg' || containerTag === 'math';
  let depth = 1;
  let pos = from;
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) return html.length;
    const next = html.charCodeAt(lt + 1);
    if (next === 0x21 /* '!' */ || next === 0x3f /* '?' */) {
      pos = skipCommentCdataOrDecl(html, lt);
      continue;
    }
    const isEnd = next === 0x2f /* '/' */;
    const nameStart = isEnd ? lt + 2 : lt + 1;
    if (!isAsciiLetterCode(html.charCodeAt(nameStart))) {
      pos = lt + 1;
      continue;
    }
    const nameEnd = scanTagNameEnd(html, nameStart);
    const tagName = asciiLower(html.slice(nameStart, nameEnd));
    const endInfo = findHtmlTagEnd(html, nameEnd, false);
    const afterTag = endInfo.closed ? endInfo.end + 1 : html.length;
    if (isEnd) {
      if (tagName === containerTag) {
        depth -= 1;
        if (depth === 0) return afterTag;
      }
      pos = afterTag;
      continue;
    }
    if (RAW_HTML_TEXT_TAGS.has(tagName) && !(endInfo.selfClosing && (isForeign || xmlSelfClosing))) {
      pos = findRawTextEndTagRange(html, tagName, afterTag).afterClose;
      continue;
    }
    if (tagName === containerTag && !endInfo.selfClosing) depth += 1;
    pos = afterTag;
  }
  return html.length;
}

function extractBodyFragment(html: string, xmlSelfClosing: boolean): string {
  let pos = 0;
  let inBody = false;
  let bodyStart = 0;
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) break;
    const next = html.charCodeAt(lt + 1);
    if (next === 0x21 || next === 0x3f) {
      pos = skipCommentCdataOrDecl(html, lt);
      continue;
    }
    const isEnd = next === 0x2f;
    const nameStart = isEnd ? lt + 2 : lt + 1;
    if (!isAsciiLetterCode(html.charCodeAt(nameStart))) {
      pos = lt + 1;
      continue;
    }
    const nameEnd = scanTagNameEnd(html, nameStart);
    const tagName = asciiLower(html.slice(nameStart, nameEnd));
    const endInfo = findHtmlTagEnd(html, nameEnd, false);
    const afterTag = endInfo.closed ? endInfo.end + 1 : html.length;
    if (isEnd) {
      if (inBody && tagName === 'body') return html.slice(bodyStart, lt);
      pos = afterTag;
      continue;
    }
    if (!inBody && tagName === 'body') {
      if (xmlSelfClosing && endInfo.selfClosing) return '';
      inBody = true;
      bodyStart = afterTag;
      pos = afterTag;
      continue;
    }
    if (RAW_HTML_TEXT_TAGS.has(tagName) && !(xmlSelfClosing && endInfo.selfClosing)) {
      pos = findRawTextEndTagRange(html, tagName, afterTag).afterClose;
      continue;
    }
    if (!inBody && (tagName === 'svg' || tagName === 'math')) {
      pos = endInfo.selfClosing ? afterTag : findSuppressedContainerEnd(html, tagName, afterTag, xmlSelfClosing);
      continue;
    }
    pos = afterTag;
  }
  return inBody ? html.slice(bodyStart) : html;
}

function decodeNumericEntity(_m: string, hex: string | undefined, dec: string | undefined): string {
  const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? '0', 10);
  if (!Number.isFinite(code) || code <= 0) return '';
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(code);
}

function normalizeUriCandidate(raw: string): string {
  let decoded = raw.trim().replace(SURROUNDING_QUOTES, '');
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decoded
      .replace(URI_ENTITY_PATTERN, (m, hex?: string, dec?: string, named?: string) => {
        if (hex !== undefined || dec !== undefined) return decodeNumericEntity(m, hex, dec);
        return named ? (NAMED_URI_ENTITIES[asciiLower(named)] ?? m) : m;
      })
      .trim()
      .replace(SURROUNDING_QUOTES, '');
  }
  return decoded.replace(URI_CONTROL_AND_SPACE, '');
}

function extractSchemeBeforeDelim(compact: string): string | null {
  const colonIdx = compact.indexOf(':');
  if (colonIdx === -1) return null;
  let firstDelim = compact.length;
  for (const ch of ['/', '?', '#']) {
    const idx = compact.indexOf(ch);
    if (idx !== -1 && idx < firstDelim) firstDelim = idx;
  }
  if (colonIdx > firstDelim) return null;
  return asciiLower(compact.slice(0, colonIdx));
}

function isSafeLinkUri(raw: string): boolean {
  const compact = normalizeUriCandidate(raw);
  if (compact === '') return false;
  const scheme = extractSchemeBeforeDelim(compact);
  return scheme === null || SAFE_LINK_SCHEMES.has(scheme);
}

function isSafeImageUri(raw: string): boolean {
  const compact = normalizeUriCandidate(raw);
  if (compact === '') return false;
  const scheme = extractSchemeBeforeDelim(compact);
  if (scheme === 'http' || scheme === 'https') return true;
  return DATA_RASTER_IMAGE_URI.test(compact);
}

function cleanSafeUriForEmit(raw: string): string {
  return decodeHtmlCharacterReferences(raw, true)
    .trim()
    .replace(SURROUNDING_QUOTES, '')
    .replace(ATTR_CONTROL_CHARS, '');
}

function cleanTextAttrForEmit(raw: string): string {
  return decodeHtmlCharacterReferences(raw, true).replace(ATTR_CONTROL_CHARS, '');
}

function serializeAllowedAttributes(tagName: string, attrs: ReadonlyMap<string, string>): string | null {
  if (tagName === 'a') {
    let out = '';
    const rawHref = attrs.get('href');
    if (rawHref !== undefined && isSafeLinkUri(rawHref)) {
      out += ` href="${escapeMarkupAttribute(cleanSafeUriForEmit(rawHref))}" rel="noopener noreferrer"`;
    }
    const rawTitle = attrs.get('title');
    if (rawTitle !== undefined) {
      out += ` title="${escapeMarkupAttribute(cleanTextAttrForEmit(rawTitle))}"`;
    }
    return out;
  }
  if (tagName === 'img') {
    const rawSrc = attrs.get('src');
    if (rawSrc === undefined || !isSafeImageUri(rawSrc)) return null;
    let out = ` src="${escapeMarkupAttribute(cleanSafeUriForEmit(rawSrc))}"`;
    const rawAlt = attrs.get('alt');
    if (rawAlt !== undefined) out += ` alt="${escapeMarkupAttribute(cleanTextAttrForEmit(rawAlt))}"`;
    const rawTitle = attrs.get('title');
    if (rawTitle !== undefined) out += ` title="${escapeMarkupAttribute(cleanTextAttrForEmit(rawTitle))}"`;
    const rawWidth = attrs.get('width')?.trim();
    if (rawWidth !== undefined && IMG_DIMENSION_PATTERN.test(rawWidth)) out += ` width="${rawWidth}"`;
    const rawHeight = attrs.get('height')?.trim();
    if (rawHeight !== undefined && IMG_DIMENSION_PATTERN.test(rawHeight)) out += ` height="${rawHeight}"`;
    return out;
  }
  if (tagName === 'td' || tagName === 'th') {
    let out = '';
    const rawColspan = attrs.get('colspan')?.trim();
    if (rawColspan !== undefined && CELL_SPAN_PATTERN.test(rawColspan)) out += ` colspan="${rawColspan}"`;
    const rawRowspan = attrs.get('rowspan')?.trim();
    if (rawRowspan !== undefined && CELL_SPAN_PATTERN.test(rawRowspan)) out += ` rowspan="${rawRowspan}"`;
    return out;
  }
  return '';
}

function closeImplicitOpenTags(stack: string[], openingTag: string, out: string[]): void {
  if (stack.length === 0) return;
  const top = stack[stack.length - 1];
  if (PARAGRAPH_CLOSERS.has(openingTag) && top === 'p') {
    out.push('</p>');
    stack.pop();
    return;
  }
  if (openingTag === 'li' && top === 'li') {
    out.push('</li>');
    stack.pop();
    return;
  }
  if ((openingTag === 'dt' || openingTag === 'dd') && (top === 'dt' || top === 'dd')) {
    out.push(`</${stack.pop()}>`);
    return;
  }
  if ((openingTag === 'td' || openingTag === 'th') && (top === 'td' || top === 'th')) {
    out.push(`</${stack.pop()}>`);
    return;
  }
  if (openingTag === 'tr') {
    if (top === 'td' || top === 'th') out.push(`</${stack.pop()}>`);
    if (stack[stack.length - 1] === 'tr') {
      out.push('</tr>');
      stack.pop();
    }
  }
}

function closeMatchingOpenTag(stack: string[], tagName: string, out: string[]): void {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i] === tagName) {
      while (stack.length > i) {
        out.push(`</${stack.pop()}>`);
      }
      return;
    }
  }
}

/**
 * Extracts the document `<title>` plain text outside comments, CDATA, rawtext, and foreign SVG/MathML blocks.
 */
export function extractHtmlTitleText(html: string, xmlSelfClosing = false): string | undefined {
  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) break;
    const next = html.charCodeAt(lt + 1);
    if (next === 0x21 || next === 0x3f) {
      pos = skipCommentCdataOrDecl(html, lt);
      continue;
    }
    const isEnd = next === 0x2f;
    const nameStart = isEnd ? lt + 2 : lt + 1;
    if (!isAsciiLetterCode(html.charCodeAt(nameStart))) {
      pos = lt + 1;
      continue;
    }
    const nameEnd = scanTagNameEnd(html, nameStart);
    const tagName = asciiLower(html.slice(nameStart, nameEnd));
    const endInfo = findHtmlTagEnd(html, nameEnd, false);
    const afterTag = endInfo.closed ? endInfo.end + 1 : html.length;
    if (!isEnd && tagName === 'title') {
      if (xmlSelfClosing && endInfo.selfClosing) {
        pos = afterTag;
        continue;
      }
      const range = findRawTextEndTagRange(html, 'title', afterTag);
      const title = decodeHtmlCharacterReferences(html.slice(afterTag, range.contentEnd))
        .replace(/[ \t\n\f\r]+/g, ' ')
        .trim();
      if (title !== '') return title;
      pos = range.afterClose;
      continue;
    }
    if (!isEnd && RAW_HTML_TEXT_TAGS.has(tagName) && !(xmlSelfClosing && endInfo.selfClosing)) {
      pos = findRawTextEndTagRange(html, tagName, afterTag).afterClose;
      continue;
    }
    if (!isEnd && (tagName === 'svg' || tagName === 'math')) {
      pos = endInfo.selfClosing ? afterTag : findSuppressedContainerEnd(html, tagName, afterTag, xmlSelfClosing);
      continue;
    }
    pos = afterTag;
  }
  return undefined;
}

/**
 * Single-pass, O(N) HTML5-aware allowlist sanitizer for untrusted HTML/XHTML fragments.
 * Emits only canonical HTML5 allowlisted tags/attributes with safe URI schemes and escaped text.
 */
export function sanitizeUntrustedHtmlFragment(
  html: string,
  options: { readonly xmlSelfClosing?: boolean } = {}
): string {
  const xmlSelfClosing = options.xmlSelfClosing === true;
  const inner = extractBodyFragment(html, xmlSelfClosing);
  const out: string[] = [];
  const openStack: string[] = [];
  let pos = 0;

  const pushText = (raw: string): void => {
    if (raw !== '') out.push(escapeMarkupText(decodeHtmlCharacterReferences(raw)));
  };

  while (pos < inner.length) {
    const lt = inner.indexOf('<', pos);
    if (lt === -1) {
      pushText(inner.slice(pos));
      break;
    }
    pushText(inner.slice(pos, lt));
    if (inner.startsWith('<!--', lt)) {
      pos = findHtmlCommentEnd(inner, lt + 4);
      continue;
    }
    if (matchesCdataOpen(inner, lt)) {
      const cdataEnd = inner.indexOf(']]>', lt + 9);
      const textEnd = cdataEnd === -1 ? inner.length : cdataEnd;
      out.push(escapeMarkupText(inner.slice(lt + 9, textEnd)));
      pos = cdataEnd === -1 ? inner.length : cdataEnd + 3;
      continue;
    }
    const next = inner.charCodeAt(lt + 1);
    if (next === 0x21 /* '!' */ || next === 0x3f /* '?' */) {
      const gt = inner.indexOf('>', lt + 2);
      pos = gt === -1 ? inner.length : gt + 1;
      continue;
    }
    const isEnd = next === 0x2f /* '/' */;
    const nameStart = isEnd ? lt + 2 : lt + 1;
    if (!isAsciiLetterCode(inner.charCodeAt(nameStart))) {
      out.push('&lt;');
      pos = lt + 1;
      continue;
    }
    const nameEnd = scanTagNameEnd(inner, nameStart);
    const tagName = asciiLower(inner.slice(nameStart, nameEnd));
    const collectAttrs = !isEnd && SAFE_HTML_TAGS.has(tagName);
    const endInfo = findHtmlTagEnd(inner, nameEnd, collectAttrs);
    if (!endInfo.closed) {
      break;
    }
    const afterTag = endInfo.end + 1;

    if (isEnd) {
      if (SAFE_HTML_TAGS.has(tagName) && !SAFE_VOID_TAGS.has(tagName)) {
        closeMatchingOpenTag(openStack, tagName, out);
      }
      pos = afterTag;
      continue;
    }
    if (SUPPRESSED_CONTAINER_TAGS.has(tagName)) {
      if (RAW_HTML_TEXT_TAGS.has(tagName)) {
        pos = xmlSelfClosing && endInfo.selfClosing ? afterTag : findRawTextEndTagRange(inner, tagName, afterTag).afterClose;
      } else {
        pos = endInfo.selfClosing ? afterTag : findSuppressedContainerEnd(inner, tagName, afterTag, xmlSelfClosing);
      }
      continue;
    }
    if (SAFE_HTML_TAGS.has(tagName)) {
      const attrsStr = serializeAllowedAttributes(tagName, endInfo.attrs);
      if (attrsStr !== null) {
        if (SAFE_VOID_TAGS.has(tagName)) {
          out.push(`<${tagName}${attrsStr}>`);
        } else if (endInfo.selfClosing) {
          closeImplicitOpenTags(openStack, tagName, out);
          out.push(`<${tagName}${attrsStr}></${tagName}>`);
        } else if (openStack.length < MAX_HTML_STACK_DEPTH) {
          closeImplicitOpenTags(openStack, tagName, out);
          out.push(`<${tagName}${attrsStr}>`);
          openStack.push(tagName);
        }
      }
    }
    pos = afterTag;
  }

  while (openStack.length > 0) {
    out.push(`</${openStack.pop()}>`);
  }
  return out.join('').trim();
}

/** Clean, script-safe standalone HTML rendering of an EML message. */
export function emlMessageHtml(message: EmlMessage, fallbackTitle = 'Email Message'): string {
  const title = message.subject || fallbackTitle;
  const metaRows = [
    ['From', message.from],
    ['To', message.to],
    ['Cc', message.cc],
    ['Date', message.date],
    ['Subject', message.subject],
  ]
    .filter(([, val]) => val !== '')
    .map(
      ([label, val]) =>
        `<tr><th style="text-align:left;padding:4px 12px 4px 0;color:#4D536B;font-weight:600;vertical-align:top;">${escapeMarkupAttribute(label)}</th><td style="padding:4px 0;color:#1F2340;">${escapeMarkupAttribute(val)}</td></tr>`
    )
    .join('');

  const metaHtml = metaRows
    ? `<table style="border-collapse:collapse;margin-bottom:1.5rem;border-bottom:1px solid #E1E4EE;padding-bottom:1rem;width:100%;font-size:0.9375rem;">${metaRows}</table>`
    : '';

  const bodyHtml = message.htmlBody
    ? sanitizeUntrustedHtmlFragment(message.htmlBody)
    : message.textBody
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((p) => `<p style="margin:0 0 1rem;white-space:pre-wrap;">${escapeMarkupAttribute(p)}</p>`)
        .join('\n');

  const attachHtml =
    message.attachments.length > 0
      ? `<div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid #E1E4EE;font-size:0.875rem;color:#4D536B;"><strong>Attachments</strong><ul>${message.attachments
          .map((a) => `<li>${escapeMarkupAttribute(a.name)} (${a.bytes} bytes)</li>`)
          .join('')}</ul></div>`
      : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${UNTRUSTED_HTML_CSP}"><title>${escapeMarkupAttribute(
    title
  )}</title><style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;padding:2rem;max-width:800px;margin:0 auto;color:#1F2340;}</style></head><body>${metaHtml}${bodyHtml}${attachHtml}</body></html>`;
}
