import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';

/**
 * Two encoder choices for photographs, checked from the bytes they write:
 * - A 16-bit PNG is written with adaptive row filtering (PNG Third Edition, section 12.8): the filter-type byte of the rows
 *   of a noisy picture is not 0 (None) everywhere.
 * - A photograph converted to GIF without a dithering request is mapped to its palette without error diffusion, which is
 *   noise to LZW: the file is smaller than the dithered one by a clear margin and the picture is no worse (the synthetic
 *   photograph of the benchmark corpus).
 * The 16-bit picture is a smooth gradient with a fixed pseudo-random grain, so no two neighbours agree.
 */

const WIDTH = 256;
const HEIGHT = 192;
const SIXTEEN_BIT_MAX = 65535;

function grain(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function photograph16(): Buffer {
  const random = grain(7);
  const samples = new Uint16Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const base = [x / WIDTH, y / HEIGHT, (x + y) / (WIDTH + HEIGHT)];
      base.forEach((value, c) => {
        samples[(y * WIDTH + x) * 3 + c] = Math.round(Math.min(1, Math.max(0, value * 0.8 + 0.1 + (random() - 0.5) * 0.04)) * SIXTEEN_BIT_MAX);
      });
    }
  }
  return Buffer.from(samples.buffer);
}

/** A 16-bit picture as a PNG: the decoder's TIFF of a camera file reaches the encoder as the same samples. */
async function png16(): Promise<Buffer> {
  return sharp(photograph16(), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
}

/** The chunks of a PNG by type, from its signature on. */
function chunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  const found: Array<{ type: string; data: Buffer }> = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    found.push({ type: png.subarray(at + 4, at + 8).toString('latin1'), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return found;
}

describe('a 16-bit picture to PNG', () => {
  it('stays 16 bits per sample and filters its rows adaptively', async () => {
    const result = await convertFile(await png16(), 'png', 'png', {}, 'photo.png');
    const parts = chunks(result.buffer);
    const header = parts.find((part) => part.type === 'IHDR')?.data as Buffer;
    expect(header.readUInt32BE(0)).toBe(WIDTH);
    expect(header[8]).toBe(16);
    const raw = zlib.inflateSync(Buffer.concat(parts.filter((part) => part.type === 'IDAT').map((part) => part.data)));
    const rowBytes = 1 + WIDTH * 3 * 2;
    expect(raw.length).toBe(rowBytes * HEIGHT);
    const filters = new Set<number>();
    for (let row = 0; row < HEIGHT; row++) filters.add(raw[row * rowBytes]);
    expect([...filters].some((filter) => filter !== 0)).toBe(true);
  });
});

describe('a photograph to GIF', () => {
  const PHOTO = path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg');
  async function decoded(gif: Buffer): Promise<Buffer> {
    return sharp(gif).removeAlpha().raw().toBuffer();
  }
  const psnr = (a: Buffer, b: Buffer): number => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    return 10 * Math.log10((255 * 255) / (sum / a.length));
  };

  it('is smaller than the dithered file by a clear margin, and no worse as a picture, when no dithering is asked for', async () => {
    const source = fs.readFileSync(PHOTO);
    const reference = await sharp(source).removeAlpha().raw().toBuffer();
    const plain = await convertFile(source, 'jpg', 'gif', {}, 'photo-a.jpg');
    const dithered = await convertFile(source, 'jpg', 'gif', { dither: true }, 'photo-a.jpg');
    expect(plain.buffer.subarray(0, 3).toString('latin1')).toBe('GIF');
    expect(plain.buffer.length).toBeLessThan(dithered.buffer.length * 0.9);
    expect(psnr(await decoded(plain.buffer), reference)).toBeGreaterThan(psnr(await decoded(dithered.buffer), reference) - 1);
    const colours = new Set<number>();
    const pixels = await decoded(plain.buffer);
    for (let i = 0; i < pixels.length; i += 3) colours.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
    expect(colours.size).toBeLessThanOrEqual(256);
  });

  it('keeps the dithering a request names', async () => {
    const source = fs.readFileSync(PHOTO);
    const off = await convertFile(source, 'jpg', 'gif', { dither: false }, 'photo-a.jpg');
    const on = await convertFile(source, 'jpg', 'gif', { dither: true }, 'photo-a.jpg');
    expect(on.buffer.equals(off.buffer)).toBe(false);
    expect(on.buffer.length).toBeGreaterThan(off.buffer.length);
  });
});
