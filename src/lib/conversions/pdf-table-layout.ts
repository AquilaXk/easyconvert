import PDFDocument from 'pdfkit';
import { ConversionFailedError, PayloadLimitError } from '../types';
import { PdfUnicodeTextWriter, loadFontCoverageIndex } from './pdf-fonts';

/**
 * Table writer shared by the in-process spreadsheet and data to PDF paths. It draws only the cells it is
 * given: the document title goes into the PDF metadata, sheet names become outline entries, every row is
 * drawn (paginated, with the header rows repeated), cell text wraps and grows the row instead of being cut,
 * and a table wider than the page continues in further column groups.
 */

/** Most cells (rows times columns, over all sheets) one document may hold before it is refused with HTTP 413. */
export const PDF_TABLE_MAX_CELLS = 1_000_000;
/** Most columns one sheet may hold. */
export const PDF_TABLE_MAX_COLUMNS = 16_384;

const PAGE_SIZE = 'A4';
const PAGE_MARGIN = 36;
const FONT_SIZE = 9;
const CELL_PADDING_X = 4;
const CELL_PADDING_Y = 3;
const BORDER_WIDTH = 0.5;
/** Narrowest a column is squeezed to before the table continues in another column group. */
const MIN_COLUMN_WIDTH = 64;
/** Widest a column grows on its own; longer text wraps. */
const MAX_COLUMN_WIDTH = 360;
const SPREADSHEET_UNIT_HINT_MIN = 20;
const DEFAULT_TEXT_COLOR = '#1F2340';
const HEADER_FILL = '#F0F2FE';
const HEADER_BORDER = '#CCD2FC';
const BODY_BORDER = '#E1E4EE';
const NO_FILL = '';

export interface PdfTableCell {
  readonly text: string;
  readonly fill?: string;
  readonly fontColor?: string;
  readonly align?: 'left' | 'center' | 'right';
  readonly borderColor?: string;
}

export interface PdfTableSheet {
  /** Becomes an outline entry on the sheet's first page; omit for a document with one anonymous table. */
  readonly name?: string;
  readonly rows: readonly (readonly PdfTableCell[])[];
  /** Leading rows repeated at the top of every page. */
  readonly headerRows: number;
  /** Preferred column widths in points, where the source states them. */
  readonly widthHints?: readonly (number | undefined)[];
}

export interface PdfTableDocumentOptions {
  readonly title?: string;
  readonly orientation: 'portrait' | 'landscape';
  readonly customFontPath?: string;
}

interface SheetMetrics {
  columnCount: number;
  /** Natural single-line width of each column in points, padding included. */
  natural: Float64Array;
  /** Single-line width of every cell, row-major. */
  cellWidths: Float32Array;
  lineHeights: Float32Array;
}

function countCells(sheets: readonly PdfTableSheet[]): number {
  let cells = 0;
  for (const sheet of sheets) {
    const columns = sheet.rows.reduce((widest, row) => Math.max(widest, row.length), 0);
    if (columns > PDF_TABLE_MAX_COLUMNS) {
      throw new PayloadLimitError(`A table has ${columns} columns, more than the ${PDF_TABLE_MAX_COLUMNS} column limit.`);
    }
    cells += columns * sheet.rows.length;
    if (cells > PDF_TABLE_MAX_CELLS) {
      throw new PayloadLimitError(`The tables hold more than ${PDF_TABLE_MAX_CELLS} cells, over the limit of the in-process PDF writer.`);
    }
  }
  return cells;
}

