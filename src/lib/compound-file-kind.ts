/**
 * Which kind an OLE2 compound file ([MS-CFB]) is, read from the class ID of its root storage and the names in its root directory.
 * StarWriter, StarCalc and StarDraw documents, Corel Presentations shows and Quattro Pro 9 workbooks exist only as compound
 * files, so their container signature says nothing about the kind; the engines tell them apart as follows, and this module
 * applies the same rules to the bytes the spoof check is given (the start of the file, up to the header window, or the sectors of
 * the directory read from where they lie in a file):
 *
 * - libmagic `magic/Magdir/ole2compounddocs` (file master, commit 41b1123, revision 1.30) reads the first directory entry, which must be the root
 *   storage (line 95), and names the kind by its class ID: StarOffice 3 to 5 at lines 642-713, Corel Presentations at lines
 *   612-617. It finds that entry from the first directory sector number in the header (lines 53, 63) and nothing else.
 * - LibreOffice `include/comphelper/classids.hxx` (commit 9cb04a8) lists the class IDs of StarWriter, StarCalc and StarImpress
 *   3 to 6 (lines 28-181) and of StarDraw 5 and 6 (lines 189-212); `sot/source/sdstor/stg.cxx` lines 853-862 reads the class ID
 *   of a storage from the CompObj stream first and from the root entry otherwise.
 * - Apache Tika `POIFSContainerDetector.detect` (commit eb8d704, lines 290-316) names the kind by the entry names under the root
 *   alone, compared in upper case, and never reads the class ID of StarCalc, StarWriter and StarDraw files; a Workbook stream
 *   decides before the StarOffice names do.
 * - libwps `WPSHeader::constructHeader` (lines 220-228) takes a file with a `NativeContent_MAIN` stream for Quattro Pro 9.
 *
 * The class ID of a kind accepts a file for that kind (libmagic), one of another kind refuses it, and so does the class ID of a Word,
 * Excel or PowerPoint file (libmagic `ole2compounddocs` lines 295-300, 322-329, 357 and 408-415 of the 5.41 release give them; the
 * Microsoft documents MS-DOC, MS-XLS and MS-PPT are the formats those files follow). A class ID that no database lists (the Quattro
 * Pro 9 sample carries such a one) says nothing, as Tika never reads the class ID of these files. The names accept a file for the
 * kinds whose streams an engine uses; Corel Presentations has no such stream in any engine, so only its class ID accepts it. Names
 * and class ID must not contradict each other, so a Word root with a `StarWriterDocument` stream is refused.
 *
 * The root is read through a walk that asks for the byte ranges it needs, so one reader serves a buffer that holds the start of a
 * file, a file on disk and an object in a store, which are read at the offsets of the directory sectors instead of through the
 * first 64 KiB. The limits of the parser that reads the file in full apply to every source (see `readCompoundFileRoot`).
 */

/** Sector numbers from here up are markers (free, end of chain, FAT, DIFAT), not positions in the file ([MS-CFB] 2.1). */
export const CFBF_FIRST_RESERVED_SECTOR = 0xfffffffa;
/** The most directory entries a compound file may declare before the parser that reads it in full refuses it. */
export const CFBF_MAX_DIRECTORY_ENTRIES = 65_536;
/** The sector shifts of version 3 and 4 files; Apache POI `HeaderBlock` refuses any other ("Expected 2^9 or 2^12"). */
export const CFBF_SECTOR_SHIFTS: ReadonlySet<number> = new Set([9, 12]);

const HEADER_BYTES = 512;
const SECTOR_SHIFT_OFFSET = 30;
const FAT_SECTOR_COUNT_OFFSET = 44;
const FIRST_DIRECTORY_SECTOR_OFFSET = 48;
const FIRST_DIFAT_SECTOR_OFFSET = 68;
const DIFAT_SECTOR_COUNT_OFFSET = 72;
const HEADER_FAT_OFFSET = 76;
const HEADER_FAT_ENTRIES = 109;
const FAT_ENTRY_BYTES = 4;

