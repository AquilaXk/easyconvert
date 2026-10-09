import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { encode16BitPng } from '../src/lib/conversions/image';
import { getOracleToolPath } from './helpers/differential-oracle';
import { requireMagick, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { oracleTest } from './helpers/oracle-test';
import { SeededRandom } from './helpers/archive-corpus';

/**
 * The 16-bit RGB PNG writer against independent decoders: ffmpeg (raw `rgb48be` output compared byte for byte), an
 * unfilter written here from the PNG specification (section 9, filter types 0-4), and ImageMagick's libpng writer for size.
 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SAMPLES_PER_PIXEL = 3;
const BYTES_PER_PIXEL = 6;
const SIZE_BOUND = 1.1;
const COMPRESSION_LEVEL = 8;

interface PngChunk {
  type: string;
  data: Buffer;
}

function readChunks(png: Buffer): PngChunk[] {
  expect(png.subarray(0, 8).equals(SIGNATURE)).toBe(true);
  const chunks: PngChunk[] = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    chunks.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

/** A photograph-like 16-bit image: smooth gradients with sensor noise, a sharp edge, and a flat patch. */
function testImage(width: number, height: number, seed: number): Uint16Array {
  const rng = new SeededRandom(seed);
  const rgb = new Uint16Array(width * height * SAMPLES_PER_PIXEL);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * SAMPLES_PER_PIXEL;
      const base = 6000 + (x * 40000) / width + (y * 12000) / height;
      for (let c = 0; c < SAMPLES_PER_PIXEL; c++) {
        let v = base * (0.8 + 0.1 * c) + rng.below(180);
        if (x > width / 2 && y > height / 3 && y < height / 2) v = 60000 - c * 3000 + rng.below(40);
        if (x < width / 8 && y > (height * 3) / 4) v = 32768;
        rgb[at + c] = Math.max(0, Math.min(65535, Math.round(v)));
      }
    }
  }
  return rgb;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decodes the IDAT scanlines of a 16-bit RGB PNG into big-endian sample bytes, and reports which filter types it used. */
function unfilter(png: Buffer): { pixels: Buffer; filtersUsed: Set<number>; width: number; height: number } {
  const chunks = readChunks(png);
  const header = chunks[0].data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  expect([header[8], header[9], header[10], header[11], header[12]]).toEqual([16, 2, 0, 0, 0]);
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const rowBytes = width * BYTES_PER_PIXEL;
  expect(raw.length).toBe(height * (rowBytes + 1));
  const pixels = Buffer.alloc(height * rowBytes);
  const filtersUsed = new Set<number>();
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    filtersUsed.add(filter);
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[y * (rowBytes + 1) + 1 + i];
      const a = i >= BYTES_PER_PIXEL ? pixels[y * rowBytes + i - BYTES_PER_PIXEL] : 0;
      const b = y > 0 ? pixels[(y - 1) * rowBytes + i] : 0;
      const c = y > 0 && i >= BYTES_PER_PIXEL ? pixels[(y - 1) * rowBytes + i - BYTES_PER_PIXEL] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) predicted = paeth(a, b, c);
      else if (filter !== 0) throw new Error(`invalid filter type ${filter}`);
      pixels[y * rowBytes + i] = (x + predicted) & 0xff;
    }
  }
  return { pixels, filtersUsed, width, height };
}

function bigEndianBytes(rgb: Uint16Array): Buffer {
  const out = Buffer.alloc(rgb.length * 2);
  for (let i = 0; i < rgb.length; i++) out.writeUInt16BE(rgb[i], i * 2);
  return out;
}

describe('encode16BitPng', () => {
  const width = 640;
  const height = 480;
  const rgb = testImage(width, height, 11);

  it('writes scanlines that unfilter to the source samples, choosing among the five filter types', () => {
    const png = encode16BitPng(width, height, rgb);
    const decoded = unfilter(png);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.pixels.equals(bigEndianBytes(rgb))).toBe(true);
    // The test image has gradients, an edge and noise: more than one filter type must have won rows.
    expect(decoded.filtersUsed.size).toBeGreaterThanOrEqual(3);
    const types = readChunks(png).map((c) => c.type);
    expect(types[0]).toBe('IHDR');
    expect(types[types.length - 1]).toBe('IEND');
  });

  it('keeps every sample exact on extremes and single-pixel images', () => {
    for (const [w, h] of [[1, 1], [1, 7], [7, 1], [3, 5]]) {
      const samples = new Uint16Array(w * h * SAMPLES_PER_PIXEL);
      for (let i = 0; i < samples.length; i++) samples[i] = [0, 65535, 1, 65534, 256, 255][i % 6];
      const decoded = unfilter(encode16BitPng(w, h, samples));
      expect(decoded.pixels.equals(bigEndianBytes(samples)), `${w}x${h}`).toBe(true);
    }
  });

  it('embeds an ICC profile as a zlib-compressed iCCP chunk', () => {
    const profile = Buffer.from('not-a-real-profile-but-bytes'.repeat(20));
    const chunks = readChunks(encode16BitPng(8, 8, testImage(8, 8, 2), profile));
    const iccp = chunks.find((c) => c.type === 'iCCP')!;
    const nameEnd = iccp.data.indexOf(0);
    expect(iccp.data.subarray(0, nameEnd).toString('latin1')).toBe('ICC Profile');
    expect(zlib.inflateSync(iccp.data.subarray(nameEnd + 2)).equals(profile)).toBe(true);
  });

  it('rejects dimensions that do not match the sample array', () => {
    expect(() => encode16BitPng(4, 4, new Uint16Array(10))).toThrow(/does not match/);
    expect(() => encode16BitPng(0, 4, new Uint16Array(0))).toThrow(/dimensions/);
  });

  oracleTest('ffmpeg decodes the PNG to the source samples (rgb48be raw output, compared byte for byte)', ['ffmpeg'], () => {
    const ffmpeg = getOracleToolPath('ffmpeg')!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'png16-'));
    const pngPath = path.join(dir, 'image.png');
    fs.writeFileSync(pngPath, encode16BitPng(width, height, rgb));
    const decoded = execFileSync(ffmpeg, ['-v', 'error', '-i', pngPath, '-f', 'rawvideo', '-pix_fmt', 'rgb48be', '-'], { maxBuffer: 1 << 28 });
    expect(decoded.length).toBe(width * height * BYTES_PER_PIXEL);
    expect(decoded.equals(bigEndianBytes(rgb))).toBe(true);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('is within 10% of the size of ImageMagick (libpng) 16-bit PNG at the same compression level', () => {
    const convert = requireMagick();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'png16-size-'));
    const rawPath = path.join(dir, 'input.rgb');
    const referencePath = path.join(dir, 'reference.png');
    fs.writeFileSync(rawPath, bigEndianBytes(rgb));
    execFileSync(convert, ['-size', `${width}x${height}`, '-depth', '16', '-endian', 'MSB', `rgb:${rawPath}`, '-define', `png:compression-level=${COMPRESSION_LEVEL}`, referencePath]);
    // The comparison is only meaningful against a 16-bit file that holds the same samples.
    expect(execFileSync(convert, [referencePath, '-format', '%z', 'info:'], { encoding: 'utf8' }).trim()).toBe('16');
    const back = execFileSync(convert, [referencePath, '-depth', '16', '-endian', 'MSB', 'rgb:-'], { maxBuffer: 1 << 28 });
    expect(back.equals(bigEndianBytes(rgb))).toBe(true);
    const reference = fs.statSync(referencePath).size;
    expect(encode16BitPng(width, height, rgb).length).toBeLessThanOrEqual(reference * SIZE_BOUND);
  });
});
