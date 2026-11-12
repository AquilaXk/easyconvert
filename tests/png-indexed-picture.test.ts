import zlib from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { writeIndexedPng } from '../src/lib/conversions/png-palette-quantizer';
import { chunksOf, rgba16Of, scanlinesOf } from './helpers/png-pixels';

/**
 * The palette order and row filters of the indexed PNG the worker writes, judged by what the independent reader of
 * `tests/helpers/png-pixels.ts` finds in the file: the same RGBA16 samples as the picture, whatever order the palette is in.
 */

const template = (): Promise<Buffer> => sharp({ create: { width: 1, height: 1, channels: 3, background: '#102030' } }).png({ palette: true }).toBuffer();

function paletteOf(colours: number): Buffer {
  const palette = Buffer.alloc(colours * 4);
  for (let i = 0; i < colours; i += 1) palette.set([(i * 37 + 11) & 255, (i * 91 + 5) & 255, (i * 13 + 70) & 255, 255], i * 4);
  return palette;
}

function expectedOf(palette: Buffer, indices: Buffer): Uint16Array {
  const expected = new Uint16Array(indices.length * 4);
  for (let i = 0; i < indices.length; i += 1) for (let c = 0; c < 4; c += 1) expected[i * 4 + c] = palette[indices[i] * 4 + c] * 257;
  return expected;
}

/** A photograph's kind of picture: a smooth diagonal ramp over `colours` shuffled palette entries with a little noise, which is dithering. */
function photograph(width: number, height: number, colours: number): { palette: Buffer; indices: Buffer; shuffle: number[] } {
  const shuffle = Array.from({ length: colours }, (_, i) => i).sort((a, b) => ((a * 7919) % 211) - ((b * 7919) % 211));
  const indices = Buffer.alloc(width * height);
  let state = 17;
  for (let i = 0; i < indices.length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const x = i % width;
    const y = Math.floor(i / width);
    const level = Math.floor(((x + y) * colours) / (width + height)) + ((state >>> 20) % 3) - 1;
    indices[i] = shuffle[Math.max(0, Math.min(colours - 1, level))];
  }
  return { palette: paletteOf(colours), indices, shuffle };
}

describe('the order and filters of the indexed PNG', () => {
  it('reads back every pixel of a photograph whose palette was reordered and whose rows were filtered', async () => {
    const { palette, indices } = photograph(300, 200, 120);
    const png = await writeIndexedPng({ width: 300, height: 200, palette, indices }, await template());
    expect(Array.from(rgba16Of(png))).toEqual(Array.from(expectedOf(palette, indices)));
    const entries = chunksOf(png).find((chunk) => chunk.type === 'PLTE')?.data ?? Buffer.alloc(0);
    expect(entries.equals(Buffer.from(Array.from({ length: 120 }, (_, i) => Array.from(palette.subarray(i * 4, i * 4 + 3))).flat()))).toBe(false);
    // The image library, which checks every chunk and the length of the rows, reads the same picture.
    const read = await sharp(png).ensureAlpha().raw().toBuffer();
    expect(Array.from(read, (v) => v * 257)).toEqual(Array.from(expectedOf(palette, indices)));
  });

  it('writes a photograph smaller than zlib level 9 makes of its rows in the order the quantiser gave', async () => {
    const { palette, indices } = photograph(300, 200, 120);
    const png = await writeIndexedPng({ width: 300, height: 200, palette, indices }, await template());
    const { filters } = scanlinesOf(png);
    expect(filters.some((filter) => filter !== 0)).toBe(true);
    const plain = Buffer.alloc(201 * 200);
    for (let y = 0; y < 200; y += 1) indices.copy(plain, y * 301 + 1, y * 300, (y + 1) * 300);
    const idat = chunksOf(png)
      .filter((chunk) => chunk.type === 'IDAT')
      .reduce((sum, chunk) => sum + chunk.data.length, 0);
    expect(idat).toBeLessThan(zlib.deflateSync(plain, { level: 9 }).length * 0.95);
  });

  it('puts the colour that starts the rows of a graphic at index 0, and every pixel reads back as it was', async () => {
    const width = 160;
    const height = 90;
    const palette = paletteOf(20);
    const indices = Buffer.alloc(width * height, 7);
    for (let y = 20; y < 60; y += 1) for (let x = 30; x < 120; x += 1) indices[y * width + x] = 1 + ((x >> 4) % 18);
    const png = await writeIndexedPng({ width, height, palette, indices }, await template());
    expect(Array.from(rgba16Of(png))).toEqual(Array.from(expectedOf(palette, indices)));
    const entries = chunksOf(png).find((chunk) => chunk.type === 'PLTE')?.data ?? Buffer.alloc(0);
    expect(Array.from(entries.subarray(0, 3))).toEqual(Array.from(palette.subarray(7 * 4, 7 * 4 + 3)));
    expect(scanlinesOf(png).filters.every((filter) => filter === 0)).toBe(true);
  });

  it('keeps the palette order and the unfiltered rows of a picture of 16 colours or fewer', async () => {
    const palette = paletteOf(12);
    const indices = Buffer.alloc(64 * 32);
    for (let i = 0; i < indices.length; i += 1) indices[i] = (i * 5 + (i >> 6)) % 12;
    const png = await writeIndexedPng({ width: 64, height: 32, palette, indices }, await template());
    const entries = chunksOf(png).find((chunk) => chunk.type === 'PLTE')?.data ?? Buffer.alloc(0);
    expect(Array.from(entries)).toEqual(Array.from({ length: 12 }, (_, i) => Array.from(palette.subarray(i * 4, i * 4 + 3))).flat());
    expect(scanlinesOf(png).filters.every((filter) => filter === 0)).toBe(true);
  });

  it('does not change the picture it is given', async () => {
    const { palette, indices } = photograph(120, 80, 60);
    const before = { palette: Buffer.from(palette), indices: Buffer.from(indices) };
    await writeIndexedPng({ width: 120, height: 80, palette, indices }, await template());
    expect(palette.equals(before.palette)).toBe(true);
    expect(indices.equals(before.indices)).toBe(true);
  });

  it('stops for a cancelled conversion', async () => {
    const { palette, indices } = photograph(120, 80, 60);
    const controller = new AbortController();
    controller.abort();
    await expect(writeIndexedPng({ width: 120, height: 80, palette, indices }, await template(), controller.signal)).rejects.toBeDefined();
  });
});
