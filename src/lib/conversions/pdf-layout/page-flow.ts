import type { Block, DocumentMargins, ParagraphFormat, Section, TableBlock } from '../document-model/model';
import type { BodyBlocks } from './figures';
import type { Box, DetectedTable, LayoutLine, Paragraph } from './types';
import { type WrapMetrics, singleLineIndent, wrappingFit } from './wrap-fit';

/**
 * The spacing, indents and page starts of a PDF's pages, for a writer of a flowing document that keeps the look of the pages: a
 * paragraph is set with the exact line height of its page and the gap that stood above it, indented and wrapped where the page's
 * lines were, and every page starts a section on a new page. The text still flows, so it stays editable, and it comes out where the
 * page had it as long as the fonts have the page's widths. Only what cannot flow stands at a place on the page: a picture, and a
 * paragraph that stood beside text the flow had passed (a label of a figure) or on a page of unequal columns.
 */

/** Share of the em that a line box holds below its baseline. */
const DESCENT_SHARE = 0.23;
const SINGLE_LINE_HEIGHT_SHARE = 1.15;
const MIN_LINE_HEIGHT_SHARE = 0.9;
const MAX_LINE_HEIGHT_SHARE = 3;
/** Points a line of a paragraph may end short of the paragraph's right edge, or a centre be off, and still be aligned to it. */
const ALIGN_TOLERANCE = 2;
/** Points, and share of the text area's width, added to the width a paragraph wraps at, so a font a hair wider than the page's keeps the page's last word on its line. */
const WRAP_SLACK = 3;
const WRAP_SLACK_SHARE = 0.01;
const MIN_JUSTIFIED_LINES = 3;
/** A single line this share of the text area's width in from the left margin and centred is a centred line; a line that fills most of the width is a line of text. */
const MIN_CENTRED_SHARE = 0.1;
/** Lines of text a flow may rise back up the page (type that sits closer than its leading, or an overlap) before it counts as the top of the next column. */
const COLUMN_RISE_LINES = 1.5;
/** The height in points of a line, for how far a table or picture may stand above the end of what the flow holds before it counts as the top of a column. */
const OBJECT_LINE = 12;
/** Lines of text a paragraph may start above the end of what the flow holds before it counts as standing beside it. */
const BESIDE_LINES = 0.5;
const MIN_MARKER_GAP = 6;
/** Points from a marker to its text when the page does not say where the text starts. */
const DEFAULT_MARKER_GAP = 18;
const MAX_MARKER_GAP = 72;
const MIN_COLUMN_GAP_PT = 4;
const DEFAULT_COLUMN_GAP_PT = 36;
/**
 * Points above the page's edge where the office suite ends the body of a page that has a footer part, empty or not, when the page's
 * bottom margin and its footer distance are zero (measured: the body of such a page ends 2.8 points up, 1 mm, whatever the footer holds).
 */
const FOOTER_FLOOR_PT = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The exact height of the lines of a paragraph: the median distance between its baselines, bounded by the text size. A paragraph of
 * one line has no pitch of its own, so it takes the distance from the baseline above it when that is a line's distance, which keeps
 * a run of one-line paragraphs (a list typed with line breaks) from growing by the difference at each.
 */
function lineHeightOf(lines: readonly LayoutLine[], baselineAbove: number | undefined): number {
  const { size } = lines[0];
  const pitches = lines.slice(1).map((line, index) => line.baseline - lines[index].baseline).filter((pitch) => pitch > 0);
  const own = size * SINGLE_LINE_HEIGHT_SHARE;
  const above = baselineAbove === undefined ? own : lines[0].baseline - baselineAbove;
  let pitch = own;
  if (pitches.length > 0) pitch = median(pitches);
  else if (above >= size * MIN_LINE_HEIGHT_SHARE) pitch = Math.min(own, above);
  return Math.min(size * MAX_LINE_HEIGHT_SHARE, Math.max(size * MIN_LINE_HEIGHT_SHARE, pitch));
}

