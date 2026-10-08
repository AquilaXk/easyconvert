import zlib from 'node:zlib';
import JSZip from 'jszip';
import sharp from 'sharp';
import { ConversionFailedError, ConversionOptions, ConversionResult, CorruptStreamError, EncryptedOfficeDocumentError } from '../types';
import { InflateBudget, inflateBounded } from './bounded-inflate';
import { encodeBmp } from './image';
import { buildOpenXpsPackage } from './openxps';
import { assertNoComplexScript } from './ctl';
import { renderPdfBlocks, type PdfBlock } from './pdf-blocks';
import { renderHwpToSvg } from './hwp-render';
import { buildCfbfContainer } from './cfbf-writer';
import { HWP_EQ_GREEK, HWP_EQ_SYMBOLS, hwpEquationToLaTeX, hwpEquationToMathML } from './hwp-equation';

/**
 * HWP 5.0 Record Tag IDs
 */
export const HWP_TAGS = {
  DOCUMENT_PROPERTIES: 16,
  ID_MAPPINGS: 17,
  BIN_DATA: 18,
  FACE_NAME: 19,
  BORDER_FILL: 20,
  CHAR_SHAPE: 21,
  TAB_DEF: 22,
  NUMBERING: 23,
  BULLET: 24,
  PARA_SHAPE: 25,
  STYLE: 26,
  DOC_DATA: 27,
  DISTRIBUTE_DOC_DATA: 28,

  // Section / BodyText Tags
  PARA_HEADER: 66,
  PARA_TEXT: 67,
  PARA_CHAR_SHAPE: 68,
  PARA_LINE_SEG: 69,
  PARA_RANGE_TAG: 70,
  CTRL_HEADER: 71,
  LIST_HEADER: 72,
  PAGE_DEF: 73,
  FOOTNOTE: 74,
  PAGE_BORDER_FILL: 75,
  SHAPE_COMPONENT: 76,
  TABLE: 77,
  SHAPE_COMPONENT_LINE: 78,
  SHAPE_COMPONENT_RECTANGLE: 79,
  SHAPE_COMPONENT_ELLIPSE: 80,
  SHAPE_COMPONENT_ARC: 81,
  SHAPE_COMPONENT_POLYGON: 82,
  SHAPE_COMPONENT_CURVE: 83,
  SHAPE_COMPONENT_OLE: 84,
  SHAPE_COMPONENT_PICTURE: 85,
  SHAPE_COMPONENT_CONTAINER: 86,
  CTRL_DATA: 87,
  EQEDIT: 88,
} as const;

export interface HwpEquation {
  script: string;
  mathml: string;
  latex: string;
}

export interface HwpParagraph {
  text: string;
  isHeading: boolean;
  isBold: boolean;
  isItalic: boolean;
  equations?: HwpEquation[];
}

export interface HwpTable {
  rowCount: number;
  colCount: number;
  rows: string[][];
}

export interface HwpDocument {
  version: string;
  isCompressed: boolean;
  isEncrypted: boolean;
  isDistributed: boolean;
  paragraphs: HwpParagraph[];
  tables: HwpTable[];
  equations?: HwpEquation[];
  metadata: {
    title?: string;
    author?: string;
    creator?: string;
    date?: string;
  };
}

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

/** Sector numbers from here up are markers (DIFAT, FAT, end of chain, free), not positions in the file (MS-CFB 2.1). */
const CFBF_FIRST_RESERVED_SECTOR = 0xfffffffa;
/** Sector size of version 3 compound files; version 4 files use 4096-byte sectors. */
const CFBF_V3_SECTOR_SIZE = 512;
/** Directory entry id meaning "no entry" ([MS-CFB] 2.6.1). */
const CFBF_NO_STREAM = 0xffffffff;
/** Directory entry type of a storage ([MS-CFB] 2.6.1). */
const CFBF_STORAGE_ENTRY = 1;
const CFBF_STREAM_ENTRY = 2;

/**
 * Parses an authentic OLE2 CFBF container:
 * 512-byte header, SAT/FAT sectors, Directory Entries, MiniFAT and MiniStream.
 */
