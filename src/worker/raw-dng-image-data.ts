import fs from 'node:fs';
import { readUInt16, readUInt32 } from '../lib/conversions/image-tiff-directories';

/**
 * Whether a DNG holds every byte of its raw image: each strip or tile that its directory lists for the raw image lies inside the file.
 * A cut DNG can still decode to a full-size image, because LibRaw checks for the end of the stream only until it has reported the first
 * error, so the file's own directory is what shows the cut.
 *
 * The rules follow rawspeed (LGPL-2.1, behaviour only, commit c48d5a6):
 * - Directories: the chain from the header (`TiffParser::parse`, src/librawspeed/parsers/TiffParser.cpp lines 82 to 96) and the SubIFDs of
 *   each (`TiffIFD::parseIFDEntry`, src/librawspeed/tiff/TiffIFD.cpp lines 87 to 92). A directory may not overlap one read before it
 *   (lines 126 to 133), and at most 10 directories hang from one parent, 28 lie in the file and 5 levels are nested (`TiffIFD::Limits`,
 *   src/librawspeed/tiff/TiffIFD.h lines 81 to 97, enforced by TiffIFD.cpp lines 258 to 297; the chain counts as the children of the
 *   header). A directory that breaks a rule is dropped, with the SubIFDs after it, or with the rest of the chain.
 * - An entry whose values lie outside the file is ignored (TiffEntry.cpp lines 73 to 98, TiffIFD.cpp lines 62 to 67).
 * - The raw image: the first directory, parents before their SubIFDs, that has a Compression tag and whose NewSubFileType marks neither a
 *   reduced-resolution (bit 0) nor a transparency (bit 2) image (`DngDecoder::dropUnsuportedChunks` and `decodeRawInternal`,
 *   src/librawspeed/decoders/DngDecoder.cpp lines 87 to 111 and 448 to 465; `TiffIFD::getIFDsWithTag`, TiffIFD.cpp lines 226 to 236).
 * - Its data: tiles when it lists TileOffsets, strips otherwise; as many byte counts as offsets, at least one, none empty and each inside the
 *   file (DngDecoder.cpp lines 321 to 326, 339 to 346 and 408 to 441). Overlapping tiles (line 432) are not looked for: they are no sign
 *   of a cut, and finding them would hold every range in memory.
 */

const TIFF_MAGIC = 42;
const HEADER_BYTES = 8;
const ENTRY_BYTES = 12;
const INLINE_VALUE_BYTES = 4;
const directoryBytes = (count: number): number => 2 + count * ENTRY_BYTES + 4;

const TAG_NEW_SUBFILE_TYPE = 254;
const TAG_COMPRESSION = 259;
const TAG_STRIP_OFFSETS = 273;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_BYTE_COUNTS = 325;
const TAG_SUB_IFDS = 330;
const READ_TAGS: ReadonlySet<number> = new Set([
  TAG_NEW_SUBFILE_TYPE, TAG_COMPRESSION, TAG_STRIP_OFFSETS, TAG_STRIP_BYTE_COUNTS, TAG_TILE_OFFSETS, TAG_TILE_BYTE_COUNTS, TAG_SUB_IFDS,
]);
/** Bytes per value of the integer types these tags hold: SHORT, LONG and IFD. */
const VALUE_BYTES: ReadonlyMap<number, number> = new Map([[3, 2], [4, 4], [13, 4]]);

const SUBFILE_REDUCED_RESOLUTION = 1 << 0;
const SUBFILE_TRANSPARENCY = 1 << 2;

const MAX_CHILDREN = 10;
const MAX_DIRECTORIES = 28;
const MAX_DEPTH = 5;
/** Strip or tile values read at a time, so a directory listing millions of strips is read in pieces. */
const VALUES_PER_READ = 16_384;

interface TiffReader {
  size: number;
  little: boolean;
  /** `length` bytes at `at`, or null when they do not lie inside the file. */
  bytes(at: number, length: number): Buffer | null;
}

/** An entry of one of the tags read, whose values lie inside the file. */
interface Entry {
  type: number;
  count: number;
  /** Offset of the first value. */
  at: number;
}

interface Directory {
  entries: Map<number, Entry>;
  next: number;
}

interface Walk {
  reader: TiffReader;
  /** The byte ranges of the directories read so far. */
  read: Array<[number, number]>;
}

function values(reader: TiffReader, entry: Entry, first: number, count: number): number[] {
  const size = VALUE_BYTES.get(entry.type) as number;
  const bytes = reader.bytes(entry.at + first * size, count * size) as Buffer;
  const read = size === 2 ? readUInt16 : readUInt32;
  return Array.from({ length: count }, (_, index) => read(bytes, index * size, reader.little));
}

