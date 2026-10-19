/**
 * Writes an rpm whose payload uses stripped cpio headers (rpm 4.12 and later), following the package layout: a 96-byte lead,
 * a signature header, the metadata header with the file tables, and the payload. Authored for the tests, separately from
 * the reader under test, from the rpm file format description and lib/cpio.c: a stripped entry is `07070X`, the index of
 * the file as 8 hex digits and padding to 4 bytes, then the content and padding; a standard `TRAILER!!!` entry ends it.
 */

export interface RpmTestFile {
  /** Absolute path as installed, such as `/opt/pkg/a.txt`. */
  path: string;
  /** Full mode including the file type bits (0o100644 regular file, 0o040755 directory, 0o120777 symbolic link). */
  mode: number;
  content?: Buffer;
  /** The target of a symbolic link. */
  linkTarget?: string;
  ghost?: boolean;
  /** Regular files that share a nonzero inode (and the device 1) are hard links of each other. */
  inode?: number;
  mtime?: number;
}

export interface RpmTestOptions {
  /** Index order of the entries in the payload; defaults to ascending, with only the last link of a set carrying content. */
  streamOrder?: number[];
  /** Write sizes as 64-bit values (rpm 4.12 does for every package of its `rpmlib(LargeFiles)` kind). */
  longSizes?: boolean;
  /** Overrides for the header, to write damaged ones. */
  header?: Partial<{ extraEntries: Array<{ tag: number; type: number; count: number; data: Buffer }>; indexCountClaim: number; dataLengthClaim: number }>;
  /** Replaces the payload bytes after the entries were written (for example to compress them). */
  transformPayload?: (payload: Buffer) => Buffer;
  /** What the header says the payload is compressed with (`gzip`, `xz`, `bzip2`, `zstd`), which rpm's own tools read it by. */
  compressor?: string;
  /** Removes tags from the header (the entries of `header.extraEntries` are added after this). */
  omitTags?: number[];
  /** The size of each file as the header states it, where it should differ from the content (a lie about the payload). */
  headerSizes?: number[];
}

export const S_REG = 0o100644;
export const S_DIR = 0o040755;
export const S_LNK = 0o120777;

const TYPE = { INT16: 3, INT32: 4, INT64: 5, STRING: 6, STRING_ARRAY: 8 } as const;
const TAG = {
  NAME: 1000,
  FILESIZES: 1028,
  FILEMODES: 1030,
  FILERDEVS: 1033,
  FILEMTIMES: 1034,
  FILEDIGESTS: 1035,
  FILELINKTOS: 1036,
  FILEFLAGS: 1037,
  FILEUSERNAME: 1039,
  FILEGROUPNAME: 1040,
  FILEVERIFYFLAGS: 1045,
  FILEDEVICES: 1095,
  FILEINODES: 1096,
  FILELANGS: 1097,
  DIRINDEXES: 1116,
  BASENAMES: 1117,
  DIRNAMES: 1118,
  PAYLOADFORMAT: 1124,
  PAYLOADCOMPRESSOR: 1125,
  LONGFILESIZES: 5008,
} as const;
const RPMFILE_GHOST = 1 << 6;
const FILE_DEVICE = 1;

interface HeaderEntry {
  tag: number;
  type: number;
  count: number;
  data: Buffer;
}

const INTEGER_WIDTHS: Record<number, number> = { [TYPE.INT16]: 2, [TYPE.INT32]: 4, [TYPE.INT64]: 8 };

const align = (length: number, to: number): number => Math.ceil(length / to) * to;

function integers(values: number[], width: 2 | 4 | 8): Buffer {
  const out = Buffer.alloc(values.length * width);
  values.forEach((value, i) => {
    if (width === 2) out.writeUInt16BE(value, i * width);
    else if (width === 4) out.writeUInt32BE(value, i * width);
    else out.writeBigUInt64BE(BigInt(value), i * width);
  });
  return out;
}

const strings = (values: string[]): Buffer => Buffer.concat(values.map((value) => Buffer.from(`${value}\0`, 'utf8')));

const TYPE_BIN = 7;
const REGION_TRAILER_BYTES = 16;
const INDEX_ROW_BYTES = 16;
const HEADER_INTRO_BYTES = 16;

/**
 * The region entry rpm expects first in a header it reads (62 for the signature header, 63 for the metadata one): a binary
 * value of 16 bytes that is the last thing in the data and describes the index it closes (tag, type, minus the size of the
 * index in bytes, and 16).
 */
function regionEntry(regionTag: number, otherEntries: number): HeaderEntry {
  const trailer = Buffer.alloc(REGION_TRAILER_BYTES);
  trailer.writeUInt32BE(regionTag, 0);
  trailer.writeUInt32BE(TYPE_BIN, 4);
  trailer.writeInt32BE(-(otherEntries + 1) * INDEX_ROW_BYTES, 8);
  trailer.writeUInt32BE(REGION_TRAILER_BYTES, 12);
  return { tag: regionTag, type: TYPE_BIN, count: REGION_TRAILER_BYTES, data: trailer };
}

