/**
 * Directories of a classic TIFF (TIFF 6.0, section 2): an 8-byte header, then directories of a 2-byte entry count, 12-byte
 * entries and the 4-byte offset of the next directory, in the byte order the header names. Shared by the check for old-style
 * JPEG compression and by the repair of a directory whose tags are out of order.
 */

const TIFF_MAGIC = 42;
const TIFF_HEADER_BYTES = 8;
const IFD_COUNT_BYTES = 2;
const IFD_ENTRY_BYTES = 12;
const IFD_NEXT_BYTES = 4;
const IFD_ENTRY_VALUE_OFFSET = 8;
/** Directories read: far more than any real document has. */
const MAX_DIRECTORIES = 4096;
/** Bytes a directory takes in a file: the count, the next offset and the 12-byte entries. */
const directoryBytes = (count: number): number => IFD_COUNT_BYTES + count * IFD_ENTRY_BYTES + IFD_NEXT_BYTES;

const TAG_COMPRESSION = 259;
const COMPRESSION_OLD_STYLE_JPEG = 6;

interface TiffDirectory {
  /** Offset of the entry count. */
  at: number;
  count: number;
}

interface ClassicTiff {
  little: boolean;
  /** The directories that lie whole inside the file, in the order the chain of offsets leads to them. */
  directories: TiffDirectory[];
}

const readUInt16 = (tiff: Buffer, at: number, little: boolean): number => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
const readUInt32 = (tiff: Buffer, at: number, little: boolean): number => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
const entriesAt = (directory: TiffDirectory): number => directory.at + IFD_COUNT_BYTES;
const nextAt = (directory: TiffDirectory): number => entriesAt(directory) + directory.count * IFD_ENTRY_BYTES;

/**
 * Reads the header and the chain of directories of `tiff`, or null when the bytes are not a classic TIFF. A directory that runs
 * past the end of the file ends the chain. So does a directory already read, and the one at which the directories read so far would
 * take more bytes than the file has: directories of a real file do not overlap, and a chain of overlapping ones (a loop, or
 * directories that start a few bytes apart and each claim 65535 entries) would otherwise be walked thousands of times.
 */
function readClassicTiff(tiff: Buffer): ClassicTiff | null {
  if (tiff.length < TIFF_HEADER_BYTES) return null;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  if (readUInt16(tiff, 2, little) !== TIFF_MAGIC) return null;
  const directories: TiffDirectory[] = [];
  const offsets = new Set<number>();
  let bytes = 0;
  let at = readUInt32(tiff, 4, little);
  while (at !== 0 && at + IFD_COUNT_BYTES <= tiff.length && directories.length < MAX_DIRECTORIES && !offsets.has(at)) {
    const directory = { at, count: readUInt16(tiff, at, little) };
    bytes += directoryBytes(directory.count);
    if (nextAt(directory) + IFD_NEXT_BYTES > tiff.length || bytes > tiff.length) break;
    offsets.add(at);
    directories.push(directory);
    at = readUInt32(tiff, nextAt(directory), little);
  }
  return { little, directories };
}

/**
 * True when a directory of the TIFF declares old-style JPEG compression (Compression = 6, TIFF 6.0 section 22), which
 * libvips' libtiff is built without. Only classic TIFF is read; any other bytes answer false.
 */
export function usesOldStyleJpeg(tiff: Buffer): boolean {
  const layout = readClassicTiff(tiff);
  if (layout === null) return false;
  return layout.directories.some((directory) => {
    for (let entry = entriesAt(directory); entry < nextAt(directory); entry += IFD_ENTRY_BYTES) {
      if (readUInt16(tiff, entry, layout.little) === TAG_COMPRESSION && readUInt16(tiff, entry + IFD_ENTRY_VALUE_OFFSET, layout.little) === COMPRESSION_OLD_STYLE_JPEG) return true;
    }
    return false;
  });
}

/** True when the tags of the directory rise from entry to entry, which needs no repair and allocates nothing. */
function tagsAscend(tiff: Buffer, directory: TiffDirectory, little: boolean): boolean {
  for (let entry = entriesAt(directory) + IFD_ENTRY_BYTES; entry < nextAt(directory); entry += IFD_ENTRY_BYTES) {
    if (readUInt16(tiff, entry, little) <= readUInt16(tiff, entry - IFD_ENTRY_BYTES, little)) return false;
  }
  return true;
}

function entriesOf(tiff: Buffer, directory: TiffDirectory): Buffer[] {
  return Array.from({ length: directory.count }, (_, index) => tiff.subarray(entriesAt(directory) + index * IFD_ENTRY_BYTES, entriesAt(directory) + (index + 1) * IFD_ENTRY_BYTES));
}

/** The entries in ascending tag order (equal tags keep the order of the file), without the repeat of an entry whose 12 bytes are the same as the one before it. */
function orderedEntries(entries: readonly Buffer[], little: boolean): Buffer[] {
  const sorted = [...entries].sort((a, b) => readUInt16(a, 0, little) - readUInt16(b, 0, little));
  return sorted.filter((entry, index) => index === 0 || !entry.equals(sorted[index - 1]));
}

/** Writes `entries` where the directory's own entries were, the count after them and the offset of the next directory behind the last entry; the bytes the directory no longer uses are cleared. */
function rewriteDirectory(tiff: Buffer, directory: TiffDirectory, entries: readonly Buffer[], little: boolean): void {
  const nextOffset = Buffer.from(tiff.subarray(nextAt(directory), nextAt(directory) + IFD_NEXT_BYTES));
  tiff.fill(0, directory.at, nextAt(directory) + IFD_NEXT_BYTES);
  if (little) tiff.writeUInt16LE(entries.length, directory.at);
  else tiff.writeUInt16BE(entries.length, directory.at);
  entries.forEach((entry, index) => entry.copy(tiff, entriesAt(directory) + index * IFD_ENTRY_BYTES));
  nextOffset.copy(tiff, entriesAt(directory) + entries.length * IFD_ENTRY_BYTES);
}

/**
 * `tiff` with the entries of every directory in ascending tag order and each repeat of an identical entry dropped, or `tiff`
 * itself (the same object) when no directory needs it. TIFF 6.0 requires ascending order, and libtiff warns for an entry
 * that is not above the one before it, which the image library treats as a failure. An entry that repeats a tag with another
 * value is kept: which value is meant is not known, so such a file stays refused. Bytes that are not a classic TIFF are not touched.
 */
export function withSortedTiffTags(tiff: Buffer): Buffer {
  const layout = readClassicTiff(tiff);
  if (layout === null) return tiff;
  let repaired: Buffer | null = null;
  for (const directory of layout.directories) {
    if (tagsAscend(tiff, directory, layout.little)) continue;
    const entries = entriesOf(tiff, directory);
    const ordered = orderedEntries(entries, layout.little);
    if (ordered.length === entries.length && ordered.every((entry, index) => entry === entries[index])) continue;
    repaired ??= Buffer.from(tiff);
    rewriteDirectory(repaired, directory, ordered, layout.little);
  }
  return repaired ?? tiff;
}
