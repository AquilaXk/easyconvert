import type { PdfContentFont, PdfContentItem } from '../pdf-text-types';

/** A box in page points, origin top left, y growing downwards. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A stretch of text with one style. */
export interface StyledRun {
  text: string;
  bold: boolean;
  italic: boolean;
  monospace: boolean;
}

/** One line of text, or one cell-wide piece of a row, in logical (reading) order. */
export interface LayoutLine {
  runs: StyledRun[];
  text: string;
  box: Box;
  baseline: number;
  /** Em size in points of most of the characters. */
  size: number;
  bold: boolean;
  italic: boolean;
  monospace: boolean;
  /** Base direction is right to left. */
  rtl: boolean;
  /** Name of the font most characters use, for detecting a change of font. */
  fontKey: string;
  /** The line runs top to bottom (vertical writing). Its box is then in a transposed frame; `pageBox` is the page box. */
  vertical: boolean;
  pageBox?: Box;
}

/** A cell of a detected table. `continuation` marks a slot covered by the cell above it (a merged row). */
export interface TableCell {
  /** Paragraphs of the cell, top to bottom. */
  paragraphs: Paragraph[];
  colSpan: number;
  rowSpan: number;
  continuation: boolean;
  /** Every line of the cell is bold, so the cell reads as a header. */
  header: boolean;
}

export interface DetectedTable {
  rows: TableCell[][];
  /** Width of each grid column in points. */
  columnWidths: number[];
  box: Box;
  pageNumber: number;
  kind: 'lattice' | 'stream';
}

/** Everything on one baseline (several lines when the page has columns), left to right. */
export interface Row {
  segments: LayoutLine[];
  baseline: number;
  top: number;
  bottom: number;
  /** A table laid out as a row of its own: its single segment is the table's box. */
  table?: DetectedTable;
  /** The runs the row was made of, for a finer split into cells. */
  items?: PdfContentItem[];
}

/** Fonts of a document by index, as the extractor reports them. */
export type FontList = readonly PdfContentFont[];

/** Lines read as one paragraph: their text joined (with hyphenated words rejoined) and the style they share. */
export interface Paragraph {
  runs: StyledRun[];
  text: string;
  lines: LayoutLine[];
  box: Box;
  size: number;
  bold: boolean;
  italic: boolean;
  monospace: boolean;
  rtl: boolean;
  fontKey: string;
  /** Left edge of the first line and of the others, in points. */
  firstLineX: number;
  leftX: number;
  /** The column or page flow the paragraph came from; paragraphs of one flow share a number. */
  flow: number;
  pageNumber: number;
  /** The paragraph crosses the columns of its page (a title, a caption): it is not part of a column. */
  full: boolean;
}

export function lineWidth(line: LayoutLine): number {
  return line.box.x1 - line.box.x0;
}

export function boxesOverlapHorizontally(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1;
}
