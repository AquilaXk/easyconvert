import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import {
  findQuantizr,
  QUANTIZR_DITHER_LEVEL,
  quantizePixels,
  quantizedPalettePng,
  writeIndexedPng,
  type IndexedPicture,
} from '../src/lib/conversions/png-palette-quantizer';
import { chunksOf, headerOf, rgba16Of } from './helpers/png-pixels';
import { skipUnless } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in programs of this suite write their records outside the job directory, which the file confinement refuses (policy 248).
runWithoutFileConfinement();

/**
 * The palette quantiser of the compress page (quantizr-pixels, a separate sandboxed program around the quantizr library). The writer of the
 * indexed PNG is judged by the RGBA16 samples that `tests/helpers/png-pixels.ts` reads back, which share no code with it; the wrapper by what
 * stand-in programs are given and by how it takes every way a program can end; the program by the bytes it is given, hostile ones included.
 */

const COLOUR_TYPE_PALETTE = 3;
const real = findQuantizr();
const skippedWithoutProgram = skipUnless('quantizr-pixels', real !== null);

const standIns: string[] = [];
afterAll(() => {
  for (const dir of standIns) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A program that records its arguments and what it was given, then runs `body` (a Python script text) with `input` bound to the bytes on
 * standard input and `out` to standard output. Python, not Node: the wrapper caps the program's address space (256 MB and up), which is
 * below what Node reserves at start on Linux.
 */
function standIn(body: string): { program: string; argsFile: string; inputFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantizr-stand-in-'));
  standIns.push(dir);
  const argsFile = path.join(dir, 'args.txt');
  const inputFile = path.join(dir, 'input.bin');
  const program = path.join(dir, 'quantizr-pixels');
  const script = [
    '#!/usr/bin/env python3',
    'import struct, sys',
    `open(${JSON.stringify(argsFile)}, 'w').write(' '.join(sys.argv[1:]))`,
    'input = sys.stdin.buffer.read()',
    `open(${JSON.stringify(inputFile)}, 'wb').write(input)`,
    'out = sys.stdout.buffer',
    body,
  ].join('\n');
  fs.writeFileSync(program, script, { mode: 0o755 });
  return { program, argsFile, inputFile };
}

/** The reply of a program for the picture on its input: `colours` entries (RGBA) and an index of 0 for every pixel. */
const flatReply = (colours: number[][]): string => `
width, height = struct.unpack_from('<II', input, 0)
out.write(struct.pack('<I', ${colours.length}) + bytes(${JSON.stringify(colours.flat())}) + bytes(width * height))
out.flush()`;

/** A deterministic picture: an RGBA raster of `colours` distinct colours laid out in rows, so that its palette is known. */
function stripes(width: number, height: number, colours: number, alpha = 255): { rgba: Buffer; expected: Uint16Array; picture: IndexedPicture } {
  const palette = Buffer.alloc(colours * 4);
  for (let i = 0; i < colours; i += 1) palette.set([(i * 37) & 255, (i * 91 + 5) & 255, (i * 13 + 70) & 255, i % 2 === 0 ? alpha : 255], i * 4);
  const indices = Buffer.alloc(width * height);
  for (let i = 0; i < indices.length; i += 1) indices[i] = (i * 7 + Math.floor(i / width)) % colours;
  const expected = new Uint16Array(width * height * 4);
  for (let i = 0; i < indices.length; i += 1) {
    for (let c = 0; c < 4; c += 1) expected[i * 4 + c] = palette[indices[i] * 4 + c] * 257;
  }
  return { rgba: Buffer.alloc(0), expected, picture: { width, height, palette, indices } };
}

const template = (extra?: (image: Sharp) => Sharp): Promise<Buffer> =>
  (extra ?? ((image) => image))(sharp({ create: { width: 1, height: 1, channels: 3, background: '#102030' } })).png({ palette: true }).toBuffer();

describe('writeIndexedPng', () => {
  it.each([
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 4],
    [16, 4],
    [17, 8],
    [200, 8],
    [256, 8],
  ])('writes %i colours at %i bits a pixel, and every pixel reads back as it was', async (colours, depth) => {
    const { picture, expected } = stripes(13, 9, colours);
    const png = await writeIndexedPng(picture, await template(), 6);
    expect(headerOf(png)).toMatchObject({ width: 13, height: 9, bitDepth: depth, colorType: COLOUR_TYPE_PALETTE, interlace: 0 });
    expect(Array.from(rgba16Of(png))).toEqual(Array.from(expected));
    // The image library, which checks every chunk's CRC and the length of the rows, reads the same picture.
    const read = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(read.info).toMatchObject({ width: 13, height: 9 });
    expect(Array.from(read.data, (v) => v * 257)).toEqual(Array.from(expected));
  });

  it('writes a transparency chunk only when an entry is not opaque, and cuts off the opaque entries at its end', async () => {
    const opaque = await writeIndexedPng(stripes(8, 4, 6).picture, await template(), 1);
    expect(chunksOf(opaque).some((chunk) => chunk.type === 'tRNS')).toBe(false);
    const { picture } = stripes(8, 4, 6, 40);
    const png = await writeIndexedPng(picture, await template(), 1);
    const trns = chunksOf(png).find((chunk) => chunk.type === 'tRNS');
    expect(Array.from(trns?.data ?? [])).toEqual([40, 255, 40, 255, 40]);
  });

  it('carries the chunks of the template that tell how the picture looks, ahead of the palette, and one chunk of pixel data after it', async () => {
    const png = await writeIndexedPng(stripes(8, 4, 6).picture, await template((image) => image.withMetadata({ density: 300 })), 1);
    const types = chunksOf(png).map((chunk) => chunk.type);
    expect(types[0]).toBe('IHDR');
    expect(types.at(-1)).toBe('IEND');
    expect(types).toContain('pHYs');
    expect(types.indexOf('pHYs')).toBeLessThan(types.indexOf('PLTE'));
    expect(types.indexOf('PLTE')).toBeLessThan(types.indexOf('IDAT'));
    expect(types.filter((type) => type === 'PLTE')).toHaveLength(1);
    expect(types.filter((type) => type === 'IHDR')).toHaveLength(1);
    expect((await sharp(png).metadata()).density).toBe(300);
  });

  it('refuses a picture whose parts do not agree', async () => {
    const { picture } = stripes(8, 4, 6);
    await expect(writeIndexedPng({ ...picture, indices: picture.indices.subarray(1) }, await template(), 1)).rejects.toThrow(/indices/);
    await expect(writeIndexedPng({ ...picture, palette: Buffer.alloc(0) }, await template(), 1)).rejects.toThrow(/palette/);
    await expect(writeIndexedPng({ ...picture, indices: Buffer.alloc(32, 9) }, await template(), 1)).rejects.toThrow(/index/);
  });
});

describe('quantizePixels, as the wrapper runs the program', () => {
  const rgba = (width: number, height: number): Buffer => Buffer.alloc(width * height * 4, 200);

  it('gives the program the size and the pixels on its standard input, and the colours and the dither as arguments', async () => {
    const { program, argsFile, inputFile } = standIn(flatReply([[1, 2, 3, 255], [4, 5, 6, 128]]));
    vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
    try {
      const picture = await quantizePixels(rgba(5, 3), 5, 3, { colours: 64, dither: 0.25 });
      expect(fs.readFileSync(argsFile, 'utf8')).toBe('--colors 64 --dither 0.25');
      const input = fs.readFileSync(inputFile);
      expect([input.readUInt32LE(0), input.readUInt32LE(4), input.length]).toEqual([5, 3, 8 + 5 * 3 * 4]);
      expect(picture).not.toBeNull();
      expect(Array.from(picture?.palette ?? [])).toEqual([1, 2, 3, 255, 4, 5, 6, 128]);
      expect(picture?.indices.length).toBe(15);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('answers null, and logs, when the program fails, writes nothing or writes a result that does not fit the picture', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = [
      'sys.stderr.write("broken"); sys.exit(3)',
      '',
      'out.write(bytes([1, 0, 0, 0, 9, 9, 9, 255]))', // an entry, but no indices
      "out.write(struct.pack('<I', 0) + bytes(15))", // no colours
      "out.write(struct.pack('<I', 257) + bytes(257 * 4 + 15))",
      `${flatReply([[1, 2, 3, 255]])}\nout.write(bytes(1))`, // a byte too many
    ];
    try {
      for (const body of bad) {
        vi.stubEnv('QUANTIZR_PIXELS_PATH', standIn(body).program);
        expect(await quantizePixels(rgba(5, 3), 5, 3, { colours: 256, dither: 1 }), body).toBeNull();
        vi.unstubAllEnvs();
      }
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('answers null without running anything when no program is installed', async () => {
    vi.stubEnv('QUANTIZR_PIXELS_PATH', path.join(os.tmpdir(), 'no-such-quantizr-pixels'));
    try {
      expect(findQuantizr()).toBeNull();
      expect(await quantizePixels(rgba(5, 3), 5, 3, { colours: 256, dither: 1 })).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stops when the conversion was cancelled instead of answering null', async () => {
    vi.stubEnv('QUANTIZR_PIXELS_PATH', standIn(flatReply([[1, 2, 3, 255]])).program);
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(quantizePixels(rgba(5, 3), 5, 3, { colours: 256, dither: 1, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the palette PNG of a pipeline', () => {
  const source = async (width = 24, height = 16, density?: number): Promise<Buffer> => {
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) raw.set([(i * 5) & 255, (i * 3) & 255, (i * 11) & 255], i * 3);
    const image = sharp(raw, { raw: { width, height, channels: 3 } });
    return (density === undefined ? image : image.withMetadata({ density })).png().toBuffer();
  };
  const params = { colours: 256, dither: true, level: 1, options: {} };

  it('is the program\'s palette and indices in an indexed PNG of the size of the pipeline, after the resize', async () => {
    const { program, argsFile } = standIn(flatReply([[9, 8, 7, 255]]));
    vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
    try {
      const png = await quantizedPalettePng(sharp(await source()).resize(12, 8), params);
      expect(png).not.toBeNull();
      expect(headerOf(png as Buffer)).toMatchObject({ width: 12, height: 8, colorType: COLOUR_TYPE_PALETTE, bitDepth: 1 });
      expect(new Set(rgba16Of(png as Buffer).filter((_, i) => i % 4 === 0))).toEqual(new Set([9 * 257]));
      expect(fs.readFileSync(argsFile, 'utf8')).toBe(`--colors 256 --dither ${QUANTIZR_DITHER_LEVEL}`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('passes no dithering when the request turns it off, and the colour count of the request', async () => {
    const { program, argsFile } = standIn(flatReply([[9, 8, 7, 255]]));
    vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
    try {
      await quantizedPalettePng(sharp(await source()), { ...params, colours: 16, dither: false });
      expect(fs.readFileSync(argsFile, 'utf8')).toBe('--colors 16 --dither 0');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the density of the source, as the image library writes it', async () => {
    const { program } = standIn(flatReply([[9, 8, 7, 255]]));
    vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
    try {
      const withDensity = await source(24, 16, 300);
      const pipeline = () => sharp(withDensity).keepMetadata();
      const ours = await quantizedPalettePng(pipeline(), params);
      const library = await pipeline().png({ palette: true }).toBuffer();
      expect(chunksOf(library).some((chunk) => chunk.type === 'pHYs')).toBe(true);
      expect(chunksOf(ours as Buffer).find((chunk) => chunk.type === 'pHYs')?.data).toEqual(chunksOf(library).find((chunk) => chunk.type === 'pHYs')?.data);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is null, and the program is not run, for a picture past the pixel limit or with no program', async () => {
    const { program, argsFile } = standIn(flatReply([[9, 8, 7, 255]]));
    vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
    try {
      expect(await quantizedPalettePng(sharp(await source()), { ...params, maxPixels: 100 })).toBeNull();
      expect(fs.existsSync(argsFile)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv('QUANTIZR_PIXELS_PATH', path.join(os.tmpdir(), 'no-such-quantizr-pixels'));
    try {
      expect(await quantizedPalettePng(sharp(await source()), params)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the compress page with the program', () => {
  const photo = async (): Promise<Buffer> => {
    const width = 64;
    const height = 48;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) raw.set([(x * 4 + y) & 255, (y * 5) & 255, ((x + y) * 3) & 255], (y * width + x) * 3);
    }
    return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  };
  const compress = async (png: Buffer, options: Record<string, unknown> = {}): Promise<Buffer> => {
    const result = await convertFile(png, 'png', 'png', { palette: true, ...options }, 'a.png');
    return result.buffer;
  };

  it('writes the palette of the program, with the dither level and the colour count it was asked for', async () => {
    const { program, argsFile } = standIn(flatReply([[1, 2, 3, 255], [250, 251, 252, 255]]));
    vi.stubEnv('QUANTIZR_PIXELS_PATH', program);
    try {
      const out = await compress(await photo(), { colors: 32 });
      expect(headerOf(out)).toMatchObject({ width: 64, height: 48, colorType: COLOUR_TYPE_PALETTE });
      expect(new Set(rgba16Of(out).filter((_, i) => i % 4 === 0))).toEqual(new Set([1 * 257]));
      expect(fs.readFileSync(argsFile, 'utf8')).toBe(`--colors 32 --dither ${QUANTIZR_DITHER_LEVEL}`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('writes the palette of the image library when the program fails, so that a conversion never fails because of it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('QUANTIZR_PIXELS_PATH', standIn('sys.exit(5)').program);
    try {
      const out = await compress(await photo());
      expect(headerOf(out).colorType).toBe(COLOUR_TYPE_PALETTE);
      expect(new Set(rgba16Of(out).filter((_, i) => i % 4 === 0)).size).toBeGreaterThan(8);
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe.skipIf(skippedWithoutProgram)('the program itself', () => {
  const run = (input: Buffer, args: string[] = []) => spawnSync(real as string, args, { input, maxBuffer: 1 << 28 });
  const header = (width: number, height: number): Buffer => {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32LE(width, 0);
    bytes.writeUInt32LE(height, 4);
    return bytes;
  };
  const noise = (count: number): Buffer => {
    const bytes = Buffer.alloc(count * 4);
    let state = 12345;
    for (let i = 0; i < bytes.length; i += 1) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      bytes[i] = state >>> 24;
    }
    return bytes;
  };

  it('answers a palette of at most the colours asked, with every index inside it and the pixels within reach of their entries', () => {
    const pixels = noise(64 * 64);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    const out = run(Buffer.concat([header(64, 64), pixels]), ['--colors', '16', '--dither', '0']);
    expect(out.status).toBe(0);
    const count = out.stdout.readUInt32LE(0);
    expect(count).toBeGreaterThan(1);
    expect(count).toBeLessThanOrEqual(16);
    expect(out.stdout.length).toBe(4 + count * 4 + 64 * 64);
    const indices = out.stdout.subarray(4 + count * 4);
    expect(Math.max(...indices)).toBeLessThan(count);
  });

  it('keeps every colour of a picture that has no more than 256', () => {
    const colours = 40;
    const pixels = Buffer.alloc(30 * 20 * 4);
    for (let i = 0; i < 30 * 20; i += 1) pixels.set([(i % colours) * 6, (i % colours) * 3, 255 - (i % colours), 255], i * 4);
    const out = run(Buffer.concat([header(30, 20), pixels]));
    expect(out.status).toBe(0);
    const count = out.stdout.readUInt32LE(0);
    const indices = out.stdout.subarray(4 + count * 4);
    for (let i = 0; i < 30 * 20; i += 1) {
      expect(Array.from(out.stdout.subarray(4 + indices[i] * 4, 8 + indices[i] * 4))).toEqual(Array.from(pixels.subarray(i * 4, i * 4 + 4)));
    }
  });

  it.each([
    ['a header that names more pixels than the program reads', Buffer.concat([header(0xffffffff, 0xffffffff)])],
    ['a header of 37 megapixels', Buffer.concat([header(37_000, 1000)])],
    ['a width of zero', Buffer.concat([header(0, 5), Buffer.alloc(0)])],
    ['pixels that stop early', Buffer.concat([header(4, 4), Buffer.alloc(63)])],
    ['pixels that go on past the size', Buffer.concat([header(4, 4), Buffer.alloc(65)])],
    ['a header cut short', Buffer.alloc(5)],
    ['no input', Buffer.alloc(0)],
  ])('refuses %s with a message and exit status 2, before it allocates for the picture', (_name, input) => {
    const out = run(input);
    expect(out.status).toBe(2);
    expect(out.stdout.length).toBe(0);
    expect(out.stderr.toString()).toMatch(/^quantizr-pixels: /);
  });

  it.each([[['--colors', '1']], [['--colors', '257']], [['--colors', 'x']], [['--dither', '1.5']], [['--dither', '-1']], [['--bogus', '1']], [['--colors']]])(
    'refuses the arguments %j',
    (args) => {
      const out = run(Buffer.concat([header(2, 2), Buffer.alloc(16, 9)]), args);
      expect(out.status).toBe(2);
      expect(out.stderr.toString()).toMatch(/^quantizr-pixels: /);
    }
  );
});
