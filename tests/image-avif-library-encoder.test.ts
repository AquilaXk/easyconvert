import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { AVIFENC_MAX_THREADS, avifencArguments, encodeAvifWithCli, findAvifenc, type AvifCliRequest } from '../src/lib/conversions/avif-cli';
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
/** Four 10-bit steps in 16-bit units: the quantisation of the stored AVIF, plus the rounding of the matrix. */
const PQ_TOLERANCE_16BIT = 4 * 64;
const OVERSIZED_SIDE = 8200;
const OVERSIZED_OTHER_SIDE = 8000;
const FAILURE_EXIT_STATUS = 3;
const SCRIPT_MODE = 0o755;
/** What a fake tool answers when asked for its version, so it passes for a supported libavif without running a picture. */
const VERSION_ANSWER = `[ "$1" = "--version" ] && { echo 'Version: 1.4.2 (fake)'; exit 0; }`;

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

/** Top-left pixel of an AVIF as 8-bit R, G, B: decoded by `avifdec` (16-bit PNG) and read by ImageMagick. */
function cornerPixel(avif: string, name: string): [number, number, number] {
  const decoded = path.join(workDir, `${name}-corner.png`);
  execFileSync(requireOracleTool('avifdec'), ['-d', '16', avif, decoded]);
  const rgb = runConvert([decoded, '-crop', '1x1+0+0', '+repage', '-depth', '8', 'rgb:-']);
  return [rgb[0], rgb[1], rgb[2]];
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
  const script = writeIn(name, `#!/bin/sh\n[ "$1" = "--version" ] && exec '${requireOracleTool('avifenc')}' "$@"\nprintf '%s\\n' "$@" > '${argsFile}'\nexec '${requireOracleTool('avifenc')}' "$@"\n`);
  chmodSync(script, SCRIPT_MODE);
  return { script, argsFile };
}

