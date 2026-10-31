import { SheetLimitError } from '../../types';
import { PARQUET_MAX_CELLS, PARQUET_MAX_COLUMNS, PARQUET_MAX_ROWS } from '../parquet-format';

/**
 * The most a worksheet holds in each spreadsheet format. A table past a bound is refused with a typed limit error, never cut:
 * a writer or an office suite that drops the rows past the edge answers with a file that has lost data.
 */

/**
 * Rows and columns of an OOXML worksheet: 1,048,576 rows and 16,384 columns (XFD), "Excel specifications and limits" (Microsoft) and
 * ECMA-376 Part 1, 18.3.1.73 (`row` r) and 18.3.1.4 (`c` r). LibreOffice Calc holds the same grid (`MAXROWCOUNT`, `MAXCOLCOUNT`,
 * sc/inc/address.hxx).
 */
export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;
export const XLSX_LAST_COLUMN_NAME = 'XFD';

/**
 * Rows and columns of a BIFF8 worksheet: 65,536 rows and 256 columns (IV), "Excel specifications and limits" (Microsoft, Excel
 * 97-2003) and [MS-XLS] (a `Rw` is 16 bits and a `Col` is 8 bits in the cell records of a sheet in this format).
 */
export const XLS_MAX_ROWS = 65_536;
export const XLS_MAX_COLUMNS = 256;

/**
 * Characters of one cell: 32,767, "Excel specifications and limits" (Microsoft) and the 16-bit character count of an
 * `XLUnicodeString` in [MS-XLS]. xlsxwriter cuts a longer string to this length (`xls_strmax`); a table that holds one is refused.
 */
export const SHEET_MAX_CELL_CHARS = 32_767;

/** The refusal of a table that is past one of the bounds above: a 413 that names how much there is and how much a sheet holds. */
export function sheetLimitError(subject: string, count: number, what: string, sheet: string, limit: number): SheetLimitError {
  return new SheetLimitError(`${subject} has ${count} ${what}, and ${sheet} holds at most ${limit}; nothing was cut.`);
}

/**
 * Sheets of one workbook: 10,000, the tabs LibreOffice Calc holds (`MAXTABCOUNT`, sc/inc/address.hxx). Excel states no count ("Excel
 * specifications and limits": limited by available memory), and the office suite is what reads the workbook on the way to `.xls`, so
 * a workbook past what it holds would lose sheets there. A workbook past the bound is refused with a typed limit error, never cut.
 */
export const WORKBOOK_MAX_SHEETS = 10_000;

/**
 * Cells of an OpenDocument spreadsheet this engine writes. Its `content.xml` is one string, and an empty cell alone is about 80
 * characters of markup, so past a few million cells the string passes the engine's longest string (about 2^29 characters) and the
 * write fails untyped. One million cells keeps a sheet of long values under it, and is the cell bound of a table drawn on PDF pages.
 */
export const ODS_MAX_CELLS = 1_000_000;

/**
 * Cells of a workbook the XLSX reader builds, padding included: the 20 million cells that the data-format readers (Parquet) allow for a
 * table. A sparse sheet inside the bounds of a worksheet can still ask for 16.7 billion padded cells (a cell at XFD on each of
 * 1048576 rows), and each padded cell takes about 53 bytes of heap.
 */
export const XLSX_MAX_MATERIALISED_CELLS = 20_000_000;

/** Cells (rows times columns, over all sheets) one PDF document may hold before it is refused with HTTP 413: the most the in-process table writer draws. */
export const PDF_TABLE_MAX_CELLS = 1_000_000;
/** Columns one sheet of a PDF table may hold. */
export const PDF_TABLE_MAX_COLUMNS = 16_384;

/**
 * What a table holds in one target format, checked by every writer and by the table of records before its matrix is built, so a limit is
 * stated once. `sheet` names the worksheet of a spreadsheet format as a refusal words it ("a worksheet holds at most"), and is null
 * for a format that is no sheet, whose refusals are payload limits and not sheet limits.
 */
