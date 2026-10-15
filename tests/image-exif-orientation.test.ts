import { describe, it, expect } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import {
  decodeRgba,
  runConvert,
  runIdentify,
  sampleAt,
  withTempImage,
  SKIP_WITHOUT_MAGICK,
  type DecodedRgba,
  type Rgb,
} from './helpers/imagemagick';
import { injectExifOrientation, readExifOrientation, ORIENTATION_VALUES } from './helpers/exif-orientation';

/**
 * EXIF Orientation 1-8 must be applied to the pixels before any resize, and no stale Orientation tag may
 * survive in the output (it would make viewers rotate an already upright image a second time).
 *
 * Oracles: the fixtures are a JPEG written by ImageMagick plus a hand-built EXIF APP1 block; the expected
 * result is `magick -auto-orient` of the same file, cross-checked against the corner table below, which
 * is derived from the EXIF orientation definitions (not from any decoder).
 */

const STORED_WIDTH = 30;
const STORED_HEIGHT = 20;
const MARKER_WIDTH = 8;
const MARKER_HEIGHT = 6;
const CORNER_INSET = 2;
/** JPEG quantisation and decoder rounding move flat colours by a few levels. */
const COLOUR_TOLERANCE = 12;
const SWAPPING_ORIENTATIONS = new Set([5, 6, 7, 8]);
const NO_ORIENTATION_OR_NORMAL = [undefined, 1];

const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];
const YELLOW: Rgb = [255, 255, 0];

type Corners = readonly [Rgb, Rgb, Rgb, Rgb]; // top-left, top-right, bottom-right, bottom-left

/** Stored corners are red, green, yellow, blue; each row is where the viewer sees them after orienting. */
const EXPECTED_CORNERS: Record<number, Corners> = {
  1: [RED, GREEN, YELLOW, BLUE],
  2: [GREEN, RED, BLUE, YELLOW],
  3: [YELLOW, BLUE, RED, GREEN],
  4: [BLUE, YELLOW, GREEN, RED],
  5: [RED, BLUE, YELLOW, GREEN],
  6: [BLUE, RED, GREEN, YELLOW],
  7: [YELLOW, GREEN, RED, BLUE],
  8: [GREEN, YELLOW, BLUE, RED],
};

function buildBaseJpeg(): Buffer {
  const lastX = STORED_WIDTH - 1;
  const lastY = STORED_HEIGHT - 1;
  const box = (x: number, y: number, colour: string) => [
    '-fill',
    colour,
    '-draw',
    `rectangle ${x},${y} ${x + MARKER_WIDTH - 1},${y + MARKER_HEIGHT - 1}`,
  ];
  return runConvert([
    '-size',
    `${STORED_WIDTH}x${STORED_HEIGHT}`,
    'xc:white',
    ...box(0, 0, 'rgb(255,0,0)'),
    ...box(lastX - MARKER_WIDTH + 1, 0, 'rgb(0,255,0)'),
    ...box(lastX - MARKER_WIDTH + 1, lastY - MARKER_HEIGHT + 1, 'rgb(255,255,0)'),
    ...box(0, lastY - MARKER_HEIGHT + 1, 'rgb(0,0,255)'),
    '-sampling-factor',
    '1x1',
    '-quality',
    '100',
    'jpg:-',
  ]);
}

function cornerSamples(image: DecodedRgba): Rgb[] {
  const right = image.width - 1 - CORNER_INSET;
  const bottom = image.height - 1 - CORNER_INSET;
  return [
    sampleAt(image, CORNER_INSET, CORNER_INSET),
    sampleAt(image, right, CORNER_INSET),
    sampleAt(image, right, bottom),
    sampleAt(image, CORNER_INSET, bottom),
  ].map(([r, g, b]) => [r, g, b] as const);
}

function expectColourNear(actual: Rgb, expected: Rgb, label: string): void {
  actual.forEach((value, channel) => {
    expect(Math.abs(value - expected[channel]), `${label} channel ${channel}: got ${value}, expected ${expected[channel]}`)
      .toBeLessThanOrEqual(COLOUR_TOLERANCE);
  });
}

function fixtureFor(orientation: number): Buffer {
  return injectExifOrientation(buildBaseJpeg(), orientation);
}

function referenceAutoOrient(fixture: Buffer): DecodedRgba {
  const oriented = withTempImage(fixture, 'jpg', (file) => runConvert([file, '-auto-orient', 'png:-']));
  return decodeRgba(oriented, 'png');
}

