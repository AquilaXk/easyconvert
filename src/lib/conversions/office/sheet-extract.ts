import { ConversionOptions, UnsupportedTargetError } from '../../types';
import { ZIP_LOCAL_HEADER_SIGNATURE, openOpcPackage, startsWithBytes } from '../package-access';
import { isCfbfContainer } from '../cfbf-reader';
import { delimitedSheetRows, parseJsonTableRows } from '../sheet-text-tables';
import { parseAllXlsxWorksheets } from './xlsx-parse';
import { readCfbfWorkbookSheet } from './xls-parse';
import { type OfficeWorksheet } from './types';

/**
 * Extracts 2D array of rows from CSV, TSV, JSON, or XLSX for Office Generation
 */
export async function extractRowsForOffice(
  inputBuffer: Buffer,
  src: string,
  options: ConversionOptions
): Promise<string[][]> {
  if (src === 'xlsx') {
    // A workbook that cannot be read is refused: re-reading its ZIP bytes as CSV text would answer with junk rows.
    const zip = await openOpcPackage(inputBuffer, 'XLSX');
    const allSheets = await parseAllXlsxWorksheets(zip);
    if (allSheets.length === 1) return allSheets[0].rows;
    const merged: string[][] = [];
    allSheets.forEach((sheet, idx) => {
      if (idx > 0 && sheet.rows.length > 0) {
        merged.push([`### Sheet: ${sheet.name}`]);
      }
      merged.push(...sheet.rows);
    });
    return merged;
  }

  if (src === 'et') {
    // A Kingsoft workbook is an OOXML package or a BIFF8 compound file; neither is CSV text.
    if (startsWithBytes(inputBuffer, ZIP_LOCAL_HEADER_SIGNATURE)) return extractRowsForOffice(inputBuffer, 'xlsx', options);
    if (isCfbfContainer(inputBuffer)) return readCfbfWorkbookSheet(inputBuffer).toRows();
  }
  if (src === 'pdf') throw new UnsupportedTargetError('A PDF is read for a workbook by its tables and pages (readPdfSheets), never as rows of delimited text.');
  const text = inputBuffer.toString('utf-8');
  return src === 'json' ? parseJsonTableRows(text) : delimitedSheetRows(text, src, options);
}

/**
 * Discovers and extracts all worksheets from an office spreadsheet document
 */
export async function extractAllSheetsForOffice(
  inputBuffer: Buffer,
  src: string,
  options: ConversionOptions = {}
): Promise<OfficeWorksheet[]> {
  if (src === 'xlsx') {
    const zip = await openOpcPackage(inputBuffer, 'XLSX');
    return parseAllXlsxWorksheets(zip);
  }
  const rows = await extractRowsForOffice(inputBuffer, src, options);
  return [{ name: 'Sheet1', rows }];
}
