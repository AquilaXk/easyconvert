import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';

const IMAGE_WIDTH = 120;
const IMAGE_HEIGHT = 80;

async function pagePoints(source: { width: number; height: number }, options: Record<string, unknown> = {}) {
  const png = await sharp({
    create: { width: source.width, height: source.height, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  const result = await convertFile(png, 'png', 'pdf', options, 'photo.png');
  const pdf = await PDFDocument.load(result.buffer);
  expect(pdf.getPageCount()).toBe(1);
  return pdf.getPage(0).getSize();
}

describe('image -> pdf page size', () => {
  it('gives a landscape image a landscape page of the image size', async () => {
    expect(await pagePoints({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT })).toEqual({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT });
  });

  it('gives a portrait image a portrait page of the image size', async () => {
    expect(await pagePoints({ width: IMAGE_HEIGHT, height: IMAGE_WIDTH })).toEqual({ width: IMAGE_HEIGHT, height: IMAGE_WIDTH });
  });

  it('turns a portrait image onto a landscape page when landscape is requested', async () => {
    expect(await pagePoints({ width: IMAGE_HEIGHT, height: IMAGE_WIDTH }, { orientation: 'landscape' })).toEqual({
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
    });
  });
});