/** Runs `body` with `TMPDIR` pointing to a directory of its own, so other test files cannot add or remove entries it looks at. */
async function withPrivateTmpdir(body: (tmp: string) => Promise<void>): Promise<void> {
  const saved = process.env.TMPDIR;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'avif-private-tmp-'));
  process.env.TMPDIR = tmp;
  try {
    await body(tmp);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isRunning(pid: number): boolean {
  let running = true;
  try {
    process.kill(pid, 0);
  } catch (err) {
    running = (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  return running;
}

/** True once no process has `pid` (polled for up to `graceMs`). */
async function isGone(pid: number, graceMs = 5000): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    if (!isRunning(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function failingTool(name: string, body: string): { script: string; marker: string } {
  const marker = path.join(workDir, `${name}.ran`);
  const script = writeIn(name, `#!/bin/sh\n${VERSION_ANSWER}\ntouch '${marker}'\n${body}\n`);
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
    ['avifenc', 'avifdec'],
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

  describe.each([
    { name: '8-bit', source: grey8Graphic },
    { name: '16-bit', source: lineArt16 },
  ])('a $name grey picture on a red letterbox keeps the red bars', ({ name: depthName, source }) => {
    // The picture is half the output width, so its left and right quarters are background.
    const resize = { width: PHOTO_WIDTH * 2, height: PHOTO_HEIGHT, fit: 'contain' as const, background: '#ff0000' };
    const expectRedCorner = async (name: string): Promise<void> => {
      const out = await convertImage(await source(), 'avif', resize, 'g.png', 'png');
      const file = writeIn(`${name}.avif`, out.buffer);
      expect(avifInfo(file).format).not.toBe('YUV400');
      const [r, g, b] = cornerPixel(file, name);
      expect(Math.abs(r - 255), `${name} red`).toBeLessThanOrEqual(COLOUR_TOLERANCE * 2);
      expect(g, `${name} green`).toBeLessThanOrEqual(COLOUR_TOLERANCE * 2);
      expect(b, `${name} blue`).toBeLessThanOrEqual(COLOUR_TOLERANCE * 2);
    };

    oracleTest('written by the library encoder', ['avifenc', 'avifdec'], () => expectRedCorner(`bars-cli-${depthName}`), 60_000);

    oracleTest(
      'written by the image library when the tool is missing',
      ['avifdec'],
      async () => {
        process.env.AVIFENC_PATH = path.join(workDir, 'no-such-avifenc');
        await expectRedCorner(`bars-lib-${depthName}`);
      },
      60_000
    );
  });
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
    'a Display P3 source keeps its colours: the pixels are the sRGB values littlecms (Pillow) computes from the embedded profile',
    ['avifenc', 'avifdec', 'python3'],
    async () => {
      const patches = [[250, 20, 20], [20, 200, 40], [30, 60, 240], [128, 128, 128]];
      const raw = Buffer.alloc(patches.length * PATCH * PATCH * 3);
      for (let y = 0; y < PATCH; y += 1) {
        for (let x = 0; x < patches.length * PATCH; x += 1) raw.set(patches[Math.floor(x / PATCH)], (y * patches.length * PATCH + x) * 3);
      }
      const rawOptions = { raw: { width: patches.length * PATCH, height: PATCH, channels: 3 } } as const;
      const p3 = await sharp(raw, rawOptions).withIccProfile('p3').png().toBuffer();
      const profilePath = writeIn('p3.icc', (await sharp(p3).metadata()).icc as Buffer);
      // The PNG holds the patches re-encoded in Display P3. Pillow reads those stored numbers as they are (the image library
      // would already convert them to sRGB on load) and littlecms converts them with the embedded profile.
      const python = requireOracleTool('python3');
      const stored = execFileSync(python, ['-I', '-c', "import sys; from PIL import Image; sys.stdout.buffer.write(Image.open(sys.argv[1]).convert('RGB').tobytes())", writeIn('p3-in.png', p3)], { maxBuffer: raw.length * 2 });
      const expected = execFileSync(python, ['-I', path.join(__dirname, 'helpers', 'icc_oracle.py'), profilePath], { input: stored, maxBuffer: stored.length * 2 });
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
      // The profile mattered: some converted value differs from the stored number by more than the tolerance.
      const centre = (patch: number): number => (((PATCH >> 1) * width) + patch * PATCH + (PATCH >> 1)) * 3;
      const shifts = patches.flatMap((_, patch) => [0, 1, 2].map((c) => Math.abs(expected[centre(patch) + c] - stored[centre(patch) + c])));
      expect(Math.max(...shifts)).toBeGreaterThan(COLOUR_TOLERANCE * 4);
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
      const info = avifInfo(writeIn('pq.avif', out.buffer));
      console.info(`library-path PQ photograph tags: ${JSON.stringify(info)}`);
      expect(info).toMatchObject({ depth: 10, primaries: 9, transfer: 16 });
      expect(out.metadata).toMatchObject({ avifEncoder: 'image-library' });
    },
    60_000
  );

  oracleTest(
    'a flat PQ graphic goes to the library encoder with BT.2020 / PQ / BT.2020 NCL tags and its sample values survive',
    ['avifenc', 'avifdec'],
    async () => {
      const side = 64;
      const sample = [40000, 24000, 12000];
      const samples = new Uint16Array(side * side * 3);
      for (let i = 0; i < samples.length; i += 1) samples[i] = sample[i % 3];
      const png16 = await sharp(samples, { raw: { width: side, height: side, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
      const { writePngCicp } = await import('../src/lib/conversions/cicp');
      const tagged = writePngCicp(png16, { primaries: 9, transfer: 16, matrix: 0, fullRange: true });
      const out = await convertImage(tagged, 'avif', { toneMap: 'none', quality: 100 }, 'pq-flat.png', 'png');
      expect(out.metadata).toMatchObject({ avifEncoder: 'library-cli' });
      const file = writeIn('pq-flat.avif', out.buffer);
      expect(avifInfo(file)).toMatchObject({ depth: 10, primaries: 9, transfer: 16, matrix: 9 });
      const decoded = path.join(workDir, 'pq-flat-decoded.png');
      execFileSync(requireOracleTool('avifdec'), ['-d', '16', file, decoded]);
      const read = runConvert([decoded, '-crop', '1x1+32+32', '+repage', '-depth', '16', '-format', '%[fx:int(65535*r)] %[fx:int(65535*g)] %[fx:int(65535*b)]', 'info:']).toString('utf-8');
      const decodedSample = read.trim().split(/\s+/).map(Number);
      console.info(`flat PQ graphic decoded at 16 bits: ${decodedSample.join(',')}`);
      for (let c = 0; c < 3; c += 1) expect(Math.abs(decodedSample[c] - sample[c]), `channel ${c}`).toBeLessThanOrEqual(PQ_TOLERANCE_16BIT);
    },
    60_000
  );
});

describe('HDR output without the library encoder', () => {
  oracleTest(
    'the image library tags PQ with matrix 6, the matrix its own RGB to YCbCr conversion used, so a decoder returns the samples that went in',
    ['avifdec'],
    async () => {
      process.env.AVIFENC_PATH = path.join(workDir, 'no-such-avifenc');
      const side = 64;
      const sample = [40000, 24000, 12000];
      const samples = new Uint16Array(side * side * 3);
      for (let i = 0; i < samples.length; i += 1) samples[i] = sample[i % 3];
      const png16 = await sharp(samples, { raw: { width: side, height: side, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
      const { writePngCicp } = await import('../src/lib/conversions/cicp');
      const tagged = writePngCicp(png16, { primaries: 9, transfer: 16, matrix: 0, fullRange: true });
      const out = await convertImage(tagged, 'avif', { toneMap: 'none', quality: 100 }, 'pq-flat.png', 'png');
      expect(out.metadata).toMatchObject({ avifEncoder: 'image-library' });
      const file = writeIn('pq-flat-library.avif', out.buffer);
      // Retagging the file as matrix 9 would make a decoder apply BT.2020 coefficients to BT.601 samples; the tag has to stay 6.
      expect(avifInfo(file)).toMatchObject({ depth: 10, primaries: 9, transfer: 16, matrix: 6 });
      const decoded = path.join(workDir, 'pq-flat-library-decoded.png');
      execFileSync(requireOracleTool('avifdec'), ['-d', '16', file, decoded]);
      const read = runConvert([decoded, '-crop', '1x1+32+32', '+repage', '-depth', '16', '-format', '%[fx:int(65535*r)] %[fx:int(65535*g)] %[fx:int(65535*b)]', 'info:']).toString('utf-8');
      const decodedSample = read.trim().split(/\s+/).map(Number);
      for (let c = 0; c < 3; c += 1) expect(Math.abs(decodedSample[c] - sample[c]), `channel ${c}`).toBeLessThanOrEqual(PQ_TOLERANCE_16BIT);
    },
    60_000
  );
});

describe('encoder arguments', () => {
  oracleTest(
    'quality, speed, bit depth, chroma and threads reach the encoder as the policy states them, and the picture arrives as a file',
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
      expect(args).not.toContain('--stdin');
      expect(args).not.toContain('--input-format');
      expect(args[args.indexOf('-o') - 1]).toMatch(/\/in\.png$/);
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
    () =>
      withPrivateTmpdir(async (tmp) => {
        await convertImage(await grey8Graphic(), 'avif', {}, 'g.png', 'png');
        expect(readdirSync(tmp)).toEqual([]);
      }),
    60_000
  );
});

/** Sandbox-level properties of the encoder run, driven by fake tools; they need no AVIF encoder. */
describe('encoder run lifecycle', () => {
  async function request(): Promise<AvifCliRequest> {
    return { png: await grey8Graphic(), width: PHOTO_WIDTH, height: PHOTO_HEIGHT, quality: 60, effort: 3, bitdepth: 8, layout: '4:0:0' };
  }
  const rejection = (run: () => Promise<unknown>): Promise<unknown> =>
    run().then(
      () => null,
      (err: unknown) => err
    );
  const jobDirs = (tmp: string): string[] => readdirSync(tmp).filter((name) => name.startsWith('easyconvert-avif-'));
  const validAvif = (): Promise<Buffer> => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 9, b: 9 } } }).avif().toBuffer();

  it('removes the working directory when the tool fails, writes nothing or writes something that is not an AVIF', async () => {
    await withPrivateTmpdir(async (tmp) => {
      const cases = [
        { tool: failingTool('lifecycle-exit', `exit ${FAILURE_EXIT_STATUS}`), expected: /the AVIF encoder failed on the picture/ },
        { tool: failingTool('lifecycle-nothing', 'exit 0'), expected: /produced no output/ },
        { tool: failingTool('lifecycle-junk', `for last; do :; done\nprintf 'not an avif' > "$last"`), expected: /produced no AVIF file/ },
      ];
      for (const { tool, expected } of cases) {
        const failure = await rejection(async () => encodeAvifWithCli(tool.script, await request()));
        expect(failure, tool.script).toBeInstanceOf(ConversionFailedError);
        expect((failure as Error).message).toMatch(expected);
        expect(existsSync(tool.marker)).toBe(true);
        expect(jobDirs(tmp)).toEqual([]);
      }
    });
  }, 60_000);

  it('hands the picture over as a private file in the private working directory, and removes both afterwards', async () => {
    await withPrivateTmpdir(async (tmp) => {
      const seen = path.join(workDir, 'input-seen.png');
      const modes = path.join(workDir, 'input-modes.txt');
      const tool = failingTool('copies-input', `for last; do :; done\ndir=$(dirname "$last")\ncp "$dir/in.png" '${seen}'\nls -ld "$dir" "$dir/in.png" | cut -c1-10 > '${modes}'\nexit ${FAILURE_EXIT_STATUS}`);
      const req = await request();
      const failure = await rejection(async () => encodeAvifWithCli(tool.script, req));
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect(readFileSync(seen).equals(req.png)).toBe(true);
      expect(readFileSync(modes, 'utf-8').trim().split('\n')).toEqual(['drwx------', '-rw-------']);
      expect(jobDirs(tmp)).toEqual([]);
    });
  }, 60_000);

  it('kills a tool that outlives the timeout and removes the working directory', async () => {
    await withPrivateTmpdir(async (tmp) => {
      const pidFile = path.join(workDir, 'timeout.pid');
      const tool = failingTool('lifecycle-sleeps', `echo $$ > '${pidFile}'\nexec sleep 60`);
      const failure = await rejection(async () => encodeAvifWithCli(tool.script, await request(), { timeoutMs: 400 }));
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toMatch(/did not finish within 400 ms/);
      expect(await isGone(Number(readFileSync(pidFile, 'utf-8')))).toBe(true);
      expect(jobDirs(tmp)).toEqual([]);
    });
  }, 60_000);

  it('stops the tool and removes the working directory when the conversion is aborted', async () => {
    await withPrivateTmpdir(async (tmp) => {
      const pidFile = path.join(workDir, 'abort.pid');
      const tool = failingTool('abort-sleeps', `echo $$ > '${pidFile}'\nexec sleep 60`);
      process.env.AVIFENC_PATH = tool.script;
      const controller = new AbortController();
      const source = await grey8Graphic();
      const running = rejection(() => convertImage(source, 'avif', { signal: controller.signal }, 'g.png', 'png'));
      await waitFor(() => existsSync(pidFile));
      const pid = Number(readFileSync(pidFile, 'utf-8'));
      expect(await isGone(pid, 0)).toBe(false);
      controller.abort(new Error('stopped by the test'));
      expect(await running).toBeInstanceOf(Error);
      expect(await isGone(pid)).toBe(true);
      expect(jobDirs(tmp)).toEqual([]);
    });
  }, 60_000);

  it('does not start the tool when the signal is already aborted', async () => {
    await withPrivateTmpdir(async (tmp) => {
      const tool = failingTool('abort-before', 'exit 0');
      const controller = new AbortController();
      controller.abort(new Error('stopped before the start'));
      const failure = await rejection(async () => encodeAvifWithCli(tool.script, { ...(await request()), signal: controller.signal }));
      expect(failure).toBeInstanceOf(Error);
      expect(existsSync(tool.marker)).toBe(false);
      expect(jobDirs(tmp)).toEqual([]);
    });
  }, 60_000);

  it('answers with a fixed-text typed error when the working directory cannot be created', async () => {
    await withPrivateTmpdir(async (tmp) => {
      const missing = path.join(tmp, 'secret-missing-dir');
      process.env.TMPDIR = missing;
      const tool = failingTool('never-started', 'exit 0');
      const failure = await rejection(async () => encodeAvifWithCli(tool.script, await request()));
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toBe('Cannot encode the image as .avif (the encoder working directory could not be created)');
      expect(existsSync(tool.marker)).toBe(false);
    });
  });

  // skip-ok: root ignores directory permissions, so the directory cannot be made unremovable; the case needs a non-root user.
  it.skipIf(process.getuid?.() === 0)('keeps the typed error and logs a warning when the working directory cannot be removed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await withPrivateTmpdir(async (tmp) => {
        let locked: string | undefined;
        try {
          // The tool leaves a read-only directory with a file in it: the directory cannot be emptied, so removing it fails.
          const tool = failingTool('leaves-locked-dir', `mkdir sub\ntouch sub/file\nchmod 555 sub\nexit ${FAILURE_EXIT_STATUS}`);
          const failure = await rejection(async () => encodeAvifWithCli(tool.script, await request()));
          expect(failure).toBeInstanceOf(ConversionFailedError);
          expect((failure as Error).message).toMatch(/the AVIF encoder failed on the picture/);
          const left = jobDirs(tmp);
          expect(left).toHaveLength(1);
          locked = path.join(tmp, left[0], 'sub');
          expect(warn.mock.calls.map((call) => String(call[0])).some((line) => /could not remove the encoder working directory/.test(line))).toBe(true);
        } finally {
          if (locked !== undefined) chmodSync(locked, SCRIPT_MODE);
        }
      });
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it('refuses an output that is a symbolic link instead of reading what it points to', async () => {
    await withPrivateTmpdir(async (tmp) => {
      const target = writeIn('link-target.avif', await validAvif());
      const tool = failingTool('writes-symlink', `for last; do :; done\nln -s '${target}' "$last"`);
      const failure = await rejection(async () => encodeAvifWithCli(tool.script, await request()));
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toMatch(/produced no regular file/);
      expect(jobDirs(tmp)).toEqual([]);
    });
  }, 60_000);

  it('refuses an output larger than the picture can need', async () => {
    await withPrivateTmpdir(async (tmp) => {
      const valid = writeIn('padded-source.avif', await validAvif());
      // A valid AVIF followed by zeros up to well over width x height x 8 bytes plus the header allowance.
      const tool = failingTool('writes-too-much', `for last; do :; done\n{ cat '${valid}'; head -c 400000 /dev/zero; } > "$last"`);
      const failure = await rejection(async () => encodeAvifWithCli(tool.script, await request()));
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/Cannot encode the image as \.avif/);
      expect(jobDirs(tmp)).toEqual([]);
    });
  }, 60_000);

  it('passes the arguments through only for a whole-number quality from 0 to 100', async () => {
    const base = await request();
    const argsFor = (quality: number): string[] => avifencArguments({ ...base, quality }, '/in.png', '/out.avif');
    for (const bad of [Number.NaN, 55.5, -1, 101, Number.POSITIVE_INFINITY]) {
      expect(() => argsFor(bad), `quality ${bad}`).toThrow(ConversionFailedError);
    }
    const valid = argsFor(55);
    expect(valid[valid.indexOf('-q') + 1]).toBe('55');
  });

  it('never gives the encoder more than the thread cap, however many cores the host has', async () => {
    const base = await request();
    const threadsOn = (cores: number): number => {
      const cpus = vi.spyOn(os, 'availableParallelism').mockReturnValue(cores);
      try {
        const args = avifencArguments(base, '/in.png', '/out.avif');
        return Number(args[args.indexOf('-j') + 1]);
      } finally {
        cpus.mockRestore();
      }
    };
    expect(threadsOn(1)).toBe(1);
    expect(threadsOn(4)).toBe(4);
    expect(threadsOn(AVIFENC_MAX_THREADS)).toBe(AVIFENC_MAX_THREADS);
    expect(threadsOn(96)).toBe(AVIFENC_MAX_THREADS);
  });
});

const envWith = (tool: string): NodeJS.ProcessEnv => ({ ...process.env, AVIFENC_PATH: tool });

describe('finding the encoder', () => {
  /** A fake tool that answers `--version` with `answer` and, asked anything else, records that it ran. */
  function versionTool(name: string, answer: string): string {
    const script = writeIn(name, `#!/bin/sh\n[ "$1" = "--version" ] && { printf '%s\\n' '${answer}'; exit 0; }\nexit ${FAILURE_EXIT_STATUS}\n`);
    chmodSync(script, SCRIPT_MODE);
    return script;
  }

  it('accepts only the absolute path of an executable regular file and says once when AVIFENC_PATH is set to anything else', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const executable = failingTool('find-executable', 'exit 0').script;
      const plain = writeIn('find-plain', '#!/bin/sh\nexit 0\n');
      chmodSync(plain, 0o644);
      const directory = path.join(workDir, 'find-directory');
      mkdirSync(directory, { mode: SCRIPT_MODE });
      expect(await findAvifenc(envWith(executable))).toBe(executable);
      expect(warn).not.toHaveBeenCalled();
      for (const unusable of ['avifenc', './find-executable', plain, directory, path.join(workDir, 'find-missing')]) {
        expect(await findAvifenc(envWith(unusable)), unusable).toBeNull();
        expect(await findAvifenc(envWith(unusable)), unusable).toBeNull();
      }
      expect(warn).toHaveBeenCalledTimes(5);
      expect(String(warn.mock.calls[0][0])).toMatch(/AVIFENC_PATH is set but is not the absolute path of an executable file/);
    } finally {
      warn.mockRestore();
    }
  });

  it('counts a libavif older than 1.0.0 as not installed, because it has no -q and --qalpha, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const old = versionTool('find-v0-11-1', 'Version: 0.11.1 (aom [enc/dec]:3.5.0)');
      expect(await findAvifenc(envWith(old))).toBeNull();
      expect(await findAvifenc(envWith(old))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/libavif 0\.11\.1.*1\.0\.0 or newer/);
      const unreadable = versionTool('find-no-version', 'avifenc, a program');
      expect(await findAvifenc(envWith(unreadable))).toBeNull();
      for (const supported of ['Version: 1.0.0 (aom)', 'Version: 1.0.4 (aom)', 'Version: 1.2.1 (aom)', 'Version: 1.4.2 (aom)', 'Version: 2.0.0 (aom)', 'Version: 1.10.0 (aom)']) {
        const tool = versionTool(`find-${supported.replace(/\W+/g, '-')}`, supported);
        expect(await findAvifenc(envWith(tool)), supported).toBe(tool);
      }
      const justBelow = versionTool('find-v0-99-9', 'Version: 0.99.9 (aom)');
      expect(await findAvifenc(envWith(justBelow))).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  oracleTest(
    'a conversion with an old tool is written by the image library instead of failing, and the tool is never given a picture',
    ['avifdec'],
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        process.env.AVIFENC_PATH = versionTool('convert-v0-11-1', 'Version: 0.11.1 (aom)');
        const out = await convertImage(await interface16(), 'avif', { quality: 60 }, 'ui.png', 'png');
        expect(out.metadata).toMatchObject({ avifEncoder: 'image-library' });
        expect(avifInfo(writeIn('old-tool.avif', out.buffer))).toMatchObject({ format: 'YUV444', depth: 10 });
      } finally {
        warn.mockRestore();
      }
    },
    60_000
  );
});
