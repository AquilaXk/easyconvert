import { LayoutBudget, PDF_LAYOUT_MAX_DEPTH } from './limits';
import type { DetectedTable, LayoutLine, Row, StyledRun } from './types';

/**
 * Reading order across columns by masked recursive cuts (the method XY-Cut++ describes, arXiv 2504.10258): vertical
 * channels free of text are found first, rows that cross a channel (titles, full-width figures' captions) are masked
 * out as separators, and the rest is read column by column between separators. Lines in no channel keep their order
 * from top to bottom.
 */

/** A gap must be at least this wide in points, and this many em of the text beside it, to separate columns. */
const MIN_GUTTER_POINTS = 8;
const MIN_GUTTER_EM = 0.8;
/** Rows that have text on both sides of a gutter before it counts as one. */
const MIN_SUPPORT_ROWS = 3;
/** Rows that cross a gutter (and are masked as separators) must be at most this share of the rows that respect it. */
const MAX_CROSSER_SHARE = 0.25;
/** Median width (em) of the text on each side of a gutter; narrower pieces are list markers and numeric cells. */
const MIN_COLUMN_EM = 5;
/** Text overlapping the gutter's centre by less than this many points does not cross it. */
const CROSS_TOLERANCE = 0.5;
/** Most gutters (columns minus one) a region may have. */
const MAX_GUTTERS = 8;
/** Resolution of the occupancy profile, in points. */
const PROFILE_STEP = 1;
/** Widest page the profile covers, in points. */
const MAX_PROFILE_WIDTH = 20_000;

/**
 * A piece of the reading order: lines read as one flow, or a table. A `full` group is a separator row that crosses
 * columns; groups made from one band of columns share a `band` number and `columns` counts the columns of the band.
 */
export interface LineGroup {
  lines: LayoutLine[];
  table?: DetectedTable;
  full: boolean;
  columns: number;
  band: number;
}

