import { OcrPreprocessError } from '../types';

/**
 * Splits a single-column text page into horizontal bands at blank rows so that the bands can be
 * recognized side by side by separate engine workers.
 *
 * One engine reads a page line after line, so its time grows with the number of lines. Cutting the
 * page between two lines changes nothing for either half: the recognizer reads every line from its
 * own pixels. What a cut can change is the page layout analysis, which orders blocks and columns, so
 * a page is only cut when it has no gap between columns anywhere (a column gutter, a table, a list
 * with a bullet column) and when the cut falls in a clearly blank run of rows, never through a
 * line. Pages that do not qualify are read whole, exactly as before.
 */

/** Gray levels below this count as ink. */
export const OCR_BAND_INK_LEVEL = 128;
/** Most bands one page is cut into. */
export const OCR_BAND_MAX_BANDS = 4;
/** A band holds at least this many text lines; fewer lines do not repay the cost of an extra engine run. */
export const OCR_BAND_MIN_LINES = 3;
/** A run of blank rows is a gap between lines when it is at least this share of the text line height. */
export const OCR_BAND_MIN_GAP_LINE_FRACTION = 0.3;
/** An ink run shorter than this share of the text line height is a speck or a dot, not a line. */
export const OCR_BAND_MIN_LINE_FRACTION = 0.4;
/** A blank run of columns at least this share of the text line height wide is a gutter between columns. */
export const OCR_BAND_GUTTER_LINE_FRACTION = 1;
/** A gap after which the next line starts a new paragraph is this many times the median gap. */
export const OCR_BAND_PARAGRAPH_GAP_FACTOR = 1.5;
/** A row or column with at most this share of its length dark is blank: a stray speck does not make a line. */
export const OCR_BAND_SPECK_FRACTION = 0.001;

export interface OcrInkProfile {
  width: number;
  height: number;
  /** Dark pixels in every row. */
  rows: Uint32Array;
  /** Dark pixels in every column. */
  columns: Uint32Array;
}

/** One band of a page: rows `top` up to but not including `bottom`. */
export interface OcrBand {
  top: number;
  bottom: number;
  /** Whether the text continues into the next band as a new paragraph (the cut falls in a paragraph-sized gap). */
  paragraphBreakAfter: boolean;
}

/** Counts the dark pixels of every row and every column of an 8-bit gray page. */
export function measureInk(gray: Uint8Array, width: number, height: number): OcrInkProfile {
  if (gray.length !== width * height) {
    throw new OcrPreprocessError(`Expected ${width * height} gray samples for a ${width}x${height} page, got ${gray.length}.`);
  }
  const rows = new Uint32Array(height);
  const columns = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (gray[base + x] < OCR_BAND_INK_LEVEL) {
        count++;
        columns[x]++;
      }
    }
    rows[y] = count;
  }
  return { width, height, rows, columns };
}

interface Run {
  start: number;
  /** One past the last index. */
  end: number;
}

/** Maximal runs of indices where `occupied(i)` holds, with `occupied` false past either end. */
function runsOf(length: number, occupied: (index: number) => boolean): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let i = 0; i <= length; i++) {
    const inside = i < length && occupied(i);
    if (inside && start < 0) start = i;
    if (!inside && start >= 0) {
      runs.push({ start, end: i });
      start = -1;
    }
  }
  return runs;
}

/**
 * Ink runs that are text lines: rows holding ink, with runs separated by fewer than `minGap` blank
 * rows joined (the dot of an i is not a gap between lines), and joined runs shorter than
 * `minLine` dropped.
 */
function textLines(profile: OcrInkProfile, minGap: number, minLine: number): Run[] {
  const speck = Math.floor(profile.width * OCR_BAND_SPECK_FRACTION);
  const inked = runsOf(profile.height, (y) => profile.rows[y] > speck);
  const joined: Run[] = [];
  for (const run of inked) {
    const last = joined[joined.length - 1];
    if (last && run.start - last.end < minGap) last.end = run.end;
    else joined.push({ ...run });
  }
  return joined.filter((run) => run.end - run.start >= minLine);
}

