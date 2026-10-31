import os from 'node:os';
import { CompoundFileStructureError, CorruptStreamError } from '../types';
import {
  CFBF_DIRECTORY_ENTRY_BYTES,
  CFBF_FIRST_RESERVED_SECTOR,
  CFBF_MAX_DIRECTORY_ENTRIES,
  CFBF_MAX_FILE_BYTES,
  CFBF_MAX_PATH_CHARS,
  CFBF_MAX_STORAGE_DEPTH,
  CFBF_SECTOR_SHIFTS,
} from '../compound-file-kind';

export interface CfbfDirectoryEntry {
  id: number;
  name: string;
  type: number; // 1: Storage, 2: Stream, 5: Root
  startingSector: number;
  streamSize: number;
  childId: number;
  leftSiblingId: number;
  rightSiblingId: number;
}

export interface CfbfContainer {
  sectorSize: number;
  miniSectorSize: number;
  directoryEntries: CfbfDirectoryEntry[];
  /** Streams by their own name; where two storages hold a stream of the same name, the later directory entry wins. */
  streams: Map<string, Buffer>;
  /** Streams by their full path from the root, such as `BodyText/Section0`. */
  paths: Map<string, Buffer>;
  /** Position in the file of byte `offset` of the stream at `path`, or undefined when the stream or the byte is not there. */
  streamByteOffset(path: string, offset: number): number | undefined;
}

/**
 * Validates whether buffer has the OLE2 Compound File Binary Format (CFBF) header
 */
