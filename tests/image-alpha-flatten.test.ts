import { describe, it, expect } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { captureError } from './helpers/capture-error';
import { decodeRgba, runConvert, sampleAt, SKIP_WITHOUT_MAGICK, type DecodedRgba, type Rgb } from './helpers/imagemagick';
import { decodeExrWithFfmpeg, HAS_FFMPEG_EXR } from './helpers/ffmpeg-exr';

/**
 * Transparent pixels must be flattened onto white (or the requested `background`) for targets that cannot
 * hold alpha, and `fit: 'contain'` must letterbox opaque targets with that colour, never with black.
 *
 * Oracles: the RGBA source is written by ImageMagick; JPEG/BMP/UltraHDR output is decoded with ImageMagick,
 * EPS/PS output with the hex parser below (PostScript Level 2 `colorimage` with ASCIIHexDecode), and EXR
 * output with FFmpeg's `exr` decoder.
 */

const SOURCE_WIDTH = 24;
const SOURCE_HEIGHT = 16;
const BLOCK_SIZE = 8;
const WHITE: Rgb = [255, 255, 255];
const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const GREEN: Rgb = [0, 255, 0];
const RED_HEX = '#ff0000';
/** JPEG chroma subsampling and quantisation move flat colours by a few levels. */
const COLOUR_TOLERANCE = 8;
const OPAQUE = 255;
const TRANSPARENT = 0;
const RGB_CHANNELS = 3;
const HEX_DIGITS_PER_BYTE = 2;
/** Linear-light tolerance for EXR samples (sRGB 8-bit input, half-float storage). */
const LINEAR_TOLERANCE = 0.03;
const STRICT = process.env.ORACLE_STRICT_MODE === '1';
const SKIP_EXR = !HAS_FFMPEG_EXR && !STRICT;

/** Transparent canvas (underlying RGB black) with one opaque blue block in the bottom-right corner. */
function buildTransparentSource(): Buffer {
  const right = SOURCE_WIDTH - 1;
  const bottom = SOURCE_HEIGHT - 1;
  return runConvert([
    '-size',
    `${SOURCE_WIDTH}x${SOURCE_HEIGHT}`,
    'xc:none',
    '-fill',
    'rgb(0,0,255)',
    '-draw',
    `rectangle ${right - BLOCK_SIZE + 1},${bottom - BLOCK_SIZE + 1} ${right},${bottom}`,
    'png32:-',
  ]);
}

/** Opaque green 20x10 picture: contained in a square it leaves letterbox bars above and below. */
function buildWideOpaqueSource(): Buffer {
  return runConvert(['-size', '20x10', 'xc:rgb(0,255,0)', 'png24:-']);
}

function expectNear(actual: readonly number[], expected: Rgb, label: string): void {
  expected.forEach((value, channel) => {
    expect(Math.abs(actual[channel] - value), `${label} channel ${channel}: got ${actual[channel]}, expected ${value}`)
      .toBeLessThanOrEqual(COLOUR_TOLERANCE);
  });
}

function topLeft(image: DecodedRgba): readonly number[] {
  return sampleAt(image, 0, 0);
}

function bottomRight(image: DecodedRgba): readonly number[] {
  return sampleAt(image, image.width - 1, image.height - 1);
}

