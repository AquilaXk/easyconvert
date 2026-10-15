import { PDFDocument } from 'pdf-lib';
import { ConversionFailedError } from '../../types';
import { EncryptedOfficeDocumentError } from './legacy-office-errors';
import { readMobiRawText } from './mobi-reader';

/**
 * PDF of an AZW4 (Print Replica) e-book. A Print Replica book is a PalmDB/MOBI container whose text records
 * hold PDF files instead of markup. The text records are decompressed by the MOBI reader; the PDFs are then
 * found by their `%PDF-` signature (or, when the stream starts with the `%MOP` marker, by its table of
 * offsets and lengths), and each one must load as a PDF before it is used.
 */

const MOP_MARKER = '%MOP';
const MOP_COUNT_OFFSET = 4;
const MOP_TABLES_OFFSET = 8;
const UINT32_BYTES = 4;
const PDF_SIGNATURE = '%PDF-';
const PDF_EOF_MARKER = '%%EOF';
/** Line-end bytes that may follow the final %%EOF marker. */
const EOF_TRAILER_BYTES = 2;
/** Most PDF files one book may hold, and the most pages of the merged result. */
export const PRINT_REPLICA_MAX_PDFS = 64;
export const PRINT_REPLICA_MAX_PAGES = 20_000;

/** The slices a `%MOP` table names: for each table the first section is a PDF. Null when the table is absent or inconsistent. */
function sectionsFromTable(raw: Buffer): Buffer[] | null {
  if (raw.length < MOP_TABLES_OFFSET || raw.toString('latin1', 0, MOP_MARKER.length) !== MOP_MARKER) return null;
  const tables = raw.readUInt32BE(MOP_COUNT_OFFSET);
  if (tables === 0 || tables > PRINT_REPLICA_MAX_PDFS) return null;
  let entryOffset = MOP_TABLES_OFFSET + tables * UINT32_BYTES;
  const slices: Buffer[] = [];
  for (let table = 0; table < tables; table += 1) {
    const sections = raw.readUInt32BE(MOP_TABLES_OFFSET + table * UINT32_BYTES);
    if (sections === 0 || entryOffset + sections * 2 * UINT32_BYTES > raw.length) return null;
    const start = raw.readUInt32BE(entryOffset);
    const length = raw.readUInt32BE(entryOffset + UINT32_BYTES);
    entryOffset += sections * 2 * UINT32_BYTES;
    if (start + length > raw.length || raw.toString('latin1', start, start + PDF_SIGNATURE.length) !== PDF_SIGNATURE) return null;
    slices.push(raw.subarray(start, start + length));
  }
  return slices;
}

/** PDF candidates found by signature: each runs from one `%PDF-` to just after its last `%%EOF` before the next signature. */
function sectionsFromSignatures(raw: Buffer): Buffer[] {
  const starts: number[] = [];
  for (let at = raw.indexOf(PDF_SIGNATURE); at !== -1 && starts.length < PRINT_REPLICA_MAX_PDFS; at = raw.indexOf(PDF_SIGNATURE, at + PDF_SIGNATURE.length)) {
    starts.push(at);
  }
  return starts.map((start, index) => {
    const limit = index + 1 < starts.length ? starts[index + 1] : raw.length;
    const eof = raw.subarray(start, limit).lastIndexOf(PDF_EOF_MARKER);
    const end = eof === -1 ? limit : Math.min(limit, start + eof + PDF_EOF_MARKER.length + EOF_TRAILER_BYTES);
    return raw.subarray(start, end);
  });
}

async function loadPdf(candidate: Buffer): Promise<PDFDocument | null> {
  try {
    return await PDFDocument.load(candidate);
  } catch (error) {
    if (error instanceof Error && /encrypted/i.test(error.message)) {
      throw new EncryptedOfficeDocumentError('The Print Replica PDF is encrypted, so its pages cannot be read.');
    }
    return null;
  }
}

function countPages(pdf: PDFDocument): number {
  try {
    return pdf.getPageCount();
  } catch {
    return 0;
  }
}

async function loadDocuments(candidates: Buffer[]): Promise<{ pdf: PDFDocument; bytes: Buffer }[]> {
  const documents: { pdf: PDFDocument; bytes: Buffer }[] = [];
  for (const candidate of candidates) {
    const pdf = await loadPdf(candidate);
    // A candidate whose page tree is broken throws when its pages are counted: it is not a usable PDF.
    if (pdf && countPages(pdf) > 0) documents.push({ pdf, bytes: candidate });
  }
  return documents;
}

/** The PDF of an AZW4 book (several embedded PDFs are joined in file order). A book that holds no readable PDF is a typed 400 error. */
export async function extractPrintReplicaPdf(file: Buffer): Promise<Buffer> {
  const raw = readMobiRawText(file).bytes;
  // The decompressed text records first; a book that stores its PDF in a record outside them is read from the file itself.
  let documents = await loadDocuments(sectionsFromTable(raw) ?? sectionsFromSignatures(raw));
  if (documents.length === 0) documents = await loadDocuments(sectionsFromSignatures(file));
  if (documents.length === 0) {
    throw new ConversionFailedError('The AZW4 book holds no readable PDF: no embedded document with a valid PDF structure was found in its text records.');
  }
  if (documents.length === 1) return documents[0].bytes;
  const merged = await PDFDocument.create();
  let pages = 0;
  for (const { pdf } of documents) {
    pages += pdf.getPageCount();
    if (pages > PRINT_REPLICA_MAX_PAGES) throw new ConversionFailedError(`The AZW4 book holds more than ${PRINT_REPLICA_MAX_PAGES} pages.`);
    for (const page of await merged.copyPages(pdf, pdf.getPageIndices())) merged.addPage(page);
  }
  return Buffer.from(await merged.save());
}
