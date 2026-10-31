import { SheetLimitError } from '../types';
import {
  ODS_MAX_CELLS,
  XLS_MAX_COLUMNS,
  XLS_MAX_ROWS,
  XLSX_MAX_COLUMNS,
  XLSX_MAX_MATERIALISED_CELLS,
  XLSX_MAX_ROWS,
  assertSheetCount,
  sheetLimitError,
} from './office/sheet-bounds';
import { PARQUET_MAX_CELLS, PARQUET_MAX_COLUMNS, PARQUET_MAX_ROWS } from './parquet-format';
import { PDF_TABLE_MAX_CELLS, PDF_TABLE_MAX_COLUMNS } from './pdf-table-layout';

/**
 * What a table holds in one target format, checked by the table of records before its matrix is built and by the spreadsheet writers, so
 * a limit of a spreadsheet is stated once. `sheet` names the worksheet of a spreadsheet format as a refusal words it ("a worksheet holds at
 * most"), and is null for a format that is no sheet, whose refusals are payload limits and not sheet limits. The constants behind each
 * grid stay in the module of their format (`office/sheet-bounds`, `parquet-format`, `pdf-table-layout`); this module only names which of
 * them a target uses.
 */
export interface Grid {
  readonly sheet: string | null;
  readonly columns: number;
  /** Rows of the sheet. A spreadsheet counts its header row, any other format counts records only. */
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
 * Spreadsheets hold the grid of their format and no more cells than our XLSX reader materialises for one workbook
 * (XLSX_MAX_MATERIALISED_CELLS) or, for ODS, than its writer holds in one string (ODS_MAX_CELLS).
 */
const SPREADSHEET_GRIDS: Readonly<Record<SpreadsheetFormat, SpreadsheetGrid>> = {
  xls: { sheet: 'an .xls worksheet', columns: XLS_MAX_COLUMNS, rows: XLS_MAX_ROWS, cells: XLSX_MAX_MATERIALISED_CELLS },
  xlsx: { sheet: 'a worksheet', columns: XLSX_MAX_COLUMNS, rows: XLSX_MAX_ROWS, cells: XLSX_MAX_MATERIALISED_CELLS },
  ods: { sheet: 'a worksheet', columns: XLSX_MAX_COLUMNS, rows: XLSX_MAX_ROWS, cells: ODS_MAX_CELLS },
};

/** A PDF holds the table its page layout draws; Parquet its writer's columns, rows and cells. */
const GRIDS: Readonly<Record<string, Grid>> = {
  ...SPREADSHEET_GRIDS,
  pdf: { sheet: null, columns: PDF_TABLE_MAX_COLUMNS, rows: Infinity, cells: PDF_TABLE_MAX_CELLS },
  parquet: { sheet: null, columns: PARQUET_MAX_COLUMNS, rows: PARQUET_MAX_ROWS, cells: PARQUET_MAX_CELLS },
};

/** Every other table target holds the Parquet bound of cells in memory at once. */
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
