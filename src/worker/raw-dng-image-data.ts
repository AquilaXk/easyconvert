import fs from 'node:fs';
import { readUInt16, readUInt32 } from '../lib/conversions/image-tiff-directories';
import { RawDecodeError } from '../lib/types';

/**
 * Whether a DNG holds every byte of the raw image its decoder developed: each strip or tile of the directory LibRaw develops lies inside
 * the file, and the decoded picture is the size LibRaw writes from that directory. A cut DNG can still decode to a full-size image, because
 * LibRaw checks for the end of the stream only until it has reported the first error, so the file's own directory is what shows the cut.
 *
 * The directory and its size follow LibRaw (LGPL-2.1, behaviour only; lines of 0.21.4, the release of the worker image, the same rules in
 * 0.21.2 and 0.22.2), run as `dcraw_emu -T -6 -w -o 1 -Z`:
 * - Directories: the chain from the header (`parse_tiff`, src/metadata/tiff.cpp lines 1556 to 1574) and the SubIFDs of each, read where
 *   their entry is met among the parent's (`parse_tiff_ifd`, lines 549 to 577). At most 10
 *   are read (`tiff_ifd[LIBRAW_IFD_MAXCOUNT]`, libraw/libraw.h line 410 and libraw/libraw_const.h line 70; tiff.cpp lines 36 to 38). A
 *   directory of more than 512 entries, which is also what LibRaw reads past the end of the file (0xffff), counts toward the 10 and ends the
 *   list it is in (lines 46 to 48). An entry of more than 8 values that would end past twice the file size is skipped (lines 54 to 60).
 *   Values are read as `get2`, `getint` and `getreal` read them, with LibRaw's size for each type (src/tables/wblists.cpp lines 20 to 22)
 *   and the bytes past the end of the file as 0xff (src/utils/read_utils.cpp lines 45 to 123).
 * - The raw image: the first directory whose ImageWidth and ImageLength are 1 to 65535, whose NewSubFileType is 0 and whose
 *   PhotometricInterpretation is CFA or Linear Raw (`apply_tiff`, tiff.cpp lines 1622 to 1665, the frame at line 1697). With the engine's
 *   options, LibRaw's defaults (src/utils/init_close_utils.cpp line 90) and no `-s`, no other directory is a frame and the largest frame is
 *   not preferred, whatever its Compression.
 * - Its size: the ActiveArea when it has one, its ImageWidth and ImageLength otherwise (tiff.cpp lines 1487 to 1492 and 1723 to 1724;
 *   src/metadata/identify.cpp lines 976 to 979). LibRaw may then drop up to 18 rows or 16 columns for some models (identify.cpp lines 1018
 *   to 1031) and up to 5 to align the margins with the CFA pattern (src/utils/open.cpp lines 793 to 840), so the picture may be smaller by
 *   up to 23 on each axis. It stretches non-square pixels by the DefaultScale read last (tiff.cpp lines 1185 to 1195; `stretch`,
 *   src/postprocessing/aspect_ratio.cpp lines 69 to 105) and turns the picture when the first directory with an Orientation that turns or
 *   flips gives a flip with bit 2 (tiff.cpp lines 487 to 489 and 1840 to 1842; identify.cpp line 1281; src/write/file_write.cpp line 182).
 * - Its data follows rawspeed (LGPL-2.1, behaviour only, commit c48d5a6), which reads the raw data from nothing else: tiles when it lists
 *   TileOffsets, strips otherwise; SHORT or LONG arrays with as many byte counts as offsets, at least one, none empty and each inside the
 *   file (src/librawspeed/decoders/DngDecoder.cpp lines 321 to 326, 339 to 346 and 408 to 441). Overlapping tiles (line 432) are not looked
 *   for: they are no sign of a cut, and finding them would hold every range in memory.
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
const OFFSET_BYTES = 4;

const TAG = {
  newSubfileType: 254,
  imageWidth: 256,
  imageLength: 257,
  photometric: 262,
  stripOffsets: 273,
  orientation: 274,
  stripByteCounts: 279,
  tileOffsets: 324,
  tileByteCounts: 325,
  subIfds: 330,
  defaultScale: 50718,
  activeArea: 50829,
} as const;
const READ_TAGS: ReadonlySet<number> = new Set(Object.values(TAG));

const TYPE = { short: 3, long: 4, rational: 5, sshort: 8, slong: 9, srational: 10, float: 11, double: 12 } as const;
/** Bytes per value of each type as LibRaw counts them; a type above 18 counts as type 0. */
const UNIT_BYTES = [1, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4, 2, 8, 8, 8, 8];
const unitBytes = (type: number): number => UNIT_BYTES[type] ?? UNIT_BYTES[0];