const DIRECTORY_ENTRY_BYTES = 128;
const NAME_LENGTH_OFFSET = 64;
const ENTRY_TYPE_OFFSET = 66;
const LEFT_SIBLING_OFFSET = 68;
const RIGHT_SIBLING_OFFSET = 72;
const CHILD_OFFSET = 76;
const CLASS_ID_OFFSET = 80;
const CLASS_ID_BYTES = 16;
/** The longest name a directory entry holds: 32 UTF-16 code units with the terminator ([MS-CFB] 2.6.1). */
const MAX_NAME_BYTES = 64;
const TERMINATOR_BYTES = 2;
const ROOT_STORAGE = 5;
const NO_ENTRY = 0xffffffff;

const UTF16LE = new TextDecoder('utf-16le');

/** The kinds by the extension that names them: `sdd` (StarImpress), `smf`, `sds`, `sgl`, `wpd`, `wpg` and `xls` are the neighbours that a claimed kind must not be taken for. */
type Kind = string;

/** The class IDs of the root storage by kind: the StarOffice 3 to 5 documents (libmagic lines 642-713, `classids.hxx` lines 28-212) and Corel Presentations (libmagic lines 612-620). */
const CLASS_ID_KINDS: ReadonlyMap<string, readonly Kind[]> = new Map<string, readonly Kind[]>([
  ['DC5C7E40-B35C-101B-9961-04021C007002', ['sdw']],
  ['8B04E9B0-420E-11D0-A45E-00A0249D57B1', ['sdw']],
  ['C20CF9D1-85AE-11D1-AAB4-006097DA561A', ['sdw']],
  ['3F543FA0-B6A6-101B-9961-04021C007002', ['sdc']],
  ['6361D441-4235-11D0-89CB-008029E4B0B1', ['sdc']],
  ['C6A5B861-85D6-11D1-89CB-008029E4B0B1', ['sdc']],
  // StarOffice 3 gives StarDraw and StarImpress one class ID (libmagic line 652 names it StarDraw, `SO3_SIMPRESS_CLASSID_30`).
  ['AF10AAE0-B36D-101B-9961-04021C007002', ['sda', 'sdd']],
  ['2E8905A0-85BD-11D1-89D0-008029E4B0B1', ['sda']],
  ['012D3CC0-4216-11D0-89CB-008029E4B0B1', ['sdd']],
  ['565C7221-85BC-11D1-89D0-008029E4B0B1', ['sdd']],
  ['D4590460-35FD-101C-B12A-04021C007002', ['smf']],
  ['02B3B7E1-4225-11D0-89CA-008029E4B0B1', ['smf']],
  ['FFB5E640-85DE-11D1-89D0-008029E4B0B1', ['smf']],
  ['FB9C99E0-2C6D-101C-8E2C-00001B4CC711', ['sds']],
  ['02B3B7E0-4225-11D0-89CA-008029E4B0B1', ['sds']],
  ['BF884321-85DD-11D1-89D0-008029E4B0B1', ['sds']],
  ['340AC970-E30D-11D0-A53F-00A0249D57B1', ['sgl']],
  ['C20CF9D3-85AE-11D1-AAB4-006097DA561A', ['sgl']],
  ['402EFE62-1999-101B-99AE-04021C007002', ['shw']],
  ['402EFE60-1999-101B-99AE-04021C007002', ['wpg']],
  ['519873FF-2DAD-0220-1937-0000929679CD', ['wpd']],
]);

/**
 * The root class IDs of the Word, Excel and PowerPoint files, which none of the five names may carry whatever streams the file holds
 * (libmagic 5.41 `ole2compounddocs`: Word 6-95 line 295, Word 97-2003 line 300, Excel 5-95 line 322, Excel 97-2003 line 329,
 * PowerPoint 4 line 357, PowerPoint 95 line 408, PowerPoint 97-2003 line 415; the same IDs are the root class IDs that MS-DOC,
 * MS-XLS and MS-PPT files are written with).
 */
