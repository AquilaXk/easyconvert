import { DecompressionLimitError } from '../types';
import { InflateBudget, inflatePdfFlate, MAX_STREAM_INFLATE_BYTES } from './bounded-inflate';

/**
 * The decoded size of a JBIG2 stream, read from its first bytes before any tool decodes it.
 *
 * A JBIG2 stream (ITU-T T.88) is a run of segments, and its page information segment (type 48, section 7.4.8) opens with the
 * width and the height of the page as 32-bit big-endian integers. The PDF filter hands back one row of ceil(width / 8) bytes per
 * line, so a few kilobytes that declare a 100,000 x 100,000 page decode to 1.25 GB. Poppler decodes such a stream at full size
 * (for a page content stream it then reads the decoded bytes as operators and prints a diagnostic for each), which costs 25 to
 * 45 s and the whole output limit of the sandbox before it fails. The size is known after 30 bytes, so the stream is judged by
 * the limit of every other decoded stream (`MAX_STREAM_INFLATE_BYTES`) and refused with the same 413.
 *
 * Also handles ISO 32000-1 §7.3.5 `#XX` hex-escaped PDF Names and bounded `/Filter [/FlateDecode /JBIG2Decode]` chains;
 * other pre-filters (e.g. `ASCIIHexDecode`) fall through to downstream tool limits.
 */

const OBJECT_HEADER_PATTERN = /(\d+)\s+\d+\s+obj(?![a-z])/g;
const STREAM_KEYWORD = Buffer.from('stream', 'latin1');
const ENDSTREAM_KEYWORD = Buffer.from('endstream', 'latin1');
const END_OBJECT_KEYWORD = Buffer.from('endobj', 'latin1');
/** Bytes before the filter name that are searched for the object header (the dictionary of a picture is a few hundred). */
const DICTIONARY_LOOKBACK_BYTES = 16 * 1024;
const CHAR_CR = 0x0d;
const CHAR_LF = 0x0a;
const CHAR_LOWER_D = 0x64;
const CHAR_SLASH = 0x2f;
const CHAR_HASH = 0x23;
const CHAR_OPEN_BRACKET = 0x5b;
const CHAR_CLOSE_BRACKET = 0x5d;
const CHAR_LT = 0x3c;
const CHAR_GT = 0x3e;
const CHAR_OPEN_PAREN = 0x28;
const CHAR_CLOSE_PAREN = 0x29;
const CHAR_OPEN_BRACE = 0x7b;
const CHAR_CLOSE_BRACE = 0x7d;
const CHAR_BACKSLASH = 0x5c;
const CHAR_PERCENT = 0x25;
const MAX_PDF_NAME_RAW_BYTES = 96;
const MAX_FLATE_CHAIN_DEPTH = 8;

const PAGE_INFORMATION_SEGMENT = 48;
const PAGE_INFORMATION_BYTES = 19;
const PAGE_HEIGHT_OFFSET = 4;
const UNKNOWN_HEIGHT = 0xffffffff;
/** The page information segment comes first in every stream a writer produces; this many segments are walked at most. */
const MAX_SEGMENTS_BEFORE_PAGE_INFORMATION = 64;
const BITS_PER_BYTE = 8;

/** Fixed part of a segment header (section 7.2): number (4), flags (1), referred-to count byte (1). */
const SEGMENT_FLAGS_OFFSET = 4;
const REFERRED_COUNT_OFFSET = 5;
const PAGE_ASSOCIATION_4_BYTE_FLAG = 0x40;
const SEGMENT_TYPE_MASK = 0x3f;
const REFERRED_COUNT_SHORT_MAX = 4;
const REFERRED_COUNT_LONG_FORM = 7;
const REFERRED_COUNT_SHIFT = 5;
const LONG_FORM_COUNT_MASK = 0x1fffffff;
const LONG_FORM_COUNT_BYTES = 4;
const SEGMENT_NUMBER_ONE_BYTE_MAX = 256;
const SEGMENT_NUMBER_TWO_BYTE_MAX = 65536;
const DATA_LENGTH_BYTES = 4;

export interface SegmentHeader {
  type: number;
  dataStart: number;
  dataLength: number;
}

/** Pixels the page information segment declares. */
interface Jbig2Page {
  width: number;
  height: number;
}

