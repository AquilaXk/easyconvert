import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { applyPdfWatermark } from '../src/lib/conversions/pdf-postprocess/watermark';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { ConversionFailedError } from '../src/lib/types';
import { bombJpeg, bombPng, withCorruptIhdr } from './helpers/image-bombs';

const HTTP_PAYLOAD_TOO_LARGE = 413;
const OVER_LIMIT_SIDE = 15_000;
const WATERMARK_SIDE = 24;
const BYTES_PER_MIB = 1024 * 1024;
const MAX_RSS_GROWTH_BYTES = 50 * BYTES_PER_MIB;

async function onePagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

describe('an image watermark is held to the input pixel limit before pdf-lib decodes it', () => {
  it.each([
    ['PNG', () => bombPng(OVER_LIMIT_SIDE, OVER_LIMIT_SIDE)],
    ['JPEG', () => bombJpeg(OVER_LIMIT_SIDE, OVER_LIMIT_SIDE)],
  ])('refuses a %s that declares 225 megapixels', async (_label, build) => {
    const rssBefore = process.memoryUsage().rss;
    const run = applyPdfWatermark(await onePagePdf(), { type: 'image', image: build() });
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE });
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it('refuses a base64 data URI watermark the same way', async () => {
    const uri = `data:image/png;base64,${bombPng(OVER_LIMIT_SIDE, OVER_LIMIT_SIDE).toString('base64')}`;
    const run = applyPdfWatermark(await onePagePdf(), { type: 'image', image: uri });
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, width: OVER_LIMIT_SIDE });
  });

  it('refuses a watermark PNG whose header cannot be read, which pdf-lib would still decode', async () => {
    const run = applyPdfWatermark(await onePagePdf(), { type: 'image', image: withCorruptIhdr(bombPng(OVER_LIMIT_SIDE, OVER_LIMIT_SIDE)) });
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/header could not be decoded/);
  });

  it('still stamps a small watermark image onto the page', async () => {
    const png = await sharp({ create: { width: WATERMARK_SIDE, height: WATERMARK_SIDE, channels: 3, background: '#3366cc' } }).png().toBuffer();
    const stamped = await applyPdfWatermark(await onePagePdf(), { type: 'image', image: png });
    const reloaded = await PDFDocument.load(stamped);
    expect(reloaded.getPageCount()).toBe(1);
    expect(stamped.includes(Buffer.from('/Subtype /Image'))).toBe(true);
  });
});
