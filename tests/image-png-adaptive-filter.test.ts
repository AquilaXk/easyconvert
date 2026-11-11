import zlib from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { scanRows } from '../src/lib/conversions/png-scanlines';

/**
 * A photograph written as an 8-bit PNG gets adaptive row filtering (libpng's heuristic: each row takes the one of the five filters
 * whose output has the smallest sum of absolute values), because unfiltered camera pixels barely deflate. A graphic (few colours, long
 * flat runs) keeps the unfiltered rows at level 8, where the filters only cost bytes. Oracles: the filter byte of every row and the
 * samples are read back from the file by this test (inflate, `scanRows` unfiltering), not by the converter's own decoder; the old
 * encoder settings are the reference for the size.
 */

const WIDTH = 160;
const HEIGHT = 120;
const FILTER_NONE = 0;
const PNG_SIGNATURE_BYTES = 8;
const CHUNK_OVERHEAD_BYTES = 12;

/** A small deterministic generator (xorshift32), so the picture is the same on every run. */
function noise(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** Smooth colour ramps with sensor-like noise: neighbouring samples differ by a few levels, never by a flat run. */
function photoSamples(channels: 3 | 4): Buffer {
  const next = noise(7);
  const samples = Buffer.alloc(WIDTH * HEIGHT * channels);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = (y * WIDTH + x) * channels;
      samples[at] = Math.round(40 + (x * 150) / WIDTH + next() * 6);
      samples[at + 1] = Math.round(60 + (y * 120) / HEIGHT + next() * 6);
      samples[at + 2] = Math.round(90 + ((x + y) * 60) / (WIDTH + HEIGHT) + next() * 6);
      if (channels === 4) samples[at + 3] = 255;
    }
  }
  return samples;
}

/** Hard-edged blocks of four colours: every row is a run of equal samples. */
function graphicSamples(): Buffer {
  const palette = [[255, 255, 255], [20, 40, 200], [220, 30, 30], [0, 0, 0]];
  const samples = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const colour = palette[(Math.floor(x / 40) + Math.floor(y / 30)) % palette.length];
      samples.set(colour, (y * WIDTH + x) * 3);
    }
  }
  return samples;
}

function rawPng(samples: Buffer, channels: 3 | 4): Promise<Buffer> {
  return sharp(samples, { raw: { width: WIDTH, height: HEIGHT, channels } }).png({ compressionLevel: 9 }).toBuffer();
}

/** The IDAT chunks and the header fields of a non-interlaced 8-bit PNG. */
function readPng(png: Buffer): { idat: Buffer[]; channels: number } {
  const idat: Buffer[] = [];
  let channels = 0;
  let at = PNG_SIGNATURE_BYTES;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      expect(data.readUInt32BE(0)).toBe(WIDTH);
      expect(data.readUInt32BE(4)).toBe(HEIGHT);
      expect(data[8]).toBe(8);
      expect(data[12]).toBe(0);
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9] as 0 | 2 | 4 | 6];
    }
    if (type === 'IDAT') idat.push(data);
    at += length + CHUNK_OVERHEAD_BYTES;
  }
  return { idat, channels };
}

/** The filter type that opens each row of the scanlines. */
function filterTypes(idat: Buffer[], channels: number): number[] {
  const scanlines = zlib.inflateSync(Buffer.concat(idat));
  const stride = WIDTH * channels + 1;
  expect(scanlines.length).toBe(stride * HEIGHT);
  return Array.from({ length: HEIGHT }, (_, row) => scanlines[row * stride]);
}

async function samplesOf(idat: Buffer[], channels: number): Promise<Buffer> {
  const rows: Buffer[] = [];
  await scanRows(idat, WIDTH, HEIGHT, channels * 8, (row) => {
    rows.push(Buffer.from(row));
  });
  return Buffer.concat(rows);
}

describe('the filter rows of an 8-bit PNG', () => {
  it('are chosen per row for a photograph, as libpng chooses them, and the samples come back as they went in', async () => {
    const samples = photoSamples(3);
    const { buffer } = await convertImage(await rawPng(samples, 3), 'png', {}, 'photo.png', 'png');
    const { idat, channels } = readPng(buffer);
    expect(channels).toBe(3);
    const types = filterTypes(idat, channels);
    expect(types.every((type) => type >= FILTER_NONE && type <= 4)).toBe(true);
    // Rows differ (the heuristic follows each one), and a photograph is not left unfiltered.
    expect(new Set(types).size).toBeGreaterThanOrEqual(2);
    expect(types.filter((type) => type !== FILTER_NONE).length).toBeGreaterThan(HEIGHT * 0.9);
    expect((await samplesOf(idat, channels)).equals(samples)).toBe(true);
  });

  it('write a photograph at least a quarter smaller than unfiltered rows at level 8, the settings of before', async () => {
    const samples = photoSamples(3);
    const before = await sharp(samples, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png({ compressionLevel: 8 }).toBuffer();
    const { buffer } = await convertImage(await rawPng(samples, 3), 'png', {}, 'photo.png', 'png');
    expect(buffer.length).toBeLessThan(before.length * 0.75);
  });

  it('keep every sample of a photograph with an alpha plane', async () => {
    const samples = photoSamples(4);
    for (let at = 3; at < samples.length; at += 4 * 7) samples[at] = 128;
    const { buffer } = await convertImage(await rawPng(samples, 4), 'png', {}, 'alpha-photo.png', 'png');
    const { idat, channels } = readPng(buffer);
    expect(channels).toBe(4);
    expect(new Set(filterTypes(idat, channels)).size).toBeGreaterThanOrEqual(2);
    expect((await samplesOf(idat, channels)).equals(samples)).toBe(true);
  });

  it('stay unfiltered for a graphic, which they would only make larger', async () => {
    const samples = graphicSamples();
    const before = await sharp(samples, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png({ compressionLevel: 8 }).toBuffer();
    const { buffer } = await convertImage(await rawPng(samples, 3), 'png', {}, 'graphic.png', 'png');
    const { idat, channels } = readPng(buffer);
    expect(new Set(filterTypes(idat, channels))).toEqual(new Set([FILTER_NONE]));
    expect(buffer.length).toBeLessThanOrEqual(before.length);
    expect((await samplesOf(idat, channels)).equals(samples)).toBe(true);
  });
});
