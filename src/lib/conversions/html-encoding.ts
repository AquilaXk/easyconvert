import { decodeWindows1252 } from './office/windows-1252';

/**
 * Character encoding of an HTML file, found the way the HTML standard's encoding sniffing does it: a byte order mark, then
 * the `<meta>` declaration in the first 1024 bytes (the prescan), then, for a file that declares nothing, UTF-8 when the
 * bytes are valid UTF-8 (a pattern that legacy text almost never matches) and Windows-1252 otherwise, the default of the
 * standard for the locales that write in the Latin script. Decoding follows the standard's decoders, which replace invalid
 * bytes with U+FFFD, so an HTML file is read and never refused for its bytes.
 */

/** Bytes the prescan looks at, as in the standard. */
export const HTML_PRESCAN_BYTES = 1024;

const WINDOWS_1252 = 'windows-1252';
const UTF_8 = 'utf-8';
const REPLACEMENT_LABELS: ReadonlySet<string> = new Set(['replacement', 'iso-2022-kr', 'hz-gb-2312', 'iso-2022-cn', 'iso-2022-cn-ext']);

export type HtmlEncodingSource = 'bom' | 'declared' | 'valid-utf8' | 'default';

export interface HtmlEncoding {
  /** WHATWG encoding name. */
  encoding: string;
  source: HtmlEncodingSource;
}

const isAsciiWhitespace = (byte: number): boolean => byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
const isAsciiLetter = (byte: number): boolean => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
const lower = (byte: number): number => (byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);

/** The WHATWG name a meta declaration's label stands for, or null for a label that is not an encoding or must not be used. */
function encodingOfLabel(label: string): string | null {
  const trimmed = label.trim().toLowerCase();
  if (trimmed === '' || REPLACEMENT_LABELS.has(trimmed)) return null;
  let name: string;
  try {
    name = new TextDecoder(trimmed).encoding;
  } catch {
    return null;
  }
  // A declaration read as ASCII cannot be in UTF-16, so the standard takes it for UTF-8; x-user-defined is read as Windows-1252.
  if (name === 'utf-16le' || name === 'utf-16be') return UTF_8;
  if (name === 'x-user-defined') return WINDOWS_1252;
  return name;
}

/** The charset of a `content` attribute value (`text/html; charset=...`), by the standard's "algorithm for extracting a character encoding from a meta element". */
function charsetOfContent(content: string): string | null {
  const match = /charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;"']+))/i.exec(content);
  const label = match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
  return label === undefined ? null : label;
}

interface Attribute {
  name: string;
  value: string;
  next: number;
}

/** One attribute at `at` (the standard's "get an attribute"), or null when the tag ends. */
function readAttribute(bytes: Uint8Array, start: number, end: number): Attribute | null {
  let at = start;
  while (at < end && (isAsciiWhitespace(bytes[at]) || bytes[at] === 0x2f)) at++;
  if (at >= end || bytes[at] === 0x3e) return null;
  let name = '';
  while (at < end) {
    const byte = bytes[at];
    if (byte === 0x3d && name !== '') break;
    if (isAsciiWhitespace(byte) || byte === 0x2f || byte === 0x3e) break;
    name += String.fromCharCode(lower(byte));
    at++;
  }
  while (at < end && isAsciiWhitespace(bytes[at])) at++;
  if (at >= end || bytes[at] !== 0x3d) return { name, value: '', next: at };
  at++;
  while (at < end && isAsciiWhitespace(bytes[at])) at++;
  let value = '';
  const quote = bytes[at];
  if (quote === 0x22 || quote === 0x27) {
    at++;
    while (at < end && bytes[at] !== quote) value += String.fromCharCode(lower(bytes[at++]));
    return { name, value, next: Math.min(at + 1, end) };
  }
  while (at < end && !isAsciiWhitespace(bytes[at]) && bytes[at] !== 0x3e) value += String.fromCharCode(lower(bytes[at++]));
  return { name, value, next: at };
}

function startsWithAt(bytes: Uint8Array, at: number, text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (lower(bytes[at + index] ?? 0) !== text.charCodeAt(index)) return false;
  }
  return true;
}