export function parseCfbf(buffer: Buffer): CfbfContainer {
  if (!isCfbfContainer(buffer)) {
    throw new CorruptStreamError('Invalid CFBF container: Missing OLE2 magic signature.');
  }

  // Header fields
  const sectorShift = buffer.readUInt16LE(30);
  const miniSectorShift = buffer.readUInt16LE(32);
  const sectorSize = 1 << sectorShift; // Typically 512
  const miniSectorSize = 1 << miniSectorShift; // Typically 64

  const fatSectorCount = buffer.readUInt32LE(44);
  const firstDirSector = buffer.readUInt32LE(48);
  const miniStreamCutoff = buffer.readUInt32LE(56); // Typically 4096
  const firstMiniFatSector = buffer.readUInt32LE(60);
  const miniFatSectorCount = buffer.readUInt32LE(64);
  const firstDifatSector = buffer.readUInt32LE(68);
  const difatSectorCount = buffer.readUInt32LE(72);

  // 1. Collect all FAT sector IDs from header (up to 109) and additional DIFAT sectors
  const fatSectorIds: number[] = [];
  for (let i = 0; i < 109; i++) {
    const sId = buffer.readUInt32LE(76 + i * 4);
    if (sId < CFBF_FIRST_RESERVED_SECTOR && fatSectorIds.length < fatSectorCount) {
      fatSectorIds.push(sId);
    }
  }

  let currDifatSector = firstDifatSector;
  let difatSectorsRead = 0;
  const visitedDifat = new Set<number>();
  while (currDifatSector < CFBF_FIRST_RESERVED_SECTOR && difatSectorsRead < difatSectorCount) {
    if (visitedDifat.has(currDifatSector)) {
      throw new CorruptStreamError(`Corrupt CFBF container: the DIFAT chain returns to sector ${currDifatSector}.`);
    }
    visitedDifat.add(currDifatSector);
    const offset = (currDifatSector + 1) * sectorSize;
    if (offset + sectorSize > buffer.length) break;
    const entriesInSector = (sectorSize / 4) - 1;
    for (let i = 0; i < entriesInSector; i++) {
      const sId = buffer.readUInt32LE(offset + i * 4);
      if (sId < CFBF_FIRST_RESERVED_SECTOR && fatSectorIds.length < fatSectorCount) {
        fatSectorIds.push(sId);
      }
    }
    currDifatSector = buffer.readUInt32LE(offset + entriesInSector * 4);
    difatSectorsRead++;
  }

  // 2. Build the unified FAT table (mapping sector -> next sector)
  const fatEntriesPerSector = sectorSize / 4;
  const totalFatEntries = fatSectorIds.length * fatEntriesPerSector;
  const fat = new Uint32Array(totalFatEntries);

  for (let fIdx = 0; fIdx < fatSectorIds.length; fIdx++) {
    const sId = fatSectorIds[fIdx];
    const offset = (sId + 1) * sectorSize;
    if (offset + sectorSize > buffer.length) break;
    for (let e = 0; e < fatEntriesPerSector; e++) {
      fat[fIdx * fatEntriesPerSector + e] = buffer.readUInt32LE(offset + e * 4);
    }
  }

  // Helper to read a sector chain from the main FAT
  function readSectorChain(startSector: number, maxBytes?: number): Buffer {
    if (startSector >= CFBF_FIRST_RESERVED_SECTOR) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let curr = startSector;
    let bytesRead = 0;
    const visited = new Set<number>();

    while (curr < CFBF_FIRST_RESERVED_SECTOR) {
      if (visited.has(curr)) {
        throw new CorruptStreamError(
          `Corrupt CFBF container: the sector chain starting at sector ${startSector} returns to sector ${curr}.`
        );
      }
      visited.add(curr);
      const offset = (curr + 1) * sectorSize;
      if (offset >= buffer.length) break;
      const len = Math.min(sectorSize, buffer.length - offset);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + len)));
      bytesRead += len;
      if (maxBytes && bytesRead >= maxBytes) break;
      if (curr >= fat.length) break;
      curr = fat[curr];
    }

    const res = Buffer.concat(chunks);
    return maxBytes && res.length > maxBytes ? Buffer.from(res.subarray(0, maxBytes)) : res;
  }

  // 3. Read Directory stream
  const dirBuffer = readSectorChain(firstDirSector);
  const dirEntrySize = 128;
  const entryCount = Math.floor(dirBuffer.length / dirEntrySize);
  const directoryEntries: CfbfDirectoryEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    const off = i * dirEntrySize;
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

  // 4. Build MiniFAT table
  let miniFat: Uint32Array = new Uint32Array(0);
  if (miniFatSectorCount > 0 && firstMiniFatSector < CFBF_FIRST_RESERVED_SECTOR) {
    const miniFatBuffer = readSectorChain(firstMiniFatSector, miniFatSectorCount * sectorSize);
    miniFat = new Uint32Array(Math.floor(miniFatBuffer.length / 4));
    for (let i = 0; i < miniFat.length; i++) {
      miniFat[i] = miniFatBuffer.readUInt32LE(i * 4);
    }
  }

  // 5. MiniStream buffer (stored in Root Entry starting sector)
  const rootEntry = directoryEntries.find((d) => d.type === 5) || directoryEntries[0];
  let miniStreamBuffer: Buffer = Buffer.alloc(0);
  if (rootEntry && rootEntry.startingSector < CFBF_FIRST_RESERVED_SECTOR && rootEntry.streamSize > 0) {
    miniStreamBuffer = Buffer.from(readSectorChain(rootEntry.startingSector, rootEntry.streamSize));
  }

  // Helper to read mini sector chain
  function readMiniSectorChain(startMiniSector: number, size: number): Buffer {
    if (startMiniSector >= CFBF_FIRST_RESERVED_SECTOR || miniStreamBuffer.length === 0) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let curr = startMiniSector;
    let bytesRead = 0;
    const visited = new Set<number>();

    while (curr < CFBF_FIRST_RESERVED_SECTOR) {
      if (visited.has(curr)) {
        throw new CorruptStreamError(
          `Corrupt CFBF container: the mini sector chain starting at mini sector ${startMiniSector} returns to mini sector ${curr}.`
        );
      }
      visited.add(curr);
      const offset = curr * miniSectorSize;
      if (offset >= miniStreamBuffer.length) break;
      const len = Math.min(miniSectorSize, miniStreamBuffer.length - offset);
      chunks.push(Buffer.from(miniStreamBuffer.subarray(offset, offset + len)));
      bytesRead += len;
      if (bytesRead >= size) break;
      if (curr >= miniFat.length) break;
      curr = miniFat[curr];
    }

    const res = Buffer.concat(chunks);
    return res.length > size ? Buffer.from(res.subarray(0, size)) : res;
  }

  // 6. Extract all streams into lookup maps, by leaf name and by full path from the root
  const streams = new Map<string, Buffer>();
  const paths = new Map<string, Buffer>();

  /** Full path of every entry reachable from the root through the child / sibling links of the directory tree. */
  function resolveEntryPaths(): Map<number, string> {
    const resolved = new Map<number, string>();
    const root = directoryEntries.find((d) => d.type === 5);
    if (!root) return resolved;
    const byId = new Map(directoryEntries.map((d) => [d.id, d]));
    const pending: { id: number; prefix: string }[] = [{ id: root.childId, prefix: '' }];
    while (pending.length > 0) {
      const { id, prefix } = pending.pop() as { id: number; prefix: string };
      if (id === CFBF_NO_STREAM) continue;
      const entry = byId.get(id);
      if (!entry) continue;
      if (resolved.has(id)) {
        throw new CorruptStreamError(`Corrupt CFBF container: the directory tree reaches entry ${id} twice.`);
      }
      const entryPath = `${prefix}${entry.name}`;
      resolved.set(id, entryPath);
      pending.push({ id: entry.leftSiblingId, prefix }, { id: entry.rightSiblingId, prefix });
      if (entry.type === CFBF_STORAGE_ENTRY) pending.push({ id: entry.childId, prefix: `${entryPath}/` });
    }
    return resolved;
  }

  function resolveStreamPaths() {
    const entryPaths = resolveEntryPaths();
    for (const entry of directoryEntries) {
      if (entry.type === CFBF_STREAM_ENTRY && entry.streamSize > 0) {
        let streamData: Buffer;
        if (entry.streamSize < miniStreamCutoff) {
          if (miniStreamBuffer.length === 0) {
            throw new CorruptStreamError(
              `Corrupt CFBF container: stream "${entry.name}" is below the ${miniStreamCutoff}-byte mini stream cutoff but the container has no mini stream.`
            );
          }
          streamData = readMiniSectorChain(entry.startingSector, entry.streamSize);
        } else {
          streamData = readSectorChain(entry.startingSector, entry.streamSize);
        }
        if (streamData.length < entry.streamSize) {
          throw new CorruptStreamError(
            `Corrupt CFBF container: stream "${entry.name}" declares ${entry.streamSize} bytes but its sector chain holds ${streamData.length}.`
          );
        }
        streams.set(entry.name, streamData);
        const entryPath = entryPaths.get(entry.id);
        if (entryPath !== undefined) paths.set(entryPath, streamData);
      }
    }
  }

  resolveStreamPaths();

  return {
    sectorSize,
    miniSectorSize,
    directoryEntries,
    streams,
    paths,
  };
}

