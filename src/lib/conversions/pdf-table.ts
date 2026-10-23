import { ConversionFailedError, EngineUnavailableError } from '../types';
import type { PdfCellPart, PdfRasterImage, PdfTableCell } from './pdf-blocks';
import { anchorsOf } from './pdf-destinations';
import { shapedLineHeight, type PdfTextSegment, type PdfUnicodeTextWriter } from './pdf-fonts';
import {
  MIN_TABLE_COLUMN_WIDTH,
  TABLE_CELL_PADDING,
  TABLE_FONT_SIZE,
  PX_TO_PT,
  automaticColumnWidths,
  measureTable,
  type MeasureContext,
} from './pdf-table-metrics';
import type { LayoutLine } from './text-shaping/paragraph-layout';

/**
 * Tables for the in-process PDF writers: cells that hold text, pictures and tables of their own, and rows that continue on
 * the next page. Columns are equal, except in a table that holds a table or sits in one (see pdf-table-metrics.ts).
 *
 * A cell's content is a flow: it is measured at the cell's width when the table is laid out, and drawn into a window of
 * height it is given, returning what did not fit. A row is moved to the next page whole when it fits a page (CSS
 * Fragmentation Level 3, section 4.4: a break between rows is preferred). A row taller than a page is cut where the page
 * ends: each cell of it continues on the next page from its next line, with its borders and padding drawn again
 * (`box-decoration-break: clone`). A picture is monolithic: it is scaled to fit a page and never cut.
 */

const TABLE_BORDER_WIDTH = 0.5;
/** Deepest table inside tables the renderer lays out. Each level costs 8 pt of width (cell padding), so 32 levels leave 486 pt of the 742 pt text width of a landscape page. */
export const MAX_TABLE_DEPTH = 32;
/** Slack for comparing heights that were summed in a different order. */
const EPSILON = 1e-6;

/** What a table needs from the document it is drawn in. */
export interface TableContext extends MeasureContext {
  readonly doc: PDFKit.PDFDocument;
  readonly writer: PdfUnicodeTextWriter;
  /** Space between lines of text, in points. */
  readonly lineGap: number;
}

/** What drawing a flow left: the y below what was drawn, and the part that did not fit (absent when everything was drawn). */
export interface FlowDrawn {
  readonly end: number;
  readonly rest?: Flow;
}

/** Content that takes `height` points at its width and is drawn in as much room as it is given. */
export interface Flow {
  /** Height of what is left to draw. */
  readonly height: number;
  /** Draws what fits in `room` points below `y` with its left edge at `x`. Never starts a page. */
  draw(x: number, y: number, room: number): FlowDrawn;
}

class TextFlow implements Flow {
  readonly height: number;

  constructor(
    private readonly context: TableContext,
    private readonly content: readonly PdfTextSegment[],
    private readonly width: number,
    private readonly fresh: number,
    private readonly lines?: readonly LayoutLine[]
  ) {
    this.height = lines
      ? lines.reduce((sum, line) => sum + shapedLineHeight(line, context.lineGap), 0)
      : context.writer.heightOf(content, { width, lineGap: context.lineGap });
  }

  draw(x: number, y: number, room: number): FlowDrawn {
    const { doc, writer, lineGap } = this.context;
    doc.fontSize(TABLE_FONT_SIZE);
    if (this.height <= room + EPSILON) {
      if (this.lines) return { end: writer.drawLines(this.lines, x, y, lineGap) };
      writer.write(this.content, { width: this.width, lineGap }, x, y);
      return { end: y + this.height };
    }
    const lines = this.lines ?? writer.layoutLines(this.content, this.width);
    const count = this.linesThatFit(lines, room);
    if (count === 0) {
      if (room >= this.fresh - EPSILON) {
        throw new ConversionFailedError('A line of table text is taller than a page, so the in-process PDF renderer cannot place it');
      }
      return { end: y, rest: new TextFlow(this.context, this.content, this.width, this.fresh, lines) };
    }
    const end = writer.drawLines(lines.slice(0, count), x, y, lineGap);
    return { end, rest: new TextFlow(this.context, this.content, this.width, this.fresh, lines.slice(count)) };
  }

