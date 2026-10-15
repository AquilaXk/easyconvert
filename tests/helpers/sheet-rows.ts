import { execFileSync } from 'node:child_process';
import { requireOracleTool } from './differential-oracle';
import { sofficeConvert } from './soffice-office';

/**
 * Reads the cells of a spreadsheet package the way an office suite does: LibreOffice opens the file and exports
 * its first sheet as CSV, and Python's csv module (RFC 4180) splits that CSV into fields. Neither is the code
 * that wrote the package, so a spreadsheet writer is proven by what an independent reader finds in its output.
 */

/** LibreOffice CSV export filter: comma separator, double-quote text delimiter, UTF-8, from the first row. */
const LIBREOFFICE_CSV_FILTER = 'csv:Text - txt - csv (StarCalc):44,34,76,1';
/** Same filter with the cell contents exported "as shown" (token 9): `34.2%` and `$1,250,000.50` instead of `0.342` and `1250000.5`. */
const LIBREOFFICE_CSV_AS_SHOWN = 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true';
/** Reads CSV from stdin (UTF-8, newlines untouched as the csv module requires) and prints the rows as JSON. */
const PYTHON_CSV_READER = [
  'import csv, io, json, sys',
  'reader = csv.reader(io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", newline=""), delimiter=sys.argv[1])',
  'print(json.dumps(list(reader)))',
].join('\n');

/** Splits CSV text into rows of fields with Python's csv module. */
export function parseCsvWithPython(text: string, delimiter = ','): string[][] {
  const output = execFileSync(requireOracleTool('python3'), ['-c', PYTHON_CSV_READER, delimiter], {
    input: text,
    encoding: 'utf-8',
  });
  return JSON.parse(output) as string[][];
}

/** The rows of the first sheet of an `ods` or `xlsx` package, as an office suite reads them. */
export function sheetRowsViaLibreOffice(file: Buffer, extension: 'ods' | 'xlsx'): string[][] {
  const csv = sofficeConvert(file, extension, LIBREOFFICE_CSV_FILTER, 'csv').toString('utf-8');
  return parseCsvWithPython(csv);
}

/** The rows of the first sheet of an `ods` or `xlsx` package with every cell as the office suite displays it, number formats applied. */
export function shownSheetRowsViaLibreOffice(file: Buffer, extension: 'ods' | 'xlsx'): string[][] {
  const csv = sofficeConvert(file, extension, LIBREOFFICE_CSV_AS_SHOWN, 'csv').toString('utf-8');
  return parseCsvWithPython(csv);
}
