import { describe, it, expect } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { MAX_OUTPUT_PIXELS } from '../src/lib/conversions/image-limits';
import { captureError } from './helpers/capture-error';
import { decodeRgba, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

/**
 * Vector sources (SVG) are rasterised at the density and size the request names, so they obey the same
 * output limits as raster images: width and height are whole numbers from 1 to 65535, the output holds at most
 * 100 million pixels, and the size is checked from the SVG header before anything is rendered. A 150-byte SVG
 * resized to 30000 pixels wide used to allocate 5.6 GiB.
 *
 * Oracles: the SVG is written out below; sizes of the accepted output are read with ImageMagick.
 */

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="rgb(0,128,255)"/></svg>'
);
const QUICK_MS = 3000;
const DPI_TO_PIXELS = 300 / 72;

async function convertSvg(target: string, options: Record<string, unknown>) {
  return convertFile(SVG, 'svg', target, options, 'drawing.svg');
}

describe('SVG output size limits', () => {
  it('uses the same pixel limit as raster images', () => {
    expect(MAX_OUTPUT_PIXELS).toBe(100_000_000);
  });

  it.each([
    ['width 20000 (one-sided: 20000 x 10000 = 200 Mpx scaled from 100 x 50)', { width: 20000 }],
    ['width 30000, the reported 5.6 GiB case', { width: 30000 }],
    ['height 30000', { height: 30000 }],
    ['a 20000 x 20000 box', { width: 20000, height: 20000 }],
    ['a 11000 x 11000 box', { width: 11000, height: 11000, fit: 'fill' }],
  ])('refuses %s quickly with a typed error', async (_label, options) => {
    const started = Date.now();
    const error = await captureError(() => convertSvg('jpg', options));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/The resized image would be \d+x\d+ pixels \(\d+ pixels\), over the limit of 100000000 pixels/);
    expect(Date.now() - started).toBeLessThan(QUICK_MS);
  });

  it.each([
    ['width 1e9', { width: 1e9 }],
    ['width 65536', { width: 65536 }],
    ['fractional height', { height: 10.5 }],
    ['text width', { width: 'wide' }],
    ['negative width', { width: -4 }],
  ])('refuses %s as an unsupported option', async (_label, options) => {
    const error = await captureError(() => convertSvg('png', options));
    expect(error.name).toBe('UnsupportedOptionError');
    expect(error.message).toMatch(/Unsupported (width|height)/);
  });

  it.each(['png', 'webp', 'tiff'])('applies to a %s target too', async (target) => {
    const error = await captureError(() => convertSvg(target, { width: 20000, height: 20000 }));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/over the limit of 100000000 pixels/);
  });

  it.each(['png', 'pdf'])('refuses a density that renders the drawing over the pixel limit as %s', async (target) => {
    // 100 x 50 user units at 12000 dpi are 16667 x 8333 pixels (139 Mpx); the renderer itself accepts that.
    const error = await captureError(() => convertSvg(target, { dpi: 12000 }));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/over the limit of 100000000 pixels/);
  });

  it.each(['png', 'pdf'])('reports a density the renderer rejects as a conversion failure for %s', async (target) => {
    const error = await captureError(() => convertSvg(target, { dpi: 100000 }));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/The SVG drawing cannot be rendered at 100000 dpi/);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('still resizes a normal drawing to the requested size', async () => {
    const result = await convertSvg('png', { width: 64 });
    const image = decodeRgba(result.buffer, 'png');
    expect([image.width, image.height]).toEqual([64, 32]);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('still honours a requested box with letterboxing', async () => {
    const result = await convertSvg('png', { width: 80, height: 80, fit: 'contain' });
    const image = decodeRgba(result.buffer, 'png');
    expect([image.width, image.height]).toEqual([80, 80]);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('renders at the default density without a size request', async () => {
    const result = await convertSvg('png', {});
    const image = decodeRgba(result.buffer, 'png');
    expect([image.width, image.height]).toEqual([Math.round(100 * DPI_TO_PIXELS), Math.round(50 * DPI_TO_PIXELS)]);
  });
});
