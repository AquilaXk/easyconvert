import { hasPdfHeader } from '../format-signatures';
import { CorruptStreamError, type PdfPageAnalysis } from '../types';
import { reportConversionWarning } from './conversion-warnings';
import type { DocumentModel } from './document-model/model';
import { documentToText } from './document-model/text';
import type { OcrResult } from './ocr-pdf-combiner';
import { layoutPdf, type PdfPageText } from './pdf-layout';
import type { DetectedTable } from './pdf-layout/types';
import { runPdfTextJob } from './pdf-text-geometry';
import { PdfTextUnmappedError, pagesPhrase, visibleGlyphsOf, type PdfGeometryPages, type PdfPageContent, type PdfTextJobResult } from './pdf-text-types';

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
  /** The tables of the pages, one that goes on over several pages as one, each on the page it starts on (see `LaidOutPdf`). */
  tables: DetectedTable[];
  /** The lines of text of every page, for a reader that takes the text of a page apart from the document's flow. */
  pageText: PdfPageText[];
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

const LEFT_OUT_REASON = 'more of its glyphs have no Unicode mapping than have one.';

/**
 * Tells the conversion what the text lacks: the glyphs left out of pages that read, the pages that keep only the text their
 * fonts map, and the pages whose own text is left out, naming those that keep the text of their annotations.
 */
function reportLeftOut(
  content: readonly PdfPageContent[],
  kept: readonly PdfPageContent[],
  unreadable: ReadonlySet<number>,
  reduced: readonly number[],
  reportPages: boolean
): void {
  const partial = content.filter((page) => !unreadable.has(page.pageNumber) && page.unmappedGlyphs > 0);
  const glyphs = partial.reduce((total, page) => total + page.unmappedGlyphs, 0);
  if (glyphs > 0) {
    const pages = partial.map((page) => page.pageNumber);
    reportConversionWarning(`Left out ${glyphs} glyph${glyphs === 1 ? '' : 's'} that no font encoding maps to Unicode (${pagesPhrase(pages)}).`);
  }
  if (reduced.length > 0) reportConversionWarning(`Left out the Type 3 font text of ${pagesPhrase(reduced)} and kept the rest: ${LEFT_OUT_REASON}`);
  if (!reportPages || unreadable.size === 0) return;
  const withAnnotations = new Set(kept.filter((page) => unreadable.has(page.pageNumber) && page.items.length > 0).map((page) => page.pageNumber));
  const without = [...unreadable].filter((pageNumber) => !withAnnotations.has(pageNumber));
  if (without.length > 0) reportConversionWarning(`Left out the text of ${pagesPhrase(without)}: ${LEFT_OUT_REASON}`);
  if (withAnnotations.size > 0) {
    const their = withAnnotations.size === 1 ? 'its' : 'their';
    reportConversionWarning(`Left out the page text of ${pagesPhrase([...withAnnotations])} and kept the text of ${their} annotations: ${LEFT_OUT_REASON}`);
  }
}

/**
 * A page whose glyphs mostly have no Unicode mapping, without its own text. The text of its annotations stays unless OCR
 * reads the page: their appearances set it in fonts of their own, and Poppler prints it (`Page::displaySlice` draws every
 * annotation, poppler/Page.cc). A page handed to OCR is recognized as drawn, annotations included, so it keeps nothing.
 */
function withoutPageText(page: PdfPageContent, keepAnnotations: boolean): PdfPageContent {
  return { ...page, items: keepAnnotations ? page.items.filter((item) => item.annotation === true) : [], rules: [], images: [] };
}

/**
 * A page whose glyphs mostly have no Unicode value, kept for its text that is not set in a Type 3 font. A Type 3 font draws
 * its glyphs with programs of its own, so the lines and arrows of a figure are glyphs with no Unicode value, and its labels are
 * set in other fonts; and where such a font does show characters, they are its character codes (a bitmap font whose glyphs are
 * named `a16`), which no mapping the file holds tells from letters. The page is kept when the glyphs without a Unicode value
 * of the other fonts do not outnumber their text (the line of entry 49, without the Type 3 glyphs), and has some. Null otherwise,
 * and for a page whose fonts were not resolved.
 */
function pageWithMappedText(page: PdfPageContent): PdfPageContent | null {
  const items = page.items.filter((item) => item.annotation === true || item.type3Font !== true);
  const visible = visibleGlyphsOf(items);
  const unmappedOutsideType3 = page.unmappedGlyphs - (page.unmappedType3Glyphs ?? 0);
  return !page.operatorsSkipped && visible > 0 && unmappedOutsideType3 <= visible ? { ...page, items } : null;
}

/**
 * The document a text job read: the structure of its pages, minus the text of the pages whose glyphs mostly have no
 * Unicode mapping, except the text that is not set in a Type 3 font on a page whose other glyphs read.
 * @throws PdfTextUnmappedError when no page has text left and `onUnmapped` is not `omit`.
 */
export function documentFromJob(job: PdfTextJobResult, options: ExtractPdfOptions = {}): ReadPdfResult {
  const omit = options.onUnmapped === 'omit';
  const unmapped = new Set(job.content.filter((page) => page.unmappedGlyphs > visibleGlyphsOf(page.items)).map((page) => page.pageNumber));
  // OCR recognizes a page it is handed as drawn, so with OCR the page text is not kept whatever it holds.
  const reduced = new Map<number, PdfPageContent>();
  for (const page of job.content) {
    const mapped = unmapped.has(page.pageNumber) && !omit ? pageWithMappedText(page) : null;
    if (mapped !== null) reduced.set(page.pageNumber, mapped);
  }
  const unreadable = new Set([...unmapped].filter((pageNumber) => !reduced.has(pageNumber)));
  const unmappedPages = [...unreadable];
  const pages = job.content.map((page) => reduced.get(page.pageNumber) ?? (unreadable.has(page.pageNumber) ? withoutPageText(page, !omit) : page));
  const someTextReads = pages.some((page) => visibleGlyphsOf(page.items) > 0);
  if (unmappedPages.length > 0 && !someTextReads && !omit) throw new PdfTextUnmappedError(unmappedPages);
  const trimmed = job.content.filter((page) => reduced.has(page.pageNumber) && (reduced.get(page.pageNumber) as PdfPageContent).items.length < page.items.length);
  reportLeftOut(job.content, pages, unreadable, trimmed.map((page) => page.pageNumber), !omit);
  const { model, tables, pageText } = layoutPdf(pages, job.fonts);
  const geometry = new Map([...job.geometry].filter(([pageNumber]) => !unmapped.has(pageNumber)));
  const analyses: PdfPageAnalysis[] = job.analyses.map((analysis) =>
    unmapped.has(analysis.pageNumber) ? { ...analysis, charCount: 0, wordCount: 0, hasTextLayer: false, text: '' } : analysis
  );
  return { extracted: { model, text: documentToText(model), unmappedPages, pages, tables, pageText }, analyses, geometry };
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