  private linesThatFit(lines: readonly LayoutLine[], room: number): number {
    let used = 0;
    let count = 0;
    while (count < lines.length) {
      used += shapedLineHeight(lines[count], this.context.lineGap);
      if (used > room + EPSILON) break;
      count++;
    }
    return count;
  }
}

/** Destinations with no text to stand at: they are put at the top left of the room they are given, which they take none of. */
class AnchorFlow implements Flow {
  readonly height = 0;

  constructor(
    private readonly context: TableContext,
    private readonly names: readonly string[]
  ) {}

  draw(x: number, y: number): FlowDrawn {
    this.context.writer.destinations.place(this.names, x, y);
    return { end: y };
  }
}

/** A picture: scaled to its cell's width and to a page's height, drawn whole or not at all. */
class ImageFlow implements Flow {
  readonly height: number;
  private readonly width: number;

  constructor(
    private readonly context: TableContext,
    private readonly image: PdfRasterImage,
    availableWidth: number,
    fresh: number
  ) {
    const naturalWidth = image.widthPx * PX_TO_PT;
    const naturalHeight = image.heightPx * PX_TO_PT;
    const scale = Math.min(1, availableWidth / naturalWidth, fresh / naturalHeight);
    this.width = naturalWidth * scale;
    this.height = naturalHeight * scale;
  }

  draw(x: number, y: number, room: number): FlowDrawn {
    if (this.height > room + EPSILON) return { end: y, rest: this };
    try {
      this.context.doc.image(this.image.data, x, y, { width: this.width, height: this.height });
    } catch (err) {
      throw new ConversionFailedError(`Embedded image could not be decoded: ${(err as Error).message}`);
    }
    return { end: y + this.height };
  }
}

/** Flows one under the other, with no space between them. */
class StackFlow implements Flow {
  readonly height: number;

  constructor(private readonly parts: readonly Flow[]) {
    this.height = parts.reduce((sum, part) => sum + part.height, 0);
  }

  draw(x: number, y: number, room: number): FlowDrawn {
    let end = y;
    for (const [index, part] of this.parts.entries()) {
      const drawn = part.draw(x, end, room - (end - y));
      end = drawn.end;
      if (drawn.rest) return { end, rest: new StackFlow([drawn.rest, ...this.parts.slice(index + 1)]) };
    }
    return { end };
  }
}

/** A place in the grid without a cell: its left edge from the table's left edge, and its width. */
interface Slot {
  readonly x: number;
  readonly width: number;
}

/** A cell and the rows it fills in its group of rows, with its content and its height when drawn whole. */
interface CellSpec {
  readonly row: number;
  readonly lastRow: number;
  readonly x: number;
  readonly width: number;
  readonly height: number;
  readonly flow: Flow | undefined;
}

/** A cell with the box it fills in its group of rows: `top` and `bottom` are measured from the top of the group. */
interface PlacedCell extends CellSpec {
  readonly top: number;
  readonly bottom: number;
}

/** What is drawn of a group of rows so far: the height already drawn, and what is left of each cell's content. */
interface GroupProgress {
  readonly drawn: number;
  readonly flows: ReadonlyArray<Flow | undefined>;
}

interface GroupDrawn {
  readonly end: number;
  readonly next?: GroupProgress;
}

/** The part of a group that one page shows: from `from` to `to` measured from the top of the group, drawn from `y`. */
interface Window {
  readonly y: number;
  readonly from: number;
  readonly to: number;
}

/** Rows that a merged cell ties together; a group is never separated by a page break unless it is taller than a page. */
class RowGroup {
  readonly height: number;
  private readonly tops: readonly number[];
  private readonly cells: readonly PlacedCell[];
  private readonly cellsByRow: ReadonlyArray<readonly number[]>;

  constructor(
    private readonly rowHeights: readonly number[],
    specs: readonly CellSpec[],
    private readonly emptyColumns: ReadonlyArray<readonly Slot[]>
  ) {
    const tops: number[] = [];
    let top = 0;
    for (const rowHeight of rowHeights) {
      tops.push(top);
      top += rowHeight;
    }
    this.tops = tops;
    this.height = top;
    this.cells = specs.map((spec) => ({ ...spec, top: tops[spec.row], bottom: tops[spec.lastRow] + rowHeights[spec.lastRow] }));
    const byRow: number[][] = rowHeights.map(() => []);
    this.cells.forEach((cell, index) => byRow[cell.row].push(index));
    this.cellsByRow = byRow;
  }

