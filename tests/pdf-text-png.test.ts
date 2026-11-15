import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { encodePdfPicturePng, type PngChannels } from '../src/lib/conversions/pdf-text-png';

function samples(width: number, height: number, channels: number): Uint8Array {
  return Uint8Array.from({ length: width * height * channels }, (_unused, at) => (at * 37 + (at >> 3) * 11) & 0xff);
}

function chunkTypes(png: Buffer): string[] {
  const types: string[] = [];
  for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) types.push(png.toString('latin1', at + 4, at + 8));
  return types;
}

describe('encodePdfPicturePng', () => {
  it.each([
    [1, 4, 5],
    [3, 48, 25],
    [4, 100, 80],
    [1, 1, 1],
    [3, 7, 129],
  ] as [PngChannels, number, number][])('writes %i-channel pixels of %i x %i that the image library reads back unchanged', async (channels, width, height) => {
    const raw = samples(width, height, channels);
    const png = encodePdfPicturePng(width, height, channels, raw, 72);
    expect(png).not.toBeNull();
    // The library decodes a gray picture as three equal channels; the first of them is the gray sample.
    const decoder = channels === 1 ? sharp(png!).extractChannel(0) : sharp(png!);
    const decoded = await decoder.raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width, height, channels });
    expect(Buffer.compare(decoded.data, Buffer.from(raw))).toBe(0);
  });

  it('writes the chunks of a plain PNG and the density of the page unit', async () => {
    const png = encodePdfPicturePng(8, 8, 3, samples(8, 8, 3), 72)!;
    expect(chunkTypes(png)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    expect((await sharp(png).metadata()).density).toBe(72);
  });

  it('keeps a gray picture gray', async () => {
    const png = encodePdfPicturePng(8, 8, 1, samples(8, 8, 1), 72)!;
    const metadata = await sharp(png).metadata();
    expect(metadata.channels).toBe(1);
    expect(metadata.space).toBe('b-w');
  });

  it('refuses samples that are not as many as the size says, so the caller takes the image library and its error', () => {
    expect(encodePdfPicturePng(4, 4, 3, new Uint8Array(4 * 4 * 3 - 1), 72)).toBeNull();
    expect(encodePdfPicturePng(4, 4, 3, new Uint8Array(4 * 4 * 3 + 1), 72)).toBeNull();
    expect(encodePdfPicturePng(0, 4, 3, new Uint8Array(0), 72)).toBeNull();
  });
});