describe('EXIF orientation fixtures', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK).each(ORIENTATION_VALUES)(
    'fixture for orientation %i carries that tag and decodes to the stored size',
    (orientation) => {
      const fixture = fixtureFor(orientation);
      expect(readExifOrientation(fixture)).toBe(orientation);
      const identified = withTempImage(fixture, 'jpg', (file) => runIdentify(['-format', '%wx%h', file]));
      expect(identified).toBe(`${STORED_WIDTH}x${STORED_HEIGHT}`);
    }
  );
});

describe('convertImage applies EXIF orientation', () => {
  describe.each([
    ['with metadata stripped', { stripMetadata: true }],
    ['with metadata kept', {}],
  ])('%s', (_label, options) => {
    it.skipIf(SKIP_WITHOUT_MAGICK).each(ORIENTATION_VALUES)(
      'orientation %i yields the magick -auto-orient pixels, size and corner colours',
      async (orientation) => {
        const fixture = fixtureFor(orientation);
        const reference = referenceAutoOrient(fixture);
        const expectedWidth = SWAPPING_ORIENTATIONS.has(orientation) ? STORED_HEIGHT : STORED_WIDTH;
        const expectedHeight = SWAPPING_ORIENTATIONS.has(orientation) ? STORED_WIDTH : STORED_HEIGHT;
        expect([reference.width, reference.height], 'oracle size').toEqual([expectedWidth, expectedHeight]);

        const result = await convertImage(fixture, 'png', options, 'oriented.jpg', 'jpg');
        const actual = decodeRgba(result.buffer, 'png');

        expect([actual.width, actual.height]).toEqual([expectedWidth, expectedHeight]);
        const actualCorners = cornerSamples(actual);
        const referenceCorners = cornerSamples(reference);
        EXPECTED_CORNERS[orientation].forEach((expected, index) => {
          expectColourNear(actualCorners[index], expected, `orientation ${orientation} corner ${index} vs table`);
          expectColourNear(actualCorners[index], referenceCorners[index], `orientation ${orientation} corner ${index} vs magick`);
        });
        // Whatever the pixels say, no leftover tag may ask a viewer to rotate them again.
        expect(NO_ORIENTATION_OR_NORMAL).toContain(readExifOrientation(result.buffer));
      }
    );
  });

  it.skipIf(SKIP_WITHOUT_MAGICK).each(['jpg', 'webp'])(
    'leaves no rotating Orientation tag in %s output when metadata is kept',
    async (target) => {
      const orientation = 6;
      const result = await convertImage(fixtureFor(orientation), target, {}, 'oriented.jpg', 'jpg');
      expect(NO_ORIENTATION_OR_NORMAL).toContain(readExifOrientation(result.buffer));
      const actual = decodeRgba(result.buffer, target);
      expect([actual.width, actual.height]).toEqual([STORED_HEIGHT, STORED_WIDTH]);
      const corners = cornerSamples(actual);
      EXPECTED_CORNERS[orientation].forEach((expected, index) => {
        expectColourNear(corners[index], expected, `${target} corner ${index}`);
      });
    }
  );

  it.skipIf(SKIP_WITHOUT_MAGICK)('sizes a width-only resize from the oriented dimensions', async () => {
    const fixture = fixtureFor(6);
    const targetWidth = 10;
    const reference = decodeRgba(
      withTempImage(fixture, 'jpg', (file) => runConvert([file, '-auto-orient', '-resize', `${targetWidth}x`, 'png:-'])),
      'png'
    );
    const result = await convertImage(fixture, 'png', { stripMetadata: true, width: targetWidth }, 'oriented.jpg', 'jpg');
    const actual = decodeRgba(result.buffer, 'png');
    // The oriented image is 20x30, so width 10 gives height 15; the stored 30x20 would give 7.
    expect([actual.width, actual.height]).toEqual([reference.width, reference.height]);
    expect([actual.width, actual.height]).toEqual([targetWidth, 15]);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('fits a rotated image inside a box using the oriented dimensions', async () => {
    const fixture = fixtureFor(8);
    const box = 12;
    const reference = decodeRgba(
      withTempImage(fixture, 'jpg', (file) => runConvert([file, '-auto-orient', '-resize', `${box}x${box}`, 'png:-'])),
      'png'
    );
    const result = await convertImage(
      fixture,
      'png',
      { stripMetadata: true, width: box, height: box, fit: 'inside' },
      'oriented.jpg',
      'jpg'
    );
    const actual = decodeRgba(result.buffer, 'png');
    expect([actual.width, actual.height]).toEqual([reference.width, reference.height]);
    // Oriented 20x30 inside 12x12 is 8x12 (portrait); the stored 30x20 would give landscape 12x8.
    expect([actual.width, actual.height]).toEqual([8, 12]);
  });
});
