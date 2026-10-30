/**
 * An independent reader of Palm databases, PalmDOC text and MOBI/KF8 headers, written from the layout the MobileRead wiki
 * documents (PDB, PalmDOC, MOBI) and sharing no code with the converter. It judges a file by its structure (the database
 * header, the compression of the text records, the MOBI header, the EXTH records, the KF8 records) and reads the text of
 * a PalmDOC or MOBI 6 book by decompressing its records, so that a writer is not judged by its own reader.
 */

const PALMDB_NAME_BYTES = 32;
const PALMDB_TYPE_OFFSET = 60;
const PALMDB_CREATOR_OFFSET = 64;
const PALMDB_RECORD_COUNT_OFFSET = 76;
const PALMDB_RECORD_LIST_OFFSET = 78;
const PALMDB_RECORD_ENTRY_BYTES = 8;
const PALMDOC_HEADER_BYTES = 16;
const MOBI_MAGIC_OFFSET = 16;
const MOBI_HEADER_LENGTH_OFFSET = 20;
const MOBI_ENCODING_OFFSET = 28;
const MOBI_VERSION_OFFSET = 36;
const MOBI_FULL_NAME_OFFSET = 84;
const MOBI_FULL_NAME_LENGTH_OFFSET = 88;
const MOBI_EXTH_FLAGS_OFFSET = 128;
const MOBI_EXTRA_DATA_FLAGS_OFFSET = 0xf2;
const MOBI_HEADER_START = 16;
const EXTH_HAS_RECORDS_FLAG = 0x40;
const EXTH_RECORD_HEADER_BYTES = 8;

export interface PalmDatabase {
  name: string;
  type: string;
  creator: string;
  records: Buffer[];
}

/** Splits a Palm database into its records; a record list that does not fit the file is an error. */
export function readPalmDatabase(file: Buffer): PalmDatabase {
  if (file.length < PALMDB_RECORD_LIST_OFFSET) throw new Error('The file is shorter than a Palm database header.');
  const count = file.readUInt16BE(PALMDB_RECORD_COUNT_OFFSET);
  const offsets = Array.from({ length: count }, (_, index) => file.readUInt32BE(PALMDB_RECORD_LIST_OFFSET + index * PALMDB_RECORD_ENTRY_BYTES));
  const records = offsets.map((start, index) => {
    const end = index + 1 < count ? offsets[index + 1] : file.length;
    if (start > end || end > file.length) throw new Error(`Record ${index} lies outside the file.`);
    return file.subarray(start, end);
  });
  return {
    name: file.toString('latin1', 0, PALMDB_NAME_BYTES).replace(/\0.*$/s, ''),
    type: file.toString('latin1', PALMDB_TYPE_OFFSET, PALMDB_TYPE_OFFSET + 4),
    creator: file.toString('latin1', PALMDB_CREATOR_OFFSET, PALMDB_CREATOR_OFFSET + 4),
    records,
  };
}

export interface PalmDocHeader {
  compression: number;
  textLength: number;
  textRecordCount: number;
  recordSize: number;
}

export function readPalmDocHeader(record0: Buffer): PalmDocHeader {
  return {
    compression: record0.readUInt16BE(0),
    textLength: record0.readUInt32BE(4),
    textRecordCount: record0.readUInt16BE(8),
    recordSize: record0.readUInt16BE(10),
  };
}

/** PalmDOC LZ77 (MobileRead "PalmDOC"): literals, runs of 1 to 8 raw bytes, a space with a letter, and distance/length pairs. */
export function palmDocDecompress(input: Buffer): Buffer {
  const out: number[] = [];
  let at = 0;
  while (at < input.length) {
    const code = input[at++];
    if (code === 0 || (code >= 0x09 && code <= 0x7f)) {
      out.push(code);
    } else if (code <= 0x08) {
      for (let i = 0; i < code; i++) out.push(input[at++]);
    } else if (code >= 0xc0) {
      out.push(0x20, code ^ 0x80);
    } else {
      const pair = (code << 8) | input[at++];
      const distance = (pair >> 3) & 0x7ff;
      const length = (pair & 7) + 3;
      if (distance === 0 || distance > out.length) throw new Error('A PalmDOC back reference points before the text.');
      for (let i = 0; i < length; i++) out.push(out[out.length - distance]);
    }
  }
  return Buffer.from(out);
}

/** The number of bytes the trailing entry flagged by `bit` takes at the end of a text record (MobileRead "MOBI", extra data flags). */
function trailingEntryBytes(record: Buffer, end: number, bit: number, flags: number): number {
  if (bit === 0) return (record[end - 1] & 0b11) + 1;
  let size = 0;
  let shift = 0;
  for (let at = end - 1; at >= 0; at--) {
    size |= (record[at] & 0x7f) << shift;
    shift += 7;
    if (record[at] & 0x80) return size;
  }
  throw new Error(`The trailing entry of bit ${bit} (flags ${flags}) has no size.`);
}

