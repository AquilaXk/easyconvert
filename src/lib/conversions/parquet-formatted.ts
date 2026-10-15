import { decompressPageSlice } from './parquet-codec';
import { Encoding, PageType, PARQUET_MAX_DECODED_VALUE_BYTES, ParquetFormatError, ParquetUnsupportedError, ParquetType } from './parquet-format';
import { ColumnValue, unsignedInteger } from './parquet-logical';
import {
  assertDictionaryIndex,
  assertPlainBytes,
  assertValueWithinPage,
  byteArrayLengthAt,
  BYTE_ARRAY_LENGTH_PREFIX_BYTES,
  chargeValueBytes,
  ChunkPlan,
  DecodeBudget,
  decodeDataPageLevels,
  decodeDataPageV2LevelsAndValues,
  decodeEncodedValues,
  DICTIONARY_DATA_ENCODINGS,
  int32At,
  LeafColumn,
  NARROW_VALUE_BYTES,
  PageHeader,
  PageLevels,
  prepareParquetPlans,
  readDictionaryIndices,
  readDictionaryPageBody,
  safeInt64At,
  ScannedPage,
  uint32At,
  WIDE_VALUE_BYTES,
} from './parquet-reader';

/**
 * Parquet pages formatted straight into the text of their cells. A dictionary entry is formatted once, not once per
 * row, and a row group is read as a series of row windows, so a table is never held as one value per cell: the
 * working set is one decoded page per column.
 */

/** How one column's values become the text of a cell (delimiter or key prefix included). */
export interface ColumnCellFormatter {
  nullCell: string;
  trueCell: string;
  falseCell: string;
  /** Text before a number and after it, for formats where a finite number is exactly `prefix + number + suffix`. */
  numberPrefix?: string;
  numberSuffix?: string;
  formatNumber: (val: number) => string;
  formatString: (val: string) => string;
  /** The cell of ASCII text that needs no escaping, or null when the text must go through formatString. */
  formatTextSlice?: (page: Buffer, start: number, end: number) => string | null;
}

export type ColumnFormatterFactory = (names: string[], colIndex: number, safeAsciiString: boolean) => ColumnCellFormatter;

/**
 * `rows` rows of the table: the cell of row r in column c is `columns[c][offsets[c] + r]`. The window object and its
 * arrays are reused for the next window, so a consumer finishes with one before asking for the next.
 */
export interface FormattedRowWindow {
  columns: string[][];
  offsets: Int32Array;
  rows: number;
}

const EIGHTH_SUFFIX: readonly string[] = ['', '.125', '.25', '.375', '.5', '.625', '.75', '.875'];
const MAX_EIGHTHS = 0x7f_ff_ff_ff;
const TEXT_ANNOTATIONS: ReadonlySet<string> = new Set(['string', 'enum', 'json']);
/** log2 of the bits in a byte: boolean values are packed eight to a byte. */
const BOOLEAN_BYTE_SHIFT = 3;

// ---------------------------------------------------------------------------
// Plain values
// ---------------------------------------------------------------------------

function formatBooleans(page: Buffer, pos: number, count: number, formatter: ColumnCellFormatter): string[] {
  const { trueCell, falseCell } = formatter;
  const cells = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    cells[i] = ((page[pos + (i >> BOOLEAN_BYTE_SHIFT)] >> (i & 7)) & 1) === 1 ? trueCell : falseCell;
  }
  return cells;
}

function formatByteArrays(page: Buffer, pos: number, count: number, leaf: LeafColumn, formatter: ColumnCellFormatter): string[] {
  const { width: fixedWidth, readSlice, map } = leaf.reader;
  const { formatNumber, formatString, formatTextSlice } = formatter;
  const textSlice = formatTextSlice !== undefined && TEXT_ANNOTATIONS.has(leaf.annotation.tag) ? formatTextSlice : undefined;
  const cells = new Array<string>(count);
  let cursor = pos;
  for (let i = 0; i < count; i++) {
    let length = fixedWidth;
    if (fixedWidth === 0) {
      length = byteArrayLengthAt(page, cursor, leaf);
      cursor += BYTE_ARRAY_LENGTH_PREFIX_BYTES;
    }
    const end = cursor + length;
    assertValueWithinPage(page, end, length, leaf);
    const fast = textSlice === undefined ? null : textSlice(page, cursor, end);
    if (fast === null) {
      const value = readSlice ? readSlice(page, cursor, end) : (map as (raw: Buffer) => ColumnValue)(page.subarray(cursor, end));
      cells[i] = typeof value === 'string' ? formatString(value) : formatNumber(value as number);
    } else {
      cells[i] = fast;
    }
    cursor = end;
  }
  return cells;
}