/** The left and right edges of the area text is set in. */
interface TextArea {
  left: number;
  right: number;
}

function within(a: number, b: number): boolean {
  return Math.abs(a - b) <= ALIGN_TOLERANCE;
}

/** Whether the lines (from the one at `from`) start at one left edge. */
function sameLeft(lines: readonly LayoutLine[], from: number): boolean {
  return lines.slice(from).every((line) => within(line.box.x0, lines[from].box.x0));
}

/**
 * How the lines of a paragraph sit between the left and right edges of the text area. A line is centred when its middle is the
 * middle of the area or the middle of the page: the margins are measured from the text, so the area is not always centred on the page.
 * @param pageMiddle the x of the middle of the page
 */
function alignmentOf(lines: readonly LayoutLine[], area: TextArea, pageMiddle: number): NonNullable<ParagraphFormat['align']> {
  const width = area.right - area.left;
  const centres = lines.map((line) => (line.box.x0 + line.box.x1) / 2);
  if (lines.length === 1) {
    const { x0, x1 } = lines[0].box;
    const indent = x0 - area.left;
    if ((within(centres[0], (area.left + area.right) / 2) || within(centres[0], pageMiddle)) && indent > width * MIN_CENTRED_SHARE) return 'center';
    return within(x1, area.right) && indent > width / 5 ? 'right' : 'left';
  }
  // A first line may be indented; the others say whether the paragraph has a left edge.
  const leftEdge = sameLeft(lines, 1);
  const body = lines.slice(0, -1);
  if (lines.length >= MIN_JUSTIFIED_LINES && leftEdge && body.every((line) => within(line.box.x1, body[0].box.x1))) return 'justify';
  const ragged = Math.max(...lines.map((line) => line.box.x0)) - Math.min(...lines.map((line) => line.box.x0)) > width * MIN_CENTRED_SHARE;
  if (ragged && centres.every((centre) => within(centre, centres[0]))) return 'center';
  return ragged && lines.every((line) => within(line.box.x1, lines[0].box.x1)) ? 'right' : 'left';
}

/** What a flow needs to know of the document it formats paragraphs for. */
export interface PageSetup {
  margins: DocumentMargins;
  pageWidth: number;
  pageTops: ReadonlyMap<number, number>;
  /** Width in points of each page when the document mixes page sizes. */
  pageWidths?: ReadonlyMap<number, number>;
  /** Height in points of each page. */
  pageHeights?: ReadonlyMap<number, number>;
  /** The face the writer sets the text in and the size it sets a paragraph of the body's size in, so that a paragraph is made to wrap where the page's lines did. */
  wrap?: { metrics: WrapMetrics; bodySize: number };
}

/** What the writer of a paragraph needs of one page of a document, and where the flow stands after the last thing written. */
export class PageFlow {
  private currentPage = 0;
  /** The bottom of what stands above, on the page, as Word will lay it out. */
  private bottom: number | undefined;
  /** The flow went back up to the top of the page for the paragraph being formatted: it is the first of a column. */
  private newColumn = false;
  /** The baseline of the last line of text above on the page, when the flow has text above. */
  private baseline: number | undefined;
  /** The columns of the last paragraph written on the page, and where the flow stood when its run of columns began: the top the next column starts at. */
  private columnsAbove = 1;
  private columnTop: number | undefined;

  private readonly margins: DocumentMargins;
  private readonly pageWidth: number;
  private readonly pageTops: ReadonlyMap<number, number>;
  private readonly inCell: boolean;

  /**
   * @param page the margins the document is written with, the width of its pages in points, where the body of a page starts (its top
   * margin, or the foot of its running header when that is lower) by page number
   * @param cellBox set for the flow of a table cell: its place on the page where known (its row's `y0` and `y1`, its `x0` and `x1`);
   * the first paragraph of the cell stands below the top of its row with nothing between
   */
  constructor(
    private readonly page: PageSetup,
    private readonly cellBox?: Partial<Box>
  ) {
    ({ margins: this.margins, pageWidth: this.pageWidth, pageTops: this.pageTops } = page);
    this.inCell = cellBox !== undefined;
  }

