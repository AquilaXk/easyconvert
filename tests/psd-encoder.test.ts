import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertImage } from '../src/lib/conversions';
import { ConversionFailedError } from '../src/lib/types';

/**
 * A PSD is the Photoshop file format, not a PNG behind a PSD header. This suite walks the file byte by byte from
 * the published Adobe Photoshop File Format sections (header, colour mode data, image resources, layer and mask
 * information, image data) and unpacks the PackBits rows itself. The expected pixels are the ones written into
 * the source picture; `image-psd-writer.test.ts` adds ImageMagick and Pillow as separate readers.
 */

const WIDTH = 41;
const HEIGHT = 23;
const RGBA = 4;
const RGB = 3;
const PSD_HEADER_BYTES = 26;
const U32 = 4;
const PSD_RLE = 1;
const MAX_SIDE = 30_000;
const BYTE_MAX = 255;
const RESOURCE_RESOLUTION = 1005;
const FIXED_ONE = 0x10000;
const DEFAULT_PPI = 72;

/** Flat bands (long runs), a gradient and noise (literals), with a varying alpha channel (never 0). */
function sourcePixels(channels: number): Buffer {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * channels);
  let seed = 12345;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * channels;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      let rgba: number[];
      if (y < 8) rgba = [200, 30, 30, 255];
      else if (y < 16) rgba = [x * 6, y * 10, 255 - x * 6, 255];
      else rgba = [seed & 255, (seed >> 8) & 255, (seed >> 16) & 255, 128 + (x % 100)];
      pixels.set(rgba.slice(0, channels), i);
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

/** Reads `channels` RLE channels of `height` rows starting after the row-count table at `offset`. */
function readRleChannels(buffer: Buffer, countTableAt: number, channels: number): { planes: number[][][]; end: number } {
  const rowCount = channels * HEIGHT;
  let cursor = countTableAt + rowCount * 2;
  const planes: number[][][] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const rows: number[][] = [];
    for (let y = 0; y < HEIGHT; y += 1) {
      const length = buffer.readUInt16BE(countTableAt + (channel * HEIGHT + y) * 2);
      rows.push(unpackBits(buffer.subarray(cursor, cursor + length)));
      cursor += length;
    }
    planes.push(rows);
  }
  return { planes, end: cursor };
}

async function pngOf(channels: number): Promise<Buffer> {
  return sharp(sourcePixels(channels), { raw: { width: WIDTH, height: HEIGHT, channels } }).png().toBuffer();
}

