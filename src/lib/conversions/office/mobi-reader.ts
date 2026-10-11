import { ConversionFailedError } from '../../types';
import { EncryptedOfficeDocumentError } from './legacy-office-errors';
import { decodeWindows1252 } from './windows-1252';
import { htmlToText } from './html-text';

/**
 * Text of a MOBI, AZW or AZW3 e-book, read from the PalmDB container the way the MobileRead format notes
 * describe it: the record list, the PalmDOC header of record 0, the MOBI header that follows it (text
 * encoding and the trailing-entry flags), then every text record decompressed and decoded. Compression
 * type 1 (none) and type 2 (PalmDOC LZ77) are read; Huffman/CDIC (17480) is refused with a typed error, and a
 * DRM-protected book is refused with the encrypted-document error.
 */

const PALMDB_HEADER_BYTES = 78;
const PALMDB_TYPE_OFFSET = 60;
const PALMDB_CREATOR_OFFSET = 64;
const PALMDB_RECORD_COUNT_OFFSET = 76;
const PALMDB_RECORD_ENTRY_BYTES = 8;

const RECORD0_COMPRESSION_OFFSET = 0;
const RECORD0_TEXT_LENGTH_OFFSET = 4;
const RECORD0_TEXT_RECORD_COUNT_OFFSET = 8;
const RECORD0_ENCRYPTION_OFFSET = 12;
const PALMDOC_HEADER_BYTES = 16;
const MOBI_IDENTIFIER = 'MOBI';
const MOBI_HEADER_LENGTH_OFFSET = 20;
const MOBI_ENCODING_OFFSET = 28;
/** The trailing-entry flags sit at byte 242 of record 0; they exist when the MOBI header is at least 228 bytes long. */
const MOBI_EXTRA_FLAGS_OFFSET = 0xf2;
const MOBI_EXTRA_FLAGS_MIN_HEADER = 0xe4;
const MOBI_MIN_HEADER_FOR_ENCODING = MOBI_ENCODING_OFFSET + 4 - PALMDOC_HEADER_BYTES;

const COMPRESSION_NONE = 1;
const COMPRESSION_PALMDOC = 2;
const COMPRESSION_HUFFMAN = 17480;
const ENCODING_UTF8 = 65001;
const ENCODING_WINDOWS_1252 = 1252;

const PALMDB_BOOK_TYPES: ReadonlySet<string> = new Set(['BOOK', 'TEXt']);
const PALMDB_BOOK_CREATORS: ReadonlySet<string> = new Set(['MOBI', 'REAd']);

/** A text record never holds more than this many bytes once decompressed; the format's record size is 4096. */
const MOBI_MAX_RECORD_TEXT_BYTES = 64 * 1024;
/** The most text one e-book may declare: 256 MiB. */
export const MOBI_MAX_TEXT_BYTES = 256 * 1024 * 1024;
/** The PalmDB record list holds a 16-bit record count. */
const MOBI_MAX_TEXT_RECORDS = 0xffff;
const TRAILING_ENTRY_VARINT_MAX_BYTES = 4;
const TRAILING_FLAG_BITS_HIGH_TO_LOW = 15;
const MULTIBYTE_OVERLAP_MASK = 3;

const PALMDOC_COPY_LITERALS_MAX = 8;
const PALMDOC_DISTANCE_PAIR_FIRST = 0x80;
const PALMDOC_SPACE_PAIR_FIRST = 0xc0;
const PALMDOC_DISTANCE_MASK = 0x3fff;
const PALMDOC_DISTANCE_SHIFT = 3;
const PALMDOC_LENGTH_MASK = 7;
const PALMDOC_LENGTH_BASE = 3;
const PALMDOC_SPACE = 0x20;
const PALMDOC_SPACE_XOR = 0x80;
const PALMDOC_LITERAL_FIRST = 0x09;
const PALMDOC_LITERAL_LAST = 0x7f;

