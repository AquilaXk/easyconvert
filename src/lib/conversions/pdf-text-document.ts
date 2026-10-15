import { CorruptStreamError, type PdfPageAnalysis } from '../types';
import type { DocumentModel } from './document-model/model';
import { documentToText } from './document-model/text';
import type { OcrResult } from './ocr-pdf-combiner';
import { layoutPdfDocument } from './pdf-layout';
import { runPdfTextJob } from './pdf-text-geometry';
import { PdfTextUnmappedError, type PdfGeometryPages, type PdfPageContent, type PdfTextJobResult } from './pdf-text-types';

/**
 * The text and structure of a PDF read from its text layer: pdfjs `getTextContent()` per page in page-tree order
 * (in a worker thread with a deadline and memory cap, see pdf-text-host.ts), then the layout analysis in
 * pdf-layout. Fonts without a Unicode mapping are never emitted as text: a page that has such glyphs is refused with
 * PdfTextUnmappedError, or left out of the result when the caller recognizes it another way.
 */

/** `%PDF-` must appear within the first kilobyte (ISO 32000-2 section 7.5.2 allows leading bytes). */
const HEADER_SEARCH_BYTES = 1024;
const PDF_HEADER = '%PDF-';

export interface ExtractPdfOptions {
  /**
   * What to do with pages whose text has no Unicode mapping. `throw` (the default) refuses the document; `omit`
   * drops their text and lists them in `unmappedPages`, for a caller that runs OCR on them.
   */
  onUnmapped?: 'throw' | 'omit';
  /** Read the files of the images too, so the structure carries them (needed for DOCX, HTML and Markdown output). */
  images?: boolean;
}

export interface ExtractedPdfDocument {
  model: DocumentModel;
  /** The document's text in reading order. */
  text: string;
  /** Pages whose text could not be mapped to Unicode and was left out (only with `onUnmapped: 'omit'`). */
  unmappedPages: number[];
  /** The positioned content, for callers that need geometry or rules. */
  pages: PdfPageContent[];
}

/** What `readPdfDocument` asks of the single pass over the document. */
export interface ReadPdfOptions extends ExtractPdfOptions {
  /** Also analyze every page's text-layer density against this threshold. */
  densityThreshold?: number;
  /** Also read word geometry (see PdfGeometryPages). */
  geometry?: PdfGeometryPages;
}

export interface ReadPdfResult {
  extracted: ExtractedPdfDocument;
  /** Density analysis per page (when `densityThreshold` was set); pages left out as unmapped count as having no text layer. */
  analyses: PdfPageAnalysis[];
  /** Word geometry per page (when asked for), without the unmapped pages. */
  geometry: Map<number, OcrResult>;
}

export function assertPdfHeader(pdf: Buffer): void {
  if (!pdf.subarray(0, HEADER_SEARCH_BYTES).includes(PDF_HEADER)) {
    throw new CorruptStreamError('Invalid PDF document: missing %PDF- header');
  }
}

/** The document a text job read: the structure of its pages, minus pages whose fonts have no Unicode mapping. */
export function documentFromJob(job: PdfTextJobResult, options: ExtractPdfOptions = {}): ReadPdfResult {
  const unmappedPages = job.content.filter((page) => page.unmappedItems > 0).map((page) => page.pageNumber);
  if (unmappedPages.length > 0 && options.onUnmapped !== 'omit') throw new PdfTextUnmappedError(unmappedPages);
  const unmapped = new Set(unmappedPages);
  const pages = job.content.map((page) => (unmapped.has(page.pageNumber) ? { ...page, items: [], rules: [], images: [] } : page));
  const model = layoutPdfDocument(pages, job.fonts);
  const geometry = new Map([...job.geometry].filter(([pageNumber]) => !unmapped.has(pageNumber)));
  const analyses: PdfPageAnalysis[] = job.analyses.map((analysis) =>
    unmapped.has(analysis.pageNumber) ? { ...analysis, charCount: 0, wordCount: 0, hasTextLayer: false, text: '' } : analysis
  );
  return { extracted: { model, text: documentToText(model), unmappedPages, pages }, analyses, geometry };
}

/**
 * Reads a document once: its text and structure and, when asked, the per-page density analysis and word geometry that
 * the OCR decisions and hOCR/ALTO exports need, all from one pdfjs load.
 * @throws CorruptStreamError when the bytes are no PDF.
 * @throws EncryptedOfficeDocumentError (422) when the document needs a password.
 * @throws PayloadLimitError (413) when it has more than PDF_TEXT_MAX_PAGES pages.
 * @throws PdfTextGeometryError (400) when it is damaged, a page exceeds a limit or the deadline passes.
 * @throws PdfTextUnmappedError (400) when a page's fonts have no Unicode mapping (unless `onUnmapped` is `omit`).
 * @throws EngineUnavailableError (503) when the extraction thread cannot run.
 */
export async function readPdfDocument(pdf: Buffer, options: ReadPdfOptions = {}): Promise<ReadPdfResult> {
  assertPdfHeader(pdf);
  const job = await runPdfTextJob(pdf, { densityThreshold: options.densityThreshold, geometry: options.geometry ?? 'none', content: true, images: options.images });
  return documentFromJob(job, options);
}

/** The text and structure of a document; see `readPdfDocument` for the failures. */
export async function extractPdfDocument(pdf: Buffer, options: ExtractPdfOptions = {}): Promise<ExtractedPdfDocument> {
  return (await readPdfDocument(pdf, options)).extracted;
}
