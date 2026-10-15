import type { PdfContentItem } from '../pdf-text-types';
import type { FontList, LayoutLine } from './types';
import { isHangul, isUnspacedScript } from './text-chars';
import { LayoutBudget } from './limits';

/**
 * Vertical writing (tategaki): lines run top to bottom and follow each other from right to left. Producers draw it in
 * two ways, and both are read here:
 *  - a vertical-mode font (pdfjs reports its runs with a top-to-bottom direction), one run per line of text;
 *  - one glyph per run, drawn upright in a column (what office suites emit): a chain of single East Asian glyphs with
 *    the same x and a steady step of about one em is a vertical line.
 * The lines come back in a transposed frame, so the horizontal paragraph code reads them unchanged: the position along the
 * line stands in for x and the negated column position for the baseline. `pageBox` holds the box on the page.
 */

/** A glyph run belongs to a column when its centre is within this many em of the column's. */
const COLUMN_TOLERANCE_EM = 0.3;
/** Steps between glyphs of a column, in em. */
const MIN_STEP_EM = 0.7;
const MAX_STEP_EM = 1.6;
/** Glyphs a column needs before it is read as vertical text rather than a stack of unrelated characters. */
const MIN_GLYPHS = 3;
const ASCENT_EM = 0.8;
const DESCENT_EM = 0.2;

function isEastAsianGlyph(text: string): boolean {
  const chars = Array.from(text);
  return chars.length === 1 && (isUnspacedScript(chars[0]) || isHangul(chars[0]));
}

function lineOf(text: string, items: PdfContentItem[], fonts: FontList): LayoutLine {
  const size = items.reduce((sum, item) => sum + item.size, 0) / items.length;
  const centre = items.reduce((sum, item) => sum + item.x + (item.vertical ? 0 : item.width / 2), 0) / items.length;
  const top = Math.min(...items.map((item) => item.baseline)) - ASCENT_EM * size;
  const last = items.reduce((best, item) => (item.baseline > best.baseline ? item : best), items[0]);
  const bottom = last.baseline + (last.vertical ? last.width : 0) + DESCENT_EM * size;
  const font = items[0].font >= 0 ? fonts[items[0].font] : undefined;
  return {
    runs: [{ text, bold: font?.bold ?? false, italic: font?.italic ?? false, monospace: false }],
    text,
    // Transposed frame: x is the position along the line, the baseline is the negated column position.
    box: { x0: top, x1: bottom, y0: -centre - size / 2, y1: -centre + size / 2 },
    pageBox: { x0: centre - size / 2, x1: centre + size / 2, y0: top, y1: bottom },
    baseline: -centre,
    size,
    bold: font?.bold ?? false,
    italic: font?.italic ?? false,
    monospace: false,
    rtl: false,
    fontKey: font?.name ?? '',
    vertical: true,
  };
}

export interface VerticalSplit {
  /** Vertical lines, ordered right to left. */
  lines: LayoutLine[];
  /** Runs that are not part of vertical text. */
  rest: PdfContentItem[];
}

/** Separates the vertical text from the other runs of a page. */
export function extractVerticalLines(items: PdfContentItem[], fonts: FontList, budget: LayoutBudget): VerticalSplit {
  const lines: LayoutLine[] = [];
  const claimed = new Set<PdfContentItem>();
  for (const item of items) {
    if (item.vertical && item.text.trim() !== '') {
      lines.push(lineOf(item.text, [item], fonts));
      claimed.add(item);
    }
  }
  const glyphs = items.filter((item) => !claimed.has(item) && !item.angled && isEastAsianGlyph(item.text) && item.size > 0);
  glyphs.sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2) || a.baseline - b.baseline);
  let at = 0;
  while (at < glyphs.length) {
    const first = glyphs[at];
    const centre = first.x + first.width / 2;
    let end = at + 1;
    while (end < glyphs.length && Math.abs(glyphs[end].x + glyphs[end].width / 2 - centre) <= COLUMN_TOLERANCE_EM * first.size) end++;
    budget.tick(end - at);
    const column = glyphs.slice(at, end).sort((a, b) => a.baseline - b.baseline);
    let chain: PdfContentItem[] = [column[0]];
    const flush = (): void => {
      if (chain.length >= MIN_GLYPHS) {
        lines.push(lineOf(chain.map((item) => item.text).join(''), chain, fonts));
        for (const item of chain) claimed.add(item);
      }
    };
    for (let i = 1; i < column.length; i++) {
      const step = column[i].baseline - column[i - 1].baseline;
      if (step >= MIN_STEP_EM * column[i].size && step <= MAX_STEP_EM * column[i].size) {
        chain.push(column[i]);
      } else {
        flush();
        chain = [column[i]];
      }
    }
    flush();
    at = end;
  }
  // A column of glyphs that is bigger than the glyph columns beside it is split into one line per column of the page.
  return { lines: lines.sort((a, b) => b.pageBox!.x0 - a.pageBox!.x0 || a.pageBox!.y0 - b.pageBox!.y0), rest: items.filter((item) => !claimed.has(item)) };
}