/**
 * Decompresses a compressed HWP stream. HWP 5.0 stores bare deflate and the format declares no
 * decoded size, so the output is bounded by the per-stream cap and, through `budget`, the decoded-byte
 * budget of the whole document. A zlib-wrapped stream is accepted too. Data that is neither throws a
 * CorruptStreamError, and one that decodes past a bound throws a DecompressionLimitError.
 */
export function decompressHwpStream(buf: Buffer, budget?: InflateBudget, streamName = 'stream'): Buffer {
  const label = `HWP ${streamName}`;
  try {
    return inflateBounded(buf, { label, format: 'raw', budget });
  } catch (err) {
    if (!(err instanceof CorruptStreamError)) throw err;
  }
  return inflateBounded(buf, { label, format: 'zlib', budget });
}

/**
 * HWP 5.0 Record representation
 */
export interface HwpRecord {
  tagId: number;
  level: number;
  size: number;
  payload: Buffer;
}

/**
 * Builds an HWP 5.0 record buffer with support for extended sizes (>= 0xFFF)
 */
export function buildHwpRecord(tagId: number, level: number, payload: Buffer): Buffer {
  const size = payload.length;
  if (size < 0xfff) {
    const header = ((tagId & 0x3ff) | ((level & 0x3ff) << 10) | ((size & 0xfff) << 20)) >>> 0;
    const rec = Buffer.alloc(4 + size);
    rec.writeUInt32LE(header, 0);
    payload.copy(rec, 4);
    return rec;
  } else {
    const header = ((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (0xfff << 20)) >>> 0;
    const rec = Buffer.alloc(4 + 4 + size);
    rec.writeUInt32LE(header, 0);
    rec.writeUInt32LE(size, 4);
    payload.copy(rec, 8);
    return rec;
  }
}

/** A 12-bit record size of 0xfff means the real size follows as a 32-bit word (HWP 5.0 file format, record structure). */
const HWP_EXTENDED_SIZE_MARKER = 0xfff;

/**
 * Parses sequential HWP 5.0 records from a decompressed stream buffer
 */
export function parseHwpRecords(buffer: Buffer): HwpRecord[] {
  const records: HwpRecord[] = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const header = buffer.readUInt32LE(offset);
    offset += 4;

    const tagId = header & 0x3ff;
    const level = (header >> 10) & 0x3ff;
    let size = (header >> 20) & 0xfff;

    if (size === HWP_EXTENDED_SIZE_MARKER) {
      if (offset + 4 > buffer.length) {
        throw new CorruptStreamError(`Corrupt HWP record: tag ${tagId} is cut off inside its extended size field.`);
      }
      size = buffer.readUInt32LE(offset);
      offset += 4;
    }

    if (offset + size > buffer.length) {
      throw new CorruptStreamError(
        `Corrupt HWP record: tag ${tagId} declares ${size} payload bytes but only ${buffer.length - offset} remain.`
      );
    }

    const payload = Buffer.from(buffer.subarray(offset, offset + size));
    offset += size;

    records.push({ tagId, level, size, payload });
  }

  if (offset < buffer.length) {
    throw new CorruptStreamError(`Corrupt HWP record stream: ${buffer.length - offset} stray bytes follow the last record.`);
  }

  return records;
}

/** A control character that carries data takes 8 UTF-16 units in paragraph text: the code, six data units, the code again. */
const HWP_CONTROL_UNITS = 8;
/** Control codes 1-9, 11, 12 and 14-23 are inline or extended controls of HWP_CONTROL_UNITS units (HWP 5.0 file format, control characters). */
const HWP_DATA_CONTROLS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
const HWP_TAB = 0x09;
const HWP_LINE_BREAK = 0x0a;
const HWP_HYPHEN = 0x18;
/** Non-breaking and fixed-width spaces. */
const HWP_SPACE_CONTROLS: ReadonlySet<number> = new Set([0x1e, 0x1f]);
const HWP_FIRST_PRINTABLE = 0x20;
const HWP_UTF16_UNIT_BYTES = 2;
/** Characters turned into a string per call, so a large paragraph cannot overflow the argument stack. */
const HWP_TEXT_CHUNK_UNITS = 4096;

/**
 * Decodes the UTF-16LE text of a paragraph record. Controls that carry data (section and column definitions, tables,
 * fields, footnotes, bookmarks and the like) take 8 units and contribute no text, except the tab; a line break stays a
 * newline; the paragraph end and other single-unit controls contribute nothing. A control cut off by the end of the
 * record, or an odd byte count, is a corrupt record.
 */
export function decodeHwpText(buffer: Buffer): string {
  if (buffer.length % HWP_UTF16_UNIT_BYTES !== 0) {
    throw new CorruptStreamError('Corrupt HWP paragraph text: the record does not hold whole UTF-16 characters.');
  }
  const unitCount = buffer.length / HWP_UTF16_UNIT_BYTES;
  const units: number[] = [];
  for (let index = 0; index < unitCount; index += 1) {
    const code = buffer.readUInt16LE(index * HWP_UTF16_UNIT_BYTES);
    if (HWP_DATA_CONTROLS.has(code)) {
      if (index + HWP_CONTROL_UNITS > unitCount) {
        throw new CorruptStreamError(`Corrupt HWP paragraph text: control character ${code} is cut off by the end of the record.`);
      }
      if (code === HWP_TAB) units.push(HWP_TAB);
      index += HWP_CONTROL_UNITS - 1;
    } else if (code === HWP_LINE_BREAK) {
      units.push(HWP_LINE_BREAK);
    } else if (code === HWP_HYPHEN) {
      units.push(0x2d);
    } else if (HWP_SPACE_CONTROLS.has(code)) {
      units.push(HWP_FIRST_PRINTABLE);
    } else if (code >= HWP_FIRST_PRINTABLE) {
      units.push(code);
    }
  }
  let result = '';
  for (let index = 0; index < units.length; index += HWP_TEXT_CHUNK_UNITS) {
    result += String.fromCodePoint(...units.slice(index, index + HWP_TEXT_CHUNK_UNITS));
  }
  return result;
}

export { HWP_EQ_GREEK, HWP_EQ_SYMBOLS, hwpEquationToMathML, hwpEquationToLaTeX };

