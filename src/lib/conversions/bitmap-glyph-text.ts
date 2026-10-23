import { UnsupportedOptionError } from '../types';
import type { PdfPageContent } from './pdf-text-types';
import type { BitmapGlyphMark } from './svg-bitmap-glyph';

/**
 * The characters of a bitmap font, written again as text in a stock font: what pstoedit 4.02 does by default for a TeX bitmap
 * font (doc/pstoedit.tex, RESTRICTIONS: a non-standard font is mapped to a default font whose size makes each text fragment as
 * wide as in the original font). The glyph pictures come from the SVG Poppler draws (svg-bitmap-glyph.ts sets them aside with
 * their origin on the baseline); the characters come from the PDF's text layer, one run of shown text per item.
 *
 * A glyph belongs to the run on its baseline whose advance holds the glyph origin: Poppler and the PDF reader place a glyph at
 * the same point. Each run that holds glyphs is written once, from its left end on the baseline over its advance width. A glyph
 * that no run holds, or only a run of white space, has no character in the text layer (the reader found no Unicode value for
 * it): it is written as `#` over its picture, the mark pstoedit writes for a character it cannot map, never left out. When such
 * glyphs outnumber the glyphs that have text, the page is refused, the rule the PDF text reader applies to a page whose glyphs
 * mostly have no Unicode value (PdfTextUnmappedError, pdf-text-types.ts).
 *
 * Its height is the cap height, which is what a DXF reader takes the height of a TEXT to be (ezdxf addons/drawing/text.py,
 * `_get_cap_height` returns `dxf.height`; ezdxf fonts/ttfonts.py measures the cap height as the top of `A`). A Type 3 font
 * carries no metrics (Ghostscript writes FontBBox [0 0 1 -1] for these fonts), so the cap height is measured on the pictures:
 * the median top of the capital letters of the font on the page, which a font subset often lacks `A` for and where `A`
 * overshoots the flat capitals. A font without a capital letter on the page takes the top of the tallest glyph of each run.
 */

/**
 * What stands for a character that has no text or that the target cannot hold: pstoedit writes `#` for a character it cannot
 * map (doc/pstoedit.tex, RESTRICTIONS). The text layer keeps a glyph without a Unicode value in its place as this mark.
 */
export const UNMAPPABLE_CHARACTER = '#';

/** The text layer of one page as the PDF reader gives it: the page size in points and the runs of shown text. */
export type PdfPageText = Pick<PdfPageContent, 'width' | 'height' | 'items'>;

/** A run of text to write, in device space (y down): its left end on the baseline, its advance width and its height. */
export interface PlacedText {
  text: string;
  x: number;
  baseline: number;
  width: number;
  height: number;
}

/**
 * How far, in points, a glyph origin may lie from a run's baseline and advance and still belong to it. Poppler's SVG prints
 * positions with six decimals and the PDF reader computes them in doubles; on the twelve real files they differ by 0.0012 pt
 * at most.
 */
const ORIGIN_TOLERANCE_PT = 0.01;
/** The page sizes of the SVG and of the text layer give one scale for both axes, to within this ratio. */
const SCALE_TOLERANCE = 1e-6;
const CAPITAL_LETTER = /^[A-Z]$/;
/** A run's font when the reader could not tell it (its font table is full): such runs share no cap height. */
const UNKNOWN_FONT = -1;

const NO_TEXT = 'the PDF text layer has no text for most of its bitmap-font characters (drawn as pictures).';
const NOT_HORIZONTAL = 'bitmap-font text that is not horizontal is not supported.';

interface Run {
  item: PdfPageContent['items'][number];
  x: number;
  baseline: number;
  glyphs: BitmapGlyphMark[];
}

/** One baseline of runs, sorted by their left end. */
interface Row {
  baseline: number;
  runs: Run[];
}

function rowsOf(runs: Run[], tolerance: number): Row[] {
  const sorted = [...runs].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const rows: Row[] = [];
  for (const run of sorted) {
    const row = rows.at(-1);
    if (row && run.baseline - row.baseline <= tolerance) row.runs.push(run);
    else rows.push({ baseline: run.baseline, runs: [run] });
  }
  for (const row of rows) row.runs.sort((a, b) => a.x - b.x);
  return rows;
}

