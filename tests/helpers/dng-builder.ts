import { TAG as DNG_TAG } from '../../src/worker/raw-dng-image-data';

/**
 * Hand-written classic TIFF directories (TIFF 6.0 section 2) for the check that a DNG holds its raw image. Each directory sits at an
 * offset the test chooses, so loops, overlaps and SubIFD trees are laid out byte by byte. It shares only the tag numbers with the reader.
 */

/** The tags of the check, which name what it reads, and Compression, which it does not read. */
export const TAG = { ...DNG_TAG, compression: 259 } as const;
/** A RATIONAL entry lists its values as numerator and denominator pairs; a BYTE or ASCII entry lists one byte for each value. */
export const TYPE = { byte: 1, ascii: 2, short: 3, long: 4, rational: 5, undefined: 7, ifd: 13 } as const;

const TIFF_MAGIC = 42;
const ENTRY_BYTES = 12;
const INLINE_BYTES = 4;
export const COMPRESSION = { losslessJpeg: 7, jpeg: 6 } as const;
export const PHOTOMETRIC = { yCbCr: 6, cfa: 32803, linearRaw: 34892 } as const;
/** NewSubFileType of a reduced-resolution image, such as a preview. */
export const REDUCED_RESOLUTION = 1;
/** Width and height of the raw image `imageEntries` describes. */
export const RAW_SIZE = { width: 64, height: 100 } as const;

export interface TiffEntrySpec {
  tag: number;
  type: number;
  values: number[];
  /** Where the values go when they do not fit in the entry. */
  at?: number;
}

export interface TiffDirectorySpec {
  at: number;
  entries: TiffEntrySpec[];
  next?: number;
}

const VALUE_BYTES: Readonly<Record<number, number>> = { [TYPE.byte]: 1, [TYPE.ascii]: 1, [TYPE.short]: 2 };
const valueBytes = (type: number): number => VALUE_BYTES[type] ?? 4;
const numbersPerValue = (type: number): number => (type === TYPE.rational ? 2 : 1);

/** A file of `size` bytes holding `directories`; the header points at `first`, by default the first directory. */
export function buildTiff(size: number, directories: TiffDirectorySpec[], options: { little?: boolean; first?: number } = {}): Buffer {
  const little = options.little ?? true;
  const file = Buffer.alloc(size);
  const u16 = (value: number, at: number) => (little ? file.writeUInt16LE(value, at) : file.writeUInt16BE(value, at));
  const u32 = (value: number, at: number) => (little ? file.writeUInt32LE(value, at) : file.writeUInt32BE(value, at));
  const write = (type: number, values: number[], at: number) =>
    values.forEach((value, index) => {
      if (valueBytes(type) === 1) file.writeUInt8(value, at + index);
      else if (type === TYPE.short) u16(value, at + index * 2);
      else u32(value, at + index * 4);
    });
  file.write(little ? 'II' : 'MM', 0, 'latin1');
  u16(TIFF_MAGIC, 2);
  u32(options.first ?? directories[0].at, 4);
  for (const directory of directories) {
    u16(directory.entries.length, directory.at);
    directory.entries.forEach((entry, index) => {
      const at = directory.at + 2 + index * ENTRY_BYTES;
      u16(entry.tag, at);
      u16(entry.type, at + 2);
      u32(entry.values.length / numbersPerValue(entry.type), at + 4);
      if (entry.values.length * valueBytes(entry.type) <= INLINE_BYTES) write(entry.type, entry.values, at + 8);
      else {
        u32(entry.at as number, at + 8);
        write(entry.type, entry.values, entry.at as number);
      }
    });
    u32(directory.next ?? 0, directory.at + 2 + directory.entries.length * ENTRY_BYTES);
  }
  return file;
}

export interface ImageOptions {
  subfileType?: number;
  compression?: number;
  photometric?: number;
  /** Where the strip or tile arrays go when they do not fit in their entries. */
  arraysAt?: number;
  /** SHORT or LONG strip or tile arrays. */
  arrayType?: number;
  tiles?: boolean;
}

/** The entries of an image directory with data in `strips` ([offset, bytes] each): by default a 64 x 100 CFA image in lossless JPEG. */
export function imageEntries(strips: Array<[number, number]>, options: ImageOptions = {}): TiffEntrySpec[] {
  const [offsetsTag, countsTag] = options.tiles ? [TAG.tileOffsets, TAG.tileByteCounts] : [TAG.stripOffsets, TAG.stripByteCounts];
  const arraysAt = options.arraysAt ?? 0;
  const arrayType = options.arrayType ?? TYPE.long;
  return [
    { tag: TAG.newSubfileType, type: TYPE.long, values: [options.subfileType ?? 0] },
    { tag: TAG.imageWidth, type: TYPE.long, values: [RAW_SIZE.width] },
    { tag: TAG.imageLength, type: TYPE.long, values: [RAW_SIZE.height] },
    { tag: TAG.compression, type: TYPE.short, values: [options.compression ?? COMPRESSION.losslessJpeg] },
    { tag: TAG.photometric, type: TYPE.short, values: [options.photometric ?? PHOTOMETRIC.cfa] },
    { tag: offsetsTag, type: arrayType, values: strips.map(([offset]) => offset), at: arraysAt },
    { tag: countsTag, type: arrayType, values: strips.map(([, bytes]) => bytes), at: arraysAt + strips.length * valueBytes(arrayType) },
  ];
}

/** An ASCII entry holding `text` and its terminating zero. */
export const asciiEntry = (tag: number, text: string, at = 0): TiffEntrySpec => ({
  tag, type: TYPE.ascii, values: [...Buffer.from(text, 'latin1'), 0], at,
});

const DATA_AT = 128;

/** A DNG whose raw image is one strip of `stripBytes` at byte 128, cut to `size` bytes when that is shorter. */
export function minimalDng(stripBytes: number, size = DATA_AT + stripBytes, options: { little?: boolean } = {}): Buffer {
  return buildTiff(Math.max(size, DATA_AT), [{ at: 8, entries: imageEntries([[DATA_AT, stripBytes]]) }], options).subarray(0, size);
}

/** A copy of `file` whose IFD0 entry `tag` holds `values` (numerator and denominator pairs for a RATIONAL) over its own, as many. */
export function withIfd0Values(file: Buffer, tag: number, values: number[]): Buffer {
  const copy = Buffer.from(file);
  const little = copy.toString('latin1', 0, 2) === 'II';
  const u16 = (at: number) => (little ? copy.readUInt16LE(at) : copy.readUInt16BE(at));
  const u32 = (at: number) => (little ? copy.readUInt32LE(at) : copy.readUInt32BE(at));
  const first = u32(4);
  for (let index = 0; index < u16(first); index += 1) {
    const at = first + 2 + index * ENTRY_BYTES;
    if (u16(at) !== tag) continue;
    const type = u16(at + 2);
    const valuesAt = values.length * valueBytes(type) <= INLINE_BYTES ? at + 8 : u32(at + 8);
    const write = type === TYPE.short
      ? (little ? copy.writeUInt16LE : copy.writeUInt16BE)
      : (little ? copy.writeUInt32LE : copy.writeUInt32BE);
    values.forEach((value, position) => write.call(copy, value, valuesAt + position * valueBytes(type)));
    return copy;
  }
  throw new Error(`IFD0 has no entry ${tag}`);
}
