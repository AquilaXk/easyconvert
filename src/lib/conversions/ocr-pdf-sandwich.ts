import { type OcrResult, injectInvisibleTextLayer, injectRenderedPageTextLayer } from './ocr-pdf-combiner';
import { levelPageToText } from './ocr-output-deskew';
import { stripPageInvisibleOcrText } from './ocr-strip-invisible-text';
import { normaliseLeafPageCatalog } from './pdf-page-geometry';
import { loadPdfLibDocument } from './pdf-lib-load';

export interface SandwichPdfOptions {
  ocrMode?: string;
  /** Level each page whose text layer is skewed (`ocrDeskew`); see ocr-output-deskew.ts. */
  ocrDeskew?: boolean;
}

/**
 * Generates an authentic Lossless Sandwich PDF directly from an existing PDF document.
 * Preserves 100% of the original PDF's metadata, objects, vector artwork, annotations,
 * and compression streams while non-destructively injecting transparent text layers.
 * When `options.ocrMode === 'redo'`, any prior `3 Tr` invisible OCR text blocks on rebuilt
 * pages are stripped first so `redo` replaces rather than stacks duplicate OCR text layers,
 * and pages carrying visible (`0..2 Tr`) vector text with no prior invisible OCR layer
 * keep their vector text without a duplicate sandwich layer (`ocrmypdf --redo-ocr`).
 * Default and `force` passes leave existing content streams untouched (`ECToUnicodeFont1`...).
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
    if (isRedo) {
      const { strippedInvisibleBlocks, visibleTextBlocks } = stripPageInvisibleOcrText(page);
      if (visibleTextBlocks > 0 && strippedInvisibleBlocks === 0) {
        continue;
      }
    }
    if (ocrResult.pageRender) {
      const placed = injectRenderedPageTextLayer(page, ocrResult, ocrResult.pageRender, options.ocrDeskew === true);
      if (options.ocrDeskew === true) levelPageToText(page, placed);
      continue;
    }
    const { width: pageWidth, height: pageHeight } = page.getSize();

    const imgWidth = ocrResult.imageWidth || pageWidth;
    const imgHeight = ocrResult.imageHeight || pageHeight;

    const scaleX = pageWidth / imgWidth;
    const scaleY = pageHeight / imgHeight;

    const placed = injectInvisibleTextLayer(page, ocrResult, scaleX, scaleY, undefined, options.ocrDeskew === true);
    if (options.ocrDeskew === true) levelPageToText(page, placed);
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}
