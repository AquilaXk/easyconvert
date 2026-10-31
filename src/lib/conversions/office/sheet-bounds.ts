import { SheetLimitError } from '../../types';

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
 * The sheets of a table written to a format that has no writer-side grid check (ODS) are bound as an XLSX worksheet is, since the office suite
 * reads them on the same grid: 16,384 columns and 1,048,576 rows a sheet, 10,000 sheets a workbook. A table past a bound is refused with a
 * typed limit error, never cut. The sheets are returned as they are.
 */
export function assertSheetsWithinGrid<Sheet extends { rows: readonly (readonly unknown[])[] }>(sheets: Sheet[]): Sheet[] {
  if (sheets.length > WORKBOOK_MAX_SHEETS) throw sheetLimitError('The workbook', sheets.length, 'sheets', 'a workbook', WORKBOOK_MAX_SHEETS);
  let cells = 0;
  for (const sheet of sheets) {
    if (sheet.rows.length > XLSX_MAX_ROWS) throw sheetLimitError('The table', sheet.rows.length, 'rows', 'a worksheet', XLSX_MAX_ROWS);
    for (const row of sheet.rows) {
      if (row.length > XLSX_MAX_COLUMNS) throw sheetLimitError('The table', row.length, 'columns', 'a worksheet', XLSX_MAX_COLUMNS);
      cells += row.length;
    }
  }
  if (cells > ODS_MAX_CELLS) throw sheetLimitError('The workbook', cells, 'cells', 'an OpenDocument spreadsheet this engine writes', ODS_MAX_CELLS);
  return sheets;
}
