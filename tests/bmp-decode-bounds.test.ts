import { describe, expect, it } from 'vitest';
import { convertImage, decodeBmp, encodeBmp } from '../src/lib/conversions/image';
import { ConversionFailedError } from '../src/lib/types';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';

const BYTES_PER_MIB = 1024 * 1024;
const MAX_RSS_GROWTH_BYTES = 50 * BYTES_PER_MIB;
const BMP_FILE_HEADER_BYTES = 14;
const BMP_INFO_HEADER_BYTES = 40;
const BMP_HEADER_BYTES = BMP_FILE_HEADER_BYTES + BMP_INFO_HEADER_BYTES;
const BMP_WIDTH_OFFSET = 18;
const BMP_HEIGHT_OFFSET = 22;
const BMP_BPP_OFFSET = 28;
const BMP_PIXEL_OFFSET = 10;
const BOMB_SIDE = 10_000;

/** 54-byte header of an uncompressed BMP (BITMAPINFOHEADER) with no pixel data after it. */
function headerOnlyBmp(width: number, height: number, bitsPerPixel: number): Buffer {
  const header = Buffer.alloc(BMP_HEADER_BYTES);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(BMP_HEADER_BYTES, BMP_PIXEL_OFFSET);
  header.writeUInt32LE(BMP_INFO_HEADER_BYTES, BMP_FILE_HEADER_BYTES);
  header.writeInt32LE(width, BMP_WIDTH_OFFSET);
  header.writeInt32LE(height, BMP_HEIGHT_OFFSET);
  header.writeUInt16LE(1, BMP_BPP_OFFSET - 2);
  header.writeUInt16LE(bitsPerPixel, BMP_BPP_OFFSET);
  return header;
}

describe('decodeBmp checks the declared pixel data against the file before allocating', () => {
  it('rejects a 54-byte header that declares 10000x10000 pixels without allocating the canvas', () => {
    const bomb = headerOnlyBmp(BOMB_SIDE, BOMB_SIDE, 24);
    expect(bomb).toHaveLength(BMP_HEADER_BYTES);
    const rssBefore = process.memoryUsage().rss;
    let error: unknown;
    try {
      decodeBmp(bomb);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error).not.toBeInstanceOf(InputPixelLimitError);
    expect((error as Error).message).toContain('pixel data');
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it('answers the same typed error through the converter', async () => {
    const run = convertImage(headerOnlyBmp(BOMB_SIDE, BOMB_SIDE, 32), 'png', {}, 'lie.bmp', 'bmp');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/pixel data/);
  });

  it('rejects a file cut one byte short of its last row', () => {
    const width = 5;
    const height = 4;
    const whole = encodeBmp(Buffer.alloc(width * height * 3, 7), width, height, 3);
    expect(() => decodeBmp(whole.subarray(0, whole.length - 1))).toThrow(ConversionFailedError);
  });

  it('rejects a pixel data offset that points past the end of the file', () => {
    const whole = encodeBmp(Buffer.alloc(3 * 3 * 3, 7), 3, 3, 3);
    whole.writeUInt32LE(whole.length + 1, BMP_PIXEL_OFFSET);
    expect(() => decodeBmp(whole)).toThrow(/pixel data/);
  });

  it.each([0, 3, 12, 64])('rejects the unsupported bit depth %i', (bitsPerPixel) => {
    const file = Buffer.concat([headerOnlyBmp(2, 2, bitsPerPixel), Buffer.alloc(64)]);
    expect(() => decodeBmp(file)).toThrow(/bits per pixel/);
  });

  it('still decodes a complete 24-bit file, bottom-up, to the exact RGBA bytes', () => {
    const width = 3;
    const height = 2;
    // Rows as stored top-down by encodeBmp's input: (r, g, b) = (x*10, y*20, 99).
    const rgb = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        rgb.set([x * 10, y * 20, 99], (y * width + x) * 3);
      }
    }
    const decoded = decodeBmp(encodeBmp(rgb, width, height, 3));
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    expect([...decoded.raw.subarray(0, 4)]).toEqual([0, 0, 99, 255]);
    expect([...decoded.raw.subarray((width + 2) * 4, (width + 2) * 4 + 4)]).toEqual([20, 20, 99, 255]);
  });
});