/** A positive multiple of 1/8 below 2^28 is written from its integer and fraction parts; anything else by `formatNumber`. */
function formatDouble(value: number, formatter: ColumnCellFormatter, numberPrefix: string, numberSuffix: string): string {
  const eighths = Math.trunc(value * 8);
  if (eighths !== value * 8 || eighths <= 0 || eighths > MAX_EIGHTHS) return formatter.formatNumber(value);
  const fraction = EIGHTH_SUFFIX[eighths & 7];
  return `${numberPrefix}${eighths >> 3}${fraction}${numberSuffix}`;
}

function formatFloats(page: Buffer, pos: number, count: number, leaf: LeafColumn, formatter: ColumnCellFormatter): string[] {
  const wide = leaf.reader.kind === 'f64';
  const width = wide ? WIDE_VALUE_BYTES : NARROW_VALUE_BYTES;
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const { numberPrefix, numberSuffix = '', formatNumber } = formatter;
  const cells = new Array<string>(count);
  for (let i = 0, at = pos; i < count; i++, at += width) {
    if (!wide) cells[i] = formatNumber(view.getFloat32(at, true));
    else if (numberPrefix === undefined) cells[i] = formatNumber(view.getFloat64(at, true));
    else cells[i] = formatDouble(view.getFloat64(at, true), formatter, numberPrefix, numberSuffix);
  }
  return cells;
}

/** An integer written as the number's digits between the formatter's prefix and suffix, or by `formatNumber`. */
function integerCell(value: number, formatter: ColumnCellFormatter): string {
  const { numberPrefix, numberSuffix = '', formatNumber } = formatter;
  if (numberPrefix === undefined) return formatNumber(value);
  return numberSuffix === '' ? numberPrefix + value : numberPrefix + value + numberSuffix;
}

function formatInt32s(page: Buffer, pos: number, count: number, leaf: LeafColumn, formatter: ColumnCellFormatter): string[] {
  const { kind, map } = leaf.reader;
  const unsigned = kind === 'u32';
  const cells = new Array<string>(count);
  for (let i = 0, at = pos; i < count; i++, at += NARROW_VALUE_BYTES) {
    const raw = unsigned ? uint32At(page, at) : int32At(page, at);
    if (unsigned || !map) {
      cells[i] = integerCell(raw, formatter);
    } else {
      const mapped = map(raw);
      cells[i] = typeof mapped === 'string' ? formatter.formatString(mapped) : formatter.formatNumber(mapped as number);
    }
  }
  return cells;
}

/** A 64-bit integer outside the safe range is written as the digits of its exact value. */
function formatLargeInt64(page: Buffer, at: number, formatter: ColumnCellFormatter): string {
  return formatter.formatString(page.readBigInt64LE(at).toString());
}

function formatMappedInt64(page: Buffer, at: number, leaf: LeafColumn, formatter: ColumnCellFormatter): string {
  const { map, mapNumber } = leaf.reader;
  const safe = mapNumber ? safeInt64At(page, at) : Number.NaN;
  const mapped = Number.isNaN(safe) ? (map as (raw: bigint) => ColumnValue)(page.readBigInt64LE(at)) : (mapNumber as (raw: number) => ColumnValue)(safe);
  return typeof mapped === 'string' ? formatter.formatString(mapped) : formatter.formatNumber(mapped as number);
}

function formatInt64s(page: Buffer, pos: number, count: number, leaf: LeafColumn, formatter: ColumnCellFormatter): string[] {
  const { kind, map } = leaf.reader;
  const cells = new Array<string>(count);
  for (let i = 0, at = pos; i < count; i++, at += WIDE_VALUE_BYTES) {
    if (kind === 'u64') {
      const value = unsignedInteger(page.readBigInt64LE(at));
      cells[i] = typeof value === 'number' ? formatter.formatNumber(value) : formatter.formatString(value);
    } else if (map) {
      cells[i] = formatMappedInt64(page, at, leaf, formatter);
    } else {
      const safe = safeInt64At(page, at);
      cells[i] = Number.isNaN(safe) ? formatLargeInt64(page, at, formatter) : integerCell(safe, formatter);
    }
  }
  return cells;
}

/** `count` PLAIN values of a column, each as the text of its cell. */
function formatPlainValues(page: Buffer, pos: number, leaf: LeafColumn, count: number, formatter: ColumnCellFormatter): string[] {
  assertPlainBytes(page, pos, leaf, count);
  switch (leaf.reader.kind) {
    case 'bool':
      return formatBooleans(page, pos, count, formatter);
    case 'bytes':
      return formatByteArrays(page, pos, count, leaf, formatter);
    case 'f64':
    case 'f32':
      return formatFloats(page, pos, count, leaf, formatter);
    case 'i32':
    case 'u32':
      return formatInt32s(page, pos, count, leaf, formatter);
    default:
      return formatInt64s(page, pos, count, leaf, formatter);
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function formatDecodedValues(values: ColumnValue[], formatter: ColumnCellFormatter): string[] {
  const { nullCell, trueCell, falseCell, formatNumber, formatString } = formatter;
  const cells = new Array<string>(values.length);
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value === 'string') cells[i] = formatString(value);
    else if (typeof value === 'number') cells[i] = formatNumber(value);
    else if (typeof value === 'boolean') cells[i] = value ? trueCell : falseCell;
    else cells[i] = nullCell;
  }
  return cells;
}

