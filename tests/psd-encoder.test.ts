import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertImage } from '../src/lib/conversions';
import { ConversionFailedError } from '../src/lib/types';
import { decodeRgba, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

/**
 * A PSD is the Photoshop file format, not a PNG behind a PSD header. The expected pixels are the ones written into
 * the source picture; ImageMagick (a separate PSD reader) decodes the file, and the layout is read byte by byte
 * from the published Adobe Photoshop File Format sections.
 */

const WIDTH = 41;
const HEIGHT = 23;
const CHANNELS = 4;
const PSD_HEADER_BYTES = 26;
const PSD_SECTION_LENGTH_BYTES = 4;
const PSD_RLE = 1;
const MAX_SIDE = 30_000;

/** Flat bands (long runs), a gradient and noise (literals), with a varying alpha channel. */
function sourcePixels(): Buffer {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * CHANNELS);
  let seed = 12345;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * CHANNELS;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if (y < 8) {
        pixels.set([200, 30, 30, 255], i);
      } else if (y < 16) {
        pixels.set([x * 6, y * 10, 255 - x * 6, 255], i);
      } else {
        pixels.set([seed & 255, (seed >> 8) & 255, (seed >> 16) & 255, 128 + (x % 100)], i);
      }
    }
  }
  return pixels;
}

/** PackBits decoding as the PSD format describes it: a count byte n, then n + 1 literals or 1 - n copies of one byte. */
function unpackBits(packed: Buffer): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < packed.length) {
    const count = packed.readInt8(i);
    i += 1;
    if (count >= 0) {
      out.push(...packed.subarray(i, i + count + 1));
      i += count + 1;
    } else if (count !== -128) {
      out.push(...new Array<number>(1 - count).fill(packed[i]));
      i += 1;
    }
  }
  return out;
}

async function sourcePng(): Promise<Buffer> {
  return sharp(sourcePixels(), { raw: { width: WIDTH, height: HEIGHT, channels: CHANNELS } }).png().toBuffer();
}

describe('PSD output', () => {
  it('is laid out as the Photoshop file format says: header, empty sections, PackBits image data', async () => {
    const { buffer } = await convertImage(await sourcePng(), 'psd', {}, 'picture.png', 'png');
    expect(buffer.toString('ascii', 0, 4)).toBe('8BPS');
    expect(buffer.readUInt16BE(4)).toBe(1);
    expect(buffer.readUInt16BE(12)).toBe(CHANNELS);
    expect(buffer.readUInt32BE(14)).toBe(HEIGHT);
    expect(buffer.readUInt32BE(18)).toBe(WIDTH);
    expect(buffer.readUInt16BE(22)).toBe(8);
    expect(buffer.readUInt16BE(24)).toBe(3);
    // Color mode data, image resources and layer and mask information: three empty sections.
    expect([...buffer.subarray(PSD_HEADER_BYTES, PSD_HEADER_BYTES + 3 * PSD_SECTION_LENGTH_BYTES)]).toEqual(new Array(12).fill(0));
    const imageData = PSD_HEADER_BYTES + 3 * PSD_SECTION_LENGTH_BYTES;
    expect(buffer.readUInt16BE(imageData)).toBe(PSD_RLE);
    // The row table lists one byte count per row and channel; the packed rows fill the rest of the file exactly.
    const rowCount = CHANNELS * HEIGHT;
    let packed = 0;
    for (let row = 0; row < rowCount; row += 1) packed += buffer.readUInt16BE(imageData + 2 + row * 2);
    expect(imageData + 2 + rowCount * 2 + packed).toBe(buffer.length);
  });

  it('stores the exact pixels of the source picture in its four planes', async () => {
    const { buffer } = await convertImage(await sourcePng(), 'psd', {}, 'picture.png', 'png');
    const imageData = PSD_HEADER_BYTES + 3 * PSD_SECTION_LENGTH_BYTES;
    const rowCount = CHANNELS * HEIGHT;
    let cursor = imageData + 2 + rowCount * 2;
    const source = sourcePixels();
    for (let row = 0; row < rowCount; row += 1) {
      const packedLength = buffer.readUInt16BE(imageData + 2 + row * 2);
      const unpacked = unpackBits(buffer.subarray(cursor, cursor + packedLength));
      cursor += packedLength;
      const channel = Math.floor(row / HEIGHT);
      const y = row % HEIGHT;
      expect(unpacked).toHaveLength(WIDTH);
      expect(unpacked).toEqual(Array.from({ length: WIDTH }, (_, x) => source[(y * WIDTH + x) * CHANNELS + channel]));
    }
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('decodes in ImageMagick to the colour pixels of the source picture', async () => {
    const { buffer } = await convertImage(await sourcePng(), 'psd', {}, 'picture.png', 'png');
    const decoded = decodeRgba(buffer, 'psd');
    expect(decoded.width).toBe(WIDTH);
    expect(decoded.height).toBe(HEIGHT);
    const source = sourcePixels();
    for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
      expect([...decoded.data.subarray(i * CHANNELS, i * CHANNELS + 3)]).toEqual([...source.subarray(i * CHANNELS, i * CHANNELS + 3)]);
    }
  });

  it('refuses a picture a PSD file cannot hold with a typed error', async () => {
    const wide = await sharp({ create: { width: MAX_SIDE + 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
    const run = convertImage(wide, 'psd', {}, 'wide.png', 'png');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/at most|1 to 30000 pixels/);
  });
});
