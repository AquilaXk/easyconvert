import type { PDFDocument, PDFPage } from 'pdf-lib';
import { PayloadLimitError } from '../types';
import { maxInputPixels } from './image-input-limit-config';
import {
  type CheckedPdfRasterBudget,
  MAX_RASTER_PAGE_PIXELS,
  type PdfPageFrame,
  PdfPageFrameError,
  assertRawPdfBoxesWithinPageLimit,
  checkPageFrameWithBudget,
  hasUnresolvedPageTreeRef,
  normaliseLeafPageCatalog,
  readPageFrame,
} from './pdf-page-geometry';
import { loadPdfLibDocument } from './pdf-lib-load';

/**
 * The two readers of the page boxes that open the file with pdf-lib. They live apart from `pdf-page-geometry.ts`, which the
 * browser OCR bundle reaches and which therefore cannot import the Node-only check that `loadPdfLibDocument` runs first.
 */

/** The frame of every page of a PDF, in page order.
 * @throws DecompressionLimitError (413) when the streams pdf-lib would inflate to read the file are past a limit. */
export async function readPdfPageFrames(pdf: Buffer | Uint8Array): Promise<PdfPageFrame[]> {
  let doc: PDFDocument;
  try {
    doc = await loadPdfLibDocument(pdf, { updateMetadata: false });
  } catch (err) {
    if (err instanceof PayloadLimitError) throw err;
    throw new PdfPageFrameError(`Invalid PDF: the page boxes could not be read (${err instanceof Error ? err.message : String(err)}).`);
  }
  normaliseLeafPageCatalog(doc);
  let pages: PDFPage[];
  try {
    pages = doc.getPages();
  } catch (err) {
    throw new PdfPageFrameError(`Invalid PDF: the page tree could not be read (${err instanceof Error ? err.message : String(err)}).`);
  }
  return pages.map((page, index) => readPageFrame(page, index + 1));
}

/**
 * Checks the pages the request selects against the page and pixel limits, from the page tree and the page boxes.
 *
 * `pdf` is a file pdf-lib can open. An encrypted file is not: its page tree may sit in an encrypted object stream that the
 * fallback scan of the raw bytes cannot see, so the caller hands over the decrypted bytes (`openPdfForReading`; this module is
 * reachable from the browser OCR bundle and must not import the qpdf runner).
 */
export async function checkPdfRasterPageBudget(
  pdf: Buffer | Uint8Array,
  selectPageNumbers: (pageCount: number) => readonly number[],
  dpi: number
): Promise<CheckedPdfRasterBudget | undefined> {
  let doc: PDFDocument;
  try {
    doc = await loadPdfLibDocument(pdf, { updateMetadata: false, throwOnInvalidObject: true });
  } catch (err) {
    if (err instanceof PayloadLimitError) throw err;
    assertRawPdfBoxesWithinPageLimit(pdf, selectPageNumbers, dpi);
    return undefined;
  }
  if (hasUnresolvedPageTreeRef(doc)) {
    assertRawPdfBoxesWithinPageLimit(pdf, selectPageNumbers, dpi);
    return undefined;
  }
  normaliseLeafPageCatalog(doc);
  let pages: PDFPage[];
  try {
    pages = doc.getPages();
  } catch (err) {
    throw new PdfPageFrameError(`Invalid PDF: the page tree could not be read (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (pages.length === 0) {
    assertRawPdfBoxesWithinPageLimit(pdf, selectPageNumbers, dpi);
    return undefined;
  }
  const pageNumbers = [...selectPageNumbers(pages.length)];
  const perPageLimit = Math.min(MAX_RASTER_PAGE_PIXELS, maxInputPixels());
  const selectedFrames: PdfPageFrame[] = [];
  for (const pageNumber of pageNumbers) {
    const page = pages[pageNumber - 1];
    if (!page) {
      throw new PdfPageFrameError(`Invalid PDF: page ${pageNumber} does not exist.`);
    }
    selectedFrames.push(checkPageFrameWithBudget(page, pageNumber, dpi, perPageLimit));
  }
  return { pageNumbers, frames: selectedFrames };
}