type Real = (bytes: Buffer, little: boolean) => number;
const signed16: Real = (bytes, little) => (little ? bytes.readInt16LE(0) : bytes.readInt16BE(0));
const signed32: Real = (bytes, little) => (little ? bytes.readInt32LE(0) : bytes.readInt32BE(0));
/** `getreal` for each type: the bytes it reads and the value; any other type reads one byte. */
const REALS: ReadonlyMap<number, [number, Real]> = new Map<number, [number, Real]>([
  [TYPE.short, [2, (bytes, little) => readUInt16(bytes, 0, little)]],
  [TYPE.long, [4, (bytes, little) => readUInt32(bytes, 0, little)]],
  [TYPE.rational, [8, (bytes, little) => readUInt32(bytes, 0, little) / (readUInt32(bytes, 4, little) || 1)]],
  [TYPE.sshort, [2, signed16]],
  [TYPE.slong, [4, signed32]],
  [TYPE.srational, [8, (bytes, little) => signed32(bytes, little) / (signed32(bytes.subarray(4), little) || 1)]],
  [TYPE.float, [4, (bytes, little) => (little ? bytes.readFloatLE(0) : bytes.readFloatBE(0))]],
  [TYPE.double, [8, (bytes, little) => (little ? bytes.readDoubleLE(0) : bytes.readDoubleBE(0))]],
]);
const BYTE_REAL: [number, Real] = [1, (bytes) => bytes[0]];
/** Strip and tile arrays: SHORT or LONG. */
const ARRAY_VALUE_BYTES: ReadonlyMap<number, number> = new Map([[TYPE.short, 2], [TYPE.long, 4]]);

const MAX_DIRECTORIES = 10;
const MAX_ENTRIES = 512;
const MAX_VALUES_ALWAYS_READ = 8;
const MAX_SIDE = 65_535;
const PHOTOMETRIC_CFA = 32803;
const PHOTOMETRIC_LINEAR_RAW = 34892;
/** LibRaw's flip for Orientation & 7 (`"50132467"`); a flip with bit 2 set turns the picture. */
const FLIP_OF_ORIENTATION = [5, 0, 1, 3, 2, 4, 6, 7];
const FLIP_TURNS = 4;
const MIN_SCALE = Math.fround(0.00001);
const SQUARE_BELOW = 0.995;
const SQUARE_ABOVE = 1.005;
/** Rows or columns LibRaw may drop from the raw size: 18 for a model correction and 5 to align the margins. */
const MAX_TRIM = 18 + 5;
/** Strip or tile values read at a time, so a directory listing millions of strips is read in pieces. */
const VALUES_PER_READ = 16_384;

interface TiffReader {
  size: number;
  little: boolean;
  firstDirectory: number;
  within(at: number, length: number): boolean;
  /** `length` bytes at `at`, which the caller has found to lie inside the file. */
  read(at: number, length: number): Buffer;
  /** `length` bytes at `at`, those past the end of the file 0xff, as LibRaw's readers leave them. */
  readPadded(at: number, length: number): Buffer;
}

/** An entry of one of the tags read. */
interface Entry {
  type: number;
  count: number;
  /** Offset of the first value, inside the entry or where it points. */
  at: number;
}

interface Directory {
  entries: Map<number, Entry>;
  next: number;
}

