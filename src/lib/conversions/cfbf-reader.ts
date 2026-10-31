import { ConversionFailedError, CorruptStreamError } from '../types';
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

/**
 * Marks `sector` as read by chain `owner`, in the table of which chain read each sector. A sector read twice by one chain is a loop,
 * and one read by two chains is shared; both are refused, so no file makes the parser copy a sector twice. A sector of the FAT or
 * the DIFAT belongs to no chain. This is the loop rule of Apache POI BlockStore.ChainLoopDetector (a block claimed twice, the FAT
 * and DIFAT sectors in the same detector as the property table, `POIFSFileSystem.readCoreContents`), kept across chains as olefile
 * `_check_duplicate_stream` keeps the first sectors of all streams, and applied to every sector of every chain.
 */
function claimChainSector(owners: Uint32Array, sector: number, owner: number, start: number, unit: ChainUnit): void {
  if (owners[sector] === CFBF_TABLE_OWNER) {
    throw new CorruptStreamError(`Corrupt CFBF container: the ${unit} chain starting at ${unit} ${start} reads ${unit} ${sector}, which holds the FAT or the DIFAT.`);
  }
  if (owners[sector] === owner) {
    throw new CorruptStreamError(`Corrupt CFBF container: the ${unit} chain starting at ${unit} ${start} returns to ${unit} ${sector}.`);
  }
  if (owners[sector] !== 0) {
    throw new CorruptStreamError(`Corrupt CFBF container: ${unit} ${sector} belongs to two chains.`);
  }
  owners[sector] = owner;
}

/** The list a reader keeps of the units of the chain it is reading starts at this many, and doubles when a chain is longer. */
const CHAIN_LIST_START = 64;

type ChainUnit = 'sector' | 'mini sector';

/**
 * Reads chains of units (sectors of the file, or mini sectors of the mini stream) out of `data`: the units are listed as the table
 * gives them, each claimed once (`claimChainSector`), and the chain is copied into one buffer of exactly the bytes it holds, up to
 * `maxBytes`, with no buffer for a unit. The sectors of a file start after its one-sector header ([MS-CFB] 2.2) and the mini sectors
 * at the start of the mini stream. `owners` is the table of who read each unit; one list of units serves every chain, so a stream
 * costs no allocation but its own bytes.
 */
class ChainReader {
  private chains = 0;
  private units = new Uint32Array(CHAIN_LIST_START);
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

  /**
   * The bytes of the chain that starts at `start`, at most `maxBytes`. A chain stops at an end marker, at the byte limit, or, when
   * `mustEnd` is not set, at a unit that the data or the table does not hold (the stream that needed the rest is refused for its
   * size). With `mustEnd`, a chain that runs to a unit that the data or the table does not hold is refused.
   */
  read(start: number, maxBytes = Infinity, mustEnd = false): Buffer {
    if (start >= CFBF_FIRST_RESERVED_SECTOR) return Buffer.alloc(0);
    const owner = ++this.chains;
    let count = 0;
    let bytes = 0;
    let current = start;
    while (current < CFBF_FIRST_RESERVED_SECTOR) {
      const offset = this.offsetOf(current);
      if (offset >= this.data.length) {
        if (mustEnd) throw this.endsOutside(start, `reaches ${this.unit} ${current}, which the file does not hold`);
        break;
      }
      claimChainSector(this.owners, current, owner, start, this.unit);
      if (count === this.units.length) {
        const grown = new Uint32Array(this.units.length * 2);
        grown.set(this.units);
        this.units = grown;
      }
      this.units[count++] = current;
      bytes += Math.min(this.unitBytes, this.data.length - offset);
      if (bytes >= maxBytes) break;
      if (current >= this.table.length) {
        if (mustEnd) throw this.endsOutside(start, `ends at ${this.unit} ${current}, which the FAT does not cover`);
        break;
      }
      current = this.table[current];
    }

    const chain = Buffer.allocUnsafe(Math.min(bytes, maxBytes));
    let copied = 0;
    for (let i = 0; i < count && copied < chain.length; i++) {
      const offset = this.offsetOf(this.units[i]);
      copied += this.data.copy(chain, copied, offset, Math.min(offset + this.unitBytes, this.data.length));
    }
    return chain;
  }