  private topOf(pageNumber: number): number {
    return this.pageTops.get(pageNumber) ?? this.margins.top;
  }

  private widthOf(pageNumber: number): number {
    return this.page.pageWidths?.get(pageNumber) ?? this.pageWidth;
  }

  private enter(pageNumber: number): void {
    if (pageNumber === this.currentPage) return;
    this.currentPage = pageNumber;
    this.bottom = this.inCell ? this.cellBox?.y0 : this.topOf(pageNumber);
    this.baseline = undefined;
    this.columnsAbove = 1;
    this.columnTop = undefined;
  }

  /** The share of its width a table of `width` points keeps: a table wider than the text area is narrowed by the writer to fit it. */
  tableScale(width: number, pageNumber = this.currentPage): number {
    const area = this.widthOf(pageNumber) - this.margins.left - this.margins.right;
    return width > area && area > 0 ? area / width : 1;
  }

  /** The flow of one table cell: `box` is the cell's place on the page, where it is known (its row's `y0` and `y1`, its `x0` and `x1`). */
  cell(box: Partial<Box>): PageFlow {
    return new PageFlow(this.page, box);
  }

  /** Where the flow of a cell ends: the bottom of its last paragraph, as the writer will lay it out. */
  get end(): number | undefined {
    return this.bottom;
  }

  /**
   * How a table is placed: the gap above it, its indent from the left margin and the height of each row, and the flow moved past it.
   * @param grown what the rows grow by because their text sets taller than the page's rows were, so that the flow is past the table as
   * the writer lays it out, and the gap above the paragraph that follows is what the page had less that
   */
  table(table: DetectedTable, grown = 0): Pick<TableBlock, 'beforePt' | 'indentPt' | 'rowHeights'> {
    const { rowEdges } = table;
    const beforePt = this.object({ ...table.box, y1: table.box.y1 + grown }, table.pageNumber);
    const rowHeights = rowEdges?.length === table.rows.length + 1 ? rowEdges.slice(1).map((edge, index) => Math.max(0, edge - rowEdges[index])) : undefined;
    return { beforePt, indentPt: table.box.x0 - this.margins.left, ...(rowHeights ? { rowHeights } : {}) };
  }

  /** The gap above something whose top is at `top` and whose lines are `line` tall; the flow moves to the top of its column when `top` is far above what it holds. */
  private gapTo(top: number, line: number): number {
    if (this.bottom === undefined) return 0;
    if (!this.inCell && top < this.bottom - COLUMN_RISE_LINES * line) {
      this.bottom = this.columnTop ?? this.topOf(this.currentPage);
      this.baseline = undefined;
      this.newColumn = true;
    }
    return Math.max(0, top - this.bottom);
  }

  /**
   * Whether a paragraph whose first line box starts at `top` stood beside what the flow holds, not after it. In one column the text
   * comes down the page, so what rises is beside (a label of a figure, a mark in the margin); in several columns a rise of more than
   * a line or two is the top of the next column.
   */
  private stoodBeside(top: number, line: number, columns: number): boolean {
    if (this.inCell || this.bottom === undefined || top >= this.bottom - BESIDE_LINES * line) return false;
    return columns === 1 || top >= this.bottom - COLUMN_RISE_LINES * line;
  }

  /**
   * Whether the last line of a paragraph of the body ends where the office suite keeps the foot of the page free of body text: a line
   * there is set on the next page, and the paragraph with it, so the paragraph stands at its place on the page as a frame instead.
   */
  private endsInFooterFloor(last: LayoutLine): boolean {
    const height = this.page.pageHeights?.get(this.currentPage);
    return !this.inCell && height !== undefined && last.baseline + DESCENT_SHARE * last.size > height - FOOTER_FLOOR_PT;
  }

