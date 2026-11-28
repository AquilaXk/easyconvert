import type { PdfContentColour, PdfContentItem } from '../pdf-text-types';
import { LayoutBudget } from './limits';
import { isWhitespace } from './text-chars';
import { helveticaAdvance } from './wrap-fit';

/**
 * Text that a page draws twice at (almost) the same place: a bold imitation, or a shadow under a title. The two copies are
 * not always cut into runs alike (one has "EMAP-" and "GRE designs", the other "EMAP" and "-GRE designs"), so runs are compared by
 * their characters: a character is a duplicate when an equal character of another run stands where it does, within a share of
 * the text's size. The run drawn last is the one seen, so it is kept whole; of an earlier run the characters that a later one
 * covers are cut off its ends, and a run whose characters are all covered is dropped.
 */

/** Points two runs may stand apart, whatever their size, and still be one run drawn twice (a bold imitation). */
const MIN_DISTANCE = 0.6;
/** Share of the text's size two copies may stand apart (a shadow of 1.3 points under type of 32). */
const DISTANCE_EM = 0.08;
/** Share of its size two runs may differ in size to be copies of each other. */
const SIZE_TOLERANCE = 0.05;
/** The cells of the grid that holds the runs kept, in points: a copy stands in the cell of its original or next to it. */
const CELL_WIDTH = 32;
const CELL_HEIGHT = 16;
/** Cells along a run that it is held in at most; a longer run is held in its first ones and found by its start. */
const MAX_CELLS_PER_RUN = 64;
/** Cells in a row of the grid: a cell is `row * CELL_COLUMNS + column`, with the column kept within the row for any page the reader gives. */
const CELL_COLUMNS = 1 << 20;

/** A run and where each of its characters stands: `edges` are the x of the left edge of every character and of the right edge of the last. */
interface Placed {
  item: PdfContentItem;
  chars: string[];
  /** UTF-16 offset in `item.text` of each character, and the length of the text after the last. */
  starts: number[];
  edges: number[];
}

/** The characters of a run, each with the share of the run's width that Helvetica gives it: the face the page was set in is not known, and the run's own width is. */
function place(item: PdfContentItem): Placed {
  const chars = [...item.text];
  const starts: number[] = [];
  const edges: number[] = [item.x];
  let offset = 0;
  let total = 0;
  const advances = chars.map((char) => helveticaAdvance(char));
  for (const advance of advances) total += advance;
  let units = 0;
  chars.forEach((char, index) => {
    starts.push(offset);
    offset += char.length;
    units += advances[index];
    edges.push(item.x + (item.width * units) / total);
  });
  starts.push(offset);
  return { item, chars, starts, edges };
}

function toleranceOf(item: PdfContentItem): number {
  return Math.max(MIN_DISTANCE, DISTANCE_EM * item.size);
}

/** Whether `other` could hold copies of the characters of `placed`: the same size, on one line, and over the same stretch of it. */
function isNear(placed: Placed, other: Placed): boolean {
  const { item } = placed;
  const tolerance = toleranceOf(item);
  return (
    Math.abs(other.item.baseline - item.baseline) <= tolerance &&
    Math.abs(other.item.size - item.size) <= SIZE_TOLERANCE * item.size &&
    other.edges[0] <= placed.edges[placed.chars.length] + tolerance &&
    other.edges[other.chars.length] >= placed.edges[0] - tolerance
  );
}

/** Marks the characters of `placed` that `other` holds an equal character for, near enough. */
function markCovered(placed: Placed, other: Placed, covered: boolean[], budget: LayoutBudget): void {
  const tolerance = toleranceOf(placed.item);
  let from = 0;
  placed.chars.forEach((char, index) => {
    if (covered[index] || isWhitespace(char)) return;
    const centre = (placed.edges[index] + placed.edges[index + 1]) / 2;
    while (from < other.chars.length && (other.edges[from] + other.edges[from + 1]) / 2 < centre - tolerance) from++;
    for (let at = from; at < other.chars.length; at++) {
      budget.tick();
      const otherCentre = (other.edges[at] + other.edges[at + 1]) / 2;
      if (otherCentre > centre + tolerance) break;
      if (other.chars[at] === char) {
        covered[index] = true;
        break;
      }
    }
  });
}

