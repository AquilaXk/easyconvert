import { beforeAll, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { extractRasterImagesFromPdf } from '../src/lib/conversions/pdf-rasterizer';
import { pdfWithFlateImage } from './helpers/image-pdf-bomb';

const BYTES_PER_MIB = 1024 * 1024;
const MAX_REJECTION_MS = 1000;
const MAX_RSS_GROWTH_BYTES = 50 * BYTES_PER_MIB;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const EXPECTED_DEFAULT_LIMIT = 100_000_000;
const OVER_CAP_SIDE = 15_000;
const SMALL_SIDE = 64;
const MAX_BOMB_PDF_BYTES = 2 * BYTES_PER_MIB;

describe('PDF raster extraction (the OCR input path) honours the input pixel limit', () => {
  beforeAll(async () => {
    // Load pdfjs once so the measurement below covers the rejection only.
    await extractRasterImagesFromPdf(pdfWithFlateImage(SMALL_SIDE, SMALL_SIDE));
  });

  it('refuses a small PDF whose image declares 225 megapixels, before the image is decoded', async () => {
    const pdf = pdfWithFlateImage(OVER_CAP_SIDE, OVER_CAP_SIDE);
    expect(pdf.length).toBeLessThan(MAX_BOMB_PDF_BYTES);

    const rssBefore = process.memoryUsage().rss;
    const start = performance.now();
    let error: unknown;
    try {
      await extractRasterImagesFromPdf(pdf);
    } catch (caught) {
      error = caught;
    }
    const ms = performance.now() - start;

    expect(error).toBeInstanceOf(InputPixelLimitError);
    expect(error).toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, limit: EXPECTED_DEFAULT_LIMIT });
    expect(ms).toBeLessThan(MAX_REJECTION_MS);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it('keeps the typed error through a PDF conversion that asks for OCR, without decoding the image', async () => {
    const pdf = pdfWithFlateImage(OVER_CAP_SIDE, OVER_CAP_SIDE);
    const start = performance.now();
    const run = convertFile(pdf, 'pdf', 'txt', { ocrEnabled: true }, 'scan.pdf');
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE });
    expect(performance.now() - start).toBeLessThan(MAX_REJECTION_MS);
  });

  it('never decodes an inline image over the limit, which pdfjs drops by itself', async () => {
    const pdf = pdfWithFlateImage(OVER_CAP_SIDE, OVER_CAP_SIDE, true);
    const rssBefore = process.memoryUsage().rss;
    const images = await extractRasterImagesFromPdf(pdf);
    expect(images).toEqual([]);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it('still extracts an image within the limit', async () => {
    const images = await extractRasterImagesFromPdf(pdfWithFlateImage(SMALL_SIDE, SMALL_SIDE));
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ pageNumber: 1, width: SMALL_SIDE, height: SMALL_SIDE });
    expect(images[0].buffer.subarray(1, 4).toString('ascii')).toBe('PNG');
  });
});
