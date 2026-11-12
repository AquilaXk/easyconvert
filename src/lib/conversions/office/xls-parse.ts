import { EncryptedOfficeDocumentError, LegacyOfficeFormatError } from './legacy-office-errors';
import { XLS_MAX_CELL_TEXT_CHARS_ENV, XLS_MAX_GRID_CELLS_ENV, XLS_MAX_PDF_TEXT_CELLS_ENV, xlsMaxCellTextChars, xlsMaxGridCells, xlsMaxPdfTextCells } from './spreadsheet-limits';
import { ConversionFailedError, PayloadLimitError } from '../../types';
import { getMaxInMemoryBytes } from '../../storage/errors';
import { readBiffCellRecord, type BiffCellContext } from './biff-cell-records';
import { isCfbfContainer, parseCfbf, type CfbfContainer } from '../cfbf-reader';
import { readCfbContainer } from './cfb-streams';
import { formatCsvCell } from './spreadsheet-ranges';
import { type OfficeWorksheet } from './types';

/** FilePass record ([MS-XLS] 2.4.117): present in the workbook globals of an XOR-obfuscated or RC4-encrypted workbook. */
const BIFF_RECORD_FILEPASS = 0x002f;

/** Index of the last column (IV) of a BIFF sheet: 256 columns. Rows are a 16-bit field, so their 65536 are bounded by the record itself. */
const BIFF_MAX_COLUMN_INDEX = 255;

/** EOF record: ends the workbook globals and each sheet substream. */
const BIFF_RECORD_EOF = 0x000a;

/** Record ids of the BOF that starts a BIFF stream: BIFF8 and BIFF5, BIFF4, BIFF3, BIFF2. */
export const BIFF_BOF_RECORDS: ReadonlySet<number> = new Set([0x0809, 0x0409, 0x0209, 0x0009]);

/** Bytes of the SST record before its first string: the total and the unique string counts ([MS-XLS] 2.4.265). */
/** BOF version word of a BIFF8 stream. */
const BIFF8_BOF_VERSION = 0x0600;

const SST_HEADER_BYTES = 8;

/** Bytes of an XLUnicodeRichExtendedString before its characters: character count and option flags. */
const SST_STRING_HEADER_BYTES = 3;

const SST_FLAG_UTF16 = 0x01;

const SST_FLAG_PHONETIC = 0x04;

const SST_FLAG_RICH = 0x08;

const SST_RICH_RUN_BYTES = 4;

/**
 * Reads the strings of a BIFF8 shared string table from the bodies of the SST record and the CONTINUE records
 * after it ([MS-XLS] 2.4.265, 2.5.293). A string whose characters run across a record boundary starts the
 * continuation with a flag byte that gives the character width of the rest; formatting runs and phonetic data are
 * skipped across boundaries without one. A table that ends inside a string is refused.
 */