  /** The format of a paragraph set as a frame at its place on the page; the flow does not move. */
  frameFormat(paragraph: Paragraph): ParagraphFormat {
    const { lines } = paragraph;
    const lineHeightPt = lineHeightOf(lines, undefined);
    const x0 = Math.min(...lines.map((line) => line.box.x0));
    const x1 = Math.max(...lines.map((line) => line.box.x1));
    const widthPt = x1 - x0 + Math.max(WRAP_SLACK, (x1 - x0) * WRAP_SLACK_SHARE);
    const yPt = lines[0].baseline - (lineHeightPt - DESCENT_SHARE * lines[0].size);
    return { beforePt: 0, lineHeightPt, leftPt: 0, firstLinePt: 0, rightPt: 0, frame: { xPt: x0, yPt, widthPt } };
  }

  /** The format of a paragraph and the flow moved past it; the format is undefined for text that runs in another direction than the page's lines. */
  paragraph(paragraph: Paragraph, columns: number, marker = false): ParagraphFormat | undefined {
    this.enter(paragraph.pageNumber);
    const { lines } = paragraph;
    if (lines.some((line) => line.vertical)) {
      this.bottom = paragraph.box.y1;
      this.baseline = undefined;
      return undefined;
    }
    const first = lines[0];
    const last = lines[lines.length - 1];
    let lineHeightPt = lineHeightOf(lines, this.baseline);
    const top = first.baseline - (lineHeightPt - DESCENT_SHARE * first.size);
    if (this.stoodBeside(top, lineHeightPt, columns) || this.endsInFooterFloor(last)) return this.frameFormat(paragraph);
    // A run of columns that starts below other text starts its columns there, not at the top of the page.
    if (columns > 1 && this.columnsAbove !== columns) this.columnTop = this.bottom;
    this.columnsAbove = columns;
    const beforePt = this.gapTo(top, lineHeightPt);
    lineHeightPt = this.fitToRow(lineHeightPt, lines, beforePt);
    const { writerLines, ...indents } = this.indentsOf(paragraph, columns, marker);
    // The lines the writer sets are what the flow moves past: a line more than the page had pushes what follows down, and the gap above it is what the page had less that.
    this.bottom = (beforePt > 0 ? top : (this.bottom ?? top)) + Math.max(lines.length, writerLines ?? 0) * lineHeightPt;
    // The line boxes are as tall as the pitch says; the last baseline is where the text ends, so a tall last line keeps what it had.
    this.bottom = Math.max(this.bottom, last.baseline + DESCENT_SHARE * last.size);
    this.baseline = last.baseline;
    const columnBreakBefore = this.newColumn && columns > 1;
    this.newColumn = false;
    return { beforePt, lineHeightPt, ...indents, ...(columnBreakBefore ? { columnBreakBefore: true as const } : {}) };
  }

  /** Lines no taller than leave the text inside the row it stood in: a row whose text sets taller than its height would grow, and every row below would move. */
  private fitToRow(lineHeight: number, lines: readonly LayoutLine[], beforePt: number): number {
    if (this.cellBox?.y1 === undefined || this.bottom === undefined) return lineHeight;
    const room = this.cellBox.y1 - this.bottom - beforePt;
    const fitted = room / lines.length;
    return fitted < lineHeight && fitted >= lines[0].size * MIN_LINE_HEIGHT_SHARE ? fitted : lineHeight;
  }

