import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { pngQualityAsPalette } from '../src/lib/conversions/png-quality-palette';

/**
 * A PNG has no quality of its own: the quality of a PNG to PNG conversion is the size of the palette the picture is written with
 * (256 colours from quality 80, then in proportion to the square of the quality, as the compress page asks for it). The mapping is the
 * server's, so a call of the API gets the same answer as the page. A request that names the palette itself is not second-guessed.
 * Oracle: the picture's own palette, read back by the image library.
 */

const SIDE = 192;
let noisy: Buffer;

beforeAll(async () => {
  const { data, info } = await sharp({ create: { width: SIDE, height: SIDE, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 70 } } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  noisy = await sharp(data, { raw: info }).png().toBuffer();
});

/** The number of distinct colours of the picture, read from its decoded samples. */
async function distinctColours(png: Buffer): Promise<number> {
  const samples = await sharp(png).removeAlpha().raw().toBuffer();
  const seen = new Set<number>();
  for (let at = 0; at < samples.length; at += 3) seen.add((samples[at] << 16) | (samples[at + 1] << 8) | samples[at + 2]);
  return seen.size;
}

describe('PNG to PNG with a quality', () => {
  it('is written with the palette the quality asks for, smaller than the picture it came from', async () => {
    const out = await convertFile(noisy, 'png', 'png', { quality: 20 }, 'noise.png');
    // Quality 20 is 16 colours; the picture it came from holds tens of thousands.
    expect(await distinctColours(noisy)).toBeGreaterThan(10_000);
    expect(await distinctColours(out.buffer)).toBeLessThanOrEqual(16);
    expect(out.buffer.length).toBeLessThan(noisy.length);
  });

  it('is the same file as the one the palette options ask for', async () => {
    const byQuality = await convertFile(noisy, 'png', 'png', { quality: 60 }, 'noise.png');
    const byPalette = await convertFile(noisy, 'png', 'png', { palette: true, colors: 144 }, 'noise.png');
    expect(byQuality.buffer.equals(byPalette.buffer)).toBe(true);
  });

  it('keeps a palette the request names, whatever the quality says', async () => {
    const named = await convertFile(noisy, 'png', 'png', { quality: 10, palette: true, colors: 200 }, 'noise.png');
    const alone = await convertFile(noisy, 'png', 'png', { palette: true, colors: 200 }, 'noise.png');
    expect(named.buffer.equals(alone.buffer)).toBe(true);
  });
});

describe('the options of the other conversions', () => {
  it('are left as they are', () => {
    const jpg = { quality: 60 };
    expect(pngQualityAsPalette('jpg', 'jpg', jpg)).toBe(jpg);
    expect(pngQualityAsPalette('png', 'jpg', jpg)).toBe(jpg);
    const none = {};
    expect(pngQualityAsPalette('png', 'png', none)).toBe(none);
    const colours = { quality: 50, colors: 32 };
    expect(pngQualityAsPalette('png', 'png', colours)).toBe(colours);
  });

  it('become the palette for a PNG quality', () => {
    expect(pngQualityAsPalette('png', 'png', { quality: 40, stripMetadata: true })).toEqual({ stripMetadata: true, palette: true, colors: 64 });
    expect(pngQualityAsPalette('PNG', 'png', { quality: 95 })).toEqual({ palette: true, colors: 256 });
  });
});