/** Whether a blank run of columns wide enough to be a gutter lies between inked columns. */
function hasColumnGutter(profile: OcrInkProfile, minWidth: number): boolean {
  const speck = Math.floor(profile.height * OCR_BAND_SPECK_FRACTION);
  const inked = runsOf(profile.width, (x) => profile.columns[x] > speck);
  for (let i = 1; i < inked.length; i++) {
    if (inked[i].start - inked[i - 1].end >= minWidth) return true;
  }
  return false;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Cuts a page into up to `maxBands` bands of about the same number of text lines, each cut in the
 * middle of the gap between two lines. Returns null when the page should be read whole: it is too
 * short for two bands of OCR_BAND_MIN_LINES lines, its text line height is unknown, or it has a gap
 * between columns.
 */
export function planBands(profile: OcrInkProfile, lineHeightPx: number | null, maxBands: number): OcrBand[] | null {
  if (lineHeightPx === null || lineHeightPx <= 0 || maxBands < 2) return null;
  const minGap = Math.max(2, Math.round(lineHeightPx * OCR_BAND_MIN_GAP_LINE_FRACTION));
  const minLine = Math.max(2, Math.round(lineHeightPx * OCR_BAND_MIN_LINE_FRACTION));
  const lines = textLines(profile, minGap, minLine);
  const bandCount = Math.min(maxBands, OCR_BAND_MAX_BANDS, Math.floor(lines.length / OCR_BAND_MIN_LINES));
  if (bandCount < 2) return null;
  if (hasColumnGutter(profile, Math.max(2, Math.round(lineHeightPx * OCR_BAND_GUTTER_LINE_FRACTION)))) return null;

  const gaps = lines.slice(1).map((line, i) => line.start - lines[i].end);
  const paragraphGap = median(gaps) * OCR_BAND_PARAGRAPH_GAP_FACTOR;
  const bands: OcrBand[] = [];
  let top = 0;
  for (let k = 1; k < bandCount; k++) {
    const firstLineBelow = Math.round((k * lines.length) / bandCount);
    const gap = gaps[firstLineBelow - 1];
    const cut = Math.floor((lines[firstLineBelow - 1].end + lines[firstLineBelow].start) / 2);
    bands.push({ top, bottom: cut, paragraphBreakAfter: gap > paragraphGap });
    top = cut;
  }
  bands.push({ top, bottom: profile.height, paragraphBreakAfter: false });
  return bands;
}

/** Headers of the Netpbm pages this project writes: gray `P5\n<width> <height>\n255\n`, bitonal `P4\n<width> <height>\n`. */
const GRAY_HEADER = /^P5\n(\d+) (\d+)\n255\n/;
const BITONAL_HEADER = /^P4\n(\d+) (\d+)\n/;
const BITS_PER_BYTE = 8;

/**
 * Rows `top` to `bottom` of a Netpbm page written by encodePgm or encodePbm, as a Netpbm page of
 * their own. Rows are stored one after another with no padding between them (P4 pads each row to
 * whole bytes), so a band is a contiguous slice behind a new header.
 */
export function sliceNetpbmRows(page: Buffer, top: number, bottom: number): Buffer {
  const head = page.subarray(0, 40).toString('latin1');
  const gray = GRAY_HEADER.exec(head);
  const bitonal = gray ? null : BITONAL_HEADER.exec(head);
  const match = gray ?? bitonal;
  if (!match) throw new OcrPreprocessError('The prepared page is not a gray or bitonal Netpbm image.');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(top >= 0 && top < bottom && bottom <= height)) {
    throw new OcrPreprocessError(`Rows ${top}-${bottom} are not inside a page of ${height} rows.`);
  }
  const rowBytes = gray ? width : Math.ceil(width / BITS_PER_BYTE);
  const header = Buffer.from(gray ? `P5\n${width} ${bottom - top}\n255\n` : `P4\n${width} ${bottom - top}\n`, 'ascii');
  const samples = page.subarray(match[0].length + top * rowBytes, match[0].length + bottom * rowBytes);
  return Buffer.concat([header, samples]);
}

/** What the engine returned for one band: its plain text and its block tree (see parseTesseractBlocks). */
export interface BandReading {
  text: string;
  blocks: unknown[] | null | undefined;
}

interface VerticalBox {
  y0: number;
  y1: number;
}

function isVerticalBox(value: unknown): value is VerticalBox {
  return typeof value === 'object' && value !== null && typeof (value as VerticalBox).y0 === 'number' && typeof (value as VerticalBox).y1 === 'number';
}

/** Moves every box of a block tree down by `dy` pixels, in place: blocks, paragraphs, lines, words and symbols. */
function shiftTree(node: unknown, dy: number): void {
  if (Array.isArray(node)) {
    for (const child of node) shiftTree(child, dy);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if ((key === 'bbox' || key === 'baseline') && isVerticalBox(value)) {
      value.y0 += dy;
      value.y1 += dy;
    } else if (Array.isArray(value)) {
      shiftTree(value, dy);
    }
  }
}

/**
 * Joins the readings of the bands of one page into the reading of the page: the block trees in band order with
 * every box moved to its place on the page, and the texts joined by a line break, or a blank line where the cut
 * fell in a gap between paragraphs.
 */
export function mergeBandReadings(bands: readonly OcrBand[], readings: readonly BandReading[]): BandReading {
  if (bands.length !== readings.length) {
    throw new OcrPreprocessError(`${readings.length} readings for ${bands.length} bands.`);
  }
  let text = '';
  const blocks: unknown[] = [];
  readings.forEach((reading, index) => {
    const band = bands[index];
    const bandText = reading.text.trim();
    if (index > 0 && bandText && text) text += bands[index - 1].paragraphBreakAfter ? '\n\n' : '\n';
    text += bandText;
    if (reading.blocks) {
      shiftTree(reading.blocks, band.top);
      blocks.push(...reading.blocks);
    }
  });
  return { text, blocks };
}