const HWP_FILE_HEADER_SIGNATURE = 'HWP Document File';
const HWP_FILE_HEADER_BYTES = 256;
const HWP_VERSION_OFFSET = 32;
const HWP_FLAGS_OFFSET = 36;
const HWP_FLAG_COMPRESSED = 0x01;
const HWP_FLAG_ENCRYPTED = 0x02;
const HWP_FLAG_DISTRIBUTED = 0x04;
const HWP_SECTION_PATH = /^BodyText\/Section(\d+)$/;
/** Control id of a table in a CTRL_HEADER record: the four characters "tbl " as a little-endian word. */
const HWP_TABLE_CONTROL_ID = 0x74626c20;
const HWP_CONTROL_ID_BYTES = 4;
/** HWPTAG_TABLE: properties (4 bytes), row count and column count (2 bytes each). */
const HWP_TABLE_ROWS_OFFSET = 4;
const HWP_TABLE_COLS_OFFSET = 6;
const HWP_TABLE_MIN_PAYLOAD = 8;
/** Offsets of the cell spacing (2 bytes), the four cell margins (8 bytes) and the per-row cell counts that follow them. */
const HWP_TABLE_MARGINS_OFFSET = 10;
const HWP_TABLE_ROW_SIZES_OFFSET = 18;
/** HWPTAG_LIST_HEADER of a table cell: paragraph count (4), properties (4), then column and row address (2 bytes each). */
const HWP_CELL_COL_OFFSET = 8;
const HWP_CELL_ROW_OFFSET = 10;
const HWP_CELL_MIN_PAYLOAD = 12;
/** HWPTAG_EQEDIT: properties (4 bytes), script length in characters (2 bytes), the script in UTF-16LE. */
const HWP_EQUATION_LENGTH_OFFSET = 4;
const HWP_EQUATION_SCRIPT_OFFSET = 6;
/** Cells a table may declare; a 16-bit row and column count would otherwise allow billions. */
const HWP_MAX_TABLE_CELLS = 250_000;

interface HwpTableState {
  /** Level of the table's CTRL_HEADER record; a record at this level or above ends the table. */
  controlLevel: number;
  rowCount: number;
  colCount: number;
  cells: Map<number, string[]>;
  currentCell: number | null;
}

function corruptHwp(detail: string): CorruptStreamError {
  return new CorruptStreamError(`Invalid HWP document: ${detail}`);
}

function readHwpFileHeader(cfbf: CfbfContainer): { version: string; isCompressed: boolean; isEncrypted: boolean; isDistributed: boolean } {
  const header = cfbf.paths.get('FileHeader');
  if (!header || header.length < HWP_FILE_HEADER_BYTES) {
    throw corruptHwp(`the FileHeader stream is missing or shorter than ${HWP_FILE_HEADER_BYTES} bytes.`);
  }
  if (header.toString('latin1', 0, HWP_FILE_HEADER_SIGNATURE.length) !== HWP_FILE_HEADER_SIGNATURE) {
    throw corruptHwp('the FileHeader stream does not start with the HWP signature.');
  }
  const versionWord = header.readUInt32LE(HWP_VERSION_OFFSET);
  const flags = header.readUInt32LE(HWP_FLAGS_OFFSET);
  return {
    version: `${(versionWord >>> 24) & 0xff}.${(versionWord >>> 16) & 0xff}.${(versionWord >>> 8) & 0xff}.${versionWord & 0xff}`,
    isCompressed: (flags & HWP_FLAG_COMPRESSED) !== 0,
    isEncrypted: (flags & HWP_FLAG_ENCRYPTED) !== 0,
    isDistributed: (flags & HWP_FLAG_DISTRIBUTED) !== 0,
  };
}

/** The BodyText section streams in section order. */
function bodyTextSections(cfbf: CfbfContainer): Buffer[] {
  const sections: { index: number; stream: Buffer }[] = [];
  for (const [streamPath, stream] of cfbf.paths) {
    const match = HWP_SECTION_PATH.exec(streamPath);
    if (match) sections.push({ index: Number(match[1]), stream });
  }
  if (sections.length === 0) throw corruptHwp('it has no BodyText/Section streams.');
  sections.sort((a, b) => a.index - b.index);
  return sections.map((section) => section.stream);
}

function closeHwpTable(table: HwpTableState, parent: HwpTableState | undefined, tables: HwpTable[]): void {
  const rows: string[][] = [];
  for (let row = 0; row < table.rowCount; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col < table.colCount; col += 1) {
      cells.push((table.cells.get(row * table.colCount + col) ?? []).join(' '));
    }
    rows.push(cells);
  }
  if (parent && parent.currentCell !== null) {
    // A table inside a cell is flattened into the text of that cell.
    const texts = parent.cells.get(parent.currentCell) ?? [];
    for (const row of rows) for (const cell of row) if (cell) texts.push(cell);
    parent.cells.set(parent.currentCell, texts);
    return;
  }
  tables.push({ rowCount: table.rowCount, colCount: table.colCount, rows });
}

function readHwpEquation(payload: Buffer): HwpEquation {
  if (payload.length < HWP_EQUATION_SCRIPT_OFFSET) throw corruptHwp('an equation record is shorter than its fixed fields.');
  const length = payload.readUInt16LE(HWP_EQUATION_LENGTH_OFFSET);
  const end = HWP_EQUATION_SCRIPT_OFFSET + length * HWP_UTF16_UNIT_BYTES;
  if (end > payload.length) throw corruptHwp(`an equation declares ${length} characters but its record holds fewer.`);
  const script = payload.toString('utf16le', HWP_EQUATION_SCRIPT_OFFSET, end);
  return { script, mathml: hwpEquationToMathML(script), latex: hwpEquationToLaTeX(script) };
}

/**
 * Parses a full HWP 5.0 document: the FileHeader, the BodyText sections, and in them the paragraph texts and the
 * tables (HWP 5.0 file format: records nest by level; a table is a CTRL_HEADER "tbl " followed by HWPTAG_TABLE and,
 * per cell, a LIST_HEADER with the cell address and the cell's paragraphs). Anything that is not a readable HWP 5.0
 * document throws a typed error; no text is invented.
 */
