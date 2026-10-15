import { openPdfForEditing, type PdfAccess } from '../pdf-access';

/**
 * Removes the encryption and the owner restrictions of a PDF with qpdf (`--decrypt`), the way a document owner
 * unlocks a file for editing.
 *
 * A file with an open password needs it as `access.password`. Restrictions are only lifted when the caller confirms
 * the right to edit the document (`access.confirmEditRights === true`) or supplies the owner password; otherwise the
 * call answers PdfPermissionDeniedError (422). An unencrypted PDF is returned as it is.
 */
export async function unlockPdf(pdfBuffer: Buffer, access: PdfAccess = {}): Promise<Buffer> {
  return openPdfForEditing(pdfBuffer, 'unlock', access);
}