  start(): GroupProgress {
    return { drawn: 0, flows: this.cells.map((cell) => cell.flow) };
  }

  /** Index of the first row that reaches below `from`; the number of rows when none does. */
  private firstRowBelow(from: number): number {
    const index = this.tops.findIndex((top, row) => top + this.rowHeights[row] > from);
    return index === -1 ? this.rowHeights.length : index;
  }

  /** Draws the rows from `progress.drawn` on, in at most `room` points below `y`, with the table's left edge at `x0`. */
  draw(context: TableContext, x0: number, y: number, progress: GroupProgress, room: number): GroupDrawn {
    const { doc } = context;
    const from = progress.drawn;
    const to = from + room;
    const window: Window = { y, from, to };
    const first = this.firstRowBelow(from);
    // The y each visible row starts at, chained from the first so that rows drawn whole land where they are summed.
    const rowTop: number[] = [];
    let lastRow = first;
    for (let row = first; row < this.rowHeights.length && this.tops[row] < to; row++) {
      rowTop[row] = row === first ? y - (from - this.tops[row]) : rowTop[row - 1] + this.rowHeights[row - 1];
      lastRow = row;
    }
    const flows = [...progress.flows];
    let bottom = y;
    const draw = (index: number): void => {
      bottom = Math.max(bottom, this.drawCell(context, x0, { index, flows, window, rowTop }));
    };
    const carried = this.cells.flatMap((cell, index) => (cell.row < first ? [index] : []));
    for (let row = first; row <= lastRow; row++) {
      doc.fontSize(TABLE_FONT_SIZE);
      doc.lineWidth(TABLE_BORDER_WIDTH);
      if (row === first) carried.forEach(draw);
      (this.cellsByRow[row] ?? []).forEach(draw);
      if (rowTop[row] !== undefined) bottom = Math.max(bottom, this.drawEmptyColumns(doc, x0, row, rowTop[row], window));
    }
    const finished = to >= this.height && flows.every((flow) => flow === undefined);
    if (!finished) return { end: y + (to - from), next: { drawn: to, flows } };
    const rowsEnd = rowTop[this.rowHeights.length - 1] === undefined ? y : rowTop[this.rowHeights.length - 1] + this.rowHeights[this.rowHeights.length - 1];
    return { end: Math.max(rowsEnd, bottom) };
  }

  /** Draws the part of one cell that falls in the window and returns the y its box ends at. */
  private drawCell(
    context: TableContext,
    x0: number,
    state: { index: number; flows: Array<Flow | undefined>; window: Window; rowTop: readonly number[] }
  ): number {
    const { index, flows, window, rowTop } = state;
    const { y, from, to } = window;
    const cell = this.cells[index];
    const flow = flows[index];
    if (cell.top >= to || (cell.bottom <= from && flow === undefined)) return y;
    const startsHere = cell.top >= from;
    const top = startsHere ? rowTop[cell.row] : y;
    const contentRoom = to - Math.max(cell.top, from) - 2 * TABLE_CELL_PADDING;
    let rest = flow;
    let contentEnd = top;
    if (flow !== undefined && contentRoom > 0) {
      const drawn = flow.draw(x0 + cell.x + TABLE_CELL_PADDING, top + TABLE_CELL_PADDING, contentRoom);
      rest = drawn.rest;
      contentEnd = drawn.end + TABLE_CELL_PADDING;
    }
    flows[index] = rest;
    const height = this.boxHeight(cell, { top, contentEnd, finished: rest === undefined && cell.bottom <= to, startsHere }, state);
    context.doc.rect(x0 + cell.x, top, cell.width, height).stroke();
    return top + height;
  }

