import PDFDocument from 'pdfkit';
import { ConversionFailedError } from '../types';
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
  | { kind: 'list'; ordered: boolean; start: number; items: PdfBlock[][] }
  | { kind: 'table'; rows: PdfTextSegment[][][] }
  | { kind: 'image'; image: PdfRasterImage }
  | { kind: 'quote'; blocks: PdfBlock[] }
  | { kind: 'rule' }
  | { kind: 'pageBreak' };

/** A decoded-and-verified PNG or JPEG image with its pixel size. */
export interface PdfRasterImage {
  readonly data: Buffer;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface PdfBlockDocumentOptions {
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
const LIST_MARKER_WIDTH = 22;
const QUOTE_INDENT = 18;
const BULLET_MARKER = '•';
const TABLE_CELL_PADDING = 4;
const TABLE_BORDER_WIDTH = 0.5;
const MIN_TABLE_COLUMN_WIDTH = 24;
const RULE_SPACING = 6;
const RULE_WIDTH = 0.75;
/** CSS pixel to PDF point (96 px per inch, 72 pt per inch). */
const PX_TO_PT = 0.75;

class PdfBlockRenderer {
  constructor(
    private readonly doc: PDFKit.PDFDocument,
    private readonly writer: PdfUnicodeTextWriter
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

  render(blocks: readonly PdfBlock[], indent = 0, gapLines = BLOCK_GAP_LINES): void {
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
        this.renderList(block.ordered, block.start, block.items, indent);
        return;
      case 'table':
        this.renderTable(block.rows, indent);
        return;
      case 'image':
        this.renderImage(block.image, indent);
        return;
      case 'quote':
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
    if (this.doc.y > this.top) this.doc.moveDown(HEADING_TOP_GAP_LINES);
    this.renderText(content, size, indent, BLOCK_GAP_LINES);
  }

  private renderText(content: readonly PdfTextSegment[], size: number, indent: number, gapLines: number): void {
    if (!this.hasText(content)) return;
    this.doc.fontSize(size);
    this.writer.write(content, { width: this.contentWidth - indent, lineGap: LINE_GAP }, this.left + indent, this.doc.y);
    this.doc.x = this.left;
    this.doc.moveDown(gapLines);
  }

  private renderList(ordered: boolean, start: number, items: readonly PdfBlock[][], indent: number): void {
    const itemIndent = indent + LIST_MARKER_WIDTH;
    items.forEach((item, index) => {
      this.doc.fontSize(BODY_FONT_SIZE);
      const lineHeight = this.doc.currentLineHeight(true) + LINE_GAP;
      if (this.doc.y + lineHeight > this.bottom) this.doc.addPage();
      const top = this.doc.y;
      const page = this.doc.page;
      const marker = ordered ? `${start + index}.` : BULLET_MARKER;
      this.writer.write(marker, { lineBreak: false }, this.left + indent, top);
      this.doc.y = top;
      this.render(item, itemIndent, LIST_ITEM_GAP_LINES);
      if (this.doc.page === page) this.doc.y = Math.max(this.doc.y, top + lineHeight);
      this.doc.x = this.left;
    });
    this.doc.moveDown(BLOCK_GAP_LINES);
  }

  private renderTable(rows: readonly PdfTextSegment[][][], indent: number): void {
    const columnCount = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
    if (columnCount === 0) return;
    const tableWidth = this.contentWidth - indent;
    const columnWidth = tableWidth / columnCount;
    if (columnWidth < MIN_TABLE_COLUMN_WIDTH) {
      throw new ConversionFailedError(
        `Table with ${columnCount} columns does not fit the page width; the in-process PDF renderer needs columns of at least ${MIN_TABLE_COLUMN_WIDTH}pt`
      );
    }
    const textWidth = columnWidth - TABLE_CELL_PADDING * 2;
    const x0 = this.left + indent;
    this.doc.fontSize(TABLE_FONT_SIZE);
    const minRowHeight = this.doc.currentLineHeight(true) + TABLE_CELL_PADDING * 2;

    for (const row of rows) {
      this.doc.fontSize(TABLE_FONT_SIZE);
      const textHeights = row.map((cell) => (this.hasText(cell) ? this.writer.heightOf(cell, { width: textWidth, lineGap: LINE_GAP }) : 0));
      const tallest = textHeights.reduce((max, height) => Math.max(max, height), 0);
      const rowHeight = Math.max(minRowHeight, tallest + TABLE_CELL_PADDING * 2);
      if (rowHeight > this.bottom - this.top) {
        throw new ConversionFailedError('A table row is taller than a page; the in-process PDF renderer cannot split table cells across pages');
      }
      if (this.doc.y + rowHeight > this.bottom) this.doc.addPage();
      const y = this.doc.y;
      row.forEach((cell, index) => {
        if (!this.hasText(cell)) return;
        this.doc.fontSize(TABLE_FONT_SIZE);
        this.writer.write(cell, { width: textWidth, lineGap: LINE_GAP }, x0 + index * columnWidth + TABLE_CELL_PADDING, y + TABLE_CELL_PADDING);
      });
      this.doc.lineWidth(TABLE_BORDER_WIDTH);
      for (let index = 0; index < columnCount; index++) {
        this.doc.rect(x0 + index * columnWidth, y, columnWidth, rowHeight).stroke();
      }
      this.doc.x = this.left;
      this.doc.y = y + rowHeight;
    }
    this.doc.fontSize(BODY_FONT_SIZE);
    this.doc.moveDown(BLOCK_GAP_LINES);
  }

  private renderImage(image: PdfRasterImage, indent: number): void {
    const naturalWidth = image.widthPx * PX_TO_PT;
    const naturalHeight = image.heightPx * PX_TO_PT;
    const scale = Math.min(1, (this.contentWidth - indent) / naturalWidth, (this.bottom - this.top) / naturalHeight);
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
    this.doc.moveDown(BLOCK_GAP_LINES);
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

/**
 * Draws the blocks into an A4 PDF. Fails with EngineUnavailableError when no installed font
 * covers some text, and with ConversionFailedError for content the renderer cannot place.
 */
export async function renderPdfBlocks(blocks: readonly PdfBlock[], options: PdfBlockDocumentOptions = {}): Promise<Buffer> {
  await loadFontCoverageIndex();
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: PAGE_SIZE,
      layout: options.orientation === 'landscape' ? 'landscape' : 'portrait',
      margin: PAGE_MARGIN,
      info: options.title ? { Title: options.title } : {},
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      const writer = new PdfUnicodeTextWriter(doc, options.customFontPath);
      new PdfBlockRenderer(doc, writer).render(blocks);
    } catch (err) {
      reject(err);
      return;
    }
    doc.end();
  });
}
