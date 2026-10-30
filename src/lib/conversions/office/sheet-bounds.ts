import { DataLimitExceededError } from '../../types';

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
export function sheetLimitError(subject: string, count: number, what: string, sheet: string, limit: number): DataLimitExceededError {
  return new DataLimitExceededError(`${subject} has ${count} ${what}, and ${sheet} holds at most ${limit}; nothing was cut.`);
}