  /** Height of a cell's box in this window: its own when drawn whole, down to its content when that runs past it, else to the window's end. */
  private boxHeight(
    cell: PlacedCell,
    drawn: { top: number; contentEnd: number; finished: boolean; startsHere: boolean },
    state: { window: Window; rowTop: readonly number[] }
  ): number {
    const { top, contentEnd, finished, startsHere } = drawn;
    const { window, rowTop } = state;
    if (!finished) return window.y + (window.to - window.from) - top;
    if (startsHere && contentEnd <= top + cell.height + EPSILON) return cell.height;
    const lastTop = rowTop[cell.lastRow];
    const boxEnd = lastTop === undefined ? window.y + (Math.min(cell.bottom, window.to) - window.from) : lastTop + this.rowHeights[cell.lastRow];
    return Math.max(boxEnd, contentEnd) - top;
  }

  /** Draws the grid positions a short row leaves without a cell, and returns the y the row ends at. */
  private drawEmptyColumns(doc: PDFKit.PDFDocument, x0: number, row: number, top: number, window: Window): number {
    const rowHeight = this.rowHeights[row];
    const visibleTop = Math.max(top, window.y);
    const windowBottom = window.y + (window.to - window.from);
    const clipped = visibleTop > top || top + rowHeight > windowBottom + EPSILON;
    const height = clipped ? Math.min(top + rowHeight, windowBottom) - visibleTop : rowHeight;
    for (const slot of this.emptyColumns[row]) {
      doc.rect(x0 + slot.x, visibleTop, slot.width, height).stroke();
    }
    return visibleTop + height;
  }
}

/** The rows of a table, drawn from the group and the point inside it that `progress` names. */
export class TableFlow implements Flow {
  readonly height: number;

  constructor(
    private readonly layout: TableLayout,
    private readonly group = 0,
    private readonly progress?: GroupProgress
  ) {
    this.height = Math.max(0, layout.heightFrom[group] - (progress?.drawn ?? 0));
  }

  draw(x: number, y: number, room: number): FlowDrawn {
    const { groups, context, fresh, minSplitRoom } = this.layout;
    const limit = y + room;
    let end = y;
    let progress = this.progress;
    for (let index = this.group; index < groups.length; index++) {
      const rows = groups[index];
      const mustSplit = progress !== undefined || rows.height > fresh + EPSILON;
      const remaining = limit - end;
      const fits = progress === undefined && rows.height <= remaining + EPSILON;
      if (!fits && (!mustSplit || remaining < minSplitRoom)) return { end, rest: new TableFlow(this.layout, index, progress) };
      const drawn = rows.draw(context, x, end, progress ?? rows.start(), fits ? rows.height : remaining);
      end = drawn.end;
      if (drawn.next) return { end, rest: new TableFlow(this.layout, index, drawn.next) };
      progress = undefined;
    }
    return { end };
  }
}

/** The rows of a table laid out at one width. */
export class TableLayout {
  /** Height of the groups from each index to the end; one more entry than there are groups. */
  readonly heightFrom: readonly number[];

  constructor(
    readonly context: TableContext,
    readonly groups: readonly RowGroup[],
    /** Room a flow has at the top of a fresh page, in points: a group taller than this is cut. */
    readonly fresh: number,
    /** Least room worth starting a cut group in: one line of a cell. */
    readonly minSplitRoom: number
  ) {
    const heights = new Array<number>(groups.length + 1).fill(0);
    for (let index = groups.length - 1; index >= 0; index--) heights[index] = heights[index + 1] + groups[index].height;
    this.heightFrom = heights;
  }
}

/** The columns of a table: how many, and where each starts and how wide a cell over `span` columns from it is. */
interface Grid {
  readonly count: number;
  left(column: number): number;
  widthOf(column: number, span: number): number;
}

/** Equal columns. */
function equalGrid(count: number, width: number): Grid {
  const columnWidth = width / count;
  return { count, left: (column) => column * columnWidth, widthOf: (_, span) => span * columnWidth };
}

/** Columns of the widths given. */
function sizedGrid(widths: readonly number[]): Grid {
  const edges = [0];
  for (const width of widths) edges.push(edges[edges.length - 1] + width);
  return { count: widths.length, left: (column) => edges[column], widthOf: (column, span) => edges[column + span] - edges[column] };
}

