/**
 * Edits of version 3 compound files ([MS-CFB] 2.2 header, 2.3 FAT, 2.4 mini FAT, 2.6 directory) as the compound file writer lays
 * them out (512-byte sectors, 64-byte mini sectors, at most 109 FAT sectors), to make the layouts a writer may produce but this one
 * does not: chains whose sectors are not in file order, entries the directory tree does not reach, entries that share sectors.
 */

const SECTOR_BYTES = 512;
const MINI_SECTOR_BYTES = 64;
const ENTRY_BYTES = 128;
const TABLE_ENTRIES_PER_SECTOR = SECTOR_BYTES / 4;
const ENTRIES_PER_SECTOR = SECTOR_BYTES / ENTRY_BYTES;
const FAT_SECTOR_COUNT_OFFSET = 44;
const FIRST_DIRECTORY_SECTOR_OFFSET = 48;
const FIRST_MINI_FAT_SECTOR_OFFSET = 60;
const HEADER_DIFAT_OFFSET = 76;
const ENTRY_NAME_LENGTH_OFFSET = 64;
const ENTRY_LEFT_OFFSET = 68;
const ENTRY_RIGHT_OFFSET = 72;
const ENTRY_CHILD_OFFSET = 76;
const ENTRY_START_OFFSET = 116;
const ENTRY_SIZE_OFFSET = 120;
const ROOT_ENTRY_ID = 0;
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
export const NO_ENTRY = 0xffffffff;

const sectorOffset = (sector: number): number => (sector + 1) * SECTOR_BYTES;

function chainOf(table: readonly number[], start: number): number[] {
  const sectors: number[] = [];
  for (let sector = start; sector !== END_OF_CHAIN; sector = table[sector]) sectors.push(sector);
  return sectors;
}

function readTable(file: Buffer, sectors: readonly number[]): number[] {
  return sectors.flatMap((sector) => Array.from({ length: TABLE_ENTRIES_PER_SECTOR }, (_, index) => file.readUInt32LE(sectorOffset(sector) + index * 4)));
}

function writeTable(file: Buffer, sectors: readonly number[], table: readonly number[]): void {
  sectors.forEach((sector, sectorIndex) => {
    for (let index = 0; index < TABLE_ENTRIES_PER_SECTOR; index++) {
      file.writeUInt32LE(table[sectorIndex * TABLE_ENTRIES_PER_SECTOR + index], sectorOffset(sector) + index * 4);
    }
  });
}

const fatSectors = (file: Buffer): number[] =>
  Array.from({ length: file.readUInt32LE(FAT_SECTOR_COUNT_OFFSET) }, (_, index) => file.readUInt32LE(HEADER_DIFAT_OFFSET + index * 4));
const readFat = (file: Buffer): number[] => readTable(file, fatSectors(file));
const miniFatSectors = (file: Buffer): number[] => chainOf(readFat(file), file.readUInt32LE(FIRST_MINI_FAT_SECTOR_OFFSET));

function entryOffset(file: Buffer, id: number): number {
  const directory = chainOf(readFat(file), file.readUInt32LE(FIRST_DIRECTORY_SECTOR_OFFSET));
  return sectorOffset(directory[Math.floor(id / ENTRIES_PER_SECTOR)]) + (id % ENTRIES_PER_SECTOR) * ENTRY_BYTES;
}

export interface EntryFields {
  name?: string;
  left?: number;
  right?: number;
  child?: number;
  start?: number;
  size?: number;
}

/** The directory entry fields of `id`. */
export function entryFields(file: Buffer, id: number): Required<EntryFields> {
  const at = entryOffset(file, id);
  const nameBytes = Math.max(0, file.readUInt16LE(at + ENTRY_NAME_LENGTH_OFFSET) - 2);
  return {
    name: file.toString('utf16le', at, at + nameBytes),
    left: file.readUInt32LE(at + ENTRY_LEFT_OFFSET),
    right: file.readUInt32LE(at + ENTRY_RIGHT_OFFSET),
    child: file.readUInt32LE(at + ENTRY_CHILD_OFFSET),
    start: file.readUInt32LE(at + ENTRY_START_OFFSET),
    size: file.readUInt32LE(at + ENTRY_SIZE_OFFSET),
  };
}

