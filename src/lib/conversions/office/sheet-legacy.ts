import { ConversionFailedError, EngineUnavailableError } from '../../types';
import { startsWithBytes } from '../package-access';
import { decodeTextInput } from '../text-input';
import { decodeWindows1252 } from './windows-1252';
import { assertReadableAsText } from './text-source-guard';
import {
  XLSX_MAX_COLUMNS,
  XLSX_MAX_MATERIALISED_CELLS,
  XLSX_MAX_ROWS,
  sheetLimitError,
} from './sheet-bounds';

/**
 * Bounded in-process decoders for legacy spreadsheet and tabular formats:
 * dBASE (.dbf), Data Interchange Format (.dif), Symbolic Link (.slk),
 * space-padded printer tables (.prn), and Lotus 1-2-3 (.wk1/.wks).
 */

const CFBF_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

const DBF_HEADER_BYTES = 32;
const DBF_DESCRIPTOR_BYTES = 32;
const DBF_HEADER_TERMINATOR = 0x0d;
const DBF_DELETED_MARKER = 0x2a;
const DBF_EOF_MARKER = 0x1a;
const DBF_VALID_VERSIONS: ReadonlySet<number> = new Set([
  0x02, 0x03, 0x04, 0x05, 0x30, 0x31, 0x32, 0x43, 0x63, 0x83, 0x8b, 0x8e, 0xcb, 0xe5, 0xf5, 0xfb,
]);
const FOXPRO_DBF_VERSIONS: ReadonlySet<number> = new Set([0x30, 0x31, 0x32, 0xf5, 0xfb]);

const LOTUS_BOF_OPCODE = 0x0000;
const LOTUS_EOF_OPCODE = 0x0001;
const LOTUS_INTEGER_OPCODE = 0x000d;
const LOTUS_NUMBER_OPCODE = 0x000e;
const LOTUS_LABEL_OPCODE = 0x000f;
const LOTUS_FORMULA_OPCODE = 0x0010;
const LOTUS_LABEL_PREFIXES = new Set(["'", '"', '^', '\\']);

export const LEGACY_SPREADSHEET_FORMATS: ReadonlySet<string> = new Set(['dbf', 'dif', 'slk', 'prn', 'wk1', 'wks']);

function assertGridDimensions(subject: string, rows: number, cols: number): void {
  if (rows > XLSX_MAX_ROWS) {
    throw sheetLimitError(subject, rows, 'rows', 'a worksheet', XLSX_MAX_ROWS);
  }
  if (cols > XLSX_MAX_COLUMNS) {
    throw sheetLimitError(subject, cols, 'columns', 'a worksheet', XLSX_MAX_COLUMNS);
  }
  if (rows > 0 && cols > 0 && rows * cols > XLSX_MAX_MATERIALISED_CELLS) {
    throw sheetLimitError(subject, rows * cols, 'cells', 'a worksheet', XLSX_MAX_MATERIALISED_CELLS);
  }
}

function decodeFieldBytes(slice: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(slice);
  } catch {
    return decodeWindows1252(slice);
  }
}

