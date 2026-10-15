import { describe, it, expect } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { COLOUR_TYPE, encodePng, type PngImage } from './helpers/apng-builder';
import { decodeRgba, sampleAt, SKIP_WITHOUT_MAGICK, type Rgb } from './helpers/imagemagick';

/**
 * Grayscale (1 band) and gray+alpha (2 band) sources must be flattened and letterboxed with the whole
 * background colour. libvips takes only the first component of a background for 1 and 2 band images, which
 * turned `background: "#00ff00"` into black bars and a wrong flatten colour unless the image is converted to
 * sRGB first.
 *
 * Oracles: the sources are written byte by byte with the hand-built PNG writer (colour types 0 and 4); the
 * output is decoded with ImageMagick; the expected values are computed from the source-over formula
 * out = (source * alpha + background * (255 - alpha)) / 255.
 */

const WIDTH = 20;
const HEIGHT = 10;
const BOX = 20;
const GRAY_LEVEL = 128;
const OPAQUE = 255;
const LOW_ALPHA = 99; // 39% of 255
/** 24-bit BMP carries the flattened samples exactly; a lossy JPEG moves them a few levels. */
const BMP_TOLERANCE = 1;
const JPEG_TOLERANCE = 8;

const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];
const BACKGROUNDS: ReadonlyArray<readonly [string, string, Rgb]> = [
  ['red', '#ff0000', RED],
  ['green', '#00ff00', GREEN],
  ['blue', '#0000ff', BLUE],
  ['short hex orange', '#f80', [255, 136, 0]],
];

function grayAlpha(levelAndAlpha: (x: number) => readonly [number, number]): PngImage {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 2);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) pixels.set(levelAndAlpha(x), (y * WIDTH + x) * 2);
  }
  return { width: WIDTH, height: HEIGHT, colourType: COLOUR_TYPE.grayAlpha, bitDepth: 8, pixels };
}

function gray(level: number): PngImage {
  return { width: WIDTH, height: HEIGHT, colourType: COLOUR_TYPE.gray, bitDepth: 8, pixels: Buffer.alloc(WIDTH * HEIGHT, level) };
}

/** Left half fully transparent, right half 39% opaque gray. */
const transparentThenFaint = () => encodePng(grayAlpha((x) => (x < WIDTH / 2 ? [0, 0] : [GRAY_LEVEL, LOW_ALPHA])));

function over(level: number, alpha: number, background: number): number {
  return (level * alpha + background * (OPAQUE - alpha)) / OPAQUE;
}

function expectNear(actual: readonly number[], expected: readonly number[], tolerance: number, label: string): void {
  expected.forEach((value, channel) => {
    expect(Math.abs(actual[channel] - value), `${label} channel ${channel}: got ${actual[channel]}, expected ${value}`).toBeLessThanOrEqual(
      tolerance
    );
  });
}

describe('a gray+alpha source flattened onto a requested background', () => {
  describe.each(BACKGROUNDS)('%s background', (_name, hex, colour) => {
    it.skipIf(SKIP_WITHOUT_MAGICK)('bmp: transparent pixels take the whole colour, faint pixels blend per channel', async () => {
      const result = await convertImage(transparentThenFaint(), 'bmp', { background: hex }, 'ga.png', 'png');
      const image = decodeRgba(result.buffer, 'bmp');
      expectNear(sampleAt(image, 2, 2), colour, BMP_TOLERANCE, 'transparent half');
      expectNear(
        sampleAt(image, WIDTH - 3, 2),
        colour.map((channel) => over(GRAY_LEVEL, LOW_ALPHA, channel)),
        BMP_TOLERANCE,
        'faint half'
      );
    });

    it.skipIf(SKIP_WITHOUT_MAGICK)('jpg: the same colours within lossy tolerance', async () => {
      const result = await convertImage(transparentThenFaint(), 'jpg', { background: hex, quality: 100 }, 'ga.png', 'png');
      const image = decodeRgba(result.buffer, 'jpg');
      expectNear(sampleAt(image, 2, 2), colour, JPEG_TOLERANCE, 'transparent half');
    });
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('39% alpha gray over blue is (50, 50, 206)', async () => {
    const result = await convertImage(transparentThenFaint(), 'bmp', { background: '#0000ff' }, 'ga.png', 'png');
    expectNear(sampleAt(decodeRgba(result.buffer, 'bmp'), WIDTH - 3, 2), [50, 50, 206], BMP_TOLERANCE, 'faint half');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('defaults to white for an opaque target', async () => {
    const result = await convertImage(transparentThenFaint(), 'bmp', {}, 'ga.png', 'png');
    const image = decodeRgba(result.buffer, 'bmp');
    expectNear(sampleAt(image, 2, 2), [255, 255, 255], BMP_TOLERANCE, 'transparent half');
    expectNear(sampleAt(image, WIDTH - 3, 2), [over(GRAY_LEVEL, LOW_ALPHA, OPAQUE), over(GRAY_LEVEL, LOW_ALPHA, OPAQUE), over(GRAY_LEVEL, LOW_ALPHA, OPAQUE)], BMP_TOLERANCE, 'faint half');
  });
});

describe('letterbox bars of a gray source', () => {
  const squareBox = { width: BOX, height: BOX, fit: 'contain' as const };

  describe.each(BACKGROUNDS)('%s background', (_name, hex, colour) => {
    it.skipIf(SKIP_WITHOUT_MAGICK)('bmp: the bars are the whole colour and the picture stays gray', async () => {
      const result = await convertImage(encodePng(gray(GRAY_LEVEL)), 'bmp', { ...squareBox, background: hex }, 'g.png', 'png');
      const image = decodeRgba(result.buffer, 'bmp');
      expect([image.width, image.height]).toEqual([BOX, BOX]);
      expectNear(sampleAt(image, 10, 1), colour, BMP_TOLERANCE, 'top bar');
      expectNear(sampleAt(image, 10, BOX - 2), colour, BMP_TOLERANCE, 'bottom bar');
      expectNear(sampleAt(image, 10, 10), [GRAY_LEVEL, GRAY_LEVEL, GRAY_LEVEL], BMP_TOLERANCE, 'picture');
    });

    it.skipIf(SKIP_WITHOUT_MAGICK)('png: the bars are the opaque colour', async () => {
      const result = await convertImage(encodePng(gray(GRAY_LEVEL)), 'png', { ...squareBox, background: hex }, 'g.png', 'png');
      const image = decodeRgba(result.buffer, 'png');
      expect(sampleAt(image, 10, 1)).toEqual([...colour, OPAQUE]);
      expectNear(sampleAt(image, 10, 10), [GRAY_LEVEL, GRAY_LEVEL, GRAY_LEVEL], BMP_TOLERANCE, 'picture');
    });
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('gray+alpha source: bars are the colour, transparent pixels inside the picture too', async () => {
    const result = await convertImage(transparentThenFaint(), 'bmp', { ...squareBox, background: '#00ff00' }, 'ga.png', 'png');
    const image = decodeRgba(result.buffer, 'bmp');
    expectNear(sampleAt(image, 10, 1), GREEN, BMP_TOLERANCE, 'bar');
    expectNear(sampleAt(image, 2, 10), GREEN, BMP_TOLERANCE, 'transparent half inside the picture');
  });
});