function headerBytes(entries: HeaderEntry[], claim?: { indexCountClaim?: number; dataLengthClaim?: number }, regionTag?: number): Buffer {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const data: Buffer[] = [];
  let used = 0;
  const rows = sorted.map((entry) => {
    const width = INTEGER_WIDTHS[entry.type] ?? 1;
    const padding = align(used, width) - used;
    if (padding > 0) data.push(Buffer.alloc(padding));
    used += padding;
    const row = Buffer.alloc(INDEX_ROW_BYTES);
    row.writeUInt32BE(entry.tag, 0);
    row.writeUInt32BE(entry.type, 4);
    row.writeUInt32BE(used, 8);
    row.writeUInt32BE(entry.count, 12);
    data.push(entry.data);
    used += entry.data.length;
    return row;
  });
  if (regionTag !== undefined) {
    const region = regionEntry(regionTag, sorted.length);
    const row = Buffer.alloc(INDEX_ROW_BYTES);
    row.writeUInt32BE(region.tag, 0);
    row.writeUInt32BE(region.type, 4);
    row.writeUInt32BE(used, 8);
    row.writeUInt32BE(region.count, 12);
    rows.unshift(row);
    data.push(region.data);
    used += region.data.length;
  }
  const intro = Buffer.alloc(HEADER_INTRO_BYTES);
  Buffer.from([0x8e, 0xad, 0xe8, 0x01]).copy(intro);
  intro.writeUInt32BE(claim?.indexCountClaim ?? rows.length, 8);
  intro.writeUInt32BE(claim?.dataLengthClaim ?? used, 12);
  return Buffer.concat([intro, ...rows, ...data]);
}

function lead(): Buffer {
  const out = Buffer.alloc(96);
  Buffer.from([0xed, 0xab, 0xee, 0xdb, 3, 0]).copy(out);
  out.writeUInt16BE(1, 8);
  out.write('stripped-1.0-1', 10, 'latin1');
  out.writeUInt16BE(1, 76);
  out.writeUInt16BE(5, 78);
  return out;
}

function strippedEntry(index: number, content: Buffer, offset: number): Buffer {
  const head = Buffer.from(`07070X${index.toString(16).padStart(8, '0')}`, 'latin1');
  const parts = [Buffer.alloc(align(offset, 4) - offset), head];
  const afterHeader = align(offset, 4) + head.length;
  parts.push(Buffer.alloc(align(afterHeader, 4) - afterHeader), content);
  const afterContent = align(afterHeader, 4) + content.length;
  parts.push(Buffer.alloc(align(afterContent, 4) - afterContent));
  return Buffer.concat(parts);
}

/** The standard `TRAILER!!!` entry that ends a payload written at `offset`. */
export function trailer(offset: number): Buffer {
  const fields = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 11, 0];
  const head = Buffer.from(`070701${fields.map((value) => value.toString(16).toUpperCase().padStart(8, '0')).join('')}TRAILER!!!\0`, 'latin1');
  return Buffer.concat([Buffer.alloc(align(offset, 4) - offset), head, Buffer.alloc(align(head.length, 4) - head.length)]);
}

const DIRECTORY_SIZE = 4096;

/** The size the header gives: the file's own, however the payload stores it (every link of a set has the same). */
function sizeInHeader(file: RpmTestFile): number {
  if ((file.mode & 0o170000) === 0o040000) return DIRECTORY_SIZE;
  if ((file.mode & 0o170000) === 0o120000) return Buffer.byteLength(file.linkTarget ?? '', 'latin1');
  return file.content?.length ?? 0;
}

/** Which indexes carry content, as rpm decides it: a regular file always, except a link of a set that is not the last of it. */
function contentOf(files: RpmTestFile[], index: number): Buffer {
  const file = files[index];
  // An index outside the table is written on purpose by the tests of damaged payloads.
  if (file === undefined || file.ghost === true) return Buffer.alloc(0);
  if ((file.mode & 0o170000) === 0o120000) return Buffer.from(file.linkTarget ?? '', 'latin1');
  if ((file.mode & 0o170000) !== 0o100000) return Buffer.alloc(0);
  if (file.inode !== undefined) {
    const set = files.map((other, i) => (other.inode === file.inode && other.ghost !== true && (other.mode & 0o170000) === 0o100000 ? i : -1)).filter((i) => i >= 0);
    if (set.length > 1 && set[set.length - 1] !== index) return Buffer.alloc(0);
  }
  return file.content ?? Buffer.alloc(0);
}