/** The book is intact but its text is in an encoding this reader does not decode (the format names UTF-8 and Windows-1252). HTTP 422. */
export class UnsupportedMobiEncodingError extends ConversionFailedError {
  readonly status = 422;
  constructor(encoding: number) {
    super(`The e-book's text encoding ${encoding} is neither UTF-8 nor Windows-1252, which this reader does not decode.`);
    this.name = 'UnsupportedMobiEncodingError';
  }
}

function assertReadableEncoding(encoding: number): void {
  if (encoding !== ENCODING_UTF8 && encoding !== ENCODING_WINDOWS_1252) throw new UnsupportedMobiEncodingError(encoding);
}

function malformed(reason: string): ConversionFailedError {
  return new ConversionFailedError(`The e-book is not a readable MOBI file: ${reason}.`);
}

/** The PalmDOC LZ77 scheme: literals, runs of literals, back references and space-plus-letter pairs. */
function decompressPalmDoc(record: Buffer): Buffer {
  const out = Buffer.alloc(MOBI_MAX_RECORD_TEXT_BYTES);
  let outLength = 0;
  const push = (byte: number) => {
    if (outLength >= out.length) throw malformed('a text record expands beyond the record size limit');
    out[outLength] = byte;
    outLength += 1;
  };
  let i = 0;
  while (i < record.length) {
    const c = record[i];
    i += 1;
    if (c === 0 || (c >= PALMDOC_LITERAL_FIRST && c <= PALMDOC_LITERAL_LAST)) {
      push(c);
    } else if (c <= PALMDOC_COPY_LITERALS_MAX) {
      if (i + c > record.length) throw malformed('a literal run is cut off');
      for (let k = 0; k < c; k += 1) push(record[i + k]);
      i += c;
    } else if (c < PALMDOC_SPACE_PAIR_FIRST) {
      if (i >= record.length) throw malformed('a back reference is cut off');
      const pair = ((c << 8) | record[i]) & PALMDOC_DISTANCE_MASK;
      i += 1;
      const distance = pair >> PALMDOC_DISTANCE_SHIFT;
      const length = (pair & PALMDOC_LENGTH_MASK) + PALMDOC_LENGTH_BASE;
      if (distance === 0 || distance > outLength) throw malformed('a back reference points before the start of the record');
      for (let k = 0; k < length; k += 1) push(out[outLength - distance]);
    } else {
      push(PALMDOC_SPACE);
      push(c ^ PALMDOC_SPACE_XOR);
    }
  }
  return out.subarray(0, outLength);
}

/** Length of one trailing entry, read backwards from the end of `data[0..end)`: a base-128 number whose last byte has the top bit set. */
function trailingEntryLength(data: Buffer, end: number): number {
  let result = 0;
  let shift = 0;
  let position = end;
  for (let read = 0; read < TRAILING_ENTRY_VARINT_MAX_BYTES && position > 0; read += 1) {
    position -= 1;
    const byte = data[position];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if (byte & 0x80) break;
  }
  return result;
}

/** Bytes after the text in a record: one entry per set flag bit (1 to 15), then the multibyte overlap of bit 0. */
function trailingBytes(data: Buffer, flags: number): number {
  let total = 0;
  for (let bit = TRAILING_FLAG_BITS_HIGH_TO_LOW; bit >= 1; bit -= 1) {
    if (flags & (1 << bit)) total += trailingEntryLength(data, data.length - total);
  }
  if (flags & 1) {
    if (data.length - total < 1) throw malformed('a trailing multibyte entry is cut off');
    total += (data[data.length - total - 1] & MULTIBYTE_OVERLAP_MASK) + 1;
  }
  if (total > data.length) throw malformed('the trailing entries of a text record are longer than the record');
  return total;
}

/** The decompressed text records of an e-book, as stored, with what the headers say about them. */
export interface MobiRawText {
  bytes: Buffer;
  /** Text encoding named by the MOBI header (1252 for a plain PalmDOC book). */
  encoding: number;
  /** False for a plain PalmDOC book, whose text is not markup. */
  isMobi: boolean;
}

