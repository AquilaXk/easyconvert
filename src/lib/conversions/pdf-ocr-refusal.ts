import { OcrEngineUnavailableError, OcrLanguageUnavailableError, PayloadLimitError } from '../types';
import { PdfPageFrameError } from './pdf-page-geometry';
import { PdfPageRenderError, PdfPageRenderLimitError } from './pdf-page-render';
import { pagesPhrase } from './pdf-text-types';

/**
 * Whether a failed OCR that the request did not ask for leaves the text layer as the answer, and the warning line that says so.
 *
 * Recognizing pages is a recovery then, not the job: a conversion that reads the text layer of a PDF must not fail because
 * a page that has none cannot be rendered. Failures of one page's render are such a refusal: the memory or output it may use
 * (`PdfPageRenderLimitError`), the time it may take, and no engine to render with (`OcrEngineUnavailableError`, but not an
 * unknown language, which the request got wrong). The size of the work is not: the pages one request renders and the work budget
 * of the document (any other `PayloadLimitError`, `OcrWorkLimitError` among them) say "select a page range", and a document
 * with no text would otherwise answer an empty file; they are kept as the text layer only while other pages have text. A page
 * that cannot be drawn at all (a page tree that cannot be walked, a malformed page) is kept the same way: a document that has
 * no text would answer empty, so it is refused as damaged. Everything else, the job's own deadline or cancellation among it,
 * is not a refusal and propagates.
 *
 * The pixel limit (`InputPixelLimitError`) is not asked about here: it refuses the input whether or not OCR was asked for.
 *
 * @param pages the pages OCR was to read, empty when it was to read the whole document.
 * @param textLayerEmpty whether the text layer read as no text at all.
 * @returns the warning line for the conversion, or undefined when the failure must stay a failure.
 */
export function skippedOcrWarning(err: unknown, pages: readonly number[], textLayerEmpty: boolean): string | undefined {
  const isRenderFault = err instanceof PdfPageRenderLimitError || (err instanceof PdfPageRenderError && err.reason === 'timeout');
  const isEngineGone = err instanceof OcrEngineUnavailableError && !(err instanceof OcrLanguageUnavailableError);
  const isWorkSize = err instanceof PayloadLimitError && !(err instanceof PdfPageRenderLimitError);
  const isDamage = err instanceof PdfPageFrameError || (err instanceof PdfPageRenderError && err.reason === 'malformed');
  if (!(isRenderFault || isEngineGone || ((isWorkSize || isDamage) && !textLayerEmpty))) return undefined;
  const where = pages.length > 0 ? pagesPhrase(pages) : 'the document';
  const detail = (err as Error).message.replace(/\s+/g, ' ').trim();
  return `Did not recognize ${where} with OCR, which the request did not ask for, and kept the text layer as it reads: ${detail}`;
}