function readBiff8SharedStrings(chunks: readonly Buffer[]): string[] {
  const truncated = (): LegacyOfficeFormatError =>
    new LegacyOfficeFormatError('Corrupt XLS: the shared string table ends inside a string.');
  const strings: string[] = [];
  if (chunks[0].length < SST_HEADER_BYTES) return strings;
  const uniqueStrings = chunks[0].readUInt32LE(4);
  let chunkIndex = 0;
  let offset = SST_HEADER_BYTES;

  const hasMore = (): boolean => {
    while (chunkIndex < chunks.length && offset >= chunks[chunkIndex].length) {
      chunkIndex++;
      offset = 0;
    }
    return chunkIndex < chunks.length;
  };
  const readBytes = (count: number): Buffer => {
    const parts: Buffer[] = [];
    let needed = count;
    while (needed > 0) {
      if (!hasMore()) throw truncated();
      const take = Math.min(needed, chunks[chunkIndex].length - offset);
      parts.push(chunks[chunkIndex].subarray(offset, offset + take));
      offset += take;
      needed -= take;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  };
  const skipBytes = (count: number): void => {
    let needed = count;
    while (needed > 0) {
      if (!hasMore()) throw truncated();
      const take = Math.min(needed, chunks[chunkIndex].length - offset);
      offset += take;
      needed -= take;
    }
  };
  const readCharacters = (count: number, utf16: boolean): string => {
    let text = '';
    let remaining = count;
    let wide = utf16;
    while (remaining > 0) {
      if (offset >= chunks[chunkIndex].length) {
        chunkIndex++;
        if (chunkIndex >= chunks.length || chunks[chunkIndex].length === 0) throw truncated();
        wide = (chunks[chunkIndex][0] & SST_FLAG_UTF16) !== 0;
        offset = 1;
      }
      const width = wide ? 2 : 1;
      const available = Math.floor((chunks[chunkIndex].length - offset) / width);
      if (available === 0) throw truncated();
      const take = Math.min(remaining, available);
      text += chunks[chunkIndex].toString(wide ? 'utf16le' : 'latin1', offset, offset + take * width);
      offset += take * width;
      remaining -= take;
    }
    return text;
  };

  for (let i = 0; i < uniqueStrings && hasMore(); i++) {
    const header = readBytes(SST_STRING_HEADER_BYTES);
    const flags = header[2];
    const richRuns = (flags & SST_FLAG_RICH) !== 0 ? readBytes(2).readUInt16LE(0) : 0;
    const phoneticBytes = (flags & SST_FLAG_PHONETIC) !== 0 ? readBytes(4).readUInt32LE(0) : 0;
    strings.push(readCharacters(header.readUInt16LE(0), (flags & SST_FLAG_UTF16) !== 0));
    skipBytes(richRuns * SST_RICH_RUN_BYTES);
    skipBytes(phoneticBytes);
  }
  return strings;
}

/**
 * The cells of one legacy spreadsheet, row by row. A sheet read from a BIFF stream keeps only the cells that were
 * written: its used range can be 65536 rows by 256 columns for a single cell, which the text targets write one
 * row at a time and only the grid-building targets (`toRows`) expand, under a limit.
 */
export interface XlsSheet {
  readonly rowCount: number;
  /** The cells of one row; a blank row of a sparse sheet is one shared array, not to be changed. */
  row(index: number): readonly string[];
  /** The whole grid as arrays; a sparse sheet refuses a grid over the limit with HTTP 413. */
  toRows(limit?: GridLimit): string[][];
}

/** A cap on what a dense grid holds (every cell of the used range, or only the cells with text) and the setting that names it. */
interface GridLimit {
  readonly counts: 'grid' | 'text';
  readonly cells: () => number;
  readonly setting: string;
}

export const GRID_LIMIT: GridLimit = { counts: 'grid', cells: xlsMaxGridCells, setting: XLS_MAX_GRID_CELLS_ENV };

export const PDF_TEXT_LIMIT: GridLimit = { counts: 'text', cells: xlsMaxPdfTextCells, setting: XLS_MAX_PDF_TEXT_CELLS_ENV };

function sparseXlsSheet(cells: ReadonlyMap<number, ReadonlyMap<number, string>>, rowCount: number, columnCount: number): XlsSheet {
  const blankRow: readonly string[] = new Array<string>(columnCount).fill('');
  const buildRow = (index: number): string[] => {
    const row = new Array<string>(columnCount).fill('');
    for (const [column, value] of cells.get(index) ?? []) row[column] = value;
    return row;
  };
  return {
    rowCount,
    row: (index) => (cells.has(index) ? buildRow(index) : blankRow),
    toRows: (limit = GRID_LIMIT) => {
      const maxChars = xlsMaxCellTextChars();
      let expandedChars = 0;
      for (const rowCells of cells.values()) {
        for (const value of rowCells.values()) expandedChars += value.length;
      }
      if (expandedChars > maxChars) {
        throw new PayloadLimitError(`The XLS cells expand to more than ${maxChars} characters (${XLS_MAX_CELL_TEXT_CHARS_ENV}).`);
      }
      const maxCells = limit.cells();
      if (limit.counts === 'grid' && rowCount * columnCount > maxCells) {
        throw new PayloadLimitError(
          `The XLS sheet spans ${rowCount} rows by ${columnCount} columns (${rowCount * columnCount} cells); at most ${maxCells} are supported (${limit.setting}).`
        );
      }
      if (limit.counts === 'text') {
        let textCells = 0;
        for (const rowCells of cells.values()) {
          for (const value of rowCells.values()) if (value) textCells++;
        }
        if (textCells > maxCells) {
          throw new PayloadLimitError(`The XLS sheet holds ${textCells} cells with text; at most ${maxCells} are supported (${limit.setting}).`);
        }
      }
      return Array.from({ length: rowCount }, (_, index) => buildRow(index));
    },
  };
}

export function denseXlsSheet(rows: string[][]): XlsSheet {
  return { rowCount: rows.length, row: (index) => rows[index], toRows: () => rows };
}

/** Characters gathered before they are encoded into a byte chunk. */
const XLS_TEXT_CHUNK_CHARS = 1 << 20;

interface XlsTextLayout {
  /** The whole text of a sheet without a row. */
  readonly empty: string;
  readonly head: string;
  readonly rowSeparator: string;
  readonly tail: string;
  renderRow(cells: readonly string[]): string;
}

/**
 * Writes a sheet as text one row at a time, never holding the grid: the output is gathered as encoded chunks and
 * refused with HTTP 413 once it passes the in-memory limit that the result buffer is held to.
 */
export function encodeXlsSheetText(sheet: XlsSheet, layout: XlsTextLayout, target: string): Buffer {
  const limit = getMaxInMemoryBytes();
  const chunks: Buffer[] = [];
  let pending: string[] = [];
  let pendingChars = 0;
  let encodedBytes = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    const chunk = Buffer.from(pending.join(''), 'utf-8');
    encodedBytes += chunk.length;
    if (encodedBytes > limit) throw new PayloadLimitError(`The XLS sheet converts to more than ${limit} bytes of .${target} output.`);
    chunks.push(chunk);
    pending = [];
    pendingChars = 0;
  };
  const write = (text: string): void => {
    pending.push(text);
    pendingChars += text.length;
    if (pendingChars >= XLS_TEXT_CHUNK_CHARS) flush();
  };

  write(sheet.rowCount === 0 ? layout.empty : layout.head);
  let previousCells: readonly string[] | undefined;
  let previousText = '';
  for (let index = 0; index < sheet.rowCount; index++) {
    const cells = sheet.row(index);
    // Blank rows of a sparse sheet are one array: their text is rendered once.
    if (cells !== previousCells) {
      previousText = layout.renderRow(cells);
      previousCells = cells;
    }
    if (index > 0) write(layout.rowSeparator);
    write(previousText);
  }
  if (sheet.rowCount > 0) write(layout.tail);
  flush();
  return Buffer.concat(chunks, encodedBytes);
}