export function isCfbfContainer(buffer: Buffer): boolean {
  if (buffer.length < 512) return false;
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

/** Sector size of version 3 compound files; version 4 files use 4096-byte sectors. */
const CFBF_V3_SECTOR_SIZE = 512;
/** The mini sector shift [MS-CFB] 2.2 requires (64-byte mini sectors). */
const CFBF_MINI_SECTOR_SHIFT = 6;
/**
 * The mini stream cutoff [MS-CFB] 2.2 requires: a stream below it lives in the mini stream. Apache POI never reads the header field
 * (`POIFSDocument.java` line 64 compares with `POIFSConstants.BIG_BLOCK_MINIMUM_DOCUMENT_SIZE`, 4096), olefile notes a defect for
 * another value and fixes it at 4096 (`olefile.py` lines 1368 to 1379) and LibreOffice takes any positive value (`StgHeader::Check`,
 * `stgelem.cxx` line 205). This parser does as POI and olefile do: the header field is not read and the cutoff is 4096, so that no
 * header can turn one stream into a chain of millions of mini sectors.
 */
const CFBF_MINI_STREAM_CUTOFF = 4096;
/** Owner of a FAT or DIFAT sector in the table of who read each sector; the chains are numbered from 1. */
const CFBF_TABLE_OWNER = 0xffffffff;
/** The most bytes of the directory chain the parser reads: the slots it may hold and one more, so that a longer chain is seen to be longer. */
const CFBF_DIRECTORY_READ_BYTES = (CFBF_MAX_DIRECTORY_ENTRIES + 1) * CFBF_DIRECTORY_ENTRY_BYTES;
/** Directory entry id meaning "no entry" ([MS-CFB] 2.6.1). */
const CFBF_NO_STREAM = 0xffffffff;
/** Directory entry type of a storage ([MS-CFB] 2.6.1). */
const CFBF_STORAGE_ENTRY = 1;
const CFBF_STREAM_ENTRY = 2;
const CFBF_ROOT_ENTRY = 5;

/** Marker that ends a chain of sectors ([MS-CFB] 2.1). */
const CFBF_END_OF_CHAIN = 0xfffffffe;
/** The list a reader keeps of the units of the chain it is reading starts at this many, and doubles when a chain is longer. */
const CHAIN_LIST_START = 64;
/** The words of a table are filled from the bytes of the file, which are little-endian ([MS-CFB] 2.1); a host of the other order swaps them. */
const LITTLE_ENDIAN_HOST = os.endianness() === 'LE';

type ChainUnit = 'sector' | 'mini sector';

/**
 * What a chain is for. The directory and the mini FAT are the structure that describes the file ('structure'): such a chain starts
 * at a sector, stays inside the file and the FAT, shares no sector with another chain or with the FAT, and ends at the end-of-chain
 * marker, and any other chain a refusal names is a `CompoundFileStructureError`. A stream's own chain ('stream') may end where the
 * file does, and its damage is a `CorruptStreamError`.
 */
type ChainRole = 'structure' | 'stream';

const hex = (marker: number): string => `0x${marker.toString(16)}`;

function chainRefusal(structural: boolean, message: string): CorruptStreamError {
  return structural ? new CompoundFileStructureError(message) : new CorruptStreamError(message);
}

/**
 * Reads chains of units (sectors of the file, or mini sectors of the mini stream) out of `data`: the units are listed as the table
 * gives them, each claimed once, and the chain is copied into one buffer of exactly the bytes it holds, up to `maxBytes`, with no
 * buffer for a unit. The sectors of a file start after its one-sector header ([MS-CFB] 2.2) and the mini sectors at the start of
 * the mini stream. `owners` is the table of who read each unit; one list of units serves every chain, so a stream costs no
 * allocation but its own bytes.
 *
 * A unit read twice by one chain is a loop and one read by two chains is shared; both are refused, so no file makes the parser
 * copy a unit twice. A sector of the FAT or the DIFAT belongs to no chain. This is the loop rule of Apache POI
 * BlockStore.ChainLoopDetector (a block claimed twice, the FAT and DIFAT sectors in the same detector as the property table,
 * `POIFSFileSystem.readCoreContents`), kept across chains as olefile `_check_duplicate_stream` keeps the first sectors of all
 * streams, and applied to every unit of every chain. A unit shared by a stream and a structure chain is refused as the structure's
 * damage, whichever of the two pointers is wrong: the file's table of contents can no longer be told from its data.
 */
class ChainReader {
  private chains = 0;
  private units = new Uint32Array(CHAIN_LIST_START);
  private unitCount = 0;
  private readonly structureOwners = new Set<number>();
  private readonly firstUnitOffset: number;

  constructor(
    private readonly data: Buffer,
    private readonly unit: ChainUnit,
    private readonly unitBytes: number,
    private readonly table: Uint32Array,
    private readonly owners: Uint32Array = new Uint32Array(Math.ceil(data.length / unitBytes))
  ) {
    this.firstUnitOffset = unit === 'sector' ? unitBytes : 0;
  }

  /** The bytes of the chain that starts at `start`, at most `maxBytes`. */
  read(start: number, maxBytes = Infinity, role: ChainRole = 'stream'): Buffer {
    const chain = Buffer.allocUnsafe(this.walk(start, maxBytes, role));
    this.copyInto(chain);
    return chain;
  }

  /** The words of a table that the chain from `start` holds, at most `maxWords`, filled in place with no copy of the bytes. */
  readWords(start: number, maxWords: number, role: ChainRole): Uint32Array {
    const words = new Uint32Array(this.walk(start, maxWords * Uint32Array.BYTES_PER_ELEMENT, role) >>> 2);
    const bytes = Buffer.from(words.buffer);
    this.copyInto(bytes);
    if (!LITTLE_ENDIAN_HOST) bytes.swap32();
    return words;
  }

  /**
   * Lists the units of the chain and returns the bytes they hold, at most `maxBytes`. A chain stops at an end marker, at the byte
   * limit, or, for a stream, at a unit that the data or the table does not hold (the stream that needed the rest is refused for its
   * size). A structure chain that runs to a unit that the data or the table does not hold, or ends on another marker, is refused.
   */
  private walk(start: number, maxBytes: number, role: ChainRole): number {
    const structural = role === 'structure';
    const owner = ++this.chains;
    if (structural) this.structureOwners.add(owner);
    this.unitCount = 0;
    if (start >= CFBF_FIRST_RESERVED_SECTOR && structural) {
      throw new CompoundFileStructureError(`Corrupt CFBF container: the ${this.unit} chain starts at the marker ${hex(start)}, not at a ${this.unit}.`);
    }
    let bytes = 0;
    let current = start;
    while (current < CFBF_FIRST_RESERVED_SECTOR) {
      const offset = this.offsetOf(current);
      if (offset >= this.data.length) {
        if (structural) throw this.endsOutside(start, `reaches ${this.unit} ${current}, which the file does not hold`);
        break;
      }
      this.claim(current, owner, start, structural);
      if (this.unitCount === this.units.length) {
        const grown = new Uint32Array(this.units.length * 2);
        grown.set(this.units);
        this.units = grown;
      }
      this.units[this.unitCount++] = current;
      bytes += Math.min(this.unitBytes, this.data.length - offset);
      if (bytes >= maxBytes) break;
      if (current >= this.table.length) {
        if (structural) throw this.endsOutside(start, `ends at ${this.unit} ${current}, which the FAT does not cover`);
        break;
      }
      current = this.table[current];
    }
    if (structural && current >= CFBF_FIRST_RESERVED_SECTOR && current !== CFBF_END_OF_CHAIN) {
      throw this.endsOutside(start, `ends at the marker ${hex(current)}, not at the end of the chain`);
    }
    return Math.min(bytes, maxBytes);
  }

  private copyInto(target: Buffer): void {
    let copied = 0;
    for (let i = 0; i < this.unitCount && copied < target.length; i++) {
      const offset = this.offsetOf(this.units[i]);
      copied += this.data.copy(target, copied, offset, Math.min(offset + this.unitBytes, this.data.length));
    }
  }

  private offsetOf(unit: number): number {
    return this.firstUnitOffset + unit * this.unitBytes;
  }

  /** Marks the unit at `index` as read by chain `owner`, or refuses the chain when the unit is read already. */
  private claim(index: number, owner: number, start: number, structural: boolean): void {
    const previous = this.owners[index];
    if (previous === 0) {
      this.owners[index] = owner;
      return;
    }
    const name = this.unit;
    const chain = `the ${name} chain starting at ${name} ${start}`;
    if (previous === CFBF_TABLE_OWNER) {
      throw chainRefusal(structural, `Corrupt CFBF container: ${chain} reads ${name} ${index}, which holds the FAT or the DIFAT.`);
    }
    if (previous === owner) {
      throw chainRefusal(structural, `Corrupt CFBF container: ${chain} returns to ${name} ${index}.`);
    }
    throw chainRefusal(structural || this.structureOwners.has(previous), `Corrupt CFBF container: ${name} ${index} belongs to two chains.`);
  }

  private endsOutside(start: number, what: string): CompoundFileStructureError {
    return new CompoundFileStructureError(`Corrupt CFBF container: the ${this.unit} chain starting at ${this.unit} ${start} ${what}.`);
  }
}

/**
 * Refuses directory entries whose streams declare more bytes than the file can hold, before any stream is copied: the streams at
 * or above the cutoff lie in the file's sectors, and the ones below it in the root entry's mini stream. The root entry's own size
 * is not counted: its chain is read only as far as the file holds it, as before.
 */
function assertStreamSizesFit(entries: readonly CfbfDirectoryEntry[], miniStreamBytes: number, sectorBytes: number): void {
  let regular = 0;
  let mini = 0;
  for (const entry of entries) {
    if (entry.type !== CFBF_STREAM_ENTRY || entry.streamSize === 0) continue;
    if (entry.streamSize < CFBF_MINI_STREAM_CUTOFF) mini += entry.streamSize;
    else regular += entry.streamSize;
  }
  if (regular > sectorBytes || mini > miniStreamBytes) {
    throw new CorruptStreamError(
      `Corrupt CFBF container: its streams declare ${regular} bytes in ${sectorBytes} bytes of sectors and ${mini} bytes in a ${miniStreamBytes}-byte mini stream.`
    );
  }
}

/**
 * Refuses a file whose header gives a mini stream cutoff other than 4096 when a stream is of a size between the two values. A
 * writer places a stream in the mini stream below its cutoff and in the sectors from it up, and this reader takes the cutoff as
 * 4096 (`CFBF_MINI_STREAM_CUTOFF`), so such a stream would be read from the other store and return the bytes of other sectors.
 * LibreOffice takes the cutoff from the header (`stgelem.cxx` line 205), so the office suite may still read the file.
 */
function assertStreamPlacementAgrees(entries: readonly CfbfDirectoryEntry[], headerCutoff: number): void {
  const lowest = Math.min(headerCutoff, CFBF_MINI_STREAM_CUTOFF);
  const highest = Math.max(headerCutoff, CFBF_MINI_STREAM_CUTOFF);
  const misplaced = entries.find((entry) => entry.type === CFBF_STREAM_ENTRY && entry.streamSize !== 0 && entry.streamSize >= lowest && entry.streamSize < highest);
  if (misplaced !== undefined) {
    throw new CorruptStreamError(
      `Corrupt CFBF container: its header gives the mini stream cutoff ${headerCutoff}, so its stream "${misplaced.name}" of ${misplaced.streamSize} bytes is stored in the other store than the one a cutoff of ${CFBF_MINI_STREAM_CUTOFF} reads.`
    );
  }
}

/**
 * Parses an authentic OLE2 CFBF container:
 * 512-byte header, SAT/FAT sectors, Directory Entries, MiniFAT and MiniStream.
 */
export function parseCfbf(buffer: Buffer): CfbfContainer {
  if (buffer.length > CFBF_MAX_FILE_BYTES) {
    throw new CorruptStreamError(`The compound file is larger than the ${CFBF_MAX_FILE_BYTES}-byte limit.`);
  }
  if (!isCfbfContainer(buffer)) {
    throw new CorruptStreamError('Invalid CFBF container: Missing OLE2 magic signature.');
  }

  // Header fields
  const sectorShift = buffer.readUInt16LE(30);
  const miniSectorShift = buffer.readUInt16LE(32);
  if (!CFBF_SECTOR_SHIFTS.has(sectorShift)) {
    throw new CorruptStreamError(`Corrupt CFBF container: sector shift ${sectorShift} is neither 9 nor 12.`);
  }
  const sectorSize = 1 << sectorShift; // Typically 512
  const miniSectorSize = 1 << miniSectorShift; // Typically 64

  const fatSectorCount = buffer.readUInt32LE(44);
  const firstDirSector = buffer.readUInt32LE(48);
  const firstMiniFatSector = buffer.readUInt32LE(60);
  const headerCutoff = buffer.readUInt32LE(56);
  const miniFatSectorCount = buffer.readUInt32LE(64);
  const firstDifatSector = buffer.readUInt32LE(68);
  const difatSectorCount = buffer.readUInt32LE(72);

  // Sectors after the header, the last one possibly cut short (olefile `nb_sect`): no chain or table sector lies past them.
  const sectorsInFile = Math.ceil(buffer.length / sectorSize) - 1;
  const wholeSector = (sector: number): boolean => (sector + 2) * sectorSize <= buffer.length;

  // 1. Collect all FAT sector IDs from header (up to 109) and additional DIFAT sectors. Each DIFAT and FAT sector is read once
  // (Apache POI POIFSFileSystem.readCoreContents claims every FAT and XFAT block in one ChainLoopDetector), and the list ends at
  // the first FAT sector past the file or when it holds the sectors that map every sector of the file, so the FAT never outgrows
  // the file (olefile `loadfat` shrinks the FAT to the sectors of the file, `olefile.py` lines 1643 to 1645).
  const fatEntriesPerSector = sectorSize / 4;
  const fatSectorLimit = Math.min(fatSectorCount, Math.ceil(sectorsInFile / fatEntriesPerSector));
  const sectorOwners = new Uint32Array(sectorsInFile);
  const fatSectorIds: number[] = [];
  let fatListEnded = false;
  const addFatSector = (sId: number): void => {
    if (fatListEnded || sId >= CFBF_FIRST_RESERVED_SECTOR || fatSectorIds.length >= fatSectorLimit) return;
    if (!wholeSector(sId)) {
      fatListEnded = true;
      return;
    }
    if (sectorOwners[sId] !== 0) throw new CorruptStreamError(`Corrupt CFBF container: the FAT sector list names sector ${sId} twice.`);
    sectorOwners[sId] = CFBF_TABLE_OWNER;
    fatSectorIds.push(sId);
  };
  for (let i = 0; i < 109; i++) addFatSector(buffer.readUInt32LE(76 + i * 4));

  let currDifatSector = firstDifatSector;
  let difatSectorsRead = 0;
  while (currDifatSector < CFBF_FIRST_RESERVED_SECTOR && difatSectorsRead < difatSectorCount) {
    if (!wholeSector(currDifatSector)) break;
    if (sectorOwners[currDifatSector] !== 0) {
      throw new CorruptStreamError(`Corrupt CFBF container: the DIFAT chain returns to sector ${currDifatSector}.`);
    }
    sectorOwners[currDifatSector] = CFBF_TABLE_OWNER;
    const offset = (currDifatSector + 1) * sectorSize;
    const entriesInSector = (sectorSize / 4) - 1;
    for (let i = 0; i < entriesInSector; i++) addFatSector(buffer.readUInt32LE(offset + i * 4));
    currDifatSector = buffer.readUInt32LE(offset + entriesInSector * 4);
    difatSectorsRead++;
  }

  // 2. Build the unified FAT table (mapping sector -> next sector)
  const totalFatEntries = fatSectorIds.length * fatEntriesPerSector;
  const fat = new Uint32Array(totalFatEntries);

  for (let fIdx = 0; fIdx < fatSectorIds.length; fIdx++) {
    const offset = (fatSectorIds[fIdx] + 1) * sectorSize;
    for (let e = 0; e < fatEntriesPerSector; e++) {
      fat[fIdx * fatEntriesPerSector + e] = buffer.readUInt32LE(offset + e * 4);
    }
  }

  const sectorReader = new ChainReader(buffer, 'sector', sectorSize, fat, sectorOwners);

  // 3. Read Directory stream: the slots it may hold and one more, so that a chain that holds more is refused; a chain that does not
  // end at the end-of-chain marker or runs out of the file or the FAT is refused, not cut short.
  const dirBuffer = sectorReader.read(firstDirSector, CFBF_DIRECTORY_READ_BYTES, 'structure');
  const entryCount = Math.floor(dirBuffer.length / CFBF_DIRECTORY_ENTRY_BYTES);
  if (entryCount > CFBF_MAX_DIRECTORY_ENTRIES) {
    throw new CorruptStreamError(`Corrupt CFBF container: its directory holds more than ${CFBF_MAX_DIRECTORY_ENTRIES} entries.`);
  }
  const directoryEntries: CfbfDirectoryEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    const off = i * CFBF_DIRECTORY_ENTRY_BYTES;
    const nameLen = dirBuffer.readUInt16LE(off + 64);
    if (nameLen <= 0) continue;

    // Decode UTF-16LE name
    const rawNameLen = Math.max(0, Math.min(64, nameLen - 2));
    const name = dirBuffer.toString('utf16le', off, off + rawNameLen).replace(/\0+$/, '');
    const type = dirBuffer.readUInt8(off + 66);
    const leftSiblingId = dirBuffer.readUInt32LE(off + 68);
    const rightSiblingId = dirBuffer.readUInt32LE(off + 72);
    const childId = dirBuffer.readUInt32LE(off + 76);
    const startingSector = dirBuffer.readUInt32LE(off + 116);
    // Version 3 files (512-byte sectors) keep the size in the low 32 bits; the high half is not meaningful ([MS-CFB] 2.6.1).
    const streamSize = sectorSize === CFBF_V3_SECTOR_SIZE ? dirBuffer.readUInt32LE(off + 120) : Number(dirBuffer.readBigUInt64LE(off + 120));

    directoryEntries.push({
      id: i,
      name,
      type,
      startingSector,
      streamSize,
      childId,
      leftSiblingId,
      rightSiblingId,
    });
  }

  if (directoryEntries.length === 0) {
    throw new CompoundFileStructureError('Corrupt CFBF container: its directory holds no entry.');
  }
  const rootEntry = directoryEntries.find((d) => d.type === CFBF_ROOT_ENTRY) || directoryEntries[0];
  const hasMiniStream = rootEntry.startingSector < CFBF_FIRST_RESERVED_SECTOR && rootEntry.streamSize > 0;
  assertStreamSizesFit(directoryEntries, hasMiniStream ? rootEntry.streamSize : 0, sectorsInFile * sectorSize);
  assertStreamPlacementAgrees(directoryEntries, headerCutoff);

  // 4. The mini stream (stored in the Root Entry's chain) and its MiniFAT. The MiniFAT is read only when there is a mini stream, and
  // only the entries that the mini stream can address (olefile `loadminifat` shrinks the table to the mini sectors of the root
  // entry's size, `olefile.py` lines 1667 and 1681, and loads it only when a stream below the cutoff is opened, lines 1858 to
  // 1860); its chain too must end at an end marker.
  let miniFat: Uint32Array = new Uint32Array(0);
  let miniStreamBuffer: Buffer = Buffer.alloc(0);
  if (hasMiniStream) {
    if (miniSectorShift !== CFBF_MINI_SECTOR_SHIFT) {
      throw new CorruptStreamError(`Corrupt CFBF container: mini sector shift ${miniSectorShift} is not ${CFBF_MINI_SECTOR_SHIFT}.`);
    }
    if (miniFatSectorCount > 0) {
      const addressableMiniSectors = Math.ceil(Math.min(rootEntry.streamSize, sectorsInFile * sectorSize) / miniSectorSize);
      miniFat = sectorReader.readWords(firstMiniFatSector, Math.min(addressableMiniSectors, miniFatSectorCount * fatEntriesPerSector), 'structure');
    }
    miniStreamBuffer = sectorReader.read(rootEntry.startingSector, rootEntry.streamSize);
  }
  const miniReader = new ChainReader(miniStreamBuffer, 'mini sector', miniSectorSize, miniFat);

  // 6. Extract all streams into lookup maps, by leaf name (the root storage's streams first) and by full path from the root
  const streams = new Map<string, Buffer>();
  const paths = new Map<string, Buffer>();
  const entriesByPath = new Map<string, CfbfDirectoryEntry>();

  /**
   * Full path of every entry reachable from the root through the child / sibling links of the directory tree. Storages nest at most
   * `CFBF_MAX_STORAGE_DEPTH` deep (the walk is iterative, so the depth bounds the length of a path and not the stack) and the paths
   * together spell out at most `CFBF_MAX_PATH_CHARS` characters.
   */
  function resolveEntryPaths(): Map<number, string> {
    const resolved = new Map<number, string>();
    const root = directoryEntries.find((d) => d.type === CFBF_ROOT_ENTRY);
    if (!root) return resolved;
    const byId = new Map(directoryEntries.map((d) => [d.id, d]));
    const pending: { id: number; prefix: string; depth: number }[] = [{ id: root.childId, prefix: '', depth: 0 }];
    let pathChars = 0;
    while (pending.length > 0) {
      const { id, prefix, depth } = pending.pop() as { id: number; prefix: string; depth: number };
      if (id === CFBF_NO_STREAM) continue;
      const entry = byId.get(id);
      if (!entry) continue;
      if (resolved.has(id)) {
        throw new CorruptStreamError(`Corrupt CFBF container: the directory tree reaches entry ${id} twice.`);
      }
      const entryPath = `${prefix}${entry.name}`;
      pathChars += entryPath.length;
      if (pathChars > CFBF_MAX_PATH_CHARS) {
        throw new CorruptStreamError(`Corrupt CFBF container: the paths of its entries spell out more than ${CFBF_MAX_PATH_CHARS} characters.`);
      }
      resolved.set(id, entryPath);
      pending.push({ id: entry.leftSiblingId, prefix, depth }, { id: entry.rightSiblingId, prefix, depth });
      if (entry.type === CFBF_STORAGE_ENTRY) {
        if (depth + 1 > CFBF_MAX_STORAGE_DEPTH) {
          throw new CorruptStreamError(`Corrupt CFBF container: storages are nested more than ${CFBF_MAX_STORAGE_DEPTH} deep.`);
        }
        pending.push({ id: entry.childId, prefix: `${entryPath}/`, depth: depth + 1 });
      }
    }
    return resolved;
  }

  function resolveStreamPaths() {
    const entryPaths = resolveEntryPaths();
    for (const entry of directoryEntries) {
      if (entry.type === CFBF_STREAM_ENTRY && entry.streamSize > 0) {
        let streamData: Buffer;
        if (entry.streamSize < CFBF_MINI_STREAM_CUTOFF) {
          if (miniStreamBuffer.length === 0) {
            throw new CorruptStreamError(
              `Corrupt CFBF container: stream "${entry.name}" is below the ${CFBF_MINI_STREAM_CUTOFF}-byte mini stream cutoff but the container has no mini stream.`
            );
          }
          streamData = miniReader.read(entry.startingSector, entry.streamSize);
        } else {
          streamData = sectorReader.read(entry.startingSector, entry.streamSize);
        }
        if (streamData.length < entry.streamSize) {
          throw new CorruptStreamError(
            `Corrupt CFBF container: stream "${entry.name}" declares ${entry.streamSize} bytes but its sector chain holds ${streamData.length}.`
          );
        }
        const entryPath = entryPaths.get(entry.id);
        // `streams` is by leaf name: a stream of the root storage is the file's own, so it is never replaced by a same-named
        // stream of an embedded object (the WordDocument and 1Table of an embedded Word document); nested ones only fill gaps. An entry the directory
        // tree does not reach has no path and counts as the root's, as it did before.
        const inRootStorage = !entryPath?.includes('/');
        if (inRootStorage || !streams.has(entry.name)) streams.set(entry.name, streamData);
        if (entryPath !== undefined) {
          paths.set(entryPath, streamData);
          entriesByPath.set(entryPath, entry);
        }
      }
    }
  }

  resolveStreamPaths();

  /** Position in the file of byte `offset` of the sector chain that starts at `startSector` ([MS-CFB] 2.3: the FAT gives the next sector). */
  function chainByteOffset(startSector: number, offset: number): number | undefined {
    let sector = startSector;
    for (let hops = Math.floor(offset / sectorSize); hops > 0; hops--) {
      if (sector >= fat.length) return undefined;
      sector = fat[sector];
    }
    if (sector >= CFBF_FIRST_RESERVED_SECTOR) return undefined;
    const position = (sector + 1) * sectorSize + (offset % sectorSize);
    return position < buffer.length ? position : undefined;
  }

  function streamByteOffset(path: string, offset: number): number | undefined {
    const entry = entriesByPath.get(path);
    if (entry === undefined || offset < 0 || offset >= entry.streamSize) return undefined;
    if (entry.streamSize >= CFBF_MINI_STREAM_CUTOFF) return chainByteOffset(entry.startingSector, offset);
    let miniSector = entry.startingSector;
    for (let hops = Math.floor(offset / miniSectorSize); hops > 0; hops--) {
      if (miniSector >= miniFat.length) return undefined;
      miniSector = miniFat[miniSector];
    }
    if (miniSector >= CFBF_FIRST_RESERVED_SECTOR) return undefined;
    return chainByteOffset(rootEntry.startingSector, miniSector * miniSectorSize + (offset % miniSectorSize));
  }

  return {
    sectorSize,
    miniSectorSize,
    directoryEntries,
    streams,
    paths,
    streamByteOffset,
  };
}
