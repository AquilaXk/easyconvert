import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildMobiFromBytes } from './mobi-builder';

/**
 * Hand-written Print Replica (AZW4) container for tests: a PalmDB book whose text records hold the `%MOP` stream
 * (marker, table count, section counts, offset and length pairs) followed by real PDF files. The PDFs are made by
 * pdf-lib or LibreOffice, never by the reader under test.
 */

const MOP_HEADER_BYTES = 8;
const UINT32_BYTES = 4;
const PAIR_BYTES = 8;

/** A PDF of 300 x 200 point pages with one line of Helvetica text per page. */
export async function textPdf(pages: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) doc.addPage([300, 200]).drawText(text, { x: 20, y: 100, size: 14, font });
  return Buffer.from(await doc.save());
}

/** The `%MOP` stream: the first section of each table is its PDF. */
export function mopStream(pdfs: Buffer[]): Buffer {
  const header = Buffer.alloc(MOP_HEADER_BYTES + pdfs.length * UINT32_BYTES + pdfs.length * PAIR_BYTES);
  header.write('%MOP', 0, 'latin1');
  header.writeUInt32BE(pdfs.length, UINT32_BYTES);
  let offset = header.length;
  pdfs.forEach((pdf, i) => {
    header.writeUInt32BE(1, MOP_HEADER_BYTES + i * UINT32_BYTES);
    header.writeUInt32BE(offset, MOP_HEADER_BYTES + pdfs.length * UINT32_BYTES + i * PAIR_BYTES);
    header.writeUInt32BE(pdf.length, MOP_HEADER_BYTES + pdfs.length * UINT32_BYTES + i * PAIR_BYTES + UINT32_BYTES);
    offset += pdf.length;
  });
  return Buffer.concat([header, ...pdfs]);
}

/** An AZW4 book holding the given PDFs. */
export function buildAzw4(pdfs: Buffer[], options: { compress: boolean } = { compress: false }): Buffer {
  return buildMobiFromBytes(mopStream(pdfs), options);
}
