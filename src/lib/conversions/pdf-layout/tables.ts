import type { PdfContentItem, PdfContentRule } from '../pdf-text-types';
import { mergeSegments } from './columns';
import { LayoutBudget, PDF_LAYOUT_MAX_GRID_LINES, PDF_LAYOUT_MAX_TABLE_CELLS } from './limits';
import { paragraphsOfFlow } from './paragraphs';
import { buildRows, lineFromItems, splitSegments } from './lines';
import { isLowercase, firstChar } from './text-chars';
import { parseListMarker } from './lists';
import type { DetectedTable, FontList, LayoutLine, Paragraph, Row, TableCell } from './types';

/**
 * Tables, two ways.
 *
 * Lattice tables come from ruling lines (path operators of the page, ISO 32000-2 section 8.5): axis-aligned lines are merged,
 * grouped into connected grids, and the grid's cells are the rectangles the lines enclose; a cell whose shared edge has no
 * line is merged with its neighbour (colSpan, rowSpan).
 *
 * Stream tables come from aligned text without lines: consecutive rows with several segments whose gaps line up in
 * the same channels form columns. Prose in columns has the same shape, so a table needs short cells that do not flow
 * into each other.
 */

/** Rule coordinates within this many points are one line, and segments this close touch. */
const LINE_TOLERANCE = 1.5;
/** Most rules per axis a page may have for the grid search (the search compares every horizontal with every vertical rule). */
const MAX_RULES_PER_AXIS = 2_000;
/** A lattice needs two columns (three vertical lines) and one row (two horizontal lines); a table split over pages may leave one row. */
const MIN_GRID_COLUMN_LINES = 3;
const MIN_GRID_ROW_LINES = 2;
/** Share of a cell edge a line must cover for the edge to exist. */
const EDGE_COVERAGE = 0.9;
/** Where in a text run the point that places it in a cell is taken, as a share of its em above the baseline. */
const ANCHOR_RISE_EM = 0.3;

const MIN_STREAM_ROWS = 3;
/** Cells of a stream table are separated by gaps wider than this many em, finer than the gap that splits columns of text. */
const CELL_GAP_EM = 0.55;
/** A segment longer than this many characters is prose, not a cell. */
const MAX_CELL_CHARS = 80;
const MEDIAN_CELL_CHARS = 45;
/** Share of the rows that must have a gap in a channel for it to separate columns of a stream table. */
const CHANNEL_SUPPORT = 0.6;
const MIN_CHANNEL_POINTS = 6;
const MIN_FILLED_CELLS_PER_ROW = 1.6;
/** Share of cells that continue the cell above them, above which the columns are flowing prose. */
const FLOW_SHARE = 0.2;
/** A cell this long can be the first half of a sentence that goes on below. */
const LONG_CELL_CHARS = 25;
const SENTENCE_END = /[.!?:;\u3002\uff01\uff1f]$/u;
/** Rows further apart than this many em are not one table. */
const MAX_ROW_STEP_EM = 4.5;
/** A single-segment row this close below a table row continues one of its cells. */
const CONTINUATION_STEP_EM = 1.7;

interface Segment {
  /** Position along the axis of the line (y for horizontal, x for vertical). */
  at: number;
  from: number;
  to: number;
}

function clusterByPosition(rules: Segment[]): Segment[] {
  const sorted = [...rules].sort((a, b) => a.at - b.at || a.from - b.from);
  const merged: Segment[] = [];
  let bucket: Segment[] = [];
  const flushBucket = (): void => {
    if (bucket.length === 0) return;
    const at = bucket.reduce((sum, segment) => sum + segment.at, 0) / bucket.length;
    const byStart = [...bucket].sort((a, b) => a.from - b.from);
    let current = { at, from: byStart[0].from, to: byStart[0].to };
    for (const segment of byStart.slice(1)) {
      if (segment.from <= current.to + 2 * LINE_TOLERANCE) {
        current.to = Math.max(current.to, segment.to);
      } else {
        merged.push(current);
        current = { at, from: segment.from, to: segment.to };
      }
    }
    merged.push(current);
    bucket = [];
  };
  for (const segment of sorted) {
    if (bucket.length > 0 && segment.at - bucket[bucket.length - 1].at > LINE_TOLERANCE) flushBucket();
    bucket.push(segment);
  }
  flushBucket();
  return merged;
}

