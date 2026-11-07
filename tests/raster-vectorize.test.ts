import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { convertFile } from '../src/lib/conversions';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { VECTORIZE_MAX_OUTPUT_BYTES } from '../src/lib/conversions/raster-vectorize';
import { VECTORIZE_SOURCES, type VectorizeOptions } from '../src/lib/conversions/raster-vectorize-options';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { resolveResourceClass } from '../src/lib/queue/resource-class';
import { JOB_DEADLINE_AT } from '../src/lib/conversions/job-time';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import {
  ConversionFailedError,
  CpuTaskTimeoutError,
  EngineMissingError,
  EngineUnavailableError,
  PayloadLimitError,
  typedFailureOf,
  UnsupportedOptionError,
} from '../src/lib/types';
import { craftBmp, storedRowBytes } from './helpers/bmp-craft';
import { captureError } from './helpers/capture-error';
import { getOracleToolPath } from './helpers/differential-oracle';
import { skipUnless } from './helpers/strict-skip';

/**
 * Raster pictures traced to SVG by the pinned vtracer program. The wrapper is judged with stand-in programs (shell scripts that fail in
 * each way a real program can, or record what they were given); the real program, when installed, is judged through the public route
 * and by what each option visibly does to the SVG, against properties of the pictures drawn here (their colours, their straight edges).
 */

/** What each run of a program in the sandbox was given, recorded on the way to the real sandbox: its limits are what the sandbox enforces. */
const sandboxRuns = vi.hoisted(() => [] as Array<{ options: Record<string, unknown> }>);
vi.mock('../src/worker/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/worker/sandbox')>();
  return {
    ...actual,
    executeSandboxedBinary: (...call: Parameters<typeof actual.executeSandboxedBinary>) => {
      sandboxRuns.push({ options: { ...call[2] } });
      return actual.executeSandboxedBinary(...call);
    },
  };
});

const vtracer = getOracleToolPath('vtracer');
const haveTracer = !skipUnless('vtracer', vtracer !== null);

const WIDTH = 240;
const HEIGHT = 160;
const RED = { r: 0xe0, g: 0x10, b: 0x10 };
const BLUE = { r: 0x10, g: 0x30, b: 0xd0 };
const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#204080"/><stop offset="1" stop-color="#f0c040"/></linearGradient></defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/><rect x="0" y="120" width="${WIDTH}" height="40" fill="url(#g)"/>
  <circle cx="70" cy="60" r="40" fill="#e01010"/><rect x="140" y="20" width="70" height="70" fill="#1030d0"/></svg>`;

const scratch: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** Seeded noise (mulberry32), so every run traces the same picture. */
function seededNoise(width: number, height: number, channels: number, seed: number): Buffer {
  let state = seed;
  const bytes = Buffer.alloc(width * height * channels);
  for (let index = 0; index < bytes.length; index++) {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    bytes[index] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return bytes;
}

let clean: Buffer;
let noisy: Buffer;
beforeAll(async () => {
  clean = await sharp(Buffer.from(SCENE)).png().toBuffer();
  const grain = seededNoise(WIDTH, HEIGHT, 3, 7).map((value) => 96 + (value >> 2));
  const noise = await sharp(grain, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png().toBuffer();
  noisy = await sharp(clean).composite([{ input: noise, blend: 'soft-light' }]).png().toBuffer();
});
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** The wrapper judged here is the one that runs the release program, so the vtracer-pixels program is switched off (an empty path finds none). */
async function withTracer<T>(program: string | undefined, body: () => Promise<T>): Promise<T> {
  const before = { tracer: process.env.VTRACER_PATH, pixels: process.env.VTRACER_PIXELS_PATH };
  if (program === undefined) delete process.env.VTRACER_PATH;
  else process.env.VTRACER_PATH = program;
  process.env.VTRACER_PIXELS_PATH = '';
  try {
    return await body();
  } finally {
    if (before.tracer === undefined) delete process.env.VTRACER_PATH;
    else process.env.VTRACER_PATH = before.tracer;
    if (before.pixels === undefined) delete process.env.VTRACER_PIXELS_PATH;
    else process.env.VTRACER_PIXELS_PATH = before.pixels;
  }
}

/** A shell script that stands in for the tracer; `$in` and `$out` hold the paths it was given. */
function standIn(body: string): string {
  const file = path.join(tmpDir('vtracer-standin-'), 'vtracer');
  const parse = 'in=""; out=""; for a in "$@"; do case "$prev" in --input) in="$a";; --output) out="$a";; esac; prev="$a"; done';
  fs.writeFileSync(file, `#!/bin/sh\n${parse}\n${body}\n`, { mode: 0o755 });
  return file;
}

