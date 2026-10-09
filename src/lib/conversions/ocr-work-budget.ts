import { PayloadLimitError } from '../types';

/**
 * Wall-clock work one document may cost the OCR pipeline. A scanned page costs about the same however many pages
 * follow it (render, one to three readings), so the cost of a document grows with its page count and a long scan
 * would otherwise run until whoever waits for it gives up. The default stays under the 180 s a caller waits for a
 * conversion and well above what a 70-page scan needs (about 40 s on 12 cores).
 */
export const OCR_DOCUMENT_DEADLINE_MS = 150_000;
/** Environment variable that overrides the budget (milliseconds); tests use it to keep CI fast. */
export const OCR_DOCUMENT_DEADLINE_ENV = 'EASYCONVERT_OCR_DEADLINE_MS';

/** A document whose OCR would cost more than the budget; HTTP 413, like the other limits on the size of the work. */
export class OcrWorkLimitError extends PayloadLimitError {
  constructor(message: string) {
    super(message);
    this.name = 'OcrWorkLimitError';
  }
}

/** The budget in milliseconds: the environment override when it is a positive integer, otherwise the default. */
export function ocrDocumentDeadlineMs(): number {
  const override = Number(process.env[OCR_DOCUMENT_DEADLINE_ENV]);
  return Number.isInteger(override) && override > 0 ? override : OCR_DOCUMENT_DEADLINE_MS;
}

/**
 * The time one document's OCR has left. Pages check it before each step that costs a page's worth of work (render,
 * reading), so a document past the budget stops at the next boundary; the pages in flight finish their step.
 */
export class OcrWorkBudget {
  private readonly startedAt = performance.now();
  private readonly limitMs = ocrDocumentDeadlineMs();
  private pagesRead = 0;

  constructor(private readonly pagesTotal: number) {}

  /** Records that one more page has been read. */
  pageRead(): void {
    this.pagesRead++;
  }

  /** @throws OcrWorkLimitError (413) when the document has used up its budget. */
  assertWithinBudget(): void {
    if (performance.now() - this.startedAt <= this.limitMs) return;
    throw new OcrWorkLimitError(
      `Recognizing this document needs more than the ${this.limitMs} ms allowed for one document (${OCR_DOCUMENT_DEADLINE_ENV}); ` +
        `${this.pagesRead} of ${this.pagesTotal} pages were read. Select a page range or split the document.`
    );
  }
}
