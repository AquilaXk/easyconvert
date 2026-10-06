import { ConversionFailedError, type PdfPageAnalysis } from '../types';
import type { OcrResult } from './ocr-pdf-combiner';

/** Items a page may have before it is refused as hostile; real pages have a few thousand at most. */
export const PDF_TEXT_MAX_ITEMS_PER_PAGE = 100_000;
/** Words a page may have; one item can hold many words, so this bounds the output separately. */
export const PDF_TEXT_MAX_WORDS_PER_PAGE = 200_000;
/** Longest text item, in UTF-16 units; checked before any per-character array is allocated. */
export const PDF_TEXT_MAX_ITEM_CHARS = 1_048_576;
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

export class PdfTextGeometryError extends ConversionFailedError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PdfTextGeometryError';
  }
}

/** Which pages get word geometry: the listed ones, every page that has text, or none. */
export type PdfGeometryPages = readonly number[] | 'text-pages' | 'none';

export interface PdfTextJob {
  /** When set, every page is analyzed for text-layer density and the analyses are returned. */
  densityThreshold?: number;
  geometry: PdfGeometryPages;
}

export interface PdfTextJobResult {
  analyses: PdfPageAnalysis[];
  geometry: Map<number, OcrResult>;
}
