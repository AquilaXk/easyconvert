/**
 * The records of a BIFF worksheet that hold one value or one row of values, as the text each cell shows: shared and inline
 * strings, numbers, RK numbers, and the BIFF2 NUMBER and LABEL that an old writer still stores in a BIFF5 sheet. Formula
 * results (a FORMULA record and the STRING record after it) depend on the records around them and are read by the caller.
 *
 * Layouts: [MS-XLS] 2.4.150 (LABELSST), 2.4.148 (LABEL), 2.4.261 (RSTRING), 2.4.171 (NUMBER), 2.4.220 (RK), 2.4.175 (MULRK);
 * the BIFF2 records follow the Excel file format notes. The office suite reads the BIFF2 ids in a BIFF5 worksheet
 * (`sc/source/filter/excel/read.cxx`, state `Z_Biff5T`; `impop.cxx`, `ReadNumber` and `ReadLabel`: three attribute bytes
 * after the cell address, and a one-byte text length for the BIFF2 LABEL); xlrd 2.0.2 (BSD) reads them in a BIFF2 stream
 * only (`sheet.py` 1379-1388).
 */

/** What a record is decoded with: whether the stream writes text with option flags (BIFF8) and the strings of its SST. */
export interface BiffCellContext {
  readonly hasTextFlags: boolean;
  readonly sst: readonly string[];
}

/** Receives a cell: its row, its column and the text it shows. */
export type BiffCellSink = (row: number, column: number, text: string) => void;

type BiffCellReader = (data: Buffer, context: BiffCellContext, emit: BiffCellSink) => void;

/** Option flag of a BIFF8 string: its characters are UTF-16 and not one byte each. */
const STRING_FLAG_UTF16 = 0x01;
/** LABEL and RSTRING: row, column, XF index and the character count (two bytes each), then the text of BIFF5, or the option flags of BIFF8 and then its text. */
const LABEL_TEXT_START = 8;
const LABEL_FLAGS_OFFSET = 8;
const LABEL_UNICODE_TEXT_START = 9;
/** A BIFF2 cell record: row, column and three attribute bytes, then the value. */
const BIFF2_CELL_VALUE_OFFSET = 7;
const NUMBER_BYTES = 8;

/**
 * Decodes a 32-bit BIFF RK number into its floating point or integer value
 */
export function decodeRk(rk: number): number {
  const is100 = (rk & 0x01) !== 0;
  const isInt = (rk & 0x02) !== 0;
  let val: number;
  if (isInt) {
    val = rk >> 2;
  } else {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(0, 0);
    // `& ~3` yields a signed 32-bit value, negative when the sign bit of the double is set; the high word is unsigned.
    buf.writeUInt32LE((rk & ~3) >>> 0, 4);
    val = buf.readDoubleLE(0);
  }
  return is100 ? val / 100 : val;
}

const readLabelSst: BiffCellReader = (data, { sst }, emit) => {
  if (data.length < 10) return;
  emit(data.readUInt16LE(0), data.readUInt16LE(2), sst[data.readUInt32LE(6)] ?? '');
};

const readLabel: BiffCellReader = (data, { hasTextFlags }, emit) => {
  if (data.length < LABEL_TEXT_START) return;
  const row = data.readUInt16LE(0);
  const column = data.readUInt16LE(2);
  const length = data.readUInt16LE(6);
  if (!hasTextFlags) {
    emit(row, column, data.toString('latin1', LABEL_TEXT_START, Math.min(data.length, LABEL_TEXT_START + length)));
    return;
  }
  if (data.length < LABEL_UNICODE_TEXT_START) return;
  const wide = (data.readUInt8(LABEL_FLAGS_OFFSET) & STRING_FLAG_UTF16) !== 0;
  const text = wide
    ? data.toString('utf16le', LABEL_UNICODE_TEXT_START, Math.min(data.length, LABEL_UNICODE_TEXT_START + length * 2))
    : data.toString('latin1', LABEL_UNICODE_TEXT_START, Math.min(data.length, LABEL_UNICODE_TEXT_START + length));
  emit(row, column, text);
};

const readRString: BiffCellReader = (data, _context, emit) => {
  if (data.length < LABEL_TEXT_START) return;
  const length = data.readUInt16LE(6);
  emit(data.readUInt16LE(0), data.readUInt16LE(2), data.toString('latin1', LABEL_TEXT_START, Math.min(data.length, LABEL_TEXT_START + length)));
};

const readNumber: BiffCellReader = (data, _context, emit) => {
  if (data.length < 6 + NUMBER_BYTES) return;
  emit(data.readUInt16LE(0), data.readUInt16LE(2), String(data.readDoubleLE(6)));
};

const readRk: BiffCellReader = (data, _context, emit) => {
  if (data.length < 10) return;
  emit(data.readUInt16LE(0), data.readUInt16LE(2), String(decodeRk(data.readUInt32LE(6))));
};

const readMulRk: BiffCellReader = (data, _context, emit) => {
  if (data.length < 6) return;
  const row = data.readUInt16LE(0);
  const lastColumn = data.readUInt16LE(data.length - 2);
  let offset = 4;
  for (let column = data.readUInt16LE(2); column <= lastColumn && offset + 6 <= data.length; column++, offset += 6) {
    emit(row, column, String(decodeRk(data.readUInt32LE(offset + 2))));
  }
};

const readBiff2Number: BiffCellReader = (data, { hasTextFlags }, emit) => {
  if (hasTextFlags || data.length < BIFF2_CELL_VALUE_OFFSET + NUMBER_BYTES) return;
  emit(data.readUInt16LE(0), data.readUInt16LE(2), String(data.readDoubleLE(BIFF2_CELL_VALUE_OFFSET)));
};

const readBiff2Label: BiffCellReader = (data, { hasTextFlags }, emit) => {
  if (hasTextFlags || data.length <= BIFF2_CELL_VALUE_OFFSET) return;
  const textStart = BIFF2_CELL_VALUE_OFFSET + 1;
  const length = data[BIFF2_CELL_VALUE_OFFSET];
  emit(data.readUInt16LE(0), data.readUInt16LE(2), data.toString('latin1', textStart, Math.min(data.length, textStart + length)));
};

const CELL_RECORD_READERS: ReadonlyMap<number, BiffCellReader> = new Map<number, BiffCellReader>([
  [0x0003, readBiff2Number],
  [0x0004, readBiff2Label],
  [0x00bd, readMulRk],
  [0x00d6, readRString],
  [0x00fd, readLabelSst],
  [0x0203, readNumber],
  [0x0204, readLabel],
  [0x027e, readRk],
]);

/** Reads the cells of the record when it is one of the kinds above; false for any other record. */
export function readBiffCellRecord(recId: number, data: Buffer, context: BiffCellContext, emit: BiffCellSink): boolean {
  const read = CELL_RECORD_READERS.get(recId);
  if (read === undefined) return false;
  read(data, context, emit);
  return true;
}
