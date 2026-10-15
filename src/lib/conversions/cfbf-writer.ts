import { ConversionFailedError, PayloadLimitError } from '../types';

/**
 * Writer for OLE2 compound files, version 3 ([MS-CFB]): 512-byte sectors, a FAT (with DIFAT sectors beyond 109 FAT
 * sectors), a mini stream for streams under 4096 bytes, and a directory tree of storages and streams. The directory
 * of each storage is a balanced binary tree ordered by the [MS-CFB] name comparison, coloured so that it is a valid
 * red-black tree.
 */

export interface CfbfStreamNode {
  name: string;
  data: Buffer;
}

export interface CfbfStorageNode {
  name: string;
  children: CfbfNode[];
}

export type CfbfNode = CfbfStreamNode | CfbfStorageNode;

const SECTOR_BYTES = 512;
const SECTOR_SHIFT = 9;
const MINI_SECTOR_BYTES = 64;
const MINI_SECTOR_SHIFT = 6;
const MINI_STREAM_CUTOFF = 4096;
const DIRECTORY_ENTRY_BYTES = 128;
const FAT_ENTRIES_PER_SECTOR = SECTOR_BYTES / 4;
const HEADER_DIFAT_ENTRIES = 109;
const DIFAT_ENTRIES_PER_SECTOR = FAT_ENTRIES_PER_SECTOR - 1;
const MAX_NAME_UNITS = 31;
/** Directory entries and sectors a written file may hold; a larger request is refused before any allocation. */
const MAX_DIRECTORY_ENTRIES = 65_536;
const MAX_FILE_BYTES = 512 * 1024 * 1024;

const FREE_SECTOR = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
const NO_STREAM = 0xffffffff;

const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;
const COLOR_RED = 0;
const COLOR_BLACK = 1;
const FORBIDDEN_NAME_CHARACTERS = /[/\\:!]/;
const CFBF_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const CFBF_MINOR_VERSION = 0x3e;
const CFBF_MAJOR_VERSION = 3;
const BYTE_ORDER_LITTLE_ENDIAN = 0xfffe;

interface DirectoryEntry {
  name: string;
  type: number;
  color: number;
  left: number;
  right: number;
  child: number;
  startSector: number;
  size: number;
  data?: Buffer;
  children?: CfbfNode[];
}

/** The [MS-CFB] name order: shorter names first, then by upper-cased UTF-16 code units. */
function compareNames(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const left = a.toUpperCase();
  const right = b.toUpperCase();
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertValidName(name: string): void {
  if (name.length === 0 || name.length > MAX_NAME_UNITS || FORBIDDEN_NAME_CHARACTERS.test(name)) {
    throw new ConversionFailedError(`Cannot write compound file entry "${name}": names are 1 to ${MAX_NAME_UNITS} characters without / \\ : !.`);
  }
}

/** Links `nodeIds` (already ordered) into a balanced tree and returns the id of its root; the last level is coloured red when it is not full. */
function linkSiblings(entries: DirectoryEntry[], nodeIds: number[]): number {
  if (nodeIds.length === 0) return NO_STREAM;
  const height = Math.ceil(Math.log2(nodeIds.length + 1));
  const isPerfect = nodeIds.length === 2 ** height - 1;
  const build = (low: number, high: number, depth: number): number => {
    if (low > high) return NO_STREAM;
    const middle = Math.floor((low + high) / 2);
    const entry = entries[nodeIds[middle]];
    entry.color = !isPerfect && depth === height - 1 ? COLOR_RED : COLOR_BLACK;
    entry.left = build(low, middle - 1, depth + 1);
    entry.right = build(middle + 1, high, depth + 1);
    return nodeIds[middle];
  };
  return build(0, nodeIds.length - 1, 0);
}

function flatten(root: CfbfNode[]): DirectoryEntry[] {
  const entries: DirectoryEntry[] = [
    { name: 'Root Entry', type: TYPE_ROOT, color: COLOR_BLACK, left: NO_STREAM, right: NO_STREAM, child: NO_STREAM, startSector: END_OF_CHAIN, size: 0, children: root },
  ];
  // Breadth-first so a storage's children are created together and can be linked as one sibling tree.
  for (let index = 0; index < entries.length; index += 1) {
    const children = entries[index].children;
    if (!children) continue;
    const seen = new Set<string>();
    const ordered = [...children].sort((a, b) => compareNames(a.name, b.name));
    const ids: number[] = [];
    for (const node of ordered) {
      assertValidName(node.name);
      const key = node.name.toUpperCase();
      if (seen.has(key)) throw new ConversionFailedError(`Cannot write compound file: "${node.name}" appears twice in one storage.`);
      seen.add(key);
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        throw new PayloadLimitError(`Cannot write compound file: more than ${MAX_DIRECTORY_ENTRIES} directory entries.`);
      }
      const isStorage = 'children' in node;
      entries.push({
        name: node.name,
        type: isStorage ? TYPE_STORAGE : TYPE_STREAM,
        color: COLOR_BLACK,
        left: NO_STREAM,
        right: NO_STREAM,
        child: NO_STREAM,
        startSector: END_OF_CHAIN,
        size: isStorage ? 0 : node.data.length,
        data: isStorage ? undefined : node.data,
        children: isStorage ? node.children : undefined,
      });
      ids.push(entries.length - 1);
    }
    entries[index].child = linkSiblings(entries, ids);
  }
  return entries;
}

