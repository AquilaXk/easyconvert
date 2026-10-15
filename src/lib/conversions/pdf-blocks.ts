import PDFDocument from 'pdfkit';
import { ConversionFailedError, EngineUnavailableError } from '../types';
import { PdfUnicodeTextWriter, loadFontCoverageIndex, type PdfTextSegment } from './pdf-fonts';

/**
 * Structured document model drawn by the in-process PDF writers (HTML, Markdown, plain text and
 * HWP to PDF). Each block is drawn with fonts that cover its text; nothing is added that is not
 * document content.
 */
export type PdfBlock =
  | { kind: 'heading'; level: number; content: PdfTextSegment[] }
  | { kind: 'paragraph'; content: PdfTextSegment[] }
  | { kind: 'preformatted'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: PdfBlock[][]; markers?: readonly string[] }
  | { kind: 'table'; rows: PdfTableCell[][] }
  | { kind: 'image'; image: PdfRasterImage }
  | { kind: 'quote'; blocks: PdfBlock[] }
  | { kind: 'rule' }
  | { kind: 'pageBreak' };

/**
 * A table cell and the number of columns it spans. A cell that merges downward states `rowSpan`, and each grid position
 * it covers in the rows below is listed as a `covered` cell (no content, no border of its own).
 */
export interface PdfTableCell {
  readonly content: PdfTextSegment[];
  readonly span: number;
  readonly rowSpan?: number;
  readonly covered?: boolean;
}

/** A decoded-and-verified PNG or JPEG image with its pixel size. */
export interface PdfRasterImage {
  readonly data: Buffer;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** Page size and margins in points, for documents that state their own (otherwise A4 with 50 pt margins). */
export interface PdfPageGeometry {
  readonly widthPt: number;
  readonly heightPt: number;
  readonly marginTopPt: number;
  readonly marginRightPt: number;
  readonly marginBottomPt: number;
  readonly marginLeftPt: number;
}

export interface PdfBlockDocumentOptions {
  page?: PdfPageGeometry;
  spacing?: PdfSpacing;
  orientation?: 'portrait' | 'landscape';
  /** Document title stored in the PDF metadata (never drawn on the page). */
  title?: string;
  /** Font file tried before the installed fonts. */
  customFontPath?: string;
}

const PAGE_SIZE = 'A4';
const PAGE_MARGIN = 50;
const BODY_FONT_SIZE = 11;
const TABLE_FONT_SIZE = 10;
const PREFORMATTED_FONT_SIZE = 10;
/** Font sizes for h1 to h6. */
const HEADING_FONT_SIZES: readonly number[] = [20, 16, 14, 12, 11, 11];
const LINE_GAP = 2;
const BLOCK_GAP_LINES = 0.5;
const LIST_ITEM_GAP_LINES = 0.2;
const HEADING_TOP_GAP_LINES = 0.4;

/** Vertical gaps between lines and blocks, in points (line gap) and body lines. */
export interface PdfSpacing {
  readonly lineGap: number;
  readonly blockGapLines: number;
  readonly listItemGapLines: number;
  readonly headingTopGapLines: number;
}

const DEFAULT_SPACING: PdfSpacing = { lineGap: LINE_GAP, blockGapLines: BLOCK_GAP_LINES, listItemGapLines: LIST_ITEM_GAP_LINES, headingTopGapLines: HEADING_TOP_GAP_LINES };

/** Tighter gaps that follow a word processor's default of no space between paragraphs. */
export const PDF_DOCUMENT_SPACING: PdfSpacing = { lineGap: 0.5, blockGapLines: 0.25, listItemGapLines: 0, headingTopGapLines: 0.3 };
const LIST_MARKER_WIDTH = 22;
/** Width reserved per character of a list marker wider than the default marker column, and the gap after it. */
const MARKER_CHARACTER_WIDTH = 6.5;
const MARKER_GAP = 8;
const QUOTE_INDENT = 18;
const BULLET_MARKER = '•';
const TABLE_CELL_PADDING = 4;
const TABLE_BORDER_WIDTH = 0.5;
const MIN_TABLE_COLUMN_WIDTH = 24;
/** Narrowest text column left after list and quote indentation. */
const MIN_TEXT_WIDTH = 72;
const RULE_SPACING = 6;
const RULE_WIDTH = 0.75;
/** CSS pixel to PDF point (96 px per inch, 72 pt per inch). */
const PX_TO_PT = 0.75;

class PdfBlockRenderer {
  constructor(
    private readonly doc: PDFKit.PDFDocument,
    private readonly writer: PdfUnicodeTextWriter,
    private readonly spacing: PdfSpacing = DEFAULT_SPACING
  ) {}