/** Disjoint-set forest over indices. */
class Components {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    let at = index;
    while (this.parent[at] !== root) {
      const next = this.parent[at];
      this.parent[at] = root;
      at = next;
    }
    return root;
  }

  join(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

function uniqueSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const result: number[] = [];
  for (const value of sorted) {
    if (result.length === 0 || value - result[result.length - 1] > LINE_TOLERANCE) result.push(value);
  }
  return result;
}

interface Grid {
  xs: number[];
  ys: number[];
  horizontal: Segment[];
  vertical: Segment[];
}

/** Whether a line at coordinate `at` covers the stretch [from, to] of a grid edge. */
function covers(lines: Segment[], at: number, from: number, to: number): boolean {
  const length = to - from;
  let covered = 0;
  const near = lines.filter((line) => Math.abs(line.at - at) <= LINE_TOLERANCE * 2);
  const spans = near.map((line) => [Math.max(line.from, from), Math.min(line.to, to)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let reach = from;
  for (const [a, b] of spans) {
    if (b <= reach) continue;
    covered += b - Math.max(a, reach);
    reach = b;
  }
  return covered >= EDGE_COVERAGE * length;
}

interface GridCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

/** Merged cells of a grid: a cell extends over every edge no line covers. */
function gridCells(grid: Grid): GridCell[] {
  const rows = grid.ys.length - 1;
  const cols = grid.xs.length - 1;
  const taken = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const cells: GridCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (taken[r][c]) continue;
      let colSpan = 1;
      while (c + colSpan < cols && !taken[r][c + colSpan] && !covers(grid.vertical, grid.xs[c + colSpan], grid.ys[r], grid.ys[r + 1])) colSpan++;
      let rowSpan = 1;
      while (r + rowSpan < rows) {
        let open = true;
        for (let k = c; k < c + colSpan && open; k++) {
          if (taken[r + rowSpan][k] || covers(grid.horizontal, grid.ys[r + rowSpan], grid.xs[k], grid.xs[k + 1])) open = false;
        }
        if (!open) break;
        rowSpan++;
      }
      for (let i = r; i < r + rowSpan; i++) for (let j = c; j < c + colSpan; j++) taken[i][j] = true;
      cells.push({ row: r, col: c, rowSpan, colSpan });
    }
  }
  return cells;
}

function cellParagraphs(items: PdfContentItem[], fonts: FontList, budget: LayoutBudget, flow: number, pageNumber: number): Paragraph[] {
  if (items.length === 0) return [];
  const rows = buildRows(items, fonts, budget);
  const lines = rows.map((row) => mergeSegments(row.segments));
  return paragraphsOfFlow(lines, flow, pageNumber, false);
}

function isBoldCell(paragraphs: Paragraph[]): boolean {
  return paragraphs.length > 0 && paragraphs.every((paragraph) => paragraph.lines.every((line) => line.bold));
}

export interface LatticeResult {
  tables: DetectedTable[];
  /** Text runs that are not inside a table. */
  remaining: PdfContentItem[];
}

function gridOf(horizontal: Segment[], vertical: Segment[]): Grid {
  return {
    xs: uniqueSorted(vertical.map((line) => line.at)),
    ys: uniqueSorted(horizontal.map((line) => line.at)),
    horizontal,
    vertical,
  };
}

/**
 * Tables drawn with ruling lines. Items inside a table's cells are removed from the page's text.
 */