  private indentsOf(paragraph: Paragraph, columns: number, marker: boolean): Pick<ParagraphFormat, 'leftPt' | 'firstLinePt' | 'rightPt' | 'align'> & { writerLines?: number } {
    if (columns > 1) return { leftPt: 0, firstLinePt: 0, rightPt: 0 };
    const area = this.textArea();
    const align = marker || this.inCell ? 'left' : alignmentOf(paragraph.lines, area, this.widthOf(paragraph.pageNumber) / 2);
    const x0 = Math.min(...paragraph.lines.map((line) => line.box.x0));
    const x1 = Math.max(...paragraph.lines.map((line) => line.box.x1));
    if (align === 'center') {
      const centre = (x0 + x1) / 2;
      const offset = centre - (area.left + area.right) / 2;
      return { leftPt: Math.max(0, 2 * offset), firstLinePt: 0, rightPt: Math.max(0, -2 * offset), align };
    }
    if (align === 'right') return { leftPt: 0, firstLinePt: 0, rightPt: Math.max(0, area.right - x1), align };
    const slack = Math.max(WRAP_SLACK, (area.right - area.left) * WRAP_SLACK_SHARE);
    // A line that fits the page's text area may stand a little past it: the line is as wide as the page set it, in a font that may be wider.
    const rightPt = paragraph.lines.length > 1 ? Math.max(0, area.right - x1 - slack) : -slack;
    if (marker) return { ...this.markerIndents(paragraph, area), rightPt, align };
    const leftPt = Math.max(0, paragraph.leftX - area.left);
    const firstLinePt = paragraph.firstLineX - paragraph.leftX;
    const fit = this.wrapOf(paragraph, area, leftPt, firstLinePt, align, rightPt);
    return { leftPt, firstLinePt, rightPt: fit.rightPt, align, writerLines: fit.lines };
  }

  /**
   * The right indent that makes the writer break the paragraph's lines where the page did, nearest the page's right edge, and the lines
   * the writer sets it in; `fallback` and the page's lines where the face cannot tell.
   */
  private wrapOf(paragraph: Paragraph, area: TextArea, leftPt: number, firstLinePt: number, align: NonNullable<ParagraphFormat['align']>, fallback: number): { rightPt: number; lines: number } {
    const { wrap } = this.page;
    const kept = { rightPt: fallback, lines: paragraph.lines.length };
    if (!wrap || paragraph.lines.length === 0) return kept;
    const size = Math.abs(paragraph.size - wrap.bodySize) > 0.5 ? paragraph.size : wrap.bodySize;
    if (paragraph.lines.length === 1) {
      const minIndent = this.inCell ? Number.NEGATIVE_INFINITY : -this.margins.right;
      return { ...kept, rightPt: singleLineIndent(paragraph, size, wrap.metrics, area.right - area.left - leftPt - firstLinePt, fallback, minIndent) };
    }
    const edge = align === 'justify' ? area.right - Math.max(...paragraph.lines.map((line) => line.box.x1)) : fallback;
    const fit = wrappingFit(paragraph, size, wrap.metrics, (index) => area.right - area.left - leftPt - (index === 0 ? firstLinePt : 0), edge);
    return fit ? { rightPt: fit.indent, lines: fit.lines } : kept;
  }

  /** The area text is set in: between the page's margins, or the cell's edges where they are known. */
  private textArea(): TextArea {
    const { x0, x1 } = this.cellBox ?? {};
    return this.inCell && x0 !== undefined && x1 !== undefined
      ? { left: x0, right: x1 }
      : { left: this.margins.left, right: this.widthOf(this.currentPage) - this.margins.right };
  }

  /**
   * A list item hangs its marker: the text starts where the item's text does and the marker stands out to the left. An item whose
   * later lines start left of its marker is a paragraph with an indented first line, which the marker opens.
   */
  private markerIndents(paragraph: Paragraph, area: TextArea): Pick<ParagraphFormat, 'leftPt' | 'firstLinePt'> {
    const markerX = paragraph.firstLineX;
    if (paragraph.lines.length > 1 && paragraph.leftX < markerX - ALIGN_TOLERANCE) {
      return { leftPt: Math.max(0, paragraph.leftX - area.left), firstLinePt: markerX - paragraph.leftX };
    }
    const textX = paragraph.lines[0].textX0 ?? (paragraph.leftX > markerX ? paragraph.leftX : markerX + DEFAULT_MARKER_GAP);
    const gap = Math.min(MAX_MARKER_GAP, Math.max(MIN_MARKER_GAP, textX - markerX));
    return { leftPt: Math.max(gap, textX - area.left), firstLinePt: -gap };
  }