function formatFoxProCurrency(rawScaled: bigint): string {
  const negative = rawScaled < 0n;
  const abs = negative ? -rawScaled : rawScaled;
  const whole = abs / 10000n;
  const frac = (abs % 10000n).toString().padStart(4, '0').replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

function formatFoxProDateTime(julianDay: number, msSinceMidnight: number): string {
  if (julianDay === 0 && msSinceMidnight === 0) return '';
  // Julian Day 2440588 = 1970-01-01T00:00:00Z
  const unixMs = (julianDay - 2440588) * 86_400_000 + msSinceMidnight;
  const d = new Date(unixMs);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function decodeDbfCell(slice: Buffer, fieldType: string, isFoxPro: boolean): string {
  if (isFoxPro) {
    if (fieldType === 'I' && slice.length === 4) {
      return String(slice.readInt32LE(0));
    }
    if (fieldType === 'B' && slice.length === 8) {
      const val = slice.readDoubleLE(0);
      return Number.isFinite(val) ? String(val) : '';
    }
    if (fieldType === 'Y' && slice.length === 8) {
      return formatFoxProCurrency(slice.readBigInt64LE(0));
    }
    if (fieldType === 'T' && slice.length === 8) {
      return formatFoxProDateTime(slice.readInt32LE(0), slice.readInt32LE(4));
    }
  }
  return decodeFieldBytes(slice).replace(/\0+$/g, '').trim();
}

function parseDbfRows(input: Buffer): string[][] {
  if (input.length < DBF_HEADER_BYTES + 1) {
    throw new ConversionFailedError('Invalid DBF file: header is shorter than 33 bytes.');
  }
  const version = input[0];
  if (!DBF_VALID_VERSIONS.has(version)) {
    throw new ConversionFailedError(`Invalid DBF file: unrecognized dBASE version byte 0x${version.toString(16)}.`);
  }
  const isFoxPro = FOXPRO_DBF_VERSIONS.has(version);

  const recordCount = input.readUInt32LE(4);
  const headerBytes = input.readUInt16LE(8);
  const recordBytes = input.readUInt16LE(10);
  if (headerBytes < DBF_HEADER_BYTES + 1 || headerBytes > input.length || recordBytes < 2) {
    throw new ConversionFailedError('Invalid DBF file: malformed header or record length.');
  }

  const fields: { name: string; type: string; length: number; offset: number }[] = [];
  let cursor = DBF_HEADER_BYTES;
  let recOffset = 1; // byte 0 of each record is the deletion flag
  while (cursor < headerBytes && input[cursor] !== DBF_HEADER_TERMINATOR) {
    if (cursor + DBF_DESCRIPTOR_BYTES > headerBytes) break;
    const rawName = input.subarray(cursor, cursor + 11);
    const nul = rawName.indexOf(0);
    const name = decodeFieldBytes(nul >= 0 ? rawName.subarray(0, nul) : rawName).trim();
    const type = String.fromCharCode(input[cursor + 11]).toUpperCase();
    const length = input[cursor + 16];
    if (length === 0 || recOffset + length > recordBytes) {
      throw new ConversionFailedError(`Invalid DBF file: invalid field length for '${name || 'field'}'.`);
    }
    fields.push({ name: name || `COL_${fields.length + 1}`, type, length, offset: recOffset });
    recOffset += length;
    cursor += DBF_DESCRIPTOR_BYTES;
  }

  if (fields.length === 0) {
    throw new ConversionFailedError('Invalid DBF file: no column descriptors found.');
  }

  assertGridDimensions('The DBF table', recordCount + 1, fields.length);
  const maxAvailableRecords = Math.floor((input.length - headerBytes) / recordBytes);
  if (recordCount > maxAvailableRecords && input.length - headerBytes > 0) {
    // Allow missing trailing EOF byte when exact records fit, refuse wildly inflated record counts.
    if (recordCount - maxAvailableRecords > 1 || headerBytes + (recordCount - 1) * recordBytes > input.length) {
      throw new ConversionFailedError(
        `Invalid DBF file: header declares ${recordCount} records, but data contains at most ${maxAvailableRecords}.`
      );
    }
  }

  const rows: string[][] = [fields.map((f) => f.name)];
  const readableRecords = Math.min(recordCount, maxAvailableRecords);
  for (let i = 0; i < readableRecords; i += 1) {
    const start = headerBytes + i * recordBytes;
    if (input[start] === DBF_EOF_MARKER) break;
    if (input[start] === DBF_DELETED_MARKER) continue;
    rows.push(
      fields.map((field) => decodeDbfCell(input.subarray(start + field.offset, start + field.offset + field.length), field.type, isFoxPro))
    );
  }
  return rows;
}

const MAX_DIF_LINES = XLSX_MAX_MATERIALISED_CELLS * 2 + XLSX_MAX_ROWS * 2 + 1024;
const MAX_SYLK_RECORDS = XLSX_MAX_MATERIALISED_CELLS * 2 + 1024;

class TextLineReader {
  private pos = 0;
  private readonly hasCr: boolean;

  constructor(private readonly text: string) {
    this.hasCr = text.includes('\r');
  }

  next(): string | null {
    if (this.pos > this.text.length) return null;
    if (this.pos === this.text.length) {
      this.pos += 1;
      return '';
    }
    if (!this.hasCr) {
      const nl = this.text.indexOf('\n', this.pos);
      if (nl === -1) {
        const line = this.text.slice(this.pos);
        this.pos = this.text.length + 1;
        return line;
      }
      const line = this.text.slice(this.pos, nl);
      this.pos = nl + 1;
      return line;
    }
    let end = this.pos;
    while (end < this.text.length) {
      const ch = this.text.charCodeAt(end);
      if (ch === 0x0a || ch === 0x0d) break;
      end += 1;
    }
    const line = this.text.slice(this.pos, end);
    if (end < this.text.length) {
      this.pos = this.text.charCodeAt(end) === 0x0d && this.text.charCodeAt(end + 1) === 0x0a ? end + 2 : end + 1;
    } else {
      this.pos = this.text.length + 1;
    }
    return line;
  }
}

function unquoteDifString(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed;
}

function parseDifRows(input: Buffer): string[][] {
  assertReadableAsText(input, 'dif');
  const reader = new TextLineReader(decodeTextInput(input));
  let lineCount = 0;
  const readLine = (): string | null => {
    const line = reader.next();
    if (line !== null) {
      lineCount += 1;
      if (lineCount > MAX_DIF_LINES) {
        throw sheetLimitError('The DIF spreadsheet', lineCount, 'lines', 'a worksheet', MAX_DIF_LINES);
      }
    }
    return line;
  };

  let seenData = false;
  let declaredCols = 0;
  let declaredRows = 0;

  for (let line = readLine(); line !== null; line = readLine()) {
    const topic = line.trim().toUpperCase();
    if (!topic) continue;
    const tupleLine = (readLine() ?? '').trim();
    const parts = tupleLine.split(',');
    const countOrNum = Number.parseInt(parts[1] ?? '0', 10) || 0;
    readLine(); // consume header string value line

    if (topic === 'VECTORS') declaredCols = Math.max(declaredCols, countOrNum);
    else if (topic === 'TUPLES') declaredRows = Math.max(declaredRows, countOrNum);
    else if (topic === 'DATA') {
      seenData = true;
      break;
    }
  }

  if (!seenData) {
    throw new ConversionFailedError('Invalid DIF spreadsheet: missing DATA section.');
  }
  assertGridDimensions('The DIF spreadsheet', declaredRows, declaredCols);

  const rows: string[][] = [];
  let currentRow: string[] | null = null;
  let totalCells = 0;
  let maxCols = 0;

  for (let line = readLine(); line !== null; line = readLine()) {
    const tuple = line.trim();
    if (!tuple) continue;
    const comma = tuple.indexOf(',');
    if (comma <= 0) continue;
    const typeFlag = Number.parseInt(tuple.slice(0, comma).trim(), 10);
    const numPart = tuple.slice(comma + 1).trim();
    const valLine = readLine() ?? '';

    if (typeFlag === -1) {
      const marker = valLine.trim().toUpperCase();
      if (marker === 'BOT') {
        if (currentRow !== null) {
          assertGridDimensions('The DIF spreadsheet', rows.length + 1, maxCols);
          rows.push(currentRow);
        }
        currentRow = [];
      } else if (marker === 'EOD') {
        break;
      }
      continue;
    }

    if (currentRow === null) currentRow = [];
    let cell = '';
    if (typeFlag === 1) {
      cell = unquoteDifString(valLine);
    } else if (typeFlag === 0) {
      const indicator = valLine.trim().toUpperCase();
      cell = indicator === 'V' ? numPart : indicator;
    }
    currentRow.push(cell);
    if (currentRow.length > maxCols) maxCols = currentRow.length;
    assertGridDimensions('The DIF spreadsheet', rows.length + 1, maxCols);
    totalCells += 1;
    if (totalCells > XLSX_MAX_MATERIALISED_CELLS) {
      throw sheetLimitError('The DIF spreadsheet', totalCells, 'cells', 'a worksheet', XLSX_MAX_MATERIALISED_CELLS);
    }
  }
  if (currentRow !== null && currentRow.length > 0) {
    assertGridDimensions('The DIF spreadsheet', rows.length + 1, maxCols);
    rows.push(currentRow);
  }
  if (rows.length === 0) throw new ConversionFailedError('The DIF spreadsheet contains no data rows.');
  return rows;
}

function splitSylkFields(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
        current += ch;
      }
      continue;
    }
    if (ch === ';' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function decodeSylkValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed;
}

function materializeSparseCells(cells: Map<number, Map<number, string>>, maxRow: number, maxCol: number, label: string): string[][] {
  if (maxRow === 0 || maxCol === 0) {
    throw new ConversionFailedError(`The ${label} spreadsheet contains no cells.`);
  }
  assertGridDimensions(`The ${label} spreadsheet`, maxRow, maxCol);
  const grid: string[][] = [];
  for (let r = 1; r <= maxRow; r += 1) {
    const rowMap = cells.get(r);
    const row = new Array<string>(maxCol).fill('');
    if (rowMap) {
      for (const [c, val] of rowMap) row[c - 1] = val;
    }
    grid.push(row);
  }
  return grid;
}

function parseSylkRows(input: Buffer): string[][] {
  assertReadableAsText(input, 'slk');
  const reader = new TextLineReader(decodeTextInput(input));

  const cells = new Map<number, Map<number, string>>();
  let maxRow = 0;
  let maxCol = 0;
  let lastY = 1;
  let lastX = 1;
  let recordCount = 0;
  let cellCount = 0;
  let seenHeader = false;

  for (let rawLine = reader.next(); rawLine !== null; rawLine = reader.next()) {
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;
    if (!seenHeader) {
      if (!trimmed.startsWith('ID')) {
        throw new ConversionFailedError('Invalid SYLK spreadsheet: missing ID header record.');
      }
      seenHeader = true;
    }
    recordCount += 1;
    if (recordCount > MAX_SYLK_RECORDS) {
      throw sheetLimitError('The SYLK spreadsheet', recordCount, 'records', 'a worksheet', MAX_SYLK_RECORDS);
    }

    const fields = splitSylkFields(trimmed);
    const recType = fields[0];
    if (recType === 'E') break;
    if (recType === 'B') {
      let bRow = 0;
      let bCol = 0;
      for (let idx = 1; idx < fields.length; idx += 1) {
        const f = fields[idx];
        if (f.startsWith('Y')) bRow = Number.parseInt(f.slice(1), 10) || 0;
        else if (f.startsWith('X')) bCol = Number.parseInt(f.slice(1), 10) || 0;
      }
      assertGridDimensions('The SYLK spreadsheet', bRow, bCol);
      continue;
    }
    if (recType !== 'C') continue;

    cellCount += 1;
    if (cellCount > XLSX_MAX_MATERIALISED_CELLS) {
      throw sheetLimitError('The SYLK spreadsheet', cellCount, 'cells', 'a worksheet', XLSX_MAX_MATERIALISED_CELLS);
    }

    let y = lastY;
    let x = lastX;
    let value: string | undefined;
    for (let idx = 1; idx < fields.length; idx += 1) {
      const f = fields[idx];
      if (f.startsWith('Y')) y = Number.parseInt(f.slice(1), 10);
      else if (f.startsWith('X')) x = Number.parseInt(f.slice(1), 10);
      else if (f.startsWith('K')) value = decodeSylkValue(f.slice(1));
    }
    if (!Number.isInteger(y) || !Number.isInteger(x) || y < 1 || x < 1) {
      throw new ConversionFailedError('Invalid SYLK spreadsheet: invalid cell coordinate.');
    }
    lastY = y;
    lastX = x;
    maxRow = Math.max(maxRow, y);
    maxCol = Math.max(maxCol, x);
    assertGridDimensions('The SYLK spreadsheet', maxRow, maxCol);
    if (value !== undefined) {
      let rowMap = cells.get(y);
      if (!rowMap) {
        rowMap = new Map<number, string>();
        cells.set(y, rowMap);
      }
      rowMap.set(x, value);
    }
  }
  if (!seenHeader) {
    throw new ConversionFailedError('Invalid SYLK spreadsheet: missing ID header record.');
  }
  return materializeSparseCells(cells, maxRow, maxCol, 'SYLK');
}

const MAX_PRN_LINES = XLSX_MAX_ROWS * 4 + 1024;

function parsePrnRows(input: Buffer): string[][] {
  assertReadableAsText(input, 'prn');
  const reader = new TextLineReader(decodeTextInput(input));
  const rows: string[][] = [];
  const fallbackRows: string[][] = [];
  let maxMultiCols = 0;
  let maxFallbackCols = 0;
  let lineCount = 0;

  for (let rawLine = reader.next(); rawLine !== null; rawLine = reader.next()) {
    lineCount += 1;
    if (lineCount > MAX_PRN_LINES) {
      throw sheetLimitError('The PRN table', lineCount, 'lines', 'a worksheet', MAX_PRN_LINES);
    }
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;
    const nextRowCount = rows.length + 1;
    if (nextRowCount > XLSX_MAX_ROWS) {
      throw sheetLimitError('The PRN table', nextRowCount, 'rows', 'a worksheet', XLSX_MAX_ROWS);
    }
    const multiCells = trimmed.split(/\s{2,}|\t+/).map((cell) => cell.trim());
    maxMultiCols = Math.max(maxMultiCols, multiCells.length);
    assertGridDimensions('The PRN table', nextRowCount, maxMultiCols);
    rows.push(multiCells);

    if (maxMultiCols <= 1) {
      const singleCells = trimmed.split(/\s+/);
      maxFallbackCols = Math.max(maxFallbackCols, singleCells.length);
      assertGridDimensions('The PRN table', nextRowCount, maxFallbackCols);
      fallbackRows.push(singleCells);
    } else if (fallbackRows.length > 0) {
      fallbackRows.length = 0;
    }
  }
  if (rows.length === 0) throw new ConversionFailedError('The PRN file holds no data.');
  return maxMultiCols <= 1 ? fallbackRows : rows;
}

function readLotusNullTerminatedText(buf: Buffer): string {
  const end = buf.indexOf(0);
  const raw = end >= 0 ? buf.subarray(0, end) : buf;
  return decodeFieldBytes(raw);
}

function parseLotusRows(input: Buffer, format: string): string[][] {
  if (startsWithBytes(input, CFBF_HEADER)) {
    throw new EngineUnavailableError(
      'soffice',
      `.${format} compound spreadsheets are opened by LibreOffice Calc; the in-process engine has no reader for them.`
    );
  }
  if (input.length < 6) {
    throw new ConversionFailedError(`Invalid ${format.toUpperCase()} file: shorter than minimum Lotus BOF header.`);
  }
  const firstOpcode = input.readUInt16LE(0);
  const firstLen = input.readUInt16LE(2);
  if (firstOpcode !== LOTUS_BOF_OPCODE || firstLen !== 2) {
    throw new ConversionFailedError(`Invalid ${format.toUpperCase()} file: missing Lotus 1-2-3 BOF record.`);
  }

  const cells = new Map<number, Map<number, string>>();
  let maxRow = 0;
  let maxCol = 0;
  let offset = 0;
  let records = 0;

  while (offset + 4 <= input.length) {
    records += 1;
    if (records > XLSX_MAX_MATERIALISED_CELLS) {
      throw sheetLimitError(`The ${format.toUpperCase()} workbook`, records, 'records', 'a worksheet', XLSX_MAX_MATERIALISED_CELLS);
    }
    const opcode = input.readUInt16LE(offset);
    const len = input.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + len > input.length) {
      throw new ConversionFailedError(`Invalid ${format.toUpperCase()} file: truncated record payload.`);
    }
    const payload = input.subarray(offset, offset + len);
    offset += len;

    if (opcode === LOTUS_EOF_OPCODE) break;

    let col = -1;
    let row = -1;
    let val: string | undefined;

    if (opcode === LOTUS_INTEGER_OPCODE && payload.length >= 7) {
      col = payload.readUInt16LE(1);
      row = payload.readUInt16LE(3);
      val = String(payload.readInt16LE(5));
    } else if ((opcode === LOTUS_NUMBER_OPCODE || opcode === LOTUS_FORMULA_OPCODE) && payload.length >= 13) {
      col = payload.readUInt16LE(1);
      row = payload.readUInt16LE(3);
      const num = payload.readDoubleLE(5);
      val = Number.isFinite(num) ? String(num) : '';
    } else if (opcode === LOTUS_LABEL_OPCODE && payload.length >= 6) {
      col = payload.readUInt16LE(1);
      row = payload.readUInt16LE(3);
      const textStart = LOTUS_LABEL_PREFIXES.has(String.fromCharCode(payload[5])) ? 6 : 5;
      val = readLotusNullTerminatedText(payload.subarray(textStart));
    }

    if (col >= 0 && row >= 0 && val !== undefined) {
      const r1 = row + 1;
      const c1 = col + 1;
      maxRow = Math.max(maxRow, r1);
      maxCol = Math.max(maxCol, c1);
      assertGridDimensions(`The ${format.toUpperCase()} worksheet`, maxRow, maxCol);
      let rowMap = cells.get(r1);
      if (!rowMap) {
        rowMap = new Map<number, string>();
        cells.set(r1, rowMap);
      }
      rowMap.set(c1, val);
    }
  }
  return materializeSparseCells(cells, maxRow, maxCol, format.toUpperCase());
}

/** Reads legacy spreadsheet formats (DBF, DIF, SYLK, PRN, WK1, WKS) into a 2D row matrix. */
export function readLegacySpreadsheetRows(input: Buffer, format: string): string[][] {
  switch (format) {
    case 'dbf':
      return parseDbfRows(input);
    case 'dif':
      return parseDifRows(input);
    case 'slk':
      return parseSylkRows(input);
    case 'prn':
      return parsePrnRows(input);
    case 'wk1':
    case 'wks':
      return parseLotusRows(input, format);
    default:
      throw new ConversionFailedError(`Unsupported legacy spreadsheet format '.${format}'.`);
  }
}