/** Bytes of one referred-to segment number: 1, 2 or 4 by the number of the segment that refers (section 7.2.5). */
function referredNumberBytes(segmentNumber: number): number {
  if (segmentNumber <= SEGMENT_NUMBER_ONE_BYTE_MAX) return 1;
  return segmentNumber <= SEGMENT_NUMBER_TWO_BYTE_MAX ? 2 : 4;
}

/** The segment header at `at`, or null when the bytes are no header or run past the buffer. */
export function segmentHeaderAt(data: Buffer, at: number): SegmentHeader | null {
  if (at + REFERRED_COUNT_OFFSET + 1 > data.length) return null;
  const segmentNumber = data.readUInt32BE(at);
  const flags = data[at + SEGMENT_FLAGS_OFFSET];
  const shortCount = data[at + REFERRED_COUNT_OFFSET] >> REFERRED_COUNT_SHIFT;
  let referredCount: number;
  let cursor: number;
  if (shortCount <= REFERRED_COUNT_SHORT_MAX) {
    referredCount = shortCount;
    cursor = at + REFERRED_COUNT_OFFSET + 1;
  } else if (shortCount === REFERRED_COUNT_LONG_FORM) {
    if (at + REFERRED_COUNT_OFFSET + LONG_FORM_COUNT_BYTES > data.length) return null;
    referredCount = data.readUInt32BE(at + REFERRED_COUNT_OFFSET) & LONG_FORM_COUNT_MASK;
    cursor = at + REFERRED_COUNT_OFFSET + LONG_FORM_COUNT_BYTES + Math.ceil((referredCount + 1) / BITS_PER_BYTE);
  } else {
    return null;
  }
  cursor += referredCount * referredNumberBytes(segmentNumber);
  cursor += (flags & PAGE_ASSOCIATION_4_BYTE_FLAG) !== 0 ? 4 : 1;
  if (cursor + DATA_LENGTH_BYTES > data.length) return null;
  return { type: flags & SEGMENT_TYPE_MASK, dataStart: cursor + DATA_LENGTH_BYTES, dataLength: data.readUInt32BE(cursor) };
}

/**
 * The page the JBIG2 stream that starts at `start` in `data` declares in its page information segment; null when no such
 * segment is read there, or when the page is striped with an unknown height (it grows as stripes arrive).
 */
function jbig2PageAt(data: Buffer, start: number): Jbig2Page | null {
  let at = start;
  for (let walked = 0; walked < MAX_SEGMENTS_BEFORE_PAGE_INFORMATION; walked++) {
    const header = segmentHeaderAt(data, at);
    if (header === null || header.dataStart + header.dataLength > data.length) return null;
    if (header.type === PAGE_INFORMATION_SEGMENT) {
      if (header.dataLength < PAGE_INFORMATION_BYTES) return null;
      const height = data.readUInt32BE(header.dataStart + PAGE_HEIGHT_OFFSET);
      return height === UNKNOWN_HEIGHT ? null : { width: data.readUInt32BE(header.dataStart), height };
    }
    at = header.dataStart + header.dataLength;
  }
  return null;
}

/** Bytes a page decodes to: whole bytes per row. */
function decodedBytesOf(page: Jbig2Page): number {
  return Math.ceil(page.width / BITS_PER_BYTE) * page.height;
}

/** Bytes the JBIG2 stream that starts at `start` in `data` decodes to, or null as `jbig2PageAt`. */
export function jbig2DecodedBytes(data: Buffer, start: number): number | null {
  const page = jbig2PageAt(data, start);
  return page === null ? null : decodedBytesOf(page);
}

/** Work of one search, for the tests: names looked at, and bytes the search moved over (keyword searches and dictionary text). */
export interface Jbig2ScanStats {
  namesExamined: number;
  bytesScanned: number;
}

/**
 * Names of the filter one search looks at. A file made of the name alone has one at every 12 bytes; the search is linear in the
 * size of the file whatever their number, and past this many it stops: the stream limit of the tools (a 413, see
 * `toPopplerOutputLimitError`) answers for the rest.
 */
export const MAX_JBIG2_NAMES_EXAMINED = 4096;