interface Walk {
  reader: TiffReader;
  directories: Directory[];
  /** Directories LibRaw has counted, those it read no entries from included. */
  counted: number;
  pixelAspect: number;
}

const get2 = (reader: TiffReader, at: number): number => readUInt16(reader.readPadded(at, 2), 0, reader.little);
const get4 = (reader: TiffReader, at: number): number => readUInt32(reader.readPadded(at, 4), 0, reader.little);

/** `getint` `count` times from the first value of `entry`. */
function ints(reader: TiffReader, entry: Entry, count: number): number[] {
  const short = entry.type === TYPE.short;
  return Array.from({ length: count }, (_, index) => (short ? get2(reader, entry.at + index * 2) : get4(reader, entry.at + index * 4)));
}

/** `getreal` `count` times from the first value of `entry`. */
function reals(reader: TiffReader, entry: Entry, count: number): number[] {
  const [bytes, real] = REALS.get(entry.type) ?? BYTE_REAL;
  return Array.from({ length: count }, (_, index) => real(reader.readPadded(entry.at + index * bytes, bytes), reader.little));
}

const firstInt = (reader: TiffReader, entry: Entry | undefined): number => (entry === undefined ? 0 : ints(reader, entry, 1)[0]);

/** The entries of the tags read from the directory at `at`, in file order, and its next offset; null when LibRaw reads none from it. */
function readEntries(reader: TiffReader, at: number): { entries: Array<[number, Entry]>; next: number } | null {
  const count = get2(reader, at);
  if (count > MAX_ENTRIES || !reader.within(at + 2, count * ENTRY_BYTES)) return null;
  const bytes = reader.read(at + 2, count * ENTRY_BYTES);
  const entries: Array<[number, Entry]> = [];
  for (let offset = 0; offset < bytes.length; offset += ENTRY_BYTES) {
    const tag = readUInt16(bytes, offset, reader.little);
    if (!READ_TAGS.has(tag)) continue;
    const type = readUInt16(bytes, offset + 2, reader.little);
    const values = readUInt32(bytes, offset + 4, reader.little);
    const outOfLine = Math.imul(values, unitBytes(type)) >>> 0 > INLINE_VALUE_BYTES;
    const valuesAt = outOfLine ? readUInt32(bytes, offset + 8, reader.little) : at + 2 + offset + 8;
    if (values > MAX_VALUES_ALWAYS_READ && valuesAt + values > 2 * reader.size) continue;
    entries.push([tag, { type, count: values, at: valuesAt }]);
  }
  return { entries, next: get4(reader, at + 2 + bytes.length) };
}

/** LibRaw's pixel aspect from a DefaultScale entry, or null when it ignores the entry. */
function pixelAspectOf(reader: TiffReader, entry: Entry): number | null {
  const [horizontal, vertical] = reals(reader, entry, 2).map(Math.fround);
  if (!(horizontal > MIN_SCALE && vertical > MIN_SCALE)) return null;
  const aspect = Math.fround(horizontal / vertical);
  return aspect > SQUARE_BELOW && aspect < SQUARE_ABOVE ? 1 : aspect;
}

/** Reads the directory at `at` and the SubIFDs it lists; null when it ends the list it is in. */
function visit(walk: Walk, at: number): Directory | null {
  if (walk.counted >= MAX_DIRECTORIES) return null;
  walk.counted += 1;
  const read = readEntries(walk.reader, at);
  if (read === null) return null;
  const directory: Directory = { entries: new Map(), next: read.next };
  walk.directories.push(directory);
  for (const [tag, entry] of read.entries) {
    if (tag === TAG.subIfds) visitSubIfds(walk, entry);
    else if (tag === TAG.defaultScale) walk.pixelAspect = pixelAspectOf(walk.reader, entry) ?? walk.pixelAspect;
    else directory.entries.set(tag, entry);
  }
  return directory;
}

function visitSubIfds(walk: Walk, list: Entry): void {
  for (let index = 0; index < list.count; index += 1) {
    if (visit(walk, get4(walk.reader, list.at + index * OFFSET_BYTES)) === null) return;
  }
}

