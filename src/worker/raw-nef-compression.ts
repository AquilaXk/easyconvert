import fs from 'node:fs';

/**
 * Which compression a Nikon NEF says it has, read from its maker note before any decoder runs.
 *
 * The camera records it in the maker note of the Exif directory: tag 0x0093 (NEFCompression, a SHORT) in older bodies, and tag 0x0051
 * (a 24 byte block whose SHORT at offset 10 is the compression) in the Z 6III, Z 8, Z 9 and Z f (ExifTool's Nikon tables, `NEFCompression`
 * and `MakerNotes0x51`). 13 is "High Efficiency" and 14 is "High Efficiency*"; LibRaw 0.22.3 and earlier have no decoder for either.
 * A Nikon maker note of the type with its own TIFF header is "Nikon\0", the version 2 and two reserved bytes, then a TIFF header whose
 * offsets all count from its first byte.
 */

const TIFF_MAGIC = 42;
const TIFF_HEADER_BYTES = 8;
const ENTRY_BYTES = 12;
const MAX_ENTRIES = 1024;
const TAG_EXIF_IFD = 0x8769;
const TAG_MAKER_NOTE = 0x927c;
const TAG_NEF_COMPRESSION = 0x0093;
const TAG_NEF_COMPRESSION_BLOCK = 0x0051;
const COMPRESSION_OFFSET_IN_BLOCK = 10;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_UNDEFINED = 7;
const NIKON_MAKER_NOTE_PREFIX = 'Nikon\0\u0002';
const MAKER_NOTE_TIFF_OFFSET = 10;

const NEF_COMPRESSION_HIGH_EFFICIENCY = 13;
const NEF_COMPRESSION_HIGH_EFFICIENCY_STAR = 14;

interface Entry {
  type: number;
  count: number;
  /** The 4 bytes of the value field. */
  field: Buffer;
}

/** Reads `length` bytes at `offset`, or null when they do not lie inside the file. */
type ReadAt = (offset: number, length: number) => Buffer | null;

const u16 = (bytes: Buffer, at: number, little: boolean): number => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
const u32 = (bytes: Buffer, at: number, little: boolean): number => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));

/** A TIFF header at `base`: its byte order and the offset of its first directory, or null. */
function readHeader(readAt: ReadAt, base: number): { little: boolean; first: number } | null {
  const header = readAt(base, TIFF_HEADER_BYTES);
  if (header === null) return null;
  const order = header.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  return u16(header, 2, little) === TIFF_MAGIC ? { little, first: u32(header, 4, little) } : null;
}

/** The entry of `tag` in the directory at `at` (counted from the start of the file), or null. */
function findEntry(readAt: ReadAt, at: number, little: boolean, tag: number): Entry | null {
  const countBytes = readAt(at, 2);
  if (countBytes === null) return null;
  const count = u16(countBytes, 0, little);
  if (count === 0 || count > MAX_ENTRIES) return null;
  const entries = readAt(at + 2, count * ENTRY_BYTES);
  if (entries === null) return null;
  for (let index = 0; index < count; index += 1) {
    const entry = entries.subarray(index * ENTRY_BYTES, (index + 1) * ENTRY_BYTES);
    if (u16(entry, 0, little) === tag) return { type: u16(entry, 2, little), count: u32(entry, 4, little), field: entry.subarray(8, 12) };
  }
  return null;
}

/** The compression value in the maker note at `noteAt`, or null. */
function readMakerNoteCompression(readAt: ReadAt, noteAt: number, noteLength: number): number | null {
  const prefix = readAt(noteAt, NIKON_MAKER_NOTE_PREFIX.length);
  if (prefix === null || prefix.toString('latin1') !== NIKON_MAKER_NOTE_PREFIX) return null;
  if (noteLength < MAKER_NOTE_TIFF_OFFSET + TIFF_HEADER_BYTES) return null;
  const base = noteAt + MAKER_NOTE_TIFF_OFFSET;
  const header = readHeader(readAt, base);
  if (header === null) return null;
  const { little } = header;
  const directory = base + header.first;

  const short = findEntry(readAt, directory, little, TAG_NEF_COMPRESSION);
  if (short !== null && short.type === TYPE_SHORT && short.count === 1) return u16(short.field, 0, little);

  const block = findEntry(readAt, directory, little, TAG_NEF_COMPRESSION_BLOCK);
  if (block !== null && block.type === TYPE_UNDEFINED && block.count >= COMPRESSION_OFFSET_IN_BLOCK + 2) {
    const value = readAt(base + u32(block.field, 0, little) + COMPRESSION_OFFSET_IN_BLOCK, 2);
    return value === null ? null : u16(value, 0, little);
  }
  return null;
}

/**
 * The NEFCompression of the Nikon NEF at `filePath`, or null when the file is not a TIFF with a Nikon maker note that records one
 * (another maker, a damaged file, an older maker note layout) or cannot be read. Reads a few hundred bytes at most.
 */
export function readNefCompression(filePath: string): number | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const readAt: ReadAt = (offset, length) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || length <= 0 || offset + length > size) return null;
      const bytes = Buffer.alloc(length);
      return fs.readSync(fd, bytes, 0, length, offset) === length ? bytes : null;
    };
    const header = readHeader(readAt, 0);
    if (header === null) return null;
    const exif = findEntry(readAt, header.first, header.little, TAG_EXIF_IFD);
    if (exif === null || exif.type !== TYPE_LONG || exif.count !== 1) return null;
    const note = findEntry(readAt, u32(exif.field, 0, header.little), header.little, TAG_MAKER_NOTE);
    if (note === null || note.type !== TYPE_UNDEFINED || note.count <= 4) return null;
    return readMakerNoteCompression(readAt, u32(note.field, 0, header.little), note.count);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** True when the NEF at `filePath` records High Efficiency or High Efficiency* compression. */
export function isHighEfficiencyNef(filePath: string): boolean {
  const compression = readNefCompression(filePath);
  return compression === NEF_COMPRESSION_HIGH_EFFICIENCY || compression === NEF_COMPRESSION_HIGH_EFFICIENCY_STAR;
}
