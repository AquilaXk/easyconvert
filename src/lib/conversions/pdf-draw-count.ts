import { forEachContentToken } from './pdf-content-tokens';
import { PdfStructureError } from './pdf-values';

/**
 * Draws one page may make, counted as pdf.js executes them: each `Do` that leads to an image or form XObject and each inline
 * image, a form's own draws again on every invocation. Real Distiller documents with dense 1-bit `/ImageMask` stipple
 * hatching reach 103,258 draws on a single page (`gd-754270.pdf`, p. 24) and 115,886 draws on a single page (`gd-297219.pdf`,
 * p. 42), so per Policy #205/#442 the per-page cap keeps ~2.2x headroom above those measurements while still stopping runaway
 * million-draw pages before `pdf.js` builds unbounded operator arrays.
 */
export const MAX_PDF_DRAWS_PER_PAGE = 250_000;
/**
 * Draws all pages of one document may make together, counted as `MAX_PDF_DRAWS_PER_PAGE` counts them; `gd-754270.pdf` makes
 * 1,005,782 draws across 45 pages, so the document cap keeps ~2.5x headroom above that measurement.
 */
export const MAX_PDF_DRAWS = 2_500_000;

/** The draws of one page, added to those of its document. */
export class PageDraws {
  count = 0;

  constructor(private readonly document: DrawLedger) {}

  /**
   * Adds `draws` to the page's count and the document's, and refuses the file past either limit. The count is checked as it grows,
   * so a content stream that draws a million times is stopped at the limit and not read to its end.
   * @throws PdfStructureError past MAX_PDF_DRAWS_PER_PAGE or MAX_PDF_DRAWS.
   */
  add(draws: number): void {
    this.count += draws;
    this.document.total += draws;
    if (this.count > MAX_PDF_DRAWS_PER_PAGE) throw new PdfStructureError(`PDF page draws more than ${MAX_PDF_DRAWS_PER_PAGE} images and forms.`);
    if (this.document.total > MAX_PDF_DRAWS) throw new PdfStructureError(`PDF draws more than ${MAX_PDF_DRAWS} images and forms.`);
  }
}

/** The draws of the pages of one document, in page order, made in one read of its content streams. */
export class DrawLedger {
  total = 0;
  private readonly pages: PageDraws[] = [];

  startPage(): PageDraws {
    const page = new PageDraws(this);
    this.pages.push(page);
    return page;
  }

  perPage(): readonly number[] {
    return this.pages.map((page) => page.count);
  }
}

/** Inline images in a content stream: the `ID` operators outside strings, names, comments and image data (section 8.9.7). */
export function inlineImageCount(content: string): number {
  if (!content.includes('BI')) return 0;
  let count = 0;
  forEachContentToken(content, (token) => {
    if (token === 'ID') count++;
  });
  return count;
}
