import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { classifyContent, classifyRaster, type Raster } from '../src/lib/conversions/image-content';
import { AVIF_CLI_MAX_PIXELS, WEBP_EFFORT, webpOptionsFor, avifBitdepthFor, avifEncoderFor, avifEffortFor, avifChromaFor, avifLayoutFor, avifLibraryOptionsOf, avifPolicyFor, avifSpeedFor, jpegChromaFor, jpegOptionsFor } from '../src/lib/conversions/image-encoder-defaults';
import { getOracleToolPath, requireOracleTool } from './helpers/differential-oracle';
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
  const out = execFileSync(requireOracleTool('avifdec'), ['--info', file], { encoding: 'utf-8' });
  const pick = (key: string): string => (new RegExp(`${key}\\s*:\\s*([^\\n]+)`).exec(out)?.[1] ?? '').trim();
  return { depth: Number(pick('Bit Depth')), format: pick('Format'), alpha: pick('Alpha') };
}

function writeIn(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  writeFileSync(file, bytes);
  return file;
}

function exiftool(file: string): string {
  return execFileSync(requireOracleTool('exiftool'), ['-a', '-G1', '-s', file], { encoding: 'utf-8' });
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

describe('content classification of decoded samples', () => {
  /** The samples a plain PNG decodes to, in the layout `decodePlainPngOnce` hands over. */
  async function rasterOf(png: Buffer): Promise<Raster> {
    const meta = await sharp(png).metadata();
    const deep = meta.depth === 'ushort';
    const { data, info } = await sharp(png).toColourspace(meta.space as string).raw({ depth: deep ? 'ushort' : 'uchar' }).toBuffer({ resolveWithObject: true });
    const samples = deep ? new Uint16Array(data.buffer, data.byteOffset, data.length / 2) : new Uint8Array(data.buffer, data.byteOffset, data.length);
    return { samples, width: info.width, height: info.height, channels: info.channels };
  }

  const corpus = (name: string): Buffer => readFileSync(path.join(__dirname, '..', 'bench', 'corpus', name));
  const pictures: Array<[string, () => Promise<Buffer>, 'graphic' | 'photo']> = [
    ['text', () => svgPng(textBody), 'graphic'],
    ['line art', () => svgPng(lineBody), 'graphic'],
    ['interface', () => svgPng(uiBody), 'graphic'],
    ['photograph', photoPng, 'photo'],
    ['photograph in 16 bits', async () => sharp(await photoPng()).toColourspace('rgb16').png().toBuffer(), 'photo'],
    ['interface in 16 bits with alpha', async () => sharp(await svgPng(uiBody)).toColourspace('rgb16').ensureAlpha().png().toBuffer(), 'graphic'],
    ['grey line art', async () => sharp(await svgPng(lineBody)).toColourspace('b-w').png().toBuffer(), 'graphic'],
    ['16-bit grey line art with alpha', async () => sharp(await svgPng(lineBody)).toColourspace('grey16').ensureAlpha().png().toBuffer(), 'graphic'],
    ['benchmark screenshot (16-bit colour with alpha)', async () => corpus('screenshot.png'), 'graphic'],
    ['benchmark line art (16-bit grey with alpha)', async () => corpus('lineart.png'), 'graphic'],
    ['benchmark photograph', async () => corpus('photo-b.png'), 'photo'],
  ];

  it.each(pictures)('%s: the class of the samples is the class of the pipeline', async (_name, make, expected) => {
    const png = await make();
    expect(await classifyContent(sharp(png))).toBe(expected);
    expect(classifyRaster(await rasterOf(png))).toBe(expected);
  });

  it('calls a picture one column wide a photo, as the thumbnail of one column has no pair to compare', () => {
    expect(classifyRaster({ samples: new Uint8Array(3 * 40), width: 1, height: 40, channels: 3 })).toBe('photo');
  });
});

describe('encoder choices', () => {
  it('uses full chroma from JPEG quality 90 and from AVIF quality 80, and for graphic AVIF at any quality', () => {
    expect([jpegChromaFor(89), jpegChromaFor(90)]).toEqual(['4:2:0', '4:4:4']);
    expect([avifChromaFor(79, 'photo'), avifChromaFor(80, 'photo'), avifChromaFor(40, 'graphic')]).toEqual(['4:2:0', '4:4:4', '4:4:4']);
  });

  it('keeps trellis quantisation and the scan search out of the JPEG encode below the full-chroma quality, whatever the content', () => {
    for (const [content, grey] of [['photo', false], ['graphic', false], ['graphic', true]] as const) {
      const options = jpegOptionsFor(85, content, grey);
      expect(options, `${content} grey=${grey}`).toMatchObject({ quality: 85, progressive: false, trellisQuantisation: false, optimiseCoding: true, overshootDeringing: true });
      expect(options.optimiseScans, `${content} grey=${grey}`).toBeUndefined();
    }
    expect([jpegOptionsFor(85, 'graphic').chromaSubsampling, jpegOptionsFor(85, 'photo').chromaSubsampling]).toEqual(['4:2:0', '4:2:0']);
  });

  it('chooses the quantisation table by content: 3 for photographs, 2 for graphics', () => {
    expect([jpegOptionsFor(70, 'photo').quantisationTable, jpegOptionsFor(70, 'graphic').quantisationTable]).toEqual([3, 2]);
  });

  it('spends the progressive scan search only on a colour graphic at the full-chroma quality', () => {
    expect(jpegOptionsFor(92, 'graphic')).toMatchObject({ chromaSubsampling: '4:4:4', progressive: true, optimiseScans: true });
    expect(jpegOptionsFor(92, 'graphic', true)).toMatchObject({ progressive: false });
    expect(jpegOptionsFor(92, 'photo')).toMatchObject({ chromaSubsampling: '4:4:4', progressive: false });
  });

  it('writes a grey AVIF as monochrome at any quality and content, and a colour one by the chroma rule', () => {
    expect([avifLayoutFor(true, 30, 'photo'), avifLayoutFor(true, 95, 'graphic')]).toEqual(['4:0:0', '4:0:0']);
    expect([avifLayoutFor(false, 79, 'photo'), avifLayoutFor(false, 80, 'photo'), avifLayoutFor(false, 40, 'graphic')]).toEqual(['4:2:0', '4:4:4', '4:4:4']);
  });

  it('maps the library effort onto the encoder speed preset the other way round: effort 3 is speed 6', () => {
    expect([avifSpeedFor(0), avifSpeedFor(3), avifSpeedFor(5), avifSpeedFor(9)]).toEqual([9, 6, 4, 0]);
  });

  it('gives both AVIF encoders one policy: the image library cannot write monochrome and keeps the colour chroma rule for a grey picture', () => {
    const policy = avifPolicyFor(40, 'photo', 0.5 * MEGAPIXEL, true, true, 'image-library');
    expect(policy).toEqual({ encoder: 'image-library', quality: 40, effort: 3, bitdepth: 10, chroma: '4:2:0', layout: '4:0:0', tune: 'ssim' });
    expect(avifLibraryOptionsOf(policy)).toEqual({ quality: 40, effort: 3, tune: 'ssim', chromaSubsampling: '4:2:0', bitdepth: 10 });
    expect(avifPolicyFor(undefined, 'graphic', 0.5 * MEGAPIXEL, false, false, 'image-library')).toEqual({
      encoder: 'image-library',
      quality: 60,
      effort: 5,
      bitdepth: 8,
      chroma: '4:4:4',
      layout: '4:4:4',
      tune: 'ssim',
    });
  });

  it("gives the library encoder's tool its own effort ladder and tuning: speed 6 for graphics, the encoder's own tuning for them, ssim for photographs", () => {
    expect(avifPolicyFor(undefined, 'graphic', 0.5 * MEGAPIXEL, true, true, 'library-cli')).toEqual({
      encoder: 'library-cli',
      quality: 60,
      effort: 3,
      bitdepth: 10,
      chroma: '4:4:4',
      layout: '4:0:0',
      tune: undefined,
    });
    expect(avifPolicyFor(50, 'photo', 0.5 * MEGAPIXEL, false, false, 'library-cli')).toMatchObject({ effort: 3, layout: '4:2:0', tune: 'ssim' });
    expect(avifEffortFor(30 * MEGAPIXEL, 'photo', 'library-cli')).toBe(avifEffortFor(30 * MEGAPIXEL, 'photo'));
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

  it('subsamples the chroma of a photograph and of a screenshot below quality 90, as the reference encoder does', async () => {
    expect(await sampling(await photoPng(), { quality: 85 })).toBe('2x2,1x1,1x1');
    expect(await sampling(await photoPng(), {})).toBe('2x2,1x1,1x1');
    expect(await sampling(await svgPng(textBody), { quality: 85 })).toBe('2x2,1x1,1x1');
  });

  it('keeps the chroma of a screenshot at full resolution from quality 90', async () => {
    expect(await sampling(await svgPng(textBody), { quality: 90 })).toBe('1x1,1x1,1x1');
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
  it('encodes a source with more than 8 bits per sample at 10 bits when it is grey and keeps more than 256 levels', async () => {
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
    execFileSync(requireOracleTool('avifdec'), ['--depth', '16', file, decoded]);
    const levels = Number(runIdentify(['-format', '%k', decoded]).trim().split('\n')[0]);
    expect(levels).toBeGreaterThan(256);
  }, 60_000);

  it('encodes a 16-bit RGB source at 10 bits, within the AV1 Main profile, and keeps HDR output at 10 bits', async () => {
    expect([avifBitdepthFor(false), avifBitdepthFor(true)]).toEqual([8, 10]);
    const rgb16 = runConvert(['-size', '64x64', 'gradient:#102030-#f0e0d0', '-depth', '16', 'png:-']);
    expect(await sharp(rgb16).metadata()).toMatchObject({ depth: 'ushort', channels: 3 });
    const out = (await convertImage(rgb16, 'avif', { quality: 90 }, 'rgb16.png', 'png')).buffer;
    expect(avifInfo(writeIn('rgb16.avif', out)).depth).toBe(10);
  });

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

  // The AVIF holds 10 bits: one 10-bit step below full is 64 of the 16-bit values, which an 8-bit reduction (>> 8)
  // still reads as 255, so only a check at the picture's own depth keeps this channel.
  const ALPHA_STEP_10_BIT = 64;
  it('keeps a 16-bit alpha channel whose only deviation is one 10-bit step below full', async () => {
    const samples = new Uint16Array(WIDTH * HEIGHT * 4).fill(65_535);
    samples[3] = 65_535 - ALPHA_STEP_10_BIT;
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

describe('WebP encoder options', () => {
  it('converts to YUV the way the reference encoder does, whatever the content: sharp YUV doubles the encode time of a graphic for under 2% of bytes', () => {
    expect(webpOptionsFor(70)).toEqual({ quality: 70, effort: WEBP_EFFORT, smartSubsample: false });
    expect(webpOptionsFor(undefined)).toEqual({ quality: 80, effort: WEBP_EFFORT, smartSubsample: false });
  });
});

describe.skipIf(skipWithoutTools('cwebp', 'dwebp', 'ffmpeg'))('WebP default quality and effort', () => {
  it('a request with no quality is quality 80 at the reference encoder effort, within 3% of cwebp -q 80 -m 4', async () => {
    const png = await photoPng();
    const ours = (await convertImage(png, 'webp', {}, 'p.png', 'png')).buffer;
    const source = writeIn('webp-source.png', png);
    const reference = path.join(workDir, 'ref.webp');
    execFileSync(requireOracleTool('cwebp'), ['-quiet', '-q', '80', '-m', '4', source, '-o', reference]);
    const referenceBytes = readFileSync(reference).length;
    expect(Math.abs(ours.length - referenceBytes) / referenceBytes).toBeLessThan(SIZE_MATCH_TOLERANCE);
  });

  it('writes an interface (graphic content) as the very file cwebp -q 70 -m 4 writes', async () => {
    const png = await svgPng(uiBody);
    const ours = (await convertImage(png, 'webp', { quality: 70 }, 'ui.png', 'png')).buffer;
    const source = writeIn('webp-ui-source.png', png);
    const reference = path.join(workDir, 'ref-ui.webp');
    execFileSync(requireOracleTool('cwebp'), ['-quiet', '-q', '70', '-m', '4', source, '-o', reference]);
    expect(ours.equals(readFileSync(reference))).toBe(true);
  });
});

/**
 * Equal-size quality of the new encoder settings against the previous ones (the library defaults at a quality
 * matched by bisection to the new file size). SSIM is ffmpeg's; ssimulacra2 is reported by `npm run bench:quality`
 * when installed. Graphic JPEG is judged against the reference encoder by BD-rate in image-graphic-jpeg-parity.test.ts: its
 * settings no longer try to beat the library's heaviest preset (progressive scans searched, trellis) at equal size.
 */
describe.skipIf(skipWithoutTools('avifdec', 'dwebp', 'ffmpeg'))('equal-size quality against the previous settings', () => {
  const ffmpeg = (): string => requireOracleTool('ffmpeg');

  function decodeToPng(encoded: Buffer, extension: string, name: string): string {
    const input = writeIn(`${name}.${extension}`, encoded);
    const output = path.join(workDir, `${name}-decoded.png`);
    if (extension === 'avif') execFileSync(requireOracleTool('avifdec'), [input, output]);
    else if (extension === 'webp') execFileSync(requireOracleTool('dwebp'), ['-nodither', '-quiet', input, '-o', output]);
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

  const fixtures: Array<[string, () => Promise<Buffer>, boolean]> = [
    ['photo', photoPng, false],
    ['text', () => svgPng(textBody), true],
    ['line art', () => svgPng(lineBody), true],
    ['interface', () => svgPng(uiBody), true],
    ['photo, rotated gradient', async () => sharp(await photoPng()).rotate(90).resize(WIDTH, HEIGHT, { fit: 'cover' }).png().toBuffer(), false],
  ];

  it.each(['jpg', 'webp', 'avif'])('%s: SSIM at equal file size is not worse than the previous settings on 5 fixtures', async (target) => {
    for (const [label, make, graphic] of fixtures) {
      if (target === 'jpg' && graphic) continue;
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

describe('avifEncoderFor', () => {
  it('gives grey and graphic pictures to the library encoder, colour photographs and oversized pictures to the image library, and everything to the image library without the tool', () => {
    expect(avifEncoderFor('graphic', false, 1_000, true)).toBe('library-cli');
    expect(avifEncoderFor('photo', true, 1_000, true)).toBe('library-cli');
    expect(avifEncoderFor('photo', false, 1_000, true)).toBe('image-library');
    expect(avifEncoderFor('graphic', false, AVIF_CLI_MAX_PIXELS, true)).toBe('library-cli');
    expect(avifEncoderFor('graphic', true, AVIF_CLI_MAX_PIXELS + 1, true)).toBe('image-library');
    expect(avifEncoderFor('graphic', true, 1_000, false)).toBe('image-library');
  });
});
