import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { mergePdfBuffers, extractArtifactMetadata } from '@/lib/jobs';

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

  it('extracts PNG dimensions from the IHDR chunk and PDF page count', async () => {
    const png = Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64');
    const pngMeta = await extractArtifactMetadata(png, 'pixel.png', 'k/pixel.png');
    expect(pngMeta).toMatchObject({
      filename: 'pixel.png',
      format: 'png',
      sizeBytes: png.length,
      storageKey: 'k/pixel.png',
      width: 1,
      height: 1,
    });

    const pdf = await mergePdfBuffers([
      await createSinglePagePdf(FIRST_PAGE_SIZE, 'A'),
      await createSinglePagePdf(SECOND_PAGE_SIZE, 'B'),
    ]);
    const pdfMeta = await extractArtifactMetadata(pdf, 'doc.pdf');
    expect(pdfMeta).toMatchObject({ format: 'pdf', pageCount: 2, sizeBytes: pdf.length });
  });
});
