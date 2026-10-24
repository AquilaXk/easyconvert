import { InflateBudget, inflateBounded } from '../bounded-inflate';
import { ConversionFailedError, PayloadLimitError } from '../../types';
import { HTML_MODEL_MAX_IMAGE_BYTES } from '../html-model';
import { decodeWindows1252 } from './windows-1252';

/**
 * Reads a RocketBook (.rb) container, the e-book format of the NuvoMedia Rocket eBook and the Gemstar REB 1100, into the
 * book it holds: the title and authors of its info page, its HTML pages in table order and its PNG pictures.
 *
 * Layout, from the MobileRead format page ("RB is a container for holding Rocket eBook content": an HTML file with its
 * images and a `.info` file of metadata) and from the behaviour of calibre's reader, which reads the same files
 * (src/calibre/ebooks/rb/reader.py lines 38-63, 74-107; rb/__init__.py line 5; metadata/rb.py lines 14-49; GPL-3.0, the
 * behaviour only is followed and no code is copied) and of two real files:
 *
 * - bytes 0-13 are the signature, 24-27 the offset of the table of contents, 28-31 the size of the whole file (a file of
 *   another size is corrupt, reader.py lines 43-48), all little-endian;
 * - the table is a 32-bit page count and then one 44-byte entry per page: a 32-byte name padded with NULs (percent-escaped),
 *   the stored size, the offset and the flags (reader.py lines 54-61);
 * - a page with flag 2 is the info page of `KEY=value` lines (TITLE and AUTHOR, metadata/rb.py lines 40-49);
 * - a page whose name ends in `html` is text, one whose name ends in `png` and whose flags are 0 is a picture
 *   (reader.py lines 116-123, 98-103); pages flagged 1 or 2 are not text (lines 75-76);
 * - a text page flagged 8 is a 32-bit chunk count, the 32-bit size of the text, the size of every chunk and then the
 *   zlib streams, one per chunk (lines 81-90); any other text page is stored as it is (line 92). Text is Windows-1252 (lines 90, 92).
 *
 * calibre has no limit on any count or size and trusts every offset. This reader keeps what it does on a well-formed file
 * and bounds the rest, the way the other e-book readers of this project do (`mobi-reader.ts`): see `ROCKETBOOK_LIMITS`.
 */

const SIGNATURE = Buffer.from([0xb0, 0x0c, 0xb0, 0x0c, 0x02, 0x00, 0x4e, 0x55, 0x56, 0x4f, 0x00, 0x00, 0x00, 0x00]);
const TOC_OFFSET_FIELD = 24;
const SIZE_FIELD = 28;
/** The header is read up to the size field: the signature, ten bytes and the two fields. */
const HEADER_BYTES = 32;
const TOC_ENTRY_BYTES = 44;
const NAME_BYTES = 32;
const ENTRY_SIZE_AT = NAME_BYTES;
const ENTRY_OFFSET_AT = NAME_BYTES + 4;
const ENTRY_FLAGS_AT = NAME_BYTES + 8;
const CHUNK_TABLE_HEAD_BYTES = 8;
const CHUNK_SIZE_BYTES = 4;
const PAGE_COUNT_BYTES = 4;

const FLAG_PLAIN = 0;
const FLAG_INFO = 2;
/** Pages flagged 1 or 2 are not text (reader.py lines 75-76). */
const NOT_TEXT_FLAGS: ReadonlySet<number> = new Set([1, FLAG_INFO]);
const FLAG_DEFLATED = 8;

/** The bounds on an untrusted file. calibre states none; the values are this project's, chosen from the sizes of real books and the other readers. */
export interface RocketBookLimits {
  /** Pages in the table of contents. Each entry is 44 bytes, so a file of N bytes holds fewer than N/44; 65,535 is the most a PalmDB e-book of this project may hold (`mobi-reader.ts`). */
  maxPages: number;
  /** Bytes of HTML all pages inflate to together: the document budget of `bounded-inflate.ts` and of `MOBI_MAX_TEXT_BYTES`. */
  maxTextBytes: number;
  /** Bytes one chunk inflates to. The writer of the real files cuts text in 4096-byte chunks (calibre rb/writer.py line 13); 1 MiB is 256 times that. */
  maxChunkBytes: number;
  /** Bytes of all pictures together: the limit of the HTML model's embedded pictures. */
  maxImageBytes: number;
  /** Bytes of the info page that are read; the title and authors are lines of it. */
  maxInfoBytes: number;
}

export const ROCKETBOOK_LIMITS: RocketBookLimits = {
  maxPages: 0xffff,
  maxTextBytes: 256 * 1024 * 1024,
  maxChunkBytes: 1024 * 1024,
  maxImageBytes: HTML_MODEL_MAX_IMAGE_BYTES,
  maxInfoBytes: 64 * 1024,
};

/** The file is not a RocketBook container, or is damaged. HTTP 400. */
export class RocketBookFormatError extends ConversionFailedError {
  readonly status = 400;