  private get left(): number {
    return this.doc.page.margins.left;
  }

  private get top(): number {
    return this.doc.page.margins.top;
  }

  private get contentWidth(): number {
    return this.doc.page.width - this.doc.page.margins.left - this.doc.page.margins.right;
  }

  private get bottom(): number {
    return this.doc.page.maxY();
  }

  /** Width left for text at this indentation; deep list and quote nesting fails instead of squeezing text out. */
  private textWidth(indent: number): number {
    const width = this.contentWidth - indent;
    if (width < MIN_TEXT_WIDTH) {
      throw new ConversionFailedError(
        `Lists and block quotes nest too deeply for the page: ${Math.max(0, Math.floor(width))}pt of text width is left and the in-process PDF renderer needs at least ${MIN_TEXT_WIDTH}pt`
      );
    }
    return width;
  }

  render(blocks: readonly PdfBlock[], indent = 0, gapLines = this.spacing.blockGapLines): void {
    for (const block of blocks) {
      this.renderBlock(block, indent, gapLines);
    }
  }

  private renderBlock(block: PdfBlock, indent: number, gapLines: number): void {
    switch (block.kind) {
      case 'heading':
        this.renderHeading(block.level, block.content, indent);
        return;
      case 'paragraph':
        this.renderText(block.content, BODY_FONT_SIZE, indent, gapLines);
        return;
      case 'preformatted':
        this.renderText([{ text: block.text }], PREFORMATTED_FONT_SIZE, indent, gapLines);
        return;
      case 'list':
        this.renderList(block.ordered, block.start, block.items, indent, block.markers);
        return;
      case 'table':
        this.renderTable(block.rows, indent);
        return;
      case 'image':
        this.renderImage(block.image, indent);
        return;
      case 'quote':
        this.textWidth(indent + QUOTE_INDENT);
        this.render(block.blocks, indent + QUOTE_INDENT, gapLines);
        return;
      case 'rule':
        this.renderRule(indent);
        return;
      case 'pageBreak':
        this.doc.addPage();
        return;
    }
  }

  private hasText(content: readonly PdfTextSegment[]): boolean {
    return content.some((segment) => segment.text.trim().length > 0);
  }

  private renderHeading(level: number, content: readonly PdfTextSegment[], indent: number): void {
    if (!this.hasText(content)) return;
    const size = HEADING_FONT_SIZES[Math.min(Math.max(level, 1), HEADING_FONT_SIZES.length) - 1];
    this.doc.fontSize(size);
    if (this.doc.y > this.top) this.doc.moveDown(this.spacing.headingTopGapLines);
    this.renderText(content, size, indent, this.spacing.blockGapLines);
  }

  private renderText(content: readonly PdfTextSegment[], size: number, indent: number, gapLines: number): void {
    if (!this.hasText(content)) return;
    this.doc.fontSize(size);
    this.writer.write(content, { width: this.textWidth(indent), lineGap: this.spacing.lineGap }, this.left + indent, this.doc.y);
    this.doc.x = this.left;
    this.doc.moveDown(gapLines);
  }

