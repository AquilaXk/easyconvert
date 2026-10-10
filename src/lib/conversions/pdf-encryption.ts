import { inflateSync } from 'node:zlib';
import { PdfStructureError, parseValue, skipWhite, type PdfDict, type PdfValue } from './pdf-document';

/**
 * Detects whether a PDF is encrypted with a minimal parser that reads only the cross-reference data, so the check
 * can run before any PDF library loads (and decrypts or mis-reads) the document.
 *
 * The parser finds `startxref` in the last PDF_TRAILER_SCAN_BYTES, then follows the chain of cross-reference sections
 * (a table with a `trailer`, or a cross-reference stream) through `/Prev`. A document is encrypted when any trailer
 * in the chain names `/Encrypt`: a newer section that omits the entry does not clear an older one. Page content,
 * object streams and every other object are never read.
 *
 * Hostile input is bounded: the chain is limited to MAX_CROSS_REFERENCE_SECTIONS sections and may not loop, a table
 * may not declare more entries than the file holds, and a cross-reference stream inflates to at most
 * MAX_XREF_STREAM_BYTES. A file whose trailer cannot be read answers a PdfStructureError (HTTP 400), never a guess.
 */

/** Bytes from the end of the file searched for `startxref` (the specification asks for 1024; writers add padding). */
export const PDF_TRAILER_SCAN_BYTES = 64 * 1024;
/** Cross-reference sections (the original and its incremental updates) one file may chain through `/Prev`. */
export const MAX_CROSS_REFERENCE_SECTIONS = 64;
/** Subsections one cross-reference table may declare. */
const MAX_XREF_SUBSECTIONS = 4096;
/** Largest cross-reference stream, packed or inflated; 8 MiB lists more than a million objects. */
const MAX_XREF_STREAM_BYTES = 8 * 1024 * 1024;
/** Bytes of the file read at once to parse one dictionary or section header. */
const PARSE_WINDOW_BYTES = 64 * 1024;
/** Bytes from the start of the file searched for the `%PDF-` header; offsets count from it. */
const HEADER_SEARCH_BYTES = 1024;
/** Every entry of a cross-reference table is 20 bytes: `nnnnnnnnnn ggggg n` and a two-byte end of line. */
const XREF_ENTRY_BYTES = 20;
const MAX_OFFSET_DIGITS = 12;
const MAX_FIELD_WIDTH = 8;
/** PNG predictor values start at 10; a cross-reference stream normally uses 12 (Up). */
const PNG_PREDICTOR_MIN = 10;
const PNG_FILTER_SUB = 1;
const PNG_FILTER_UP = 2;
const PNG_FILTER_AVERAGE = 3;
const PNG_FILTER_PAETH = 4;
const BYTE_MASK = 0xff;
const XREF_TYPE_IN_USE = 1;
const FLATE_FILTER_NAMES: ReadonlySet<string> = new Set(['FlateDecode', 'Fl']);
const OBJECT_HEADER = /^\s*(\d{1,10})\s+(\d{1,5})\s+obj\b/;

export interface PdfEncryptionInfo {
  encrypted: boolean;
  /** Security handler of the Encrypt dictionary (`Standard`); present only when the dictionary could be read. */
  filter?: string;
  /** Algorithm version (V) of the Encrypt dictionary. */
  v?: number;
  /** Standard handler revision (R). */
  r?: number;
  /** Permission flags (P) as the signed 32-bit value the specification defines. */
  p?: number;
}

interface CrossReferenceSection {
  trailer: PdfDict;
  /** Offset (from the header) of an in-use, uncompressed object this section lists; undefined when it does not. */
  offsetOf(objectNumber: number): number | undefined;
}

function isDict(value: PdfValue | undefined): value is PdfDict {
  return typeof value === 'object' && value !== null && value.kind === 'dict';
}

function window(pdf: Buffer, start: number, bytes = PARSE_WINDOW_BYTES): string {
  return pdf.toString('latin1', start, Math.min(pdf.length, start + bytes));
}

function findStartXref(pdf: Buffer): number {
  const tail = pdf.subarray(Math.max(0, pdf.length - PDF_TRAILER_SCAN_BYTES));
  const at = tail.lastIndexOf('startxref', undefined, 'latin1');
  if (at === -1) {
    throw new PdfStructureError(`PDF has no startxref in its last ${PDF_TRAILER_SCAN_BYTES} bytes.`);
  }
  const digits = new RegExp(`^\\s*(\\d{1,${MAX_OFFSET_DIGITS}})`).exec(tail.toString('latin1', at + 'startxref'.length, at + 'startxref'.length + 40));
  if (!digits) throw new PdfStructureError('PDF startxref is not followed by an offset.');
  return Number(digits[1]);
}