/** True for a `stream` keyword at `at` that is not the end of `endstream`. */
function isStreamKeyword(pdf: Buffer, at: number): boolean {
  return at === 0 || pdf[at - 1] !== CHAR_LOWER_D;
}

/**
 * The next occurrence of a keyword at or after a position, for positions that only grow. The occurrence found is kept, so
 * the names that precede it ask once, and a search that finds none is never repeated: each byte is read once per keyword.
 */
class ForwardKeywordSearch {
  private found = -1;
  private exhausted = false;

  constructor(
    private readonly pdf: Buffer,
    private readonly keyword: Buffer,
    private readonly stats: Jbig2ScanStats,
    private readonly accepts: (at: number) => boolean = () => true
  ) {}

  /** Offset of the first occurrence at or after `from`, or -1 when there is none. */
  nextAtOrAfter(from: number): number {
    if (this.exhausted) return -1;
    if (this.found >= from) return this.found;
    let candidate = this.pdf.indexOf(this.keyword, from);
    while (candidate >= 0 && !this.accepts(candidate)) candidate = this.pdf.indexOf(this.keyword, candidate + this.keyword.length);
    this.stats.bytesScanned += (candidate < 0 ? this.pdf.length : candidate) - from;
    this.exhausted = candidate < 0;
    this.found = candidate;
    return candidate;
  }
}

interface Jbig2Stream {
  objectNumber: number;
  dataStart: number;
  flateLayers: number;
}

function isPdfDelimiterOrSpace(b: number): boolean {
  return (
    b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20 ||
    b === CHAR_OPEN_PAREN || b === CHAR_CLOSE_PAREN || b === CHAR_LT || b === CHAR_GT ||
    b === CHAR_OPEN_BRACKET || b === CHAR_CLOSE_BRACKET || b === CHAR_OPEN_BRACE || b === CHAR_CLOSE_BRACE ||
    b === CHAR_SLASH || b === CHAR_PERCENT
  );
}

function hexNibble(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  const lower = b | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
}

/** Decode an ISO 32000-1 §7.3.5 PDF Name starting at `/` with `#XX` hex escapes. */
function readPdfName(pdf: Buffer, slashAt: number): { name: string; end: number } {
  let i = slashAt + 1;
  const limit = Math.min(pdf.length, i + MAX_PDF_NAME_RAW_BYTES);
  let name = '';
  while (i < limit && !isPdfDelimiterOrSpace(pdf[i])) {
    if (pdf[i] === CHAR_HASH && i + 2 < pdf.length) {
      const hi = hexNibble(pdf[i + 1]);
      const lo = hexNibble(pdf[i + 2]);
      if (hi >= 0 && lo >= 0) {
        name += String.fromCharCode((hi << 4) | lo);
        i += 3;
        continue;
      }
    }
    name += String.fromCharCode(pdf[i]);
    i++;
  }
  return { name, end: i };
}

function isJbig2NameStart(pdf: Buffer, at: number): boolean {
  if (at >= pdf.length) return false;
  if (pdf[at] === 0x4a) return true;
  return pdf[at] === CHAR_HASH && at + 2 < pdf.length && pdf[at + 1] === 0x34 && (pdf[at + 2] | 0x20) === 0x61;
}

function findNextJbig2Name(pdf: Buffer, from: number, stats: Jbig2ScanStats): number {
  let pos = from;
  while (pos < pdf.length) {
    const slash = pdf.indexOf(CHAR_SLASH, pos);
    if (slash < 0) {
      stats.bytesScanned += pdf.length - from;
      return -1;
    }
    if (isJbig2NameStart(pdf, slash + 1)) {
      const { name, end } = readPdfName(pdf, slash);
      if (name === 'JBIG2Decode' && (end >= pdf.length || isPdfDelimiterOrSpace(pdf[end]))) {
        stats.bytesScanned += slash - from;
        return slash;
      }
    }
    pos = slash + 1;
  }
  stats.bytesScanned += pdf.length - from;
  return -1;
}

function skipPdfTrivia(pdf: Buffer, pos: number, end: number): number {
  let i = pos;
  while (i < end) {
    const b = pdf[i];
    if (b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20) {
      i++;
    } else if (b === CHAR_PERCENT) {
      while (i < end && pdf[i] !== CHAR_LF && pdf[i] !== CHAR_CR) i++;
    } else {
      break;
    }
  }
  return i;
}