function columnCount(rows: readonly PdfTableCell[][]): number {
  return rows.reduce((widest, row) => Math.max(widest, row.reduce((sum, cell) => sum + cell.span, 0)), 0);
}

/** Whether a table holds a table in one of its cells. */
function holdsTable(rows: readonly PdfTableCell[][]): boolean {
  return rows.some((row) => row.some((cell) => cell.parts?.some((part) => part.kind === 'table')));
}

/** The grid of a table in `width` points; refuses a table whose content cannot be set in that width. */
function gridOf(context: TableContext, rows: readonly PdfTableCell[][], size: { width: number; depth: number }): Grid {
  const count = columnCount(rows);
  const where = size.depth === 0 ? 'the page width' : 'the width of the cell that holds it';
  if (size.width / count < MIN_TABLE_COLUMN_WIDTH) {
    throw new EngineUnavailableError(
      'soffice',
      `a table with ${count} columns does not fit ${where}; the in-process PDF renderer needs columns of at least ${MIN_TABLE_COLUMN_WIDTH}pt`
    );
  }
  if (size.depth === 0 && !holdsTable(rows)) return equalGrid(count, size.width);
  context.doc.fontSize(TABLE_FONT_SIZE);
  const measure = measureTable(context, rows);
  if (size.width < measure.least) {
    throw new EngineUnavailableError(
      'soffice',
      `a table with ${count} columns and the tables inside it need ${Math.ceil(measure.least)}pt but ${where} is ${Math.floor(size.width)}pt; the in-process PDF renderer needs columns of at least ${MIN_TABLE_COLUMN_WIDTH}pt`
    );
  }
  return sizedGrid(automaticColumnWidths(measure, size.width));
}

function hasText(content: readonly PdfTextSegment[]): boolean {
  return content.some((segment) => segment.text.trim().length > 0);
}

/** The flow of text: its lines when it shows any, else its destinations alone, else nothing. */
function textFlows(context: TableContext, content: readonly PdfTextSegment[], width: number, fresh: number): Flow[] {
  if (hasText(content)) return [new TextFlow(context, content, width, fresh)];
  const names = anchorsOf(content);
  return names.length > 0 ? [new AnchorFlow(context, names)] : [];
}

/** The flow of one cell's content at `width`, or undefined when the cell shows nothing. */
function cellFlow(context: TableContext, cell: PdfTableCell, width: number, inner: { fresh: number; depth: number }): Flow | undefined {
  if (cell.covered) return undefined;
  if (!cell.parts) return textFlows(context, cell.content, width, inner.fresh)[0];
  const flows = cell.parts.flatMap((part) => partFlow(context, part, width, inner));
  return flows.length > 0 ? new StackFlow(flows) : undefined;
}

function partFlow(context: TableContext, part: PdfCellPart, width: number, inner: { fresh: number; depth: number }): Flow[] {
  switch (part.kind) {
    case 'text':
      return textFlows(context, part.content, width, inner.fresh);
    case 'image':
      return [new ImageFlow(context, part.image, width, inner.fresh)];
    case 'table': {
      const table = layoutTable(context, part.rows, { width, fresh: inner.fresh, depth: inner.depth + 1 });
      return table ? [table] : [];
    }
  }
}

interface Placement {
  readonly cell: PdfTableCell;
  readonly row: number;
  /** First grid column of the cell, and the number of columns it covers. */
  readonly column: number;
  readonly span: number;
  readonly flow: Flow | undefined;
}

/** Where every cell sits in the grid, and the flow of its content, for each row. */
function placeRows(context: TableContext, rows: readonly PdfTableCell[][], grid: Grid, inner: { fresh: number; depth: number }): Placement[][] {
  return rows.map((row, rowIndex) => {
    let column = 0;
    return row.map((cell): Placement => {
      const span = Math.min(cell.span, grid.count - column);
      const placement = {
        cell,
        row: rowIndex,
        column,
        span,
        flow: cellFlow(context, cell, grid.widthOf(column, span) - TABLE_CELL_PADDING * 2, inner),
      };
      column += span;
      return placement;
    });
  });
}

const rowSpanOf = (placement: Placement): number => Math.max(1, placement.cell.rowSpan ?? 1);