/** The entry whose 12 bytes lie at `at`, or null when it holds no value of an integer type these tags use or its values leave the file. */
function readEntry(reader: TiffReader, entry: Buffer, at: number): Entry | null {
  const size = VALUE_BYTES.get(readUInt16(entry, 2, reader.little));
  const count = readUInt32(entry, 4, reader.little);
  if (size === undefined || count === 0) return null;
  const valuesAt = count * size <= INLINE_VALUE_BYTES ? at + 8 : readUInt32(entry, 8, reader.little);
  return valuesAt + count * size <= reader.size ? { type: readUInt16(entry, 2, reader.little), count, at: valuesAt } : null;
}

function readDirectory(walk: Walk, at: number): Directory | null {
  const { reader } = walk;
  const head = reader.bytes(at, 2);
  if (head === null || walk.read.length >= MAX_DIRECTORIES) return null;
  const count = readUInt16(head, 0, reader.little);
  const end = at + directoryBytes(count);
  const directory = reader.bytes(at, end - at);
  if (directory === null || walk.read.some(([start, stop]) => at < stop && start < end)) return null;
  walk.read.push([at, end]);
  const entries = new Map<number, Entry>();
  for (let offset = 2; offset < directory.length - 4; offset += ENTRY_BYTES) {
    const bytes = directory.subarray(offset, offset + ENTRY_BYTES);
    const tag = readUInt16(bytes, 0, reader.little);
    const entry = READ_TAGS.has(tag) ? readEntry(reader, bytes, at + offset) : null;
    if (entry !== null) entries.set(tag, entry);
  }
  return { entries, next: readUInt32(directory, directory.length - 4, reader.little) };
}

function isRawImage(reader: TiffReader, directory: Directory): boolean {
  if (!directory.entries.has(TAG_COMPRESSION)) return false;
  const subfile = directory.entries.get(TAG_NEW_SUBFILE_TYPE);
  const kind = subfile === undefined ? 0 : values(reader, subfile, 0, 1)[0];
  return (kind & (SUBFILE_REDUCED_RESOLUTION | SUBFILE_TRANSPARENCY)) === 0;
}

/** The raw image at or below `directory`, which lies `depth` levels below the header. */
function rawImageBelow(walk: Walk, directory: Directory, depth: number): Directory | null {
  if (isRawImage(walk.reader, directory)) return directory;
  const subIfds = directory.entries.get(TAG_SUB_IFDS);
  if (subIfds === undefined || depth >= MAX_DEPTH) return null;
  for (const offset of values(walk.reader, subIfds, 0, Math.min(subIfds.count, MAX_CHILDREN))) {
    const child = readDirectory(walk, offset);
    if (child === null) return null;
    const raw = rawImageBelow(walk, child, depth + 1);
    if (raw !== null) return raw;
  }
  return null;
}

function findRawImage(reader: TiffReader): Directory | null {
  const walk: Walk = { reader, read: [] };
  let at = readUInt32(reader.bytes(4, 4) as Buffer, 0, reader.little);
  for (let chained = 0; at !== 0 && chained < MAX_CHILDREN; chained += 1) {
    const directory = readDirectory(walk, at);
    if (directory === null) return null;
    const raw = rawImageBelow(walk, directory, 1);
    if (raw !== null) return raw;
    at = directory.next;
  }
  return null;
}

function holdsImageData(reader: TiffReader, raw: Directory): boolean {
  const tiled = raw.entries.has(TAG_TILE_OFFSETS);
  const offsets = raw.entries.get(tiled ? TAG_TILE_OFFSETS : TAG_STRIP_OFFSETS);
  const counts = raw.entries.get(tiled ? TAG_TILE_BYTE_COUNTS : TAG_STRIP_BYTE_COUNTS);
  if (offsets === undefined || counts === undefined || offsets.count !== counts.count) return false;
  for (let first = 0; first < offsets.count; first += VALUES_PER_READ) {
    const length = Math.min(VALUES_PER_READ, offsets.count - first);
    const starts = values(reader, offsets, first, length);
    if (values(reader, counts, first, length).some((size, index) => size < 1 || starts[index] + size > reader.size)) return false;
  }
  return true;
}

function openTiff(fd: number): TiffReader | null {
  const size = fs.fstatSync(fd).size;
  const bytes = (at: number, length: number): Buffer | null => {
    if (at + length > size) return null;
    const buffer = Buffer.alloc(length);
    return fs.readSync(fd, buffer, 0, length, at) === length ? buffer : null;
  };
  const header = bytes(0, HEADER_BYTES);
  const order = header?.toString('latin1', 0, 2);
  if (header === null || (order !== 'II' && order !== 'MM')) return null;
  const little = order === 'II';
  return readUInt16(header, 2, little) === TIFF_MAGIC ? { size, little, bytes } : null;
}

/** True when the DNG at `filePath` lists a raw image and holds every strip or tile of it; false for a cut file or one that is no DNG. */
export function dngHoldsRawImageData(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const reader = openTiff(fd);
    const raw = reader === null ? null : findRawImage(reader);
    return reader !== null && raw !== null && holdsImageData(reader, raw);
  } finally {
    fs.closeSync(fd);
  }
}