function lookupDictionary(
  page: Buffer,
  pos: number,
  nonNull: number,
  leaf: LeafColumn,
  dictionary: string[] | null
): string[] {
  if (!dictionary) {
    throw new ParquetFormatError(`Corrupted Parquet file: dictionary-encoded page without a dictionary in column '${leaf.name}'`);
  }
  const cells = new Array<string>(nonNull);
  if (nonNull === 0) return cells;
  const indices = readDictionaryIndices(page, pos, nonNull, leaf);
  for (let i = 0; i < nonNull; i++) {
    const index = indices[i];
    assertDictionaryIndex(index, dictionary.length, leaf);
    cells[i] = dictionary[index];
  }
  return cells;
}

/** The cells of a page's present values spread over all of its rows, with the null cell where a value is absent. */
function placeNulls(present: string[], levels: Uint8Array, count: number, nullCell: string): string[] {
  const cells = new Array<string>(count);
  let next = 0;
  for (let i = 0; i < count; i++) cells[i] = levels[i] === 1 ? present[next++] : nullCell;
  return cells;
}

/** Charges the text of a page's cells to the decoded-value budget, the way text columns are charged when decoded. */
function chargeFormattedCells(cells: string[], leaf: LeafColumn, formatter: ColumnCellFormatter, budget: DecodeBudget): void {
  if (leaf.reader.kind !== 'bytes' && leaf.reader.map === null) return;
  let bytes = 0;
  for (let i = 0; i < cells.length; i++) bytes += cells[i].length;
  const overhead = cells.length * formatter.nullCell.length;
  if (bytes > overhead) chargeValueBytes(budget, bytes - overhead);
}

interface PageValues {
  body: Buffer;
  header: PageHeader;
  presence: PageLevels;
}

/** The text of every cell of one data page. */
function formatDataPage(
  page: PageValues,
  leaf: LeafColumn,
  dictionary: string[] | null,
  formatter: ColumnCellFormatter,
  budget: DecodeBudget
): string[] {
  const { body, header, presence } = page;
  const { nonNull, pos } = presence;
  const count = header.numValues;
  let present: string[];
  let charged = true;
  if (DICTIONARY_DATA_ENCODINGS.has(header.encoding)) {
    present = lookupDictionary(body, pos, nonNull, leaf, dictionary);
  } else if (header.encoding === Encoding.PLAIN) {
    present = formatPlainValues(body, pos, leaf, nonNull, formatter);
  } else {
    present = formatDecodedValues(decodeEncodedValues(body, pos, nonNull, header.encoding, leaf, null, budget), formatter);
    charged = false;
  }
  const cells = presence.levels !== null && nonNull !== count ? placeNulls(present, presence.levels, count, formatter.nullCell) : present;
  if (charged) chargeFormattedCells(cells, leaf, formatter, budget);
  return cells;
}

// ---------------------------------------------------------------------------
// Column chunks and row windows
// ---------------------------------------------------------------------------

/** Walks the pages of one column chunk, holding the cells of the page it is in. */
class FormattedChunkCursor {
  cells: string[] = [];
  position = 0;
  private pageIndex = 0;
  private dictionary: string[] | null = null;

  constructor(
    private readonly buffer: Buffer,
    private readonly plan: ChunkPlan,
    private readonly formatter: ColumnCellFormatter,
    private readonly budget: DecodeBudget
  ) {}

  /** Cells left in the page the cursor is in; loads the next page when that one is used up. */
  available(): number {
    if (this.position === this.cells.length) this.loadNextPage();
    return this.cells.length - this.position;
  }

  advance(count: number): void {
    this.position += count;
  }

  private loadNextPage(): void {
    const { pages } = this.plan;
    while (this.pageIndex < pages.length) {
      const page = pages[this.pageIndex++];
      const cells = this.formatPage(page);
      if (cells !== null) {
        this.cells = cells;
        this.position = 0;
        return;
      }
    }
    throw new ParquetFormatError(`Corrupted Parquet file: column '${this.plan.leaf.name}' ends before all rows are present`);
  }