/** The PalmDB container of a book: its records, each a slice of the file. */
interface PalmDb {
  recordCount: number;
  record: (index: number) => Buffer;
}

function readPalmDb(file: Buffer): PalmDb {
  if (file.length < PALMDB_HEADER_BYTES) throw malformed('the file is shorter than a PalmDB header');
  const type = file.toString('latin1', PALMDB_TYPE_OFFSET, PALMDB_TYPE_OFFSET + 4);
  const creator = file.toString('latin1', PALMDB_CREATOR_OFFSET, PALMDB_CREATOR_OFFSET + 4);
  if (!PALMDB_BOOK_TYPES.has(type) || !PALMDB_BOOK_CREATORS.has(creator)) {
    throw malformed(`the PalmDB type "${type}" and creator "${creator}" are not those of an e-book`);
  }
  const recordCount = file.readUInt16BE(PALMDB_RECORD_COUNT_OFFSET);
  if (recordCount < 2 || PALMDB_HEADER_BYTES + recordCount * PALMDB_RECORD_ENTRY_BYTES > file.length) {
    throw malformed('the record list is missing or cut off');
  }
  const offsets: number[] = [];
  for (let i = 0; i < recordCount; i += 1) {
    const offset = file.readUInt32BE(PALMDB_HEADER_BYTES + i * PALMDB_RECORD_ENTRY_BYTES);
    if (offset >= file.length || (i > 0 && offset < offsets[i - 1])) throw malformed(`record ${i} starts outside the file or out of order`);
    offsets.push(offset);
  }
  return { recordCount, record: (index) => file.subarray(offsets[index], index + 1 < recordCount ? offsets[index + 1] : file.length) };
}

/** Reads and decompresses every text record of a MOBI, AZW, AZW3 or AZW4 book. */
export function readMobiRawText(file: Buffer): MobiRawText {
  return readMobiRecords(file, readPalmDb(file));
}

function readMobiRecords(file: Buffer, db: PalmDb): MobiRawText {
  const { recordCount } = db;
  const recordBytes = db.record;
  const first = recordBytes(0);
  if (first.length < PALMDOC_HEADER_BYTES) throw malformed('record 0 is shorter than the PalmDOC header');
  const compression = first.readUInt16BE(RECORD0_COMPRESSION_OFFSET);
  const textLength = first.readUInt32BE(RECORD0_TEXT_LENGTH_OFFSET);
  const textRecords = first.readUInt16BE(RECORD0_TEXT_RECORD_COUNT_OFFSET);
  const encryption = first.readUInt16BE(RECORD0_ENCRYPTION_OFFSET);
  if (encryption !== 0) throw new EncryptedOfficeDocumentError('The e-book is protected by DRM, so its text cannot be read.');
  if (compression === COMPRESSION_HUFFMAN) {
    throw new ConversionFailedError('The e-book uses Huffman (HUFF/CDIC) compression, which this reader does not support.');
  }
  if (compression !== COMPRESSION_NONE && compression !== COMPRESSION_PALMDOC) {
    throw malformed(`compression type ${compression} is unknown`);
  }
  if (textLength > MOBI_MAX_TEXT_BYTES) {
    throw malformed(`the book declares ${textLength} bytes of text, more than the ${MOBI_MAX_TEXT_BYTES} byte limit`);
  }
  if (textRecords === 0 || textRecords > MOBI_MAX_TEXT_RECORDS || textRecords >= recordCount) {
    throw malformed(`the header names ${textRecords} text records in a file of ${recordCount} records`);
  }

  let encoding = ENCODING_WINDOWS_1252;
  let extraFlags = 0;
  // A plain PalmDOC book (type TEXt) has no MOBI header and its text is not markup.
  const isMobi = first.length >= PALMDOC_HEADER_BYTES + 4 && first.toString('latin1', PALMDOC_HEADER_BYTES, PALMDOC_HEADER_BYTES + 4) === MOBI_IDENTIFIER;
  if (isMobi) {
    const headerLength = first.readUInt32BE(MOBI_HEADER_LENGTH_OFFSET);
    if (headerLength >= MOBI_MIN_HEADER_FOR_ENCODING && first.length >= MOBI_ENCODING_OFFSET + 4) {
      encoding = first.readUInt32BE(MOBI_ENCODING_OFFSET);
    }
    if (headerLength >= MOBI_EXTRA_FLAGS_MIN_HEADER && first.length >= MOBI_EXTRA_FLAGS_OFFSET + 2) {
      extraFlags = first.readUInt16BE(MOBI_EXTRA_FLAGS_OFFSET);
    }
  }
  const parts: Buffer[] = [];
  let total = 0;
  for (let index = 1; index <= textRecords; index += 1) {
    const record = recordBytes(index);
    const body = record.subarray(0, record.length - trailingBytes(record, extraFlags));
    const text = compression === COMPRESSION_PALMDOC ? decompressPalmDoc(body) : body;
    total += text.length;
    if (total > MOBI_MAX_TEXT_BYTES) throw malformed(`the text is longer than the ${MOBI_MAX_TEXT_BYTES} byte limit`);
    parts.push(text);
  }
  return { bytes: Buffer.concat(parts), encoding, isMobi };
}