export function detectLatticeTables(
  rules: PdfContentRule[],
  items: PdfContentItem[],
  fonts: FontList,
  budget: LayoutBudget,
  pageNumber: number
): LatticeResult {
  const horizontalRules: Segment[] = [];
  const verticalRules: Segment[] = [];
  for (const rule of rules) {
    if (rule.y0 === rule.y1 || rule.y1 - rule.y0 <= LINE_TOLERANCE) horizontalRules.push({ at: (rule.y0 + rule.y1) / 2, from: rule.x0, to: rule.x1 });
    else if (rule.x1 - rule.x0 <= LINE_TOLERANCE) verticalRules.push({ at: (rule.x0 + rule.x1) / 2, from: rule.y0, to: rule.y1 });
  }
  if (horizontalRules.length === 0 || verticalRules.length === 0) return { tables: [], remaining: items };
  const horizontal = clusterByPosition(horizontalRules);
  const vertical = clusterByPosition(verticalRules);
  if (horizontal.length > MAX_RULES_PER_AXIS || vertical.length > MAX_RULES_PER_AXIS) return { tables: [], remaining: items };

  budget.tick(horizontal.length * vertical.length);
  const components = new Components(horizontal.length + vertical.length);
  horizontal.forEach((h, hi) => {
    vertical.forEach((v, vi) => {
      const touches = v.at >= h.from - LINE_TOLERANCE && v.at <= h.to + LINE_TOLERANCE && h.at >= v.from - LINE_TOLERANCE && h.at <= v.to + LINE_TOLERANCE;
      if (touches) components.join(hi, horizontal.length + vi);
    });
  });
  const groups = new Map<number, { h: Segment[]; v: Segment[] }>();
  horizontal.forEach((line, index) => {
    const root = components.find(index);
    groups.set(root, groups.get(root) ?? { h: [], v: [] });
    groups.get(root)!.h.push(line);
  });
  vertical.forEach((line, index) => {
    const root = components.find(horizontal.length + index);
    groups.set(root, groups.get(root) ?? { h: [], v: [] });
    groups.get(root)!.v.push(line);
  });

  const tables: DetectedTable[] = [];
  let remaining = items;
  let tableNumber = 0;
  for (const group of groups.values()) {
    const grid = gridOf(group.h, group.v);
    if (grid.xs.length < MIN_GRID_COLUMN_LINES || grid.ys.length < MIN_GRID_ROW_LINES) continue;
    if (grid.xs.length > PDF_LAYOUT_MAX_GRID_LINES || grid.ys.length > PDF_LAYOUT_MAX_GRID_LINES) continue;
    if ((grid.xs.length - 1) * (grid.ys.length - 1) > PDF_LAYOUT_MAX_TABLE_CELLS) continue;
    tableNumber++;
    const table = buildLattice(grid, remaining, fonts, budget, pageNumber, tableNumber);
    if (table === null) continue;
    tables.push(table.table);
    remaining = table.remaining;
  }
  return { tables, remaining };
}