  constructor(reason: string) {
    super(`The file is not a readable RocketBook: ${reason}.`);
    this.name = 'RocketBookFormatError';
  }
}

export interface RocketBookPage {
  /** The name of the page in the table of contents, percent escapes decoded. */
  name: string;
  /** The HTML of the page. */
  html: string;
}

export interface RocketBook {
  title?: string;
  authors: string[];
  /** The text pages in table order. */
  pages: RocketBookPage[];
  /** The bytes of the PNG picture named `name`, or undefined for a name that is not one. */
  image(name: string): Buffer | undefined;
}

interface Entry {
  name: string;
  size: number;
  offset: number;
  flags: number;
}

interface Extent {
  start: number;
  end: number;
  name: string;
}

const PERCENT_ESCAPE = /%([0-9a-f]{2})/gi;
const UNDEFINED_WINDOWS_1252 = /[\u0081\u008d\u008f\u0090\u009d]/g;
const REPLACEMENT_CHARACTER = '�';
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
const AUTHOR_SEPARATOR = /,?\s+(?:and|with)\s+/gi;
const ESCAPED_AMPERSAND = '￿';

/** The name of an entry: the bytes without the NUL padding, percent escapes decoded to bytes and read as UTF-8 (reader.py line 59, 94). */
function entryName(raw: Buffer): string {
  let start = 0;
  let end = raw.length;
  while (start < end && raw[start] === 0) start += 1;
  while (end > start && raw[end - 1] === 0) end -= 1;
  const unescaped = raw.subarray(start, end).toString('latin1').replace(PERCENT_ESCAPE, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(unescaped, 'latin1').toString('utf-8');
}

function lookupName(source: string): string {
  try {
    return decodeURIComponent(source.replace(/^\.\//, ''));
  } catch {
    return source;
  }
}

function readEntries(file: Buffer, limits: RocketBookLimits): { entries: Entry[]; tableStart: number; tableEnd: number } {
  const tableStart = file.readUInt32LE(TOC_OFFSET_FIELD);
  if (tableStart < HEADER_BYTES || tableStart + PAGE_COUNT_BYTES > file.length) throw new RocketBookFormatError('the table of contents lies outside the file');
  const count = file.readUInt32LE(tableStart);
  const available = Math.floor((file.length - tableStart - PAGE_COUNT_BYTES) / TOC_ENTRY_BYTES);
  if (count > available) throw new RocketBookFormatError(`the table of contents lists ${count} pages and the file holds room for ${available}`);
  if (count > limits.maxPages) throw new PayloadLimitError(`The RocketBook lists more than ${limits.maxPages} pages.`);
  const entries: Entry[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = tableStart + PAGE_COUNT_BYTES + index * TOC_ENTRY_BYTES;
    entries.push({
      name: entryName(file.subarray(at, at + NAME_BYTES)),
      size: file.readUInt32LE(at + ENTRY_SIZE_AT),
      offset: file.readUInt32LE(at + ENTRY_OFFSET_AT),
      flags: file.readUInt32LE(at + ENTRY_FLAGS_AT),
    });
  }
  return { entries, tableStart, tableEnd: tableStart + PAGE_COUNT_BYTES + count * TOC_ENTRY_BYTES };
}

/** `[offset, offset + length)` as bytes of the file, or a format error when it leaves the file. */
function within(file: Buffer, entry: Entry, length: number): Buffer {
  if (entry.offset + length > file.length) throw new RocketBookFormatError(`page ${entry.name} lies outside the file`);
  return file.subarray(entry.offset, entry.offset + length);
}

/** The stored chunks of a deflated text page and the size of text it states (reader.py lines 82-87). */
function chunkTable(file: Buffer, entry: Entry, limits: RocketBookLimits): { chunks: Buffer[]; statedText: number; storedBytes: number } {
  const head = within(file, entry, CHUNK_TABLE_HEAD_BYTES);
  const count = head.readUInt32LE(0);
  const statedText = head.readUInt32LE(4);
  if (statedText > limits.maxTextBytes) throw new PayloadLimitError(`The RocketBook page ${entry.name} states ${statedText} bytes of text, more than the limit of ${limits.maxTextBytes}.`);
  const tableBytes = CHUNK_TABLE_HEAD_BYTES + count * CHUNK_SIZE_BYTES;
  if (count > (file.length - entry.offset - CHUNK_TABLE_HEAD_BYTES) / CHUNK_SIZE_BYTES) throw new RocketBookFormatError(`page ${entry.name} lists ${count} chunks that do not fit in the file`);
  const table = within(file, entry, tableBytes);
  const chunks: Buffer[] = [];
  let at = entry.offset + tableBytes;
  for (let index = 0; index < count; index += 1) {
    const size = table.readUInt32LE(CHUNK_TABLE_HEAD_BYTES + index * CHUNK_SIZE_BYTES);
    if (at + size > file.length) throw new RocketBookFormatError(`a chunk of page ${entry.name} lies outside the file`);
    chunks.push(file.subarray(at, at + size));
    at += size;
  }
  return { chunks, statedText, storedBytes: at - entry.offset };
}

function decodeText(bytes: Buffer): string {
  return decodeWindows1252(bytes).replace(UNDEFINED_WINDOWS_1252, REPLACEMENT_CHARACTER);
}

/** The authors of an `AUTHOR` value: split at `&`, `and` and `with`; `&&` is an ampersand of a name (calibre metadata/__init__.py `string_to_authors`, lines 27-33). */
function authorsOf(value: string): string[] {
  const split = value.replace(/&&/g, ESCAPED_AMPERSAND).replace(AUTHOR_SEPARATOR, '&').split('&');
  return split.map((author) => author.trim().replace(new RegExp(ESCAPED_AMPERSAND, 'g'), '&')).filter((author) => author !== '');
}

function readInfo(info: Buffer): { title?: string; authors: string[] } {
  let title: string | undefined;
  let authors: string[] = [];
  for (const line of info.toString('utf-8').split(LINE_BREAK)) {
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1);
    if (key === 'TITLE') title = value.trim() === '' ? undefined : value.trim();
    else if (key === 'AUTHOR') authors = authorsOf(value);
  }
  return { title, authors };
}

/** No two stored pages share a byte, and none lies on the header or the table: reading a page twice would otherwise cost the file's size every time. */
function assertDisjoint(extents: Extent[]): void {
  const sorted = extents.filter((extent) => extent.end > extent.start).sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start < sorted[index - 1].end) throw new RocketBookFormatError(`${sorted[index].name} and ${sorted[index - 1].name} overlap`);
  }
}