  private renderList(ordered: boolean, start: number, items: readonly PdfBlock[][], indent: number, markers?: readonly string[]): void {
    const markerWidth = markers ? Math.max(LIST_MARKER_WIDTH, ...markers.map((marker) => marker.length * MARKER_CHARACTER_WIDTH + MARKER_GAP)) : LIST_MARKER_WIDTH;
    const itemIndent = indent + markerWidth;
    this.textWidth(itemIndent);
    items.forEach((item, index) => {
      this.doc.fontSize(BODY_FONT_SIZE);
      const lineHeight = this.doc.currentLineHeight(true) + this.spacing.lineGap;
      if (this.doc.y + lineHeight > this.bottom) this.doc.addPage();
      const top = this.doc.y;
      const page = this.doc.page;
      const marker = markers?.[index] ?? (ordered ? `${start + index}.` : BULLET_MARKER);
      this.writer.write(marker, { lineBreak: false }, this.left + indent, top);
      this.doc.y = top;
      this.render(item, itemIndent, this.spacing.listItemGapLines);
      if (this.doc.page === page) this.doc.y = Math.max(this.doc.y, top + lineHeight);
      this.doc.x = this.left;
    });
    this.doc.moveDown(this.spacing.blockGapLines);
  }

  private renderTable(rows: readonly PdfTableCell[][], indent: number): void {
    const columnCount = rows.reduce((widest, row) => Math.max(widest, row.reduce((sum, cell) => sum + cell.span, 0)), 0);
    if (columnCount === 0) return;
    const tableWidth = this.textWidth(indent);
    const columnWidth = tableWidth / columnCount;
    if (columnWidth < MIN_TABLE_COLUMN_WIDTH) {
      throw new EngineUnavailableError(
        'soffice',
        `a table with ${columnCount} columns does not fit the page width; the in-process PDF renderer needs columns of at least ${MIN_TABLE_COLUMN_WIDTH}pt`
      );
    }
    const x0 = this.left + indent;
    this.doc.fontSize(TABLE_FONT_SIZE);
    const minRowHeight = this.doc.currentLineHeight(true) + TABLE_CELL_PADDING * 2;

    // Where every cell sits, and how tall its text needs the cell to be.
    interface PlacedCell {
      readonly cell: PdfTableCell;
      readonly x: number;
      readonly width: number;
      readonly rowSpan: number;
      readonly needed: number;
    }
    const placedRows: PlacedCell[][] = rows.map((row) => {
      let column = 0;
      return row.map((cell) => {
        const span = Math.min(cell.span, columnCount - column);
        const width = span * columnWidth;
        const x = x0 + column * columnWidth;
        column += span;
        const hasContent = !cell.covered && this.hasText(cell.content);
        const textHeight = hasContent ? this.writer.heightOf(cell.content, { width: width - TABLE_CELL_PADDING * 2, lineGap: this.spacing.lineGap }) : 0;
        return { cell, x, width, rowSpan: Math.max(1, cell.rowSpan ?? 1), needed: hasContent ? textHeight + TABLE_CELL_PADDING * 2 : 0 };
      });
    });
    const heights = placedRows.map((row) => row.reduce((tallest, placed) => (placed.rowSpan === 1 ? Math.max(tallest, placed.needed) : tallest), minRowHeight));
    // A cell that merges downward grows its last row when its text is taller than the rows it spans.
    placedRows.forEach((row, rowIndex) => {
      for (const placed of row) {
        if (placed.rowSpan === 1) continue;
        const last = Math.min(rowIndex + placed.rowSpan, heights.length) - 1;
        const spanned = heights.slice(rowIndex, last + 1).reduce((sum, height) => sum + height, 0);
        if (spanned < placed.needed) heights[last] += placed.needed - spanned;
      }
    });
    const pageHeight = this.bottom - this.top;
    if (heights.some((height) => height > pageHeight)) {
      throw new EngineUnavailableError('soffice', 'a table row is taller than a page; the in-process PDF renderer cannot split table cells across pages');
    }

    placedRows.forEach((row, rowIndex) => {
      // Rows that a merged cell starting here spans stay on the page with it.
      const groupHeight = row.reduce((tallest, placed) => {
        const last = Math.min(rowIndex + placed.rowSpan, heights.length) - 1;
        return Math.max(tallest, heights.slice(rowIndex, last + 1).reduce((sum, height) => sum + height, 0));
      }, heights[rowIndex]);
      if (this.doc.y + groupHeight > this.bottom) this.doc.addPage();
      const y = this.doc.y;
      this.doc.fontSize(TABLE_FONT_SIZE);
      this.doc.lineWidth(TABLE_BORDER_WIDTH);
      let drawnTo = x0;
      for (const { cell, x, width, rowSpan } of row) {
        drawnTo = x + width;
        if (cell.covered) continue;
        const last = Math.min(rowIndex + rowSpan, heights.length) - 1;
        const height = heights.slice(rowIndex, last + 1).reduce((sum, rowHeight) => sum + rowHeight, 0);
        if (this.hasText(cell.content)) {
          this.doc.fontSize(TABLE_FONT_SIZE);
          this.writer.write(cell.content, { width: width - TABLE_CELL_PADDING * 2, lineGap: this.spacing.lineGap }, x + TABLE_CELL_PADDING, y + TABLE_CELL_PADDING);
        }
        this.doc.rect(x, y, width, height).stroke();
      }
      for (let empty = Math.round((drawnTo - x0) / columnWidth); empty < columnCount; empty++) {
        this.doc.rect(x0 + empty * columnWidth, y, columnWidth, heights[rowIndex]).stroke();
      }
      this.doc.x = this.left;
      this.doc.y = y + heights[rowIndex];
    });
    this.doc.fontSize(BODY_FONT_SIZE);
    this.doc.moveDown(this.spacing.blockGapLines);
  }