export const delimitedLayout = (delimiter: string): XlsTextLayout => ({
  empty: '',
  head: '',
  rowSeparator: '\n',
  tail: '',
  renderRow: (cells) => cells.map((cell) => formatCsvCell(cell, delimiter)).join(delimiter),
});

/** The layout of `JSON.stringify(rows, null, 2)` for an array of non-empty rows of strings. */
export const JSON_ROWS_LAYOUT: XlsTextLayout = {
  empty: '[]',
  head: '[\n',
  rowSeparator: ',\n',
  tail: '\n]',
  renderRow: (cells) => `  [\n${cells.map((cell) => `    ${JSON.stringify(cell)}`).join(',\n')}\n  ]`,
};

/**
 * Authentic BIFF8 Binary Spreadsheet Stream Parser
 * Parses BOF, SST, LABELSST, LABEL, NUMBER, RK, MULRK, FORMULA, STRING records.
 */
export function parseBiff8Workbook(stream: Buffer): string[][] {
  return readBiff8Sheet(stream).toRows();
}

/** The sheet of a stream that is not a BIFF workbook: no rows. */
const EMPTY_XLS_SHEET: XlsSheet = { rowCount: 0, row: () => [], toRows: () => [] };

const BIFF_RECORD_BOUNDSHEET = 0x0085;

const BIFF_RECORD_COLINFO = 0x007d;

const BIFF_COLUMN_WIDTH_UNITS_PER_CHARACTER = 256;

/** Points a column of one character is drawn at, as for the columns of an XLSX sheet. */
const POINTS_PER_COLUMN_CHARACTER = 7.5;

const BIFF_SUBSTREAM_GLOBALS = 0x0005;

/**
 * The BOF substream types that are not worksheets: Visual Basic module, chart, macro sheet ([MS-XLS] 2.4.21) and the BIFF4
 * workspace. Any other type is read as a worksheet, as the office suite's Excel import does for a type it does not know
 * (`ImportExcel::Bof5`, `sc/source/filter/excel/impop.cxx`).
 */
const BIFF_NON_WORKSHEET_SUBSTREAMS: ReadonlySet<number> = new Set([0x0006, 0x0020, 0x0040, 0x0100]);

/** The first byte of a formula result that is a string, kept in the STRING record after the FORMULA record. */
const BIFF_FORMULA_RESULT_STRING = 0;

