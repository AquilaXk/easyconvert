/**
 * Version 4 compound files ([MS-CFB] 2.2; 4096-byte sectors) laid out sector by sector, to make the shapes a hostile file takes and
 * the writer does not: a mini FAT chain that covers the whole file, a FAT sector list that names every sector, a directory far
 * from the FAT. A file of 8,192 sectors is 32 MiB and costs only the zeroed buffer.
 */

export const LARGE_SECTOR_BYTES = 4096;
export const LARGE_FAT_ENTRIES_PER_SECTOR = LARGE_SECTOR_BYTES / 4;
export const END_OF_CHAIN = 0xfffffffe;
export const FAT_SECTOR_MARK = 0xfffffffd;
export const DIFAT_SECTOR_MARK = 0xfffffffc;
export const FREE_SECTOR = 0xffffffff;

const HEADER_FAT_LIST_ENTRIES = 109;
const DIFAT_LIST_ENTRIES = LARGE_FAT_ENTRIES_PER_SECTOR - 1;
const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ROOT_ENTRY_TYPE = 5;
const STREAM_ENTRY_TYPE = 2;
const DIRECTORY_ENTRY_BYTES = 128;

/** A run of sectors that the FAT chains in file order. */
export interface SectorRun {
  first: number;
  length: number;
}

/** A stream of the root storage: its name, first sector and size. */
export interface LargeStream {
  name: string;
  start: number;
  size: number;
}

export interface LargeFileLayout {
  /** Sectors after the header. */
  sectors: number;
  directorySector: number;
  /** The sectors that the header and the DIFAT name as FAT sectors, in order; the first ones hold the table, so there must be as many as the file needs. */
  fatSectors: readonly number[];
  /** Sectors that hold the DIFAT chain, in order. */
  difatSectors?: readonly number[];
  /** Runs of sectors that the FAT chains: the mini FAT, the mini stream and the streams. */
  runs?: readonly SectorRun[];
  /** The root entry's first sector and size: the mini stream. */
  root?: { start: number; size: number };
  miniFat?: { first: number; headerCount: number };
  /** Streams of the root storage, in directory order after the root entry. */
  streams?: readonly LargeStream[];
  /** FAT entries set after the runs: `[sector, next]`, to chain a sector to one that is not its neighbour. */
  links?: ReadonlyArray<readonly [number, number]>;
}

function writeHeader(file: Buffer, layout: LargeFileLayout): void {
  SIGNATURE.copy(file, 0);
  file.writeUInt16LE(0x3e, 24);
  file.writeUInt16LE(4, 26);
  file.writeUInt16LE(0xfffe, 28);
  file.writeUInt16LE(12, 30);
  file.writeUInt16LE(6, 32);
  file.writeUInt32LE(layout.fatSectors.length, 44);
  file.writeUInt32LE(layout.directorySector, 48);
  file.writeUInt32LE(4096, 56);
  file.writeUInt32LE(layout.miniFat?.first ?? END_OF_CHAIN, 60);
  file.writeUInt32LE(layout.miniFat?.headerCount ?? 0, 64);
  file.writeUInt32LE(layout.difatSectors?.[0] ?? END_OF_CHAIN, 68);
  file.writeUInt32LE(layout.difatSectors?.length ?? 0, 72);
  for (let index = 0; index < HEADER_FAT_LIST_ENTRIES; index++) file.writeUInt32LE(layout.fatSectors[index] ?? FREE_SECTOR, 76 + index * 4);
}

const sectorOffset = (sector: number): number => (sector + 1) * LARGE_SECTOR_BYTES;

function writeDifat(file: Buffer, layout: LargeFileLayout): void {
  const difat = layout.difatSectors ?? [];
  difat.forEach((sector, index) => {
    for (let slot = 0; slot < DIFAT_LIST_ENTRIES; slot++) {
      const listed = layout.fatSectors[HEADER_FAT_LIST_ENTRIES + index * DIFAT_LIST_ENTRIES + slot];
      file.writeUInt32LE(listed ?? FREE_SECTOR, sectorOffset(sector) + slot * 4);
    }
    file.writeUInt32LE(difat[index + 1] ?? END_OF_CHAIN, sectorOffset(sector) + DIFAT_LIST_ENTRIES * 4);
  });
}