/** The 30 s stand-in must be stopped long before it ends: a bound only a hang crosses. */
const STOP_HANG_GUARD_MS = 10_000;
const MINIMAL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><path d="M0,0h4v4h-4z" fill="#000000"/></svg>';
const writesMinimalSvg = (): string => standIn(`printf '%s' '${MINIMAL_SVG}' > "$out"`);
/** A stand-in that writes an SVG, and whether it was started. */
const started = (): { program: string; ran: () => boolean } => {
  const marker = path.join(tmpDir('vtracer-ran-'), 'ran');
  return { program: standIn(`touch '${marker}'\nprintf '%s' '${MINIMAL_SVG}' > "$out"`), ran: () => fs.existsSync(marker) };
};

const vectorize = (input: Buffer, source = 'png', options: VectorizeOptions | undefined = undefined) =>
  convertFile(input, source, 'svg', options === undefined ? {} : { vectorize: options }, `picture.${source}`);

interface Trace {
  bytes: number;
  paths: number;
  fills: Set<string>;
  hasCurves: boolean;
}

function traceOf(svg: Buffer): Trace {
  const text = svg.toString('utf8');
  const commands = (text.match(/ d="[^"]*"/g) ?? []).join('');
  return {
    bytes: svg.length,
    paths: (text.match(/<path\b/g) ?? []).length,
    fills: new Set((text.match(/fill="#[0-9A-Fa-f]{6}"/g) ?? []).map((fill) => fill.slice(6, 13).toUpperCase())),
    hasCurves: /[CcSs]/.test(commands),
  };
}

const near = (hex: string, colour: { r: number; g: number; b: number }, within: number): boolean => {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = value >> 16;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return Math.abs(r - colour.r) <= within && Math.abs(g - colour.g) <= within && Math.abs(b - colour.b) <= within;
};

describe('the raster to SVG pairs', () => {
  it('are offered for exactly the raster inputs the reference serves with the same engine', () => {
    const traced = ['bmp', 'gif', 'jpeg', 'jpg', 'png', 'tif', 'tiff', 'webp'];
    expect([...VECTORIZE_SOURCES].sort()).toEqual(traced);
    for (const source of traced) expect(FORMAT_REGISTRY[source].targetFormats).toContain('svg');
  });

  it('run on the CPU lane whatever the file size, since a small compressible picture can trace for seconds with gigabytes', () => {
    for (const source of VECTORIZE_SOURCES) {
      for (const bytes of [1_000, 5 * 1024 * 1024, 60 * 1024 * 1024]) expect(resolveResourceClass(source, 'svg', bytes, {}), `${source} ${bytes}`).toBe('cpu');
    }
    expect(resolveResourceClass('png', 'webp', 1_000, {})).toBe('light');
  });
});

describe('the tracer program, as the wrapper sees it', () => {
  it('answers engine-unavailable (503, retried on another worker) when the program is not installed', async () => {
    const failure = await withTracer('/nonexistent/vtracer', () => captureError(() => vectorize(clean)));
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect(failure).toBeInstanceOf(EngineMissingError);
    expect((failure as EngineUnavailableError).engineName).toBe('vtracer');
  });

  it('hands the program a PNG of the first frame and only the options the request set, in the engine spelling', async () => {
    const seen = path.join(tmpDir('vtracer-seen-'), 'seen');
    const program = standIn(`printf '%s\\n' "$@" > '${seen}.args'\ncp "$in" '${seen}.png'\nprintf '%s' '${MINIMAL_SVG}' > "$out"`);
    const frames = Buffer.concat([Buffer.alloc(16 * 16 * 3, 0), Buffer.alloc(16 * 16 * 3, 255)]);
    const gif = await sharp(frames, { raw: { width: 16, height: 32, channels: 3, pageHeight: 16 } }).gif().toBuffer();
    await withTracer(program, () => vectorize(gif, 'gif', { preset: 'photo', colorPrecision: 3, simplify: 1.5 }));
    const args = fs.readFileSync(`${seen}.args`, 'utf8').trim().split('\n');
    expect(args.slice(0, -4)).toEqual(['--preset', 'photo', '--color-precision', '3', '--simplify', '1.5']);
    expect([args.at(-4), args.at(-2)]).toEqual(['--input', '--output']);
    const staged = await sharp(fs.readFileSync(`${seen}.png`)).raw().toBuffer({ resolveWithObject: true });
    expect(staged.info).toMatchObject({ format: 'raw', width: 16, height: 16, channels: 4 });
    expect([...staged.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
  });

  it('sends no option flag when the request sets none, so the engine defaults apply', async () => {
    const seen = path.join(tmpDir('vtracer-seen-'), 'args');
    const program = standIn(`printf '%s\\n' "$@" > '${seen}'\nprintf '%s' '${MINIMAL_SVG}' > "$out"`);
    await withTracer(program, () => vectorize(clean));
    expect(fs.readFileSync(seen, 'utf8').trim().split('\n').filter((arg) => arg.startsWith('--'))).toEqual(['--input', '--output']);
  });

  it('returns the SVG the program wrote without scripts, event handlers or external references', async () => {
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" onload="alert(1)"><script>alert(2)</script><path d="M0,0h4v4h-4z" fill="url(https://example.com/x)"/></svg>';
    const program = standIn(`cat > "$out" <<'EOF'\n${hostile}\nEOF`);
    const result = await withTracer(program, () => vectorize(clean));
    const svg = result.buffer.toString('utf8');
    expect(result.mimeType).toBe('image/svg+xml');
    expect(result.filename).toBe('picture.svg');
    expect(svg).toContain('<path d="M0,0h4v4h-4z"');
    expect(svg).not.toMatch(/<script|onload|example\.com/i);
  });

  it('answers a typed failure without the scratch path when the program exits with an error', async () => {
    const program = standIn('echo "Conversion failed: cannot read $in" >&2; exit 1');
    const failure = await withTracer(program, () => captureError(() => vectorize(clean)));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(EngineMissingError);
    expect(failure.message).toContain('exited with status 1');
    expect(failure.message).not.toContain(os.tmpdir());
  });

  it.each([
    ['writes nothing', 'exit 0', 'The SVG tracer wrote no SVG from this picture.'],
    ['writes something that is no SVG', `printf 'not an svg' > "$out"`, 'The SVG tracer wrote something that is not an SVG document.'],
  ])('answers a typed failure when the program %s', async (_name, body, message) => {
    const failure = await withTracer(standIn(body), () => captureError(() => vectorize(clean)));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(EngineMissingError);
    expect(failure.message).toBe(message);
  });

  it('refuses an SVG past the output limit (413) instead of returning part of it', async () => {
    // The writer is the program itself (exec), so where the file-size limit applies it is the program the limit stops.
    const program = standIn(`exec head -c ${VECTORIZE_MAX_OUTPUT_BYTES + 1} /dev/zero > "$out"`);
    const failure = await withTracer(program, () => captureError(() => vectorize(clean)));
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as PayloadLimitError).status).toBe(413);
  });

  it('refuses a trace that runs out of the memory limit (413), as the engine reports a failed allocation', async () => {
    const program = standIn(`echo "memory allocation of 4294967296 bytes failed" >&2; kill -ABRT $$`);
    const failure = await withTracer(program, () => captureError(() => vectorize(clean)));
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as PayloadLimitError).status).toBe(413);
    expect(failure.message).toMatch(/^Tracing this picture needs more than the 2048 MB the SVG tracer may use\./);
  });

  it('reports a program that crashes with SIGSEGV as a failed trace that names the signal, not as a memory refusal', async () => {
    const failure = await withTracer(standIn('kill -SEGV $$'), () => captureError(() => vectorize(clean)));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(PayloadLimitError);
    expect(failure.message).toBe('The SVG tracer could not trace this picture: it was stopped by SIGSEGV.');
    expect(typedFailureOf(failure)).toEqual({ status: 400, code: 'conversion_failed' });
  });

  it('runs the program without a network, under the measured memory, output, diagnostics and time limits', async () => {
    sandboxRuns.length = 0;
    await withTracer(writesMinimalSvg(), () => vectorize(clean));
    expect(sandboxRuns).toHaveLength(1);
    expect(sandboxRuns[0].options).toMatchObject({ networkIsolated: true, memoryLimitMb: 2048, maxFileSize: 32 * 1024 * 1024, maxBuffer: 64 * 1024, timeoutMs: 120_000 });
  });

  it('stops a program that overruns the time of the conversion, with a typed timeout and without waiting for it', async () => {
    const started = Date.now();
    const failure = await withTracer(standIn('sleep 30'), () => captureError(() => convertFile(clean, 'png', 'svg', { timeoutMs: 700 }, 'p.png')));
    expect(failure).toBeInstanceOf(CpuTaskTimeoutError);
    expect(Date.now() - started).toBeLessThan(STOP_HANG_GUARD_MS);
  });

  it('leaves no scratch directory behind', async () => {
    const privateTmp = tmpDir('vtracer-private-tmp-');
    const succeeds = writesMinimalSvg();
    const fails = standIn('exit 1');
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = privateTmp;
    try {
      await withTracer(succeeds, () => vectorize(clean));
      await withTracer(fails, () => vectorize(clean).catch(() => undefined));
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    expect(fs.readdirSync(privateTmp)).toEqual([]);
  });
});

/** A run-length BMP of `side` x `side` pixels of colour 0: runs of 255 pixels per row, so the file is about 8 bytes per 1000 pixels. */
function runLengthBmp(side: number): Buffer {
  const stream: number[] = [];
  for (let row = 0; row < side; row++) {
    for (let left = side; left > 0; left -= 255) stream.push(Math.min(255, left), 0);
    stream.push(0, 0);
  }
  stream.push(0, 1);
  return craftBmp({ width: side, height: side, bitCount: 8, compression: 1, palette: [[0, 0, 0], [255, 255, 255]], pixels: Uint8Array.from(stream) });
}

/** A BMP (V5 header) of `width` x `height` pixels of one RGB colour, with an embedded ICC profile. */
function profiledBmp(width: number, height: number, rgb: readonly number[], icc: Buffer): Buffer {
  const rowBytes = storedRowBytes(width, 24);
  const pixels = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([rgb[2], rgb[1], rgb[0]], y * rowBytes + x * 3);
  return craftBmp({ width, height, bitCount: 24, pixels, header: 124, icc: new Uint8Array(icc) });
}

describe('inputs refused before the program starts', () => {
  it('refuses a picture over the 16 megapixel budget of tracing (413) from its header', async () => {
    const huge = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 9 }).toBuffer();
    const { program, ran } = started();
    const failure = await withTracer(program, () => captureError(() => vectorize(huge)));
    expect(failure).toBeInstanceOf(InputPixelLimitError);
    expect((failure as InputPixelLimitError).status).toBe(413);
    expect(ran()).toBe(false);
  });

  it('refuses bytes that do not decode as a picture, with a typed failure', async () => {
    const truncated = clean.subarray(0, 60);
    const { program, ran } = started();
    const failure = await withTracer(program, () => captureError(() => vectorize(truncated)));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure.message).toMatch(/^Invalid image/);
    expect(ran()).toBe(false);
  });

  it.each<[string, unknown]>([
    ['an unknown preset', { preset: 'sketch' }],
    ['an unknown mode', { mode: 'bezier' }],
    ['a speckle filter past 128', { filterSpeckle: 129 }],
    ['a fractional speckle filter', { filterSpeckle: 2.5 }],
    ['a colour precision of 0', { colorPrecision: 0 }],
    ['a tolerance of 0', { simplify: 0 }],
    ['an option of another tracer', { gradientStep: 16 }],
    ['options that are not an object', 'photo'],
  ])('refuses %s as an unsupported option (400)', async (_name, raw) => {
    const { program, ran } = started();
    const failure = await withTracer(program, () => captureError(() => convertFile(clean, 'png', 'svg', { vectorize: raw as VectorizeOptions }, 'p.png')));
    expect(failure).toBeInstanceOf(UnsupportedOptionError);
    expect(ran()).toBe(false);
  });

  it('refuses a small run-length BMP that declares more than 16 megapixels before it allocates the picture', async () => {
    const bomb = runLengthBmp(10_000);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const { program, ran } = started();
    const before = process.memoryUsage().arrayBuffers;
    const failure = await withTracer(program, () => captureError(() => vectorize(bomb, 'bmp')));
    const allocated = process.memoryUsage().arrayBuffers - before;
    expect(failure).toBeInstanceOf(InputPixelLimitError);
    expect((failure as InputPixelLimitError).status).toBe(413);
    expect(allocated).toBeLessThan(50 * 1024 * 1024);
    expect(ran()).toBe(false);
  });

  it('answers engine-unavailable for a missing program before it decodes the picture', async () => {
    const failure = await withTracer('/nonexistent/vtracer', () => captureError(() => vectorize(clean.subarray(0, 60))));
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect((failure as EngineUnavailableError).engineName).toBe('vtracer');
  });

  it('stops a cancelled conversion with its reason before the picture is staged', async () => {
    const { program, ran } = started();
    const controller = new AbortController();
    const reason = new Error('cancelled by the caller');
    controller.abort(reason);
    const failure = await withTracer(program, () => captureError(() => convertFile(clean, 'png', 'svg', { signal: controller.signal }, 'p.png')));
    expect(failure).toBe(reason);
    expect(ran()).toBe(false);
  });

  it('stops a conversion whose job deadline has passed with a typed timeout, without starting the program', async () => {
    const { program, ran } = started();
    const failure = await withTracer(program, () => captureError(() => convertFile(clean, 'png', 'svg', { [JOB_DEADLINE_AT]: Date.now() - 1 } as never, 'p.png')));
    expect(failure).toBeInstanceOf(CpuTaskTimeoutError);
    expect(failure.message).toBe('The conversion ran out of time before the SVG tracer could start.');
    expect(ran()).toBe(false);
  });
});

