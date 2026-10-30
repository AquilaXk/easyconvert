/**
 * A BIFF8 workbook read straight from its bytes, with no code from `src`: the Compound File container (MS-CFB) is opened to the
 * `Workbook` stream, the records of that stream (MS-XLS 2.1.4) are walked, and the cell records are decoded to values. A test uses it
 * to see which kind of record an `.xls` writer put each cell in (number, shared string, boolean), the way an office suite would find
 * them, instead of trusting what the converter says about its own output.
 */

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const DIRECTORY_ENTRY_BYTES = 128;
const HEADER_DIFAT_ENTRIES = 109;
const STREAM_OBJECT_TYPE = 2;
const ROOT_OBJECT_TYPE = 5;
const FORMULA_RESULT_BOOLEAN = 1;

export const RECORD = {
  BOF: 0x0809,
  EOF: 0x000a,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  BOUNDSHEET: 0x0085,
  DIMENSIONS: 0x0200,
} as const;

export interface BiffRecord {
  id: number;
  data: Buffer;
}

export type BiffCell =
  | { kind: 'number'; record: number; value: number }
  | { kind: 'string'; record: number; value: string }
  | { kind: 'boolean'; record: number; value: boolean };

interface DirectoryEntry {
  name: string;
  type: number;
  start: number;
  size: number;
}

function readChain(sectors: Buffer, first: number, fat: readonly number[], sectorBytes: number): Buffer {
  const parts: Buffer[] = [];
  const seen = new Set<number>();
  for (let sector = first; sector !== END_OF_CHAIN && sector !== FREE_SECTOR; sector = fat[sector]) {
    if (seen.has(sector)) throw new Error('the sector chain loops');
    seen.add(sector);
    parts.push(sectors.subarray(sector * sectorBytes, (sector + 1) * sectorBytes));
  }
  return Buffer.concat(parts);
}

/** The bytes of a stream of a Compound File (version 3 or 4), found by its directory name. */
export function readCompoundStream(file: Buffer, streamName: string): Buffer {
  if (!file.subarray(0, CFB_SIGNATURE.length).equals(CFB_SIGNATURE)) throw new Error('not a Compound File: the D0 CF 11 E0 signature is missing');
  const sectorBytes = 1 << file.readUInt16LE(0x1e);
  const miniSectorBytes = 1 << file.readUInt16LE(0x20);
  const fatSectorCount = file.readUInt32LE(0x2c);
  const firstDirectory = file.readUInt32LE(0x30);
  const miniCutoff = file.readUInt32LE(0x38);
  const firstMiniFat = file.readUInt32LE(0x3c);
  const firstDifat = file.readUInt32LE(0x44);
  const sectors = file.subarray(sectorBytes);

  const fatSectors: number[] = [];
  for (let i = 0; i < HEADER_DIFAT_ENTRIES && fatSectors.length < fatSectorCount; i++) fatSectors.push(file.readUInt32LE(0x4c + i * 4));
  for (let sector = firstDifat; sector !== END_OF_CHAIN && sector !== FREE_SECTOR && fatSectors.length < fatSectorCount; ) {
    const block = sectors.subarray(sector * sectorBytes, (sector + 1) * sectorBytes);
    for (let i = 0; i < sectorBytes / 4 - 1 && fatSectors.length < fatSectorCount; i++) fatSectors.push(block.readUInt32LE(i * 4));
    sector = block.readUInt32LE(sectorBytes - 4);
  }
  const fat: number[] = [];
  for (const sector of fatSectors) {
    const block = sectors.subarray(sector * sectorBytes, (sector + 1) * sectorBytes);
    for (let i = 0; i < sectorBytes; i += 4) fat.push(block.readUInt32LE(i));
  }

  const directoryBytes = readChain(sectors, firstDirectory, fat, sectorBytes);
  const entries: DirectoryEntry[] = [];
  for (let offset = 0; offset + DIRECTORY_ENTRY_BYTES <= directoryBytes.length; offset += DIRECTORY_ENTRY_BYTES) {
    const nameBytes = directoryBytes.readUInt16LE(offset + 0x40);
    entries.push({
      name: directoryBytes.toString('utf16le', offset, offset + Math.max(0, nameBytes - 2)),
      type: directoryBytes.readUInt8(offset + 0x42),
      start: directoryBytes.readUInt32LE(offset + 0x74),
      size: Number(directoryBytes.readBigUInt64LE(offset + 0x78)),
    });
  }
  const entry = entries.find((candidate) => candidate.type === STREAM_OBJECT_TYPE && candidate.name === streamName);
  if (!entry) throw new Error(`the Compound File has no stream named ${streamName}`);
  if (entry.size >= miniCutoff) return readChain(sectors, entry.start, fat, sectorBytes).subarray(0, entry.size);

  const root = entries.find((candidate) => candidate.type === ROOT_OBJECT_TYPE);
  if (!root) throw new Error('the Compound File has no root entry');
  const miniStream = readChain(sectors, root.start, fat, sectorBytes);
  const miniFat: number[] = [];
  const miniFatBytes = readChain(sectors, firstMiniFat, fat, sectorBytes);
  for (let i = 0; i < miniFatBytes.length; i += 4) miniFat.push(miniFatBytes.readUInt32LE(i));
  return readChain(miniStream, entry.start, miniFat, miniSectorBytes).subarray(0, entry.size);
}