/** The directories LibRaw reads, in its order, and the pixel aspect it ends with. */
function walkDirectories(reader: TiffReader): Walk {
  const walk: Walk = { reader, directories: [], counted: 0, pixelAspect: 1 };
  for (let at = reader.firstDirectory; at !== 0;) {
    const directory = visit(walk, at);
    if (directory === null) break;
    at = directory.next;
  }
  return walk;
}

function isRawImage(reader: TiffReader, directory: Directory): boolean {
  const { entries } = directory;
  const width = firstInt(reader, entries.get(TAG.imageWidth));
  const height = firstInt(reader, entries.get(TAG.imageLength));
  const kind = entries.get(TAG.newSubfileType);
  const photometric = entries.get(TAG.photometric);
  const photometricValue = photometric === undefined ? 0 : get2(reader, photometric.at);
  return width >= 1 && width <= MAX_SIDE && height >= 1 && height <= MAX_SIDE
    && (kind === undefined ? 0 : Math.trunc(reals(reader, kind, 1)[0])) === 0
    && (photometricValue === PHOTOMETRIC_CFA || photometricValue === PHOTOMETRIC_LINEAR_RAW);
}

function rawSize(reader: TiffReader, raw: Directory): ImageSize {
  const width = firstInt(reader, raw.entries.get(TAG.imageWidth));
  const height = firstInt(reader, raw.entries.get(TAG.imageLength));
  const area = raw.entries.get(TAG.activeArea);
  if (area === undefined) return { width, height };
  const [top, left, bottom, right] = ints(reader, area, 4);
  return { width: ((right - left) & MAX_SIDE) || width, height: ((bottom - top) & MAX_SIDE) || height };
}

/** Whether the first directory whose Orientation turns or flips the picture turns it. */
function turned(reader: TiffReader, directories: Directory[]): boolean {
  for (const { entries } of directories) {
    const orientation = entries.get(TAG.orientation);
    const flip = orientation === undefined ? 0 : FLIP_OF_ORIENTATION[get2(reader, orientation.at) & 7];
    if (flip !== 0) return (flip & FLIP_TURNS) !== 0;
  }
  return false;
}

/** Whether `decoded` is the picture LibRaw writes from a raw image of size `raw`: trimmed by at most MAX_TRIM, stretched, turned. */
function matchesDecoded(raw: ImageSize, pixelAspect: number, turn: boolean, decoded: ImageSize): boolean {
  const [width, height] = turn ? [decoded.height, decoded.width] : [decoded.width, decoded.height];
  const stretchWidth = (columns: number) => (pixelAspect > 1 ? Math.floor(columns * pixelAspect + 0.5) : columns);
  const stretchHeight = (rows: number) => (pixelAspect < 1 ? Math.floor(rows / pixelAspect + 0.5) : rows);
  const fits = (length: number, rawLength: number, stretch: (length: number) => number) =>
    length <= stretch(rawLength) && length >= stretch(rawLength - MAX_TRIM);
  return fits(width, raw.width, stretchWidth) && fits(height, raw.height, stretchHeight);
}

/** `entry` as a strip or tile array: SHORT or LONG, at least one value, all inside the file; else null. */
function arrayOf(reader: TiffReader, entry: Entry | undefined): (Entry & { valueBytes: number }) | null {
  const valueBytes = entry === undefined ? undefined : ARRAY_VALUE_BYTES.get(entry.type);
  if (entry === undefined || valueBytes === undefined || entry.count === 0 || !reader.within(entry.at, entry.count * valueBytes)) return null;
  return { ...entry, valueBytes };
}

function arrayValues(reader: TiffReader, array: Entry & { valueBytes: number }, first: number, count: number): number[] {
  const bytes = reader.read(array.at + first * array.valueBytes, count * array.valueBytes);
  const read = array.valueBytes === 2 ? readUInt16 : readUInt32;
  return Array.from({ length: count }, (_, index) => read(bytes, index * array.valueBytes, reader.little));
}

