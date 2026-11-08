import { forEachContentToken } from './pdf-content-tokens';
import { type ContentVisitor, PdfDocument, PdfStructureError } from './pdf-document';
import { PDF_CONTENT_MAX_STATE_DEPTH, pdfTextFailure } from './pdf-text-types';

export { forEachContentToken };

/**
 * A bounded look at the streams a PDF's text depends on, before pdfjs reads it. pdfjs inflates a stream to the end
 * whatever its size, so a few kilobytes that expand to gigabytes would cost it seconds and memory the thread's heap
 * limit does not count (buffers live outside the heap). Here every content stream the page tree draws, and every
 * ToUnicode map, is decoded under the per-stream and per-document byte budgets of bounded-inflate.ts, and the
 * structure walk is bounded by the object, page and nesting limits of pdf-document.ts.
 * @throws DecompressionLimitError (413) when a stream or the document would decode past its budget.
 * @throws PdfStructureError (400) when the object graph exceeds a structural limit.
 * A stream with a filter this reader does not decode is left to pdfjs.
 * Content streams are also scanned for graphics-state nesting (`q`): pdfjs copies the state at every `q`, so a stream
 * of tens of thousands of unclosed `q` operators costs it quadratic time. Real documents nest a few dozen levels.
 * @throws CorruptStreamError (400) when a stream's compressed data is malformed.
 * @throws EncryptedOfficeDocumentError (422) for an encrypted file: its streams are ciphertext here, so none of these limits could be
 * checked and pdfjs, which decrypts with the empty password, would read it unchecked. A caller decrypts the file first (`openPdfForReading`).
 * `visitContent`, when given, is called with each content stream as well, so a caller that reads them does not decode them again.
 * @returns the document read, so the caller can read more of it without indexing the file again.
 */
export function assertPdfStreamsWithinLimits(pdf: Buffer, visitContent?: ContentVisitor): PdfDocument {
  const document = new PdfDocument(pdf, undefined, true);
  refuseEncrypted(document);
  assertDocumentStreamsWithinLimits(document, visitContent);
  return document;
}

/** The checks of `assertPdfStreamsWithinLimits` on a document already read, for one of its other readings. */
export function assertDocumentStreamsWithinLimits(document: PdfDocument, visitContent?: ContentVisitor): void {
  document.contentStreams((content, pageIndex) => {
    assertStateDepthWithinLimit(content);
    visitContent?.(content, pageIndex);
  });
  document.toUnicodeStreams(() => undefined);
}

/**
 * The part of `assertPdfStreamsWithinLimits` for a job that reads the page content as pdfjs gives it but has pdfjs build
 * the annotations: the annotation count, and every appearance stream and the forms it draws, under the same budgets.
 * @throws the errors of `assertPdfStreamsWithinLimits`.
 */
export function assertPdfAnnotationStreamsWithinLimits(pdf: Buffer): void {
  const document = new PdfDocument(pdf, undefined, true);
  refuseEncrypted(document);
  document.annotationAppearanceStreams(assertStateDepthWithinLimit);
}

function refuseEncrypted(document: PdfDocument): void {
  if (document.encrypted) {
    throw pdfTextFailure('encrypted', 'The PDF is encrypted, so the size of its pages and pictures cannot be checked before it is read; it has to be opened with its password first.');
  }
}

function assertStateDepthWithinLimit(content: string): void {
  if (graphicsStateDepth(content, PDF_CONTENT_MAX_STATE_DEPTH) > PDF_CONTENT_MAX_STATE_DEPTH) {
    throw new PdfStructureError(`A content stream nests the graphics state deeper than ${PDF_CONTENT_MAX_STATE_DEPTH} levels`);
  }
}

/**
 * Deepest nesting of q operators in a content stream, found with `forEachContentToken`. Linear in the stream length; the scan
 * stops as soon as the depth passes `stopAbove`.
 */
export function graphicsStateDepth(content: string, stopAbove = Number.POSITIVE_INFINITY): number {
  let depth = 0;
  let deepest = 0;
  forEachContentToken(content, (token) => {
    if (token === 'q') {
      depth++;
      deepest = Math.max(deepest, depth);
      return deepest > stopAbove;
    }
    if (token === 'Q') depth = Math.max(0, depth - 1);
    return false;
  });
  return deepest;
}