function looksLikeSectionStart(pdf: Buffer, start: number): boolean {
  if (start < 0 || start >= pdf.length) return false;
  const head = window(pdf, start, 64);
  const at = skipWhite(head, 0);
  return head.startsWith('xref', at) || OBJECT_HEADER.test(head.slice(at));
}

/** Offsets count from the `%PDF-` header; files with bytes in front of it are common enough to honour. */
function offsetBase(pdf: Buffer, startOffset: number): number {
  const header = pdf.subarray(0, HEADER_SEARCH_BYTES).indexOf('%PDF-', 0, 'latin1');
  const candidates = header > 0 ? [header, 0] : [0];
  const base = candidates.find((candidate) => looksLikeSectionStart(pdf, candidate + startOffset));
  if (base === undefined) throw new PdfStructureError('PDF startxref does not point at a cross-reference section.');
  return base;
}

function readTrailerDictionary(pdf: Buffer, start: number): PdfDict {
  const text = window(pdf, start);
  const value = parseValue(text, 0, 0).value;
  if (!isDict(value)) throw new PdfStructureError('PDF trailer is not a dictionary.');
  return value;
}

interface TableSubsection {
  first: number;
  count: number;
  entriesAt: number;
}

function readTableSection(pdf: Buffer, afterKeyword: number): CrossReferenceSection {
  const subsections: TableSubsection[] = [];
  let cursor = afterKeyword;
  for (;;) {
    if (subsections.length > MAX_XREF_SUBSECTIONS) {
      throw new PdfStructureError(`PDF cross-reference table has more than ${MAX_XREF_SUBSECTIONS} subsections.`);
    }
    const text = window(pdf, cursor, 128);
    const at = skipWhite(text, 0);
    if (text.startsWith('trailer', at)) {
      return tableSection(pdf, subsections, readTrailerDictionary(pdf, cursor + at + 'trailer'.length));
    }
    const header = /^(\d{1,10})[ \t]+(\d{1,10})[ \t]*/.exec(text.slice(at));
    if (!header) throw new PdfStructureError('PDF cross-reference table has a malformed subsection header.');
    const count = Number(header[2]);
    const entriesStart = cursor + at + header[0].length;
    const entriesAt = entriesStart + skipWhite(window(pdf, entriesStart, 4), 0);
    const end = entriesAt + count * XREF_ENTRY_BYTES;
    if (end > pdf.length) throw new PdfStructureError('PDF cross-reference table lists more entries than the file holds.');
    subsections.push({ first: Number(header[1]), count, entriesAt });
    cursor = end;
  }
}

function tableSection(pdf: Buffer, subsections: readonly TableSubsection[], trailer: PdfDict): CrossReferenceSection {
  return {
    trailer,
    offsetOf(objectNumber) {
      const subsection = subsections.find((candidate) => objectNumber >= candidate.first && objectNumber < candidate.first + candidate.count);
      if (!subsection) return undefined;
      const at = subsection.entriesAt + (objectNumber - subsection.first) * XREF_ENTRY_BYTES;
      const entry = /^(\d{10}) (\d{5}) ([nf])/.exec(pdf.toString('latin1', at, at + XREF_ENTRY_BYTES));
      return entry && entry[3] === 'n' ? Number(entry[1]) : undefined;
    },
  };
}

function numberList(value: PdfValue | undefined): number[] | undefined {
  if (typeof value !== 'object' || value === null || value.kind !== 'array') return undefined;
  return value.items.every((item) => typeof item === 'number') ? (value.items as number[]) : undefined;
}

function firstDecodeParms(value: PdfValue | undefined): PdfDict | undefined {
  if (isDict(value)) return value;
  if (typeof value === 'object' && value !== null && value.kind === 'array') {
    const [first] = value.items;
    return isDict(first) ? first : undefined;
  }
  return undefined;
}

