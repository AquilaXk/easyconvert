/**
 * Which files the converter reads by OCR. A PDF is read by OCR when it has no text at all (document.ts: `isScanned`),
 * and then every page without a text layer is recognized; this asks the converter's own text-density pass and page
 * decision for it instead of guessing from the file, so the harness and the converter cannot disagree.
 */
import { evaluatePageOcrDecisions, inspectPdfPagesTextDensity } from '../../src/lib/conversions/ocr';

/** The density threshold document.ts uses when the request gives none. */
const DEFAULT_DENSITY_THRESHOLD = 15;

/** Pages the converter would recognize in `pdf` with default options; 0 when the PDF has text or cannot be read. */
export async function ocrPageCount(pdf: Buffer): Promise<number> {
  try {
    const analyses = await inspectPdfPagesTextDensity(pdf, DEFAULT_DENSITY_THRESHOLD);
    if (analyses.some((page) => page.text.trim() !== '')) return 0;
    return evaluatePageOcrDecisions(analyses, 'skip_text').pagesNeedingOcr.length;
  } catch {
    return 0;
  }
}