/** Decodes the RGB bytes of a PostScript Level 2 `colorimage` with an ASCIIHexDecode data source. */
function parsePostscriptRgb(postscript: Buffer): { width: number; height: number; rgb: Buffer } {
  const text = postscript.toString('latin1');
  const header = /^(\d+) (\d+) 8 \[/m.exec(text);
  const dataStart = text.indexOf('colorimage\n');
  const dataEnd = text.indexOf('>', dataStart);
  if (!header || dataStart < 0 || dataEnd < 0) throw new Error('not an ASCIIHex colorimage PostScript file');
  const hex = text.slice(dataStart + 'colorimage\n'.length, dataEnd).replace(/\s+/g, '');
  const rgb = Buffer.from(hex, 'hex');
  expect(hex.length, 'hex digits').toBe(rgb.length * HEX_DIGITS_PER_BYTE);
  return { width: Number(header[1]), height: Number(header[2]), rgb };
}

function rgbAt(parsed: { width: number; rgb: Buffer }, x: number, y: number): number[] {
  const offset = (y * parsed.width + x) * RGB_CHANNELS;
  return [parsed.rgb[offset], parsed.rgb[offset + 1], parsed.rgb[offset + 2]];
}

describe('convertImage flattens transparency for opaque targets', () => {
  describe.each([
    ['jpg', 'jpg'],
    ['bmp', 'bmp'],
    ['ultrahdr', 'jpg'],
  ])('%s output', (target, extension) => {
    it.skipIf(SKIP_WITHOUT_MAGICK)('turns transparent pixels white and keeps opaque ones', async () => {
      const result = await convertImage(buildTransparentSource(), target, { quality: 100 }, 'alpha.png', 'png');
      const image = decodeRgba(result.buffer, extension);
      expect([image.width, image.height]).toEqual([SOURCE_WIDTH, SOURCE_HEIGHT]);
      expectNear(topLeft(image), WHITE, 'transparent corner');
      expectNear(bottomRight(image), BLUE, 'opaque corner');
    });

    it.skipIf(SKIP_WITHOUT_MAGICK)('flattens onto the requested background', async () => {
      const result = await convertImage(
        buildTransparentSource(),
        target,
        { quality: 100, background: RED_HEX },
        'alpha.png',
        'png'
      );
      const image = decodeRgba(result.buffer, extension);
      expectNear(topLeft(image), RED, 'transparent corner');
      expectNear(bottomRight(image), BLUE, 'opaque corner');
    });
  });

  describe.each(['eps', 'ps'])('%s output', (target) => {
    it.skipIf(SKIP_WITHOUT_MAGICK)('turns transparent pixels white and keeps opaque ones', async () => {
      const result = await convertImage(buildTransparentSource(), target, {}, 'alpha.png', 'png');
      const parsed = parsePostscriptRgb(result.buffer);
      expect([parsed.width, parsed.height]).toEqual([SOURCE_WIDTH, SOURCE_HEIGHT]);
      expectNear(rgbAt(parsed, 0, 0), WHITE, 'transparent corner');
      expectNear(rgbAt(parsed, parsed.width - 1, parsed.height - 1), BLUE, 'opaque corner');
    });

    it.skipIf(SKIP_WITHOUT_MAGICK)('flattens onto the requested background', async () => {
      const result = await convertImage(buildTransparentSource(), target, { background: RED_HEX }, 'alpha.png', 'png');
      expectNear(rgbAt(parsePostscriptRgb(result.buffer), 0, 0), RED, 'transparent corner');
    });
  });

  describe('exr output', () => {
    it.skipIf(SKIP_EXR || SKIP_WITHOUT_MAGICK)('stores linear white for transparent pixels', async () => {
      const result = await convertImage(buildTransparentSource(), 'exr', {}, 'alpha.png', 'png');
      const exr = decodeExrWithFfmpeg(result.buffer);
      expect([exr.width, exr.height]).toEqual([SOURCE_WIDTH, SOURCE_HEIGHT]);
      const at = (x: number, y: number) => {
        const offset = (y * exr.width + x) * RGB_CHANNELS;
        return [exr.rgb[offset], exr.rgb[offset + 1], exr.rgb[offset + 2]];
      };
      at(0, 0).forEach((value, channel) => {
        expect(Math.abs(value - 1), `transparent corner channel ${channel}: ${value}`).toBeLessThanOrEqual(LINEAR_TOLERANCE);
      });
      const opaque = at(exr.width - 1, exr.height - 1);
      expect([opaque[0], opaque[1]].every((value) => value <= LINEAR_TOLERANCE)).toBe(true);
      expect(Math.abs(opaque[2] - 1)).toBeLessThanOrEqual(LINEAR_TOLERANCE);
    });
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('keeps transparency for targets that can hold alpha', async () => {
    const result = await convertImage(buildTransparentSource(), 'png', {}, 'alpha.png', 'png');
    const image = decodeRgba(result.buffer, 'png');
    expect(topLeft(image)[3]).toBe(TRANSPARENT);
    expect(bottomRight(image)).toEqual([...BLUE, OPAQUE]);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('rejects a background that is not a #rgb or #rrggbb colour', async () => {
    for (const background of ['red', '#12', '#gggggg', '']) {
      const error = await captureError(() =>
        convertImage(buildTransparentSource(), 'jpg', { background }, 'alpha.png', 'png')
      );
      expect(error.name, `background ${JSON.stringify(background)}`).toBe('UnsupportedOptionError');
      expect(error.message).toContain(`Unsupported background ${JSON.stringify(background)}`);
    }
  });
});

describe('convertImage letterboxes fit: contain', () => {
  const squareBox = { width: 20, height: 20, fit: 'contain' as const };
  const BAR_Y = 1;
  const CENTRE = 10;

  describe.each([
    ['jpg', 'jpg'],
    ['bmp', 'bmp'],
  ])('%s output (opaque target)', (target, extension) => {
    it.skipIf(SKIP_WITHOUT_MAGICK)('fills the bars with white by default, not black', async () => {
      const result = await convertImage(buildWideOpaqueSource(), target, { ...squareBox, quality: 100 }, 'wide.png', 'png');
      const image = decodeRgba(result.buffer, extension);
      expect([image.width, image.height]).toEqual([20, 20]);
      expectNear(sampleAt(image, CENTRE, BAR_Y), WHITE, 'top bar');
      expectNear(sampleAt(image, CENTRE, image.height - 1 - BAR_Y), WHITE, 'bottom bar');
      expectNear(sampleAt(image, CENTRE, CENTRE), GREEN, 'picture');
    });

    it.skipIf(SKIP_WITHOUT_MAGICK)('fills the bars with the requested background', async () => {
      const result = await convertImage(
        buildWideOpaqueSource(),
        target,
        { ...squareBox, quality: 100, background: RED_HEX },
        'wide.png',
        'png'
      );
      const image = decodeRgba(result.buffer, extension);
      expectNear(sampleAt(image, CENTRE, BAR_Y), RED, 'top bar');
      expectNear(sampleAt(image, CENTRE, CENTRE), GREEN, 'picture');
    });
  });

  describe('png output (alpha-capable target)', () => {
    it.skipIf(SKIP_WITHOUT_MAGICK)('keeps the bars transparent by default', async () => {
      const result = await convertImage(buildWideOpaqueSource(), 'png', squareBox, 'wide.png', 'png');
      const image = decodeRgba(result.buffer, 'png');
      expect(sampleAt(image, CENTRE, BAR_Y)[3]).toBe(TRANSPARENT);
      expect(sampleAt(image, CENTRE, CENTRE)).toEqual([...GREEN, OPAQUE]);
    });

    it.skipIf(SKIP_WITHOUT_MAGICK)('paints the bars with an explicitly requested background', async () => {
      const result = await convertImage(
        buildWideOpaqueSource(),
        'png',
        { ...squareBox, background: RED_HEX },
        'wide.png',
        'png'
      );
      expect(sampleAt(decodeRgba(result.buffer, 'png'), CENTRE, BAR_Y)).toEqual([...RED, OPAQUE]);
    });
  });
});
