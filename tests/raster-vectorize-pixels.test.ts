import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import type { VectorizeOptions } from '../src/lib/conversions/raster-vectorize-options';
import { EngineUnavailableError } from '../src/lib/types';
import { captureError } from './helpers/capture-error';
import { getOracleToolPath } from './helpers/differential-oracle';
import { skipUnless } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in programs of this suite write their records outside the job directory, which the file confinement refuses (policy 248).
runWithoutFileConfinement();

/**
 * The worker hands the tracer the pixels it decoded, to vtracer-pixels (scripts/vtracer-pixels) when the worker has it and as a PNG to the
 * release program otherwise. The wrapper is judged with stand-in programs that record what they were given; the two real programs, when
 * installed, are judged against each other: the SVG must be the same bytes for every picture and every option.
 */

const vtracer = getOracleToolPath('vtracer');
const pixelsProgram = getOracleToolPath('vtracer-pixels');
const haveBoth = !skipUnless('vtracer and vtracer-pixels', vtracer !== null && pixelsProgram !== null);

const ROOT = path.resolve(__dirname, '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const MINIMAL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><path d="M0,0h4v4h-4z" fill="#000000"/></svg>';
/** A stand-in that copies the file it was given to `copy`, keeps its arguments in `arguments` and writes an SVG. */
function recorder(): { program: string; copy: string; arguments: string } {
  const dir = tmpDir('vtracer-recorder-');
  const copy = path.join(dir, 'given');
  const args = path.join(dir, 'arguments');
  const parse = 'in=""; out=""; for a in "$@"; do case "$prev" in --input) in="$a";; --output) out="$a";; esac; prev="$a"; done';
  const program = path.join(dir, 'program');
  fs.writeFileSync(program, `#!/bin/sh\n${parse}\nprintf '%s\\n' "$@" > '${args}'\ncp "$in" '${copy}'\nprintf '%s' '${MINIMAL_SVG}' > "$out"\n`, { mode: 0o755 });
  return { program, copy, arguments: args };
}

async function withPrograms<T>(programs: { tracer?: string; pixels?: string }, body: () => Promise<T>): Promise<T> {
  const before = { tracer: process.env.VTRACER_PATH, pixels: process.env.VTRACER_PIXELS_PATH };
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  set('VTRACER_PATH', programs.tracer ?? '');
  set('VTRACER_PIXELS_PATH', programs.pixels ?? '');
  try {
    return await body();
  } finally {
    set('VTRACER_PATH', before.tracer);
    set('VTRACER_PIXELS_PATH', before.pixels);
  }
}

const RED = { r: 200, g: 40, b: 40 };
const solid = (channels: 3 | 4 = 3) => sharp({ create: { width: 24, height: 16, channels, background: channels === 4 ? { ...RED, alpha: 0.5 } : RED } });
/** Pictures that reach the tracer through different decoders and conversions. */
const PICTURES: Array<[string, string, () => Promise<Buffer>]> = [
  ['a 16-bit RGBA PNG', 'png', () => solid(4).toColourspace('rgb16').png().toBuffer()],
  ['a 16-bit grey PNG with alpha', 'png', () => sharp({ create: { width: 24, height: 16, channels: 4, background: { r: 90, g: 90, b: 90, alpha: 0.7 } } }).toColourspace('b-w').png().toBuffer()],
  ['a palette PNG', 'png', () => solid().png({ palette: true }).toBuffer()],
  ['a CMYK JPEG', 'jpg', () => solid().toColourspace('cmyk').jpeg().toBuffer()],
  ['a JPEG turned by its EXIF orientation', 'jpg', () => solid().jpeg().withMetadata({ orientation: 6 }).toBuffer()],
  ['a lossless WebP with alpha', 'webp', () => solid(4).webp({ lossless: true }).toBuffer()],
  ['a GIF', 'gif', () => solid().gif().toBuffer()],
  ['a TIFF', 'tiff', () => solid().tiff().toBuffer()],
];

const vectorize = (input: Buffer, source: string, options: VectorizeOptions = {}) => convertFile(input, source, 'svg', { vectorize: options }, `picture.${source}`);

describe('the tracer is handed the pixels it traces', () => {
  it('reads vtracer-pixels first: the width and the height as little-endian u32, then the RGBA bytes, in the file named by --input', async () => {
    const pixels = recorder();
    const png = await sharp(Buffer.alloc(7 * 5 * 3, 200), { raw: { width: 7, height: 5, channels: 3 } }).png().toBuffer();
    await withPrograms({ tracer: '/nonexistent/vtracer', pixels: pixels.program }, () => vectorize(png, 'png', { preset: 'photo', filterSpeckle: 9 }));
    const given = fs.readFileSync(pixels.copy);
    expect([given.readUInt32LE(0), given.readUInt32LE(4)]).toEqual([7, 5]);
    expect(given.length).toBe(8 + 7 * 5 * 4);
    expect([...given.subarray(8, 12)]).toEqual([200, 200, 200, 255]);
    const args = fs.readFileSync(pixels.arguments, 'utf8').trim().split('\n');
    expect(args.slice(0, 4)).toEqual(['--preset', 'photo', '--filter-speckle', '9']);
    expect(args.slice(4).filter((_, index) => index % 2 === 0)).toEqual(['--input', '--output']);
  });

  it('falls back to the release program, which gets a PNG, when vtracer-pixels is not there', async () => {
    const release = recorder();
    const png = await sharp(Buffer.alloc(7 * 5 * 3, 200), { raw: { width: 7, height: 5, channels: 3 } }).png().toBuffer();
    await withPrograms({ tracer: release.program, pixels: '/nonexistent/vtracer-pixels' }, () => vectorize(png, 'png'));
    expect([...fs.readFileSync(release.copy).subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('answers 503 before decoding when neither program is there', async () => {
    const failure = await withPrograms({ tracer: '/nonexistent/vtracer', pixels: '/nonexistent/vtracer-pixels' }, () => captureError(() => vectorize(Buffer.from('not a picture'), 'png')));
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect((failure as EngineUnavailableError).engineName).toBe('vtracer');
  });

  it.each(PICTURES)('gives vtracer-pixels the pixels the release program reads from its PNG, for %s', async (_name, source, encode) => {
    const picture = await encode();
    const pixels = recorder();
    const release = recorder();
    await withPrograms({ pixels: pixels.program }, () => vectorize(picture, source));
    await withPrograms({ tracer: release.program }, () => vectorize(picture, source));
    const raw = fs.readFileSync(pixels.copy);
    const { data, info } = await sharp(fs.readFileSync(release.copy)).raw().toBuffer({ resolveWithObject: true });
    expect([raw.readUInt32LE(0), raw.readUInt32LE(4), info.channels]).toEqual([info.width, info.height, 4]);
    expect(Buffer.compare(raw.subarray(8), data)).toBe(0);
  });
});

describe.skipIf(!haveBoth)('vtracer-pixels and the release program', () => {
  const OPTION_SETS: VectorizeOptions[] = [{}, { preset: 'bw' }, { preset: 'photo', mode: 'polygon' }, { preset: 'poster', filterSpeckle: 0, mode: 'pixel' }, { colorPrecision: 3, simplify: 1.5 }];

  it.each(PICTURES)('write the same bytes of SVG for %s, with every option set', async (_name, source, encode) => {
    const picture = await encode();
    for (const options of OPTION_SETS) {
      const viaPixels = await withPrograms({ tracer: '/nonexistent/vtracer', pixels: pixelsProgram as string }, () => vectorize(picture, source, options));
      const viaRelease = await withPrograms({ tracer: vtracer as string }, () => vectorize(picture, source, options));
      expect(Buffer.compare(viaPixels.buffer, viaRelease.buffer), JSON.stringify(options)).toBe(0);
    }
  });

  it('refuses input that is not a header and as many pixels as it names, and writes no SVG', () => {
    const dir = tmpDir('vtracer-pixels-refusals-');
    const header = (width: number, height: number) => {
      const bytes = Buffer.alloc(8);
      bytes.writeUInt32LE(width, 0);
      bytes.writeUInt32LE(height, 4);
      return bytes;
    };
    const cases: Array<[string, Buffer]> = [
      ['an empty file', Buffer.alloc(0)],
      ['a header cut short', header(2, 2).subarray(0, 5)],
      ['a width of zero', Buffer.concat([header(0, 2), Buffer.alloc(8)])],
      ['pixels short of the header', Buffer.concat([header(2, 2), Buffer.alloc(15)])],
      ['pixels past the header', Buffer.concat([header(2, 2), Buffer.alloc(17)])],
      ['a picture that cannot be addressed', Buffer.concat([header(0xffffffff, 0xffffffff), Buffer.alloc(16)])],
      ['a picture one pixel over the bound the worker keeps', Buffer.concat([header(16_000_001, 1), Buffer.alloc(16)])],
    ];
    for (const [name, content] of cases) {
      const input = path.join(dir, 'in.rgba');
      const output = path.join(dir, 'out.svg');
      fs.writeFileSync(input, content);
      const run = spawnSync(pixelsProgram as string, ['--input', input, '--output', output], { encoding: 'utf8' });
      expect(run.status, name).toBe(1);
      expect(run.stderr, name).toMatch(/^Conversion failed: /);
      expect(fs.existsSync(output), name).toBe(false);
    }
  });
});

describe('the vtracer-pixels source', () => {
  const read = (...file: string[]) => fs.readFileSync(path.join(ROOT, ...file), 'utf8');
  const release = read('scripts', 'install-vtracer.sh');
  const pin = (name: string) => new RegExp(`^${name}="([^"]+)"$`, 'm').exec(release)?.[1];

  it('is the source of the commit and the version the release program is pinned to', () => {
    const source = read('scripts', 'vtracer-pixels', 'SOURCE');
    expect(source).toContain(`Tag:        ${pin('VTRACER_VERSION')}`);
    expect(source).toContain(`Commit:     ${pin('VTRACER_COMMIT')}`);
    expect(read('scripts', 'vtracer-pixels', 'Cargo.toml')).toContain(`vtracer = "=${pin('VTRACER_VERSION')}"`);
    expect(read('scripts', 'vtracer-pixels', 'Cargo.lock')).toMatch(new RegExp(`name = "vtracer"\\nversion = "${pin('VTRACER_VERSION')}"\\nsource = "registry`));
  });

  it('keeps the licence text of the commit it was copied from', () => {
    const digest = createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'scripts', 'vtracer-pixels', 'LICENSE'))).digest('hex');
    expect(digest).toBe(pin('VTRACER_LICENSE_SHA256'));
  });

  it('refuses the pixel count the worker refuses, no more', () => {
    const wrapper = read('src', 'lib', 'conversions', 'raster-vectorize.ts');
    const worker = /VECTORIZE_PIXEL_BUDGET: PixelBudget = \{ maxPixels: ([0-9_]+),/.exec(wrapper)?.[1];
    expect(worker).toBeDefined();
    expect(read('scripts', 'vtracer-pixels', 'src', 'main.rs')).toContain(`const MAX_PIXELS: usize = ${worker};`);
  });

  it('ships the licence texts of the allocator it links, as the crates carry them', () => {
    const notice = read('scripts', 'vtracer-pixels', 'NOTICE-mimalloc');
    const lock = read('scripts', 'vtracer-pixels', 'Cargo.lock');
    for (const crate of ['mimalloc', 'libmimalloc-sys']) {
      const version = new RegExp(`name = "${crate}"\\nversion = "([^"]+)"`).exec(lock)?.[1];
      expect(version, crate).toBeDefined();
      expect(notice, crate).toContain(`${crate} ${version}`);
    }
    expect(notice).toContain('Copyright 2019 Octavian Oncescu');
    expect(notice).toContain('Copyright (c) 2018-2025 Microsoft Corporation, Daan Leijen');
  });

  it('is built with the pinned toolchain and the lockfile, from the sources of the checkout', () => {
    const install = read('scripts', 'install-vtracer-pixels.sh');
    expect(install).toContain('cargo build --release --locked');
    expect(install).toMatch(/^RUST_VERSION="\d+\.\d+\.\d+"$/m);
    const digests = [...install.matchAll(/^(?:RUSTC|CARGO|RUST_STD|RUST_STD_MUSL)_SHA256_(?:AARCH64|X86_64)="([0-9a-f]{64})"$/gm)];
    expect(digests).toHaveLength(8);
    expect(install).toContain('--target "$target"');
    expect(install).toMatch(/target="(?:aarch64|x86_64)-unknown-linux-musl"/);
    expect(install.indexOf('sha256sum --check')).toBeLessThan(install.indexOf('install.sh"'));
  });
});
