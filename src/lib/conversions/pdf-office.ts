import { ConversionFailedError, type ConversionOptions } from '../types';
import { documentToEpub } from './document-model/epub';
import type { DocumentModel } from './document-model/model';
import { plainTextModel } from './document-model/plain';
import { evaluatePageOcrDecisions, recognizeRenderedPdfPages } from './ocr';
import type { OcrResult } from './ocr-pdf-combiner';
import { openPdfForReading } from './pdf-access';
import { readPdfDocument, type ExtractedPdfDocument } from './pdf-text-document';
import { PdfTextGeometryError } from './pdf-text-types';

/**
 * The content of a PDF for the Office, e-book and slide writers: the structure of its text layer, with the pages that
 * have no text layer (scans, fonts without a Unicode mapping) recognized by OCR as the pages are displayed.
 */

const DEFAULT_DENSITY_THRESHOLD = 15;

/** The pages OCR read as text by page number; a page it read as empty is not one. */
function readPagesOf(results: Map<number, OcrResult>): Map<number, string> {
  return new Map(
    [...results]
      .filter(([, result]) => result.text.trim() !== '')
      .sort(([a], [b]) => a - b)
      .map(([pageNumber, result]): [number, string] => [pageNumber, result.text])
  );
}

/**
 * What a PDF holds for a writer: the structure of its text layer, or the text of its pages when OCR read some. A document read by OCR
 * keeps the structure of the pages that have a text layer (`extracted`, null when pdfjs could not read it) and says which pages OCR read.
 */
export type PdfOfficeContent =
  | { kind: 'layout'; extracted: ExtractedPdfDocument }
  | { kind: 'text'; pages: { pageNumber: number; text: string }[]; extracted: ExtractedPdfDocument | null; recognizedPages: ReadonlySet<number> };

/**
 * @param withImages carry the images of the pages in the result (a writer that places them needs this).
 * @throws PdfTextUnmappedError when no page of the document reads for want of a Unicode mapping and OCR is off.
 * @throws PdfPasswordRequiredError when the document needs an open password that the request lacks or got wrong.
 * @throws ConversionFailedError when the document has no text and OCR finds none.
 * @throws OcrEngineUnavailableError when a page needs OCR and no engine can render it.
 */
export async function readPdfContentForOffice(source: Buffer, options: ConversionOptions, withImages = false): Promise<PdfOfficeContent> {
  // An encrypted document is read from a copy qpdf decrypted with the request's password, the empty one when there is none.
  const inputBuffer = await openPdfForReading(source, options.password, options.signal);
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
  if (!needsOcr && extracted) return { kind: 'layout', extracted };

  const recognized = await recognizeRenderedPdfPages(inputBuffer, pagesNeedingOcr.length > 0 ? new Set(pagesNeedingOcr) : undefined, {
    dpi: options.dpi,
    language: options.ocrLanguage,
    detectOrientation: options.ocrDetectOrientation,
  });
  // A page OCR read as empty is not a recognized page: it keeps its own text layer, and so its tables.
  const readByOcr = readPagesOf(recognized);
  if (readByOcr.size === 0) {
    if (extracted && hasText) return { kind: 'layout', extracted };
    throw new ConversionFailedError('PDF has no text layer and OCR recognised no text on any page.');
  }
  // Pages read by OCR and pages with their own text are joined in page order as paragraphs.
  const pages: { pageNumber: number; text: string }[] = [];
  if (analyses.length > 0) {
    for (const analysis of analyses) {
      const ocrText = readByOcr.get(analysis.pageNumber);
      if (ocrText !== undefined) pages.push({ pageNumber: analysis.pageNumber, text: ocrText });
      else if (analysis.text) pages.push({ pageNumber: analysis.pageNumber, text: analysis.text });
    }
  } else {
    for (const [pageNumber, text] of readByOcr) pages.push({ pageNumber, text });
  }
  return { kind: 'text', pages, extracted, recognizedPages: new Set(readByOcr.keys()) };
}

/** The document model of a PDF for the Office, e-book and slide writers; see `readPdfContentForOffice` for the failures. */
export async function readPdfForOffice(source: Buffer, options: ConversionOptions, withImages = false): Promise<DocumentModel> {
  const content = await readPdfContentForOffice(source, options, withImages);
  return content.kind === 'layout' ? content.extracted.model : plainTextModel(content.pages.map((page) => page.text).join('\n\n'));
}

/**
 * An EPUB from a PDF, written from the block model its reader built, as it is for a DOCX: the text never passes through Markdown,
 * whose rules read a row of numbers as nested lists and whose limits are those of a user's document.
 */
export async function pdfToEpub(source: Buffer, options: ConversionOptions, title: string): Promise<Buffer> {
  return documentToEpub(await readPdfForOffice(source, options), { title, language: options.language });
}