  private offsetOf(unit: number): number {
    return this.firstUnitOffset + unit * this.unitBytes;
  }

  /**
   * A plain ConversionFailedError, not a CorruptStreamError: the office suite is given every file that the in-process reader refuses
   * as corrupt (`retryRefusedLegacyDocument`), and for the three real workbooks whose directory chain runs past the file
   * (govdocs1-007750, -007751, -008063) it writes the bytes as text. These files were refused before the chain was checked, with
   * the same class of error, and stay refused.
   */
  private endsOutside(start: number, what: string): ConversionFailedError {
    return new ConversionFailedError(`Corrupt CFBF container: the ${this.unit} chain starting at ${this.unit} ${start} ${what}.`);
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
  const miniFatSectorCount = buffer.readUInt32LE(64);
  const firstDifatSector = buffer.readUInt32LE(68);
  const difatSectorCount = buffer.readUInt32LE(72);

  // Sectors after the header, the last one possibly cut short (olefile `nb_sect`): no chain or table sector lies past them.
  const sectorsInFile = Math.ceil(buffer.length / sectorSize) - 1;
  const wholeSector = (sector: number): boolean => (sector + 2) * sectorSize <= buffer.length;

  // 1. Collect all FAT sector IDs from header (up to 109) and additional DIFAT sectors. Each DIFAT and FAT sector is read once
  // (Apache POI POIFSFileSystem.readCoreContents claims every FAT and XFAT block in one ChainLoopDetector), and the list ends at
  // the first FAT sector past the file, so the FAT never outgrows the file.
  const sectorOwners = new Uint32Array(sectorsInFile);
  const fatSectorIds: number[] = [];
  let fatListEnded = false;
  const addFatSector = (sId: number): void => {
    if (fatListEnded || sId >= CFBF_FIRST_RESERVED_SECTOR || fatSectorIds.length >= fatSectorCount) return;
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
  const fatEntriesPerSector = sectorSize / 4;
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
  // end at an end marker or runs out of the file or the FAT is refused, not cut short.
  const dirBuffer = sectorReader.read(firstDirSector, CFBF_DIRECTORY_READ_BYTES, true);
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

  const rootEntry = directoryEntries.find((d) => d.type === CFBF_ROOT_ENTRY) || directoryEntries[0];
  const hasMiniStream = rootEntry !== undefined && rootEntry.startingSector < CFBF_FIRST_RESERVED_SECTOR && rootEntry.streamSize > 0;
  assertStreamSizesFit(directoryEntries, hasMiniStream ? rootEntry.streamSize : 0, sectorsInFile * sectorSize);

  // 4. Build MiniFAT table; its chain too must end at an end marker.
  let miniFat: Uint32Array = new Uint32Array(0);
  if (miniFatSectorCount > 0 && firstMiniFatSector < CFBF_FIRST_RESERVED_SECTOR) {
    const miniFatBuffer = sectorReader.read(firstMiniFatSector, miniFatSectorCount * sectorSize, true);
    miniFat = new Uint32Array(Math.floor(miniFatBuffer.length / 4));
    for (let i = 0; i < miniFat.length; i++) {
      miniFat[i] = miniFatBuffer.readUInt32LE(i * 4);
    }
  }

  // 5. MiniStream buffer (stored in Root Entry starting sector)
  let miniStreamBuffer: Buffer = Buffer.alloc(0);
  if (hasMiniStream) {
    if (miniSectorShift !== CFBF_MINI_SECTOR_SHIFT) {
      throw new CorruptStreamError(`Corrupt CFBF container: mini sector shift ${miniSectorShift} is not ${CFBF_MINI_SECTOR_SHIFT}.`);
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
    if (miniSector >= CFBF_FIRST_RESERVED_SECTOR || !rootEntry) return undefined;
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
