/**
 * Which kind an OLE2 compound file ([MS-CFB]) is, read from the class ID of its root storage and the names in its root directory.
 * StarWriter, StarCalc and StarDraw documents, Corel Presentations shows and Quattro Pro 9 workbooks exist only as compound
 * files, so their container signature says nothing about the kind; the engines tell them apart as follows, and this module
 * applies the same rules to the bytes the spoof check is given (the start of the file, up to the header window):
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
 * The class ID of a kind accepts a file for that kind (libmagic), one of another kind refuses it, and one that no database lists
 * (the Quattro Pro 9 sample carries such a one) says nothing, as Tika never reads the class ID of these files. The names accept a
 * file for the kinds whose streams an engine uses; Corel Presentations has no such stream in any engine, so only its class ID
 * accepts it. Names and class ID must not contradict each other.
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

/** The directory entries held by the whole sectors of the directory chain that lie in `buf`, and whether the chain ended inside it; undefined when the chain returns to a sector or holds too many entries. */
function readDirectoryChain(buf: Uint8Array, view: DataView, sectorBytes: number): { entries: DirectoryEntry[]; chainEnded: boolean } | undefined {
  const fatSectorCount = Math.min(view.getUint32(FAT_SECTOR_COUNT_OFFSET, true), HEADER_FAT_ENTRIES);
  const fatSectors = Array.from({ length: fatSectorCount }, (_, index) => view.getUint32(HEADER_FAT_OFFSET + index * FAT_ENTRY_BYTES, true));
  const fatEntriesPerSector = sectorBytes / FAT_ENTRY_BYTES;
  const nextSector = (sector: number): number | undefined => {
    const fatSector = fatSectors[Math.floor(sector / fatEntriesPerSector)];
    if (fatSector === undefined || fatSector >= CFBF_FIRST_RESERVED_SECTOR) return undefined;
    const at = (fatSector + 1) * sectorBytes + (sector % fatEntriesPerSector) * FAT_ENTRY_BYTES;
    return at + FAT_ENTRY_BYTES <= buf.length ? view.getUint32(at, true) : undefined;
  };

  const entries: DirectoryEntry[] = [];
  const read = new Set<number>();
  let sector = view.getUint32(FIRST_DIRECTORY_SECTOR_OFFSET, true);
  while (sector < CFBF_FIRST_RESERVED_SECTOR) {
    if (read.has(sector)) return undefined;
    read.add(sector);
    const start = (sector + 1) * sectorBytes;
    if (start + sectorBytes > buf.length) return { entries, chainEnded: false };
    for (let at = start; at < start + sectorBytes; at += DIRECTORY_ENTRY_BYTES) {
      if (entries.length === CFBF_MAX_DIRECTORY_ENTRIES) return undefined;
      entries.push(decodeEntry(buf, view, at));
    }
    const next = nextSector(sector);
    if (next === undefined) return { entries, chainEnded: false };
    sector = next;
  }
  return { entries, chainEnded: true };
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
    names.add(entries[id].name.toUpperCase());
    pending.push(entries[id].left, entries[id].right);
  }
  return { names, allReached };
}

/**
 * Reads the class ID and the root entry names of the compound file that starts `buf`. Only whole directory sectors inside `buf`
 * are read, the directory chain is followed through the FAT sectors that the header lists, and the same limits as the parser
 * that reads the file in full apply: the sector shifts, the entry maximum, and a refusal of a chain or tree that returns to itself.
 */
export function readCompoundFileRoot(buf: Uint8Array): CompoundFileRoot {
  if (buf.length < HEADER_BYTES) return MALFORMED;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sectorShift = view.getUint16(SECTOR_SHIFT_OFFSET, true);
  if (!CFBF_SECTOR_SHIFTS.has(sectorShift)) return MALFORMED;

  const sectorBytes = 1 << sectorShift;
  const chain = readDirectoryChain(buf, view, sectorBytes);
  if (chain === undefined) return MALFORMED;
  if (chain.entries.length === 0) return UNREADABLE;
  if (chain.entries[0].type !== ROOT_STORAGE) return MALFORMED;

  const tree = rootNames(chain.entries);
  if (tree === undefined) return MALFORMED;
  const classIdAt = (view.getUint32(FIRST_DIRECTORY_SECTOR_OFFSET, true) + 1) * sectorBytes + CLASS_ID_OFFSET;
  return {
    status: 'read',
    classId: guidText(buf.subarray(classIdAt, classIdAt + CLASS_ID_BYTES)),
    names: tree.names,
    complete: chain.chainEnded && tree.allReached,
  };
}

export type CompoundFileVerdict = 'match' | 'mismatch' | 'unreadable';

function kindsOfNames(names: ReadonlySet<string>): readonly Kind[] {
  return NAME_KINDS.find(([name]) => names.has(name))?.[1] ?? [];
}

/**
 * Whether the compound file that starts `buf` is of the kind `ext` names. A class ID or a stream name of another kind refuses it;
 * a class ID or stream name of the kind accepts it; a root that names no kind at all is refused when the directory was read to its
 * end and unreadable when it was not. The caller decides what an unreadable directory means for the bytes it was given.
 */
export function compoundFileVerdict(ext: string, buf: Uint8Array): CompoundFileVerdict {
  const root = readCompoundFileRoot(buf);
  if (root.status === 'unreadable') return 'unreadable';
  if (root.status === 'malformed') return 'mismatch';
  const byClassId = root.classId === undefined ? [] : (CLASS_ID_KINDS.get(root.classId) ?? []);
  const byNames = kindsOfNames(root.names);
  if ((byClassId.length > 0 && !byClassId.includes(ext)) || (byNames.length > 0 && !byNames.includes(ext))) return 'mismatch';
  if (byClassId.length > 0 || byNames.length > 0) return 'match';
  return root.complete ? 'mismatch' : 'unreadable';
}
