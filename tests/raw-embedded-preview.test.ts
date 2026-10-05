import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';

const MAIN_WIDTH = 64;
const MAIN_HEIGHT = 48;
const THUMB_WIDTH = 8;
const THUMB_HEIGHT = 6;
const APP1_MARKER = Buffer.from([0xff, 0xe1]);
const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const SOI_LENGTH = 2;
const TRAILER_BYTES = 4096;
const COLOUR_TOLERANCE = 12;

async function solidJpeg(width: number, height: number, colour: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: colour } }).jpeg({ quality: 95 }).toBuffer();
}

/** A camera-style file: a JPEG whose Exif segment carries its own thumbnail JPEG, followed by non-JPEG sensor data. */
async function jpegWithExifThumbnail(): Promise<Buffer> {
  const main = await solidJpeg(MAIN_WIDTH, MAIN_HEIGHT, { r: 200, g: 40, b: 40 });
  const thumbnail = await solidJpeg(THUMB_WIDTH, THUMB_HEIGHT, { r: 40, g: 40, b: 200 });
  const payload = Buffer.concat([EXIF_HEADER, thumbnail]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + length.length);
  const app1 = Buffer.concat([APP1_MARKER, length, payload]);
  return Buffer.concat([main.subarray(0, SOI_LENGTH), app1, main.subarray(SOI_LENGTH), Buffer.alloc(TRAILER_BYTES)]);
}

describe('embedded RAW preview extraction', () => {
  it('returns the main JPEG, not the Exif thumbnail nested in its APP1 segment', async () => {
    const result = await convertFile(await jpegWithExifThumbnail(), 'raw', 'png', { allowEmbeddedPreview: true }, 'frame.raw');
    const meta = await sharp(result.buffer).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: MAIN_WIDTH, height: MAIN_HEIGHT });
    const { data } = await sharp(result.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(Math.abs(data[0] - 200)).toBeLessThan(COLOUR_TOLERANCE);
    expect(Math.abs(data[2] - 40)).toBeLessThan(COLOUR_TOLERANCE);
  });
});