  /** The gap above a table or picture with this box, and the flow moved past it. */
  object(box: Box, pageNumber: number): number {
    this.enter(pageNumber);
    const gap = this.gapTo(box.y0, OBJECT_LINE);
    this.bottom = box.y1;
    this.baseline = undefined;
    return gap;
  }
}

/** A paragraph that holds a page open when nothing else on it does, so the page keeps its place in the document. */
const BLANK_PAGE: Block = { type: 'paragraph', runs: [], rtl: false, align: 'left' };

/**
 * The sections of a document whose blocks stand on pages: every page starts a section on a new page, split further wherever the
 * number of columns changes. A page with no block (a blank page, or one that only held running headers) gets a section of one
 * empty paragraph.
 * @param pageOf the page number each block stands on, never decreasing
 * @param columnsOf the columns of each block's flow
 * @param pageNumbers every page of the document in order
 * @param topMargins the top margin each page is written with
 * @param furniture the pages that have a running header, and those that have a running footer: a page of a document that has one and
 * lacks it (a first page without a letterhead) omits it
 */
export interface PageSectionFurniture {
  headerPages: ReadonlySet<number>;
  footerPages: ReadonlySet<number>;
  documentSize?: { width: number; height: number };
  pageSizes?: ReadonlyMap<number, { width: number; height: number }>;
  columnGaps?: ReadonlyMap<number, number>;
}

export function pageSections(
  blocks: readonly Block[],
  columnsOf: readonly number[],
  pageOf: readonly number[],
  pageNumbers: readonly number[],
  furniture: PageSectionFurniture,
  topMargins: ReadonlyMap<number, number>
): Section[] {
  const sections: Section[] = [];
  let at = 0;
  const { documentSize: docSize, pageSizes, columnGaps } = furniture;
  pageNumbers.forEach((pageNumber, index) => {
    const start = sections.length;
    for (; at < blocks.length && pageOf[at] <= pageNumber; at++) {
      const last = sections[sections.length - 1];
      if (sections.length > start && last.columns === columnsOf[at]) last.blocks.push(blocks[at]);
      else sections.push({ columns: columnsOf[at], blocks: [blocks[at]] });
    }
    if (sections.length === start) sections.push({ columns: 1, blocks: [BLANK_PAGE] });
    if (index > 0) sections[start].breakType = 'nextPage';
    const top = topMargins.get(pageNumber);
    if (top !== undefined) sections[start].marginTopPt = top;
    if (furniture.headerPages.size > 0 && !furniture.headerPages.has(pageNumber)) sections[start].omitsHeader = true;
    if (furniture.footerPages.size > 0 && !furniture.footerPages.has(pageNumber)) sections[start].omitsFooter = true;
    const size = pageSizes?.get(pageNumber);
    const customSize = size && docSize && (Math.abs(size.width - docSize.width) > 0.5 || Math.abs(size.height - docSize.height) > 0.5) ? size : undefined;
    const gap = columnGaps?.get(pageNumber);
    for (let s = start; s < sections.length; s++) {
      if (customSize) {
        sections[s].pageWidthPt = customSize.width;
        sections[s].pageHeightPt = customSize.height;
      }
      if (gap !== undefined && sections[s].columns > 1) sections[s].columnGapPt = gap;
    }
  });
  return sections;
}

/** The format of the first paragraph of a block that is text. */
function firstFormatOf(block: Block): ParagraphFormat | undefined {
  if (block.type === 'paragraph' || block.type === 'heading') return block.format;
  return block.type === 'list' ? block.items[0]?.format : undefined;
}