const OFFICE_CLASS_IDS: ReadonlySet<string> = new Set([
  '00020900-0000-0000-C000-000000000046',
  '00020906-0000-0000-C000-000000000046',
  '00020810-0000-0000-C000-000000000046',
  '00020820-0000-0000-C000-000000000046',
  '00044851-0000-0000-C000-000000000046',
  'EA7BAE70-FB3B-11CD-A903-00AA00510EA3',
  '64818D10-4F9B-11CF-86EA-00AA00B929E8',
]);

/** Names under the root (upper case) that name a kind, in the order Tika tests them (`POIFSContainerDetector` lines 290-316); the first rule that finds a name decides. */
const NAME_KINDS: readonly (readonly [string, readonly Kind[]])[] = [
  ['WORKBOOK', ['xls']],
  ['STARCALCDOCUMENT', ['sdc']],
  ['STARWRITERDOCUMENT', ['sdw']],
  // Tika consults CompObj to tell StarDraw from StarImpress; the class ID does that here, and a file without one is taken for either.
  ['STARDRAWDOCUMENT3', ['sda', 'sdd']],
  ['NATIVECONTENT_MAIN', ['qpw']],
];

export type CompoundFileRoot =
  | {
      status: 'read';
      /** The class ID of the root storage as upper case GUID text; undefined when it is all zero. */
      classId: string | undefined;
      /** The upper case names of the entries under the root. */
      names: ReadonlySet<string>;
      /** False when the bytes end before the directory does, so names may be missing. */
      complete: boolean;
    }
  /** The directory lies past the bytes given: no first directory sector in them, or no whole sector of it. */
  | { status: 'unreadable' }
  /** The bytes cannot be a compound file's directory: a header no reader accepts, a first entry that is not the root, or a chain or tree that returns to itself. */
  | { status: 'malformed' };

const MALFORMED: CompoundFileRoot = { status: 'malformed' };
const UNREADABLE: CompoundFileRoot = { status: 'unreadable' };

interface DirectoryEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
}