function skipPdfLiteralString(pdf: Buffer, openAt: number, end: number): number {
  let i = openAt + 1;
  let depth = 1;
  while (i < end && depth > 0) {
    if (pdf[i] === CHAR_BACKSLASH) i += 2;
    else if (pdf[i] === CHAR_OPEN_PAREN) { depth++; i++; }
    else if (pdf[i] === CHAR_CLOSE_PAREN) { depth--; i++; }
    else i++;
  }
  return Math.min(i, end);
}

function readFilterArray(pdf: Buffer, bracketAt: number, end: number): { chain: string[]; next: number } {
  const chain: string[] = [];
  let i = bracketAt + 1;
  while (i < end) {
    i = skipPdfTrivia(pdf, i, end);
    if (i >= end || pdf[i] === CHAR_CLOSE_BRACKET) { i++; break; }
    if (pdf[i] === CHAR_SLASH) {
      const token = readPdfName(pdf, i);
      chain.push(token.name);
      i = token.end;
    } else {
      i++;
    }
  }
  return { chain, next: i };
}

function extractJbig2FilterChain(pdf: Buffer, start: number, end: number): string[] | null {
  let dictDepth = 0;
  let i = start;
  while (i < end) {
    i = skipPdfTrivia(pdf, i, end);
    if (i >= end) break;
    const b = pdf[i];
    if (b === CHAR_LT && i + 1 < end && pdf[i + 1] === CHAR_LT) { dictDepth++; i += 2; continue; }
    if (b === CHAR_GT && i + 1 < end && pdf[i + 1] === CHAR_GT) { if (dictDepth > 0) dictDepth--; i += 2; continue; }
    if (b === CHAR_OPEN_PAREN) { i = skipPdfLiteralString(pdf, i, end); continue; }
    if (b !== CHAR_SLASH) { i++; continue; }
    const key = readPdfName(pdf, i);
    i = key.end;
    if (dictDepth > 1 || key.name !== 'Filter') continue;
    i = skipPdfTrivia(pdf, i, end);
    if (i < end && pdf[i] === CHAR_SLASH) {
      const val = readPdfName(pdf, i);
      i = val.end;
      if (val.name === 'JBIG2Decode') return [val.name];
    } else if (i < end && pdf[i] === CHAR_OPEN_BRACKET) {
      const { chain, next } = readFilterArray(pdf, i, end);
      i = next;
      if (chain.includes('JBIG2Decode')) return chain;
    }
  }
  return null;
}

/** Start of the data after the `stream` keyword at `keywordAt` (one line feed, or a carriage return and a line feed). */
function streamDataStart(pdf: Buffer, keywordAt: number): number {
  let at = keywordAt + STREAM_KEYWORD.length;
  if (pdf[at] === CHAR_CR) at++;
  if (pdf[at] === CHAR_LF) at++;
  return at;
}

/**
 * The stream object whose dictionary, written between `regionStart` and `keywordAt`, uses `JBIG2Decode` directly or behind
 * bounded `FlateDecode` filters.
 */
function jbig2StreamIn(pdf: Buffer, nameAt: number, regionStart: number, keywordAt: number, stats: Jbig2ScanStats): Jbig2Stream | null {
  const lookbackStart = Math.max(nameAt - DICTIONARY_LOOKBACK_BYTES, regionStart);
  const dictionaryRegion = pdf.toString('latin1', lookbackStart, keywordAt);
  stats.bytesScanned += dictionaryRegion.length;
  const headers = [...dictionaryRegion.matchAll(OBJECT_HEADER_PATTERN)];
  const header = headers[headers.length - 1];
  if (header === undefined) return null;
  const chain = extractJbig2FilterChain(pdf, lookbackStart + header.index + header[0].length, keywordAt);
  const jbig2Index = chain ? chain.indexOf('JBIG2Decode') : -1;
  if (jbig2Index < 0) return null;
  for (let i = 0; i < jbig2Index; i++) {
    if (chain![i] !== 'FlateDecode') return null;
  }
  if (jbig2Index > MAX_FLATE_CHAIN_DEPTH) {
    throw new DecompressionLimitError(`PDF object ${header[1]} declares ${jbig2Index} FlateDecode layers before JBIG2Decode`);
  }
  return { objectNumber: Number(header[1]), dataStart: streamDataStart(pdf, keywordAt), flateLayers: jbig2Index };
}

