import { type OcrResult, injectInvisibleTextLayer, injectRenderedPageTextLayer } from './ocr-pdf-combiner';
import { normaliseLeafPageCatalog } from './pdf-page-geometry';
import { loadPdfLibDocument } from './pdf-lib-load';

/**
 * Generates an authentic Lossless Sandwich PDF directly from an existing PDF document.
 * Preserves 100% of the original PDF's metadata, objects, vector artwork, annotations,
 * and compression streams while non-destructively injecting transparent text layers.
 * It lives apart from `ocr-pdf-combiner.ts`, which the browser OCR bundle reaches and which therefore cannot import the
 * Node-only check that `loadPdfLibDocument` runs before pdf-lib reads the file.
 * @throws DecompressionLimitError (413) and the other errors of `assertPdfLibParseWithinLimits`.
 */
export async function createLosslessSandwichPdfFromPdf(
  originalPdfBuffer: Buffer,
  pageOcrResults: Map<number, OcrResult>
): Promise<Buffer> {
  const doc = await loadPdfLibDocument(originalPdfBuffer);
  normaliseLeafPageCatalog(doc);
  const numPages = doc.getPageCount();
  for (let i = 0; i < numPages; i++) {
    const pageNum = i + 1;
    const ocrResult = pageOcrResults.get(pageNum);
    if (!ocrResult) continue;

    const page = doc.getPage(i);
    if (ocrResult.pageRender) {
      injectRenderedPageTextLayer(page, ocrResult, ocrResult.pageRender);
      continue;
    }
    const { width: pageWidth, height: pageHeight } = page.getSize();

    const imgWidth = ocrResult.imageWidth || pageWidth;
    const imgHeight = ocrResult.imageHeight || pageHeight;

    const scaleX = pageWidth / imgWidth;
    const scaleY = pageHeight / imgHeight;

    injectInvisibleTextLayer(page, ocrResult, scaleX, scaleY);
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}