function imageData(reader: TiffReader, raw: Directory): DngRawImageData {
  const tiled = raw.entries.has(TAG.tileOffsets);
  const offsets = arrayOf(reader, raw.entries.get(tiled ? TAG.tileOffsets : TAG.stripOffsets));
  const counts = arrayOf(reader, raw.entries.get(tiled ? TAG.tileByteCounts : TAG.stripByteCounts));
  if (offsets === null || counts === null || offsets.count !== counts.count) return 'unreadable-layout';
  for (let first = 0; first < offsets.count; first += VALUES_PER_READ) {
    const length = Math.min(VALUES_PER_READ, offsets.count - first);
    const starts = arrayValues(reader, offsets, first, length);
    const sizes = arrayValues(reader, counts, first, length);
    if (sizes.includes(0)) return 'unreadable-layout';
    if (sizes.some((size, index) => starts[index] + size > reader.size)) return 'outside-file';
  }
  return 'whole';
}

function openTiff(fd: number): TiffReader | null {
  const size = fs.fstatSync(fd).size;
  const within = (at: number, length: number): boolean => at + length <= size;
  const readInto = (buffer: Buffer, at: number, length: number): void => {
    if (fs.readSync(fd, buffer, 0, length, at) !== length) {
      throw new RawDecodeError(`The DNG changed while it was checked: ${length} bytes at ${at} came back short`);
    }
  };
  const read = (at: number, length: number): Buffer => {
    const buffer = Buffer.alloc(length);
    readInto(buffer, at, length);
    return buffer;
  };
  const readPadded = (at: number, length: number): Buffer => {
    const buffer = Buffer.alloc(length, 0xff);
    readInto(buffer, at, Math.max(0, Math.min(length, size - at)));
    return buffer;
  };
  if (!within(0, HEADER_BYTES)) return null;
  const header = read(0, HEADER_BYTES);
  const order = header.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  if (readUInt16(header, 2, little) !== TIFF_MAGIC) return null;
  return { size, little, firstDirectory: readUInt32(header, 4, little), within, read, readPadded };
}

/** Whether the DNG at `filePath` holds every strip or tile of the raw image LibRaw develops into `decoded`, the picture its decoder wrote. */
export function dngRawImageData(filePath: string, decoded: ImageSize): DngRawImageData {
  const fd = fs.openSync(filePath, 'r');
  try {
    const reader = openTiff(fd);
    if (reader === null) return 'not-classic-tiff';
    const { directories, pixelAspect } = walkDirectories(reader);
    const raw = directories.find((directory) => isRawImage(reader, directory));
    if (raw === undefined) return 'no-raw-image';
    if (!matchesDecoded(rawSize(reader, raw), pixelAspect, turned(reader, directories), decoded)) return 'dimensions';
    return imageData(reader, raw);
  } finally {
    fs.closeSync(fd);
  }
}

/** Why a DNG that printed the line is refused, for each finding of `dngRawImageData` but `whole`. */
const UNCHECKED_DNG_REASONS: Readonly<Record<Exclude<DngRawImageData, 'whole' | 'outside-file'>, string>> = {
  'not-classic-tiff': 'the file is not a classic TIFF',
  'no-raw-image': 'it lists no CFA or Linear Raw image the decoder develops',
  'unreadable-layout': 'its raw image does not list one byte count for each of its strips or tiles, none empty',
  dimensions: 'its raw image is not the size of the decoded picture',
};

/** The refusal of a DNG whose decoder reported corrupted data, for a finding of `dngRawImageData` other than `whole`. */
export function dngRefusal(finding: Exclude<DngRawImageData, 'whole'>, src: string): RawDecodeError {
  if (finding === 'outside-file') return new RawDecodeError(`The .${src} file is truncated: its raw image data runs past the end of the file`);
  return new RawDecodeError(`Native RAW decoder reported corrupted data in the .${src} file, and the file cannot be shown to be whole: ${UNCHECKED_DNG_REASONS[finding]}`);
}
