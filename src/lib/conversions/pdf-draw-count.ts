import { forEachContentToken } from './pdf-content-tokens';
import { PdfStructureError } from './pdf-values';

/**
 * Draws one page may make, counted as pdf.js executes them: each `Do` that leads to an image or form XObject and each inline
 * image, a form's own draws again on every invocation. The page that draws most of the 1,310 PDFs of the real-world corpus and
 * the test fixtures (1,244 as they are, 66 encrypted ones after qpdf decrypts them) draws 31,854 times (a map of small
 * pictures), and the cap is three times that. pdf.js builds an operator for each draw (a 12 KB file whose page draws one picture
 * a million times gives it 1,001,002 operators) and the page reader walks every one, so the size of the file does not show the
 * work.
 */
export const MAX_PDF_DRAWS_PER_PAGE = 100_000;
/** Draws all pages of one document may make together, counted as `MAX_PDF_DRAWS_PER_PAGE` counts them; the most any of those documents makes is 123,697 (20 pages). */
export const MAX_PDF_DRAWS = 500_000;

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
