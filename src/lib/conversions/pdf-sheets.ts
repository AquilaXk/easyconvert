/**
 * The sheets of a workbook written from a PDF, as a table extractor lays them out: one sheet for each table the pages hold, named
 * `Page N Table M` after the page it starts on (Camelot's `TableList.export(f='excel')` writes `page-N-table-M`); a table that goes on in
 * the same columns on the next page stays one table. A document with no table gives one sheet `Page N` for each page that has text, a
 * line of text for a row. The tables and the lines come from the one layout pass that writes documents (`layoutPdf`: ruled tables, then
 * aligned text), so a table is the same table in both outputs. A page that OCR read keeps its recognized text as a sheet `Page N`.
 */
import { ConversionFailedError, type ConversionOptions } from '../types';
import { reportConversionWarning } from './conversion-warnings';
import type { DetectedTable, TableCell } from './pdf-layout/types';
import { readPdfContentForOffice, type PdfOfficeContent } from './pdf-office';
import type { ExtractedPdfDocument } from './pdf-text-document';
import { pagesPhrase } from './pdf-text-types';
import type { SheetCell, SheetMerge, WorkbookSheet } from './xlsx-writer';

/** A cell's paragraphs are set apart by a line break; the lines of one paragraph are already joined by a space (`joinLines`). */
const PARAGRAPH_JOINER = '\n';

function cellText(cell: TableCell): SheetCell {
  const text = cell.paragraphs.map((paragraph) => paragraph.text).join(PARAGRAPH_JOINER);
  return text === '' ? null : text;
}

/**
 * The rows of a table in grid columns: a cell that spans columns takes its first column and the ones it covers stay empty, a cell
 * that spans rows is followed by a continuation slot in the rows below. A spanning cell is a merged range with its value in the first cell.
 */
function tableSheet(table: DetectedTable, name: string): WorkbookSheet {
  const merges: SheetMerge[] = [];
  const rows = table.rows.map((row, rowIndex) => {
    const cells: SheetCell[] = Array<SheetCell>(row.reduce((width, cell) => width + cell.colSpan, 0)).fill(null);
    let column = 0;
    for (const cell of row) {
      if (!cell.continuation) {
        cells[column] = cellText(cell);
        if (cell.colSpan > 1 || cell.rowSpan > 1) merges.push({ row: rowIndex, column, rowSpan: cell.rowSpan, columnSpan: cell.colSpan });
      }
      column += cell.colSpan;
    }
    return cells;
  });
  return { name, rows, merges };
}

/** The sheet of a page's lines of text, a line for a row, or none for a page without text. */
function textSheet(pageNumber: number, lines: readonly string[]): WorkbookSheet[] {
  const rows = lines.filter((line) => line.trim() !== '').map((line) => [line]);
  return rows.length === 0 ? [] : [{ name: `Page ${pageNumber}`, rows }];
}

/** What the sheets are made of: the layout of the pages that have a text layer, and the text OCR read from the other pages by page number. */
export interface PdfSheetInput {
  layout: Pick<ExtractedPdfDocument, 'tables' | 'pageText'> | null;
  recognized: ReadonlyMap<number, string>;
}

/** The sheets of a PDF, in page order, the pages whose text beside the tables they leave out, and the text sheets that lost a bare page number. */
export interface PdfSheets {
  sheets: WorkbookSheet[];
  leftOut: number[];
  /** Pages whose text sheet leaves out a bare number as the counter of the page (`pageCounterBlocks`), which the sheet is named after. */
  bareCounterPages: number[];
}

/**
 * The sheets a PDF gives: the tables of the pages with a text layer, and the text of the pages OCR read. A document with no table has a
 * text sheet for every page that has text; with a table, the text outside the tables is left out and `leftOut` says which pages lost it.
 */
export function sheetsOfPdf({ layout, recognized }: PdfSheetInput): PdfSheets {
  const tablesOfPage = new Map<number, DetectedTable[]>();
  for (const table of layout?.tables ?? []) {
    if (recognized.has(table.pageNumber)) continue;
    const onPage = tablesOfPage.get(table.pageNumber);
    if (onPage) onPage.push(table);
    else tablesOfPage.set(table.pageNumber, [table]);
  }
  const linesOfPage = new Map((layout?.pageText ?? []).filter((page) => !recognized.has(page.pageNumber)).map((page) => [page.pageNumber, page.lines]));
  const pageNumbers = [...new Set([...tablesOfPage.keys(), ...linesOfPage.keys(), ...recognized.keys()])].sort((a, b) => a - b);
  const withTables = tablesOfPage.size > 0;
  const sheets = pageNumbers.flatMap((pageNumber): WorkbookSheet[] => {
    const recognizedText = recognized.get(pageNumber);
    if (recognizedText !== undefined) return textSheet(pageNumber, recognizedText.split(/\r?\n/));
    if (withTables) return (tablesOfPage.get(pageNumber) ?? []).map((table, index) => tableSheet(table, `Page ${pageNumber} Table ${index + 1}`));
    return textSheet(pageNumber, linesOfPage.get(pageNumber) ?? []);
  });
  const leftOut = withTables ? pageNumbers.filter((pageNumber) => !recognized.has(pageNumber) && (linesOfPage.get(pageNumber) ?? []).some((line) => line.trim() !== '')) : [];
  // Only pages that get a text sheet, and only a bare number at the head of a page: one at its foot is the page number and goes silently.
  const bareCounterPages = withTables
    ? []
    : (layout?.pageText ?? [])
        .filter((page) => !recognized.has(page.pageNumber) && page.hasHeaderBareCounter && page.lines.some((line) => line.trim() !== ''))
        .map((page) => page.pageNumber);
  return { sheets, leftOut, bareCounterPages };
}

function sheetInputOf(content: PdfOfficeContent): PdfSheetInput {
  if (content.kind === 'layout') return { layout: content.extracted, recognized: new Map() };
  const recognized = new Map(content.pages.filter((page) => content.recognizedPages.has(page.pageNumber)).map((page): [number, string] => [page.pageNumber, page.text]));
  return { layout: content.extracted, recognized };
}

/**
 * The sheets of a PDF's workbook; a document without a text layer is read as `pdf` to a document is (`readPdfContentForOffice`).
 * For the failures see `readPdfContentForOffice` and `layoutPdf`; `writeXlsxWorkbook` refuses a workbook of too many sheets.
 */
export async function readPdfSheets(source: Buffer, options: ConversionOptions): Promise<WorkbookSheet[]> {
  const { sheets, leftOut, bareCounterPages } = sheetsOfPdf(sheetInputOf(await readPdfContentForOffice(source, options)));
  if (sheets.length === 0) throw new ConversionFailedError('PDF has no text to write as sheets.');
  if (leftOut.length > 0) reportConversionWarning(`Left out the text outside the tables of ${pagesPhrase(leftOut)}: a workbook of a PDF that has tables holds the tables.`);
  if (bareCounterPages.length > 0) {
    reportConversionWarning(`Left out the bare number printed on ${pagesPhrase(bareCounterPages)} as a page counter: a text sheet is named after its page.`);
  }
  return sheets;
}
