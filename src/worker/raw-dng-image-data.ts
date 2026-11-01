import fs from 'node:fs';
import { readUInt16, readUInt32 } from '../lib/conversions/image-tiff-directories';

/**
 * Whether a DNG holds every byte of the raw image its decoder developed: each strip or tile that its raw directory lists lies inside the
 * file, and that directory is the size of the decoded picture. A cut DNG can still decode to a full-size image, because LibRaw checks for
 * the end of the stream only until it has reported the first error, so the file's own directory is what shows the cut.
 *
 * The rules follow rawspeed (LGPL-2.1, behaviour only, commit c48d5a6) and LibRaw (LGPL-2.1, behaviour only, 0.21.2):
 * - Directories: the chain from the header (`TiffParser::parse`, src/librawspeed/parsers/TiffParser.cpp lines 82 to 96) and the SubIFDs of
 *   each (`TiffIFD::parseIFDEntry`, src/librawspeed/tiff/TiffIFD.cpp lines 87 to 92). A directory may not overlap one read before it
 *   (lines 126 to 133), and at most 10 directories hang from one parent, 28 lie in the file and 5 levels are nested (`TiffIFD::Limits`,
 *   src/librawspeed/tiff/TiffIFD.h lines 81 to 97, enforced by TiffIFD.cpp lines 258 to 297; the chain counts as the children of the
 *   header). A directory that breaks a rule is dropped, with the SubIFDs after it, or with the rest of the chain.
 * - An entry whose values lie outside the file is ignored (TiffEntry.cpp lines 73 to 98, TiffIFD.cpp lines 62 to 67).
 * - The raw image: the first directory, parents before their SubIFDs, that has a Compression tag rawspeed decodes and whose
 *   NewSubFileType marks neither a reduced-resolution (bit 0) nor a transparency (bit 2) image (`DngDecoder::dropUnsuportedChunks` and
 *   `decodeRawInternal`, src/librawspeed/decoders/DngDecoder.cpp lines 87 to 146 and 448 to 465; `TiffIFD::getIFDsWithTag`, TiffIFD.cpp
 *   lines 226 to 236), and whose PhotometricInterpretation is CFA or Linear Raw, as LibRaw requires of a main image (`apply_tiff`,
 *   src/metadata/tiff.cpp lines 1627 to 1634).
 * - Its size: the ActiveArea when it has one, its ImageWidth and ImageLength otherwise, as LibRaw sizes the image it develops (tiff.cpp
 *   lines 1477 to 1482 and 1713 to 1714), in either orientation.
 * - Its data: tiles when it lists TileOffsets, strips otherwise; as many byte counts as offsets, at least one, none empty and each inside the
 *   file (DngDecoder.cpp lines 321 to 326, 339 to 346 and 408 to 441). Overlapping tiles (line 432) are not looked for: they are no sign
 *   of a cut, and finding them would hold every range in memory.
 */

/** What the check found: `whole`, or why the DNG's raw image cannot be shown to be in the file. */
export type DngRawImageData = 'whole' | 'not-classic-tiff' | 'no-raw-image' | 'unreadable-layout' | 'dimensions' | 'outside-file';

export interface ImageSize {
  width: number;
  height: number;
}

const TIFF_MAGIC = 42;
const HEADER_BYTES = 8;
const ENTRY_BYTES = 12;
const INLINE_VALUE_BYTES = 4;
const directoryBytes = (count: number): number => 2 + count * ENTRY_BYTES + 4;

const TAG = {
  newSubfileType: 254,
  imageWidth: 256,
  imageLength: 257,
  compression: 259,
  photometric: 262,
  stripOffsets: 273,
  stripByteCounts: 279,
  tileOffsets: 324,
  tileByteCounts: 325,
  subIfds: 330,
  activeArea: 50829,
} as const;
const READ_TAGS: ReadonlySet<number> = new Set(Object.values(TAG));

type ValueBytes = 2 | 4;
/** Bytes per value of the integer types these tags hold: SHORT, LONG and IFD. */
const VALUE_BYTES: ReadonlyMap<number, ValueBytes> = new Map([[3, 2], [4, 4], [13, 4]]);

const SUBFILE_REDUCED_RESOLUTION = 1 << 0;
const SUBFILE_TRANSPARENCY = 1 << 2;
/** Uncompressed, lossless JPEG, deflate, VC-5 and lossy JPEG: the compressions of `DngDecoder::dropUnsuportedChunks`. */
const DECODED_COMPRESSIONS: ReadonlySet<number> = new Set([1, 7, 8, 9, 0x884c]);
const PHOTOMETRIC_CFA = 32803;
const PHOTOMETRIC_LINEAR_RAW = 34892;
/** ActiveArea values: top, left, bottom, right. */
const ACTIVE_AREA_VALUES = 4;

const MAX_CHILDREN = 10;
const MAX_DIRECTORIES = 28;
const MAX_DEPTH = 5;
/** Strip or tile values read at a time, so a directory listing millions of strips is read in pieces. */
const VALUES_PER_READ = 16_384;

interface TiffReader {
  size: number;
  little: boolean;
  firstDirectory: number;
  within(at: number, length: number): boolean;
  /** `length` bytes at `at`, which the caller has found to lie inside the file. */
  read(at: number, length: number): Buffer;
}

/** An entry of one of the tags read, of an integer type, whose values lie inside the file. */
interface Entry {
  valueBytes: ValueBytes;
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
  const bytes = reader.read(entry.at + first * entry.valueBytes, count * entry.valueBytes);
  const read = entry.valueBytes === 2 ? readUInt16 : readUInt32;
  return Array.from({ length: count }, (_, index) => read(bytes, index * entry.valueBytes, reader.little));
}

