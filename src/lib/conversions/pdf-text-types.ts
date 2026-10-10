import { ConversionFailedError, CorruptStreamError, DecompressionLimitError, EncryptedOfficeDocumentError, PayloadLimitError, type PdfPageAnalysis } from '../types';
import { PdfStructureError } from './pdf-document';
import type { OcrResult } from './ocr-pdf-combiner';

/** Items a page may have before it is refused as hostile; real pages have a few thousand at most. */
export const PDF_TEXT_MAX_ITEMS_PER_PAGE = 100_000;
/** Words a page may have; one item can hold many words, so this bounds the output separately. */
export const PDF_TEXT_MAX_WORDS_PER_PAGE = 200_000;
/** Longest text item, in UTF-16 units; checked before any per-character array is allocated. */
export const PDF_TEXT_MAX_ITEM_CHARS = 1_048_576;
/** Text a page may hold in all its items, in UTF-16 units; checked before any glyph or per-character data is built. */
export const PDF_TEXT_MAX_CHARS_PER_PAGE = 2_097_152;
/**
 * Pages with more text items than this are laid out without reading the operator list (equal shares
 * per character). The operator list cannot be sized before it is read, so graphics-heavy pages are
 * bounded by the wall-clock deadline instead.
 */
export const PDF_TEXT_OPERATOR_LIST_MAX_ITEMS = 20_000;
/** Wall-clock limit for one extraction job in its worker thread. */
export const PDF_TEXT_DEADLINE_MS = 60_000;
/** Environment variable that overrides the deadline (milliseconds); tests use it to keep CI fast. */
export const PDF_TEXT_DEADLINE_ENV = 'EASYCONVERT_PDF_TEXT_DEADLINE_MS';

/** Pixels of an image pdfjs decodes; larger images are skipped by the reader instead of being decoded. */
export const PDF_TEXT_MAX_IMAGE_PIXELS = 50_000_000;
/** Pages a document may have for its text content to be read; a larger document is refused with 413. */
export const PDF_TEXT_MAX_PAGES = 2_000;
/** Text items a whole document may have; with the per-page cap alone, a few thousand pages could still hold hundreds of millions. */
export const PDF_TEXT_MAX_ITEMS_PER_DOCUMENT = 500_000;
/** Text a whole document may hold, in UTF-16 units. */
export const PDF_TEXT_MAX_CHARS_PER_DOCUMENT = 16_777_216;
/** Graphics operators one page may have before the page's rules and images are no longer collected. */
export const PDF_CONTENT_MAX_OPERATORS_PER_PAGE = 2_000_000;
/** Ruling lines one page may contribute; more are dropped (the page is flagged), as they only serve table detection. */
export const PDF_CONTENT_MAX_RULES_PER_PAGE = 20_000;
/** Image placements one page may report. */
export const PDF_CONTENT_MAX_IMAGES_PER_PAGE = 256;
/** Bytes of image files a document may return; more is refused with a 413. */
export const PDF_CONTENT_MAX_IMAGE_BYTES = 128 * 1024 * 1024;
/** Decoded content stream bytes of one page read to line up its images with their PDF streams. */
export const PDF_CONTENT_MAX_PAGE_STREAM_BYTES = 64 * 1024 * 1024;
/** Distinct fonts a document may report; the item table is bounded by the item caps, this bounds the font table. */
export const PDF_CONTENT_MAX_FONTS = 4_096;
/** Nesting depth of the save/restore stack followed while reading the operator list. */
export const PDF_CONTENT_MAX_STATE_DEPTH = 256;

export class PdfTextGeometryError extends ConversionFailedError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PdfTextGeometryError';
  }
}

/**
 * A page's text has glyphs the font gives no Unicode value for (replacement characters or control codes), so
 * reading it would hand out garbage. The request can enable OCR to read such pages instead (HTTP 400).
 */
export class PdfTextUnmappedError extends ConversionFailedError {
  readonly status = 400;
  readonly pages: readonly number[];
  constructor(pages: readonly number[]) {
    const shown = pages.slice(0, 10).join(', ');
    super(
      `PDF page${pages.length === 1 ? '' : 's'} ${shown}${pages.length > 10 ? ', ...' : ''} use a font with no Unicode mapping, so the text cannot be read; enable OCR to recognize ${pages.length === 1 ? 'it' : 'them'}.`
    );
    this.name = 'PdfTextUnmappedError';
    this.pages = pages;
  }
}