/** What the reader takes from one entry, found before any byte of it is inflated. */
type Plan =
  | { kind: 'info'; entry: Entry }
  | { kind: 'text'; entry: Entry; chunks: Buffer[] }
  | { kind: 'plain-text'; entry: Entry }
  | { kind: 'picture'; entry: Entry };

function planOf(file: Buffer, entries: readonly Entry[], limits: RocketBookLimits, extents: Extent[]): Plan[] {
  const plan: Plan[] = [];
  let hasInfo = false;
  let imageBytes = 0;
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    const span = (length: number): void => {
      extents.push({ start: entry.offset, end: entry.offset + length, name: entry.name });
    };
    if (entry.flags === FLAG_INFO && !hasInfo) {
      hasInfo = true;
      span(entry.size);
      plan.push({ kind: 'info', entry });
    } else if (lower.endsWith('html') && !NOT_TEXT_FLAGS.has(entry.flags)) {
      if (entry.flags === FLAG_DEFLATED) {
        const { chunks, storedBytes } = chunkTable(file, entry, limits);
        span(storedBytes);
        plan.push({ kind: 'text', entry, chunks });
      } else {
        span(entry.size);
        plan.push({ kind: 'plain-text', entry });
      }
    } else if (lower.endsWith('png') && entry.flags === FLAG_PLAIN) {
      span(entry.size);
      imageBytes += entry.size;
      if (imageBytes > limits.maxImageBytes) throw new PayloadLimitError(`The RocketBook pictures are larger than ${limits.maxImageBytes} bytes together.`);
      plan.push({ kind: 'picture', entry });
    }
  }
  return plan;
}

export function readRocketBook(file: Buffer, limits: RocketBookLimits = ROCKETBOOK_LIMITS): RocketBook {
  if (file.length < HEADER_BYTES || !file.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new RocketBookFormatError('it does not start with the RocketBook signature');
  if (file.readUInt32LE(SIZE_FIELD) !== file.length) throw new RocketBookFormatError('the size recorded in the header is not the size of the file');
  const { entries, tableStart, tableEnd } = readEntries(file, limits);
  const extents: Extent[] = [
    { start: 0, end: HEADER_BYTES, name: 'the header' },
    { start: tableStart, end: tableEnd, name: 'the table of contents' },
  ];
  const plan = planOf(file, entries, limits, extents);
  assertDisjoint(extents);

  const budget = new InflateBudget(limits.maxTextBytes);
  const pages: RocketBookPage[] = [];
  const images = new Map<string, Buffer>();
  let metadata: { title?: string; authors: string[] } | undefined;
  for (const step of plan) {
    const { entry } = step;
    const label = `RocketBook page ${entry.name}`;
    if (step.kind === 'info') {
      metadata = readInfo(within(file, entry, entry.size).subarray(0, limits.maxInfoBytes));
    } else if (step.kind === 'text') {
      const text = step.chunks.map((chunk) => inflateBounded(chunk, { label, format: 'zlib', maxOutputLength: limits.maxChunkBytes, budget }));
      pages.push({ name: entry.name, html: decodeText(Buffer.concat(text)) });
    } else if (step.kind === 'plain-text') {
      budget.charge(entry.size, label);
      pages.push({ name: entry.name, html: decodeText(within(file, entry, entry.size)) });
    } else {
      images.set(entry.name, within(file, entry, entry.size));
    }
  }
  return { title: metadata?.title, authors: metadata?.authors ?? [], pages, image: (name) => images.get(lookupName(name)) };
}
