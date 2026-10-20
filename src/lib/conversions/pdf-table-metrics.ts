import type { PdfCellPart, PdfTableCell } from './pdf-blocks';
import type { PdfTextSegment, PdfUnicodeTextWriter } from './pdf-fonts';

/**
 * Column widths of the tables the in-process PDF writers draw. A table that holds a table, and a table inside one, takes
 * its column widths from its content, as CSS 2.1 section 17.5.2.2 describes for automatic table layout: every column has
 * a minimum width (its widest word) and a maximum width (its longest line), and the width the table is given is shared
 * between them. Other tables have equal columns.
 */

/** Table text size and the space around a cell's content, in points. */
export const TABLE_FONT_SIZE = 10;
export const TABLE_CELL_PADDING = 4;
export const MIN_TABLE_COLUMN_WIDTH = 24;
/** CSS pixel to PDF point (96 px per inch, 72 pt per inch). */
export const PX_TO_PT = 0.75;
/** A word wider than this is broken inside, so it asks no more of its column. */
const MAX_WORD_WIDTH = 96;
const WHITESPACE_RUN = /\s+/;

/**
 * The widths a table asks for, in points, cell padding included. The least is what its content cannot be narrower than
 * (every column at MIN_TABLE_COLUMN_WIDTH, and each table inside it at its own least); the minimum is the widest word of
 * every column; the maximum is the longest line of every column.
 */
export interface TableMeasure {
  readonly least: number;
  readonly min: number;
  readonly max: number;
  readonly columnLeasts: readonly number[];
  readonly columnMins: readonly number[];
  readonly columnMaxs: readonly number[];
}

/** What the measuring needs: the writer that sets the text, and the measures already made of the tables of this document. */
export interface MeasureContext {
  readonly writer: PdfUnicodeTextWriter;
  readonly measured: WeakMap<readonly (readonly PdfTableCell[])[], TableMeasure>;
}

interface ContentWidth {
  readonly least: number;
  readonly min: number;
  readonly max: number;
}

function textWidth(context: MeasureContext, content: readonly PdfTextSegment[], words: Map<string, number>): ContentWidth {
  const text = content.map((segment) => segment.text).join('');
  if (text.trim().length === 0) return { least: 0, min: 0, max: 0 };
  const max = Math.ceil(context.writer.measure(content).width);
  let widest = 0;
  for (const word of text.split(WHITESPACE_RUN)) {
    if (word.length === 0) continue;
    let width = words.get(word);
    if (width === undefined) {
      width = Math.ceil(context.writer.measure(word).width);
      words.set(word, width);
    }
    widest = Math.max(widest, width);
  }
  return { least: 0, min: Math.min(widest, MAX_WORD_WIDTH, max), max };
}

function partWidth(context: MeasureContext, part: PdfCellPart, words: Map<string, number>): ContentWidth {
  switch (part.kind) {
    case 'text':
      return textWidth(context, part.content, words);
    case 'image':
      // A picture is scaled down to its column, so it asks for no minimum.
      return { least: 0, min: 0, max: Math.ceil(part.image.widthPx * PX_TO_PT) };
    case 'table': {
      const table = measureTable(context, part.rows);
      return { least: table.least, min: table.min, max: table.max };
    }
  }
}

/** The width a cell's content asks for, without padding. */
function cellWidth(context: MeasureContext, cell: PdfTableCell, words: Map<string, number>): ContentWidth {
  if (cell.covered) return { least: 0, min: 0, max: 0 };
  const parts: readonly PdfCellPart[] = cell.parts ?? [{ kind: 'text', content: cell.content }];
  return parts.reduce<ContentWidth>(
    (widest, part) => {
      const width = partWidth(context, part, words);
      return { least: Math.max(widest.least, width.least), min: Math.max(widest.min, width.min), max: Math.max(widest.max, width.max) };
    },
    { least: 0, min: 0, max: 0 }
  );
}

/** Shares `needed` over the columns `from` to `to`, in proportion to their weights, raising the ones that fall short. */
function raiseColumns(widths: number[], span: { from: number; to: number }, needed: number, weights: readonly number[]): void {
  let have = 0;
  let weight = 0;
  for (let column = span.from; column < span.to; column++) {
    have += widths[column];
    weight += weights[column];
  }
  if (needed <= have) return;
  for (let column = span.from; column < span.to; column++) {
    widths[column] += (needed - have) * (weights[column] / weight);
  }
}

/** The column widths a table asks for, once per table. Cells that span columns widen the columns they cover. */
export function measureTable(context: MeasureContext, rows: readonly (readonly PdfTableCell[])[]): TableMeasure {
  const known = context.measured.get(rows);
  if (known) return known;
  const count = rows.reduce((widest, row) => Math.max(widest, row.reduce((sum, cell) => sum + cell.span, 0)), 0);
  const floor = (): number[] => new Array<number>(count).fill(MIN_TABLE_COLUMN_WIDTH);
  const leasts = floor();
  const mins = floor();
  const maxs = floor();
  const words = new Map<string, number>();
  const spanning: Array<{ from: number; to: number; least: number; min: number; max: number }> = [];
  for (const row of rows) {
    let column = 0;
    for (const cell of row) {
      const from = column;
      column += cell.span;
      const width = cellWidth(context, cell, words);
      const padded = { least: width.least + 2 * TABLE_CELL_PADDING, min: width.min + 2 * TABLE_CELL_PADDING, max: width.max + 2 * TABLE_CELL_PADDING };
      if (cell.span === 1) {
        leasts[from] = Math.max(leasts[from], padded.least);
        mins[from] = Math.max(mins[from], padded.min);
        maxs[from] = Math.max(maxs[from], padded.max);
      } else {
        spanning.push({ from, to: Math.min(column, count), ...padded });
      }
    }
  }
  for (const cell of spanning) {
    raiseColumns(leasts, cell, cell.least, leasts);
    raiseColumns(mins, cell, cell.min, mins);
    raiseColumns(maxs, cell, cell.max, maxs);
  }
  mins.forEach((min, column) => {
    mins[column] = Math.max(min, leasts[column]);
  });
  maxs.forEach((max, column) => {
    maxs[column] = Math.max(max, mins[column]);
  });
  const total = (widths: readonly number[]): number => widths.reduce((sum, width) => sum + width, 0);
  const measure: TableMeasure = {
    least: total(leasts),
    min: total(mins),
    max: total(maxs),
    columnLeasts: leasts,
    columnMins: mins,
    columnMaxs: maxs,
  };
  context.measured.set(rows, measure);
  return measure;
}

/**
 * The column widths of a table in `width` points (CSS 2.1, 17.5.2.2): the maximums when they fit, grown in proportion to fill
 * the width; otherwise the minimums plus a share of what is left, in proportion to how much more each column wants; and when
 * not even the minimums fit, the least widths plus a share of what is left. `width` is at least `measure.least`.
 */
export function automaticColumnWidths(measure: TableMeasure, width: number): number[] {
  const { columnLeasts: leasts, columnMins: mins, columnMaxs: maxs } = measure;
  if (width >= measure.max) return maxs.map((max) => max + ((width - measure.max) * max) / measure.max);
  if (width >= measure.min) return mins.map((min, column) => min + ((maxs[column] - min) * (width - measure.min)) / (measure.max - measure.min));
  return leasts.map((least, column) => least + ((mins[column] - least) * (width - measure.least)) / (measure.min - measure.least));
}
