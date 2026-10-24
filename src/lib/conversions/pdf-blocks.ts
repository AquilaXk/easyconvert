import PDFDocument from 'pdfkit';
import { ConversionFailedError, EngineUnavailableError } from '../types';
import { WaitingDestinations, anchorsAt, anchorsOf } from './pdf-destinations';
import { PdfUnicodeTextWriter, loadFontCoverageIndex, type PdfAnchor, type PdfTextSegment } from './pdf-fonts';
import { layoutTable, type Flow, type TableContext } from './pdf-table';
import {
  MIN_TABLE_COLUMN_WIDTH,
  PX_TO_PT,
  TABLE_FONT_SIZE,
  columnCount,
  measureTable,
  neededTableWidth,
  type MeasureContext,
  type TableMeasure,
} from './pdf-table-metrics';

/**
 * Structured document model drawn by the in-process PDF writers (HTML, Markdown, plain text and
 * HWP to PDF). Each block is drawn with fonts that cover its text; nothing is added that is not
 * document content.
 *
 * Links inside the document: a segment's `anchors` name destinations at the start of its text, an `anchor` block names
 * destinations for the next block that draws something (an empty division, an empty paragraph), and a segment's link
 * `#name` goes to one (see pdf-destinations.ts). A link to a name that no block states is drawn as plain text.
 */
export type PdfBlock =
  | { kind: 'heading'; level: number; content: PdfTextSegment[] }
  | { kind: 'paragraph'; content: PdfTextSegment[] }
  | { kind: 'preformatted'; text: string; anchors?: readonly PdfAnchor[] }
  | { kind: 'list'; ordered: boolean; start: number; items: PdfBlock[][]; markers?: readonly string[] }
  | { kind: 'table'; rows: PdfTableCell[][]; sizing?: PdfTableSizing }
  | { kind: 'image'; image: PdfRasterImage }
  | { kind: 'quote'; blocks: PdfBlock[] }
  | { kind: 'rule' }
  | { kind: 'pageBreak' }
  | { kind: 'anchor'; names: readonly string[] };

/**
 * A table cell and the number of columns it spans. A cell that merges downward states `rowSpan`, and each grid position
 * it covers in the rows below is listed as a `covered` cell (no content, no border of its own). A cell that holds more
 * than text lists its content as `parts` (and leaves `content` empty).
 */
export interface PdfTableCell {
  readonly content: PdfTextSegment[];
  readonly span: number;
  readonly rowSpan?: number;
  readonly covered?: boolean;
  readonly parts?: readonly PdfCellPart[];
}

/** One piece of a cell's content, drawn one under the other: text, a picture, or a table of its own. */
export type PdfCellPart =
  | { readonly kind: 'text'; readonly content: PdfTextSegment[] }
  | { readonly kind: 'image'; readonly image: PdfRasterImage }
  | { readonly kind: 'table'; readonly rows: PdfTableCell[][]; readonly sizing?: PdfTableSizing };

/** A length in points, or a percentage of the width a table is given: the CSS `width` of an HTML table. */
export type PdfLength = { readonly unit: 'pt'; readonly value: number } | { readonly unit: 'percent'; readonly value: number };

export type PdfTableAlign = 'left' | 'center' | 'right';

/**
 * How an HTML table is sized and placed in the width it is given: as wide as its content asks (`auto`) or as wide as it
 * states, and on which side (left when absent). A table without sizing (from a writer other than HTML) fills the width.
 */
