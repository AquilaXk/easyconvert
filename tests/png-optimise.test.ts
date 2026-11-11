import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { findOxipng, OXIPNG_LEVEL_FULL_COLOUR, OXIPNG_LEVEL_PALETTE, optimisePng } from '../src/lib/conversions/png-optimise';
import { craftPng } from './helpers/png-craft';
import { chunksOf, headerOf, rgba16Of } from './helpers/png-pixels';
import { skipUnless } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in programs of this suite write their records outside the job directory, which the file confinement refuses (policy 247).
runWithoutFileConfinement();

/**
 * The lossless optimiser of PNG files (oxipng, a separate sandboxed program). Oracle for every picture: the RGBA16 samples read back by
 * `tests/helpers/png-pixels.ts` (inflate, unfilter and expand written for this test) are equal before and after; the colour type and bit
 * depth read from the header show which reduction was made; and a file the program cannot shrink comes back as the same bytes.
 */

const WIDTH = 96;
const HEIGHT = 64;
const COLOUR_TYPE_GREY = 0;
const COLOUR_TYPE_RGB = 2;
const COLOUR_TYPE_PALETTE = 3;
const COLOUR_TYPE_GREY_ALPHA = 4;
const COLOUR_TYPE_RGBA = 6;

const available = findOxipng() !== null;
const skipped = skipUnless('oxipng', available);

/** A small deterministic generator (xorshift32), so that every picture is the same on every run. */
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

function pixels(channels: 1 | 2 | 3 | 4, paint: (x: number, y: number, next: () => number) => number[]): Buffer {
  const next = noise(11);
  const samples = Buffer.alloc(WIDTH * HEIGHT * channels);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) samples.set(paint(x, y, next), (y * WIDTH + x) * channels);
  }
  return samples;
}

const encode = (samples: Buffer, channels: 1 | 2 | 3 | 4, level = 1): Promise<Buffer> =>
  sharp(samples, { raw: { width: WIDTH, height: HEIGHT, channels } }).png({ compressionLevel: level }).toBuffer();

const FIVE_COLOURS = [[200, 30, 30], [30, 200, 30], [30, 30, 200], [240, 240, 20], [250, 250, 250]];

/** Stand-in programs, to judge the wrapper by what it hands the program and by how it takes each way a program can end. */
const standIns: string[] = [];
afterAll(() => {
  for (const dir of standIns) fs.rmSync(dir, { recursive: true, force: true });
});

function standIn(body: string): { program: string; argsFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxipng-stand-in-'));
  standIns.push(dir);
  const argsFile = path.join(dir, 'args.txt');
  const program = path.join(dir, 'oxipng');
  fs.writeFileSync(program, `#!/bin/sh\nprintf '%s ' "$@" > '${argsFile}'\n${body}\n`, { mode: 0o755 });
  return { program, argsFile };
}

