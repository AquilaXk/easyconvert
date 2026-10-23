import { hasPdfHeader } from '../format-signatures';
import { CorruptStreamError, type PdfPageAnalysis } from '../types';
import { reportConversionWarning } from './conversion-warnings';
import type { DocumentModel } from './document-model/model';
import { documentToText } from './document-model/text';
import type { OcrResult } from './ocr-pdf-combiner';
import { layoutPdfDocument } from './pdf-layout';
import { runPdfTextJob } from './pdf-text-geometry';
import { PdfTextUnmappedError, pagesPhrase, type PdfGeometryPages, type PdfPageContent, type PdfTextJobResult } from './pdf-text-types';

/**
 * The text and structure of a PDF read from its text layer: pdfjs `getTextContent()` per page in page-tree order
 * (in a worker thread with a deadline and memory cap, see pdf-text-host.ts), then the layout analysis in
 * pdf-layout. A glyph that no ToUnicode map, font encoding or symbol table gives text for is never emitted as text: it is
 * left out, and the result reports how many (see pdf-glyph-recovery.ts). A page where such glyphs outnumber the ones that
 * map is left out as a whole; the document is refused with PdfTextUnmappedError only when no page of it reads, or leaves
 * those pages to the caller when it recognizes them another way.
 */

export interface ExtractPdfOptions {
  /**
   * What to do when no page of the document reads because the glyphs without a Unicode mapping outnumber the others.
   * `throw` (the default) refuses the document; `omit` drops the text of those pages and lists them in `unmappedPages`,
   * for a caller that runs OCR on them. With `throw`, a document with other pages that read keeps them and reports
   * the pages it left out.
   */
  onUnmapped?: 'throw' | 'omit';
  /** Read the files of the images too, so the structure carries them (needed for DOCX, HTML and Markdown output). */
  images?: boolean;
}

export interface ExtractedPdfDocument {
  model: DocumentModel;
  /** The document's text in reading order. */
  text: string;
  /** Pages whose text could not be mapped to Unicode and was left out. */
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
  if (!hasPdfHeader(pdf)) {
    throw new CorruptStreamError('Invalid PDF document: missing %PDF- header');
  }
}

const WHITE_SPACE = /\s/u;

/** Characters of the page's text that are not white space. */
function visibleGlyphsOf(page: PdfPageContent): number {
  let glyphs = 0;
  for (const item of page.items) for (const character of item.text) if (!WHITE_SPACE.test(character)) glyphs++;
  return glyphs;
}

/** Tells the conversion what the text lacks: the glyphs left out of pages that read, and the pages left out as a whole. */
function reportLeftOut(content: readonly PdfPageContent[], unreadable: ReadonlySet<number>, reportPages: boolean): void {
  const partial = content.filter((page) => !unreadable.has(page.pageNumber) && page.unmappedGlyphs > 0);
  const glyphs = partial.reduce((total, page) => total + page.unmappedGlyphs, 0);
  if (glyphs > 0) {
    const pages = partial.map((page) => page.pageNumber);
    reportConversionWarning(`Left out ${glyphs} glyph${glyphs === 1 ? '' : 's'} that no font encoding maps to Unicode (${pagesPhrase(pages)}).`);
  }
  if (reportPages && unreadable.size > 0) {
    reportConversionWarning(`Left out the text of ${pagesPhrase([...unreadable])}: more of its glyphs have no Unicode mapping than have one.`);
  }
}

/**
 * The document a text job read: the structure of its pages, minus the pages whose glyphs mostly have no Unicode mapping.
 * @throws PdfTextUnmappedError when no page reads and `onUnmapped` is not `omit`.
 */
export function documentFromJob(job: PdfTextJobResult, options: ExtractPdfOptions = {}): ReadPdfResult {
  const omit = options.onUnmapped === 'omit';
  const unmapped = new Set(job.content.filter((page) => page.unmappedGlyphs > visibleGlyphsOf(page)).map((page) => page.pageNumber));
  const unmappedPages = [...unmapped];
  const someTextReads = job.content.some((page) => !unmapped.has(page.pageNumber) && visibleGlyphsOf(page) > 0);
  if (unmappedPages.length > 0 && !someTextReads && !omit) throw new PdfTextUnmappedError(unmappedPages);
  reportLeftOut(job.content, unmapped, !omit);
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
 * @throws PdfTextUnmappedError (400) when no page of the document reads for want of a Unicode mapping (unless `onUnmapped` is `omit`).
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
