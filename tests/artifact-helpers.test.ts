import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { mergePdfBuffers } from '@/lib/jobs';
import { readMetadata } from '@/lib/jobs/metadata/read';

const FIRST_PAGE_SIZE: [number, number] = [400, 400];
const SECOND_PAGE_SIZE: [number, number] = [300, 500];

async function createSinglePagePdf(size: [number, number], text: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage(size);
  page.drawText(text, { x: 20, y: 20 });
  return Buffer.from(await pdfDoc.save());
}

// 1x1 RGBA PNG; IHDR width/height are both 1 by construction.
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('artifact helpers', () => {
  it('merges PDF buffers into one document preserving page order', async () => {
    const first = await createSinglePagePdf(FIRST_PAGE_SIZE, 'Page 1');
    const second = await createSinglePagePdf(SECOND_PAGE_SIZE, 'Page 2');

    const merged = await mergePdfBuffers([first, second]);

    expect(merged.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(2);
    const sizes = doc.getPages().map((page) => {
      const { width, height } = page.getSize();
      return [width, height];
    });
    expect(sizes).toEqual([FIRST_PAGE_SIZE, SECOND_PAGE_SIZE]);
  });

  it('reads the dimensions of a PNG and the page count and size of a PDF', async () => {
    const png = Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64');
    const pngMeta = await readMetadata(png, 'pixel.png');
    expect(pngMeta).toMatchObject({
      schemaVersion: 1,
      File: { FileName: 'pixel.png', FileType: 'PNG', FileSize: png.length, MIMEType: 'image/png' },
      Image: { ImageWidth: 1, ImageHeight: 1 },
    });

    const pdf = await mergePdfBuffers([
      await createSinglePagePdf(FIRST_PAGE_SIZE, 'A'),
      await createSinglePagePdf(SECOND_PAGE_SIZE, 'B'),
    ]);
    const pdfMeta = await readMetadata(pdf, 'doc.pdf');
    expect(pdfMeta).toMatchObject({ File: { FileType: 'PDF', FileSize: pdf.length }, PDF: { PageCount: 2, PageWidth: FIRST_PAGE_SIZE[0], PageHeight: FIRST_PAGE_SIZE[1] } });
  });
});
