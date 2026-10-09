import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { avifEffortFor, avifSpeedFor } from '../src/lib/conversions/image-encoder-defaults';
import { ConversionFailedError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { injectExifOrientation } from './helpers/exif-orientation';
import { lineArt16, interface16 } from './helpers/graphic-parity';
import { runConvert } from './helpers/imagemagick';
import { oracleTest } from './helpers/oracle-test';

/**
 * AVIF through the reference AVIF library's command-line encoder. Oracles: `avifdec --info` (bit depth, chroma
 * format, alpha, colour tags, ICC), `avifdec` decoding to PNG read by ImageMagick (pixel values), `exiftool`,
 * and ImageMagick's own colour management for the profile conversion. The encoder under test is only ever
 * observed through its output files and through the arguments a recording wrapper sees.
 */

const PHOTO_WIDTH = 192;
const PHOTO_HEIGHT = 128;
const BYTE_MAX = 255;
const NOISE_MULTIPLIER = 2654435761;
const PATCH = 16;
const COLOUR_TOLERANCE = 2;
const OVERSIZED_SIDE = 8200;
const OVERSIZED_OTHER_SIDE = 8000;
const FAILURE_EXIT_STATUS = 3;
const SCRIPT_MODE = 0o755;

let workDir: string;
const savedAvifencPath = process.env.AVIFENC_PATH;
const savedSecret = process.env.AVIF_TEST_SECRET_TOKEN;

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'avif-library-encoder-'));
});
afterEach(() => {
  if (savedAvifencPath === undefined) delete process.env.AVIFENC_PATH;
  else process.env.AVIFENC_PATH = savedAvifencPath;
  if (savedSecret === undefined) delete process.env.AVIF_TEST_SECRET_TOKEN;
  else process.env.AVIF_TEST_SECRET_TOKEN = savedSecret;
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeIn(name: string, bytes: Buffer | string): string {
  const file = path.join(workDir, name);
  writeFileSync(file, bytes);
  return file;
}

interface AvifInfo {
  depth: number;
  format: string;
  alpha: string;
  icc: string;
  primaries: number;
  transfer: number;
  matrix: number;
}

function avifInfo(file: string): AvifInfo {
  const out = execFileSync(requireOracleTool('avifdec'), ['--info', file], { encoding: 'utf-8' });
  const pick = (key: string): string => (new RegExp(`${key}\\s*:\\s*([^\\n]+)`).exec(out)?.[1] ?? '').trim();
  return {
    depth: Number(pick('Bit Depth')),
    format: pick('Format'),
    alpha: pick('Alpha'),
    icc: pick('ICC Profile'),
    primaries: Number(pick('Color Primaries')),
    transfer: Number(pick('Transfer Char\\.')),
    matrix: Number(pick('Matrix Coeffs\\.')),
  };
}

function noise(index: number): number {
  return (Math.imul(index + 1, NOISE_MULTIPLIER) >>> 12) & 0x1f;
}

/** A smooth colour gradient with per-pixel noise: the statistics of a photograph, none of the flat areas. */
async function photoPng(): Promise<Buffer> {
  const raw = Buffer.alloc(PHOTO_WIDTH * PHOTO_HEIGHT * 3);
  for (let y = 0; y < PHOTO_HEIGHT; y += 1) {
    for (let x = 0; x < PHOTO_WIDTH; x += 1) {
      const at = (y * PHOTO_WIDTH + x) * 3;
      const n = noise(y * PHOTO_WIDTH + x);
      raw[at] = Math.min(BYTE_MAX, Math.round((x * 200) / PHOTO_WIDTH + 30 * Math.sin(y / 9)) + n);
      raw[at + 1] = Math.min(BYTE_MAX, Math.round((y * 200) / PHOTO_HEIGHT + 30 * Math.cos(x / 11)) + n);
      raw[at + 2] = Math.min(BYTE_MAX, ((x + y) >> 1) + n * 2);
    }
  }
  return sharp(raw, { raw: { width: PHOTO_WIDTH, height: PHOTO_HEIGHT, channels: 3 } }).png().toBuffer();
}

/** Eight grey 8-bit bands with a stripe pattern: flat areas and hard edges, one channel. */
async function grey8Graphic(): Promise<Buffer> {
  const raw = Buffer.alloc(PHOTO_WIDTH * PHOTO_HEIGHT, 255);
  for (let y = 0; y < PHOTO_HEIGHT; y += 1) for (let x = 0; x < PHOTO_WIDTH; x += 1) if ((x >> 3) % 4 === 0 || (y >> 3) % 5 === 0) raw[y * PHOTO_WIDTH + x] = 20;
  return sharp(raw, { raw: { width: PHOTO_WIDTH, height: PHOTO_HEIGHT, channels: 1 } }).toColourspace('b-w').png().toBuffer();
}

/** A recording wrapper around the real encoder: it logs its arguments, then runs the real binary on them. */
function recordingWrapper(name: string): { script: string; argsFile: string } {
  const argsFile = path.join(workDir, `${name}.args`);
  const script = writeIn(name, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexec '${requireOracleTool('avifenc')}' "$@"\n`);
  chmodSync(script, SCRIPT_MODE);
  return { script, argsFile };
}

function failingTool(name: string, body: string): { script: string; marker: string } {
  const marker = path.join(workDir, `${name}.ran`);
  const script = writeIn(name, `#!/bin/sh\ntouch '${marker}'\n${body}\n`);
  chmodSync(script, SCRIPT_MODE);
  return { script, marker };
}

describe('grey sources', () => {
  oracleTest(
    'a 16-bit grey picture becomes a 10-bit monochrome (YUV400) AVIF written by the library encoder',
    ['avifenc', 'avifdec'],
    async () => {
      const out = await convertImage(await lineArt16(), 'avif', { quality: 70 }, 'grey.png', 'png');
      expect(avifInfo(writeIn('grey16.avif', out.buffer))).toMatchObject({ format: 'YUV400', depth: 10 });
      expect(out.metadata).toMatchObject({ avifEncoder: 'library-cli' });
    },
    60_000
  );

  oracleTest(
    'an 8-bit grey picture becomes an 8-bit YUV400 AVIF',
    ['avifenc', 'avifdec'],
    async () => {
      const out = await convertImage(await grey8Graphic(), 'avif', { quality: 60 }, 'grey8.png', 'png');
      expect(avifInfo(writeIn('grey8.avif', out.buffer))).toMatchObject({ format: 'YUV400', depth: 8 });
    },
    60_000
  );

  oracleTest(
    'a grey picture with real transparency stays YUV400 and keeps its alpha plane',
    ['avifenc', 'avifdec', 'magick'],
    async () => {
      const greyAlpha = runConvert(['-size', `${PHOTO_WIDTH}x${PHOTO_HEIGHT}`, 'gradient:#202020-#e0e0e0', '-alpha', 'set', '-channel', 'A', '-evaluate', 'set', '50%', '+channel', '-depth', '8', '-define', 'png:color-type=4', 'png:-']);
      expect(await sharp(greyAlpha).metadata()).toMatchObject({ channels: 2, hasAlpha: true });
      const info = avifInfo(writeIn('grey-alpha.avif', (await convertImage(greyAlpha, 'avif', {}, 'ga.png', 'png')).buffer));
      expect(info.format).toBe('YUV400');
      expect(info.alpha).toMatch(/Present|premultiplied/i);
    },
    60_000
  );

  oracleTest(
    'a grey picture letterboxed on a coloured background is colour, on a neutral one it stays grey',
    ['avifenc', 'avifdec'],
    async () => {
      const grey = await grey8Graphic();
      const resize = { width: PHOTO_WIDTH * 2, height: PHOTO_HEIGHT * 2, fit: 'contain' as const };
      const coloured = await convertImage(grey, 'avif', { ...resize, background: '#ff0000' }, 'g.png', 'png');
      expect(avifInfo(writeIn('boxed-red.avif', coloured.buffer)).format).not.toBe('YUV400');
      const neutral = await convertImage(grey, 'avif', { ...resize, background: '#c0c0c0' }, 'g.png', 'png');
      expect(avifInfo(writeIn('boxed-grey.avif', neutral.buffer)).format).toBe('YUV400');
    },
    60_000
  );
});

describe('colour sources', () => {
  oracleTest(
    'graphic content is written by the library encoder at full-resolution chroma (YUV444) and 10 bits',
    ['avifenc', 'avifdec'],
    async () => {
      const graphic = await convertImage(await interface16(), 'avif', { quality: 50 }, 'ui.png', 'png');
      expect(avifInfo(writeIn('graphic.avif', graphic.buffer))).toMatchObject({ format: 'YUV444', depth: 10 });
      expect(graphic.metadata).toMatchObject({ avifEncoder: 'library-cli' });
    },
    60_000
  );

  oracleTest(
    'a colour photograph stays on the image library: YUV420 at 8 bits below quality 80, and the metadata names the encoder',
    ['avifenc', 'avifdec'],
    async () => {
      const tool = failingTool('never-run-for-photos', 'exit 0');
      process.env.AVIFENC_PATH = tool.script;
      const photo = await convertImage(await photoPng(), 'avif', { quality: 50 }, 'p.png', 'png');
      expect(photo.metadata).toMatchObject({ avifEncoder: 'image-library' });
      expect(avifInfo(writeIn('photo.avif', photo.buffer))).toMatchObject({ format: 'YUV420', depth: 8 });
      expect(existsSync(tool.marker)).toBe(false);
    },
    60_000
  );

  oracleTest(
    'a Display P3 source keeps its colours: the pixels are the sRGB values ImageMagick computes from the embedded profile',
    ['avifenc', 'avifdec', 'magick'],
    async () => {
      const patches = [[250, 20, 20], [20, 200, 40], [30, 60, 240], [128, 128, 128]];
      const raw = Buffer.alloc(patches.length * PATCH * PATCH * 3);
      for (let y = 0; y < PATCH; y += 1) {
        for (let x = 0; x < patches.length * PATCH; x += 1) raw.set(patches[Math.floor(x / PATCH)], (y * patches.length * PATCH + x) * 3);
      }
      const rawOptions = { raw: { width: patches.length * PATCH, height: PATCH, channels: 3 } } as const;
      const p3 = await sharp(raw, rawOptions).withIccProfile('p3').png().toBuffer();
      const srgbProfile = (await sharp(await sharp(raw, rawOptions).withIccProfile('srgb').png().toBuffer()).metadata()).icc as Buffer;
      const profilePath = writeIn('srgb.icc', srgbProfile);
      const expected = runConvert([writeIn('p3-in.png', p3), '-profile', profilePath, '-depth', '8', 'rgb:-']);
      const avif = writeIn('p3.avif', (await convertImage(p3, 'avif', { quality: 100 }, 'p3.png', 'png')).buffer);
      expect(avifInfo(avif)).toMatchObject({ icc: 'Absent', primaries: 1 });
      const decodedPath = path.join(workDir, 'p3-decoded.png');
      execFileSync(requireOracleTool('avifdec'), [avif, decodedPath]);
      const decoded = runConvert([decodedPath, '-depth', '8', 'rgb:-']);
      const width = patches.length * PATCH;
      for (let patch = 0; patch < patches.length; patch += 1) {
        const at = ((PATCH >> 1) * width + patch * PATCH + (PATCH >> 1)) * 3;
        for (let c = 0; c < 3; c += 1) expect(Math.abs(decoded[at + c] - expected[at + c]), `patch ${patch} channel ${c}`).toBeLessThanOrEqual(COLOUR_TOLERANCE);
      }
      // The profile mattered: some converted value differs from the stored one by more than the tolerance.
      const stored = patches.flat();
      const shifts = patches.flatMap((_, patch) => stored.slice(patch * 3, patch * 3 + 3).map((value, c) => Math.abs(expected[(((PATCH >> 1) * width) + patch * PATCH + (PATCH >> 1)) * 3 + c] - value)));
      expect(Math.max(...shifts)).toBeGreaterThan(COLOUR_TOLERANCE);
    },
    60_000
  );

  oracleTest(
    'the EXIF orientation is applied to the pixels and no orientation tag is left to turn the picture twice',
    ['avifenc', 'avifdec', 'exiftool'],
    async () => {
      const source = injectExifOrientation(await sharp(await photoPng()).jpeg().toBuffer(), 6);
      const out = await convertImage(source, 'avif', {}, 'o.jpg', 'jpg');
      const file = writeIn('oriented.avif', out.buffer);
      const tags = execFileSync(requireOracleTool('exiftool'), ['-a', '-G1', '-s', file], { encoding: 'utf-8' });
      expect(/Orientation\s*:\s*(.*)/.exec(tags)?.[1].trim() ?? 'Horizontal (normal)').toBe('Horizontal (normal)');
      const decoded = path.join(workDir, 'oriented.png');
      execFileSync(requireOracleTool('avifdec'), [file, decoded]);
      expect(await sharp(decoded).metadata()).toMatchObject({ width: PHOTO_HEIGHT, height: PHOTO_WIDTH });
    },
    60_000
  );

  oracleTest(
    'alpha that is fully opaque is dropped and alpha that is not is kept',
    ['avifenc', 'avifdec'],
    async () => {
      const opaque = await sharp(await photoPng()).ensureAlpha().png().toBuffer();
      expect(avifInfo(writeIn('opaque.avif', (await convertImage(opaque, 'avif', {}, 'o.png', 'png')).buffer)).alpha).toMatch(/Absent/);
      const raw = Buffer.alloc(PHOTO_WIDTH * PHOTO_HEIGHT * 4, BYTE_MAX);
      raw[3] = 100;
      const translucent = await sharp(raw, { raw: { width: PHOTO_WIDTH, height: PHOTO_HEIGHT, channels: 4 } }).png().toBuffer();
      expect(avifInfo(writeIn('translucent.avif', (await convertImage(translucent, 'avif', {}, 't.png', 'png')).buffer)).alpha).toMatch(/Present|premultiplied/i);
    },
    60_000
  );
});

describe('HDR output', () => {
  oracleTest(
    'a PQ photograph is written at 10 bits with BT.2020 / PQ colour tags by the image library',
    ['avifenc', 'avifdec'],
    async () => {
      const side = 32;
      const samples = new Uint16Array(side * side * 3);
      for (let i = 0; i < samples.length; i += 1) samples[i] = (((i / 3) | 0) % side) * 2000;
      const png16 = await sharp(samples, { raw: { width: side, height: side, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
      const { writePngCicp } = await import('../src/lib/conversions/cicp');
      const tagged = writePngCicp(png16, { primaries: 9, transfer: 16, matrix: 0, fullRange: true });
      const out = await convertImage(tagged, 'avif', { toneMap: 'none', quality: 90 }, 'pq.png', 'png');
      expect(avifInfo(writeIn('pq.avif', out.buffer))).toMatchObject({ depth: 10, primaries: 9, transfer: 16 });
      expect(out.metadata).toMatchObject({ avifEncoder: 'image-library' });
    },
    60_000
  );
});

describe('encoder arguments', () => {
  oracleTest(
    'quality, speed, bit depth, chroma and threads reach the encoder as the policy states them, and the picture arrives on stdin',
    ['avifenc', 'avifdec'],
    async () => {
      const wrapper = recordingWrapper('args-wrapper');
      process.env.AVIFENC_PATH = wrapper.script;
      const ui = await interface16();
      const { width = 0, height = 0 } = await sharp(ui).metadata();
      await convertImage(ui, 'avif', { quality: 55 }, 'ui.png', 'png');
      const args = readFileSync(wrapper.argsFile, 'utf-8').trim().split('\n');
      const valueOf = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
      expect(valueOf('-q')).toBe('55');
      expect(valueOf('--qalpha')).toBe('55');
      expect(valueOf('-s')).toBe(String(avifSpeedFor(avifEffortFor(width * height, 'graphic', 'library-cli'))));
      expect(valueOf('-d')).toBe('10');
      expect(valueOf('-y')).toBe('444');
      expect(Number(valueOf('-j'))).toBeGreaterThanOrEqual(1);
      expect(Number(valueOf('-j'))).toBeLessThanOrEqual(os.availableParallelism());
      expect(args).toContain('--stdin');
    },
    60_000
  );
});

describe('without the library encoder', () => {
  oracleTest(
    'the image library encodes, the result says so, and the file is a valid AVIF',
    ['avifdec'],
    async () => {
      process.env.AVIFENC_PATH = path.join(workDir, 'no-such-avifenc');
      const out = await convertImage(await photoPng(), 'avif', { quality: 60 }, 'p.png', 'png');
      expect(out.metadata).toMatchObject({ avifEncoder: 'image-library' });
      expect(out.mimeType).toBe('image/avif');
      expect(avifInfo(writeIn('fallback.avif', out.buffer))).toMatchObject({ format: 'YUV420', depth: 8 });
    },
    60_000
  );

  oracleTest(
    'a grey picture falls back to a colour AVIF, which the image library cannot make monochrome',
    ['avifdec'],
    async () => {
      process.env.AVIFENC_PATH = path.join(workDir, 'no-such-avifenc');
      const out = await convertImage(await grey8Graphic(), 'avif', { quality: 60 }, 'g.png', 'png');
      expect(out.metadata).toMatchObject({ avifEncoder: 'image-library' });
      expect(avifInfo(writeIn('fallback-grey.avif', out.buffer)).format).toBe('YUV444');
    },
    60_000
  );
});

describe('sandbox and limits', () => {
  oracleTest(
    'a picture over the encoder pixel budget falls back to the image library instead of being refused, and the tool is not started',
    ['avifdec'],
    async () => {
      const tool = failingTool('never-run', 'exit 0');
      process.env.AVIFENC_PATH = tool.script;
      const huge = await sharp({ create: { width: OVERSIZED_SIDE, height: OVERSIZED_OTHER_SIDE, channels: 3, background: { r: 128, g: 128, b: 128 } } }).toColourspace('b-w').png().toBuffer();
      const out = await convertImage(huge, 'avif', {}, 'huge.png', 'png');
      expect(out.metadata).toMatchObject({ avifEncoder: 'image-library' });
      expect(avifInfo(writeIn('huge.avif', out.buffer)).format).toBe('YUV444');
      expect(existsSync(tool.marker)).toBe(false);
    },
    240_000
  );

  it('turns an encoder failure into a typed conversion error that does not show the tool path', async () => {
    const tool = failingTool('exits-nonzero', `echo 'bad input at ${workDir}' >&2\nexit ${FAILURE_EXIT_STATUS}`);
    process.env.AVIFENC_PATH = tool.script;
    const failure = await convertImage(await grey8Graphic(), 'avif', {}, 'g.png', 'png').then(
      () => null,
      (err: unknown) => err
    );
    expect(existsSync(tool.marker)).toBe(true);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/Cannot encode the image as \.avif/);
    expect((failure as Error).message).not.toContain(workDir);
  }, 60_000);

  it('turns an encoder that exits cleanly without a file into a typed conversion error', async () => {
    const tool = failingTool('writes-nothing', 'exit 0');
    process.env.AVIFENC_PATH = tool.script;
    const failure = await convertImage(await grey8Graphic(), 'avif', {}, 'g.png', 'png').then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/produced no output/);
  }, 60_000);

  it('runs the encoder with credentials removed from its environment', async () => {
    process.env.AVIF_TEST_SECRET_TOKEN = 'must-not-reach-the-encoder';
    const envFile = path.join(workDir, 'seen-env.txt');
    const tool = failingTool('dumps-env', `env > '${envFile}'\nexit ${FAILURE_EXIT_STATUS}`);
    process.env.AVIFENC_PATH = tool.script;
    await convertImage(await grey8Graphic(), 'avif', {}, 'g.png', 'png').catch(() => undefined);
    const seen = readFileSync(envFile, 'utf-8');
    expect(seen).not.toContain('must-not-reach-the-encoder');
    expect(seen).toMatch(/^PATH=/m);
  }, 60_000);

  oracleTest(
    'the private working directory of the encoder is removed after a conversion',
    ['avifenc', 'avifdec'],
    async () => {
      const leftovers = (): string[] => readdirSync(os.tmpdir()).filter((name) => name.startsWith('easyconvert-avif-'));
      const before = new Set(leftovers());
      await convertImage(await grey8Graphic(), 'avif', {}, 'g.png', 'png');
      const after = leftovers();
      expect(after.filter((name) => !before.has(name))).toEqual([]);
    },
    60_000
  );
});
