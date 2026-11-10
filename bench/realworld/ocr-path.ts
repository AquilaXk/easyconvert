/**
 * Which files the converter reads by OCR. A PDF is read by OCR when it has no text at all (document.ts: `isScanned`),
 * and then every page without a text layer is recognized; this asks the converter's own text-density pass and page
 * decision for it instead of guessing from the file, so the harness and the converter cannot disagree.
 */
import { evaluatePageOcrDecisions, inspectPdfPagesTextDensity } from '../../src/lib/conversions/ocr';

/** The density threshold document.ts uses when the request gives none. */
const DEFAULT_DENSITY_THRESHOLD = 15;
const ALWAYS_OCR_TARGETS: ReadonlySet<string> = new Set(['hocr', 'alto']);

export interface PdfOcrPageCounts {
  /** Pages recognized for ordinary targets (0 when any page has text). */
  scannedPages: number;
  /** Pages recognized for hOCR and ALTO targets (every page below the text density threshold). */
  markupPages: number;
}

export async function ocrPageCounts(pdf: Buffer): Promise<PdfOcrPageCounts> {
  try {
    const analyses = await inspectPdfPagesTextDensity(pdf, DEFAULT_DENSITY_THRESHOLD);
    const markupPages = evaluatePageOcrDecisions(analyses, 'skip_text').pagesNeedingOcr.length;
    const scannedPages = analyses.some((page) => page.text.trim() !== '') ? 0 : markupPages;
    return { scannedPages, markupPages };
  } catch {
    return { scannedPages: 0, markupPages: 0 };
  }
}

/** Pages the converter would recognize in `pdf` with default options; 0 when the PDF has text (unless `target` is hOCR or ALTO) or cannot be read. */
export async function ocrPageCount(pdf: Buffer, target?: string): Promise<number> {
  const counts = await ocrPageCounts(pdf);
  return target !== undefined && ALWAYS_OCR_TARGETS.has(target) ? counts.markupPages : counts.scannedPages;
}