function nextSectors(layout: LargeFileLayout): Uint32Array {
  const next = new Uint32Array(layout.sectors).fill(FREE_SECTOR);
  const tableSectors = Math.ceil(layout.sectors / LARGE_FAT_ENTRIES_PER_SECTOR);
  for (const sector of layout.fatSectors.slice(0, tableSectors)) next[sector] = FAT_SECTOR_MARK;
  for (const sector of layout.difatSectors ?? []) next[sector] = DIFAT_SECTOR_MARK;
  next[layout.directorySector] = END_OF_CHAIN;
  for (const run of layout.runs ?? []) {
    for (let index = 0; index < run.length; index++) next[run.first + index] = index + 1 < run.length ? run.first + index + 1 : END_OF_CHAIN;
  }
  for (const [sector, target] of layout.links ?? []) next[sector] = target;
  return next;
}

function writeFat(file: Buffer, layout: LargeFileLayout): void {
  const next = nextSectors(layout);
  const tableSectors = Math.ceil(layout.sectors / LARGE_FAT_ENTRIES_PER_SECTOR);
  layout.fatSectors.slice(0, tableSectors).forEach((sector, index) => {
    for (let slot = 0; slot < LARGE_FAT_ENTRIES_PER_SECTOR; slot++) {
      file.writeUInt32LE(next[index * LARGE_FAT_ENTRIES_PER_SECTOR + slot] ?? FREE_SECTOR, sectorOffset(sector) + slot * 4);
    }
  });
}

function writeEntry(file: Buffer, at: number, entry: { name: string; type: number; right: number; child: number; start: number; size: number }): void {
  file.write(entry.name, at, 'utf16le');
  file.writeUInt16LE((entry.name.length + 1) * 2, at + 64);
  file.writeUInt8(entry.type, at + 66);
  file.writeUInt32LE(FREE_SECTOR, at + 68);
  file.writeUInt32LE(entry.right, at + 72);
  file.writeUInt32LE(entry.child, at + 76);
  file.writeUInt32LE(entry.start, at + 116);
  file.writeBigUInt64LE(BigInt(entry.size), at + 120);
}

function writeDirectory(file: Buffer, layout: LargeFileLayout): void {
  const at = sectorOffset(layout.directorySector);
  const streams = layout.streams ?? [];
  const root = { name: 'Root Entry', type: ROOT_ENTRY_TYPE, right: FREE_SECTOR, child: streams.length > 0 ? 1 : FREE_SECTOR, start: layout.root?.start ?? END_OF_CHAIN, size: layout.root?.size ?? 0 };
  writeEntry(file, at, root);
  streams.forEach((stream, index) => {
    const right = index + 1 < streams.length ? index + 2 : FREE_SECTOR;
    writeEntry(file, at + (index + 1) * DIRECTORY_ENTRY_BYTES, { ...stream, type: STREAM_ENTRY_TYPE, right, child: FREE_SECTOR });
  });
}

/** The file for `layout`: the header, the DIFAT chain, the FAT, a directory of the root entry and the streams, and zeros elsewhere. */
export function largeFile(layout: LargeFileLayout): Buffer {
  const file = Buffer.alloc((layout.sectors + 1) * LARGE_SECTOR_BYTES);
  writeHeader(file, layout);
  writeDifat(file, layout);
  writeFat(file, layout);
  writeDirectory(file, layout);
  return file;
}

/** How much the array buffers (the bytes of every Buffer and typed array) grew while `run` ran, garbage that has not been collected yet included. */
export const arrayBuffersGrowth = (run: () => void): number => {
  const before = process.memoryUsage().arrayBuffers;
  run();
  return process.memoryUsage().arrayBuffers - before;
};