describe('the program as the wrapper runs it', () => {
  const rgb = (): Promise<Buffer> => encode(pixels(3, (x, y, next) => [Math.round(next() * 255), (x * 3) & 255, (y * 4) & 255]), 3);
  const palette = (): Buffer => craftPng({ width: 8, height: 8, bits: 8, colorType: COLOUR_TYPE_PALETTE, rows: Buffer.alloc(64), palette: Buffer.from([1, 2, 3]) });

  it('gets the preset for the kind of picture, its input on standard input, a bounded time and no network', async () => {
    const { program, argsFile } = standIn('cat > /dev/null');
    vi.stubEnv('OXIPNG_PATH', program);
    try {
      await optimisePng(palette());
      expect(fs.readFileSync(argsFile, 'utf8')).toMatch(new RegExp(`^-q -o ${OXIPNG_LEVEL_PALETTE} --threads \\d+ --timeout \\d+ --stdout - $`));
      await optimisePng(await rgb());
      expect(fs.readFileSync(argsFile, 'utf8')).toMatch(new RegExp(`^-q -o ${OXIPNG_LEVEL_FULL_COLOUR} `));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the input when the program fails, writes nothing, writes a larger file or writes what is not a PNG', async () => {
    const png = await rgb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const body of ['cat > /dev/null; echo broken >&2; exit 3', 'cat > /dev/null', 'cat; echo more', 'cat > /dev/null; printf nope']) {
        vi.stubEnv('OXIPNG_PATH', standIn(body).program);
        expect((await optimisePng(png)).equals(png), body).toBe(true);
        vi.unstubAllEnvs();
      }
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('does not run on a picture past the size it is worth optimising, or on bytes that are no PNG header', async () => {
    const { program, argsFile } = standIn('cat');
    vi.stubEnv('OXIPNG_PATH', program);
    try {
      const huge = craftPng({ width: 1, height: 1, bits: 8, colorType: COLOUR_TYPE_RGB, rows: Buffer.from([1, 2, 3]) });
      huge.writeUInt32BE(20_000, 16);
      huge.writeUInt32BE(20_000, 20);
      expect((await optimisePng(huge)).equals(huge)).toBe(true);
      expect(fs.existsSync(argsFile)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe.skipIf(skipped)('lossless PNG optimisation', () => {
  it('writes a picture of five colours stored as RGB with a palette, and keeps every pixel', async () => {
    const png = await encode(pixels(3, (x, y) => FIVE_COLOURS[(Math.floor(x / 8) + Math.floor(y / 8)) % 5]), 3);
    expect(headerOf(png).colorType).toBe(COLOUR_TYPE_RGB);
    const optimised = await optimisePng(png);
    expect(headerOf(optimised).colorType).toBe(COLOUR_TYPE_PALETTE);
    expect(headerOf(optimised).bitDepth).toBeLessThanOrEqual(4);
    expect(optimised.length).toBeLessThan(png.length);
    expect(rgba16Of(optimised)).toEqual(rgba16Of(png));
  });

  it('writes RGB samples that are all grey as a grey picture', async () => {
    const png = await encode(pixels(3, (x, y, next) => Array(3).fill(Math.round(((x + y) * 255) / (WIDTH + HEIGHT) + next() * 40)).map((v) => Math.min(255, v))), 3);
    const optimised = await optimisePng(png);
    expect(headerOf(optimised).colorType).toBe(COLOUR_TYPE_GREY);
    expect(rgba16Of(optimised)).toEqual(rgba16Of(png));
    expect(optimised.length).toBeLessThan(png.length);
  });

  it('drops an alpha plane that is opaque everywhere', async () => {
    const png = await encode(pixels(4, (x, y, next) => [Math.round(next() * 255), (x * 3) & 255, (y * 4) & 255, 255]), 4);
    expect(headerOf(png).colorType).toBe(COLOUR_TYPE_RGBA);
    const optimised = await optimisePng(png);
    expect(headerOf(optimised).colorType).toBe(COLOUR_TYPE_RGB);
    expect(rgba16Of(optimised)).toEqual(rgba16Of(png));
  });

  it('keeps an alpha plane that is not opaque, with the colours of the transparent pixels', async () => {
    const png = await encode(pixels(4, (x, y, next) => [Math.round(next() * 255), (x * 3) & 255, (y * 4) & 255, x < 10 ? 0 : x < 20 ? 128 : 255]), 4);
    const optimised = await optimisePng(png);
    expect(headerOf(optimised).colorType).toBe(COLOUR_TYPE_RGBA);
    expect(rgba16Of(optimised)).toEqual(rgba16Of(png));
  });

  it('reduces grey with alpha of two levels to a palette and keeps both', async () => {
    const rows = Buffer.alloc(WIDTH * HEIGHT * 2);
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) rows.set([((x >> 3) + (y >> 3)) % 2 === 0 ? 20 : 220, x < 30 ? 0 : 255], (y * WIDTH + x) * 2);
    }
    const png = craftPng({ width: WIDTH, height: HEIGHT, bits: 8, colorType: COLOUR_TYPE_GREY_ALPHA, rows });
    const optimised = await optimisePng(png);
    expect(headerOf(optimised).colorType).toBe(COLOUR_TYPE_PALETTE);
    expect(rgba16Of(optimised)).toEqual(rgba16Of(png));
  });

  it('reduces 16-bit samples whose two bytes are equal to 8 bits, and keeps 16 bits where they are not', async () => {
    const next = noise(5);
    const rows = (lossless: boolean): Buffer => {
      const out = Buffer.alloc(WIDTH * HEIGHT * 2);
      for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
        const high = Math.round(next() * 255);
        out.writeUInt16BE(lossless ? high * 257 : (high << 8) | Math.round(next() * 255), i * 2);
      }
      return out;
    };
    const exact = craftPng({ width: WIDTH, height: HEIGHT, bits: 16, colorType: COLOUR_TYPE_GREY, rows: rows(true) });
    const exactOut = await optimisePng(exact);
    expect(headerOf(exactOut).bitDepth).toBe(8);
    expect(rgba16Of(exactOut)).toEqual(rgba16Of(exact));
    const deep = craftPng({ width: WIDTH, height: HEIGHT, bits: 16, colorType: COLOUR_TYPE_GREY, rows: rows(false) });
    const deepOut = await optimisePng(deep);
    expect(headerOf(deepOut).bitDepth).toBe(16);
    expect(rgba16Of(deepOut)).toEqual(rgba16Of(deep));
  });

  it('packs a palette of four colours stored with 8 bits per index into 2 bits, and keeps the transparency', async () => {
    const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
    const rows = Buffer.alloc(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) rows[y * WIDTH + x] = ((x >> 2) + (y >> 3)) % 4;
    const png = craftPng({ width: WIDTH, height: HEIGHT, bits: 8, colorType: COLOUR_TYPE_PALETTE, rows, palette, transparency: Buffer.from([255, 128, 255, 0]) });
    const optimised = await optimisePng(png);
    expect(headerOf(optimised).colorType).toBe(COLOUR_TYPE_PALETTE);
    expect(headerOf(optimised).bitDepth).toBe(2);
    expect(rgba16Of(optimised)).toEqual(rgba16Of(png));
  });

  it('removes the colours that no pixel uses from a palette', async () => {
    const palette = Buffer.alloc(256 * 3);
    for (let i = 0; i < 256; i += 1) palette.set([i, 255 - i, (i * 7) & 255], i * 3);
    const rows = Buffer.alloc(WIDTH * HEIGHT);
    for (let i = 0; i < rows.length; i += 1) rows[i] = (i % 3) * 100;
    const png = craftPng({ width: WIDTH, height: HEIGHT, bits: 8, colorType: COLOUR_TYPE_PALETTE, rows, palette });
    const optimised = await optimisePng(png);
    expect(chunksOf(optimised).find((chunk) => chunk.type === 'PLTE')!.data.length).toBeLessThanOrEqual(3 * 4);
    expect(rgba16Of(optimised)).toEqual(rgba16Of(png));
  });

  it('keeps a photograph full-colour and its pixels, and makes the file smaller through the filters and the deflate level', async () => {
    const png = await encode(pixels(3, (x, y, next) => [Math.round(60 + x + next() * 5), Math.round(90 + y * 2 + next() * 5), Math.round(120 + ((x + y) >> 1) + next() * 5)]), 3, 6);
    const optimised = await optimisePng(png);
    expect(headerOf(optimised).colorType).toBe(COLOUR_TYPE_RGB);
    expect(optimised.length).toBeLessThan(png.length);
    expect(rgba16Of(optimised)).toEqual(rgba16Of(png));
  });

  it('writes an interlaced picture without interlacing, with the same pixels', async () => {
    const samples = pixels(3, (x, y) => FIVE_COLOURS[(x + y) % 5]);
    const interlaced = await sharp(samples, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png({ progressive: true, compressionLevel: 1 }).toBuffer();
    expect(headerOf(interlaced).interlace).toBe(1);
    const optimised = await optimisePng(interlaced);
    expect(headerOf(optimised).interlace).toBe(0);
    const expected = await sharp(interlaced).ensureAlpha().raw().toBuffer();
    const read = rgba16Of(optimised);
    expect(Array.from(read, (value) => value >> 8)).toEqual(Array.from(expected));
  });

  it('keeps the chunks that tell how the picture looks', async () => {
    const png = await sharp(pixels(3, (x, y) => FIVE_COLOURS[(x + y) % 5]), { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).withMetadata({ density: 144 }).png({ compressionLevel: 1 }).toBuffer();
    const optimised = await optimisePng(png);
    expect(chunksOf(optimised).find((chunk) => chunk.type === 'pHYs')?.data).toEqual(chunksOf(png).find((chunk) => chunk.type === 'pHYs')?.data);
  });

  it('gives back the same bytes when the file cannot be made smaller', async () => {
    const once = await optimisePng(await encode(pixels(3, (x, y) => FIVE_COLOURS[(x + y) % 5]), 3));
    const twice = await optimisePng(once);
    expect(twice.equals(once)).toBe(true);
  });

  it('gives back bytes that are not a PNG, and a truncated PNG, unchanged', async () => {
    const garbage = Buffer.from('this is not a picture at all');
    expect((await optimisePng(garbage)).equals(garbage)).toBe(true);
    const png = await encode(pixels(3, (x, y) => FIVE_COLOURS[(x + y) % 5]), 3);
    const truncated = png.subarray(0, png.length - 40);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await optimisePng(truncated)).equals(truncated)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('without the program', () => {
  it('gives back the same bytes when OXIPNG_PATH names no executable', async () => {
    vi.stubEnv('OXIPNG_PATH', '/nonexistent/oxipng');
    try {
      const png = await encode(pixels(3, (x, y) => FIVE_COLOURS[(x + y) % 5]), 3);
      expect((await optimisePng(png)).equals(png)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe.skipIf(skipped)('PNG to PNG conversions', () => {
  const noisy = async (): Promise<Buffer> =>
    encode(pixels(3, (x, y, next) => [Math.round(40 + x * 1.5 + next() * 8), Math.round(70 + y * 2 + next() * 8), Math.round(100 + ((x + y) >> 1) + next() * 8)]), 3, 6);

  it('write the palette of the compress page smaller than without the optimiser, with the same pixels', async () => {
    const source = await noisy();
    vi.stubEnv('OXIPNG_PATH', '/nonexistent/oxipng');
    const plain = await convertFile(source, 'png', 'png', { palette: true, colors: 256 }, 'noise.png');
    vi.unstubAllEnvs();
    const optimised = await convertFile(source, 'png', 'png', { palette: true, colors: 256 }, 'noise.png');
    expect(optimised.buffer.length).toBeLessThan(plain.buffer.length);
    expect(rgba16Of(optimised.buffer)).toEqual(rgba16Of(plain.buffer));
  });

  it('write a picture of few colours as a palette that keeps every pixel of the source', async () => {
    const source = await encode(pixels(3, (x, y) => FIVE_COLOURS[(Math.floor(x / 6) + Math.floor(y / 4)) % 5]), 3, 9);
    const out = await convertFile(source, 'png', 'png', {}, 'few.png');
    expect(headerOf(out.buffer).colorType).toBe(COLOUR_TYPE_PALETTE);
    expect(rgba16Of(out.buffer)).toEqual(rgba16Of(source));
  });

  it('do not optimise a conversion from another format', async () => {
    const jpeg = await sharp(await encode(pixels(3, (x, y) => FIVE_COLOURS[(x + y) % 5]), 3)).jpeg().toBuffer();
    const out = await convertFile(jpeg, 'jpg', 'png', {}, 'a.jpg');
    expect(headerOf(out.buffer).colorType).toBe(COLOUR_TYPE_RGB);
  });
});
