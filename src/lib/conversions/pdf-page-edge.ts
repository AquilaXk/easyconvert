import type { OcrBBox } from './ocr-pdf-combiner';
import { runPdfTextJob } from './pdf-text-geometry';

/**
 * Words that a PDF draws past the edge of their page, read from the PDF itself: pdf.js gives every word the box its glyph
 * advances make, in the page as displayed (the viewport: /Rotate applied, the CropBox inside the MediaBox), the same box
 * Poppler's `pdftotext -bbox` reports. A print engine never leaves a word off the page, so a word whose box ends past an
 * edge is a page that was laid out wrong (docs/policy-decisions.md entry 90).
 */

/**
 * How far a word's box may reach past an edge before the word counts as past it, in points. It only absorbs the rounding of the
 * numbers in the PDF (the office suite writes coordinates to 0.001 pt, so a sum of a few of them is off by a few thousandths):
 * ten times that. It is not an allowance for the side bearings of the first and last letters. pdf.js leaves out every glyph whose
 * origin is past the edge, so a box that ends only a little past it is a word that was cut: on the 450 govdocs pages the office
 * suite draws, the words that end 0.2 to 0.4 pt past the right edge are `Environmen` (of `Environment`), `Confere` and `abatement`, and a
 * tolerance of 0.5 pt would have left those three pages as they were (Poppler's `pdftotext -bbox` counts them too).
 */
export const PAGE_EDGE_TOLERANCE_PT = 0.01;

export interface WordsPastPageEdge {
  /** Words whose box reaches past an edge of their page by more than the tolerance. */
  words: number;
  /** Pages (from 1) that hold such words. */
  pages: number[];
}

/**
 * Counts the words of the PDF whose box is past an edge of its page.
 * @param deadlineMs the wall-clock limit of the read, which cannot be longer than the PDF text host's (a longer read of a
 *   page with many glyphs is stopped, and so is the thread, as for every PDF text job).
 * @throws PdfTextGeometryError when the PDF cannot be read in that time or within the limits of the PDF text reader (items, characters, words and glyph matching per page).
 */
export async function wordsPastPageEdge(pdf: Buffer, deadlineMs: number): Promise<WordsPastPageEdge> {
  const { geometry } = await runPdfTextJob(pdf, { geometry: 'text-pages', deadlineMs });
  let words = 0;
  const pages: number[] = [];
  // The map holds the pages in page order.
  for (const [pageNumber, page] of geometry) {
    const { imageWidth, imageHeight } = page;
    if (imageWidth === undefined || imageHeight === undefined) continue;
    let onPage = 0;
    for (const block of page.lineBlocks ?? []) {
      for (const { bbox } of block.words) {
        if (isPastEdge(bbox, imageWidth, imageHeight)) onPage++;
      }
    }
    if (onPage > 0) {
      words += onPage;
      pages.push(pageNumber);
    }
  }
  return { words, pages };
}

function isPastEdge(box: Pick<OcrBBox, 'x' | 'y' | 'width' | 'height'>, pageWidth: number, pageHeight: number): boolean {
  return (
    box.x < -PAGE_EDGE_TOLERANCE_PT ||
    box.y < -PAGE_EDGE_TOLERANCE_PT ||
    box.x + box.width > pageWidth + PAGE_EDGE_TOLERANCE_PT ||
    box.y + box.height > pageHeight + PAGE_EDGE_TOLERANCE_PT
  );
}
