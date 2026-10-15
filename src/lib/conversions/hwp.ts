import zlib from 'node:zlib';
import JSZip from 'jszip';
import sharp from 'sharp';
import { ConversionFailedError, ConversionOptions, ConversionResult, CorruptStreamError, EncryptedOfficeDocumentError } from '../types';
import { InflateBudget, inflateBounded } from './bounded-inflate';
import { encodeBmp } from './image';
import { buildOpenXpsPackage } from './openxps';
import { renderHwpToSvg } from './hwp-render';
import { buildCfbfContainer } from './cfbf-writer';
import { readHwpSections } from './hwp-reader';
import { renderModelTarget } from './document-targets';
import { BlockSink, DocumentContext, assembleDocument, type TableDraftCell } from './document-model/build';
import type { DocumentModel } from './document-model/model';
import { textRun } from './document-model/support';
import { HWP_TAGS, HWP_UTF16_UNIT_BYTES, buildHwpRecord, decodeHwpText, parseHwpRecords, type HwpRecord } from './hwp-records';
import { HWP_EQ_GREEK, HWP_EQ_SYMBOLS, hwpEquationToLaTeX, hwpEquationToMathML } from './hwp-equation';

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

/** Heading level the flat paragraph list gives a heading paragraph. */
const LEGACY_HEADING_LEVEL = 2;

export interface HwpDocument {
  version: string;
  isCompressed: boolean;
  isEncrypted: boolean;
  isDistributed: boolean;
  paragraphs: HwpParagraph[];
  tables: HwpTable[];
  equations?: HwpEquation[];
  /** The document in reading order with headings, lists, tables with merged cells, pictures, links and notes. */
  model: DocumentModel;
  metadata: {
    title?: string;
    author?: string;
    creator?: string;
    date?: string;
  };
}

/** A flat paragraph and table list as a document model: paragraphs first, then the tables (no position is known). */
export function legacyHwpModel(paragraphs: readonly HwpParagraph[], tables: readonly HwpTable[]): DocumentModel {
  const context = new DocumentContext();
  const sink = new BlockSink(context);
  for (const paragraph of paragraphs) {
    if (paragraph.isHeading) sink.heading(LEGACY_HEADING_LEVEL, [textRun(paragraph.text)]);
    else sink.paragraph([textRun(paragraph.text)]);
  }
  for (const table of tables) {
    const rows: TableDraftCell[][] = table.rows.map((row) =>
      row.map((text) => {
        const blocks = new BlockSink(context);
        if (text !== '') blocks.paragraph([textRun(text)]);
        return { blocks: blocks.blocks, colSpan: 1, rowSpan: 1, header: false };
      })
    );
    sink.table({ rows, columnCount: table.colCount });
  }
  return assembleDocument({ sections: [{ columns: 1, blocks: sink.blocks }], context });
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

export { HWP_TAGS, buildHwpRecord, decodeHwpText, parseHwpRecords, type HwpRecord };
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
  const sectionRecords = sectionBuffers.map((buffer) => parseHwpRecords(buffer));
  const docInfoStream = cfbf.paths.get('DocInfo');
  const docInfoRecords = docInfoStream ? parseHwpRecords(isCompressed ? decompressHwpStream(docInfoStream, inflateBudget, 'DocInfo') : docInfoStream) : [];
  const model = readHwpSections(docInfoRecords, sectionRecords, (streamName, compress) => {
    const stream = cfbf.paths.get(streamName);
    if (!stream) return undefined;
    return (compress ?? isCompressed) ? decompressHwpStream(stream, inflateBudget, streamName) : stream;
  });

  const paragraphs: HwpParagraph[] = [];
  const tables: HwpTable[] = [];
  const allEquations: HwpEquation[] = [];

  for (const records of sectionRecords) {
    const openTables: HwpTableState[] = [];
    const closeInnermost = (): void => {
      const closed = openTables.pop() as HwpTableState;
      closeHwpTable(closed, openTables[openTables.length - 1], tables);
    };

    for (const rec of records) {
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
    model,
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

/** Targets HWP documents are written to from the block model. */
const HWP_MODEL_TARGETS: ReadonlySet<string> = new Set(['txt', 'html', 'md', 'pdf', 'epub', 'docx', 'odt']);

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

  // Targets written from the document model keep headings, lists, merged cells, pictures, links and notes in order.
  if (HWP_MODEL_TARGETS.has(tgt)) return renderModelTarget(doc.model, tgt, options, baseName);

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

  // RTF
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

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeHtml(str: string): string {
  return escapeXml(str);
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