/** The last index whose value is at most `limit` (-1 when none), in an array sorted ascending by `value`. */
function lastAtMost<T>(sorted: readonly T[], value: (entry: T) => number, limit: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (value(sorted[middle]) <= limit) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** The run that holds the glyph: on a row within tolerance of its origin, the last run starting at or before it, if it reaches it. */
function runOf(glyph: BitmapGlyphMark, rows: readonly Row[], tolerance: number, scale: number): Run | undefined {
  for (let index = lastAtMost(rows, (row) => row.baseline, glyph.y + tolerance); index >= 0; index--) {
    const row = rows[index];
    if (glyph.y - row.baseline > tolerance) break;
    const run = row.runs[lastAtMost(row.runs, (candidate) => candidate.x, glyph.x + tolerance)];
    if (run && Math.abs(run.baseline - glyph.y) <= tolerance && glyph.x < run.x + run.item.width * scale - tolerance) return run;
  }
  return undefined;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >>> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Per font, the median top above the baseline of its capital letters' pictures, read where a run has one glyph per character. */
function capHeights(runs: readonly Run[]): Map<number, number> {
  const tops = new Map<number, Map<number, number>>();
  for (const run of runs) {
    const characters = [...run.item.text].filter((character) => character.trim() !== '');
    if (run.item.font === UNKNOWN_FONT || characters.length !== run.glyphs.length) continue;
    const glyphs = [...run.glyphs].sort((a, b) => a.x - b.x);
    characters.forEach((character, index) => {
      if (!CAPITAL_LETTER.test(character)) return;
      const font = tops.get(run.item.font) ?? new Map<number, number>();
      font.set(glyphs[index].glyph, glyphs[index].y - glyphs[index].top);
      tops.set(run.item.font, font);
    });
  }
  return new Map([...tops].map(([font, glyphs]) => [font, median([...glyphs.values()])]));
}

/** The tallest of the glyphs above their baseline; glyphs drawn wholly below it (an underscore) take their pictures' height. */
function tallest(glyphs: readonly BitmapGlyphMark[]): number {
  const above = glyphs.reduce((height, glyph) => Math.max(height, glyph.y - glyph.top), Number.NEGATIVE_INFINITY);
  return above > 0 ? above : glyphs.reduce((height, glyph) => Math.max(height, glyph.bottom - glyph.top), 0);
}

/** The mark written for a glyph without text, fitted over its picture on its baseline. */
function unmappedMark(glyph: BitmapGlyphMark): PlacedText {
  return { text: UNMAPPABLE_CHARACTER, x: glyph.left, baseline: glyph.y, width: glyph.right - glyph.left, height: tallest([glyph]) };
}

/**
 * The text that replaces the page's bitmap glyphs: the runs of the text layer that hold them, in the text layer's order, then
 * a mark for each glyph without text; in device units (the SVG's `deviceWidth` x `deviceHeight` for the text layer's page size).
 * @throws UnsupportedOptionError when glyphs without text outnumber the others, a run that holds glyphs is not horizontal, or
 * the page sizes do not agree.
 */
export function placeBitmapGlyphText(glyphs: readonly BitmapGlyphMark[], page: PdfPageText, deviceWidth: number, deviceHeight: number): PlacedText[] {
  const scale = deviceWidth / page.width;
  if (!(scale > 0) || Math.abs(deviceHeight / page.height / scale - 1) > SCALE_TOLERANCE) {
    throw new UnsupportedOptionError('the PDF text layer and the drawn page do not have the same page size.');
  }
  const tolerance = ORIGIN_TOLERANCE_PT * scale;
  const runs: Run[] = page.items.map((item) => ({ item, x: item.x * scale, baseline: item.baseline * scale, glyphs: [] }));
  const rows = rowsOf(runs, tolerance);
  const unmapped: BitmapGlyphMark[] = [];
  for (const glyph of glyphs) {
    const run = runOf(glyph, rows, tolerance, scale);
    if (run) run.glyphs.push(glyph);
    else unmapped.push(glyph);
  }
  const written: Run[] = [];
  for (const run of runs.filter((candidate) => candidate.glyphs.length > 0)) {
    if (run.item.angled || run.item.vertical) throw new UnsupportedOptionError(NOT_HORIZONTAL);
    if (run.item.text.trim() !== '') written.push(run);
    else for (const glyph of run.glyphs) unmapped.push(glyph);
  }
  if (unmapped.length > glyphs.length - unmapped.length) throw new UnsupportedOptionError(NO_TEXT);
  const caps = capHeights(written);
  const texts = written.map((run) => ({
    text: run.item.text,
    x: run.x,
    baseline: run.baseline,
    width: run.item.width * scale,
    height: caps.get(run.item.font) ?? tallest(run.glyphs),
  }));
  return [...texts, ...unmapped.map(unmappedMark)];
}
