import { describe, expect, it } from 'vitest';
import { isImageCompression, paletteColorsForQuality, serverOptionsFor } from '../src/lib/image-compression';
import { resolveConversionTier } from '../src/lib/edge/tier-router';

describe('the compression of a PNG or a JPG', () => {
  it('is a conversion of the format to itself, for PNG and JPG only', () => {
    expect(isImageCompression('png', 'png')).toBe(true);
    expect(isImageCompression('JPG', 'jpg')).toBe(true);
    expect(isImageCompression('png', 'jpg')).toBe(false);
    expect(isImageCompression('webp', 'webp')).toBe(false);
  });

  it('keeps the whole palette from quality 80 and shrinks it in proportion to the square of the quality below', () => {
    expect([100, 85, 80].map(paletteColorsForQuality)).toEqual([256, 256, 256]);
    expect(paletteColorsForQuality(40)).toBe(64);
    expect(paletteColorsForQuality(20)).toBe(16);
    expect(paletteColorsForQuality(1)).toBe(2);
  });

  it('sends a PNG quality as a palette size and leaves every other conversion as it is', () => {
    expect(serverOptionsFor('png', 'png', { quality: 40, stripMetadata: true })).toEqual({ stripMetadata: true, palette: true, colors: 64 });
    expect(serverOptionsFor('png', 'png', {})).toEqual({ palette: true, colors: 256 });
    const jpg = { quality: 60 };
    expect(serverOptionsFor('jpg', 'jpg', jpg)).toBe(jpg);
    const pair = { quality: 60 };
    expect(serverOptionsFor('png', 'jpg', pair)).toBe(pair);
  });

  it('runs on the server tier, not on the canvas or the browser quantiser', () => {
    for (const format of ['png', 'jpg']) {
      expect(resolveConversionTier(format, format, 200_000, { quality: 60 }, { hasCanvas: true })).toMatchObject({ tier: 'L4', isClientEdge: false });
    }
    expect(resolveConversionTier('png', 'jpg', 200_000, {}, { hasCanvas: true })).toMatchObject({ tier: 'L0' });
  });
});
