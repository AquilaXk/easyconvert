import { describe, expect, it, vi } from 'vitest';
import { FULL_PALETTE_QUALITY, isImageCompression, paletteColorsForQuality, serverOptionsFor } from '../src/lib/image-compression';
import { ImageOptionsSection } from '../src/components/workbench/options/ImageAndMediaOptions';
import { renderComponent, visibleText } from './helpers/rendered-dom';
import { resolveConversionTier } from '../src/lib/edge/tier-router';
import { executeItemConversion } from '../src/lib/client-converter';

describe('the compression of a PNG or a JPG', () => {
  it('is a conversion of the format to itself, for PNG and JPG only', () => {
    expect(isImageCompression('png', 'png')).toBe(true);
    expect(isImageCompression('JPG', 'jpg')).toBe(true);
    expect(isImageCompression('png', 'jpg')).toBe(false);
    expect(isImageCompression('webp', 'webp')).toBe(false);
  });

  it('counts a file named .jpeg or .jfif as a JPG, as the compress page of JPG takes it', () => {
    expect(isImageCompression('jpeg', 'jpg')).toBe(true);
    expect(isImageCompression('jfif', 'jpg')).toBe(true);
    expect(isImageCompression('jpeg', 'jpeg')).toBe(true);
    expect(isImageCompression('jpeg', 'png')).toBe(false);
    expect(isImageCompression('tif', 'tiff')).toBe(false);
  });

  it('keeps the whole palette at the quality the options dialog shows for a PNG, and takes colours away with every step below it', () => {
    const shown = visibleText(renderComponent(ImageOptionsSection, { options: {}, onChange: () => undefined, targetFormat: 'png' }));
    expect(shown).toContain(`${FULL_PALETTE_QUALITY}%`);
    expect([100, FULL_PALETTE_QUALITY].map(paletteColorsForQuality)).toEqual([256, 256]);
    expect(paletteColorsForQuality(FULL_PALETTE_QUALITY - 1)).toBeLessThan(256);
    expect(paletteColorsForQuality(80)).toBeLessThan(paletteColorsForQuality(84));
  });

  it('shrinks the palette in proportion to the square of the quality', () => {
    expect(paletteColorsForQuality(FULL_PALETTE_QUALITY / 2)).toBe(64);
    expect(paletteColorsForQuality(FULL_PALETTE_QUALITY / 4)).toBe(16);
    expect(paletteColorsForQuality(1)).toBe(2);
  });

  it('sends a PNG quality as a palette size and leaves every other conversion as it is', () => {
    expect(serverOptionsFor('png', 'png', { quality: FULL_PALETTE_QUALITY / 2, stripMetadata: true })).toEqual({ stripMetadata: true, palette: true, colors: 64 });
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
    for (const source of ['jpeg', 'jfif']) {
      expect(resolveConversionTier(source, 'jpg', 200_000, { quality: 60 }, { hasCanvas: true })).toMatchObject({ tier: 'L4', isClientEdge: false });
    }
    expect(resolveConversionTier('png', 'jpg', 200_000, {}, { hasCanvas: true })).toMatchObject({ tier: 'L0' });
  });
});

describe('a compression that does not make the file smaller', () => {
  const item = (name: string, format: string, bytes: number) => ({
    id: '1', file: new File([new Uint8Array(bytes)], name), name, size: bytes, sourceFormat: format, targetFormat: format, status: 'ready' as const, options: {},
  });

  async function answerFor(queued: ReturnType<typeof item>, resultBytes: number) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(resultBytes), { status: 200 })));
    const onSuccess = vi.fn();
    await executeItemConversion(queued, { onProgress: () => undefined, onSuccess, onError: (failure) => { throw new Error(JSON.stringify(failure)); } });
    vi.unstubAllGlobals();
    return onSuccess.mock.calls[0];
  }

  it('gives the input back as it is, marked unchanged', async () => {
    const [, size, , , , unchanged] = await answerFor(item('photo.png', 'png', 1000), 1200);
    expect(size).toBe(1000);
    expect(unchanged).toBe(true);
  });

  it('gives a .jpeg input back as it is too, as the compress page of JPG names its target jpg', async () => {
    const queued = { ...item('photo.jpeg', 'jpeg', 1000), targetFormat: 'jpg' };
    const [, size, , , , unchanged] = await answerFor(queued, 1200);
    expect(size).toBe(1000);
    expect(unchanged).toBe(true);
  });

  it('gives the server result when it is smaller', async () => {
    const [, size, , , , unchanged] = await answerFor(item('photo.jpg', 'jpg', 1000), 400);
    expect(size).toBe(400);
    expect(unchanged).toBeUndefined();
  });

  it('keeps the result when the metadata was asked to go, as the input still holds it', async () => {
    const queued = { ...item('photo.jpg', 'jpg', 1000), options: { stripMetadata: true } };
    const [, size, , , , unchanged] = await answerFor(queued, 1200);
    expect(size).toBe(1200);
    expect(unchanged).toBeUndefined();
  });

  it('keeps what a resize or a filter made, whatever its weight', async () => {
    const queued = { ...item('photo.png', 'png', 1000), options: { width: 2000 } };
    const [, size, , , , unchanged] = await answerFor(queued, 5000);
    expect(size).toBe(5000);
    expect(unchanged).toBeUndefined();
  });

  it('leaves a conversion to another format alone, whatever its size', async () => {
    const queued = { ...item('photo.png', 'png', 1000), targetFormat: 'webp' };
    const [, size, , , , unchanged] = await answerFor(queued, 5000);
    expect(size).toBe(5000);
    expect(unchanged).toBeUndefined();
  });
});
