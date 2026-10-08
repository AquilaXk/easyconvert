import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { classifyContent } from '../src/lib/conversions/image-content';
import { avifEffortFor, avifChromaFor, jpegChromaFor } from '../src/lib/conversions/image-encoder-defaults';
import { getOracleToolPath } from './helpers/differential-oracle';
import { measureSsimPsnr } from './helpers/ffmpeg-measure';
import { decodeRgba, runConvert, runIdentify, SKIP_WITHOUT_MAGICK, withTempImage } from './helpers/imagemagick';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Per-codec encoder defaults. Oracles: ImageMagick `identify` (JPEG sampling factors), `exiftool` (profile and
 * EXIF blocks), `avifdec --info` (bit depth, chroma format, alpha), ffmpeg SSIM, and `cwebp` at the same quality.
 */

const WIDTH = 192;
const HEIGHT = 128;
const BYTE_MAX = 255;
const NOISE_MULTIPLIER = 2654435761;
const SIZE_MATCH_TOLERANCE = 0.03;
const SSIM_SLACK = 0.003;
const MEGAPIXEL = 1_000_000;

let workDir: string;

function noise(index: number): number {
  return (Math.imul(index + 1, NOISE_MULTIPLIER) >>> 12) & 0x1f;
}

/** A smooth colour gradient with per-pixel noise: the statistics of a photograph, none of the flat areas. */
async function photoPng(): Promise<Buffer> {
  const raw = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = (y * WIDTH + x) * 3;
      const n = noise(y * WIDTH + x);
      raw[at] = Math.min(BYTE_MAX, Math.round((x * 200) / WIDTH + 30 * Math.sin(y / 9)) + n);
      raw[at + 1] = Math.min(BYTE_MAX, Math.round((y * 200) / HEIGHT + 30 * Math.cos(x / 11)) + n);
      raw[at + 2] = Math.min(BYTE_MAX, ((x + y) >> 1) + n * 2);
    }
  }
  return sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png().toBuffer();
}