export interface Grid {
  readonly sheet: string | null;
  readonly columns: number;
  /** Rows of the sheet, the header row included. */
  readonly rows: number;
  /** Cells of the table: the most a workbook this engine reads, or a writer holds in one string or in memory, for the format. */
  readonly cells: number;
}

/** A spreadsheet format's grid: its worksheet is named. */
export interface SpreadsheetGrid extends Grid {
  readonly sheet: string;
}

export type SpreadsheetFormat = 'xls' | 'xlsx' | 'ods';

/**
 * The grid of each target. Spreadsheets hold the grid of their format and no more cells than our XLSX reader materialises for one
 * workbook (XLSX_MAX_MATERIALISED_CELLS) or, for ODS, than its writer holds in one string (ODS_MAX_CELLS). A PDF holds the table its
 * page layout draws (`pdf-table-layout.ts`), Parquet its writer's columns, rows and cells (`parquet-format.ts`), and every other table
 * target the Parquet bound of cells held in memory at once.
 */
const GRIDS: Readonly<Record<string, Grid>> = {
  xls: { sheet: 'an .xls worksheet', columns: XLS_MAX_COLUMNS, rows: XLS_MAX_ROWS, cells: XLSX_MAX_MATERIALISED_CELLS },
  xlsx: { sheet: 'a worksheet', columns: XLSX_MAX_COLUMNS, rows: XLSX_MAX_ROWS, cells: XLSX_MAX_MATERIALISED_CELLS },
  ods: { sheet: 'a worksheet', columns: XLSX_MAX_COLUMNS, rows: XLSX_MAX_ROWS, cells: ODS_MAX_CELLS },
  pdf: { sheet: null, columns: PDF_TABLE_MAX_COLUMNS, rows: Infinity, cells: PDF_TABLE_MAX_CELLS },
  parquet: { sheet: null, columns: PARQUET_MAX_COLUMNS, rows: PARQUET_MAX_ROWS, cells: PARQUET_MAX_CELLS },
};
const OTHER_GRID: Grid = { sheet: null, columns: Infinity, rows: Infinity, cells: PARQUET_MAX_CELLS };

export function gridOf(format: SpreadsheetFormat): SpreadsheetGrid;
export function gridOf(format: string): Grid;
export function gridOf(format: string): Grid {
  return Object.hasOwn(GRIDS, format) ? GRIDS[format] : OTHER_GRID;
}

export function isSpreadsheetGrid(grid: Grid): grid is SpreadsheetGrid {
  return grid.sheet !== null;
}

/** The refusal of a table with more rows or columns than a worksheet of `grid` holds. */
export function gridLimitError(grid: SpreadsheetGrid, count: number, what: 'rows' | 'columns'): SheetLimitError {
  return sheetLimitError('The table', count, what, grid.sheet, grid[what]);
}

/** Refuses a workbook of more than WORKBOOK_MAX_SHEETS sheets with the typed limit error. */
export function assertSheetCount(count: number): void {
  if (count > WORKBOOK_MAX_SHEETS) throw sheetLimitError('The workbook', count, 'sheets', 'a workbook', WORKBOOK_MAX_SHEETS);
}

/**
 * The sheets of a table written to a format that has no writer-side grid check (ODS) are bound as an XLSX worksheet is, since the office suite
 * reads them on the same grid: 16,384 columns and 1,048,576 rows a sheet, 10,000 sheets a workbook. A table past a bound is refused with a
 * typed limit error, never cut. The sheets are returned as they are.
 */
export function assertSheetsWithinGrid<Sheet extends { rows: readonly (readonly unknown[])[] }>(sheets: Sheet[]): Sheet[] {
  const grid = gridOf('ods');
  assertSheetCount(sheets.length);
  let cells = 0;
  for (const sheet of sheets) {
    if (sheet.rows.length > grid.rows) throw gridLimitError(grid, sheet.rows.length, 'rows');
    for (const row of sheet.rows) {
      if (row.length > grid.columns) throw gridLimitError(grid, row.length, 'columns');
      cells += row.length;
    }
  }
  if (cells > grid.cells) throw sheetLimitError('The workbook', cells, 'cells', 'an OpenDocument spreadsheet this engine writes', grid.cells);
  return sheets;
}