/** Row heights: the tallest single-row cell; a cell that merges downward grows its last row when it is taller than the rows it spans. */
function rowHeightsOf(placed: readonly Placement[][], minRowHeight: number): number[] {
  const needed = (placement: Placement): number => (placement.flow && placement.flow.height > 0 ? placement.flow.height + TABLE_CELL_PADDING * 2 : 0);
  const heights = placed.map((row) => row.reduce((tallest, placement) => (rowSpanOf(placement) === 1 ? Math.max(tallest, needed(placement)) : tallest), minRowHeight));
  placed.forEach((row, rowIndex) => {
    for (const placement of row) {
      if (rowSpanOf(placement) === 1) continue;
      const last = Math.min(rowIndex + rowSpanOf(placement), heights.length) - 1;
      const spanned = heights.slice(rowIndex, last + 1).reduce((sum, height) => sum + height, 0);
      if (spanned < needed(placement)) heights[last] += needed(placement) - spanned;
    }
  });
  return heights;
}

/** Index of the last row of each group of rows tied together by merged cells, in order. */
function groupEnds(placed: readonly Placement[][]): number[] {
  const ends: number[] = [];
  let reach = 0;
  placed.forEach((row, rowIndex) => {
    for (const placement of row) reach = Math.max(reach, Math.min(rowIndex + rowSpanOf(placement), placed.length) - 1);
    if (reach <= rowIndex) {
      ends.push(rowIndex);
      reach = rowIndex + 1;
    }
  });
  return ends;
}

function buildGroup(placed: readonly Placement[][], heights: readonly number[], range: { first: number; last: number }, grid: Grid): RowGroup {
  const specs: CellSpec[] = [];
  const emptyColumns: Slot[][] = [];
  for (let rowIndex = range.first; rowIndex <= range.last; rowIndex++) {
    let nextColumn = 0;
    for (const placement of placed[rowIndex]) {
      nextColumn = placement.column + placement.span;
      if (placement.cell.covered) continue;
      const lastRow = Math.min(rowIndex + rowSpanOf(placement), heights.length) - 1;
      const height = heights.slice(rowIndex, lastRow + 1).reduce((sum, rowHeight) => sum + rowHeight, 0);
      specs.push({
        row: rowIndex - range.first,
        lastRow: lastRow - range.first,
        x: grid.left(placement.column),
        width: grid.widthOf(placement.column, placement.span),
        height,
        flow: placement.flow,
      });
    }
    const empty: Slot[] = [];
    for (let column = nextColumn; column < grid.count; column++) empty.push({ x: grid.left(column), width: grid.widthOf(column, 1) });
    emptyColumns.push(empty);
  }
  return new RowGroup(heights.slice(range.first, range.last + 1), specs, emptyColumns);
}

/**
 * Lays the rows out in `width` points. `fresh` is the room a table has at the top of a fresh page. Undefined when no
 * row has a cell. Refuses columns narrower than 24 pt, and tables nested more than MAX_TABLE_DEPTH deep.
 */
export function layoutTable(context: TableContext, rows: readonly PdfTableCell[][], size: { width: number; fresh: number; depth: number }): TableFlow | undefined {
  if (size.depth > MAX_TABLE_DEPTH) {
    throw new EngineUnavailableError(
      'soffice',
      `HTML tables nested more than ${MAX_TABLE_DEPTH} levels deep cannot be drawn by the in-process PDF renderer; rendering it needs the native LibreOffice engine`
    );
  }
  if (columnCount(rows) === 0) return undefined;
  const grid = gridOf(context, rows, size);
  context.doc.fontSize(TABLE_FONT_SIZE);
  const minRowHeight = context.doc.currentLineHeight(true) + TABLE_CELL_PADDING * 2;
  const placed = placeRows(context, rows, grid, { fresh: size.fresh - TABLE_CELL_PADDING * 2, depth: size.depth });
  const heights = rowHeightsOf(placed, minRowHeight);
  const groups: RowGroup[] = [];
  let first = 0;
  for (const last of groupEnds(placed)) {
    groups.push(buildGroup(placed, heights, { first, last }, grid));
    first = last + 1;
  }
  return new TableFlow(new TableLayout(context, groups, size.fresh, minRowHeight));
}