function svgPng(body: string): Promise<Buffer> {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${body}</svg>`)).png().toBuffer();
}

const textBody =
  '<rect width="100%" height="100%" fill="#fff"/><text x="8" y="40" font-family="DejaVu Sans, sans-serif" font-size="28" fill="#c0392b">Red text 123</text>' +
  '<text x="8" y="80" font-family="DejaVu Sans, sans-serif" font-size="16" fill="#1f618d">Blue small print</text><rect x="8" y="96" width="170" height="3" fill="#27ae60"/>';
const lineBody =
  '<rect width="100%" height="100%" fill="#fdfefe"/><g fill="none" stroke="#000" stroke-width="1.5"><circle cx="96" cy="64" r="50"/><circle cx="96" cy="64" r="30"/><path d="M10 10 L182 118 M182 10 L10 118"/></g>';
const uiBody =
  '<rect width="100%" height="100%" fill="#eceff1"/><rect x="0" y="0" width="192" height="24" fill="#2c3e50"/><rect x="10" y="40" width="80" height="20" rx="4" fill="#3498db"/>' +
  '<rect x="100" y="40" width="80" height="20" rx="4" fill="#e74c3c"/><rect x="10" y="76" width="170" height="40" fill="#fff" stroke="#bdc3c7"/>';

function avifInfo(file: string): { depth: number; format: string; alpha: string } {
  const out = execFileSync(getOracleToolPath('avifdec') as string, ['--info', file], { encoding: 'utf-8' });
  const pick = (key: string): string => (new RegExp(`${key}\\s*:\\s*([^\\n]+)`).exec(out)?.[1] ?? '').trim();
  return { depth: Number(pick('Bit Depth')), format: pick('Format'), alpha: pick('Alpha') };
}

function writeIn(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  writeFileSync(file, bytes);
  return file;
}

function exiftool(file: string): string {
  return execFileSync(getOracleToolPath('exiftool') as string, ['-a', '-G1', '-s', file], { encoding: 'utf-8' });
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'encoder-defaults-'));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('content classification', () => {
  it('calls text, line art and UI graphic, and a noisy gradient a photo', async () => {
    expect(await classifyContent(sharp(await svgPng(textBody)))).toBe('graphic');
    expect(await classifyContent(sharp(await svgPng(lineBody)))).toBe('graphic');
    expect(await classifyContent(sharp(await svgPng(uiBody)))).toBe('graphic');
    expect(await classifyContent(sharp(await photoPng()))).toBe('photo');
  });
});

describe('encoder choices', () => {
  it('uses full chroma from JPEG quality 90 and from AVIF quality 80, and for graphic content at any quality', () => {
    expect([jpegChromaFor(89, 'photo'), jpegChromaFor(90, 'photo'), jpegChromaFor(40, 'graphic')]).toEqual(['4:2:0', '4:4:4', '4:4:4']);
    expect([avifChromaFor(79, 'photo'), avifChromaFor(80, 'photo'), avifChromaFor(40, 'graphic')]).toEqual(['4:2:0', '4:4:4', '4:4:4']);
  });

  it('searches longer for small graphic pictures and shorter for very large ones', () => {
    expect(avifEffortFor(0.5 * MEGAPIXEL, 'graphic')).toBeGreaterThan(avifEffortFor(0.5 * MEGAPIXEL, 'photo'));
    expect(avifEffortFor(30 * MEGAPIXEL, 'photo')).toBeLessThan(avifEffortFor(0.5 * MEGAPIXEL, 'photo'));
    expect(avifEffortFor(30 * MEGAPIXEL, 'graphic')).toBe(avifEffortFor(30 * MEGAPIXEL, 'photo'));
  });
});

describe.skipIf(SKIP_WITHOUT_MAGICK)('JPEG chroma subsampling', () => {
  const sampling = async (png: Buffer, options: { quality?: number }): Promise<string> => {
    const jpeg = (await convertImage(png, 'jpg', options, 'p.png', 'png')).buffer;
    return withTempImage(jpeg, 'jpg', (file) => runIdentify(['-format', '%[jpeg:sampling-factor]', file]).trim());
  };

  it('keeps full-resolution chroma at quality 92', async () => {
    expect(await sampling(await photoPng(), { quality: 92 })).toBe('1x1,1x1,1x1');
  });

  it('subsamples the chroma of a photograph below quality 90, but not of a screenshot', async () => {
    expect(await sampling(await photoPng(), { quality: 85 })).toBe('2x2,1x1,1x1');
    expect(await sampling(await photoPng(), {})).toBe('2x2,1x1,1x1');
    expect(await sampling(await svgPng(textBody), { quality: 85 })).toBe('1x1,1x1,1x1');
  });
});

describe.skipIf(SKIP_WITHOUT_MAGICK)('grey sources in JPEG', () => {
  const colourspaceOf = (jpeg: Buffer): string => withTempImage(jpeg, 'jpg', (file) => runIdentify(['-format', '%[colorspace]', file]).trim());

  it('stay one-component (Gray) unless the background has a hue', async () => {
    const raw = Buffer.alloc(WIDTH * HEIGHT, 0);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (noise(i) * 8) & BYTE_MAX;
    const grey = await sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 1 } }).toColourspace('b-w').png().toBuffer();
    expect(colourspaceOf((await convertImage(grey, 'jpg', {}, 'g.png', 'png')).buffer)).toBe('Gray');
    expect(colourspaceOf((await convertImage(grey, 'jpg', { background: '#c0c0c0' }, 'g.png', 'png')).buffer)).toBe('Gray');
    expect(colourspaceOf((await convertImage(grey, 'jpg', { background: '#ff0000' }, 'g.png', 'png')).buffer)).toBe('sRGB');
    expect(colourspaceOf((await convertImage(await photoPng(), 'jpg', {}, 'p.png', 'png')).buffer)).toBe('sRGB');
  });
});

describe.skipIf(skipWithoutTools('exiftool'))('metadata on lossy outputs', () => {
  it('writes no colour profile for an untagged source: sRGB is the default of JPEG, WebP and AVIF', async () => {
    const png = await photoPng();
    for (const target of ['jpg', 'webp', 'avif']) {
      const out = (await convertImage(png, target, {}, 'p.png', 'png')).buffer;
      expect(exiftool(writeIn(`untagged.${target}`, out)), target).not.toMatch(/ICC_Profile|ICC-profile/i);
    }
  });

  it('still tags a TIFF with sRGB', async () => {
    const out = (await convertImage(await photoPng(), 'tiff', {}, 'p.png', 'png')).buffer;
    expect(exiftool(writeIn('tagged.tiff', out))).toMatch(/ICC_Profile/);
  });

  it('keeps the EXIF block of the source', async () => {
    const source = await sharp(await photoPng()).withExif({ IFD0: { Copyright: 'Encoder defaults test' } }).jpeg().toBuffer();
    for (const target of ['jpg', 'webp', 'avif']) {
      const out = (await convertImage(source, target, {}, 'p.jpg', 'jpg')).buffer;
      const copyright = /Copyright\s*:\s*(.*)/.exec(exiftool(writeIn(`exif.${target}`, out)));
      expect(copyright?.[1].trim(), target).toBe('Encoder defaults test');
    }
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('still colour-manages a Display P3 source into untagged sRGB pixels', async () => {
    const colours = [[250, 20, 20], [20, 200, 40], [30, 60, 240], [128, 128, 128]];
    const raw = Buffer.from(colours.flat());
    const rawOptions = { raw: { width: 4, height: 1, channels: 3 } } as const;
    const p3 = await sharp(raw, rawOptions).withIccProfile('p3').png().toBuffer();
    const srgbProfile = (await sharp(await sharp(raw, rawOptions).withIccProfile('srgb').png().toBuffer()).metadata()).icc as Buffer;
    const out = (await convertImage(p3, 'png', {}, 'p3.png', 'png')).buffer;
    expect(exiftool(writeIn('p3-out.png', out))).not.toMatch(/ICC_Profile/);
    // ImageMagick converts the embedded Display P3 profile of the same file to sRGB with lcms.
    const profilePath = path.join(workDir, 'srgb.icc');
    writeFileSync(profilePath, srgbProfile);
    const expected = runConvert([writeIn('p3-in.png', p3), '-profile', profilePath, '-depth', '8', 'rgb:-']);
    const actual = decodeRgba(out, 'png').data;
    expect(expected).toHaveLength(12);
    for (let i = 0; i < 4; i += 1) for (let c = 0; c < 3; c += 1) expect(Math.abs(actual[i * 4 + c] - expected[i * 3 + c])).toBeLessThanOrEqual(2);
    // The conversion moved the values: the profile mattered.
    expect(Math.max(...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => Math.abs(actual[Math.floor(i / 3) * 4 + (i % 3)] - raw[i])))).toBeGreaterThan(2);
  });
});

describe.skipIf(skipWithoutTools('avifdec'))('AVIF encoding', () => {
  it('encodes a source with more than 8 bits per sample at 10 bits and keeps more than 256 levels', async () => {
    // A 16-bit grey ramp: 1024 columns, 64 apart in 16-bit value, so 8 bits cannot hold it.
    const columns = 1024;
    const rows = 8;
    const samples = Buffer.alloc(columns * rows * 2);
    for (let y = 0; y < rows; y += 1) for (let x = 0; x < columns; x += 1) samples.writeUInt16BE(x * 64, (y * columns + x) * 2);
    const ramp = runConvert(['-size', `${columns}x${rows}`, '-depth', '16', '-endian', 'MSB', 'gray:-', '-depth', '16', 'png:-'], samples);
    expect(runIdentify(['-format', '%z', writeIn('ramp.png', ramp)]).trim()).toBe('16');
    const avif = (await convertImage(ramp, 'avif', { quality: 95 }, 'ramp.png', 'png')).buffer;
    const file = writeIn('ramp.avif', avif);
    expect(avifInfo(file).depth).toBe(10);
    const decoded = path.join(workDir, 'ramp-decoded.png');
    execFileSync(getOracleToolPath('avifdec') as string, ['--depth', '16', file, decoded]);
    const levels = Number(runIdentify(['-format', '%k', decoded]).trim().split('\n')[0]);
    expect(levels).toBeGreaterThan(256);
  }, 60_000);

  it('keeps an 8-bit source at 8 bits', async () => {
    const out = (await convertImage(await photoPng(), 'avif', {}, 'p.png', 'png')).buffer;
    expect(avifInfo(writeIn('eight.avif', out)).depth).toBe(8);
  });

  it('drops an alpha channel that is fully opaque and keeps one that is not', async () => {
    const opaque = await sharp(await photoPng()).ensureAlpha().png().toBuffer();
    expect((await sharp(opaque).metadata()).hasAlpha).toBe(true);
    expect(avifInfo(writeIn('opaque.avif', (await convertImage(opaque, 'avif', {}, 'o.png', 'png')).buffer)).alpha).toMatch(/Absent/);
    const raw = Buffer.alloc(WIDTH * HEIGHT * 4, BYTE_MAX);
    raw[3] = 100;
    const translucent = await sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer();
    expect(avifInfo(writeIn('translucent.avif', (await convertImage(translucent, 'avif', {}, 't.png', 'png')).buffer)).alpha).toMatch(/Present|premultiplied/i);
  });

  it('keeps a 16-bit alpha channel whose only deviation is one step below full', async () => {
    const samples = new Uint16Array(WIDTH * HEIGHT * 4).fill(65_535);
    samples[3] = 65_534;
    const png16 = await sharp(samples, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).toColourspace('rgb16').png().toBuffer();
    expect(await sharp(png16).metadata()).toMatchObject({ depth: 'ushort', hasAlpha: true });
    const out = (await convertImage(png16, 'avif', {}, 'a16.png', 'png')).buffer;
    expect(avifInfo(writeIn('alpha16.avif', out)).alpha).toMatch(/Present|premultiplied/i);
    const full = new Uint16Array(WIDTH * HEIGHT * 4).fill(65_535);
    const opaque16 = await sharp(full, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).toColourspace('rgb16').png().toBuffer();
    expect(avifInfo(writeIn('opaque16.avif', (await convertImage(opaque16, 'avif', {}, 'o16.png', 'png')).buffer)).alpha).toMatch(/Absent/);
  });

  it('picks chroma by content and quality: 4:2:0 for a photo below 80, 4:4:4 for graphics and at 80', async () => {
    const photo = await photoPng();
    const graphic = await svgPng(uiBody);
    const format = async (png: Buffer, quality: number): Promise<string> =>
      avifInfo(writeIn(`chroma-${quality}.avif`, (await convertImage(png, 'avif', { quality }, 'c.png', 'png')).buffer)).format;
    expect(await format(photo, 50)).toBe('YUV420');
    expect(await format(photo, 80)).toBe('YUV444');
    expect(await format(graphic, 50)).toBe('YUV444');
  }, 60_000);
});

describe.skipIf(skipWithoutTools('cwebp', 'dwebp', 'ffmpeg'))('WebP default quality and effort', () => {
  it('a request with no quality is quality 80 at the reference encoder effort, within 3% of cwebp -q 80 -m 4', async () => {
    const png = await photoPng();
    const ours = (await convertImage(png, 'webp', {}, 'p.png', 'png')).buffer;
    const source = writeIn('webp-source.png', png);
    const reference = path.join(workDir, 'ref.webp');
    execFileSync(getOracleToolPath('cwebp') as string, ['-quiet', '-q', '80', '-m', '4', source, '-o', reference]);
    const referenceBytes = readFileSync(reference).length;
    expect(Math.abs(ours.length - referenceBytes) / referenceBytes).toBeLessThan(SIZE_MATCH_TOLERANCE);
  });
});

/**
 * Equal-size quality of the new encoder settings against the previous ones (the library defaults at a quality
 * matched by bisection to the new file size). SSIM is ffmpeg's; ssimulacra2 is reported by `npm run bench:quality`
 * when installed.
 */
describe.skipIf(skipWithoutTools('avifdec', 'dwebp', 'ffmpeg'))('equal-size quality against the previous settings', () => {
  const ffmpeg = (): string => getOracleToolPath('ffmpeg') as string;

  function decodeToPng(encoded: Buffer, extension: string, name: string): string {
    const input = writeIn(`${name}.${extension}`, encoded);
    const output = path.join(workDir, `${name}-decoded.png`);
    if (extension === 'avif') execFileSync(getOracleToolPath('avifdec') as string, [input, output]);
    else if (extension === 'webp') execFileSync(getOracleToolPath('dwebp') as string, ['-nodither', '-quiet', input, '-o', output]);
    else execFileSync(ffmpeg(), ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', input, '-frames:v', '1', output]);
    return output;
  }

  type Encoder = (png: Buffer, quality: number) => Promise<Buffer>;
  const previous: Record<string, Encoder> = {
    jpg: (png, q) => sharp(png).jpeg({ quality: q, mozjpeg: true }).toBuffer(),
    webp: (png, q) => sharp(png).webp({ quality: q }).toBuffer(),
    avif: (png, q) => sharp(png).avif({ quality: q, tune: 'psnr', effort: 3 }).toBuffer(),
  };

  async function previousAtSize(target: string, png: Buffer, bytes: number): Promise<Buffer> {
    let low = 1;
    let high = 100;
    let best = await previous[target](png, 50);
    while (low <= high) {
      const mid = (low + high) >> 1;
      const candidate = await previous[target](png, mid);
      if (Math.abs(candidate.length - bytes) < Math.abs(best.length - bytes)) best = candidate;
      if (candidate.length < bytes) low = mid + 1;
      else high = mid - 1;
    }
    return best;
  }

  const fixtures: Array<[string, () => Promise<Buffer>]> = [
    ['photo', photoPng],
    ['text', () => svgPng(textBody)],
    ['line art', () => svgPng(lineBody)],
    ['interface', () => svgPng(uiBody)],
    ['photo, rotated gradient', async () => sharp(await photoPng()).rotate(90).resize(WIDTH, HEIGHT, { fit: 'cover' }).png().toBuffer()],
  ];

  it.each(['jpg', 'webp', 'avif'])('%s: SSIM at equal file size is not worse than the previous settings on 5 fixtures', async (target) => {
    for (const [label, make] of fixtures) {
      const png = await make();
      const reference = writeIn(`ref-${target}.png`, png);
      const ours = (await convertImage(png, target, { quality: 70 }, 'f.png', 'png')).buffer;
      const old = await previousAtSize(target, png, ours.length);
      expect(Math.abs(old.length - ours.length) / ours.length, `${label}: size match`).toBeLessThan(0.25);
      const oursSsim = measureSsimPsnr(ffmpeg(), decodeToPng(ours, target === 'jpg' ? 'jpg' : target, `ours-${target}`), reference).ssim;
      const oldSsim = measureSsimPsnr(ffmpeg(), decodeToPng(old, target === 'jpg' ? 'jpg' : target, `old-${target}`), reference).ssim;
      expect(oursSsim + SSIM_SLACK, `${label}: ${ours.length} B vs ${old.length} B`).toBeGreaterThanOrEqual(oldSsim);
    }
  }, 240_000);
});
