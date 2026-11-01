/**
 * Hand-written classic TIFF directories (TIFF 6.0 section 2) for the check that a DNG holds its raw image. Each directory sits at an
 * offset the test chooses, so loops, overlaps and SubIFD trees are laid out byte by byte. It shares no code with the reader.
 */

export const TAG = {
  newSubfileType: 254,
  compression: 259,
  stripOffsets: 273,
  stripByteCounts: 279,
  tileOffsets: 324,
  tileByteCounts: 325,
  subIfds: 330,
} as const;
export const TYPE = { short: 3, long: 4, ifd: 13 } as const;

const TIFF_MAGIC = 42;
const ENTRY_BYTES = 12;
const INLINE_BYTES = 4;
const LOSSLESS_JPEG = 7;
/** NewSubFileType of a reduced-resolution image, such as a preview. */
export const REDUCED_RESOLUTION = 1;

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

const valueBytes = (type: number): number => (type === TYPE.short ? 2 : 4);

/** A file of `size` bytes holding `directories`; the header points at `first`, by default the first directory. */
export function buildTiff(size: number, directories: TiffDirectorySpec[], options: { little?: boolean; first?: number } = {}): Buffer {
  const little = options.little ?? true;
  const file = Buffer.alloc(size);
  const u16 = (value: number, at: number) => (little ? file.writeUInt16LE(value, at) : file.writeUInt16BE(value, at));
  const u32 = (value: number, at: number) => (little ? file.writeUInt32LE(value, at) : file.writeUInt32BE(value, at));
  const write = (type: number, values: number[], at: number) =>
    values.forEach((value, index) => (type === TYPE.short ? u16(value, at + index * 2) : u32(value, at + index * 4)));
  file.write(little ? 'II' : 'MM', 0, 'latin1');
  u16(TIFF_MAGIC, 2);
  u32(options.first ?? directories[0].at, 4);
  for (const directory of directories) {
    u16(directory.entries.length, directory.at);
    directory.entries.forEach((entry, index) => {
      const at = directory.at + 2 + index * ENTRY_BYTES;
      u16(entry.tag, at);
      u16(entry.type, at + 2);
      u32(entry.values.length, at + 4);
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

/** The entries of an image directory with lossless JPEG data in `strips` ([offset, bytes] each), the arrays at `arraysAt` when needed. */
export function imageEntries(strips: Array<[number, number]>, options: { subfileType?: number; arraysAt?: number; tiles?: boolean } = {}): TiffEntrySpec[] {
  const [offsetsTag, countsTag] = options.tiles ? [TAG.tileOffsets, TAG.tileByteCounts] : [TAG.stripOffsets, TAG.stripByteCounts];
  const arraysAt = options.arraysAt ?? 0;
  return [
    { tag: TAG.newSubfileType, type: TYPE.long, values: [options.subfileType ?? 0] },
    { tag: TAG.compression, type: TYPE.short, values: [LOSSLESS_JPEG] },
    { tag: offsetsTag, type: TYPE.long, values: strips.map(([offset]) => offset), at: arraysAt },
    { tag: countsTag, type: TYPE.long, values: strips.map(([, bytes]) => bytes), at: arraysAt + strips.length * 4 },
  ];
}

const DATA_AT = 64;

/** A DNG whose raw image is one strip of `stripBytes` at byte 64, cut to `size` bytes when that is shorter. */
export function minimalDng(stripBytes: number, size = DATA_AT + stripBytes): Buffer {
  return buildTiff(Math.max(size, DATA_AT), [{ at: 8, entries: imageEntries([[DATA_AT, stripBytes]]) }]).subarray(0, size);
}