/**
 * Moves the gap above the first paragraph of a run of columns that starts below other text of its page into a paragraph of its own
 * before the run. The gap sits above the paragraph; a writer takes it as the start of the section (LibreOffice starts every column
 * of the section below it), so the columns after the first would start that far below the gap that was measured to them.
 */
export function hoistColumnGaps(body: BodyBlocks): void {
  const { model, columnsOf, origins, pageOf } = body;
  for (let index = model.length - 1; index > 0; index--) {
    const columns = columnsOf[index];
    if (columns <= 1 || columnsOf[index - 1] === columns || pageOf[index - 1] !== pageOf[index]) continue;
    const format = firstFormatOf(model[index]);
    if (!format || format.frame || format.beforePt <= 0) continue;
    const spacer: Block = { type: 'paragraph', runs: [], rtl: false, align: 'left', spacerPt: format.beforePt };
    format.beforePt = 0;
    model.splice(index, 0, spacer);
    columnsOf.splice(index, 0, columnsOf[index - 1]);
    origins.splice(index, 0, null);
    pageOf.splice(index, 0, pageOf[index]);
  }
}

/** The height in points of the paragraph that holds a figure open, never less than the line a writer can set (a rule has no height). */
export const FIGURE_SPACER_MIN_PT = 1;

/**
 * Takes the height of every figure's paragraph out of the gap above the block that follows it: that gap was measured from the block
 * above the figure, so it holds the figure's height already, and the paragraph that holds the figure open would add it again.
 */
export function absorbFigureSpacers(blocks: readonly Block[], pageOf?: readonly number[]): void {
  blocks.forEach((block, index) => {
    if (block.type !== 'paragraph' || block.spacerPt === undefined) return;
    if (pageOf && pageOf[index] !== pageOf[index + 1]) return;
    const next = blocks[index + 1];
    const held = Math.max(block.spacerPt, FIGURE_SPACER_MIN_PT);
    if (next?.type === 'paragraph' || next?.type === 'heading') {
      if (next.format) next.format = { ...next.format, beforePt: Math.max(0, next.format.beforePt - held) };
    } else if (next?.type === 'table' && next.beforePt !== undefined) {
      next.beforePt = Math.max(0, next.beforePt - held);
    }
  });
}

/** A block in several columns, as `irregularColumnPages` reads it: the boxes of its lines (a paragraph that goes on into the next column has lines in both). */
export interface ColumnedBlock {
  pageNumber: number;
  columns: number;
  boxes: readonly Box[];
}

/** How far (share of the first) the distances between the left edges of the columns may differ for the columns to be the equal columns a writer sets. */
const COLUMN_REGULARITY = 0.12;
const COLUMN_START_TOLERANCE = 12;

/** The left edges of the columns the paragraphs stand in, nearest first. */
function columnStarts(boxes: readonly Box[]): { start: number }[] {
  const starts: { start: number }[] = [];
  for (const box of [...boxes].sort((a, b) => a.x0 - b.x0)) {
    const last = starts[starts.length - 1];
    if (!last || box.x0 - last.start > COLUMN_START_TOLERANCE) starts.push({ start: box.x0 });
  }
  return starts;
}

function groupByColumnPage(blocks: readonly ColumnedBlock[]): Map<number, ColumnedBlock[]> {
  const byPage = new Map<number, ColumnedBlock[]>();
  for (const block of blocks) {
    if (block.columns <= 1) continue;
    const members = byPage.get(block.pageNumber) ?? [];
    members.push(block);
    byPage.set(block.pageNumber, members);
  }
  return byPage;
}