export function parseHwpDocument(inputBuffer: Buffer): HwpDocument {
  if (!isCfbfContainer(inputBuffer)) {
    throw corruptHwp('the file is not an OLE2 compound file.');
  }
  const cfbf = parseCfbf(inputBuffer);
  const { version, isCompressed, isEncrypted, isDistributed } = readHwpFileHeader(cfbf);

  if (isEncrypted) {
    throw new EncryptedOfficeDocumentError('Encrypted HWP documents with password protection cannot be converted without credentials.');
  }
  if (isDistributed) {
    throw new ConversionFailedError('Distribution-protected HWP documents keep their text in encrypted ViewText streams and cannot be converted.');
  }

  const inflateBudget = new InflateBudget();
  const sectionBuffers = bodyTextSections(cfbf).map((stream, index) =>
    isCompressed ? decompressHwpStream(stream, inflateBudget, `Section${index}`) : stream
  );

  const paragraphs: HwpParagraph[] = [];
  const tables: HwpTable[] = [];
  const allEquations: HwpEquation[] = [];

  for (const sectionBuffer of sectionBuffers) {
    const openTables: HwpTableState[] = [];
    const closeInnermost = (): void => {
      const closed = openTables.pop() as HwpTableState;
      closeHwpTable(closed, openTables[openTables.length - 1], tables);
    };

    for (const rec of parseHwpRecords(sectionBuffer)) {
      while (openTables.length > 0 && rec.level <= openTables[openTables.length - 1].controlLevel) closeInnermost();
      const table = openTables[openTables.length - 1];

      if (rec.tagId === HWP_TAGS.CTRL_HEADER) {
        if (rec.payload.length >= HWP_CONTROL_ID_BYTES && rec.payload.readUInt32LE(0) === HWP_TABLE_CONTROL_ID) {
          openTables.push({ controlLevel: rec.level, rowCount: 0, colCount: 0, cells: new Map(), currentCell: null });
        }
      } else if (rec.tagId === HWP_TAGS.TABLE && table && rec.level === table.controlLevel + 1) {
        if (rec.payload.length < HWP_TABLE_MIN_PAYLOAD) throw corruptHwp('a table record is shorter than its fixed fields.');
        table.rowCount = rec.payload.readUInt16LE(HWP_TABLE_ROWS_OFFSET);
        table.colCount = rec.payload.readUInt16LE(HWP_TABLE_COLS_OFFSET);
        if (table.rowCount * table.colCount > HWP_MAX_TABLE_CELLS) {
          throw corruptHwp(`a table declares ${table.rowCount} x ${table.colCount} cells, more than the limit of ${HWP_MAX_TABLE_CELLS}.`);
        }
      } else if (rec.tagId === HWP_TAGS.LIST_HEADER && table && rec.level === table.controlLevel + 1) {
        // A list header before the table record is the table's caption: its paragraphs are document text, not a cell.
        if (table.rowCount === 0) continue;
        if (rec.payload.length < HWP_CELL_MIN_PAYLOAD) throw corruptHwp('a table cell record is shorter than its fixed fields.');
        const col = rec.payload.readUInt16LE(HWP_CELL_COL_OFFSET);
        const row = rec.payload.readUInt16LE(HWP_CELL_ROW_OFFSET);
        if (row >= table.rowCount || col >= table.colCount) {
          throw corruptHwp(`a table cell at row ${row}, column ${col} lies outside its ${table.rowCount} x ${table.colCount} table.`);
        }
        table.currentCell = row * table.colCount + col;
        if (!table.cells.has(table.currentCell)) table.cells.set(table.currentCell, []);
      } else if (rec.tagId === HWP_TAGS.PARA_TEXT) {
        const text = decodeHwpText(rec.payload).trim();
        if (!text) continue;
        if (table && table.currentCell !== null) {
          table.cells.get(table.currentCell)?.push(text);
        } else {
          paragraphs.push({ text, isHeading: false, isBold: false, isItalic: false });
        }
      } else if (rec.tagId === HWP_TAGS.EQEDIT) {
        const equation = readHwpEquation(rec.payload);
        allEquations.push(equation);
        const last = paragraphs[paragraphs.length - 1];
        if (last) last.equations = [...(last.equations ?? []), equation];
      }
    }
    while (openTables.length > 0) closeInnermost();
  }

  return {
    version,
    isCompressed,
    isEncrypted,
    isDistributed,
    paragraphs,
    tables,
    equations: allEquations.length > 0 ? allEquations : undefined,
    metadata: {},
  };
}

/** Control id of an equation in a CTRL_HEADER record: the four characters "eqed" as a little-endian word. */
const HWP_EQUATION_CONTROL_ID = 0x65716564;
/** UTF-16 units a control character with data takes in paragraph text. */
const HWP_PARAGRAPH_END = 0x000d;
const HWP_EXTENDED_CONTROL_CODE = 0x000b;
const HWP_PARA_HEADER_BYTES = 24;
const HWP_PARA_CONTROL_MASK_OFFSET = 4;
const HWP_PARA_CHAR_SHAPE_COUNT_OFFSET = 14;
const HWP_PARA_LINE_SEG_COUNT_OFFSET = 18;
/** Control mask bit set on a paragraph that holds a table or other drawing object. */
const HWP_PARA_HAS_OBJECT_MASK = 0x800;
/** Default cell geometry in HWP units (1/7200 inch) for tables written from plain rows. */
const HWP_CELL_WIDTH = 7200;
const HWP_CELL_HEIGHT = 1000;
const HWP_CELL_MARGIN = 141;
const HWP_CELL_BORDER_FILL_ID = 1;
const HWP_TABLE_ATTRIBUTES = 0x04000006;
const HWP_TABLE_CONTROL_COMMON_BYTES = 42;
const HWP_TABLE_CONTROL_ATTRIBUTES = 0x082a2210;
const HWP_CELL_HEADER_BYTES = 34;
const HWP_CELL_ATTRIBUTES = 0x05000020;
const HWP_DOCUMENT_PROPERTIES_BYTES = 26;
const HWP_FILE_FORMAT_VERSION = 0x05000300;
const HWP_FILE_HEADER_SIGNATURE_FIELD_BYTES = 32;

/** A paragraph record group at `level`: header, text with its paragraph end, and one character shape run. */
function hwpParagraphRecords(text: string, level: number, controlUnits: readonly number[] = []): Buffer[] {
  const textUnits = Buffer.from(text, 'utf16le');
  const controls = Buffer.alloc(controlUnits.length * HWP_UTF16_UNIT_BYTES);
  controlUnits.forEach((unit, index) => controls.writeUInt16LE(unit, index * HWP_UTF16_UNIT_BYTES));
  const end = Buffer.alloc(HWP_UTF16_UNIT_BYTES);
  end.writeUInt16LE(HWP_PARAGRAPH_END, 0);
  const paraText = Buffer.concat([controls, textUnits, end]);

  const header = Buffer.alloc(HWP_PARA_HEADER_BYTES);
  header.writeUInt32LE(paraText.length / HWP_UTF16_UNIT_BYTES, 0);
  header.writeUInt32LE(controlUnits.length > 0 ? HWP_PARA_HAS_OBJECT_MASK : 0, HWP_PARA_CONTROL_MASK_OFFSET);
  header.writeUInt16LE(1, HWP_PARA_CHAR_SHAPE_COUNT_OFFSET);
  header.writeUInt16LE(1, HWP_PARA_LINE_SEG_COUNT_OFFSET);
  return [
    buildHwpRecord(HWP_TAGS.PARA_HEADER, level, header),
    buildHwpRecord(HWP_TAGS.PARA_TEXT, level + 1, paraText),
    buildHwpRecord(HWP_TAGS.PARA_CHAR_SHAPE, level + 1, Buffer.alloc(8)),
  ];
}

