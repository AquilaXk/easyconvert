import { PDFDocument } from 'pdf-lib';
import { loadPdfDocument, openPdfForEditing, PDF_LIB_OBJECTS_PER_TICK } from '@/lib/conversions/pdf-access';
import { PARSER_LOOP_REFUSAL, withMendedPageTree } from '@/lib/conversions/pdf-postprocess/mend-page-tree';

/** Passwords for the inputs of a merge, by position; an input without an entry is merged only if it has no open password. */
export interface PdfMergeAccess {
  passwords?: ReadonlyArray<string | null | undefined>;
  /** True when the caller states they may edit every encrypted input, which lifts the owner restrictions of all of them. */
  confirmEditRights?: boolean;
  /** Stops the merge between two inputs when it fires: a merge in this process cannot be stopped inside one input. */
  signal?: AbortSignal;
}

/** The input as a document whose pages can be listed; the parser meets a page tree that loops while it lists them. */
async function readMergeInput(plain: Buffer): Promise<PDFDocument> {
  const doc = await loadPdfDocument(plain);
  doc.getPageIndices();
  return doc;
}

/**
 * Merges multiple PDF buffers into a single PDF buffer using pdf-lib.
 *
 * An input that needs an open password takes its own entry in `access.passwords` (PdfPasswordRequiredError, 422,
 * otherwise). An input whose owner forbids page assembly and modification is merged only with
 * `access.confirmEditRights` or the owner password as its password (PdfPermissionDeniedError, 422, otherwise).
 * The merged output is not encrypted.
 */
export async function mergePdfBuffers(buffers: Buffer[], access: PdfMergeAccess = {}): Promise<Buffer> {
  const mergedPdf = await PDFDocument.create();
  for (const [index, buf] of buffers.entries()) {
    access.signal?.throwIfAborted();
    const plain = await openPdfForEditing(buf, 'merge', {
      password: access.passwords?.[index] ?? undefined,
      confirmEditRights: access.confirmEditRights,
      signal: access.signal,
    });
    // A page tree that loops overflows the parser's stack; the input is read again from the mended tree.
    const doc = await withMendedPageTree(plain, readMergeInput, PARSER_LOOP_REFUSAL);
    const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
    for (const page of copiedPages) {
      mergedPdf.addPage(page);
    }
  }
  const mergedBytes = await mergedPdf.save({ objectsPerTick: PDF_LIB_OBJECTS_PER_TICK });
  return Buffer.from(mergedBytes);
}