/** Id of the directory entry named `name`, searched in the directory sectors in order. */
export function entryId(file: Buffer, name: string): number {
  const entryCount = chainOf(readFat(file), file.readUInt32LE(FIRST_DIRECTORY_SECTOR_OFFSET)).length * ENTRIES_PER_SECTOR;
  for (let id = 0; id < entryCount; id++) if (entryFields(file, id).name === name) return id;
  throw new Error(`no directory entry is named ${name}`);
}

/** Overwrites fields of directory entry `id` in place. A new name keeps the old length. */
export function setEntry(file: Buffer, id: number, fields: EntryFields): void {
  const at = entryOffset(file, id);
  if (fields.name !== undefined) file.write(fields.name, at, 'utf16le');
  if (fields.left !== undefined) file.writeUInt32LE(fields.left, at + ENTRY_LEFT_OFFSET);
  if (fields.right !== undefined) file.writeUInt32LE(fields.right, at + ENTRY_RIGHT_OFFSET);
  if (fields.child !== undefined) file.writeUInt32LE(fields.child, at + ENTRY_CHILD_OFFSET);
  if (fields.start !== undefined) file.writeUInt32LE(fields.start, at + ENTRY_START_OFFSET);
  if (fields.size !== undefined) file.writeUInt32LE(fields.size, at + ENTRY_SIZE_OFFSET);
}

/**
 * A copy of the file with sector `index` (not the first) of the chain that starts at `start` moved to a new sector after the last
 * one: its bytes are copied there, the chain is relinked through it, and the old sector is marked free with its bytes left in place.
 */
export function moveChainSectorToEnd(file: Buffer, start: number, index: number): Buffer {
  const fat = readFat(file);
  const chain = chainOf(fat, start);
  const moved = chain[index];
  const target = file.length / SECTOR_BYTES - 1;
  if (index === 0 || target >= fat.length) throw new Error('the sector cannot be moved in this layout');
  const copy = Buffer.concat([file, file.subarray(sectorOffset(moved), sectorOffset(moved) + SECTOR_BYTES)]);
  fat[target] = fat[moved];
  fat[chain[index - 1]] = target;
  fat[moved] = FREE_SECTOR;
  writeTable(copy, fatSectors(copy), fat);
  return copy;
}

/**
 * A copy of the file with mini sector `index` (not the first) of the mini chain that starts at `start` moved to a new mini sector
 * after the last one, inside the slack of the root entry's last sector: its bytes are copied there, the mini chain is relinked
 * through it, the root entry's size grows by one mini sector, and the old mini sector is marked free with its bytes left in place.
 */
export function moveMiniChainSectorToEnd(file: Buffer, start: number, index: number): Buffer {
  const copy = Buffer.from(file);
  const miniFat = readTable(copy, miniFatSectors(copy));
  const chain = chainOf(miniFat, start);
  const moved = chain[index];
  const root = entryFields(copy, ROOT_ENTRY_ID);
  const target = root.size / MINI_SECTOR_BYTES;
  const rootSectors = chainOf(readFat(copy), root.start);
  if (index === 0 || (target + 1) * MINI_SECTOR_BYTES > rootSectors.length * SECTOR_BYTES || target >= miniFat.length) {
    throw new Error('the mini sector cannot be moved in this layout');
  }
  const miniSectorOffset = (miniSector: number): number =>
    sectorOffset(rootSectors[Math.floor((miniSector * MINI_SECTOR_BYTES) / SECTOR_BYTES)]) + ((miniSector * MINI_SECTOR_BYTES) % SECTOR_BYTES);
  copy.copy(copy, miniSectorOffset(target), miniSectorOffset(moved), miniSectorOffset(moved) + MINI_SECTOR_BYTES);
  miniFat[target] = miniFat[moved];
  miniFat[chain[index - 1]] = target;
  miniFat[moved] = FREE_SECTOR;
  writeTable(copy, miniFatSectors(copy), miniFat);
  setEntry(copy, ROOT_ENTRY_ID, { size: root.size + MINI_SECTOR_BYTES });
  return copy;
}