/** The colours of the characters of the stretch `from` to `to` (UTF-16 offsets) of a run, with the stretches ending where the shorter text does. */
function coloursOf(colours: readonly PdfContentColour[], from: number, to: number): PdfContentColour[] {
  const kept: PdfContentColour[] = [];
  let begin = 0;
  for (const { end, color } of colours) {
    if (Math.min(end, to) > Math.max(begin, from)) kept.push({ end: Math.min(end, to) - from, color });
    begin = end;
  }
  return kept;
}

/** The run with the characters before `first` and from `last` on left out, standing where those characters stood. */
function cut(placed: Placed, first: number, last: number): PdfContentItem {
  const { item, starts, edges } = placed;
  const text = item.text.slice(starts[first], starts[last]);
  const trimmed: PdfContentItem = { ...item, text, x: edges[first], width: edges[last] - edges[first] };
  const colors = item.colors ? coloursOf(item.colors, starts[first], starts[last]) : [];
  if (colors.length > 0) trimmed.colors = colors;
  else delete trimmed.colors;
  return trimmed;
}

/** What is left of a run once the characters that others cover are cut off its ends, or undefined when no character of it is left. */
function uncovered(placed: Placed, covered: readonly boolean[]): PdfContentItem | undefined {
  const count = placed.chars.length;
  if (!covered.includes(true)) return placed.item;
  const open = placed.chars.map((char, index) => !covered[index] && !isWhitespace(char));
  const first = open.indexOf(true);
  if (first < 0) return undefined;
  const last = open.lastIndexOf(true) + 1;
  // Characters covered between two that are not stay: the run is cut at its ends only. Text that runs right to left is not cut: its characters are in logical order, the page's x in visual.
  return (first === 0 && last === count) || placed.item.rtl ? placed.item : cut(placed, first, last);
}

/** The grid cells a run is held in: those along it on its row of the grid, at most `MAX_CELLS_PER_RUN`. */
function cellsOf(placed: Placed, reach = 0): number[] {
  const first = Math.floor(placed.edges[0] / CELL_WIDTH) - reach;
  const last = Math.min(first + MAX_CELLS_PER_RUN, Math.floor(placed.edges[placed.chars.length] / CELL_WIDTH) + reach);
  const row = Math.floor(placed.item.baseline / CELL_HEIGHT);
  const cells: number[] = [];
  for (let column = first; column <= last; column++) cells.push(row * CELL_COLUMNS + column);
  return cells;
}

/** The runs held in the cells a copy of `placed` can stand in: along it and one cell either side, on its row of the grid and the rows above and below. */
function nearbyRuns(grid: ReadonlyMap<number, Placed[]>, placed: Placed): Set<Placed> {
  const found = new Set<Placed>();
  for (const cell of cellsOf(placed, 1)) {
    for (const rowShift of [-CELL_COLUMNS, 0, CELL_COLUMNS]) {
      for (const other of grid.get(cell + rowShift) ?? []) found.add(other);
    }
  }
  return found;
}

/**
 * Drops text drawn twice at (almost) the same place, which is how some producers fake bold type or set a shadow under a title: the
 * run drawn last is kept, and of an earlier one what the later ones do not cover.
 */
export function withoutDuplicates(items: PdfContentItem[], budget: LayoutBudget): PdfContentItem[] {
  const grid = new Map<number, Placed[]>();
  const kept: (PdfContentItem | undefined)[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const placed = place(items[index]);
    const covered = placed.chars.map(() => false);
    for (const other of nearbyRuns(grid, placed)) {
      budget.tick();
      if (isNear(placed, other)) markCovered(placed, other, covered, budget);
    }
    const left = uncovered(placed, covered);
    kept[index] = left;
    if (!left) continue;
    const stands = left === placed.item ? placed : place(left);
    for (const cell of cellsOf(stands)) {
      const held = grid.get(cell);
      if (held) held.push(stands);
      else grid.set(cell, [stands]);
    }
  }
  return kept.filter((item): item is PdfContentItem => item !== undefined);
}
