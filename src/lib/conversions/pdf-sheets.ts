/**
 * The sheets of a workbook written from a PDF, as a table extractor lays them out: one sheet for each table the pages hold, named
 * `Page N Table M` after the page it starts on (Camelot's `TableList.export(f='excel')` writes `page-N-table-M`); a table that goes on in
 * the same columns on the next page stays one table. A document with no table gives one sheet `Page N` for each page that has text, a
 * line of text for a row. The tables and the lines come from the one layout pass that writes documents (`layoutPdf`: ruled tables, then
 * aligned text), so a table is the same table in both outputs. A page that OCR read keeps its recognized text as a sheet `Page N`.
 */
import type { ConversionOptions } from '../types';
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

interface PageSheet {
  pageNumber: number;
  sheet: WorkbookSheet;
}

function tableSheets(tables: DetectedTable[]): PageSheet[] {
  const perPage = new Map<number, number>();
  return tables.map((table) => {
    const number = (perPage.get(table.pageNumber) ?? 0) + 1;
    perPage.set(table.pageNumber, number);
    return { pageNumber: table.pageNumber, sheet: tableSheet(table, `Page ${table.pageNumber} Table ${number}`) };
  });
}

/** The sheet of a page's lines of text, a line for a row, or none for a page without text. */
function textSheet(pageNumber: number, lines: readonly string[]): PageSheet[] {
  const rows = lines.filter((line) => line.trim() !== '').map((line) => [line]);
  return rows.length === 0 ? [] : [{ pageNumber, sheet: { name: `Page ${pageNumber}`, rows } }];
}

/** What the sheets are made of: the layout of the pages that have a text layer, and the text OCR read from the other pages by page number. */
export interface PdfSheetInput {
  layout: Pick<ExtractedPdfDocument, 'tables' | 'pageText'> | null;
  recognized: ReadonlyMap<number, string>;
}

/**
 * The sheets a PDF gives: the tables of the pages with a text layer, and the text of the pages OCR read. A document with no table has a
 * text sheet for every page that has text; with a table, the text outside the tables is left out and the conversion says which pages
 * lost it. Sheets are in page order.
 */
export function sheetsOfPdf({ layout, recognized }: PdfSheetInput): WorkbookSheet[] {
  const tables = tableSheets((layout?.tables ?? []).filter((table) => !recognized.has(table.pageNumber)));
  const layoutPages = (layout?.pageText ?? []).filter((page) => !recognized.has(page.pageNumber));
  const recognizedSheets = [...recognized].flatMap(([pageNumber, text]) => textSheet(pageNumber, text.split(/\r?\n/)));
  let sheets: PageSheet[];
  if (tables.length === 0) {
    sheets = [...layoutPages.flatMap((page) => textSheet(page.pageNumber, page.lines)), ...recognizedSheets];
  } else {
    sheets = [...tables, ...recognizedSheets];
    const leftOut = layoutPages.filter((page) => page.lines.some((line) => line.trim() !== '')).map((page) => page.pageNumber);
    if (leftOut.length > 0) reportConversionWarning(`Left out the text outside the tables of ${pagesPhrase(leftOut)}: a workbook of a PDF that has tables holds the tables.`);
  }
  return sheets.sort((a, b) => a.pageNumber - b.pageNumber).map((entry) => entry.sheet);
}

function sheetInputOf(content: PdfOfficeContent): PdfSheetInput {
  if (content.kind === 'layout') return { layout: content.extracted, recognized: new Map() };
  const recognized = content.pages.filter((page) => content.recognizedPages.has(page.pageNumber)).map((page): [number, string] => [page.pageNumber, page.text]);
  return { layout: content.extracted, recognized: new Map(recognized) };
}

/**
 * The sheets of a PDF's workbook; a document without a text layer is read as `pdf` to a document is (`readPdfContentForOffice`).
 * For the failures see `readPdfContentForOffice` and `layoutPdf`; `writeXlsxWorkbook` refuses a workbook of too many sheets.
 */
export async function readPdfSheets(source: Buffer, options: ConversionOptions): Promise<WorkbookSheet[]> {
  return sheetsOfPdf(sheetInputOf(await readPdfContentForOffice(source, options)));
}
