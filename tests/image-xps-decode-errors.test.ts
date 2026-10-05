import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { convertImage } from '../src/lib/conversions/image';
import { captureError } from './helpers/capture-error';
import { decodeRgba, runConvert, sampleAt, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { injectExifOrientation } from './helpers/exif-orientation';

/**
 * XPS output must embed the real decoded picture (oriented, resized, true size) and must fail with a typed
 * error when the input cannot be decoded: it may never return the raw input labelled as PNG with an
 * invented size.
 *
 * Oracles: the package is opened with JSZip and its image part decoded with ImageMagick; fixtures come from
 * ImageMagick plus the hand-built EXIF block.
 */

const IMAGE_PART = 'Documents/1/Resources/Images/image1.png';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STORED_WIDTH = 30;
const STORED_HEIGHT = 20;
const COLOUR_TOLERANCE = 12;

async function embeddedImage(xps: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(xps);
  const part = zip.file(IMAGE_PART);
  if (!part) throw new Error(`XPS package has no ${IMAGE_PART}: ${Object.keys(zip.files).join(', ')}`);
  return part.async('nodebuffer');
}

function buildMarkedJpeg(): Buffer {
  return runConvert([
    '-size',
    `${STORED_WIDTH}x${STORED_HEIGHT}`,
    'xc:rgb(0,255,0)',
    '-fill',
    'rgb(255,0,0)',
    '-draw',
    'rectangle 0,0 7,5',
    '-sampling-factor',
    '1x1',
    '-quality',
    '100',
    'jpg:-',
  ]);
}

describe('convertImage to xps', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('embeds the oriented picture at its real size', async () => {
    const rotatedQuarterTurn = 6;
    const source = injectExifOrientation(buildMarkedJpeg(), rotatedQuarterTurn);
    const result = await convertImage(source, 'xps', {}, 'photo.jpg', 'jpg');
    const embedded = await embeddedImage(result.buffer);
    expect(embedded.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
    const image = decodeRgba(embedded, 'png');
    // Orientation 6 displays the stored picture turned a quarter clockwise: 20x30, red marker top-right.
    expect([image.width, image.height]).toEqual([STORED_HEIGHT, STORED_WIDTH]);
    const [r, g, b] = sampleAt(image, image.width - 2, 2);
    expect(Math.abs(r - 255)).toBeLessThanOrEqual(COLOUR_TOLERANCE);
    expect(g).toBeLessThanOrEqual(COLOUR_TOLERANCE);
    expect(b).toBeLessThanOrEqual(COLOUR_TOLERANCE);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('applies the requested resize to the embedded picture', async () => {
    const width = 15;
    const result = await convertImage(buildMarkedJpeg(), 'xps', { width, height: 10, fit: 'fill' }, 'photo.jpg', 'jpg');
    const image = decodeRgba(await embeddedImage(result.buffer), 'png');
    expect([image.width, image.height]).toEqual([width, 10]);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('embeds a valid PNG source with its own dimensions', async () => {
    const png = runConvert(['-size', '41x23', 'xc:rgb(0,0,255)', 'png24:-']);
    const result = await convertImage(png, 'xps', {}, 'blue.png', 'png');
    const image = decodeRgba(await embeddedImage(result.buffer), 'png');
    expect([image.width, image.height]).toEqual([41, 23]);
    expect(sampleAt(image, 20, 11)).toEqual([0, 0, 255, 255]);
  });

  describe.each([
    ['metadata kept', {}],
    ['metadata stripped', { stripMetadata: true }],
  ])('undecodable input with %s', (_label, options) => {
    const garbage = Buffer.from('this is not an image, it is text that no decoder can read', 'utf-8');
    const truncatedPng = (): Buffer => runConvert(['-size', '8x8', 'xc:red', 'png24:-']).subarray(0, 40);

    it('rejects text with a typed ConversionFailedError', async () => {
      const error = await captureError(() => convertImage(garbage, 'xps', options, 'bad.png', 'png'));
      expect(error.name).toBe('ConversionFailedError');
      expect(error.message).toMatch(/^Unable to decode the image: .*unsupported image format/);
    });

    it.skipIf(SKIP_WITHOUT_MAGICK)('rejects a truncated PNG with a typed ConversionFailedError', async () => {
      const error = await captureError(() => convertImage(truncatedPng(), 'xps', options, 'cut.png', 'png'));
      expect(error.name).toBe('ConversionFailedError');
      expect(error.message).toMatch(/^Unable to decode the image: /);
    });
  });
});