export interface PdfTableSizing {
  readonly width: PdfLength | 'auto';
  readonly align?: PdfTableAlign;
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

/** A4 in points, portrait. */
const A4_SIZE: readonly [number, number] = [595.28, 841.89];
const PAGE_MARGIN = 50;
/**
 * The most a page is shrunk so that its widest table fits. A print engine lays a page out wider than the paper when its
 * content overflows and scales every page down by the same factor, at most this much (Blink: the `printingMaximumShrinkFactor`
 * setting, 1.5, read by `LocalFrameView::ForceLayoutForPagination` through `CalculateOverflowShrinkForPrinting`).
 */
const MAX_PAGE_SHRINK = 1.5;
const BODY_FONT_SIZE = 11;
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
/** Narrowest text column left after list and quote indentation. */
const MIN_TEXT_WIDTH = 72;
const RULE_SPACING = 6;
const RULE_WIDTH = 0.75;

/** The width a list's items are indented by: the default marker column, or a wider one for long markers. */
function markerColumnWidth(markers: readonly string[] | undefined): number {
  return markers ? Math.max(LIST_MARKER_WIDTH, ...markers.map((marker) => marker.length * MARKER_CHARACTER_WIDTH + MARKER_GAP)) : LIST_MARKER_WIDTH;
}

class PdfBlockRenderer {
  /** Names of destinations that wait for the next thing drawn (see the `anchor` block). */
  private readonly waiting = new WaitingDestinations<string>();
  /** The measures of the tables of the document, made once whether the page shrink or the layout asks first. */
  private readonly measured = new WeakMap<readonly (readonly PdfTableCell[])[], TableMeasure>();

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

  /**
   * How many times wider than the text column the page has to be laid out for every table to fit: 1 when all fit, at most
   * MAX_PAGE_SHRINK. Refuses a table whose columns do not fit even then. Call it before the first page.
   */
  pageShrink(blocks: readonly PdfBlock[], textColumn: number, indent = 0): number {
    let shrink = 1;
    for (const block of blocks) {
      if (block.kind === 'table') shrink = Math.max(shrink, this.tableShrink(block, textColumn, indent));
      else if (block.kind === 'quote') shrink = Math.max(shrink, this.pageShrink(block.blocks, textColumn, indent + QUOTE_INDENT));
      else if (block.kind === 'list') {
        for (const item of block.items) shrink = Math.max(shrink, this.pageShrink(item, textColumn, indent + markerColumnWidth(block.markers)));
      }
    }
    return shrink;
  }

  private tableShrink(table: Extract<PdfBlock, { kind: 'table' }>, textColumn: number, indent: number): number {
    if (table.rows.every((row) => row.length === 0)) return 1;
    const shrinkFor = (width: number): number => (width + indent) / textColumn;
    const count = columnCount(table.rows);
    const refuse = (least: number): never => {
      throw new EngineUnavailableError(
        'soffice',
        `a table with ${count} columns does not fit the page width: it needs ${Math.ceil(least)}pt of ${Math.floor(textColumn - indent)}pt, and a page is shrunk at most ${MAX_PAGE_SHRINK} times; the in-process PDF renderer needs columns of at least ${MIN_TABLE_COLUMN_WIDTH}pt`
      );
    };
    // Every column takes at least the narrowest width, so a table of too many columns is refused before it is measured.
    if (shrinkFor(count * MIN_TABLE_COLUMN_WIDTH) > MAX_PAGE_SHRINK) refuse(count * MIN_TABLE_COLUMN_WIDTH);
    this.doc.fontSize(TABLE_FONT_SIZE);
    const measure = measureTable(this.measureContext, table.rows);
    if (shrinkFor(measure.least) > MAX_PAGE_SHRINK) refuse(measure.least);
    return Math.min(MAX_PAGE_SHRINK, shrinkFor(neededTableWidth(measure, table.sizing)));
  }

  private get measureContext(): MeasureContext {
    return { writer: this.writer, measured: this.measured };
  }

  render(blocks: readonly PdfBlock[], indent = 0, gapLines = this.spacing.blockGapLines): void {
    for (const block of blocks) {
      this.renderBlock(block, indent, gapLines);
    }
  }

  /** Draws the document; the destinations still waiting at its end stand where the content ends. */
  renderDocument(blocks: readonly PdfBlock[]): void {
    this.render(blocks);
    this.placeWaiting(this.left, Math.min(this.doc.y, this.bottom));
  }

  private placeWaiting(left: number, top: number): void {
    this.writer.destinations.place(this.waiting.release(), left, top);
  }