/** Measures every cell once, in the font that will draw it. */
function measureSheet(sheet: PdfTableSheet, writer: PdfUnicodeTextWriter): SheetMetrics {
  const columnCount = sheet.rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const natural = new Float64Array(columnCount);
  const cellWidths = new Float32Array(columnCount * sheet.rows.length);
  const lineHeights = new Float32Array(columnCount * sheet.rows.length);
  sheet.rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (cell.text.length === 0) return;
      const { width, lineHeight } = writer.measure(cell.text);
      cellWidths[r * columnCount + c] = width;
      lineHeights[r * columnCount + c] = lineHeight;
      natural[c] = Math.max(natural[c], Math.min(width + 2 * CELL_PADDING_X, MAX_COLUMN_WIDTH));
    });
  });
  sheet.widthHints?.forEach((hint, c) => {
    if (hint !== undefined && hint > SPREADSHEET_UNIT_HINT_MIN && c < columnCount) {
      natural[c] = Math.min(Math.max(natural[c], hint), MAX_COLUMN_WIDTH);
    }
  });
  return { columnCount, natural, cellWidths, lineHeights };
}

/** Splits the columns into groups whose narrowest widths fit the page, in column order. */
function groupColumns(natural: Float64Array, contentWidth: number): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let used = 0;
  for (let c = 0; c < natural.length; c++) {
    const narrowest = Math.min(Math.max(natural[c], 2 * CELL_PADDING_X), MIN_COLUMN_WIDTH);
    if (current.length > 0 && used + narrowest > contentWidth) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(c);
    used += narrowest;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Column widths of one group: natural widths when they fit, otherwise squeezed in proportion to what each can give up. */
function groupWidths(natural: Float64Array, group: readonly number[], contentWidth: number): number[] {
  const wanted = group.map((c) => Math.max(natural[c], 2 * CELL_PADDING_X));
  const narrowest = wanted.map((w) => Math.min(w, MIN_COLUMN_WIDTH));
  const wantedTotal = wanted.reduce((sum, w) => sum + w, 0);
  if (wantedTotal <= contentWidth) return wanted;
  const spare = contentWidth - narrowest.reduce((sum, w) => sum + w, 0);
  const extra = wanted.map((w, i) => w - narrowest[i]);
  const extraTotal = extra.reduce((sum, e) => sum + e, 0);
  return narrowest.map((w, i) => w + (extraTotal > 0 ? (spare * extra[i]) / extraTotal : 0));
}

class SheetPainter {
  constructor(
    private readonly doc: PDFKit.PDFDocument,
    private readonly writer: PdfUnicodeTextWriter,
    private readonly sheet: PdfTableSheet,
    private readonly metrics: SheetMetrics,
    private readonly pageOptions: { size: string; layout: 'portrait' | 'landscape'; margin: number }
  ) {}

  private get bottom(): number {
    return this.doc.page.height - this.pageOptions.margin;
  }

  /** Height of row `r` over the columns of a group: the tallest wrapped cell. */
  private rowHeight(r: number, group: readonly number[], widths: readonly number[]): number {
    const row = this.sheet.rows[r];
    let tallest = 0;
    group.forEach((c, index) => {
      const cell = row[c];
      if (!cell || cell.text.length === 0) return;
      const available = widths[index] - 2 * CELL_PADDING_X;
      const slot = r * this.metrics.columnCount + c;
      if (this.metrics.cellWidths[slot] <= available && !cell.text.includes('\n')) {
        tallest = Math.max(tallest, this.metrics.lineHeights[slot]);
      } else {
        this.doc.fontSize(FONT_SIZE);
        tallest = Math.max(tallest, this.writer.heightOf(cell.text, { width: available, lineGap: 0 }));
      }
    });
    return tallest + 2 * CELL_PADDING_Y;
  }

  private drawRow(r: number, group: readonly number[], widths: readonly number[], y: number, height: number, isHeader: boolean): void {
    const row = this.sheet.rows[r];
    let x = this.pageOptions.margin;
    group.forEach((c, index) => {
      const cell = row[c];
      const width = widths[index];
      const fill = cell?.fill ?? (isHeader ? HEADER_FILL : NO_FILL);
      if (fill) this.doc.rect(x, y, width, height).fill(fill);
      this.doc.rect(x, y, width, height).strokeColor(cell?.borderColor ?? (isHeader ? HEADER_BORDER : BODY_BORDER)).lineWidth(BORDER_WIDTH).stroke();
      if (cell && cell.text.length > 0) {
        this.doc.fontSize(FONT_SIZE).fillColor(cell.fontColor ?? DEFAULT_TEXT_COLOR);
        this.writer.write(
          cell.text,
          { width: width - 2 * CELL_PADDING_X, align: cell.align ?? 'left', lineGap: 0 },
          x + CELL_PADDING_X,
          y + CELL_PADDING_Y
        );
      }
      x += width;
    });
  }

  /** Draws the whole sheet, group by group; `freshPage` says the open page is still empty and can be used. */
  paint(freshPage: boolean): void {
    const contentWidth = this.doc.page.width - 2 * this.pageOptions.margin;
    const groups = groupColumns(this.metrics.natural, contentWidth);
    const headerRows = Math.min(this.sheet.headerRows, this.sheet.rows.length);
    const usable = this.bottom - this.pageOptions.margin;
    let useOpenPage = freshPage;
    groups.forEach((group, groupIndex) => {
      const widths = groupWidths(this.metrics.natural, group, contentWidth);
      const headerHeights = Array.from({ length: headerRows }, (_, r) => this.rowHeight(r, group, widths));
      const headerTotal = headerHeights.reduce((sum, h) => sum + h, 0);
      let y = this.pageOptions.margin;
      for (let r = 0; r < this.sheet.rows.length; r++) {
        const isHeader = r < headerRows;
        const height = isHeader ? headerHeights[r] : this.rowHeight(r, group, widths);
        if (headerTotal + (isHeader ? 0 : height) > usable || height > usable) {
          throw new ConversionFailedError(
            `Row ${r + 1} is taller than a page (${Math.ceil(height)}pt): the in-process PDF writer cannot split one row across pages.`
          );
        }
        const startsGroup = r === 0;
        if (startsGroup || (!isHeader && y + height > this.bottom)) {
          if (startsGroup && useOpenPage) {
            useOpenPage = false;
          } else {
            this.doc.addPage(this.pageOptions);
          }
          y = this.pageOptions.margin;
          if (startsGroup && groupIndex === 0 && this.sheet.name) this.doc.outline.addItem(this.sheet.name);
          if (!isHeader) {
            headerHeights.forEach((h, headerRow) => {
              this.drawRow(headerRow, group, widths, y, h, true);
              y += h;
            });
          }
        }
        this.drawRow(r, group, widths, y, height, isHeader);
        y += height;
      }
    });
  }
}

/**
 * Renders the sheets as tables in an A4 PDF. Throws a ConversionFailedError for a row that cannot fit one
 * page, a PayloadLimitError (413) above PDF_TABLE_MAX_CELLS, and an EngineUnavailableError when no installed
 * font covers a character.
 */
export async function renderPdfTables(sheets: readonly PdfTableSheet[], options: PdfTableDocumentOptions): Promise<Buffer> {
  if (sheets.length === 0 || sheets.every((sheet) => sheet.rows.length === 0)) {
    throw new ConversionFailedError('The table has no rows to draw.');
  }
  countCells(sheets);
  await loadFontCoverageIndex();
  return new Promise<Buffer>((resolve, reject) => {
    const pageOptions = { size: PAGE_SIZE, layout: options.orientation, margin: PAGE_MARGIN };
    const doc = new PDFDocument({ ...pageOptions, autoFirstPage: false, info: options.title ? { Title: options.title } : {} });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      const writer = new PdfUnicodeTextWriter(doc, options.customFontPath);
      doc.addPage(pageOptions);
      let freshPage = true;
      for (const sheet of sheets) {
        if (sheet.rows.length === 0) continue;
        doc.fontSize(FONT_SIZE);
        const metrics = measureSheet(sheet, writer);
        new SheetPainter(doc, writer, sheet, metrics, pageOptions).paint(freshPage);
        freshPage = false;
      }
    } catch (err) {
      reject(err);
      return;
    }
    doc.end();
  });
}