/** A BOF of BIFF2 to BIFF4 states no substream type before its type word; the stream is one worksheet. */
const BIFF_BOF_TYPE_OFFSET = 2;

/** The cells one worksheet substream wrote. */
export interface BiffWorksheet {
  /** Name from the BOUNDSHEET record of the worksheet; absent for a stream that has none. */
  name?: string;
  readonly cells: Map<number, Map<number, string>>;
  maxRow: number;
  maxCol: number;
  /** Width in points of each column the COLINFO records give one for. */
  readonly columnWidths: number[];
}

/** A BOUNDSHEET name: [MS-XLS] 2.4.28 (BIFF8: character count, flag byte, characters) or the BIFF5 byte string. */
function boundSheetName(data: Buffer, hasTextFlags: boolean): string | undefined {
  if (data.length < 8) return undefined;
  const count = data[6];
  if (!hasTextFlags) return data.toString('latin1', 7, Math.min(data.length, 7 + count));
  const wide = (data[7] & SST_FLAG_UTF16) !== 0;
  return wide ? data.toString('utf16le', 8, Math.min(data.length, 8 + count * 2)) : data.toString('latin1', 8, Math.min(data.length, 8 + count));
}

/**
 * Reads the cells of a BIFF stream, one list entry per worksheet substream (`BOF` with the worksheet type until its `EOF`).
 * The substreams of charts and macro sheets hold no cells and the globals substream holds none either. A stream whose cells
 * come outside any worksheet substream (a hand-written or truncated one) keeps them in one worksheet of their own.
 * The grid of the used range is never built here: a sheet whose only cell sits at IV65536 would need 16.7 million entries.
 */