function impliedColumnGap(
  starts: readonly { start: number }[],
  maxX1: readonly number[],
  pageWidth: number,
  margins: DocumentMargins,
  observedGap: number
): number | undefined {
  const columns = starts.length;
  if (Math.abs(starts[0].start - margins.left) > ALIGN_TOLERANCE) return undefined;
  const pitch = (starts[columns - 1].start - starts[0].start) / (columns - 1);
  const lastSpan = maxX1[columns - 1] - starts[columns - 1].start;
  if (lastSpan >= pitch - observedGap - ALIGN_TOLERANCE && pageWidth - margins.right - maxX1[columns - 1] > ALIGN_TOLERANCE) {
    return undefined;
  }
  const implied = columns * pitch - (pageWidth - margins.left - margins.right);
  return implied >= MIN_COLUMN_GAP_PT && implied <= observedGap + ALIGN_TOLERANCE ? implied : undefined;
}

function measurePageColumnGap(
  members: readonly ColumnedBlock[],
  pageWidth: number,
  margins: DocumentMargins
): number | undefined {
  const columns = Math.max(...members.map((member) => member.columns));
  const boxes = members.flatMap((member) => member.boxes);
  const starts = columnStarts(boxes);
  if (columns <= 1 || starts.length !== columns) return undefined;
  const minX0 = Array<number>(columns).fill(Infinity);
  const maxX1 = Array<number>(columns).fill(-Infinity);
  for (const box of boxes) {
    let column = 0;
    for (let i = 1; i < columns; i++) {
      if (box.x0 >= starts[i].start - COLUMN_START_TOLERANCE) column = i;
    }
    minX0[column] = Math.min(minX0[column], box.x0);
    maxX1[column] = Math.max(maxX1[column], box.x1);
  }
  const edgeGaps: number[] = [];
  for (let i = 0; i < columns - 1; i++) {
    if (Number.isFinite(maxX1[i]) && Number.isFinite(minX0[i + 1])) edgeGaps.push(minX0[i + 1] - maxX1[i]);
  }
  if (edgeGaps.length === 0) return undefined;
  const observedGap = Math.min(...edgeGaps);
  if (observedGap < 0) return undefined;
  const candidate = impliedColumnGap(starts, maxX1, pageWidth, margins, observedGap) ?? observedGap;
  const clamped = Math.max(MIN_COLUMN_GAP_PT, Math.min(DEFAULT_COLUMN_GAP_PT, candidate));
  return clamped < DEFAULT_COLUMN_GAP_PT - 0.5 ? Math.round(clamped * 10) / 10 : undefined;
}

/**
 * The pages whose columns are not the equal columns of a writer's section (a newsletter with a narrow column beside wide ones): the
 * paragraphs of such a page are set where the page had them, as frames, since columns would put them elsewhere.
 */
export function irregularColumnPages(blocks: readonly ColumnedBlock[]): Set<number> {
  const irregular = new Set<number>();
  for (const [page, members] of groupByColumnPage(blocks)) {
    const columns = Math.max(...members.map((member) => member.columns));
    const starts = columnStarts(members.flatMap((member) => member.boxes));
    const pitches = starts.slice(1).map((entry, index) => entry.start - starts[index].start);
    const uneven = pitches.some((pitch) => Math.abs(pitch - pitches[0]) > COLUMN_REGULARITY * pitches[0]);
    if (starts.length !== columns || uneven) irregular.add(page);
  }
  return irregular;
}

/**
 * Column gap in points per page for equal multi-column pages whose column spacing is narrower than Word's 36 pt default.
 */
export function regularColumnGaps(
  blocks: readonly ColumnedBlock[],
  irregular: ReadonlySet<number>,
  pageWidths: ReadonlyMap<number, number>,
  defaultPageWidth: number,
  margins: DocumentMargins
): Map<number, number> {
  const gaps = new Map<number, number>();
  for (const [page, members] of groupByColumnPage(blocks)) {
    if (irregular.has(page)) continue;
    const gap = measurePageColumnGap(members, pageWidths.get(page) ?? defaultPageWidth, margins);
    if (gap !== undefined) gaps.set(page, gap);
  }
  return gaps;
}