/** Upper case GUID text of 16 bytes in the in-file layout (three little-endian fields, then 8 bytes), or undefined for the all-zero GUID. */
function guidText(bytes: Uint8Array): string | undefined {
  if (bytes.every((byte) => byte === 0)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, CLASS_ID_BYTES);
  const hex = (value: number, digits: number): string => value.toString(16).toUpperCase().padStart(digits, '0');
  const tail = Array.from(bytes.subarray(8), (byte) => hex(byte, 2)).join('');
  return `${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}-${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}

function decodeEntry(buf: Uint8Array, view: DataView, at: number): DirectoryEntry {
  const nameBytes = Math.max(0, Math.min(MAX_NAME_BYTES, view.getUint16(at + NAME_LENGTH_OFFSET, true) - TERMINATOR_BYTES));
  return {
    name: UTF16LE.decode(buf.subarray(at, at + nameBytes)).replace(/\0+$/, ''),
    type: buf[at + ENTRY_TYPE_OFFSET],
    left: view.getUint32(at + LEFT_SIBLING_OFFSET, true),
    right: view.getUint32(at + RIGHT_SIBLING_OFFSET, true),
    child: view.getUint32(at + CHILD_OFFSET, true),
  };
}

/** A run of bytes of the file that the walk asks its source for. */
interface ByteRange {
  offset: number;
  length: number;
}

/** The walk asks for byte ranges and is handed what the source has of them: fewer bytes than asked when the source ends, none past its end. */
type Walk<T> = Generator<ByteRange, T, Uint8Array>;

/** Bytes of a file from `offset`, as many as exist up to `length`: the reading of a file at an offset, which gives fewer bytes at the end and none past it. */
export type ByteSource = (offset: number, length: number) => Uint8Array;
export type AsyncByteSource = (offset: number, length: number) => Promise<Uint8Array>;

/** Raised inside the walk for a fault that makes the bytes no compound file's directory; `readRootWalk` turns it into the `malformed` status. */
class MalformedDirectory extends Error {}

/**
 * The FAT of the file, found as the parser that reads the file in full finds it (`parseCfbf`): the 109 FAT sector numbers of the
 * header, then those of the DIFAT chain, a sector of either kind read once and a FAT list that stops at the count the header gives.
 * The DIFAT chain is followed only as far as the sector being looked up needs, so a directory in the first 109 FAT sectors costs no
 * DIFAT read.
 */
function fatTable(header: DataView, sectorBytes: number): { nextSector: (sector: number) => Walk<number | undefined> } {
  const fatSectorCount = header.getUint32(FAT_SECTOR_COUNT_OFFSET, true);
  const difatSectorCount = header.getUint32(DIFAT_SECTOR_COUNT_OFFSET, true);
  const entriesPerSector = sectorBytes / FAT_ENTRY_BYTES;
  const fatSectors: number[] = [];
  const tableSectors = new Set<number>();
  let nextDifatSector = header.getUint32(FIRST_DIFAT_SECTOR_OFFSET, true);
  let difatSectorsRead = 0;

  const addFatSector = (sector: number): void => {
    if (sector >= CFBF_FIRST_RESERVED_SECTOR || fatSectors.length >= fatSectorCount) return;
    if (tableSectors.has(sector)) throw new MalformedDirectory();
    tableSectors.add(sector);
    fatSectors.push(sector);
  };
  for (let index = 0; index < HEADER_FAT_ENTRIES; index++) addFatSector(header.getUint32(HEADER_FAT_OFFSET + index * FAT_ENTRY_BYTES, true));

  function* fatSectorAt(index: number): Walk<number | undefined> {
    while (index >= fatSectors.length && fatSectors.length < fatSectorCount && nextDifatSector < CFBF_FIRST_RESERVED_SECTOR && difatSectorsRead < difatSectorCount) {
      if (tableSectors.has(nextDifatSector)) throw new MalformedDirectory();
      tableSectors.add(nextDifatSector);
      const sector = yield { offset: (nextDifatSector + 1) * sectorBytes, length: sectorBytes };
      if (sector.length < sectorBytes) return undefined;
      const view = new DataView(sector.buffer, sector.byteOffset, sectorBytes);
      for (let entry = 0; entry < entriesPerSector - 1; entry++) addFatSector(view.getUint32(entry * FAT_ENTRY_BYTES, true));
      nextDifatSector = view.getUint32((entriesPerSector - 1) * FAT_ENTRY_BYTES, true);
      difatSectorsRead++;
    }
    return fatSectors[index];
  }

  return {
    *nextSector(sector: number): Walk<number | undefined> {
      const fatSector = yield* fatSectorAt(Math.floor(sector / entriesPerSector));
      if (fatSector === undefined) return undefined;
      const entry = yield { offset: (fatSector + 1) * sectorBytes + (sector % entriesPerSector) * FAT_ENTRY_BYTES, length: FAT_ENTRY_BYTES };
      return entry.length === FAT_ENTRY_BYTES ? new DataView(entry.buffer, entry.byteOffset, FAT_ENTRY_BYTES).getUint32(0, true) : undefined;
    },
  };
}

/** The directory entries held by the whole sectors of the directory chain that the source has, the class ID of the first, and whether the chain ended inside the source. */
function* readDirectoryChain(
  firstSector: number,
  sectorBytes: number,
  fat: { nextSector: (sector: number) => Walk<number | undefined> }
): Walk<{ entries: DirectoryEntry[]; classId: string | undefined; chainEnded: boolean }> {
  const entries: DirectoryEntry[] = [];
  const read = new Set<number>();
  let classId: string | undefined;
  let sector = firstSector;
  while (sector < CFBF_FIRST_RESERVED_SECTOR) {
    if (read.has(sector)) throw new MalformedDirectory();
    read.add(sector);
    const bytes = yield { offset: (sector + 1) * sectorBytes, length: sectorBytes };
    if (bytes.length < sectorBytes) return { entries, classId, chainEnded: false };
    const view = new DataView(bytes.buffer, bytes.byteOffset, sectorBytes);
    if (sector === firstSector) classId = guidText(bytes.subarray(CLASS_ID_OFFSET, CLASS_ID_OFFSET + CLASS_ID_BYTES));
    for (let at = 0; at < sectorBytes; at += DIRECTORY_ENTRY_BYTES) {
      if (entries.length === CFBF_MAX_DIRECTORY_ENTRIES) throw new MalformedDirectory();
      entries.push(decodeEntry(bytes, view, at));
    }
    const next = yield* fat.nextSector(sector);
    if (next === undefined) return { entries, classId, chainEnded: false };
    sector = next;
  }
  return { entries, classId, chainEnded: true };
}

/** The upper case names of the entries under the root, following the child link and the sibling links of the red-black tree; undefined when the tree reaches an entry twice. */
function rootNames(entries: readonly DirectoryEntry[]): { names: Set<string>; allReached: boolean } | undefined {
  const names = new Set<string>();
  const reached = new Set<number>();
  const pending = [entries[0].child];
  let allReached = true;
  while (pending.length > 0) {
    const id = pending.pop() as number;
    if (id === NO_ENTRY) continue;
    if (id >= entries.length) {
      allReached = false;
      continue;
    }
    if (reached.has(id)) return undefined;
    reached.add(id);
    names.add(upperCaseAscii(entries[id].name));
    pending.push(entries[id].left, entries[id].right);
  }
  return { names, allReached };
}

/** Upper case for the letters a to z only: the office suite compares names in ASCII, so `ſ` (long s) and `ı` (dotless i) stay what they are. */
function upperCaseAscii(name: string): string {
  return name.replace(/[a-z]+/g, (letters) => letters.toUpperCase());
}

function* readRoot(): Walk<CompoundFileRoot> {
  const headerBytes = yield { offset: 0, length: HEADER_BYTES };
  if (headerBytes.length < HEADER_BYTES) return MALFORMED;
  const header = new DataView(headerBytes.buffer, headerBytes.byteOffset, HEADER_BYTES);
  const sectorShift = header.getUint16(SECTOR_SHIFT_OFFSET, true);
  const firstDirectorySector = header.getUint32(FIRST_DIRECTORY_SECTOR_OFFSET, true);
  if (!CFBF_SECTOR_SHIFTS.has(sectorShift) || firstDirectorySector >= CFBF_FIRST_RESERVED_SECTOR) return MALFORMED;

  const sectorBytes = 1 << sectorShift;
  const chain = yield* readDirectoryChain(firstDirectorySector, sectorBytes, fatTable(header, sectorBytes));
  if (chain.entries.length === 0) return UNREADABLE;
  if (chain.entries[0].type !== ROOT_STORAGE) return MALFORMED;

  const tree = rootNames(chain.entries);
  if (tree === undefined) return MALFORMED;
  return { status: 'read', classId: chain.classId, names: tree.names, complete: chain.chainEnded && tree.allReached };
}

function* readRootWalk(): Walk<CompoundFileRoot> {
  try {
    return yield* readRoot();
  } catch (error) {
    if (error instanceof MalformedDirectory) return MALFORMED;
    throw error;
  }
}

/** The size of the blocks a file or an object is read in: 64 KiB, the window the storage layer hands the spoof check. */
const SOURCE_BLOCK_BYTES = 65_536;
/** The most blocks one read fetches: twice the 128 that the largest directory accepted (65,536 entries of 128 bytes, 8 MiB) fills when it lies in one run, so a directory spread over a file cannot make the read fetch without end. */
const MAX_SOURCE_BLOCKS = 256;

/** The walk of the root with its ranges served from blocks (a range always lies in one block: the sector sizes 512 and 4096 divide 65,536, and a range starts at a multiple of the sector size or inside one sector) of `SOURCE_BLOCK_BYTES`, each fetched once; the walk is `malformed` when it would need more than `MAX_SOURCE_BLOCKS`. */
function* readRootFromBlocks(): Walk<CompoundFileRoot> {
  const walk = readRootWalk();
  const blocks = new Map<number, Uint8Array>();
  let step = walk.next();
  while (!step.done) {
    const { offset, length } = step.value;
    const index = Math.floor(offset / SOURCE_BLOCK_BYTES);
    const blockStart = index * SOURCE_BLOCK_BYTES;
    let block = blocks.get(index);
    if (block === undefined) {
      if (blocks.size === MAX_SOURCE_BLOCKS) return MALFORMED;
      block = yield { offset: blockStart, length: SOURCE_BLOCK_BYTES };
      blocks.set(index, block);
    }
    step = walk.next(block.subarray(offset - blockStart, offset - blockStart + length));
  }
  return step.value;
}

/**
 * Reads the class ID and the root entry names of the compound file that starts `buf`. Only whole directory sectors inside `buf`
 * are read, the directory chain is followed through the FAT sectors that the header and the DIFAT chain list, and the same limits
 * as the parser that reads the file in full apply: the sector shifts, the entry maximum, and a refusal of a chain or tree that
 * returns to itself, a first directory sector that is a marker, and a FAT or DIFAT sector listed twice.
 */
export function readCompoundFileRoot(buf: Uint8Array): CompoundFileRoot {
  const walk = readRootWalk();
  let step = walk.next();
  while (!step.done) step = walk.next(buf.subarray(step.value.offset, step.value.offset + step.value.length));
  return step.value;
}

/**
 * The same reading of a file that is not in memory: the directory sectors are fetched from `source` at their offsets, in blocks of
 * 64 KiB and at most 256 of them (a source that cannot give a range is a source that ends there). The file is whole, so a root
 * that the source ends before is `unreadable` for good.
 */
export function readCompoundFileRootFrom(source: ByteSource): CompoundFileRoot {
  const walk = readRootFromBlocks();
  let step = walk.next();
  while (!step.done) step = walk.next(source(step.value.offset, step.value.length));
  return step.value;
}

export async function readCompoundFileRootFromAsync(source: AsyncByteSource): Promise<CompoundFileRoot> {
  const walk = readRootFromBlocks();
  let step = walk.next();
  while (!step.done) step = walk.next(await source(step.value.offset, step.value.length));
  return step.value;
}

export type CompoundFileVerdict = 'match' | 'mismatch' | 'unreadable';

function kindsOfNames(names: ReadonlySet<string>): readonly Kind[] {
  return NAME_KINDS.find(([name]) => names.has(name))?.[1] ?? [];
}

function verdictOfRoot(ext: string, root: CompoundFileRoot): CompoundFileVerdict {
  if (root.status === 'unreadable') return 'unreadable';
  if (root.status === 'malformed') return 'mismatch';
  if (root.classId !== undefined && OFFICE_CLASS_IDS.has(root.classId)) return 'mismatch';
  const byClassId = root.classId === undefined ? [] : (CLASS_ID_KINDS.get(root.classId) ?? []);
  const byNames = kindsOfNames(root.names);
  if ((byClassId.length > 0 && !byClassId.includes(ext)) || (byNames.length > 0 && !byNames.includes(ext))) return 'mismatch';
  if (byClassId.length > 0 || byNames.length > 0) return 'match';
  return root.complete ? 'mismatch' : 'unreadable';
}

/**
 * Whether the compound file that starts `buf` is of the kind `ext` names. A class ID or a stream name of another kind refuses it,
 * as does the class ID of a Word, Excel or PowerPoint file; a class ID or stream name of the kind accepts it; a root that names no
 * kind at all is refused when the directory was read to its end and unreadable when it was not. The caller decides what an
 * unreadable directory means for the bytes it was given.
 */
export function compoundFileVerdict(ext: string, buf: Uint8Array): CompoundFileVerdict {
  return verdictOfRoot(ext, readCompoundFileRoot(buf));
}

/** The verdict for a file read at the offsets of its directory (see `readCompoundFileRootFrom`); `unreadable` there means the file ends before its directory does. */
export function compoundFileVerdictFrom(ext: string, source: ByteSource): CompoundFileVerdict {
  return verdictOfRoot(ext, readCompoundFileRootFrom(source));
}

export async function compoundFileVerdictFromAsync(ext: string, source: AsyncByteSource): Promise<CompoundFileVerdict> {
  return verdictOfRoot(ext, await readCompoundFileRootFromAsync(source));
}
