import { describe, it, expect } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { COLOUR_TYPE, encodePng, rgbaImage } from './helpers/apng-builder';
import { captureError } from './helpers/capture-error';

/**
 * Option validation happens before any early-return target (PDF, hOCR, ALTO) does work, every raster
 * source advertises the background option, and failures are reported for what they are: a source that
 * cannot be read is a decode error, an output the encoder cannot write is an encode error.
 *
 * Oracles: the PNGs are written by the hand-built writer in tests/helpers/apng-builder.ts; the error
 * texts are the contract being checked.
 */

const SOLID = encodePng(rgbaImage(16, 16, () => [10, 20, 30, 255]));
/** libwebp stores at most 16383 pixels per side. */
const OVER_WEBP_LIMIT = 16384;

describe('background is validated before early-return targets', () => {
  it.each(['pdf', 'hocr', 'alto', 'png', 'jpg'])('%s target rejects a malformed background', async (target) => {
    const error = await captureError(() => convertImage(SOLID, target, { background: 'red' }, 'a.png', 'png'));
    expect(error.name).toBe('UnsupportedOptionError');
    expect(error.message).toContain('Unsupported background "red"');
  });

  it('pdf accepts a valid background', async () => {
    const result = await convertImage(SOLID, 'pdf', { background: '#fff' }, 'a.png', 'png');
    expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('the registry advertises background for every raster source that has options', () => {
  const rasterWithOptions = Object.values(FORMAT_REGISTRY).filter((format) => format.category === 'image' && format.optionsSchema);

  it('lists gif, bmp, tiff and heic', () => {
    for (const id of ['gif', 'bmp', 'tiff', 'tif', 'heic', 'heif']) {
      expect(FORMAT_REGISTRY[id].optionsSchema?.background, id).toBe(true);
    }
  });

  it('lists every raster source with an options schema', () => {
    expect(rasterWithOptions.length).toBeGreaterThan(10);
    for (const format of rasterWithOptions) {
      expect(format.optionsSchema?.background, format.id).toBe(true);
    }
  });
});

describe('decode and encode failures are told apart', () => {
  it('an unreadable source is a decode error', async () => {
    const garbage = Buffer.from('this is not an image');
    for (const options of [{}, { stripMetadata: true }]) {
      const error = await captureError(() => convertImage(garbage, 'png', options, 'bad.png', 'png'));
      expect(error.name).toBe('ConversionFailedError');
      expect(error.message).toMatch(/^Invalid image: it could not be decoded \(/);
    }
  });

  it('a truncated source is a decode error even though libvips reads it lazily', async () => {
    const truncated = SOLID.subarray(0, SOLID.length - 20);
    const error = await captureError(() => convertImage(truncated, 'png', { stripMetadata: true }, 'cut.png', 'png'));
    expect(error.message).toMatch(/^Invalid image: it could not be decoded \(/);
  });

  it('an output the encoder cannot write is an encode error, not a decode error', async () => {
    const error = await captureError(() =>
      convertImage(SOLID, 'webp', { width: OVER_WEBP_LIMIT, height: 8, fit: 'fill' }, 'a.png', 'png')
    );
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/^Cannot encode the image as \.webp \(/);
    expect(error.message).not.toMatch(/decoded/);
  });

  it('an unsupported target is a typed unsupported-target error', async () => {
    const error = await captureError(() => convertImage(SOLID, 'nonsense', {}, 'a.png', 'png'));
    expect(error.name).toBe('UnsupportedTargetError');
  });

  it('gray sources keep working through the same wrapper', async () => {
    const gray = encodePng({ width: 4, height: 4, colourType: COLOUR_TYPE.gray, bitDepth: 8, pixels: Buffer.alloc(16, 90) });
    const result = await convertImage(gray, 'webp', {}, 'g.png', 'png');
    expect(result.buffer.toString('latin1', 8, 12)).toBe('WEBP');
  });
});