const MOBI_FULL_NAME_OFFSET = 0x54;
const MOBI_FULL_NAME_LENGTH_OFFSET = 0x58;
const MOBI_FIRST_IMAGE_OFFSET = 0x6c;
const MOBI_EXTH_FLAGS_OFFSET = 0x80;
const MOBI_EXTH_FLAG = 0x40;
const NO_RECORD = 0xffffffff;
const EXTH_MAGIC = 'EXTH';
const EXTH_HEADER_BYTES = 12;
const EXTH_RECORD_HEADER_BYTES = 8;
const EXTH_MAX_RECORDS = 1024;
const EXTH_AUTHOR = 100;
const EXTH_COVER_OFFSET = 201;
const EXTH_UPDATED_TITLE = 503;
const EXTH_LANGUAGE = 524;
const MOBI_MAX_METADATA_CHARS = 1024;
/** One picture record is at most this large; a book's pictures are limited again by the document model. */
const MOBI_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_MAGICS: ReadonlyArray<readonly number[]> = [
  [0xff, 0xd8, 0xff],
  [0x89, 0x50, 0x4e, 0x47],
  [0x47, 0x49, 0x46, 0x38],
  [0x42, 0x4d],
];

/** A MOBI book with its markup as stored (offsets in it are what the book's `filepos` links name) and its pictures and metadata. */
export interface MobiBook extends MobiRawText {
  title?: string;
  authors: string[];
  language?: string;
  /** Index (0-based, among the picture records) of the cover picture the book names. */
  coverIndex?: number;
  /** Bytes of picture number `index` (1-based, as `recindex` in the markup counts them); undefined when there is none or the record is not a picture. */
  image: (index: number) => Buffer | undefined;
}

function decodeMetadata(bytes: Buffer, encoding: number): string {
  const limited = bytes.subarray(0, MOBI_MAX_METADATA_CHARS * 4);
  const text = encoding === ENCODING_UTF8 ? limited.toString('utf-8') : decodeWindows1252(limited);
  return text.replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, MOBI_MAX_METADATA_CHARS);
}

function isPictureRecord(record: Buffer): boolean {
  return record.length > 0 && record.length <= MOBI_MAX_IMAGE_BYTES && IMAGE_MAGICS.some((magic) => magic.every((byte, at) => record[at] === byte));
}

/**
 * Reads a MOBI or AZW book with the markup, the pictures its `recindex` attributes number, the title, the authors, the
 * language and the cover the headers name. Metadata and pictures are optional: a header field or record that points
 * outside the book is ignored, never followed.
 */