  /** The cells of a data page; null for a page that holds none (index and dictionary pages). */
  private formatPage(page: ScannedPage): string[] | null {
    const { type } = page.header;
    if (type === PageType.INDEX_PAGE) return null;
    if (type === PageType.DICTIONARY_PAGE) {
      this.readDictionary(page);
      return null;
    }
    if (type !== PageType.DATA_PAGE && type !== PageType.DATA_PAGE_V2) {
      throw new ParquetUnsupportedError(`Unsupported Parquet page type ${type} in column '${this.plan.leaf.name}'`);
    }
    return formatDataPage(this.readDataPage(page), this.plan.leaf, this.dictionary, this.formatter, this.budget);
  }

  private readDictionary(page: ScannedPage): void {
    const { leaf } = this.plan;
    const body = readDictionaryPageBody(this.buffer, this.plan, page);
    this.dictionary = formatPlainValues(body, 0, leaf, page.header.numValues, this.formatter);
  }

  private readDataPage(page: ScannedPage): PageValues {
    const { header } = page;
    const { leaf, chunk } = this.plan;
    if (header.type === PageType.DATA_PAGE) {
      const body = decompressPageSlice(chunk.codec, this.buffer, page.bodyStart, page.bodyEnd, header.uncompressedSize);
      return { body, header, presence: decodeDataPageLevels(body, header, leaf, this.budget) };
    }
    const raw = this.buffer.subarray(page.bodyStart, page.bodyEnd);
    const { levels, nonNull, valuesPage } = decodeDataPageV2LevelsAndValues(raw, chunk.codec, header, leaf, this.budget);
    return { body: valuesPage, header, presence: { levels, nonNull, pos: 0 } };
  }
}

/** Whether a column's text cells are plain ASCII, so a formatter may skip escaping checks. */
function isAsciiColumn(leaf: LeafColumn): boolean {
  return (
    leaf.reader.kind !== 'bytes' ||
    leaf.type === ParquetType.INT96 ||
    leaf.annotation.tag === 'decimal' ||
    leaf.annotation.tag === 'uuid' ||
    leaf.annotation.tag === 'bson'
  );
}

/** Groups the chunk plans by row group, each group ordered by schema column. */
function groupByRowGroup(plans: ChunkPlan[], columnCount: number): ChunkPlan[][] {
  const groups: ChunkPlan[][] = [];
  for (let first = 0; first < plans.length; first += columnCount) {
    const group = plans.slice(first, first + columnCount);
    group.sort((a, b) => a.leaf.colIndex - b.leaf.colIndex);
    groups.push(group);
  }
  return groups;
}

function mapRangeError(error: unknown): unknown {
  if (error instanceof RangeError) {
    return new ParquetFormatError(`Unsupported Parquet file: the decoded table exceeds engine limits (${error.message})`);
  }
  return error;
}

/** A flat Parquet file read as text cells, one row window at a time. */
export class FormattedParquetTable {
  readonly names: string[];
  readonly numRows: number;

  private constructor(
    private readonly buffer: Buffer,
    private readonly groups: ChunkPlan[][],
    private readonly formatters: ColumnCellFormatter[],
    names: string[],
    numRows: number
  ) {
    this.names = names;
    this.numRows = numRows;
  }

  static open(buffer: Buffer, makeFormatter: ColumnFormatterFactory): FormattedParquetTable {
    try {
      const { meta, plans } = prepareParquetPlans(buffer);
      const names = meta.leaves.map((leaf) => leaf.name);
      const formatters = meta.leaves.map((leaf, c) => makeFormatter(names, c, isAsciiColumn(leaf)));
      return new FormattedParquetTable(buffer, groupByRowGroup(plans, meta.leaves.length), formatters, names, meta.numRows);
    } catch (error) {
      throw mapRangeError(error);
    }
  }

  /** The table's rows in order, in windows that never cross a row group or the end of a page of any column. */
  *windows(): Generator<FormattedRowWindow> {
    const columnCount = this.names.length;
    const budget: DecodeBudget = { valueBytes: PARQUET_MAX_DECODED_VALUE_BYTES };
    const window: FormattedRowWindow = { columns: new Array<string[]>(columnCount), offsets: new Int32Array(columnCount), rows: 0 };
    try {
      for (const group of this.groups) {
        const cursors = group.map((plan) => new FormattedChunkCursor(this.buffer, plan, this.formatters[plan.leaf.colIndex], budget));
        for (let remaining = group[0].rows; remaining > 0; remaining -= window.rows) {
          window.rows = this.fillWindow(window, cursors, remaining);
          yield window;
          for (const cursor of cursors) cursor.advance(window.rows);
        }
      }
    } catch (error) {
      throw mapRangeError(error);
    }
  }

  private fillWindow(window: FormattedRowWindow, cursors: FormattedChunkCursor[], remaining: number): number {
    let rows = remaining;
    for (const cursor of cursors) rows = Math.min(rows, cursor.available());
    for (let c = 0; c < cursors.length; c++) {
      window.columns[c] = cursors[c].cells;
      window.offsets[c] = cursors[c].position;
    }
    return rows;
  }
}