const firstValue = (reader: TiffReader, entry: Entry | undefined): number | undefined => (entry === undefined ? undefined : values(reader, entry, 0, 1)[0]);

/** The entry whose 12 bytes lie at `at`, or null when it holds no value of an integer type these tags use or its values leave the file. */
function readEntry(reader: TiffReader, entry: Buffer, at: number): Entry | null {
  const valueBytes = VALUE_BYTES.get(readUInt16(entry, 2, reader.little));
  const count = readUInt32(entry, 4, reader.little);
  if (valueBytes === undefined || count === 0) return null;
  const valuesAt = count * valueBytes <= INLINE_VALUE_BYTES ? at + 8 : readUInt32(entry, 8, reader.little);
  return reader.within(valuesAt, count * valueBytes) ? { valueBytes, count, at: valuesAt } : null;
}

function readDirectory(walk: Walk, at: number): Directory | null {
  const { reader } = walk;
  if (!reader.within(at, 2) || walk.read.length >= MAX_DIRECTORIES) return null;
  const end = at + directoryBytes(readUInt16(reader.read(at, 2), 0, reader.little));
  if (!reader.within(at, end - at) || walk.read.some(([start, stop]) => at < stop && start < end)) return null;
  const directory = reader.read(at, end - at);
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
  const compression = firstValue(reader, directory.entries.get(TAG.compression));
  if (compression === undefined || !DECODED_COMPRESSIONS.has(compression)) return false;
  const kind = firstValue(reader, directory.entries.get(TAG.newSubfileType)) ?? 0;
  const photometric = firstValue(reader, directory.entries.get(TAG.photometric));
  return (kind & (SUBFILE_REDUCED_RESOLUTION | SUBFILE_TRANSPARENCY)) === 0
    && (photometric === PHOTOMETRIC_CFA || photometric === PHOTOMETRIC_LINEAR_RAW);
}

/** The raw image at or below `directory`, which lies `depth` levels below the header. */
function rawImageBelow(walk: Walk, directory: Directory, depth: number): Directory | null {
  if (isRawImage(walk.reader, directory)) return directory;
  const subIfds = directory.entries.get(TAG.subIfds);
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
  let at = reader.firstDirectory;
  for (let chained = 0; at !== 0 && chained < MAX_CHILDREN; chained += 1) {
    const directory = readDirectory(walk, at);
    if (directory === null) return null;
    const raw = rawImageBelow(walk, directory, 1);
    if (raw !== null) return raw;
    at = directory.next;
  }
  return null;
}

function rawSize(reader: TiffReader, raw: Directory): ImageSize | null {
  const area = raw.entries.get(TAG.activeArea);
  if (area !== undefined && area.count >= ACTIVE_AREA_VALUES) {
    const [top, left, bottom, right] = values(reader, area, 0, ACTIVE_AREA_VALUES);
    return { width: right - left, height: bottom - top };
  }
  const width = firstValue(reader, raw.entries.get(TAG.imageWidth));
  const height = firstValue(reader, raw.entries.get(TAG.imageLength));
  return width === undefined || height === undefined ? null : { width, height };
}

function matchesSize(size: ImageSize | null, decoded: ImageSize): boolean {
  if (size === null) return false;
  const same = size.width === decoded.width && size.height === decoded.height;
  return same || (size.width === decoded.height && size.height === decoded.width);
}

function imageData(reader: TiffReader, raw: Directory): DngRawImageData {
  const tiled = raw.entries.has(TAG.tileOffsets);
  const offsets = raw.entries.get(tiled ? TAG.tileOffsets : TAG.stripOffsets);
  const counts = raw.entries.get(tiled ? TAG.tileByteCounts : TAG.stripByteCounts);
  if (offsets === undefined || counts === undefined || offsets.count !== counts.count) return 'unreadable-layout';
  for (let first = 0; first < offsets.count; first += VALUES_PER_READ) {
    const length = Math.min(VALUES_PER_READ, offsets.count - first);
    const starts = values(reader, offsets, first, length);
    const sizes = values(reader, counts, first, length);
    if (sizes.includes(0)) return 'unreadable-layout';
    if (sizes.some((size, index) => starts[index] + size > reader.size)) return 'outside-file';
  }
  return 'whole';
}

function openTiff(fd: number): TiffReader | null {
  const size = fs.fstatSync(fd).size;
  const within = (at: number, length: number): boolean => at + length <= size;
  const read = (at: number, length: number): Buffer => {
    const buffer = Buffer.alloc(length);
    if (fs.readSync(fd, buffer, 0, length, at) !== length) throw new Error(`The DNG changed while it was read: ${length} bytes at ${at} came back short`);
    return buffer;
  };
  if (!within(0, HEADER_BYTES)) return null;
  const header = read(0, HEADER_BYTES);
  const order = header.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  if (readUInt16(header, 2, little) !== TIFF_MAGIC) return null;
  return { size, little, firstDirectory: readUInt32(header, 4, little), within, read };
}

/** Whether the DNG at `filePath` holds every strip or tile of a raw image the size of `decoded`, the picture its decoder wrote. */
export function dngRawImageData(filePath: string, decoded: ImageSize): DngRawImageData {
  const fd = fs.openSync(filePath, 'r');
  try {
    const reader = openTiff(fd);
    if (reader === null) return 'not-classic-tiff';
    const raw = findRawImage(reader);
    if (raw === null) return 'no-raw-image';
    if (!matchesSize(rawSize(reader, raw), decoded)) return 'dimensions';
    return imageData(reader, raw);
  } finally {
    fs.closeSync(fd);
  }
}
