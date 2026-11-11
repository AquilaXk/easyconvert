import type { LoadOptions, PDFDocument } from 'pdf-lib';
import { PdfDocument } from './pdf-document';

/**
 * Checks, before pdf-lib reads a file, the streams pdf-lib inflates while it loads one (`PdfDocument.assertLibParseWithinLimits`).
 * pdf-lib decodes every object stream and cross-reference stream it meets with an inflate that has no output limit, so a few
 * hundred kilobytes of Flate data in one (referenced or not) cost it gigabytes of memory.
 * @throws DecompressionLimitError (413), PdfStructureError (400) or CorruptStreamError (400), as `PdfDocument.assertLibParseWithinLimits`.
 */
export function assertPdfLibParseWithinLimits(pdf: Uint8Array): void {
  const bytes = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  new PdfDocument(bytes, undefined, false, 'scan').assertLibParseWithinLimits();
}

/**
 * The one way to open a PDF with pdf-lib (a source scan fails any other `PDFDocument.load`): the streams pdf-lib would inflate
 * are checked first (`assertPdfLibParseWithinLimits`), then the file is loaded with `options`.
 * @throws the errors of `assertPdfLibParseWithinLimits`, and those of `PDFDocument.load`.
 */
export async function loadPdfLibDocument(pdf: Uint8Array, options?: LoadOptions): Promise<PDFDocument> {
  assertPdfLibParseWithinLimits(pdf);
  // Imported when first needed, as the text thread does: it reads most files without pdf-lib.
  const lib = await import('pdf-lib');
  return lib.PDFDocument.load(pdf, options);
}