interface Gutter {
  x0: number;
  x1: number;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Joins the segments of a row into one line, in reading order. */
export function mergeSegments(segments: LayoutLine[]): LayoutLine {
  if (segments.length === 1) return segments[0];
  const rtl = segments.filter((segment) => segment.rtl).length * 2 > segments.length;
  const ordered = rtl ? [...segments].sort((a, b) => b.box.x0 - a.box.x0) : [...segments].sort((a, b) => a.box.x0 - b.box.x0);
  return mergeLines(ordered, ' ', rtl);
}

/** Concatenates lines (already in reading order) with `joiner` between them. */
export function mergeLines(lines: LayoutLine[], joiner: string, rtl: boolean): LayoutLine {
  const runs: StyledRun[] = [];
  let text = '';
  lines.forEach((line, index) => {
    const separator = index === 0 ? '' : joiner;
    if (separator !== '' && runs.length > 0) runs[runs.length - 1] = { ...runs[runs.length - 1], text: runs[runs.length - 1].text + separator };
    for (const run of line.runs) runs.push({ ...run });
    text += separator + line.text;
  });
  const biggest = lines.reduce((best, line) => (line.text.length > best.text.length ? line : best), lines[0]);
  return {
    runs,
    text,
    box: {
      x0: Math.min(...lines.map((line) => line.box.x0)),
      x1: Math.max(...lines.map((line) => line.box.x1)),
      y0: Math.min(...lines.map((line) => line.box.y0)),
      y1: Math.max(...lines.map((line) => line.box.y1)),
    },
    baseline: biggest.baseline,
    size: biggest.size,
    bold: biggest.bold,
    italic: biggest.italic,
    monospace: biggest.monospace,
    rtl,
    fontKey: biggest.fontKey,
    vertical: false,
  };
}

/** A gutter: the plateau of x positions where the most rows have a gap; only its centre separates columns. */
interface Gap {
  x0: number;
  x1: number;
}

function gapsOf(row: Row): Gap[] {
  const gaps: Gap[] = [];
  const segments = [...row.segments].sort((a, b) => a.box.x0 - b.box.x0);
  for (let i = 1; i < segments.length; i++) {
    const x0 = segments[i - 1].box.x1;
    const x1 = segments[i].box.x0;
    const size = Math.max(segments[i - 1].size, segments[i].size);
    if (x1 - x0 >= Math.max(MIN_GUTTER_POINTS, MIN_GUTTER_EM * size)) gaps.push({ x0, x1 });
  }
  return gaps;
}

function centreOf(gutter: Gutter): number {
  return (gutter.x0 + gutter.x1) / 2;
}

/** Whether some segment of the row has text on both sides of the gutter's centre. */
function crosses(row: Row, gutter: Gutter): boolean {
  const centre = centreOf(gutter);
  return row.segments.some((segment) => segment.box.x0 < centre - CROSS_TOLERANCE && segment.box.x1 > centre + CROSS_TOLERANCE);
}

/** Whether the row has text on both sides of the gutter's centre and none across it. */
function respects(row: Row, gutter: Gutter): boolean {
  if (crosses(row, gutter)) return false;
  const centre = centreOf(gutter);
  const left = row.segments.some((segment) => segment.box.x1 <= centre + CROSS_TOLERANCE);
  const right = row.segments.some((segment) => segment.box.x0 >= centre - CROSS_TOLERANCE);
  return left && right;
}

/** Width of the text on one side of the gutter in a row. */
function sideWidth(row: Row, gutter: Gutter, side: 'left' | 'right'): number {
  const centre = centreOf(gutter);
  const pieces = row.segments.filter((segment) => (side === 'left' ? segment.box.x1 <= centre + CROSS_TOLERANCE : segment.box.x0 >= centre - CROSS_TOLERANCE));
  if (pieces.length === 0) return 0;
  return Math.max(...pieces.map((segment) => segment.box.x1)) - Math.min(...pieces.map((segment) => segment.box.x0));
}

/**
 * Gutters that separate columns, left to right. Each row's gaps are counted into an occupancy profile; the best
 * plateau becomes a gutter when enough rows respect it, few rows cross it, and the text on both sides is wide.
 */
function findGutters(rows: Row[], budget: LayoutBudget): Gutter[] {
  const gapRows = rows.filter((row) => row.segments.length >= 2);
  if (gapRows.length < MIN_SUPPORT_ROWS) return [];
  const left = Math.floor(Math.min(...rows.flatMap((row) => row.segments.map((segment) => segment.box.x0))));
  const right = Math.ceil(Math.max(...rows.flatMap((row) => row.segments.map((segment) => segment.box.x1))));
  const cells = Math.ceil((right - left) / PROFILE_STEP) + 1;
  if (cells <= 0 || cells > MAX_PROFILE_WIDTH) return [];
  const delta = new Int32Array(cells + 1);
  for (const row of gapRows) {
    for (const gap of gapsOf(row)) {
      delta[Math.max(0, Math.floor((gap.x0 - left) / PROFILE_STEP))]++;
      delta[Math.min(cells, Math.ceil((gap.x1 - left) / PROFILE_STEP))]--;
    }
  }
  budget.tick(cells + rows.length);
  const profile = new Int32Array(cells);
  let running = 0;
  for (let i = 0; i < cells; i++) {
    running += delta[i];
    profile[i] = running;
  }

  const gutters: Gutter[] = [];
  for (let attempt = 0; attempt < MAX_GUTTERS; attempt++) {
    let best = 0;
    let peak = 0;
    for (let i = 0; i < cells; i++) {
      if (profile[i] > peak) {
        peak = profile[i];
        best = i;
      }
    }
    if (peak < MIN_SUPPORT_ROWS) break;
    let from = best;
    let to = best;
    while (from > 0 && profile[from - 1] === peak) from--;
    while (to < cells - 1 && profile[to + 1] === peak) to++;
    const gutter: Gutter = { x0: left + from * PROFILE_STEP, x1: left + (to + 1) * PROFILE_STEP };
    // Whatever the verdict, this plateau and its neighbourhood are used up.
    const reach = Math.max(1, to - from + 1);
    for (let i = Math.max(0, from - reach); i <= Math.min(cells - 1, to + reach); i++) profile[i] = 0;
    budget.tick(rows.length);
    const supporters = rows.filter((row) => respects(row, gutter));
    const crossers = rows.filter((row) => crosses(row, gutter));
    if (supporters.length < MIN_SUPPORT_ROWS) continue;
    if (crossers.length > Math.max(1, MAX_CROSSER_SHARE * supporters.length)) continue;
    const em = medianOf(supporters.map((row) => row.segments[0].size));
    if (medianOf(supporters.map((row) => sideWidth(row, gutter, 'left'))) < MIN_COLUMN_EM * em) continue;
    if (medianOf(supporters.map((row) => sideWidth(row, gutter, 'right'))) < MIN_COLUMN_EM * em) continue;
    gutters.push(gutter);
  }
  return gutters.sort((a, b) => a.x0 - b.x0);
}

function columnIndexOf(segment: LayoutLine, gutters: Gutter[]): number {
  const centre = (segment.box.x0 + segment.box.x1) / 2;
  let index = 0;
  for (const gutter of gutters) {
    if (centre > centreOf(gutter)) index++;
  }
  return index;
}

function flatten(rows: Row[], columns: number, band: number): LineGroup[] {
  const groups: LineGroup[] = [];
  let lines: LayoutLine[] = [];
  const flushLines = (): void => {
    if (lines.length > 0) groups.push({ lines, full: false, columns, band });
    lines = [];
  };
  for (const row of rows) {
    if (row.table) {
      flushLines();
      groups.push({ lines: [], table: row.table, full: false, columns, band });
    } else {
      lines.push(mergeSegments(row.segments));
    }
  }
  flushLines();
  return groups;
}

/**
 * Orders the rows of a region into flows. Rows are given top to bottom.
 * @param rightToLeft read columns from the right (the region's text is mostly right to left).
 */
export function orderRows(rows: Row[], budget: LayoutBudget, rightToLeft: boolean, depth = 0, nextBand = { value: 0 }): LineGroup[] {
  if (rows.length === 0) return [];
  const gutters = depth < PDF_LAYOUT_MAX_DEPTH ? findGutters(rows, budget) : [];
  if (gutters.length === 0) return flatten(rows, 1, -1);

  const groups: LineGroup[] = [];
  let band: Row[][] = Array.from({ length: gutters.length + 1 }, () => []);
  const flush = (): void => {
    const columns = rightToLeft ? [...band].reverse() : band;
    const bandId = nextBand.value++;
    for (const column of columns) {
      if (column.length === 0) continue;
      budget.tick(column.length);
      for (const group of orderRows(column, budget, rightToLeft, depth + 1, nextBand)) {
        groups.push({ ...group, columns: gutters.length + 1, band: bandId });
      }
    }
    band = Array.from({ length: gutters.length + 1 }, () => []);
  };
  for (const row of rows) {
    budget.tick(row.segments.length);
    if (gutters.some((gutter) => crosses(row, gutter))) {
      flush();
      if (row.table) groups.push({ lines: [], table: row.table, full: true, columns: 1, band: -1 });
      else groups.push({ lines: [mergeSegments(row.segments)], full: true, columns: 1, band: -1 });
      continue;
    }
    const pieces: LayoutLine[][] = Array.from({ length: gutters.length + 1 }, () => []);
    for (const segment of row.segments) pieces[columnIndexOf(segment, gutters)].push(segment);
    pieces.forEach((segments, index) => {
      if (segments.length === 0) return;
      const top = Math.min(...segments.map((segment) => segment.box.y0));
      const bottom = Math.max(...segments.map((segment) => segment.box.y1));
      band[index].push({ segments, baseline: row.baseline, top, bottom, table: row.table });
    });
  }
  flush();
  return groups;
}

/** Whether a region's lines are mostly right to left, which decides the order of its columns. */
export function isRightToLeftRegion(rows: Row[]): boolean {
  let rtl = 0;
  let total = 0;
  for (const row of rows) {
    for (const segment of row.segments) {
      total += segment.text.length;
      if (segment.rtl) rtl += segment.text.length;
    }
  }
  return total > 0 && rtl * 2 > total;
}