function filterNames(value: PdfValue | undefined): string[] {
  if (typeof value === 'object' && value !== null && value.kind === 'name') return [value.value];
  if (typeof value === 'object' && value !== null && value.kind === 'array') {
    return value.items.flatMap((item) => (typeof item === 'object' && item !== null && item.kind === 'name' ? [item.value] : []));
  }
  return [];
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** Undoes the PNG row filters of a one-byte-per-sample stream; undefined for data that is not whole rows. */
function undoPngPredictor(data: Buffer, columns: number): Buffer | undefined {
  const rowBytes = columns + 1;
  if (columns < 1 || data.length % rowBytes !== 0) return undefined;
  const rows = data.length / rowBytes;
  const out = Buffer.alloc(rows * columns);
  for (let row = 0; row < rows; row++) {
    const filter = data[row * rowBytes];
    for (let column = 0; column < columns; column++) {
      const raw = data[row * rowBytes + 1 + column];
      const left = column > 0 ? out[row * columns + column - 1] : 0;
      const up = row > 0 ? out[(row - 1) * columns + column] : 0;
      const upLeft = row > 0 && column > 0 ? out[(row - 1) * columns + column - 1] : 0;
      let predicted: number;
      switch (filter) {
        case PNG_FILTER_SUB:
          predicted = left;
          break;
        case PNG_FILTER_UP:
          predicted = up;
          break;
        case PNG_FILTER_AVERAGE:
          predicted = (left + up) >> 1;
          break;
        case PNG_FILTER_PAETH:
          predicted = paeth(left, up, upLeft);
          break;
        default:
          predicted = 0;
      }
      out[row * columns + column] = (raw + predicted) & BYTE_MASK;
    }
  }
  return out;
}

/** The rows of a cross-reference stream, or undefined when the stream uses anything beyond Flate and PNG predictors. */
function decodeXrefStream(pdf: Buffer, dict: PdfDict, dataStart: number): Buffer | undefined {
  const length = dict.entries.get('Length');
  if (typeof length !== 'number' || length > MAX_XREF_STREAM_BYTES || dataStart + length > pdf.length) return undefined;
  const raw = pdf.subarray(dataStart, dataStart + length);
  const filters = filterNames(dict.entries.get('Filter'));
  let data = raw;
  if (filters.length > 1 || (filters.length === 1 && !FLATE_FILTER_NAMES.has(filters[0]))) return undefined;
  if (filters.length === 1) {
    try {
      data = inflateSync(raw, { maxOutputLength: MAX_XREF_STREAM_BYTES });
    } catch {
      return undefined;
    }
  }
  const parms = firstDecodeParms(dict.entries.get('DecodeParms'));
  const predictor = parms?.entries.get('Predictor');
  if (predictor === undefined || predictor === 1) return data;
  const columns = parms?.entries.get('Columns');
  if (typeof predictor !== 'number' || predictor < PNG_PREDICTOR_MIN || typeof columns !== 'number') return undefined;
  return undoPngPredictor(data, columns);
}

function readStreamSection(pdf: Buffer, objectStart: number): CrossReferenceSection {
  const text = window(pdf, objectStart);
  const header = OBJECT_HEADER.exec(text);
  if (!header) throw new PdfStructureError('PDF cross-reference stream has no object header.');
  const parsed = parseValue(text, header[0].length, 0);
  if (!isDict(parsed.value)) throw new PdfStructureError('PDF cross-reference stream has no dictionary.');
  const trailer = parsed.value;
  const type = trailer.entries.get('Type');
  if (!(typeof type === 'object' && type !== null && type.kind === 'name' && type.value === 'XRef')) {
    throw new PdfStructureError('PDF startxref points at an object that is not a cross-reference stream.');
  }
  const keyword = skipWhite(text, parsed.end);
  const streamStart = /^stream(\r\n|\n|\r)/.exec(text.slice(keyword));
  const widths = numberList(trailer.entries.get('W'));
  const unreadable = !streamStart || !widths || widths.length !== 3 || widths.some((w) => w < 0 || w > MAX_FIELD_WIDTH);
  let rows: Buffer | undefined;
  let decoded = false;
  return {
    trailer,
    offsetOf(objectNumber) {
      if (unreadable) return undefined;
      if (!decoded) {
        rows = decodeXrefStream(pdf, trailer, objectStart + keyword + streamStart[0].length);
        decoded = true;
      }
      return rows ? lookupInRows(rows, widths, trailer, objectNumber) : undefined;
    },
  };
}

function readField(row: Buffer, from: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) value = value * (BYTE_MASK + 1) + row[from + i];
  return value;
}