describe('what the program reads', () => {
  /** The PNG the program was handed for `input`, decoded: its header and its first pixel. */
  async function staged(input: Buffer, source: string) {
    const copy = path.join(tmpDir('vtracer-staged-'), 'staged.png');
    await withTracer(standIn(`cp "$in" '${copy}'\nprintf '%s' '${MINIMAL_SVG}' > "$out"`), () => vectorize(input, source));
    const png = fs.readFileSync(copy);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    return { meta: await sharp(png).metadata(), info, first: [...data.subarray(0, 4)] };
  }
  const RGB_RED = { r: 200, g: 40, b: 40 };
  const twoFrames = (side: number) => sharp(Buffer.concat([Buffer.alloc(side * side * 3, 0), Buffer.alloc(side * side * 3, 255)]), { raw: { width: side, height: side * 2, channels: 3, pageHeight: side } });

  it('is the picture turned upright by its EXIF orientation', async () => {
    const turned = await sharp({ create: { width: 64, height: 32, channels: 3, background: RGB_RED } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const { info } = await staged(turned, 'jpg');
    expect([info.width, info.height]).toEqual([32, 64]);
  });

  it.each<[string, string, () => Promise<Buffer>]>([
    ['a 16-bit PNG', 'png', () => sharp({ create: { width: 16, height: 16, channels: 3, background: RGB_RED } }).toColourspace('rgb16').png().toBuffer()],
    ['a CMYK JPEG', 'jpg', () => sharp({ create: { width: 16, height: 16, channels: 3, background: RGB_RED } }).toColourspace('cmyk').jpeg().toBuffer()],
    ['a palette PNG', 'png', () => sharp({ create: { width: 16, height: 16, channels: 3, background: RGB_RED } }).png({ palette: true }).toBuffer()],
  ])('is 8-bit sRGB with alpha for %s, in the colour it shows', async (_name, source, encode) => {
    const { meta, first } = await staged(await encode(), source);
    expect(meta).toMatchObject({ depth: 'uchar', channels: 4, space: 'srgb' });
    expect(first.slice(0, 3).map((value, index) => Math.abs(value - [RGB_RED.r, RGB_RED.g, RGB_RED.b][index]))).toSatisfy((gaps: number[]) => gaps.every((gap) => gap <= 24));
    expect(first[3]).toBe(255);
  });

  it.each([
    ['the first page of a multi-page TIFF', 'tiff', (side: number) => twoFrames(side).tiff().toBuffer()],
    ['the first frame of an animated WebP', 'webp', (side: number) => twoFrames(side).webp({ lossless: true }).toBuffer()],
  ])('is %s', async (_name, source, encode) => {
    const { info, first } = await staged(await encode(16), source);
    expect([info.width, info.height]).toEqual([16, 16]);
    expect(first).toEqual([0, 0, 0, 255]);
  });

  it('is a BMP with an embedded profile converted to sRGB', async () => {
    const colour = { r: 200, g: 100, b: 50 };
    const p3 = await sharp({ create: { width: 8, height: 8, channels: 3, background: colour } }).withIccProfile('p3').png().toBuffer();
    const p3Values = [...(await sharp(p3, { ignoreIcc: true }).raw().toBuffer()).subarray(0, 3)];
    const { first } = await staged(profiledBmp(8, 8, p3Values, (await sharp(p3).metadata()).icc as Buffer), 'bmp');
    expect(p3Values).not.toEqual([colour.r, colour.g, colour.b]);
    expect(first.slice(0, 3).map((value, index) => Math.abs(value - [colour.r, colour.g, colour.b][index]))).toSatisfy((gaps: number[]) => gaps.every((gap) => gap <= 2));
  });
});

describe.skipIf(!haveTracer)('the pinned tracer', () => {
  beforeAll(() => {
    process.env.VTRACER_PATH ??= vtracer as string;
  });

  async function encodings(): Promise<Record<string, Buffer>> {
    const rgb = await sharp(clean).removeAlpha().raw().toBuffer();
    const rowBytes = storedRowBytes(WIDTH, 24);
    const pixels = new Uint8Array(rowBytes * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const from = ((HEIGHT - 1 - y) * WIDTH + x) * 3;
        const to = y * rowBytes + x * 3;
        pixels.set([rgb[from + 2], rgb[from + 1], rgb[from]], to);
      }
    }
    const jpeg = await sharp(clean).jpeg({ quality: 95 }).toBuffer();
    const tiff = await sharp(clean).tiff().toBuffer();
    return {
      png: clean,
      jpg: jpeg,
      jpeg,
      webp: await sharp(clean).webp({ lossless: true }).toBuffer(),
      gif: await sharp(clean).gif().toBuffer(),
      bmp: craftBmp({ width: WIDTH, height: HEIGHT, bitCount: 24, pixels }),
      tif: tiff,
      tiff,
    };
  }

  async function account(): Promise<string> {
    const user = await userStore.createUser({ name: 'vectorize', email: `vectorize_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`, tier: 'free' });
    return (await redisKeyStore.generateApiKey(user.id, 'vectorize', { scopes: ['convert:write', 'convert:read'] })).secretKey;
  }

  function post(file: Buffer, name: string, key: string, options?: unknown): NextRequest {
    const body = new FormData();
    body.append('file', new Blob([new Uint8Array(file)]), name);
    body.append('targetFormat', 'svg');
    if (options !== undefined) body.append('options', JSON.stringify(options));
    return new NextRequest('http://localhost/api/v1/convert?raw=true', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body });
  }

  it('converts each raster pair through POST /api/v1/convert into an SVG of the same size with the picture shapes in their colours', async () => {
    const key = await account();
    for (const [source, bytes] of Object.entries(await encodings())) {
      const response = await v1ConvertPost(post(bytes, `scene.${source}`, key));
      expect(response.status, source).toBe(200);
      expect(response.headers.get('content-type'), source).toContain('image/svg+xml');
      const svg = Buffer.from(await response.arrayBuffer());
      expect(svg.toString('utf8'), source).toContain(`width="${WIDTH}" height="${HEIGHT}"`);
      const fills = [...traceOf(svg).fills];
      expect(fills.some((fill) => near(fill, RED, 24)), `${source}: ${fills.join(' ')}`).toBe(true);
      expect(fills.some((fill) => near(fill, BLUE, 24)), `${source}: ${fills.join(' ')}`).toBe(true);
    }
  });

  it('answers 422 through the route for options the schema does not allow', async () => {
    const response = await v1ConvertPost(post(clean, 'scene.png', await account(), { vectorize: { colorPrecision: 9 } }));
    expect(response.status).toBe(422);
  });

  describe('each option changes the SVG the way the engine documents it', () => {
    let base: Trace;
    beforeAll(async () => {
      base = traceOf((await vectorize(noisy)).buffer);
    });
    const traced = async (options: VectorizeOptions) => traceOf((await vectorize(noisy, 'png', options)).buffer);

    it('the bw preset traces black shapes only', async () => {
      expect([...(await traced({ preset: 'bw' })).fills]).toEqual(['#000000']);
      expect(base.fills.size).toBeGreaterThan(1);
    });

    it('the poster preset keeps more colours, the photo preset fewer and larger shapes', async () => {
      expect((await traced({ preset: 'poster' })).fills.size).toBeGreaterThan(base.fills.size);
      expect((await traced({ preset: 'photo' })).paths).toBeLessThan(base.paths);
    });

    it('polygon and pixel modes draw straight edges only, where spline draws curves', async () => {
      expect(base.hasCurves).toBe(true);
      expect((await traced({ mode: 'polygon' })).hasCurves).toBe(false);
      expect((await traced({ mode: 'pixel' })).hasCurves).toBe(false);
    });

    it('a smaller speckle filter keeps more patches and a larger one fewer', async () => {
      expect((await traced({ filterSpeckle: 0 })).paths).toBeGreaterThan(base.paths);
      expect((await traced({ filterSpeckle: 16 })).paths).toBeLessThan(base.paths);
    });

    it('a lower colour precision gives fewer colours', async () => {
      expect((await traced({ colorPrecision: 2 })).fills.size).toBeLessThan(base.fills.size);
    });

    it('simplify writes the same shapes with fewer curve segments', async () => {
      const simplified = await traced({ simplify: 2.5 });
      expect(simplified.paths).toBe(base.paths);
      expect(simplified.bytes).toBeLessThan(base.bytes);
    });

    it('an explicit value overrides the preset', async () => {
      expect((await traced({ preset: 'photo', filterSpeckle: 0 })).paths).toBeGreaterThan((await traced({ preset: 'photo' })).paths);
    });
  });

  it('refuses noise traced with every shape kept, once its SVG passes the output limit, with a typed 413', async () => {
    const side = 800;
    const noise = await sharp(seededNoise(side, side, 3, 11), { raw: { width: side, height: side, channels: 3 } }).png().toBuffer();
    const failure = await captureError(() => vectorize(noise, 'png', { preset: 'poster', filterSpeckle: 0, mode: 'pixel' }));
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as PayloadLimitError).status).toBe(413);
    expect(failure.message).toBe(`The SVG traced from this picture is larger than ${VECTORIZE_MAX_OUTPUT_BYTES} bytes. Raise filterSpeckle or lower colorPrecision for fewer shapes.`);
  }, 60_000);
});