export interface MobiBook {
  database: PalmDatabase;
  palmDoc: PalmDocHeader;
  /** The MOBI header's own length, its text encoding code page and its format version (6 for a MOBI book, 8 for KF8). */
  headerLength: number;
  encoding: number;
  version: number;
  fullName: string;
  /** EXTH records by type; a type may repeat. */
  exth: Map<number, Buffer[]>;
  extraDataFlags: number;
}

/** Reads the MOBI header and the EXTH records of record 0. */
export function readMobiBook(file: Buffer): MobiBook {
  const database = readPalmDatabase(file);
  const record0 = database.records[0];
  if (record0.toString('latin1', MOBI_MAGIC_OFFSET, MOBI_MAGIC_OFFSET + 4) !== 'MOBI') throw new Error('Record 0 has no MOBI header.');
  const headerLength = record0.readUInt32BE(MOBI_HEADER_LENGTH_OFFSET);
  const exth = new Map<number, Buffer[]>();
  const hasExth = (record0.readUInt32BE(MOBI_EXTH_FLAGS_OFFSET) & EXTH_HAS_RECORDS_FLAG) !== 0;
  if (hasExth) {
    const start = MOBI_HEADER_START + headerLength;
    if (record0.toString('latin1', start, start + 4) !== 'EXTH') throw new Error('The MOBI header announces EXTH records that are not there.');
    const count = record0.readUInt32BE(start + 8);
    let at = start + 12;
    for (let i = 0; i < count; i++) {
      const type = record0.readUInt32BE(at);
      const length = record0.readUInt32BE(at + 4);
      exth.set(type, [...(exth.get(type) ?? []), record0.subarray(at + EXTH_RECORD_HEADER_BYTES, at + length)]);
      at += length;
    }
  }
  const nameStart = record0.readUInt32BE(MOBI_FULL_NAME_OFFSET);
  const nameLength = record0.readUInt32BE(MOBI_FULL_NAME_LENGTH_OFFSET);
  return {
    database,
    palmDoc: readPalmDocHeader(record0),
    headerLength,
    encoding: record0.readUInt32BE(MOBI_ENCODING_OFFSET),
    version: record0.readUInt32BE(MOBI_VERSION_OFFSET),
    fullName: record0.toString('utf-8', nameStart, nameStart + nameLength),
    exth,
    extraDataFlags: headerLength >= MOBI_EXTRA_DATA_FLAGS_OFFSET - MOBI_HEADER_START + 2 ? record0.readUInt16BE(MOBI_EXTRA_DATA_FLAGS_OFFSET) : 0,
  };
}

/** The text of the PalmDOC records (compression 1 or 2) of a Palm database, with the trailing entries of a MOBI record taken off. */
export function palmDocText(file: Buffer): Buffer {
  const { records } = readPalmDatabase(file);
  const header = readPalmDocHeader(records[0]);
  if (header.compression !== 1 && header.compression !== 2) throw new Error(`PalmDOC compression ${header.compression} is not read here.`);
  const flags = records[0].toString('latin1', MOBI_MAGIC_OFFSET, MOBI_MAGIC_OFFSET + 4) === 'MOBI' ? readMobiBook(file).extraDataFlags : 0;
  const parts: Buffer[] = [];
  for (const record of records.slice(1, 1 + header.textRecordCount)) {
    let end = record.length;
    // Bits 1 and up are backward-varint trailing entries, the entry of the lowest bit last in the record; bit 0 is the multibyte overlap, inside them all.
    for (let bit = 1; bit <= 15; bit++) if (flags & (1 << bit)) end -= trailingEntryBytes(record, end, bit, flags);
    if (flags & 1) end -= trailingEntryBytes(record, end, 0, flags);
    const body = record.subarray(0, end);
    parts.push(header.compression === 2 ? palmDocDecompress(body) : body);
  }
  const text = Buffer.concat(parts);
  if (text.length < header.textLength) throw new Error(`The text records hold ${text.length} of the ${header.textLength} bytes the header states.`);
  return text.subarray(0, header.textLength);
}

/** The records of a database that start with `magic` (FDST, FLIS, FCIS, INDX, BOUNDARY, EOF in a Kindle book). */
export function recordsStartingWith(database: PalmDatabase, magic: string): number[] {
  const bytes = Buffer.from(magic, 'latin1');
  return database.records.flatMap((record, index) => (record.subarray(0, bytes.length).equals(bytes) ? [index] : []));
}

const HTML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The words of a piece of markup: tags and entities resolved, white space collapsed, NFC. */
export function wordsOfMarkup(markup: string): string {
  return markup
    .replace(/<(?:head|script|style)\b[\s\S]*?<\/(?:head|script|style)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
      if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
      if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
      return HTML_ENTITIES[name.toLowerCase()] ?? match;
    })
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}