/** The records of a BIFF stream, in order, each with its payload. */
export function walkRecords(stream: Buffer): BiffRecord[] {
  const records: BiffRecord[] = [];
  for (let offset = 0; offset + 4 <= stream.length; ) {
    const id = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    if (offset + 4 + length > stream.length) throw new Error(`record 0x${id.toString(16)} at ${offset} runs past the end of the stream`);
    records.push({ id, data: stream.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  }
  return records;
}

/** A number stored as an RK value (MS-XLS 2.5.218): 30 bits of an IEEE double or of an integer, scaled by 100 when the low bit says so. */
function decodeRk(rk: number): number {
  const divide = (rk & 1) !== 0;
  const isInteger = (rk & 2) !== 0;
  let value: number;
  if (isInteger) {
    value = rk >> 2;
  } else {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    value = bytes.readDoubleLE(0);
  }
  return divide ? value / 100 : value;
}

/** The strings of the SST record (MS-XLS 2.4.265), which a test workbook keeps within one record. */
function sharedStrings(records: readonly BiffRecord[]): string[] {
  const index = records.findIndex((record) => record.id === RECORD.SST);
  if (index < 0) return [];
  if (records[index + 1]?.id === RECORD.CONTINUE) throw new Error('this walker reads a shared string table that fits one record');
  const data = records[index].data;
  const unique = data.readUInt32LE(4);
  const strings: string[] = [];
  let offset = 8;
  for (let i = 0; i < unique; i++) {
    const length = data.readUInt16LE(offset);
    const flags = data.readUInt8(offset + 2);
    offset += 3;
    const runs = flags & 0x08 ? data.readUInt16LE(offset) : 0;
    if (flags & 0x08) offset += 2;
    const phoneticBytes = flags & 0x04 ? data.readUInt32LE(offset) : 0;
    if (flags & 0x04) offset += 4;
    const wide = (flags & 0x01) !== 0;
    const byteLength = wide ? length * 2 : length;
    strings.push(data.toString(wide ? 'utf16le' : 'latin1', offset, offset + byteLength));
    offset += byteLength + runs * 4 + phoneticBytes;
  }
  return strings;
}

/** The cells of the first worksheet of a workbook stream, by `row,column` (both from 0), with the record kind that stores each. */
export function readCells(stream: Buffer): Map<string, BiffCell> {
  const records = walkRecords(stream);
  const strings = sharedStrings(records);
  const cells = new Map<string, BiffCell>();
  const key = (row: number, column: number): string => `${row},${column}`;
  const firstSheetStart = records.findIndex((record, i) => record.id === RECORD.BOF && i > 0);
  for (const record of firstSheetStart < 0 ? records : records.slice(firstSheetStart)) {
    const { id, data } = record;
    if (id === RECORD.NUMBER) {
      cells.set(key(data.readUInt16LE(0), data.readUInt16LE(2)), { kind: 'number', record: id, value: data.readDoubleLE(6) });
    } else if (id === RECORD.RK) {
      cells.set(key(data.readUInt16LE(0), data.readUInt16LE(2)), { kind: 'number', record: id, value: decodeRk(data.readUInt32LE(6)) });
    } else if (id === RECORD.MULRK) {
      const row = data.readUInt16LE(0);
      const first = data.readUInt16LE(2);
      const last = data.readUInt16LE(data.length - 2);
      for (let column = first; column <= last; column++) {
        cells.set(key(row, column), { kind: 'number', record: id, value: decodeRk(data.readUInt32LE(4 + (column - first) * 6 + 2)) });
      }
    } else if (id === RECORD.LABELSST) {
      cells.set(key(data.readUInt16LE(0), data.readUInt16LE(2)), { kind: 'string', record: id, value: strings[data.readUInt32LE(6)] });
    } else if (id === RECORD.BOOLERR && data.readUInt8(7) === 0) {
      cells.set(key(data.readUInt16LE(0), data.readUInt16LE(2)), { kind: 'boolean', record: id, value: data.readUInt8(6) !== 0 });
    } else if (id === RECORD.FORMULA && data.readUInt16LE(12) === 0xffff && data.readUInt8(6) === FORMULA_RESULT_BOOLEAN) {
      // A formula whose cached result is a boolean: how the office suite stores a TRUE or FALSE cell.
      cells.set(key(data.readUInt16LE(0), data.readUInt16LE(2)), { kind: 'boolean', record: id, value: data.readUInt8(8) !== 0 });
    }
  }
  return cells;
}

/** The cells of the first worksheet of an `.xls` file. */
export function readXlsCells(file: Buffer): Map<string, BiffCell> {
  return readCells(readCompoundStream(file, 'Workbook'));
}