/** The eight units an extended control takes in the text of its host paragraph: code, four-character id, data, code. */
function hwpExtendedControlUnits(controlId: number): number[] {
  return [HWP_EXTENDED_CONTROL_CODE, controlId & 0xffff, controlId >>> 16, 0, 0, 0, 0, HWP_EXTENDED_CONTROL_CODE];
}

function hwpTableRecords(rows: string[][]): Buffer[] {
  const rowCount = rows.length;
  const colCount = Math.max(1, ...rows.map((row) => row.length));
  const records = hwpParagraphRecords('', 0, hwpExtendedControlUnits(HWP_TABLE_CONTROL_ID));

  const control = Buffer.alloc(HWP_CONTROL_ID_BYTES + HWP_TABLE_CONTROL_COMMON_BYTES);
  control.writeUInt32LE(HWP_TABLE_CONTROL_ID, 0);
  control.writeUInt32LE(HWP_TABLE_CONTROL_ATTRIBUTES, 4);
  control.writeUInt32LE(colCount * HWP_CELL_WIDTH, 16);
  control.writeUInt32LE(rowCount * HWP_CELL_HEIGHT, 20);
  records.push(buildHwpRecord(HWP_TAGS.CTRL_HEADER, 1, control));

  const table = Buffer.alloc(HWP_TABLE_ROW_SIZES_OFFSET + rowCount * 2 + 2);
  table.writeUInt32LE(HWP_TABLE_ATTRIBUTES, 0);
  table.writeUInt16LE(rowCount, HWP_TABLE_ROWS_OFFSET);
  table.writeUInt16LE(colCount, HWP_TABLE_COLS_OFFSET);
  for (let margin = 0; margin < 4; margin += 1) table.writeUInt16LE(HWP_CELL_MARGIN, HWP_TABLE_MARGINS_OFFSET + margin * 2);
  for (let row = 0; row < rowCount; row += 1) table.writeUInt16LE(colCount, HWP_TABLE_ROW_SIZES_OFFSET + row * 2);
  table.writeUInt16LE(HWP_CELL_BORDER_FILL_ID, HWP_TABLE_ROW_SIZES_OFFSET + rowCount * 2);
  records.push(buildHwpRecord(HWP_TAGS.TABLE, 2, table));

  rows.forEach((row, rowIndex) => {
    for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
      const cell = Buffer.alloc(HWP_CELL_HEADER_BYTES);
      cell.writeUInt32LE(1, 0);
      cell.writeUInt32LE(HWP_CELL_ATTRIBUTES, 4);
      cell.writeUInt16LE(colIndex, HWP_CELL_COL_OFFSET);
      cell.writeUInt16LE(rowIndex, HWP_CELL_ROW_OFFSET);
      cell.writeUInt16LE(1, 12);
      cell.writeUInt16LE(1, 14);
      cell.writeUInt32LE(HWP_CELL_WIDTH, 16);
      cell.writeUInt32LE(HWP_CELL_HEIGHT, 20);
      for (let margin = 0; margin < 4; margin += 1) cell.writeUInt16LE(HWP_CELL_MARGIN, 24 + margin * 2);
      cell.writeUInt16LE(HWP_CELL_BORDER_FILL_ID, 32);
      records.push(buildHwpRecord(HWP_TAGS.LIST_HEADER, 2, cell));
      records.push(...hwpParagraphRecords(row[colIndex] ?? '', 2));
    }
  });
  return records;
}

function hwpEquationRecords(script: string): Buffer[] {
  const records = hwpParagraphRecords('', 0, hwpExtendedControlUnits(HWP_EQUATION_CONTROL_ID));
  const control = Buffer.alloc(HWP_CONTROL_ID_BYTES);
  control.writeUInt32LE(HWP_EQUATION_CONTROL_ID, 0);
  records.push(buildHwpRecord(HWP_TAGS.CTRL_HEADER, 1, control));
  const scriptUnits = Buffer.from(script, 'utf16le');
  const payload = Buffer.alloc(HWP_EQUATION_SCRIPT_OFFSET + scriptUnits.length);
  payload.writeUInt16LE(script.length, HWP_EQUATION_LENGTH_OFFSET);
  scriptUnits.copy(payload, HWP_EQUATION_SCRIPT_OFFSET);
  records.push(buildHwpRecord(HWP_TAGS.EQEDIT, 2, payload));
  return records;
}

/**
 * Builds an HWP 5.0 compound file: FileHeader, DocInfo and BodyText/Section0 streams in a version 3 compound file
 * ([MS-CFB]), the section holding paragraph, table (CTRL_HEADER "tbl ", HWPTAG_TABLE, one LIST_HEADER per cell) and
 * equation records laid out as in files written by the word processor. DocInfo carries only the document properties:
 * the file reads back through the format's record structure, but a word processor needs fonts and styles to open it.
 */
export function buildHwpCompoundFile(params: {
  paragraphs: { text: string; isHeading?: boolean }[];
  tables?: { rows: string[][] }[];
  equations?: string[];
  compressed?: boolean;
}): Buffer {
  const isCompressed = params.compressed !== false;
  const packStream = (raw: Buffer): Buffer => (isCompressed ? zlib.deflateRawSync(raw) : raw);

  const sectionRecords: Buffer[] = [];
  for (const paragraph of params.paragraphs) sectionRecords.push(...hwpParagraphRecords(paragraph.text, 0));
  for (const script of params.equations ?? []) sectionRecords.push(...hwpEquationRecords(script));
  for (const table of params.tables ?? []) sectionRecords.push(...hwpTableRecords(table.rows));

  const fileHeader = Buffer.alloc(HWP_FILE_HEADER_BYTES);
  fileHeader.write(HWP_FILE_HEADER_SIGNATURE, 0, 'latin1');
  fileHeader.writeUInt32LE(HWP_FILE_FORMAT_VERSION, HWP_VERSION_OFFSET);
  fileHeader.writeUInt32LE(isCompressed ? HWP_FLAG_COMPRESSED : 0, HWP_FLAGS_OFFSET);

  const documentProperties = Buffer.alloc(HWP_DOCUMENT_PROPERTIES_BYTES);
  documentProperties.writeUInt16LE(1, 0); // one section
  for (let start = 0; start < 6; start += 1) documentProperties.writeUInt16LE(1, 2 + start * 2); // page, footnote, endnote, figure, table and equation numbers start at 1
  const docInfo = buildHwpRecord(HWP_TAGS.DOCUMENT_PROPERTIES, 0, documentProperties);

  return buildCfbfContainer([
    { name: 'FileHeader', data: fileHeader },
    { name: 'DocInfo', data: packStream(docInfo) },
    { name: 'BodyText', children: [{ name: 'Section0', data: packStream(Buffer.concat(sectionRecords)) }] },
  ]);
}

/**
 * Converts parsed HWP document AST to PDF, OpenXML DOCX, ODT, HTML, TXT, RTF, MD, HWPX, or raster images.
 */
