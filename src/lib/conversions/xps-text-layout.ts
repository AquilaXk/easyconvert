import { PayloadLimitError } from '../types';
import { loadFontCoverageIndex, toDrawableText } from './pdf-fonts';
import { TextMeter, wrapText, type PlacedRun } from './text-wrap';

/**
 * Text layout for XPS pages (ECMA-388): lines wrap at the page margins by the advance widths of the fonts
 * that draw them, and text that does not fit one page continues on as many further pages as it needs.
 */

/** A4 in XPS units (1/96 inch). */
export const XPS_PAGE_WIDTH = 793.76;
export const XPS_PAGE_HEIGHT = 1122.56;
export const XPS_PAGE_MARGIN = 48;
export const XPS_FONT_SIZE = 10.5;
/** Most pages one package may hold before it is refused with HTTP 413. */
export const XPS_MAX_PAGES = 10_000;

/** Distance between baselines, in page units. */
const LINE_HEIGHT = 20;
const CONTENT_WIDTH = XPS_PAGE_WIDTH - 2 * XPS_PAGE_MARGIN;
const FIRST_BASELINE = XPS_PAGE_MARGIN + XPS_FONT_SIZE;
const LAST_BASELINE = XPS_PAGE_HEIGHT - XPS_PAGE_MARGIN;

export type XpsTextRun = PlacedRun;

export interface XpsTextLine {
  /** Baseline of the line in page units. */
  y: number;
  runs: XpsTextRun[];
}

/**
 * Lays the paragraphs out over as many pages as they need. A blank paragraph leaves a blank line. Throws
 * a PayloadLimitError (413) above XPS_MAX_PAGES pages and an EngineUnavailableError when no installed font
 * covers a character.
 */
export async function layoutXpsParagraphs(paragraphs: readonly string[]): Promise<XpsTextLine[][]> {
  await loadFontCoverageIndex();
  const meter = new TextMeter();
  const pages: XpsTextLine[][] = [[]];
  let y = FIRST_BASELINE;
  for (const paragraph of paragraphs) {
    const drawable = toDrawableText(paragraph);
    for (const sourceLine of drawable.split('\n')) {
      const wrapped = sourceLine.trim() === '' ? [''] : wrapText(sourceLine, meter, CONTENT_WIDTH, XPS_FONT_SIZE);
      for (const text of wrapped) {
        if (y > LAST_BASELINE) {
          if (pages.length >= XPS_MAX_PAGES) {
            throw new PayloadLimitError(`The text needs more than ${XPS_MAX_PAGES} XPS pages.`);
          }
          pages.push([]);
          y = FIRST_BASELINE;
        }
        if (text !== '') pages[pages.length - 1].push({ y, runs: meter.place(text, XPS_PAGE_MARGIN, XPS_FONT_SIZE) });
        y += LINE_HEIGHT;
      }
    }
  }
  return pages;
}