  /** `content` led by the destinations that wait for a block, which stand at the first line drawn. */
  private withWaiting(content: readonly PdfTextSegment[]): readonly PdfTextSegment[] {
    const names = this.waiting.release();
    return names.length > 0 ? [{ text: '', anchors: anchorsAt(names) }, ...content] : content;
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
        this.renderText([{ text: block.text, anchors: block.anchors }], PREFORMATTED_FONT_SIZE, indent, gapLines);
        return;
      case 'list':
        this.renderList(block.ordered, block.start, block.items, indent, block.markers);
        return;
      case 'table':
        this.renderTable(block, indent);
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
      case 'anchor':
        this.waiting.hold(block.names);
        return;
    }
  }

  private hasText(content: readonly PdfTextSegment[]): boolean {
    return content.some((segment) => segment.text.trim().length > 0);
  }

  private renderHeading(level: number, content: readonly PdfTextSegment[], indent: number): void {
    if (!this.hasText(content)) {
      this.waiting.hold(anchorsOf(content));
      return;
    }
    const size = HEADING_FONT_SIZES[Math.min(Math.max(level, 1), HEADING_FONT_SIZES.length) - 1];
    this.doc.fontSize(size);
    if (this.doc.y > this.top) this.doc.moveDown(this.spacing.headingTopGapLines);
    this.renderText(content, size, indent, this.spacing.blockGapLines);
  }

  private renderText(content: readonly PdfTextSegment[], size: number, indent: number, gapLines: number): void {
    if (!this.hasText(content)) {
      this.waiting.hold(anchorsOf(content));
      return;
    }
    this.doc.fontSize(size);
    this.writer.write(this.withWaiting(content), { width: this.textWidth(indent), lineGap: this.spacing.lineGap }, this.left + indent, this.doc.y);
    this.doc.x = this.left;
    this.doc.moveDown(gapLines);
  }