  private renderImage(image: PdfRasterImage, indent: number): void {
    const naturalWidth = image.widthPx * PX_TO_PT;
    const naturalHeight = image.heightPx * PX_TO_PT;
    const scale = Math.min(1, this.textWidth(indent) / naturalWidth, (this.bottom - this.top) / naturalHeight);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    if (this.doc.y + height > this.bottom) this.doc.addPage();
    const y = this.doc.y;
    try {
      this.doc.image(image.data, this.left + indent, y, { width, height });
    } catch (err) {
      throw new ConversionFailedError(`Embedded image could not be decoded: ${(err as Error).message}`);
    }
    this.doc.x = this.left;
    this.doc.y = y + height;
    this.doc.fontSize(BODY_FONT_SIZE);
    this.doc.moveDown(this.spacing.blockGapLines);
  }

  private renderRule(indent: number): void {
    const y = this.doc.y + RULE_SPACING;
    this.doc
      .lineWidth(RULE_WIDTH)
      .moveTo(this.left + indent, y)
      .lineTo(this.left + this.contentWidth, y)
      .stroke();
    this.doc.y = y + RULE_SPACING;
  }
}

/** pdfkit options for the page size and margins: the document's own geometry when it states one, otherwise A4. */
function documentOptions(options: PdfBlockDocumentOptions): PDFKit.PDFDocumentOptions {
  const info = options.title ? { Title: options.title } : {};
  const landscape = options.orientation === 'landscape';
  const { page } = options;
  if (!page) {
    return { size: PAGE_SIZE, layout: landscape ? 'landscape' : 'portrait', margin: PAGE_MARGIN, info };
  }
  const swap = landscape && page.widthPt < page.heightPt;
  const size: [number, number] = swap ? [page.heightPt, page.widthPt] : [page.widthPt, page.heightPt];
  return {
    size,
    margins: { top: page.marginTopPt, right: page.marginRightPt, bottom: page.marginBottomPt, left: page.marginLeftPt },
    info,
  };
}

/**
 * Draws the blocks into an A4 PDF. Fails with EngineUnavailableError when no installed font
 * covers some text, and with ConversionFailedError for content the renderer cannot place.
 */
export async function renderPdfBlocks(blocks: readonly PdfBlock[], options: PdfBlockDocumentOptions = {}): Promise<Buffer> {
  await loadFontCoverageIndex();
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument(documentOptions(options));
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      const writer = new PdfUnicodeTextWriter(doc, options.customFontPath);
      new PdfBlockRenderer(doc, writer, options.spacing).render(blocks);
    } catch (err) {
      reject(err);
      return;
    }
    doc.end();
  });
}
