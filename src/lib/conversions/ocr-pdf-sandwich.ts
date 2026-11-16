import { type OcrResult, injectInvisibleTextLayer, injectRenderedPageTextLayer } from './ocr-pdf-combiner';
import { stripPageInvisibleOcrText } from './ocr-strip-invisible-text';
import { normaliseLeafPageCatalog } from './pdf-page-geometry';
import { loadPdfLibDocument } from './pdf-lib-load';

export interface SandwichPdfOptions {
  ocrMode?: string;
}

/**
 * Generates an authentic Lossless Sandwich PDF directly from an existing PDF document.
 * Preserves 100% of the original PDF's metadata, objects, vector artwork, annotations,
 * and compression streams while non-destructively injecting transparent text layers.
 * Any prior `3 Tr` invisible OCR text blocks on rebuilt pages are stripped first so
 * `redo` and `force` replace rather than stack duplicate OCR text layers; in `redo`
 * mode, pages carrying visible (`0..2 Tr`) vector text with no prior invisible OCR layer
 * keep their vector text without a duplicate sandwich layer (`ocrmypdf --redo-ocr`).
 * It lives apart from `ocr-pdf-combiner.ts`, which the browser OCR bundle reaches and which therefore cannot import the
 * Node-only check that `loadPdfLibDocument` runs before pdf-lib reads the file.
 * @throws DecompressionLimitError (413) and the other errors of `assertPdfLibParseWithinLimits`.
 */
export async function createLosslessSandwichPdfFromPdf(
  originalPdfBuffer: Buffer,
  pageOcrResults: Map<number, OcrResult>,
  options: SandwichPdfOptions = {}
): Promise<Buffer> {
  const doc = await loadPdfLibDocument(originalPdfBuffer);
  normaliseLeafPageCatalog(doc);
  const isRedo = options.ocrMode === 'redo';
  const numPages = doc.getPageCount();
  for (let i = 0; i < numPages; i++) {
    const pageNum = i + 1;
    const ocrResult = pageOcrResults.get(pageNum);
    if (!ocrResult) continue;

    const page = doc.getPage(i);
    const { strippedInvisibleBlocks, visibleTextBlocks } = stripPageInvisibleOcrText(page);
    if (isRedo && visibleTextBlocks > 0 && strippedInvisibleBlocks === 0) {
      continue;
    }
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