export function readMobiBook(file: Buffer): MobiBook {
  const db = readPalmDb(file);
  const raw = readMobiRecords(file, db);
  const first = db.record(0);
  const book: MobiBook = { ...raw, authors: [], image: () => undefined };
  if (!raw.isMobi) return book;
  assertReadableEncoding(raw.encoding);
  const headerLength = first.readUInt32BE(MOBI_HEADER_LENGTH_OFFSET);
  const headerEnd = PALMDOC_HEADER_BYTES + headerLength;
  const has = (offset: number): boolean => headerLength >= offset + 4 - PALMDOC_HEADER_BYTES && first.length >= offset + 4;

  let fullName: string | undefined;
  if (has(MOBI_FULL_NAME_LENGTH_OFFSET)) {
    const start = first.readUInt32BE(MOBI_FULL_NAME_OFFSET);
    const length = first.readUInt32BE(MOBI_FULL_NAME_LENGTH_OFFSET);
    if (length > 0 && start >= headerEnd && start + length <= first.length) fullName = decodeMetadata(first.subarray(start, start + length), raw.encoding);
  }
  if (has(MOBI_EXTH_FLAGS_OFFSET) && (first.readUInt32BE(MOBI_EXTH_FLAGS_OFFSET) & MOBI_EXTH_FLAG) !== 0 && first.toString('latin1', headerEnd, headerEnd + 4) === EXTH_MAGIC) {
    readExth(first, headerEnd, raw.encoding, book);
  }
  book.title = book.title ?? (fullName === '' ? undefined : fullName);

  if (has(MOBI_FIRST_IMAGE_OFFSET)) {
    const firstImage = first.readUInt32BE(MOBI_FIRST_IMAGE_OFFSET);
    if (firstImage !== NO_RECORD && firstImage > 0 && firstImage < db.recordCount) {
      book.image = (index) => {
        if (!Number.isInteger(index) || index < 1 || firstImage + index - 1 >= db.recordCount) return undefined;
        const record = db.record(firstImage + index - 1);
        return isPictureRecord(record) ? record : undefined;
      };
    }
  }
  return book;
}

/** The metadata records of the EXTH header: a record that is cut off ends the list, and so does an implausible count. */
function readExth(first: Buffer, at: number, encoding: number, book: MobiBook): void {
  if (at + EXTH_HEADER_BYTES > first.length) return;
  const count = Math.min(first.readUInt32BE(at + 8), EXTH_MAX_RECORDS);
  let position = at + EXTH_HEADER_BYTES;
  for (let i = 0; i < count; i += 1) {
    if (position + EXTH_RECORD_HEADER_BYTES > first.length) return;
    const type = first.readUInt32BE(position);
    const length = first.readUInt32BE(position + 4);
    if (length < EXTH_RECORD_HEADER_BYTES || position + length > first.length) return;
    const data = first.subarray(position + EXTH_RECORD_HEADER_BYTES, position + length);
    if (type === EXTH_AUTHOR) {
      const author = decodeMetadata(data, encoding);
      if (author !== '') book.authors.push(author);
    } else if (type === EXTH_UPDATED_TITLE) {
      const title = decodeMetadata(data, encoding);
      if (title !== '') book.title = title;
    } else if (type === EXTH_LANGUAGE) {
      const language = decodeMetadata(data, encoding);
      if (language !== '') book.language = language;
    } else if (type === EXTH_COVER_OFFSET && data.length >= 4) {
      book.coverIndex = data.readUInt32BE(0);
    }
    position += length;
  }
}

/** The plain text of a MOBI, AZW or AZW3 e-book. A book whose text records hold no text throws a typed error. */
export function readMobiText(file: Buffer): string {
  const { bytes, encoding, isMobi } = readMobiRawText(file);
  assertReadableEncoding(encoding);
  const markup = encoding === ENCODING_UTF8 ? bytes.toString('utf-8') : decodeWindows1252(bytes);
  const withoutNulls = markup.replace(/\0/g, '');
  const text = isMobi ? htmlToText(withoutNulls) : withoutNulls.replace(/\r\n?/g, '\n').trim();
  if (text === '') throw new ConversionFailedError('The e-book holds no text.');
  return text;
}
