import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
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
      const pdfDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
      metadata.pageCount = pdfDoc.getPageCount();
      metadata.title = pdfDoc.getTitle() || undefined;
      metadata.author = pdfDoc.getAuthor() || undefined;
    } catch {
      // ignore
    }
  } else if (ext === 'png' && buf.length >= 24) {
    metadata.width = buf.readUInt32BE(16);
    metadata.height = buf.readUInt32BE(20);
  }

  return metadata;
}

/**
 * Merges multiple PDF buffers into a single PDF buffer using pdf-lib.
 */
export async function mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
  const mergedPdf = await PDFDocument.create();
  for (const buf of buffers) {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
    for (const page of copiedPages) {
      mergedPdf.addPage(page);
    }
  }
  const mergedBytes = await mergedPdf.save();
  return Buffer.from(mergedBytes);
}

