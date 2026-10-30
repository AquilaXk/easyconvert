import JSZip from 'jszip';
import { readZipEntryPrefix } from '../zip-entry-reader';
import { XLS_MAX_COLUMNS, XLS_MAX_ROWS, sheetLimitError } from './sheet-bounds';

/**
 * A workbook that is written as `.xls` has to fit the BIFF8 sheet. The office suite's `MS Excel 97` export drops the rows past 65,536
 * and the columns past 256 without a word (measured: a 70,001-row sheet comes back as 65,536 rows and a 300-column sheet as 256),
 * so the size is read from the worksheet parts first and a workbook that does not fit is refused.
 */

/** The `<dimension>` element is the first or second child of `<worksheet>`; this many bytes of the part always reach it. */
const DIMENSION_PROBE_BYTES = 16 * 1024;
const WORKSHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/i;
const DIMENSION_REF = /<dimension\s[^>]*?ref="\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?"/;

function columnNumber(letters: string): number {
  let number = 0;
  for (const letter of letters) number = number * 26 + letter.charCodeAt(0) - 64;
  return number;
}

const limitError = (sheetPart: string, what: string, count: number, limit: number): Error =>
  sheetLimitError(`The workbook (${sheetPart})`, count, what, 'an .xls worksheet', limit);

/**
 * Refuses (413) an XLSX package with a worksheet whose declared `dimension` runs past row 65,536 or column 256. A worksheet that
 * declares no dimension, and a package that is not a ZIP, are left to the office suite.
 */
export async function assertWorkbookFitsXls(xlsx: Buffer): Promise<void> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(xlsx);
  } catch {
    return;
  }
  for (const entry of zip.file(WORKSHEET_PART)) {
    const match = DIMENSION_REF.exec(await readZipEntryPrefix(entry, DIMENSION_PROBE_BYTES));
    if (match === null) continue;
    const lastColumn = columnNumber(match[3] ?? match[1]);
    const lastRow = Number(match[4] ?? match[2]);
    if (lastRow > XLS_MAX_ROWS) throw limitError(entry.name, 'rows', lastRow, XLS_MAX_ROWS);
    if (lastColumn > XLS_MAX_COLUMNS) throw limitError(entry.name, 'columns', lastColumn, XLS_MAX_COLUMNS);
  }
}