export function buildStrippedPayload(files: RpmTestFile[], order?: number[]): Buffer {
  const sequence = order ?? files.map((_file, i) => i).filter((i) => files[i].ghost !== true);
  const parts: Buffer[] = [];
  let offset = 0;
  for (const index of sequence) {
    const piece = strippedEntry(index, contentOf(files, index), offset);
    parts.push(piece);
    offset += piece.length;
  }
  parts.push(trailer(offset));
  return Buffer.concat(parts);
}

function metadataHeader(files: RpmTestFile[], options: RpmTestOptions): Buffer {
  const dirs: string[] = [];
  const dirIndexes: number[] = [];
  const bases: string[] = [];
  for (const file of files) {
    const cut = file.path.lastIndexOf('/') + 1;
    const dir = file.path.slice(0, cut);
    if (!dirs.includes(dir)) dirs.push(dir);
    dirIndexes.push(dirs.indexOf(dir));
    bases.push(file.path.slice(cut));
  }
  const sizes = options.headerSizes ?? files.map(sizeInHeader);
  const entries: HeaderEntry[] = [
    { tag: TAG.NAME, type: TYPE.STRING, count: 1, data: strings(['stripped']) },
    { tag: TAG.PAYLOADFORMAT, type: TYPE.STRING, count: 1, data: strings(['cpio']) },
    ...(options.compressor === undefined ? [] : [{ tag: TAG.PAYLOADCOMPRESSOR, type: TYPE.STRING, count: 1, data: strings([options.compressor]) }]),
    { tag: TAG.BASENAMES, type: TYPE.STRING_ARRAY, count: bases.length, data: strings(bases) },
    { tag: TAG.DIRNAMES, type: TYPE.STRING_ARRAY, count: dirs.length, data: strings(dirs) },
    { tag: TAG.DIRINDEXES, type: TYPE.INT32, count: files.length, data: integers(dirIndexes, 4) },
    { tag: TAG.FILEMODES, type: TYPE.INT16, count: files.length, data: integers(files.map((file) => file.mode), 2) },
    { tag: TAG.FILEMTIMES, type: TYPE.INT32, count: files.length, data: integers(files.map((file) => file.mtime ?? 1_704_164_646), 4) },
    { tag: TAG.FILEFLAGS, type: TYPE.INT32, count: files.length, data: integers(files.map((file) => (file.ghost === true ? RPMFILE_GHOST : 0)), 4) },
    { tag: TAG.FILEDEVICES, type: TYPE.INT32, count: files.length, data: integers(files.map(() => FILE_DEVICE), 4) },
    { tag: TAG.FILEINODES, type: TYPE.INT32, count: files.length, data: integers(files.map((file, i) => file.inode ?? 1000 + i), 4) },
    { tag: TAG.FILERDEVS, type: TYPE.INT16, count: files.length, data: integers(files.map(() => 0), 2) },
    { tag: TAG.FILEDIGESTS, type: TYPE.STRING_ARRAY, count: files.length, data: strings(files.map(() => '')) },
    { tag: TAG.FILEUSERNAME, type: TYPE.STRING_ARRAY, count: files.length, data: strings(files.map(() => 'root')) },
    { tag: TAG.FILEGROUPNAME, type: TYPE.STRING_ARRAY, count: files.length, data: strings(files.map(() => 'root')) },
    { tag: TAG.FILEVERIFYFLAGS, type: TYPE.INT32, count: files.length, data: integers(files.map(() => 0xffffffff), 4) },
    { tag: TAG.FILELANGS, type: TYPE.STRING_ARRAY, count: files.length, data: strings(files.map(() => '')) },
    { tag: TAG.FILELINKTOS, type: TYPE.STRING_ARRAY, count: files.length, data: strings(files.map((file) => file.linkTarget ?? '')) },
    options.longSizes === true
      ? { tag: TAG.LONGFILESIZES, type: TYPE.INT64, count: files.length, data: integers(sizes, 8) }
      : { tag: TAG.FILESIZES, type: TYPE.INT32, count: files.length, data: integers(sizes, 4) },
  ].filter((entry) => !(options.omitTags ?? []).includes(entry.tag));
  entries.push(...(options.header?.extraEntries ?? []));
  return headerBytes(entries, options.header, 63);
}

/** An rpm of `files` whose payload is stripped. The signature header is empty, which is all the reader needs. */
export function buildStrippedRpm(files: RpmTestFile[], options: RpmTestOptions = {}): Buffer {
  const signature = headerBytes([], undefined, 62);
  const signaturePadding = Buffer.alloc(align(96 + signature.length, 8) - 96 - signature.length);
  const payload = (options.transformPayload ?? ((bytes: Buffer) => bytes))(buildStrippedPayload(files, options.streamOrder));
  return Buffer.concat([lead(), signature, signaturePadding, metadataHeader(files, options), payload]);
}
