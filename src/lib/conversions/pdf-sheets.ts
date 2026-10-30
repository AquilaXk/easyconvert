import type { ConversionOptions } from '../types';
import { WORKBOOK_MAX_SHEETS, sheetLimitError } from './office/sheet-bounds';
import { detectPdfTables, pdfTextRows } from './pdf-layout';
import type { DetectedTable } from './pdf-layout/types';
import { readPdfContentForOffice, type PdfOfficeContent } from './pdf-office';
import type { PdfContentFont, PdfPageContent } from './pdf-text-types';
import type { SheetCell, SheetMerge, WorkbookSheet } from './xlsx-writer';

/**
 * The sheets of a workbook written from a PDF, as a table extractor lays them out: one sheet for each table the pages hold, named
 * `Page N Table M` after the page it starts on (Camelot's `TableList.export(f='excel')` writes `page-N-table-M`); a table that goes on in
 * the same columns on the next page stays one table. A document with no table gives one sheet `Page N` for each page, a line of text
 * for a row and the pieces of a line that sit apart in the columns of its row. Tables are found by the layout analysis that writes
 * documents (`pdf-layout`: ruled tables, then aligned text), so a table is the same table in both outputs.
 */

const TABLE_CELL_JOINER = '\n';

function cellText(cell: DetectedTable['rows'][number][number]): SheetCell {
  const text = cell.paragraphs.map((paragraph) => paragraph.text).join(TABLE_CELL_JOINER);
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

function tableSheets(tables: DetectedTable[]): WorkbookSheet[] {
  const perPage = new Map<number, number>();
  return tables.map((table) => {
    const number = (perPage.get(table.pageNumber) ?? 0) + 1;
    perPage.set(table.pageNumber, number);
    return tableSheet(table, `Page ${table.pageNumber} Table ${number}`);
  });
}

function textSheet(pageNumber: number, rows: string[][]): WorkbookSheet {
  return { name: `Page ${pageNumber}`, rows };
}

/** The lines of text OCR read from a page, one for a row. */
function lineRows(text: string): string[][] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => [line]);
}

function layoutSheets(pages: PdfPageContent[], fonts: PdfContentFont[]): WorkbookSheet[] {
  const tables = detectPdfTables(pages, fonts);
  if (tables.length > 0) return tableSheets(tables);
  return pages.map((page) => textSheet(page.pageNumber, pdfTextRows(page, fonts)));
}

/** The sheets a PDF's content gives. @throws SheetLimitError (413) for more than WORKBOOK_MAX_SHEETS sheets. */
export function sheetsOfPdfContent(content: PdfOfficeContent): WorkbookSheet[] {
  const sheets =
    content.kind === 'layout'
      ? layoutSheets(content.extracted.pages, content.extracted.fonts)
      : content.pages.map((page) => textSheet(page.pageNumber, lineRows(page.text)));
  if (sheets.length > WORKBOOK_MAX_SHEETS) throw sheetLimitError('The PDF', sheets.length, 'sheets of tables or pages', 'a workbook', WORKBOOK_MAX_SHEETS);
  return sheets;
}

/**
 * The sheets of a PDF's workbook; a document without a text layer is read as `pdf` to a document is (`readPdfContentForOffice`).
 * @throws SheetLimitError (413) for more than WORKBOOK_MAX_SHEETS sheets; for the other failures see `readPdfContentForOffice` and `detectPdfTables`.
 */
export async function readPdfSheets(source: Buffer, options: ConversionOptions): Promise<WorkbookSheet[]> {
  return sheetsOfPdfContent(await readPdfContentForOffice(source, options));
}