function buildLattice(
  grid: Grid,
  items: PdfContentItem[],
  fonts: FontList,
  budget: LayoutBudget,
  pageNumber: number,
  tableNumber: number
): { table: DetectedTable; remaining: PdfContentItem[] } | null {
  const rows = grid.ys.length - 1;
  const cols = grid.xs.length - 1;
  const cells = gridCells(grid);
  const owner = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1));
  cells.forEach((cell, index) => {
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) for (let c = cell.col; c < cell.col + cell.colSpan; c++) owner[r][c] = index;
  });
  const members: PdfContentItem[][] = cells.map(() => []);
  const remaining: PdfContentItem[] = [];
  const left = grid.xs[0];
  const right = grid.xs[cols];
  const top = grid.ys[0];
  const bottom = grid.ys[rows];
  budget.tick(items.length);
  let inside = 0;
  for (const item of items) {
    const x = item.x + item.width / 2;
    const y = item.baseline - ANCHOR_RISE_EM * item.size;
    if (item.angled || x < left || x > right || y < top || y > bottom) {
      remaining.push(item);
      continue;
    }
    const c = Math.min(cols - 1, Math.max(0, upperIndex(grid.xs, x) - 1));
    const r = Math.min(rows - 1, Math.max(0, upperIndex(grid.ys, y) - 1));
    members[owner[r][c]].push(item);
    inside++;
  }
  if (inside === 0) return null;

  const flowBase = 1_000_000 + tableNumber * PDF_LAYOUT_MAX_TABLE_CELLS;
  const content = cells.map((_, index) => cellParagraphs(members[index], fonts, budget, flowBase + index, pageNumber));
  const ordered: TableCell[][] = placeSlots(cells, rows, cols).map((slots) =>
    slots.map((slot): TableCell => {
      const cell = cells[slot.cell];
      if (slot.continuation) return { paragraphs: [], colSpan: cell.colSpan, rowSpan: 1, continuation: true, header: false };
      return { paragraphs: content[slot.cell], colSpan: cell.colSpan, rowSpan: cell.rowSpan, continuation: false, header: false };
    })
  );
  const first = ordered[0];
  if (rows > 1 && first.every((cell) => cell.continuation || isBoldCell(cell.paragraphs))) {
    for (const cell of first) cell.header = !cell.continuation;
  }
  return {
    table: {
      rows: ordered,
      columnWidths: grid.xs.slice(1).map((x, index) => x - grid.xs[index]),
      box: { x0: left, y0: top, x1: right, y1: bottom },
      pageNumber,
      kind: 'lattice',
    },
    remaining,
  };
}

interface Slot {
  cell: number;
  continuation: boolean;
}

/** Slots of every row in column order: the cells that start there and continuations of cells that span down. */
function placeSlots(cells: GridCell[], rows: number, cols: number): Slot[][] {
  const grid: (Slot | null)[][] = Array.from({ length: rows }, () => new Array<Slot | null>(cols).fill(null));
  cells.forEach((cell, index) => {
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
      grid[r][cell.col] = { cell: index, continuation: r > cell.row };
    }
  });
  return grid.map((row) => row.filter((slot): slot is Slot => slot !== null));
}

function emptyCell(colSpan: number): TableCell {
  return { paragraphs: [], colSpan, rowSpan: 1, continuation: false, header: false };
}

