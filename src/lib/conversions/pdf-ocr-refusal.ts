import { OcrEngineUnavailableError, OcrLanguageUnavailableError, PayloadLimitError } from '../types';
import { PdfPageFrameError } from './pdf-page-geometry';
import { PdfPageRenderError } from './pdf-page-render';
import { pagesPhrase } from './pdf-text-types';

/**
 * Whether a failed OCR that the request did not ask for leaves the text layer as the answer, and the warning line that says so.
 *
 * Recognizing pages is a recovery then, not the job: a conversion that reads the text layer of a PDF must not fail because
 * the pages that have none cannot be rendered or read within the engine's limits. Three kinds of failure are such a refusal:
 * no engine to render with (`OcrEngineUnavailableError`, but not an unknown language, which the request got wrong), a limit
 * (`PayloadLimitError`: the page budget, the work budget of `OcrWorkBudget`, the memory or output a render may use) and a
 * render that ran out of time. A page that cannot be drawn at all (a page tree that cannot be walked, a malformed page) is
 * kept as the text layer only while other pages have text: a document that has none would answer empty, so it is refused as
 * damaged. Everything else, the job's own deadline or cancellation among it, is not a refusal and propagates.
 *
 * The pixel limit (`InputPixelLimitError`) is not asked about here: it refuses the input whether or not OCR was asked for.
 *
 * @param pages the pages OCR was to read, empty when it was to read the whole document.
 * @param textLayerEmpty whether the text layer read as no text at all.
 * @returns the warning line for the conversion, or undefined when the failure must stay a failure.
 */
export function skippedOcrWarning(err: unknown, pages: readonly number[], textLayerEmpty: boolean): string | undefined {
  const isLimit = err instanceof PayloadLimitError;
  const isEngineGone = err instanceof OcrEngineUnavailableError && !(err instanceof OcrLanguageUnavailableError);
  const isSlowRender = err instanceof PdfPageRenderError && err.reason === 'timeout';
  const isDamage = err instanceof PdfPageFrameError || (err instanceof PdfPageRenderError && err.reason === 'malformed');
  if (!(isLimit || isEngineGone || isSlowRender || (isDamage && !textLayerEmpty))) return undefined;
  const where = pages.length > 0 ? pagesPhrase(pages) : 'the document';
  const detail = (err as Error).message.replace(/\s+/g, ' ').trim();
  return `Did not recognize ${where} with OCR, which the request did not ask for, and kept the text layer as it reads: ${detail}`;
}