export function readBiff8Worksheets(stream: Buffer): BiffWorksheet[] {
  if (stream.length < 4) return [];

  const firstRec = stream.readUInt16LE(0);
  if (firstRec !== 0x0809 && firstRec !== 0x0409 && firstRec !== 0x0209 && firstRec !== 0x0009) {
    return [];
  }

  // BOF record id and version word ([MS-XLS] 2.4.21): only a BIFF8 BOF (id 0x0809, version 0x0600) writes text with option
  // flags; BIFF5 (id 0x0809, version 0x0500) and BIFF2 to BIFF4 (ids 0x0009, 0x0209, 0x0409) write it without.
  const hasTextFlags = firstRec === 0x0809 && stream.length >= 6 && stream.readUInt16LE(4) >= BIFF8_BOF_VERSION;

  const sst: string[] = [];
  const worksheets: BiffWorksheet[] = [];
  /** Names by the stream position of the substream they belong to (lbPlyPos), and in the order the workbook lists them. */
  const namesByPosition = new Map<number, string>();
  const namesInOrder: string[] = [];
  let worksheetsStarted = 0;
  /** What each open substream is: a worksheet, or anything else (globals, chart, macro sheet, VB module). */
  const substreams: Array<'worksheet' | 'globals' | 'other'> = [];
  let implicitWorksheet: BiffWorksheet | undefined;
  /** The formula cell whose string result the STRING record after it carries. */
  let lastFormulaCell: { r: number; c: number } | null = null;

  /** The worksheet that cells are written to now; undefined inside a chart or macro substream. */
  const activeWorksheet = (): BiffWorksheet | undefined => {
    const kind = substreams[substreams.length - 1];
    if (kind === 'worksheet') return worksheets[worksheets.length - 1];
    if (kind === 'other') return undefined;
    if (implicitWorksheet === undefined) {
      implicitWorksheet = { cells: new Map(), maxRow: -1, maxCol: -1, columnWidths: [] };
      worksheets.push(implicitWorksheet);
    }
    return implicitWorksheet;
  };

  const setCell = (r: number, c: number, val: string): void => {
    if (c > BIFF_MAX_COLUMN_INDEX) {
      throw new LegacyOfficeFormatError(`Corrupt XLS: a cell lies in column ${c}, past the last column (${BIFF_MAX_COLUMN_INDEX}) of a BIFF sheet.`);
    }
    const sheet = activeWorksheet();
    if (sheet === undefined) return;
    if (!sheet.cells.has(r)) sheet.cells.set(r, new Map());
    sheet.cells.get(r)!.set(c, val);
    if (r > sheet.maxRow) sheet.maxRow = r;
    if (c > sheet.maxCol) sheet.maxCol = c;
  };
  const cellContext: BiffCellContext = { hasTextFlags, sst };

  let pos = 0;
  while (pos + 4 <= stream.length) {
    const recordStart = pos;
    const recId = stream.readUInt16LE(pos);
    const recLen = stream.readUInt16LE(pos + 2);
    pos += 4;
    if (pos + recLen > stream.length) break;
    const data = stream.subarray(pos, pos + recLen);
    pos += recLen;

    if (BIFF_BOF_RECORDS.has(recId)) {
      const type = data.length >= BIFF_BOF_TYPE_OFFSET + 2 ? data.readUInt16LE(BIFF_BOF_TYPE_OFFSET) : undefined;
      lastFormulaCell = null;
      if (type === BIFF_SUBSTREAM_GLOBALS) {
        substreams.push('globals');
      } else if (type === undefined || !BIFF_NON_WORKSHEET_SUBSTREAMS.has(type)) {
        // A worksheet takes the name of its BOUNDSHEET: matched by position, else by order.
        const name = namesByPosition.get(recordStart) ?? namesInOrder[worksheetsStarted];
        worksheetsStarted++;
        worksheets.push({ name, cells: new Map(), maxRow: -1, maxCol: -1, columnWidths: [] });
        substreams.push('worksheet');
      } else {
        substreams.push('other');
      }
      continue;
    }
    if (recId === BIFF_RECORD_EOF) {
      substreams.pop();
      lastFormulaCell = null;
      continue;
    }
    if (recId === BIFF_RECORD_COLINFO && data.length >= 6) {
      // [MS-XLS] 2.4.48: the first and last column, then the width in 1/256 of the width of a character.
      const sheet = activeWorksheet();
      const last = Math.min(data.readUInt16LE(2), BIFF_MAX_COLUMN_INDEX);
      if (sheet !== undefined) {
        const points = Math.round((data.readUInt16LE(4) / BIFF_COLUMN_WIDTH_UNITS_PER_CHARACTER) * POINTS_PER_COLUMN_CHARACTER);
        for (let column = data.readUInt16LE(0); column <= last; column++) sheet.columnWidths[column] = points;
      }
      continue;
    }
    if (recId === BIFF_RECORD_BOUNDSHEET && data.length >= 4) {
      const name = boundSheetName(data, hasTextFlags) ?? '';
      namesByPosition.set(data.readUInt32LE(0), name);
      namesInOrder.push(name);
      continue;
    }

    // 0x002F: FILEPASS. Every record after it is obfuscated or encrypted, so reading it as cells yields garbage.
    if (recId === BIFF_RECORD_FILEPASS) {
      throw new EncryptedOfficeDocumentError('The XLS workbook is encrypted or password protected, so its cells cannot be read.');
    }

    // 0x00FC: SST (Shared String Table), followed by the CONTINUE records that carry the rest of its strings
    if (recId === 0x00FC) {
      const sstChunks: Buffer[] = [data];
      let peekPos = pos;
      while (peekPos + 4 <= stream.length) {
        const nextId = stream.readUInt16LE(peekPos);
        const nextLen = stream.readUInt16LE(peekPos + 2);
        if (nextId === 0x003C && peekPos + 4 + nextLen <= stream.length) {
          sstChunks.push(stream.subarray(peekPos + 4, peekPos + 4 + nextLen));
          peekPos += 4 + nextLen;
          pos = peekPos;
        } else {
          break;
        }
      }
      sst.push(...readBiff8SharedStrings(sstChunks));
    }

    if (readBiffCellRecord(recId, data, cellContext, setCell)) continue;

    // 0x0006: FORMULA
    if (recId === 0x0006 && data.length >= 14) {
      const r = data.readUInt16LE(0);
      const c = data.readUInt16LE(2);
      lastFormulaCell = null;
      if (data[12] === 0xff && data[13] === 0xff) {
        // A result of 0xFFFF in its last two bytes is no number: its first byte says what it is (xlrd `sheet.py` 929-996).
        const fType = data[6];
        if (fType === BIFF_FORMULA_RESULT_STRING) lastFormulaCell = { r, c };
        else if (fType === 1) setCell(r, c, data[8] === 1 ? 'TRUE' : 'FALSE');
        else if (fType === 2) setCell(r, c, '#ERR!');
      } else {
        const num = data.readDoubleLE(6);
        setCell(r, c, String(num));
      }
    }

    // 0x0207: STRING, the cached result of the string formula before it
    else if (recId === 0x0207 && lastFormulaCell && data.length >= 3) {
      const len = data.readUInt16LE(0);
      const flags = hasTextFlags ? data.readUInt8(2) : 0;
      const textStart = hasTextFlags ? 3 : 2;
      const isUnicode = (flags & 0x01) !== 0;
      let str = '';
      if (isUnicode) {
        str = data.toString('utf16le', textStart, Math.min(data.length, textStart + len * 2));
      } else {
        str = data.toString('latin1', textStart, Math.min(data.length, textStart + len));
      }
      setCell(lastFormulaCell.r, lastFormulaCell.c, str);
      lastFormulaCell = null;
    }
  }

  return worksheets.filter((sheet) => sheet.maxRow >= 0 && sheet.maxCol >= 0);
}

