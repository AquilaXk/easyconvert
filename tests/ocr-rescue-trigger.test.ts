import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { imageHasInk } from '../src/lib/conversions/ocr';

const blank = (background: string): Promise<Buffer> => sharp({ create: { width: 200, height: 100, channels: 3, background } }).png().toBuffer();

describe('the ink check that gates the ONNX second reading of an English page', () => {
  it('finds no ink on a white or a flat grey page, so the engine is not started for a blank page', async () => {
    expect(await imageHasInk(await blank('#fff'))).toBe(false);
    expect(await imageHasInk(await blank('#e8e8e8'))).toBe(false);
  });

  it('finds ink on a page with a dark mark, however small', async () => {
    const marked = await sharp(await blank('#fff')).composite([{ input: { create: { width: 6, height: 2, channels: 3, background: '#000' } }, left: 40, top: 40 }]).png().toBuffer();
    expect(await imageHasInk(marked)).toBe(true);
  });
});