/** Why a worker-thread job failed, so the host can rebuild the typed error across the thread boundary. */
export type PdfTextFailureKind = 'encrypted' | 'limit' | 'decompression' | 'structure' | 'corrupt-stream' | 'invalid';

export function pdfTextFailure(kind: PdfTextFailureKind | undefined, message: string): ConversionFailedError {
  switch (kind) {
    case 'encrypted':
      return new EncryptedOfficeDocumentError(message);
    case 'limit':
      return new PayloadLimitError(message);
    case 'decompression':
      return new DecompressionLimitError(message);
    case 'structure':
      return new PdfStructureError(message);
    case 'corrupt-stream':
      return new CorruptStreamError(message);
    default:
      return new PdfTextGeometryError(message);
  }
}

/** The kind to report for a typed error; the order matters because DecompressionLimitError is a PayloadLimitError. */
export function pdfTextFailureKindOf(error: unknown): PdfTextFailureKind {
  if (error instanceof EncryptedOfficeDocumentError) return 'encrypted';
  if (error instanceof DecompressionLimitError) return 'decompression';
  if (error instanceof PayloadLimitError) return 'limit';
  if (error instanceof PdfStructureError) return 'structure';
  if (error instanceof CorruptStreamError) return 'corrupt-stream';
  return 'invalid';
}

/** Which pages get word geometry: the listed ones, every page that has text, or none. */
export type PdfGeometryPages = readonly number[] | 'text-pages' | 'none';

export interface PdfTextJob {
  /** When set, every page is analyzed for text-layer density and the analyses are returned. */
  densityThreshold?: number;
  geometry: PdfGeometryPages;
  /** When set, the positioned text, rules and images of every page (or the listed pages) are returned. */
  content?: boolean | readonly number[];
  /** With `content`: also return the pixels of the images (the PDF's own JPEG data, or a PNG of the decoded pixels). */
  images?: boolean;
}

/** One font of a document, as the layout needs it. */
export interface PdfContentFont {
  /** BaseFont without its subset tag, for example `NotoSans-Bold`. */
  name: string;
  bold: boolean;
  italic: boolean;
  monospace: boolean;
  serif: boolean;
}

/**
 * A run of shown text in the page as displayed: points, origin at the top left, y growing downwards (the page
 * viewport, so /Rotate is applied). `x` is the left end of the run and `baseline` its baseline.
 */
export interface PdfContentItem {
  text: string;
  x: number;
  baseline: number;
  width: number;
  /** Em size in points. */
  size: number;
  /** Index into the document's font table, or -1 when the font is unknown. */
  font: number;
  /** The run contains right-to-left letters, so its text is already in logical order. */
  rtl: boolean;
  /** Baseline runs steeper than a small tolerance; such runs are not part of any line. */
  angled: boolean;
  /** Text of a vertical writing mode font. */
  vertical: boolean;
}

/** An axis-aligned ruling line (a stroked segment or a thin filled rectangle), in page-viewport points. */
export interface PdfContentRule {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  thickness: number;
}

/** A placed image: its box in the page viewport and what is needed to find its pixels. */
export interface PdfContentImage {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pixel size of the image. */
  pixelWidth: number;
  pixelHeight: number;
  /** The image file: `jpeg` is the PDF's own JPEG stream byte for byte, `png` a PNG of the pixels pdfjs decoded. */
  data?: Uint8Array;
  format?: 'jpeg' | 'png';
}

export interface PdfPageContent {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfContentItem[];
  rules: PdfContentRule[];
  images: PdfContentImage[];
  /** Items whose text holds replacement characters or control codes (glyphs no Unicode value was found for). */
  unmappedItems: number;
  /** The operator list was not read (too many items or operators): no rules, images or font names for the page. */
  operatorsSkipped: boolean;
  /** Rules beyond the per-page cap were dropped. */
  rulesTruncated: boolean;
}

export interface PdfTextJobResult {
  analyses: PdfPageAnalysis[];
  geometry: Map<number, OcrResult>;
  /** Positioned content of the requested pages, in page order. */
  content: PdfPageContent[];
  /** The document's fonts; items refer to them by index. */
  fonts: PdfContentFont[];
}