/** Index of the first coordinate greater than `value` (binary search). */
function upperIndex(coordinates: number[], value: number): number {
  let low = 0;
  let high = coordinates.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (coordinates[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

// ---------------------------------------------------------------------------------------------
// Stream tables
// ---------------------------------------------------------------------------------------------

interface Channel {
  x0: number;
  x1: number;
}

function isTabular(row: Row): boolean {
  return row.segments.length >= 2 && row.segments.every((segment) => segment.text.length <= MAX_CELL_CHARS);
}

function medianNumber(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Channels (vertical whitespace) that at least CHANNEL_SUPPORT of the rows have a gap in. */
function tableChannels(rows: Row[], budget: LayoutBudget): Channel[] {
  const gaps: Channel[] = [];
  for (const row of rows) {
    const segments = [...row.segments].sort((a, b) => a.box.x0 - b.box.x0);
    for (let i = 1; i < segments.length; i++) {
      const x0 = segments[i - 1].box.x1;
      const x1 = segments[i].box.x0;
      if (x1 - x0 >= MIN_CHANNEL_POINTS) gaps.push({ x0, x1 });
    }
  }
  gaps.sort((a, b) => a.x0 - b.x0);
  const clusters: (Channel & { hits: number })[] = [];
  for (const gap of gaps) {
    budget.tick();
    const last = clusters[clusters.length - 1];
    if (last && gap.x0 < last.x1) {
      const x0 = Math.max(last.x0, gap.x0);
      const x1 = Math.min(last.x1, gap.x1);
      if (x1 - x0 >= MIN_CHANNEL_POINTS / 2) {
        last.x0 = x0;
        last.x1 = x1;
        last.hits++;
        continue;
      }
    }
    clusters.push({ ...gap, hits: 1 });
  }
  const needed = Math.max(2, Math.ceil(CHANNEL_SUPPORT * rows.length));
  return clusters.filter((cluster) => cluster.hits >= needed).map(({ x0, x1 }) => ({ x0, x1 }));
}

function bandOf(x: number, channels: Channel[]): number {
  let band = 0;
  for (const channel of channels) if (x > (channel.x0 + channel.x1) / 2) band++;
  return band;
}

/**
 * Whether the cells of a column read on from one another: a cell that starts in lower case under a long cell that
 * did not end a sentence continues it, which is how prose in columns looks and a table does not.
 */
function flowsLikeProse(grid: { text: string; start: number }[][], bands: number): boolean {
  let continued = 0;
  let cells = 0;
  for (let band = 0; band < bands; band++) {
    let previous = '';
    for (const row of grid) {
      const cell = row.find((slot) => slot.start === band);
      if (!cell) continue;
      cells++;
      if (previous.length >= LONG_CELL_CHARS && !SENTENCE_END.test(previous.trimEnd()) && isLowercase(firstChar(cell.text))) continued++;
      previous = cell.text;
    }
  }
  return cells > 0 && continued > FLOW_SHARE * cells;
}

/** Whether the first column holds nothing but list markers: a list whose bullets sit apart from their text, not a table. */
function isMarkerColumn(grid: { text: string; start: number }[][]): boolean {
  const firsts = grid.map((row) => row.find((slot) => slot.start === 0)?.text).filter((text): text is string => text !== undefined);
  return firsts.length > 0 && firsts.every((text) => parseListMarker(`${text} x`) !== null);
}

/** The table a run of rows makes, or null when the run is prose in columns or too thin to be a table. */
function buildStreamTable(run: Row[], fonts: FontList, budget: LayoutBudget, pageNumber: number, tableNumber: number): DetectedTable | null {
  const tabular = run.filter(isTabular);
  if (tabular.length < MIN_STREAM_ROWS) return null;
  const channels = tableChannels(tabular, budget);
  if (channels.length === 0) return null;
  const bands = channels.length + 1;
  const grid: { text: string; lines: LayoutLine[]; span: number; start: number }[][] = [];
  const cellTexts: string[] = [];
  let filled = 0;
  for (const row of run) {
    if (isTabular(row)) {
      const slots: { text: string; lines: LayoutLine[]; span: number; start: number }[] = [];
      for (const segment of row.segments) {
        const start = bandOf(segment.box.x0 + 1, channels);
        const end = bandOf(segment.box.x1 - 1, channels);
        slots.push({ text: segment.text, lines: [segment], span: Math.max(1, end - start + 1), start });
        cellTexts.push(segment.text);
        filled++;
      }
      grid.push(slots);
    } else {
      // A single-segment row right under a table row continues the cell above it.
      const segment = row.segments[0];
      const target = grid[grid.length - 1]?.find((slot) => slot.start === bandOf((segment.box.x0 + segment.box.x1) / 2, channels));
      if (!target) return null;
      target.lines.push(segment);
      target.text += ` ${segment.text}`;
    }
  }
  if (filled / tabular.length < MIN_FILLED_CELLS_PER_ROW) return null;
  if (medianNumber(cellTexts.map((text) => text.length)) > MEDIAN_CELL_CHARS) return null;
  if (flowsLikeProse(grid, bands) || isMarkerColumn(grid)) return null;

  const left = Math.min(...run.map((row) => row.segments[0].box.x0));
  const right = Math.max(...run.map((row) => Math.max(...row.segments.map((segment) => segment.box.x1))));
  const edges = [left, ...channels.map((channel) => (channel.x0 + channel.x1) / 2), right];
  const rowsOut: TableCell[][] = grid.map((slots, rowIndex) => {
    const cells: TableCell[] = [];
    let column = 0;
    const sorted = [...slots].sort((a, b) => a.start - b.start);
    for (const slot of sorted) {
      for (; column < slot.start; column++) cells.push(emptyCell(1));
      const paragraphs = paragraphsOfFlow(slot.lines, 2_000_000 + tableNumber * PDF_LAYOUT_MAX_TABLE_CELLS + rowIndex * bands + slot.start, pageNumber, false);
      cells.push({ paragraphs, colSpan: slot.span, rowSpan: 1, continuation: false, header: false });
      column = slot.start + slot.span;
    }
    for (; column < bands; column++) cells.push(emptyCell(1));
    return cells;
  });
  if (rowsOut[0].every((cell) => cell.paragraphs.length === 0 || isBoldCell(cell.paragraphs))) {
    for (const cell of rowsOut[0]) cell.header = cell.paragraphs.length > 0;
  }
  return {
    rows: rowsOut,
    columnWidths: edges.slice(1).map((edge, index) => edge - edges[index]),
    box: { x0: left, y0: Math.min(...run.map((row) => row.top)), x1: right, y1: Math.max(...run.map((row) => row.bottom)) },
    pageNumber,
    kind: 'stream',
  };
}

function isContinuation(row: Row, previous: Row): boolean {
  if (row.segments.length !== 1) return false;
  const size = row.segments[0].size;
  return row.baseline - previous.baseline <= CONTINUATION_STEP_EM * size && row.segments[0].text.length <= MAX_CELL_CHARS;
}

/** The row split into cells at the finer gap; rows without their runs keep their own segments. */
function cellRow(row: Row, fonts: FontList): Row {
  if (!row.items || row.table) return row;
  const segments = splitSegments(row.items, CELL_GAP_EM).map((segment) => lineFromItems(segment, fonts));
  return { ...row, segments };
}

/** Replaces each run of rows that is a stream table with one table row. */
export function detectStreamTables(pageRows: Row[], fonts: FontList, budget: LayoutBudget, pageNumber: number): Row[] {
  const rows = pageRows.map((row) => cellRow(row, fonts));
  const output: Row[] = [];
  let at = 0;
  let tableNumber = 0;
  while (at < rows.length) {
    if (!isTabular(rows[at])) {
      output.push(rows[at]);
      at++;
      continue;
    }
    let end = at + 1;
    while (end < rows.length) {
      const previous = rows[end - 1];
      const row = rows[end];
      const step = row.baseline - previous.baseline;
      const size = Math.max(row.segments[0].size, previous.segments[0].size);
      if (step > MAX_ROW_STEP_EM * size) break;
      if (!isTabular(row) && !isContinuation(row, previous)) break;
      end++;
    }
    budget.tick(end - at);
    // A trailing continuation row that follows no tabular row is not part of the table.
    let runEnd = end;
    while (runEnd > at && !isTabular(rows[runEnd - 1])) runEnd--;
    const run = rows.slice(at, runEnd);
    tableNumber++;
    const table = buildStreamTable(run, fonts, budget, pageNumber, tableNumber);
    if (table) {
      output.push({ segments: [tableSegment(table)], baseline: table.box.y1, top: table.box.y0, bottom: table.box.y1, table });
    } else {
      output.push(...pageRows.slice(at, runEnd));
    }
    at = runEnd;
  }
  return output;
}

/** The single segment a table row carries: only its box matters to the column logic. */
export function tableSegment(table: DetectedTable): LayoutLine {
  return {
    runs: [],
    text: '',
    box: table.box,
    baseline: table.box.y1,
    size: 0,
    bold: false,
    italic: false,
    monospace: false,
    rtl: false,
    fontKey: '',
    vertical: false,
  };
}

