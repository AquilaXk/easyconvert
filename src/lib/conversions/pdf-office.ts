import { ConversionFailedError, type ConversionOptions } from '../types';
import type { DocumentModel } from './document-model/model';
import { plainTextModel } from './document-model/plain';
import { evaluatePageOcrDecisions, recognizeRenderedPdfPages } from './ocr';
import type { OcrResult } from './ocr-pdf-combiner';
import { readPdfDocument } from './pdf-text-document';
import { PdfTextGeometryError } from './pdf-text-types';

/**
 * The content of a PDF for the Office, e-book and slide writers: the structure of its text layer, with the pages that
 * have no text layer (scans, fonts without a Unicode mapping) recognized by OCR as the pages are displayed.
 */

const DEFAULT_DENSITY_THRESHOLD = 15;

function ocrTextOf(results: Map<number, OcrResult>): string {
  return [...results]
    .sort(([a], [b]) => a - b)
    .map(([, result]) => result.text)
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

/**
 * @param withImages carry the images of the pages in the result (a writer that places them needs this).
 * @throws PdfTextUnmappedError when a page's fonts have no Unicode mapping and OCR is off.
 * @throws ConversionFailedError when the document has no text and OCR finds none.
 * @throws OcrEngineUnavailableError when a page needs OCR and no engine can render it.
 */
export async function readPdfForOffice(inputBuffer: Buffer, options: ConversionOptions, withImages = false): Promise<DocumentModel> {
  const densityThreshold = options.ocrDensityThreshold || DEFAULT_DENSITY_THRESHOLD;
  let read: Awaited<ReturnType<typeof readPdfDocument>> | null = null;
  try {
    read = await readPdfDocument(inputBuffer, { densityThreshold, onUnmapped: options.ocrEnabled ? 'omit' : 'throw', images: withImages });
  } catch (err) {
    // A document pdfjs cannot read is recognized as displayed when OCR was asked for; otherwise it is refused.
    if (!(options.ocrEnabled && err instanceof PdfTextGeometryError)) throw err;
  }
  const extracted = read?.extracted ?? null;
  const hasText = (extracted?.text.trim() ?? '') !== '';
  const analyses = read?.analyses ?? [];
  const { pagesNeedingOcr } = evaluatePageOcrDecisions(analyses, options.ocrMode || 'skip_text');
  const needsOcr = !hasText || (options.ocrEnabled === true && (pagesNeedingOcr.length > 0 || analyses.length === 0));
  if (!needsOcr && extracted) return extracted.model;

  const recognized = await recognizeRenderedPdfPages(inputBuffer, pagesNeedingOcr.length > 0 ? new Set(pagesNeedingOcr) : undefined, {
    dpi: options.dpi,
    language: options.ocrLanguage,
    detectOrientation: options.ocrDetectOrientation,
  });
  const recognizedText = ocrTextOf(recognized);
  if (recognizedText === '') {
    if (extracted && hasText) return extracted.model;
    throw new ConversionFailedError('PDF has no text layer and OCR recognised no text on any page.');
  }
  // Pages read by OCR and pages with their own text are joined in page order as paragraphs.
  const parts: string[] = [];
  if (analyses.length > 0) {
    for (const analysis of analyses) {
      const ocr = recognized.get(analysis.pageNumber);
      if (ocr) parts.push(ocr.text);
      else if (analysis.text) parts.push(analysis.text);
    }
  } else {
    parts.push(recognizedText);
  }
  return plainTextModel(parts.join('\n\n'));
}