function indexOfText(bytes: Uint8Array, from: number, end: number, text: string): number {
  for (let at = from; at + text.length <= end; at++) {
    if (startsWithAt(bytes, at, text)) return at;
  }
  return -1;
}

/** The encoding a `<meta>` element declares in the first 1024 bytes, or null (the standard's prescan algorithm). */
export function prescanHtmlEncoding(bytes: Uint8Array): string | null {
  const end = Math.min(bytes.length, HTML_PRESCAN_BYTES);
  let at = 0;
  while (at < end) {
    if (startsWithAt(bytes, at, '<!--')) {
      const close = indexOfText(bytes, at + 2, end, '-->');
      if (close < 0) return null;
      at = close + 3;
    } else if (startsWithAt(bytes, at, '<meta') && at + 5 < end && (isAsciiWhitespace(bytes[at + 5]) || bytes[at + 5] === 0x2f)) {
      const declared = metaEncoding(bytes, at + 5, end);
      if (declared !== null) return declared.encoding;
      at += 5;
    } else if (bytes[at] === 0x3c && at + 1 < end && (isAsciiLetter(bytes[at + 1]) || (bytes[at + 1] === 0x2f && isAsciiLetter(bytes[at + 2] ?? 0)))) {
      at = skipTag(bytes, at + 1, end);
    } else if (bytes[at] === 0x3c && at + 1 < end && (bytes[at + 1] === 0x21 || bytes[at + 1] === 0x2f || bytes[at + 1] === 0x3f)) {
      const close = bytes.indexOf(0x3e, at);
      if (close < 0 || close >= end) return null;
      at = close + 1;
    } else {
      at++;
    }
  }
  return null;
}

/** Past the end of the tag whose name starts at `at`: the attributes are read so that a `>` inside a quoted value does not end it. */
function skipTag(bytes: Uint8Array, start: number, end: number): number {
  let at = start;
  while (at < end && !isAsciiWhitespace(bytes[at]) && bytes[at] !== 0x3e) at++;
  for (let attribute = readAttribute(bytes, at, end); attribute !== null; attribute = readAttribute(bytes, at, end)) at = attribute.next;
  return at + 1;
}

function metaEncoding(bytes: Uint8Array, start: number, end: number): { encoding: string } | null {
  let at = start;
  let pragma = false;
  let needPragma: boolean | null = null;
  let charset: string | null = null;
  const seen = new Set<string>();
  for (let attribute = readAttribute(bytes, at, end); attribute !== null; attribute = readAttribute(bytes, at, end)) {
    at = attribute.next;
    if (seen.has(attribute.name)) continue;
    seen.add(attribute.name);
    if (attribute.name === 'http-equiv') {
      if (attribute.value === 'content-type') pragma = true;
    } else if (attribute.name === 'content') {
      const fromContent = charsetOfContent(attribute.value);
      if (fromContent !== null && charset === null) {
        charset = fromContent;
        needPragma = true;
      }
    } else if (attribute.name === 'charset') {
      charset = attribute.value;
      needPragma = false;
    }
  }
  if (charset === null || (needPragma === true && !pragma)) return null;
  const encoding = encodingOfLabel(charset);
  return encoding === null ? null : { encoding };
}

function bomEncoding(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return UTF_8;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder(UTF_8, { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The encoding of an HTML file and how it was found. */
export function sniffHtmlEncoding(bytes: Uint8Array): HtmlEncoding {
  const bom = bomEncoding(bytes);
  if (bom !== null) return { encoding: bom, source: 'bom' };
  const declared = prescanHtmlEncoding(bytes);
  if (declared !== null) return { encoding: declared, source: 'declared' };
  if (isValidUtf8(bytes)) return { encoding: UTF_8, source: 'valid-utf8' };
  return { encoding: WINDOWS_1252, source: 'default' };
}

/** Decodes an HTML file; a byte order mark is consumed and a byte the encoding cannot decode becomes U+FFFD. */
export function decodeHtmlInput(bytes: Uint8Array): string {
  const { encoding } = sniffHtmlEncoding(bytes);
  if (encoding === WINDOWS_1252) return decodeWindows1252(bytes);
  return new TextDecoder(encoding, { fatal: false, ignoreBOM: false }).decode(bytes);
}
