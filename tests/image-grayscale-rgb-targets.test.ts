import { describe, it, expect } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { decodeRgba, runConvert, sampleAt, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { decodeExrWithFfmpeg, HAS_FFMPEG_EXR } from './helpers/ffmpeg-exr';

/**
 * Grayscale (1 channel) and grayscale+alpha (2 channel) sources must reach the RGB-only encoders (EPS/PS,
 * EXR, Ultra HDR, BMP) as three-channel RGB. Handing the encoders one channel per pixel shifts every
 * following pixel and produces wrong colours and a wrong data length.
 *
 * Oracles: the fixtures are 8-bit gray PNGs written by ImageMagick (colour type byte checked in the PNG
 * header); EPS/PS is read with a hex parser, EXR with FFmpeg, JPEG/BMP with ImageMagick; the expected
 * values are the gray levels the fixture was drawn with.
 */

const WIDTH = 24;
const HEIGHT = 16;
const HALF = WIDTH / 2;
const DARK = 64;
const LIGHT = 192;
const HALF_ALPHA_PERCENT = 50;
const MAX_LEVEL = 255;
/** Mid-gray flattened with 50% alpha onto white. */
const FLATTENED_DARK = Math.round((DARK * HALF_ALPHA_PERCENT + MAX_LEVEL * (100 - HALF_ALPHA_PERCENT)) / 100);
const PNG_COLOUR_TYPE_OFFSET = 25;
const PNG_GRAY = 0;
const PNG_GRAY_ALPHA = 4;
const RGB_CHANNELS = 3;
const COLOUR_TOLERANCE = 8;
const LINEAR_TOLERANCE = 0.03;
const STRICT = process.env.ORACLE_STRICT_MODE === '1';
const SKIP_EXR = !HAS_FFMPEG_EXR && !STRICT;

function buildGray(type: 'Grayscale' | 'GrayscaleAlpha'): Buffer {
  const fill = (level: number) => (type === 'Grayscale' ? `gray(${level})` : `rgba(${level},${level},${level},0.5)`);
  const half = (level: number) => ['(', '-size', `${HALF}x${HEIGHT}`, `xc:${fill(level)}`, ')'];
  const png = runConvert([
    ...half(DARK),
    ...half(LIGHT),
    '+append',
    '-type',
    type,
    '-depth',
    '8',
    'png:-',
  ]);
  const expectedType = type === 'Grayscale' ? PNG_GRAY : PNG_GRAY_ALPHA;
  expect(png[PNG_COLOUR_TYPE_OFFSET], 'fixture PNG colour type').toBe(expectedType);
  return png;
}

function parsePostscriptRgb(postscript: Buffer): { width: number; height: number; rgb: Buffer } {
  const text = postscript.toString('latin1');
  const header = /^(\d+) (\d+) 8 \[/m.exec(text);
  const dataStart = text.indexOf('colorimage\n');
  const dataEnd = text.indexOf('>', dataStart);
  if (!header || dataStart < 0 || dataEnd < 0) throw new Error('not an ASCIIHex colorimage PostScript file');
  const hex = text.slice(dataStart + 'colorimage\n'.length, dataEnd).replace(/\s+/g, '');
  return { width: Number(header[1]), height: Number(header[2]), rgb: Buffer.from(hex, 'hex') };
}

function expectGray(actual: readonly number[], level: number, label: string): void {
  actual.slice(0, RGB_CHANNELS).forEach((value, channel) => {
    expect(Math.abs(value - level), `${label} channel ${channel}: got ${value}, expected ${level}`).toBeLessThanOrEqual(
      COLOUR_TOLERANCE,
    );
  });
}

/** IEC 61966-2-1 sRGB electro-optical transfer function, written out for the oracle. */
function srgbToLinear(level: number): number {
  const v = level / MAX_LEVEL;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

const CASES = [
  ['gray', 'Grayscale', DARK, LIGHT],
  [
    'gray with half alpha',
    'GrayscaleAlpha',
    FLATTENED_DARK,
    Math.round((LIGHT * HALF_ALPHA_PERCENT + MAX_LEVEL * HALF_ALPHA_PERCENT) / 100),
  ],
] as const;

const METADATA_MODES = [
  ['metadata kept', {}],
  ['metadata stripped', { stripMetadata: true }],
] as const;

describe.each(CASES)('convertImage of a %s source', (_label, type, darkLevel, lightLevel) => {
  describe.each(METADATA_MODES)('with %s', (_mode, modeOptions) => {
    describe.each(['eps', 'ps'])('%s output', (target) => {
      it.skipIf(SKIP_WITHOUT_MAGICK)('stores three bytes per pixel with the gray levels in R, G and B', async () => {
        const result = await convertImage(buildGray(type), target, { ...modeOptions }, 'gray.png', 'png');
        const parsed = parsePostscriptRgb(result.buffer);
        expect([parsed.width, parsed.height]).toEqual([WIDTH, HEIGHT]);
        expect(parsed.rgb.length).toBe(WIDTH * HEIGHT * RGB_CHANNELS);
        const at = (x: number, y: number) => {
          const offset = (y * WIDTH + x) * RGB_CHANNELS;
          return [parsed.rgb[offset], parsed.rgb[offset + 1], parsed.rgb[offset + 2]];
        };
        expectGray(at(0, 0), darkLevel, 'left half');
        expectGray(at(WIDTH - 1, HEIGHT - 1), lightLevel, 'right half');
      });
    });

    describe.each([
      ['bmp', 'bmp'],
      ['ultrahdr', 'jpg'],
    ])('%s output', (target, extension) => {
      it.skipIf(SKIP_WITHOUT_MAGICK)('decodes to the same gray levels', async () => {
        const result = await convertImage(buildGray(type), target, { ...modeOptions, quality: 100 }, 'gray.png', 'png');
        const image = decodeRgba(result.buffer, extension);
        expect([image.width, image.height]).toEqual([WIDTH, HEIGHT]);
        expectGray(sampleAt(image, 0, 0), darkLevel, 'left half');
        expectGray(sampleAt(image, WIDTH - 1, HEIGHT - 1), lightLevel, 'right half');
      });
    });

    it.skipIf(SKIP_EXR || SKIP_WITHOUT_MAGICK)('exr output holds the linear-light gray levels', async () => {
      const result = await convertImage(buildGray(type), 'exr', { ...modeOptions }, 'gray.png', 'png');
      const exr = decodeExrWithFfmpeg(result.buffer);
      expect([exr.width, exr.height]).toEqual([WIDTH, HEIGHT]);
      const at = (x: number, y: number) => {
        const offset = (y * exr.width + x) * RGB_CHANNELS;
        return [exr.rgb[offset], exr.rgb[offset + 1], exr.rgb[offset + 2]];
      };
      at(0, 0).forEach((value, channel) => {
        expect(Math.abs(value - srgbToLinear(darkLevel)), `left channel ${channel}: ${value}`).toBeLessThanOrEqual(
          LINEAR_TOLERANCE,
        );
      });
      at(WIDTH - 1, HEIGHT - 1).forEach((value, channel) => {
        expect(Math.abs(value - srgbToLinear(lightLevel)), `right channel ${channel}: ${value}`).toBeLessThanOrEqual(
          LINEAR_TOLERANCE,
        );
      });
    });
  });
});
