import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { pdfjsImageToPng } from '../src/lib/conversions/pdf-rasterizer';
import { encodePdfPicture1BitPng, encodePdfPicturePng, type PngChannels } from '../src/lib/conversions/pdf-text-png';

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

describe('encodePdfPicture1BitPng', () => {
  function expectedGrayPixels(packed: Uint8Array, width: number, height: number): Buffer {
    const rowBytes = Math.ceil(width / 8);
    const expected = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (packed[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        expected[y * width + x] = bit === 1 ? 255 : 0;
      }
    }
    return expected;
  }

  it.each([
    [1, 1],
    [7, 5],
    [8, 8],
    [13, 9],
    [64, 32],
  ])('writes exact 1-bit grayscale PNG (bitDepth=1, colourType=0) for %i x %i including dirty trailing pad bits', async (width, height) => {
    const rowBytes = Math.ceil(width / 8);
    const packed = Uint8Array.from({ length: rowBytes * height }, (_u, i) => ((i * 73 + 0b1010_0101) & 0xff) | 0x07);
    const png = encodePdfPicture1BitPng(width, height, packed, 300);
    expect(png).not.toBeNull();
    const ihdrDataOffset = 16;
    expect(png![ihdrDataOffset + 8]).toBe(1);
    expect(png![ihdrDataOffset + 9]).toBe(0);
    const meta = await sharp(png!).metadata();
    expect(meta).toMatchObject({ width, height, channels: 1, space: 'b-w', density: 300 });
    const decoded = await sharp(png!).extractChannel(0).raw().toBuffer();
    expect(Buffer.compare(decoded, expectedGrayPixels(packed, width, height))).toBe(0);
  });

  it('rejects invalid dimensions, density, or mismatched byte length', () => {
    expect(encodePdfPicture1BitPng(9, 2, new Uint8Array(3), 72)).toBeNull();
    expect(encodePdfPicture1BitPng(0, 2, new Uint8Array(0), 72)).toBeNull();
    expect(encodePdfPicture1BitPng(8, 2, new Uint8Array(2), 0)).toBeNull();
    expect(encodePdfPicture1BitPng(8.5, 2, new Uint8Array(4), 72)).toBeNull();
    expect(encodePdfPicture1BitPng(0x8000_0000, 1, new Uint8Array(1), 72)).toBeNull();
    expect(encodePdfPicture1BitPng(8, 1, new Uint8Array(1), 1e12)).toBeNull();
    expect(encodePdfPicturePng(0x8000_0000, 1, 1, new Uint8Array(1), 72)).toBeNull();
    expect(encodePdfPicturePng(1, 1, 1, new Uint8Array(1), 1e12)).toBeNull();
  });

  it('keeps large 1-bpp pdfjs images (kind 1) at bit depth 1 rather than promoting to 24-bit RGB', async () => {
    const width = 1024;
    const height = 1024;
    const packed = new Uint8Array((width / 8) * height).fill(0xaa);
    const result = await pdfjsImageToPng({ kind: 1, width, height, data: packed });
    expect(result).toBeDefined();
    expect(result!.png[16 + 8]).toBe(1);
    expect(result!.png[16 + 9]).toBe(0);
    const meta = await sharp(result!.png).metadata();
    expect(meta).toMatchObject({ width, height, channels: 1, space: 'b-w' });
  });

  it('handles non-TypedArray storage safely without throwing on invalid pixel containers', async () => {
    const arrayBacked = await pdfjsImageToPng({ kind: 1, width: 8, height: 2, data: [0xaa, 0x55] });
    expect(arrayBacked).toBeDefined();
    expect(arrayBacked!.png[16 + 8]).toBe(1);
    const invalid = await pdfjsImageToPng({ kind: 1, width: 8, height: 2, data: { invalid: true } });
    expect(invalid).toBeUndefined();
  });
});
