import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { loadPdfDocument, openPdfForEditing } from '@/lib/conversions/pdf-access';
import { inspectPdfEncryption } from '@/lib/conversions/pdf-encryption';
import { getFormatByExtension } from '@/lib/registry';

/**
 * Extracts metadata from file buffer in a safe, deterministic manner.
 */
export async function extractArtifactMetadata(
  buf: Buffer,
  filename: string,
  storageKey?: string
): Promise<Record<string, unknown>> {
  const ext = path.extname(filename).replace(/^\./, '').toLowerCase();
  const formatDef = getFormatByExtension(ext);
  const metadata: Record<string, unknown> = {
    filename,
    sizeBytes: buf.length,
    format: ext,
    mimeType: formatDef?.mimeType || 'application/octet-stream',
    category: formatDef?.category || 'unknown',
    storageKey,
    timestamp: new Date().toISOString(),
  };

  if (ext === 'pdf') {
    try {
      if (inspectPdfEncryption(buf).encrypted) {
        // Page count, title and author of an encrypted file sit behind its password: record that, read nothing.
        metadata.encrypted = true;
      } else {
        const pdfDoc = await loadPdfDocument(buf);
        metadata.pageCount = pdfDoc.getPageCount();
        metadata.title = pdfDoc.getTitle() || undefined;
        metadata.author = pdfDoc.getAuthor() || undefined;
      }
    } catch {
      // Metadata is best effort for a PDF whose structure cannot be read; the file itself is not touched.
    }
  } else if (ext === 'png' && buf.length >= 24) {
    metadata.width = buf.readUInt32BE(16);
    metadata.height = buf.readUInt32BE(20);
  }

  return metadata;
}

/** Passwords for the inputs of a merge, by position; an input without an entry is merged only when unencrypted. */
export interface PdfMergeAccess {
  passwords?: ReadonlyArray<string | undefined>;
}

/**
 * Merges multiple PDF buffers into a single PDF buffer using pdf-lib.
 *
 * Each encrypted input needs its own password in `access.passwords` (PdfPasswordRequiredError, 422, otherwise) and
 * its owner must not restrict any right unless the password is the owner password (PdfPermissionDeniedError, 422).
 * The merged output is not encrypted.
 */
export async function mergePdfBuffers(buffers: Buffer[], access: PdfMergeAccess = {}): Promise<Buffer> {
  const mergedPdf = await PDFDocument.create();
  for (const [index, buf] of buffers.entries()) {
    const plain = await openPdfForEditing(buf, { password: access.passwords?.[index] });
    const doc = await loadPdfDocument(plain);
    const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
    for (const page of copiedPages) {
      mergedPdf.addPage(page);
    }
  }
  const mergedBytes = await mergedPdf.save();
  return Buffer.from(mergedBytes);
}