const sectorsFor = (bytes: number, sectorBytes: number): number => Math.ceil(bytes / sectorBytes);

/** Builds a version 3 compound file holding `root` under its Root Entry. */
export function buildCfbfContainer(root: CfbfNode[]): Buffer {
  const entries = flatten(root);

  // Streams under the cutoff share the mini stream; the rest get sectors of their own.
  const small = entries.filter((entry) => entry.type === TYPE_STREAM && entry.size > 0 && entry.size < MINI_STREAM_CUTOFF);
  const large = entries.filter((entry) => entry.type === TYPE_STREAM && entry.size >= MINI_STREAM_CUTOFF);
  const miniSectorCount = small.reduce((sum, entry) => sum + sectorsFor(entry.size, MINI_SECTOR_BYTES), 0);
  const miniStream = Buffer.alloc(miniSectorCount * MINI_SECTOR_BYTES);
  const miniFat = new Array<number>(miniSectorCount).fill(FREE_SECTOR);
  let miniCursor = 0;
  for (const entry of small) {
    const count = sectorsFor(entry.size, MINI_SECTOR_BYTES);
    entry.startSector = miniCursor;
    (entry.data as Buffer).copy(miniStream, miniCursor * MINI_SECTOR_BYTES);
    for (let index = 0; index < count; index += 1) miniFat[miniCursor + index] = index === count - 1 ? END_OF_CHAIN : miniCursor + index + 1;
    miniCursor += count;
  }

  const directorySectors = sectorsFor(entries.length * DIRECTORY_ENTRY_BYTES, SECTOR_BYTES);
  const miniFatSectors = sectorsFor(miniSectorCount * 4, SECTOR_BYTES);
  const miniStreamSectors = sectorsFor(miniStream.length, SECTOR_BYTES);
  const largeSectors = large.map((entry) => sectorsFor(entry.size, SECTOR_BYTES));
  const dataSectors = directorySectors + miniFatSectors + miniStreamSectors + largeSectors.reduce((sum, count) => sum + count, 0);

  let fatSectors = 1;
  let difatSectors = 0;
  for (;;) {
    const total = dataSectors + fatSectors + difatSectors;
    const neededFat = sectorsFor(total, FAT_ENTRIES_PER_SECTOR);
    const neededDifat = neededFat > HEADER_DIFAT_ENTRIES ? sectorsFor(neededFat - HEADER_DIFAT_ENTRIES, DIFAT_ENTRIES_PER_SECTOR) : 0;
    if (neededFat === fatSectors && neededDifat === difatSectors) break;
    fatSectors = neededFat;
    difatSectors = neededDifat;
  }
  const totalSectors = dataSectors + fatSectors + difatSectors;
  if ((totalSectors + 1) * SECTOR_BYTES > MAX_FILE_BYTES) {
    throw new PayloadLimitError(`Cannot write compound file: the result would exceed ${MAX_FILE_BYTES} bytes.`);
  }

  // Sector order: directory, mini FAT, mini stream, large streams, FAT, DIFAT.
  const fat = new Array<number>(fatSectors * FAT_ENTRIES_PER_SECTOR).fill(FREE_SECTOR);
  const chain = (first: number, count: number): void => {
    for (let index = 0; index < count; index += 1) fat[first + index] = index === count - 1 ? END_OF_CHAIN : first + index + 1;
  };
  let cursor = 0;
  const firstDirectory = cursor;
  chain(cursor, directorySectors);
  cursor += directorySectors;
  const firstMiniFat = miniFatSectors > 0 ? cursor : END_OF_CHAIN;
  chain(cursor, miniFatSectors);
  cursor += miniFatSectors;
  const firstMiniStream = miniStreamSectors > 0 ? cursor : END_OF_CHAIN;
  chain(cursor, miniStreamSectors);
  cursor += miniStreamSectors;
  large.forEach((entry, index) => {
    entry.startSector = cursor;
    chain(cursor, largeSectors[index]);
    cursor += largeSectors[index];
  });
  const firstFat = cursor;
  for (let index = 0; index < fatSectors; index += 1) fat[firstFat + index] = FAT_SECTOR;
  cursor += fatSectors;
  const firstDifat = difatSectors > 0 ? cursor : END_OF_CHAIN;
  for (let index = 0; index < difatSectors; index += 1) fat[cursor + index] = DIFAT_SECTOR;

  entries[0].startSector = firstMiniStream;
  entries[0].size = miniStream.length;

  const file = Buffer.alloc((totalSectors + 1) * SECTOR_BYTES);
  const sectorOffset = (sector: number): number => (sector + 1) * SECTOR_BYTES;

  // Header
  Buffer.from(CFBF_SIGNATURE).copy(file, 0);
  file.writeUInt16LE(CFBF_MINOR_VERSION, 24);
  file.writeUInt16LE(CFBF_MAJOR_VERSION, 26);
  file.writeUInt16LE(BYTE_ORDER_LITTLE_ENDIAN, 28);
  file.writeUInt16LE(SECTOR_SHIFT, 30);
  file.writeUInt16LE(MINI_SECTOR_SHIFT, 32);
  file.writeUInt32LE(0, 40); // number of directory sectors: zero in version 3
  file.writeUInt32LE(fatSectors, 44);
  file.writeUInt32LE(firstDirectory, 48);
  file.writeUInt32LE(MINI_STREAM_CUTOFF, 56);
  file.writeUInt32LE(firstMiniFat, 60);
  file.writeUInt32LE(miniFatSectors, 64);
  file.writeUInt32LE(firstDifat, 68);
  file.writeUInt32LE(difatSectors, 72);
  for (let index = 0; index < HEADER_DIFAT_ENTRIES; index += 1) {
    file.writeUInt32LE(index < fatSectors ? firstFat + index : FREE_SECTOR, 76 + index * 4);
  }

  // Directory
  entries.forEach((entry, index) => {
    const at = sectorOffset(firstDirectory) + index * DIRECTORY_ENTRY_BYTES;
    file.write(entry.name, at, 'utf16le');
    file.writeUInt16LE((entry.name.length + 1) * 2, at + 64);
    file.writeUInt8(entry.type, at + 66);
    file.writeUInt8(entry.color, at + 67);
    file.writeUInt32LE(entry.left, at + 68);
    file.writeUInt32LE(entry.right, at + 72);
    file.writeUInt32LE(entry.child, at + 76);
    file.writeUInt32LE(entry.type === TYPE_STORAGE ? 0 : entry.startSector, at + 116);
    file.writeUInt32LE(entry.size, at + 120);
  });
  // Unused directory slots in the last directory sector are free entries (all-ones links).
  for (let index = entries.length; index < directorySectors * (SECTOR_BYTES / DIRECTORY_ENTRY_BYTES); index += 1) {
    const at = sectorOffset(firstDirectory) + index * DIRECTORY_ENTRY_BYTES;
    file.writeUInt32LE(NO_STREAM, at + 68);
    file.writeUInt32LE(NO_STREAM, at + 72);
    file.writeUInt32LE(NO_STREAM, at + 76);
  }

  // Mini FAT, mini stream and large streams
  miniFat.forEach((value, index) => file.writeUInt32LE(value, sectorOffset(firstMiniFat) + index * 4));
  if (miniFatSectors > 0) {
    for (let index = miniFat.length; index < miniFatSectors * FAT_ENTRIES_PER_SECTOR; index += 1) {
      file.writeUInt32LE(FREE_SECTOR, sectorOffset(firstMiniFat) + index * 4);
    }
  }
  miniStream.copy(file, sectorOffset(firstMiniStream === END_OF_CHAIN ? 0 : firstMiniStream));
  for (const entry of large) (entry.data as Buffer).copy(file, sectorOffset(entry.startSector));

  // FAT and DIFAT
  fat.forEach((value, index) => file.writeUInt32LE(value, sectorOffset(firstFat) + index * 4));
  for (let sector = 0; sector < difatSectors; sector += 1) {
    const at = sectorOffset(firstDifat + sector);
    for (let slot = 0; slot < DIFAT_ENTRIES_PER_SECTOR; slot += 1) {
      const fatIndex = HEADER_DIFAT_ENTRIES + sector * DIFAT_ENTRIES_PER_SECTOR + slot;
      file.writeUInt32LE(fatIndex < fatSectors ? firstFat + fatIndex : FREE_SECTOR, at + slot * 4);
    }
    file.writeUInt32LE(sector === difatSectors - 1 ? END_OF_CHAIN : firstDifat + sector + 1, at + DIFAT_ENTRIES_PER_SECTOR * 4);
  }
  return file;
}