/** The sheet of one worksheet's cells; rows after the last one that holds text are not part of it. */
function sheetOfCells(cells: ReadonlyMap<number, ReadonlyMap<number, string>>, maxCol: number): XlsSheet {
  let rowCount = 0;
  for (const [r, rowMap] of cells) {
    if (r < rowCount) continue;
    for (const value of rowMap.values()) {
      if (value) {
        rowCount = r + 1;
        break;
      }
    }
  }
  return sparseXlsSheet(cells, rowCount, maxCol + 1);
}

/** The worksheets, each as its own sheet with its name and column widths. */
export function namedSheetsOf(worksheets: readonly BiffWorksheet[]): Array<{ name: string; sheet: XlsSheet; columnWidths: number[] }> {
  return worksheets.map((worksheet, index) => ({
    name: worksheet.name || `Sheet${index + 1}`,
    sheet: sheetOfCells(worksheet.cells, worksheet.maxCol),
    columnWidths: worksheet.columnWidths,
  }));
}

/**
 * The cells of every worksheet laid over each other in one sparse sheet, as the text targets have always written them.
 * The PDF target keeps the worksheets apart (namedSheetsOf).
 */
export function mergedSheetOf(worksheets: readonly BiffWorksheet[]): XlsSheet {
  if (worksheets.length === 0) return EMPTY_XLS_SHEET;
  if (worksheets.length === 1) return sheetOfCells(worksheets[0].cells, worksheets[0].maxCol);
  const cells = new Map<number, Map<number, string>>();
  let maxCol = -1;
  for (const worksheet of worksheets) {
    for (const [r, rowMap] of worksheet.cells) {
      const merged = cells.get(r) ?? new Map<number, string>();
      cells.set(r, merged);
      for (const [c, value] of rowMap) merged.set(c, value);
    }
    maxCol = Math.max(maxCol, worksheet.maxCol);
  }
  return sheetOfCells(cells, maxCol);
}

/**
 * True when the stream is a BIFF workbook that ends where it should: it starts with a BOF and every substream it opens is closed
 * by its EOF. xlrd reads a sheet record by record up to its EOF and fails on a stream that ends before it (`sheet.py`, `read`;
 * `book.py`, `get_record_parts`); bytes after the last EOF are not read. The records are only walked, no cell is decoded.
 */
function biffStreamIsComplete(stream: Buffer): boolean {
  if (stream.length < 4 || !BIFF_BOF_RECORDS.has(stream.readUInt16LE(0))) return false;
  let openSubstreams = 0;
  let pos = 0;
  while (pos + 4 <= stream.length) {
    const recId = stream.readUInt16LE(pos);
    const next = pos + 4 + stream.readUInt16LE(pos + 2);
    if (next > stream.length) break;
    if (BIFF_BOF_RECORDS.has(recId)) openSubstreams++;
    else if (recId === BIFF_RECORD_EOF) {
      if (openSubstreams === 0) return false;
      openSubstreams--;
    }
    pos = next;
  }
  return openSubstreams === 0;
}

/**
 * A BIFF stream whose sheets hold no cell is a workbook without data and converts to the empty output of each target, when it is a
 * whole workbook. One that is cut short or starts with something else is damaged, and is refused rather than answered with nothing.
 */
export function assertCellsOrCompleteWorkbook(stream: Buffer, worksheets: readonly BiffWorksheet[]): void {
  if (mergedSheetOf(worksheets).rowCount === 0 && !biffStreamIsComplete(stream)) {
    throw new ConversionFailedError(
      'Corrupt XLS: The BIFF stream holds no cell records and is not a complete workbook (it lacks a BOF at its start or an EOF, or a record is cut short).'
    );
  }
}