function lookupInRows(rows: Buffer, widths: number[], trailer: PdfDict, objectNumber: number): number | undefined {
  const [typeWidth, offsetWidth, generationWidth] = widths;
  const rowBytes = typeWidth + offsetWidth + generationWidth;
  if (rowBytes === 0) return undefined;
  const size = trailer.entries.get('Size');
  const index = numberList(trailer.entries.get('Index')) ?? [0, typeof size === 'number' ? size : 0];
  let rowIndex = 0;
  for (let pair = 0; pair + 1 < index.length; pair += 2) {
    const [first, count] = [index[pair], index[pair + 1]];
    if (objectNumber >= first && objectNumber < first + count) {
      const at = (rowIndex + objectNumber - first) * rowBytes;
      if (at + rowBytes > rows.length) return undefined;
      const entryType = typeWidth === 0 ? XREF_TYPE_IN_USE : readField(rows, at, typeWidth);
      return entryType === XREF_TYPE_IN_USE ? readField(rows, at + typeWidth, offsetWidth) : undefined;
    }
    rowIndex += count;
  }
  return undefined;
}

function readSection(pdf: Buffer, start: number): CrossReferenceSection {
  const head = window(pdf, start, 64);
  const at = skipWhite(head, 0);
  if (head.startsWith('xref', at)) return readTableSection(pdf, start + at + 'xref'.length);
  return readStreamSection(pdf, start + at);
}

function readCrossReferenceChain(pdf: Buffer): { sections: CrossReferenceSection[]; base: number } {
  const startOffset = findStartXref(pdf);
  const base = offsetBase(pdf, startOffset);
  const sections: CrossReferenceSection[] = [];
  const seen = new Set<number>();
  let offset: number | undefined = startOffset;
  while (offset !== undefined) {
    if (seen.has(offset) || sections.length >= MAX_CROSS_REFERENCE_SECTIONS) {
      throw new PdfStructureError(
        `PDF cross-reference chain loops or has more than ${MAX_CROSS_REFERENCE_SECTIONS} sections.`
      );
    }
    seen.add(offset);
    if (!looksLikeSectionStart(pdf, base + offset)) {
      throw new PdfStructureError('PDF /Prev does not point at a cross-reference section.');
    }
    const section = readSection(pdf, base + offset);
    sections.push(section);
    const previous = section.trailer.entries.get('Prev');
    offset = typeof previous === 'number' ? previous : undefined;
  }
  return { sections, base };
}

function readEncryptionDictionary(
  pdf: Buffer,
  value: PdfValue,
  sections: readonly CrossReferenceSection[],
  base: number
): PdfDict | undefined {
  if (isDict(value)) return value;
  if (typeof value !== 'object' || value === null || value.kind !== 'ref') return undefined;
  for (const section of sections) {
    const offset = section.offsetOf(value.num);
    if (offset === undefined) continue;
    const text = window(pdf, base + offset);
    const header = OBJECT_HEADER.exec(text);
    if (!header || Number(header[1]) !== value.num) return undefined;
    const parsed = parseValue(text, header[0].length, 0).value;
    return isDict(parsed) ? parsed : undefined;
  }
  return undefined;
}

function numberEntry(dict: PdfDict, key: string): number | undefined {
  const value = dict.entries.get(key);
  return typeof value === 'number' ? value : undefined;
}

/**
 * Whether `pdf` is encrypted, and the algorithm, revision and permission flags of its Encrypt dictionary when that
 * dictionary can be read. Encryption is reported whenever a trailer names `/Encrypt`, even if the dictionary itself
 * cannot be resolved.
 *
 * @throws PdfStructureError (400) when no cross-reference section can be read from the end of the file.
 */
export function inspectPdfEncryption(pdf: Buffer): PdfEncryptionInfo {
  const { sections, base } = readCrossReferenceChain(pdf);
  const owner = sections.find((section) => section.trailer.entries.has('Encrypt'));
  if (!owner) return { encrypted: false };

  const info: PdfEncryptionInfo = { encrypted: true };
  const dict = readEncryptionDictionary(pdf, owner.trailer.entries.get('Encrypt') ?? null, sections, base);
  if (!dict) return info;
  const filter = dict.entries.get('Filter');
  if (typeof filter === 'object' && filter !== null && filter.kind === 'name') info.filter = filter.value;
  info.v = numberEntry(dict, 'V');
  info.r = numberEntry(dict, 'R');
  const permissions = numberEntry(dict, 'P');
  // Writers store P as an unsigned 32-bit number as well; the specification defines the signed value.
  if (permissions !== undefined) info.p = permissions >> 0;
  return info;
}