function inspectJbig2Page(pdf: Buffer, stream: Jbig2Stream, budget: InflateBudget): Jbig2Page | null {
  if (stream.flateLayers === 0) return jbig2PageAt(pdf, stream.dataStart);
  const endAt = pdf.indexOf(ENDSTREAM_KEYWORD, stream.dataStart);
  let current = pdf.subarray(stream.dataStart, endAt >= 0 ? endAt : pdf.length);
  for (let layer = 0; layer < stream.flateLayers; layer++) {
    try {
      current = inflatePdfFlate(current, { label: `PDF object ${stream.objectNumber} JBIG2 filter`, budget });
    } catch (err) {
      if (err instanceof DecompressionLimitError) throw err;
      return null;
    }
  }
  return current.length > 0 ? jbig2PageAt(current, 0) : null;
}

/** A JBIG2 stream of a PDF and the page its page information segment declares. */
export interface DeclaredJbig2Page {
  objectNumber: number;
  width: number;
  height: number;
  /** Bytes the filter hands back: ceil(width / 8) per row. */
  decodedBytes: number;
}

/**
 * The JBIG2 streams of `pdf` (including `#XX` hex-escaped names and `/FlateDecode` chains) in file order. Fail-closed: throws
 * `DecompressionLimitError` if `MAX_JBIG2_NAMES_EXAMINED` is exhausted while unexamined JBIG2 names remain.
 */
export function* declaredJbig2Pages(pdf: Buffer, stats: Jbig2ScanStats = { namesExamined: 0, bytesScanned: 0 }): Generator<DeclaredJbig2Page> {
  const streams = new ForwardKeywordSearch(pdf, STREAM_KEYWORD, stats, (at) => isStreamKeyword(pdf, at));
  const objectEnds = new ForwardKeywordSearch(pdf, END_OBJECT_KEYWORD, stats);
  const budget = new InflateBudget();
  let resumeAt = 0;
  let regionStart = 0;
  while (stats.namesExamined < MAX_JBIG2_NAMES_EXAMINED) {
    const nameAt = findNextJbig2Name(pdf, resumeAt, stats);
    if (nameAt < 0) return;
    stats.namesExamined++;
    const keywordAt = streams.nextAtOrAfter(nameAt);
    if (keywordAt < 0) return;
    const objectEnd = objectEnds.nextAtOrAfter(nameAt);
    if (objectEnd >= 0 && objectEnd < keywordAt) {
      resumeAt = objectEnd;
      continue;
    }
    const stream = jbig2StreamIn(pdf, nameAt, regionStart, keywordAt, stats);
    resumeAt = keywordAt;
    regionStart = keywordAt;
    const page = stream === null ? null : inspectJbig2Page(pdf, stream, budget);
    if (stream !== null && page !== null) {
      yield { objectNumber: stream.objectNumber, ...page, decodedBytes: decodedBytesOf(page) };
    }
  }
  if (findNextJbig2Name(pdf, resumeAt, stats) >= 0) {
    throw new DecompressionLimitError(
      `PDF exceeds the maximum of ${MAX_JBIG2_NAMES_EXAMINED} examined JBIG2 filter names with uninspected JBIG2 entries remaining.`
    );
  }
}

/**
 * Refuses a PDF with a JBIG2 stream that decodes to more than `limitBytes`.
 * @throws DecompressionLimitError (413) naming the object, the declared page and the limit.
 */
export function assertPdfJbig2WithinLimits(pdf: Buffer, limitBytes: number = MAX_STREAM_INFLATE_BYTES): void {
  for (const page of declaredJbig2Pages(pdf)) {
    if (page.decodedBytes > limitBytes) {
      throw new DecompressionLimitError(
        `PDF stream of object ${page.objectNumber} is a JBIG2 page of ${page.width} x ${page.height} pixels that decodes to ${page.decodedBytes} bytes; the limit for one stream is ${limitBytes} bytes.`
      );
    }
  }
}