describe('PSD output', () => {
  it('RGB: header, empty colour mode data, resolution resource, empty layer section, PackBits planes of the source', async () => {
    const { buffer } = await convertImage(await pngOf(RGB), 'psd', {}, 'picture.png', 'png');
    expect(buffer.toString('ascii', 0, 4)).toBe('8BPS');
    expect(buffer.readUInt16BE(4)).toBe(1);
    expect(buffer.readUInt16BE(12)).toBe(RGB);
    expect(buffer.readUInt32BE(14)).toBe(HEIGHT);
    expect(buffer.readUInt32BE(18)).toBe(WIDTH);
    expect(buffer.readUInt16BE(22)).toBe(8);
    expect(buffer.readUInt16BE(24)).toBe(3);

    let at = PSD_HEADER_BYTES;
    expect(buffer.readUInt32BE(at)).toBe(0); // colour mode data
    at += U32;
    const resourcesLength = buffer.readUInt32BE(at);
    at += U32;
    // First image resource: '8BIM', id 1005, an empty Pascal name padded to 2 bytes, 16 bytes of resolution.
    expect(buffer.toString('ascii', at, at + 4)).toBe('8BIM');
    expect(buffer.readUInt16BE(at + 4)).toBe(RESOURCE_RESOLUTION);
    expect(buffer.readUInt16BE(at + 6)).toBe(0);
    expect(buffer.readUInt32BE(at + 8)).toBe(16);
    expect(buffer.readUInt32BE(at + 12)).toBe(DEFAULT_PPI * FIXED_ONE);
    expect(buffer.readUInt32BE(at + 20)).toBe(DEFAULT_PPI * FIXED_ONE);
    at += resourcesLength;
    const layerSection = buffer.readUInt32BE(at);
    expect(layerSection).toBe(2 * U32); // empty layer info and empty global layer mask
    at += U32 + layerSection;

    expect(buffer.readUInt16BE(at)).toBe(PSD_RLE);
    const { planes, end } = readRleChannels(buffer, at + 2, RGB);
    expect(end).toBe(buffer.length);
    const source = sourcePixels(RGB);
    for (let channel = 0; channel < RGB; channel += 1) {
      for (let y = 0; y < HEIGHT; y += 1) {
        expect(planes[channel][y]).toEqual(Array.from({ length: WIDTH }, (_, x) => source[(y * WIDTH + x) * RGB + channel]));
      }
    }
  });

  it('RGBA: one layer with the exact straight-alpha planes, and a merged image premultiplied against white', async () => {
    const { buffer } = await convertImage(await pngOf(RGBA), 'psd', {}, 'picture.png', 'png');
    expect(buffer.readUInt16BE(12)).toBe(RGBA);
    let at = PSD_HEADER_BYTES;
    at += U32; // colour mode data (empty)
    at += U32 + buffer.readUInt32BE(at); // image resources
    const sectionLength = buffer.readUInt32BE(at);
    at += U32;
    const sectionEnd = at + sectionLength;
    const layerInfoLength = buffer.readUInt32BE(at);
    at += U32;
    // Layer count: negative, so the first extra channel of the merged image is its transparency.
    expect(buffer.readInt16BE(at)).toBe(-1);
    const record = at + 2;
    expect([buffer.readInt32BE(record), buffer.readInt32BE(record + 4), buffer.readInt32BE(record + 8), buffer.readInt32BE(record + 12)]).toEqual([0, 0, HEIGHT, WIDTH]);
    expect(buffer.readUInt16BE(record + 16)).toBe(4);
    const channelIds = [0, 1, 2, 3].map((i) => buffer.readInt16BE(record + 18 + i * 6));
    expect(channelIds).toEqual([-1, 0, 1, 2]);
    expect(buffer.toString('ascii', record + 42, record + 50)).toBe('8BIMnorm');
    // Channel image data follows the record: a compression word then the row table, per channel, in record order.
    const extraLength = buffer.readUInt32BE(record + 54);
    let channelAt = record + 58 + extraLength;
    const source = sourcePixels(RGBA);
    const sourceChannelOfLayerChannel = [3, 0, 1, 2];
    for (let i = 0; i < 4; i += 1) {
      const declared = buffer.readUInt32BE(record + 18 + i * 6 + 2);
      expect(buffer.readUInt16BE(channelAt)).toBe(PSD_RLE);
      const { planes, end } = readRleChannels(buffer, channelAt + 2, 1);
      expect(end - channelAt).toBe(declared);
      for (let y = 0; y < HEIGHT; y += 1) {
        expect(planes[0][y]).toEqual(Array.from({ length: WIDTH }, (_, x) => source[(y * WIDTH + x) * RGBA + sourceChannelOfLayerChannel[i]]));
      }
      channelAt = end;
    }
    // The layer info is padded to a multiple of 4 bytes.
    const layerInfoStart = at;
    expect(layerInfoLength).toBe(Math.ceil((channelAt - layerInfoStart) / 4) * 4);
    at = sectionEnd;

    expect(buffer.readUInt16BE(at)).toBe(PSD_RLE);
    const merged = readRleChannels(buffer, at + 2, RGBA);
    expect(merged.end).toBe(buffer.length);
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const alpha = source[(y * WIDTH + x) * RGBA + 3];
        for (let c = 0; c < RGB; c += 1) {
          const colour = source[(y * WIDTH + x) * RGBA + c];
          const expected = Math.round((colour * alpha + BYTE_MAX * (BYTE_MAX - alpha)) / BYTE_MAX);
          expect(merged.planes[c][y][x]).toBe(expected);
        }
        expect(merged.planes[3][y][x]).toBe(alpha);
      }
    }
  });

  it('refuses a picture a PSD file cannot hold with a typed error', async () => {
    const wide = await sharp({ create: { width: MAX_SIDE + 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
    const run = convertImage(wide, 'psd', {}, 'wide.png', 'png');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/at most 30000/);
  });
});
