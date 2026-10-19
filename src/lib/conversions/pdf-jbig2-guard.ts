import { DecompressionLimitError } from '../types';
import { MAX_STREAM_INFLATE_BYTES } from './bounded-inflate';

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
 * Only a stream whose first filter is JBIG2Decode is read: behind another filter (a wrapper of ASCIIHexDecode or FlateDecode)
 * the segments are not in the file as they are, and such a stream is left to the limits of the tools.
 */

const JBIG2_FILTER = Buffer.from('/JBIG2Decode', 'latin1');
const FIRST_FILTER_PATTERN = /\/Filter\s*(?:\[\s*)?\/JBIG2Decode(?![A-Za-z0-9])/;
const OBJECT_HEADER_PATTERN = /(\d+)\s+\d+\s+obj(?![a-z])/g;
const STREAM_KEYWORD = Buffer.from('stream', 'latin1');
const END_OBJECT_KEYWORD = Buffer.from('endobj', 'latin1');
/** Bytes before the filter name that are searched for the object header (the dictionary of a picture is a few hundred). */
const DICTIONARY_LOOKBACK_BYTES = 16 * 1024;
const CHAR_CR = 0x0d;
const CHAR_LF = 0x0a;
const CHAR_LOWER_D = 0x64;

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

interface SegmentHeader {
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
function segmentHeaderAt(data: Buffer, at: number): SegmentHeader | null {
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

interface Jbig2Stream {
  objectNumber: number;
  dataStart: number;
}

/** True for a `stream` keyword at `at` that is not the end of `endstream`. */
function isStreamKeyword(pdf: Buffer, at: number): boolean {
  return at === 0 || pdf[at - 1] !== CHAR_LOWER_D;
}

/** Start of the data after the `stream` keyword at `keywordAt` (one line feed, or a carriage return and a line feed). */
function streamDataStart(pdf: Buffer, keywordAt: number): number {
  let at = keywordAt + STREAM_KEYWORD.length;
  if (pdf[at] === CHAR_CR) at++;
  if (pdf[at] === CHAR_LF) at++;
  return at;
}

/** The stream object whose dictionary names JBIG2Decode as its first filter at `nameAt`; null for the name anywhere else. */
function jbig2StreamAround(pdf: Buffer, nameAt: number): Jbig2Stream | null {
  let keywordAt = pdf.indexOf(STREAM_KEYWORD, nameAt);
  while (keywordAt >= 0 && !isStreamKeyword(pdf, keywordAt)) keywordAt = pdf.indexOf(STREAM_KEYWORD, keywordAt + STREAM_KEYWORD.length);
  if (keywordAt < 0) return null;
  const objectEnd = pdf.indexOf(END_OBJECT_KEYWORD, nameAt);
  if (objectEnd >= 0 && objectEnd < keywordAt) return null;
  const dictionaryRegion = pdf.toString('latin1', Math.max(0, nameAt - DICTIONARY_LOOKBACK_BYTES), keywordAt);
  const headers = [...dictionaryRegion.matchAll(OBJECT_HEADER_PATTERN)];
  const header = headers[headers.length - 1];
  if (header === undefined || !FIRST_FILTER_PATTERN.test(dictionaryRegion.slice(header.index))) return null;
  return { objectNumber: Number(header[1]), dataStart: streamDataStart(pdf, keywordAt) };
}

/** A JBIG2 stream of a PDF and the page its page information segment declares. */
export interface DeclaredJbig2Page {
  objectNumber: number;
  width: number;
  height: number;
  /** Bytes the filter hands back: ceil(width / 8) per row. */
  decodedBytes: number;
}

/** The JBIG2 streams of `pdf` whose first filter is JBIG2Decode and whose page size is declared, in file order. */
export function* declaredJbig2Pages(pdf: Buffer): Generator<DeclaredJbig2Page> {
  for (let nameAt = pdf.indexOf(JBIG2_FILTER); nameAt >= 0; nameAt = pdf.indexOf(JBIG2_FILTER, nameAt + JBIG2_FILTER.length)) {
    const stream = jbig2StreamAround(pdf, nameAt);
    const page = stream === null ? null : jbig2PageAt(pdf, stream.dataStart);
    if (stream !== null && page !== null) {
      yield { objectNumber: stream.objectNumber, ...page, decodedBytes: decodedBytesOf(page) };
    }
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