  private renderList(ordered: boolean, start: number, items: readonly PdfBlock[][], indent: number, markers?: readonly string[]): void {
    const itemIndent = indent + markerColumnWidth(markers);
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
      // An item with no text of its own has its destinations at its marker.
      this.placeWaiting(this.left + indent, top);
      if (this.doc.page === page) this.doc.y = Math.max(this.doc.y, top + lineHeight);
      this.doc.x = this.left;
    });
    this.doc.moveDown(this.spacing.blockGapLines);
  }

  private renderTable(table: Extract<PdfBlock, { kind: 'table' }>, indent: number): void {
    if (table.rows.every((row) => row.length === 0)) return;
    const context: TableContext = { doc: this.doc, writer: this.writer, lineGap: this.spacing.lineGap, measured: this.measured };
    const x0 = this.left + indent;
    const pageHeight = this.bottom - this.top;
    let flow: Flow | undefined = layoutTable(context, table.rows, { width: this.textWidth(indent), fresh: pageHeight, depth: 0 }, table.sizing);
    while (flow) {
      const startY = this.doc.y;
      const drawn = flow.draw(x0, startY, this.bottom - startY);
      if (drawn.end > startY) this.placeWaiting(x0, startY);
      this.doc.x = this.left;
      this.doc.y = drawn.end;
      if (!drawn.rest) break;
      // Nothing placed at the top of a fresh page would repeat on every page.
      if (startY <= this.top && drawn.end <= startY) {
        throw new ConversionFailedError('A table row cannot be placed on a page: nothing of it fits the page height');
      }
      flow = drawn.rest;
      this.doc.addPage();
    }
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
    this.placeWaiting(this.left + indent, y);
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

/** Every name a block of the document states as a destination, to tell a link to one from a link to nothing. */
function declaredAnchors(blocks: readonly PdfBlock[], names: Set<string> = new Set()): Set<string> {
  const addContent = (content: readonly PdfTextSegment[]): void => anchorsOf(content).forEach((name) => names.add(name));
  const addRows = (rows: readonly PdfTableCell[][]): void => {
    for (const cell of rows.flat()) {
      addContent(cell.content);
      for (const part of cell.parts ?? []) {
        if (part.kind === 'text') addContent(part.content);
        else if (part.kind === 'table') addRows(part.rows);
      }
    }
  };
  for (const block of blocks) {
    switch (block.kind) {
      case 'anchor':
        block.names.forEach((name) => names.add(name));
        break;
      case 'heading':
      case 'paragraph':
        addContent(block.content);
        break;
      case 'preformatted':
        block.anchors?.forEach((anchor) => names.add(anchor.name));
        break;
      case 'list':
        block.items.forEach((item) => declaredAnchors(item, names));
        break;
      case 'quote':
        declaredAnchors(block.blocks, names);
        break;
      case 'table':
        addRows(block.rows);
        break;
    }
  }
  return names;
}

/** A page in points: its size and its margins. */
interface PageBox {
  readonly width: number;
  readonly height: number;
  readonly margins: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
}

/** The page the document is drawn on: its own geometry when it states one, otherwise A4, turned for a landscape orientation. */
function pageBox(options: PdfBlockDocumentOptions): PageBox {
  const landscape = options.orientation === 'landscape';
  const { page } = options;
  if (!page) {
    const [width, height] = landscape ? [A4_SIZE[1], A4_SIZE[0]] : A4_SIZE;
    return { width, height, margins: { top: PAGE_MARGIN, right: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN } };
  }
  const swap = landscape && page.widthPt < page.heightPt;
  return {
    width: swap ? page.heightPt : page.widthPt,
    height: swap ? page.widthPt : page.heightPt,
    margins: { top: page.marginTopPt, right: page.marginRightPt, bottom: page.marginBottomPt, left: page.marginLeftPt },
  };
}

/** The part of pdfkit's page this module changes: the page dictionary, whose MediaBox states the size of the paper. */
interface PdfkitPage {
  readonly dictionary: { readonly data: { MediaBox: number[] } };
}

/**
 * Starts the first page. A page shrunk `shrink` times is laid out on paper that many times larger, margins too, so that
 * the layout sees a wider text column, and each page is drawn scaled down onto the real paper: its MediaBox is the paper
 * and its content is scaled about the top left corner, as a print engine draws a page that overflows (see MAX_PAGE_SHRINK).
 * Links follow the scale through pdfkit's transformation matrix, and destinations through pdf-destinations.ts.
 */
function startPages(doc: PDFKit.PDFDocument, box: PageBox, shrink: number): void {
  const { margins } = box;
  // pdfkit lays out every page it adds, its own included, with these options.
  doc.options.size = [box.width * shrink, box.height * shrink];
  doc.options.margins = { top: margins.top * shrink, right: margins.right * shrink, bottom: margins.bottom * shrink, left: margins.left * shrink };
  if (shrink > 1) {
    doc.on('pageAdded', () => {
      (doc.page as unknown as PdfkitPage).dictionary.data.MediaBox = [0, 0, box.width, box.height];
      doc.transform(1 / shrink, 0, 0, 1 / shrink, 0, box.height * shrink - box.height);
    });
  }
  doc.addPage();
}

/**
 * Draws the blocks into an A4 PDF. Fails with EngineUnavailableError when no installed font
 * covers some text, and with ConversionFailedError for content the renderer cannot place.
 */
export async function renderPdfBlocks(blocks: readonly PdfBlock[], options: PdfBlockDocumentOptions = {}): Promise<Buffer> {
  await loadFontCoverageIndex();
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, info: options.title ? { Title: options.title } : {} });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      const writer = new PdfUnicodeTextWriter(doc, options.customFontPath);
      writer.destinations.declare(declaredAnchors(blocks));
      const renderer = new PdfBlockRenderer(doc, writer, options.spacing);
      const box = pageBox(options);
      startPages(doc, box, renderer.pageShrink(blocks, box.width - box.margins.left - box.margins.right));
      renderer.renderDocument(blocks);
      writer.destinations.finish();
    } catch (err) {
      reject(err);
      return;
    }
    doc.end();
  });
}
