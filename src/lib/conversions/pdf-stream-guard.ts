import { PdfDocument } from './pdf-document';

/**
 * A bounded look at the streams a PDF's text depends on, before pdfjs reads it. pdfjs inflates a stream to the end
 * whatever its size, so a few kilobytes that expand to gigabytes would cost it seconds and memory the thread's heap
 * limit does not count (buffers live outside the heap). Here every content stream the page tree draws, and every
 * ToUnicode map, is decoded under the per-stream and per-document byte budgets of bounded-inflate.ts, and the
 * structure walk is bounded by the object, page and nesting limits of pdf-document.ts.
 * @throws DecompressionLimitError (413) when a stream or the document would decode past its budget.
 * @throws PdfStructureError (400) when the object graph exceeds a structural limit.
 * A stream with a filter this reader does not decode is left to pdfjs.
 * @throws CorruptStreamError (400) when a stream's compressed data is malformed.
 */
export function assertPdfStreamsWithinLimits(pdf: Buffer): void {
  const document = new PdfDocument(pdf, undefined, true);
  document.contentStreams(() => undefined);
  document.toUnicodeStreams(() => undefined);
}