/** The workbook stream of a CFBF container: the BIFF8 `Workbook` of an Excel 97-2003 or Kingsoft file, or else the `Book` of an older one. */
export function selectWorkbookStream(cfbf: CfbfContainer): Buffer | undefined {
  // A file saved by Excel 97 or later for old readers keeps a BIFF5 `Book` next to the BIFF8 `Workbook`; the newer one wins.
  let workbookStream: Buffer | undefined;
  let bookStream: Buffer | undefined;
  for (const [name, buf] of cfbf.streams.entries()) {
    const lowerName = name.toLowerCase();
    if (lowerName === 'workbook') workbookStream ??= buf;
    else if (lowerName === 'book') bookStream ??= buf;
  }
  return workbookStream ?? bookStream;
}

/** The worksheets of the BIFF workbook stream inside a CFBF container. */
export function readCfbfWorkbookSheets(inputBuffer: Buffer): BiffWorksheet[] {
  const workbookStream = selectWorkbookStream(parseCfbf(inputBuffer));
  if (!workbookStream) {
    throw new ConversionFailedError('Corrupt XLS: Workbook stream not found in CFBF container');
  }
  const worksheets = readBiff8Worksheets(workbookStream);
  assertCellsOrCompleteWorkbook(workbookStream, worksheets);
  return worksheets;
}

/** The sheet of the BIFF workbook stream inside a CFBF container. */
export function readCfbfWorkbookSheet(inputBuffer: Buffer): XlsSheet {
  return mergedSheetOf(readCfbfWorkbookSheets(inputBuffer));
}

function readBiff8Sheet(stream: Buffer): XlsSheet {
  return mergedSheetOf(readBiff8Worksheets(stream));
}

/** True when the record after the BOF of a BIFF stream's globals is a FilePass: the workbook is password protected or obfuscated. */
function biffGlobalsHaveFilePass(stream: Buffer): boolean {
  let pos = 0;
  while (pos + 4 <= stream.length) {
    const recId = stream.readUInt16LE(pos);
    if (recId === BIFF_RECORD_FILEPASS) return true;
    if (recId === BIFF_RECORD_EOF) return false;
    pos += 4 + stream.readUInt16LE(pos + 2);
  }
  return false;
}

/**
 * Whether the workbook of an XLS carries a FilePass record: it is obfuscated or encrypted. The office suite decrypts a workbook that
 * uses its default password and cannot load one that needs another, which it reports like a damaged file; this tells the two
 * apart afterwards. A file this cannot read as a BIFF workbook is not encrypted as far as this can tell, and a compound file is
 * opened as the legacy readers open one, so a file past their size limit is not walked.
 */
export function xlsHasFilePass(inputBuffer: Buffer): boolean {
  let stream: Buffer | undefined = inputBuffer;
  if (isCfbfContainer(inputBuffer)) {
    try {
      stream = selectWorkbookStream(readCfbContainer(inputBuffer, 'XLS'));
    } catch {
      return false;
    }
  }
  return stream !== undefined && stream.length >= 4 && BIFF_BOF_RECORDS.has(stream.readUInt16LE(0)) && biffGlobalsHaveFilePass(stream);
}

/**
 * The cells of a worksheet that a PDF page can show: columns without any text are left out, rows without any text are kept
 * as one blank row between rows that have text (a run of them collapses to one) and are dropped before the first and after the
 * last. A sheet whose only cell is at IV65536 would otherwise be 65535 blank rows long. No text is lost.
 */
export function compactWorksheetForPdf(name: string, rows: string[][], columnWidths: readonly number[]): OfficeWorksheet {
  const usedColumns = new Set<number>();
  for (const row of rows) row.forEach((text, column) => text !== '' && usedColumns.add(column));
  const used = [...usedColumns].sort((a, b) => a - b);
  const compact: string[][] = [];
  let pendingBlank = false;
  for (const row of rows) {
    if (row.every((text) => text === '')) {
      pendingBlank = compact.length > 0;
      continue;
    }
    if (pendingBlank) compact.push(used.map(() => ''));
    pendingBlank = false;
    compact.push(used.map((column) => row[column] ?? ''));
  }
  return { name, rows: compact, columnWidths: used.map((column) => columnWidths[column]) };
}
