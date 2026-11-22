import type { PdfContentFont, PdfPageContent } from '../pdf-text-types';
import type { WrapMetrics } from './wrap-fit';
import type { Paragraph } from './types';

/**
 * How wide the writer sets the glyphs of a face against the face the page was set in. The writer sets all text in one of three faces,
 * so a page in a face of other widths (a condensed sans, a wide serif) wraps elsewhere and fills more or fewer lines. The reader gives
 * the width of every run, and the writer's face gives the width the same text would have, so their ratio is the share of the page's
 * glyph width. A justified line is wider than its glyphs (the spaces were stretched) and never narrower, so a low quantile of the
 * ratios of a face is its own; a face within a few percent of the writer's is left as it is.
 */

/** Runs of a face needed to read its ratio from. */
const MIN_RUNS = 8;
/** The quantile of the ratios that is taken for the face. */
const QUANTILE = 0.15;
/** A run is read when it has this many characters, since a short one is mostly the width of its spaces and punctuation. */
const MIN_CHARACTERS = 6;
/** Ratios this close to 1 are left as they are: the writer's face has the page's widths to within what a justified line stretches. */
const TOLERANCE = 0.03;
const MIN_PERCENT = 50;
const MAX_PERCENT = 200;
const PERCENT = 100;

/** The percent of its own glyph width at which each face (by name) is set, for the faces that differ from the writer's by more than the tolerance. */
export function faceWidthPercents(pages: readonly PdfPageContent[], fonts: readonly PdfContentFont[], metrics: WrapMetrics): Map<string, number> {
  const ratios = new Map<string, number[]>();
  for (const page of pages) {
    for (const item of page.items) {
      const font = item.font >= 0 ? fonts[item.font] : undefined;
      if (!font || item.angled || item.vertical || item.rtl || [...item.text.trim()].length < MIN_CHARACTERS) continue;
      const width = metrics.textWidth({ bold: font.bold, italic: font.italic, monospace: font.monospace }, item.text.trim(), item.size);
      if (width === undefined || width <= 0) continue;
      const list = ratios.get(font.name) ?? [];
      list.push(item.width / width);
      ratios.set(font.name, list);
    }
  }
  const percents = new Map<string, number>();
  for (const [name, list] of ratios) {
    if (list.length < MIN_RUNS) continue;
    list.sort((a, b) => a - b);
    const ratio = list[Math.floor((list.length - 1) * QUANTILE)];
    if (Math.abs(ratio - 1) >= TOLERANCE) percents.set(name, Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(ratio * PERCENT))));
  }
  return percents;
}

/** Sets the width percent of the runs of the paragraphs that are set in a face that has one. */
export function setFaceWidths(paragraphs: readonly Paragraph[], percents: ReadonlyMap<string, number>): void {
  if (percents.size === 0) return;
  for (const paragraph of paragraphs) {
    const percent = percents.get(paragraph.fontKey);
    if (percent !== undefined) for (const run of paragraph.runs) run.widthPercent = percent;
  }
}