export async function convertHwpDocument(
  doc: HwpDocument,
  targetFormat: string,
  options: ConversionOptions = {},
  baseName: string
): Promise<ConversionResult> {
  const tgt = targetFormat.toLowerCase();

  // 1. Target: HWPX (KS X 6101 standard Open Packaging Convention XML container)
  if (tgt === 'hwpx') {
    const { buildHwpxContainer } = await import('./hwpx');
    const hwpxBuffer = await buildHwpxContainer(doc);
    return {
      buffer: hwpxBuffer,
      mimeType: 'application/hwp+zip',
      filename: `${baseName}.hwpx`,
      size: hwpxBuffer.length,
    };
  }

  // 2. Target: HWP (HWP 5.0 CFBF compound binary)
  if (tgt === 'hwp') {
    const hwpBuffer = buildHwpCompoundFile({
      paragraphs: doc.paragraphs,
      tables: doc.tables,
    });
    return {
      buffer: hwpBuffer,
      mimeType: 'application/x-hwp',
      filename: `${baseName}.hwp`,
      size: hwpBuffer.length,
    };
  }

  // 3. Target: Markdown (MD)
  if (tgt === 'md' || tgt === 'markdown') {
    let md = '';
    if (doc.metadata?.title) {
      md += `# ${doc.metadata.title}\n\n`;
    }
    doc.paragraphs.forEach((p) => {
      if (p.isHeading) {
        md += `## ${p.text}\n\n`;
      } else {
        md += `${p.text}\n\n`;
      }
    });
    doc.tables.forEach((t) => {
      if (t.rows.length > 0) {
        md += '| ' + t.rows[0].join(' | ') + ' |\n';
        md += '| ' + t.rows[0].map(() => '---').join(' | ') + ' |\n';
        t.rows.slice(1).forEach((r) => {
          md += '| ' + r.join(' | ') + ' |\n';
        });
        md += '\n';
      }
    });
    const buffer = Buffer.from(md.trim(), 'utf-8');
    return { buffer, mimeType: 'text/markdown', filename: `${baseName}.md`, size: buffer.length };
  }

  // 4. Target: PDF with structured tables and paragraphs
  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromHwp(doc, options, baseName);
    return {
      buffer: pdfBuffer,
      mimeType: 'application/pdf',
      filename: `${baseName}.pdf`,
      size: pdfBuffer.length,
    };
  }

  // 5. Target: DOCX with OpenXML tables and formatted paragraphs
  if (tgt === 'docx') {
    const docxBuffer = await generateDocxFromHwp(doc, baseName);
    return {
      buffer: docxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${baseName}.docx`,
      size: docxBuffer.length,
    };
  }

  // 6. Target: HTML with structured markup
  if (tgt === 'html') {
    let html = `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(baseName)}</title>\n`;
    html += `<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:40px;color:#1F2340}h1,h2{color:#5C6BC0}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{border:1px solid #CCD2FC;padding:8px 12px;text-align:left}th{background:#F0F2FE}</style>\n</head>\n<body>\n`;

    doc.paragraphs.forEach((p) => {
      if (p.isHeading) {
        html += `<h2>${escapeHtml(p.text)}</h2>\n`;
      } else {
        html += `<p>${escapeHtml(p.text)}</p>\n`;
      }
    });

    doc.tables.forEach((t) => {
      html += '<table>\n';
      t.rows.forEach((row, rIdx) => {
        html += '  <tr>\n';
        const tag = rIdx === 0 ? 'th' : 'td';
        row.forEach((cell) => {
          html += `    <${tag}>${escapeHtml(cell)}</${tag}>\n`;
        });
        html += '  </tr>\n';
      });
      html += '</table>\n';
    });

    html += '</body>\n</html>';
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  // 7. Target: TXT
  if (tgt === 'txt') {
    const parts: string[] = doc.paragraphs.map((p) => p.text);
    doc.tables.forEach((t) => {
      parts.push(t.rows.map((r) => r.join('\t')).join('\n'));
    });
    const text = parts.join('\n\n');
    const buffer = Buffer.from(text, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  // 8. Target: RTF
  if (tgt === 'rtf') {
    const bodyParts: string[] = [];
    doc.paragraphs.forEach((p) => {
      bodyParts.push(escapeHtml(p.text).replace(/\r?\n/g, '\\par '));
    });
    doc.tables.forEach((t) => {
      t.rows.forEach((r) => {
        bodyParts.push(r.map(escapeHtml).join(' \\tab ') + '\\par ');
      });
    });
    const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Malgun Gothic;\\f1 Times New Roman;}}\\fs24 ${bodyParts.join('\\par\\par ')}}\n`;
    const buffer = Buffer.from(rtf, 'utf-8');
    return { buffer, mimeType: 'application/rtf', filename: `${baseName}.rtf`, size: buffer.length };
  }

  // 9. Target: ODT (OpenDocument Text)
  if (tgt === 'odt') {
    const odtBuffer = await generateOdtFromHwp(doc, baseName);
    return {
      buffer: odtBuffer,
      mimeType: 'application/vnd.oasis.opendocument.text',
      filename: `${baseName}.odt`,
      size: odtBuffer.length,
    };
  }

  // 10. Target: DOC (Word RTF-based)
  if (tgt === 'doc') {
    const rtfResult = await convertHwpDocument(doc, 'rtf', options, baseName);
    return {
      buffer: rtfResult.buffer,
      mimeType: 'application/msword',
      filename: `${baseName}.doc`,
      size: rtfResult.buffer.length,
    };
  }

  // 11. Target: XPS
  if (tgt === 'xps') {
    const xpsBuffer = await generateXpsFromHwp(doc, baseName);
    return {
      buffer: xpsBuffer,
      mimeType: 'application/oxps',
      filename: `${baseName}.xps`,
      size: xpsBuffer.length,
    };
  }

  // 12. Target: Raster Images (PNG, JPG, WEBP, BMP)
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(tgt)) {
    const raster = await renderHwpToRaster(doc, tgt);
    return {
      buffer: raster.buffer,
      mimeType: raster.mimeType,
      filename: `${baseName}.${tgt}`,
      size: raster.buffer.length,
    };
  }

  throw new ConversionFailedError(`Cannot convert HWP documents to '.${tgt}'.`);
}

/**
 * Converts HWP 5.0 documents to PDF, OpenXML DOCX, ODT, HTML, TXT, RTF, HWPX.
 */
export async function convertHwp(
  inputBuffer: Buffer,
  targetFormat: string,
  options: ConversionOptions = {},
  baseName: string
): Promise<ConversionResult> {
  const doc = parseHwpDocument(inputBuffer);
  return convertHwpDocument(doc, targetFormat, options, baseName);
}

/** Heading level HWP heading paragraphs are drawn at. */
const HWP_PDF_HEADING_LEVEL = 3;

/**
 * Renders HWP paragraphs and tables into PDF. The page holds only the document content (the
 * title goes to the PDF metadata), drawn with embedded fonts covering every character.
 */
async function generatePdfFromHwp(
  doc: HwpDocument,
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  for (const p of doc.paragraphs ?? []) {
    if (p.text) assertNoComplexScript(p.text, 'Pure-TS HWP to PDF');
  }
  for (const tbl of doc.tables ?? []) {
    for (const r of tbl.rows) {
      for (const cell of r) {
        assertNoComplexScript(cell, 'Pure-TS HWP to PDF');
      }
    }
  }

  const blocks: PdfBlock[] = [];
  for (const p of doc.paragraphs ?? []) {
    blocks.push(
      p.isHeading
        ? { kind: 'heading', level: HWP_PDF_HEADING_LEVEL, content: [{ text: p.text }] }
        : { kind: 'paragraph', content: [{ text: p.text }] }
    );
  }
  for (const tbl of doc.tables ?? []) {
    if (tbl.rows.length === 0) continue;
    blocks.push({ kind: 'table', rows: tbl.rows.map((row) => row.map((cell) => ({ content: [{ text: cell }], span: 1 }))) });
  }
  return renderPdfBlocks(blocks, { orientation: options.orientation, title });
}

/**
 * Builds authentic OpenXML DOCX containing structured tables and paragraphs
 */
async function generateDocxFromHwp(doc: HwpDocument, title: string): Promise<Buffer> {
  const zip = new JSZip();

  // [Content_Types].xml
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );

  // _rels/.rels
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  // word/_rels/document.xml.rels
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`
  );

  let bodyXml = '';

  // Title
  bodyXml += `<w:p><w:pPr><w:pStyle w:val="Title"/><w:spacing w:after="240"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="1F2340"/></w:rPr><w:t>${escapeXml(
    title
  )}</w:t></w:r></w:p>`;

  // Paragraphs
  for (const p of doc.paragraphs) {
    if (p.isHeading) {
      bodyXml += `<w:p><w:pPr><w:spacing w:before="200" w:after="120"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="5C6BC0"/></w:rPr><w:t>${escapeXml(
        p.text
      )}</w:t></w:r></w:p>`;
    } else {
      bodyXml += `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:sz w:val="22"/><w:color w:val="2D3748"/></w:rPr><w:t>${escapeXml(
        p.text
      )}</w:t></w:r></w:p>`;
    }
  }

  // Tables
  for (const tbl of doc.tables) {
    if (tbl.rows.length === 0) continue;
    let tblXml = `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CCD2FC"/><w:bottom w:val="single" w:sz="4" w:color="CCD2FC"/><w:left w:val="single" w:sz="4" w:color="CCD2FC"/><w:right w:val="single" w:sz="4" w:color="CCD2FC"/><w:insideH w:val="single" w:sz="4" w:color="E1E4EE"/><w:insideV w:val="single" w:sz="4" w:color="E1E4EE"/></w:tblBorders></w:tblPr>`;
    const colCount = Math.max(1, tbl.colCount || tbl.rows[0].length);
    tblXml += `<w:tblGrid>${new Array(colCount).fill('<w:gridCol/>').join('')}</w:tblGrid>`;

    tbl.rows.forEach((row, rIdx) => {
      tblXml += `<w:tr>`;
      const isHeader = rIdx === 0;
      row.forEach((cell) => {
        tblXml += `<w:tc><w:tcPr>${
          isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="F0F2FE"/>' : ''
        }</w:tcPr><w:p><w:r><w:rPr>${
          isHeader ? '<w:b/><w:color w:val="1F2340"/>' : '<w:color w:val="4A5568"/>'
        }</w:rPr><w:t>${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`;
      });
      tblXml += `</w:tr>`;
    });

    tblXml += `</w:tbl>`;
    bodyXml += tblXml;
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  zip.file('word/document.xml', documentXml);

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeHtml(str: string): string {
  return escapeXml(str);
}

/**
 * Builds OpenDocument Text (ODT) ZIP package containing structured content
 */
async function generateOdtFromHwp(doc: HwpDocument, title: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`
  );

  let contentBody = `<text:h text:outline-level="1">${escapeXml(title)}</text:h>\n`;
  doc.paragraphs.forEach((p) => {
    if (p.isHeading) {
      contentBody += `<text:h text:outline-level="2">${escapeXml(p.text)}</text:h>\n`;
    } else {
      contentBody += `<text:p>${escapeXml(p.text)}</text:p>\n`;
    }
  });

  doc.tables.forEach((t) => {
    contentBody += `<table:table table:name="Table">\n`;
    t.rows.forEach((row) => {
      contentBody += `  <table:table-row>\n`;
      row.forEach((cell) => {
        contentBody += `    <table:table-cell office:value-type="string"><text:p>${escapeXml(cell)}</text:p></table:table-cell>\n`;
      });
      contentBody += `  </table:table-row>\n`;
    });
    contentBody += `</table:table>\n`;
  });

  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
  <office:body>
    <office:text>
      ${contentBody}
    </office:text>
  </office:body>
</office:document-content>`;

  zip.file('content.xml', contentXml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Builds Open Packaging Convention XPS package
 */
async function generateXpsFromHwp(doc: HwpDocument, title: string): Promise<Buffer> {
  const lines = doc.paragraphs.map((p) => p.text).filter(Boolean);
  // Table rows follow the paragraphs, one line per row with its cells separated by a tab.
  for (const table of doc.tables) {
    for (const row of table.rows) lines.push(row.join('\t'));
  }
  return buildOpenXpsPackage([{ title, lines }], title);
}

/**
 * Rasterizes an HWP document into PNG, JPEG, WEBP or BMP: the SVG page of renderHwpToSvg, which holds every
 * paragraph and table row, drawn at its own pixel size.
 */
async function renderHwpToRaster(
  doc: HwpDocument,
  tgt: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const svg = await renderHwpToSvg(doc);
  const pipeline = sharp(Buffer.from(svg, 'utf-8'));

  switch (tgt) {
    case 'jpg':
    case 'jpeg': {
      const buffer = await pipeline.jpeg({ quality: 90 }).toBuffer();
      return { buffer, mimeType: 'image/jpeg' };
    }
    case 'webp': {
      const buffer = await pipeline.webp().toBuffer();
      return { buffer, mimeType: 'image/webp' };
    }
    case 'bmp': {
      const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const buffer = encodeBmp(data, info.width, info.height, info.channels);
      return { buffer, mimeType: 'image/bmp' };
    }
    case 'png':
    default: {
      const buffer = await pipeline.png().toBuffer();
      return { buffer, mimeType: 'image/png' };
    }
  }
}
