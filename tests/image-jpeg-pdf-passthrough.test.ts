import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { ConversionFailedError } from '../src/lib/types';
import { getOracleToolPath, requireOracleTool } from './helpers/differential-oracle';
import { decodeRgba, runConvert, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { meanDeltaE2000 } from './helpers/ciede2000';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * JPEG to PDF without re-encoding. Oracles: poppler's `pdfimages` (the image stream it extracts must be
 * byte-identical to the source, MD5; `-list` reports the colour space and encoding), `pdfinfo` (page size),
 * `pdftoppm` renders compared with ImageMagick's own decode of the JPEG, and `qpdf --check` (the file is
 * structurally valid). The fixtures are made by ImageMagick.
 */

const CORPUS = path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg');
const PDF_OVERHEAD_BYTES = 2048;
const PDF_SIZE_RATIO = 1.05;
const RENDER_DPI = 72;
const MIN_RENDER_PSNR_DB = 40;
const RENDER_EDGE_SHAVE = 2;
/** The inversion pdf-lib writes for an Adobe CMYK JPEG: Decode maps each stored sample s to 1 - s. */
const INVERTING_DECODE = '/Decode [ 1 0 1 0 1 0 1 0 ]';
const CMYK_MAX_DELTA_E = 10;
const CMYK_CONTROL_MIN_DELTA_E = 30;

let work: string;
const tool = (name: 'pdfimages' | 'pdfinfo' | 'pdftoppm' | 'qpdf'): string => requireOracleTool(name as never);

function write(name: string, bytes: Buffer): string {
  const file = path.join(work, name);
  writeFileSync(file, bytes);
  return file;
}

const md5 = (bytes: Buffer): string => createHash('md5').update(bytes).digest('hex');

async function toPdf(jpeg: Buffer, options = {}): Promise<{ file: string; bytes: Buffer }> {
  const result = await convertImage(jpeg, 'pdf', options, 'picture.jpg', 'jpg');
  expect(result.mimeType).toBe('application/pdf');
  expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  return { file: write(`out-${Math.random().toString(36).slice(2)}.pdf`, result.buffer), bytes: result.buffer };
}

/** The first image listed by `pdfimages -list`: encoding and colour space. */
function listImage(pdf: string): { enc: string; color: string; width: number; height: number; count: number } {
  const rows = execFileSync(tool('pdfimages'), ['-list', pdf], { encoding: 'utf-8' }).trim().split('\n').slice(2);
  const cells = rows[0].trim().split(/\s+/);
  return { width: Number(cells[3]), height: Number(cells[4]), color: cells[5], enc: cells[8], count: rows.length };
}

function extractedJpeg(pdf: string): Buffer {
  const prefix = path.join(work, `extract-${Math.random().toString(36).slice(2)}`);
  execFileSync(tool('pdfimages'), ['-j', pdf, prefix]);
  return readFileSync(`${prefix}-000.jpg`);
}

function pageSize(pdf: string): { width: number; height: number } {
  const text = execFileSync(tool('pdfinfo'), [pdf], { encoding: 'utf-8' });
  const match = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(text);
  return { width: Number(match?.[1]), height: Number(match?.[2]) };
}

/** Offset of the first marker `code` in the header segments of a JPEG, found by walking the segment lengths. */
function markerOffset(jpeg: Buffer, code: number): number {
  let at = 2;
  while (at + 4 <= jpeg.length) {
    if (jpeg[at] !== 0xff) throw new Error('not at a marker');
    if (jpeg[at + 1] === code) return at;
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  throw new Error(`marker 0x${code.toString(16)} not found`);
}

/** Sets the EXIF Orientation of a JPEG with exiftool, an independent writer of the tag. */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const file = write(`orient-source-${orientation}.jpg`, jpeg);
  execFileSync(requireOracleTool('exiftool'), ['-overwrite_original', '-q', `-Orientation#=${orientation}`, file]);
  return readFileSync(file);
}

beforeAll(() => {
  work = mkdtempSync(path.join(os.tmpdir(), 'jpeg-pdf-'));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(skipWithoutTools('pdfimages', 'pdfinfo', 'qpdf') || SKIP_WITHOUT_MAGICK)('JPEG goes into the PDF byte for byte', () => {
  it('baseline JPEG: pdfimages extracts an identical stream (MD5) and the PDF is at most 1.05 x the JPEG + 2 KB', async () => {
    const jpeg = readFileSync(CORPUS);
    const { file, bytes } = await toPdf(jpeg);
    expect(listImage(file)).toMatchObject({ enc: 'jpeg', color: 'rgb', width: 768, height: 512, count: 1 });
    expect(md5(extractedJpeg(file))).toBe(md5(jpeg));
    expect(bytes.length).toBeLessThanOrEqual(jpeg.length * PDF_SIZE_RATIO + PDF_OVERHEAD_BYTES);
    execFileSync(tool('qpdf'), ['--check', file], { stdio: 'pipe' });
  });

  it('progressive JPEG: identical stream', async () => {
    const jpeg = runConvert([CORPUS, '-interlace', 'Plane', '-quality', '85', 'jpg:-']);
    const { file } = await toPdf(jpeg);
    expect(listImage(file).enc).toBe('jpeg');
    expect(md5(extractedJpeg(file))).toBe(md5(jpeg));
  });

  it('grayscale JPEG is DeviceGray', async () => {
    const jpeg = runConvert([CORPUS, '-colorspace', 'Gray', '-quality', '80', 'jpg:-']);
    const { file } = await toPdf(jpeg);
    expect(listImage(file)).toMatchObject({ enc: 'jpeg', color: 'gray' });
    expect(md5(extractedJpeg(file))).toBe(md5(jpeg));
  });

  it('CMYK JPEG keeps its stream, is DeviceCMYK with the Adobe inversion, and renders the colours ImageMagick decodes', async () => {
    const jpeg = runConvert([CORPUS, '-colorspace', 'CMYK', '-quality', '90', 'jpg:-']);
    const { file } = await toPdf(jpeg);
    expect(listImage(file)).toMatchObject({ enc: 'jpeg', color: 'cmyk' });
    expect(md5(extractedJpeg(file))).toBe(md5(jpeg));
    const text = readFileSync(file).toString('latin1');
    expect(text).toContain(INVERTING_DECODE);
    // Colours: poppler renders the PDF, ImageMagick decodes the JPEG. Two CMYK to sRGB conversions never agree to
    // 2 units (poppler and ghostscript differ from each other by about 4.5), so the check is a bound on the
    // difference and a control: the same PDF with the inversion removed is far worse.
    const render = (pdf: string, name: string): Uint8Array => {
      const png = path.join(work, name);
      execFileSync(tool('pdftoppm'), ['-png', '-r', String(RENDER_DPI), '-singlefile', pdf, png]);
      return decodeRgba(readFileSync(`${png}.png`), 'png').data;
    };
    const reference = decodeRgba(jpeg, 'jpg').data;
    expect(meanDeltaE2000(render(file, 'cmyk-render'), reference)).toBeLessThanOrEqual(CMYK_MAX_DELTA_E);
    const stripped = write('cmyk-no-decode.pdf', Buffer.from(text.replace(INVERTING_DECODE, ' '.repeat(INVERTING_DECODE.length)), 'latin1'));
    expect(meanDeltaE2000(render(stripped, 'cmyk-control'), reference)).toBeGreaterThanOrEqual(CMYK_CONTROL_MIN_DELTA_E);
  });

  it('an embedded ICC profile becomes /ICCBased and the stream is untouched', async () => {
    const profileBytes = (await sharp({ create: { width: 1, height: 1, channels: 3, background: '#888' } }).withIccProfile('p3').png().toBuffer().then((b) => sharp(b).metadata())).icc as Buffer;
    const profilePath = write('p3.icc', profileBytes);
    const jpeg = runConvert([CORPUS, '-profile', profilePath, '-quality', '88', 'jpg:-']);
    const { file } = await toPdf(jpeg);
    expect(listImage(file)).toMatchObject({ enc: 'jpeg', color: 'icc' });
    expect(md5(extractedJpeg(file))).toBe(md5(jpeg));
  });

  it('page size comes from the pixels and the density: 600 x 300 px at 300 dpi is 144 x 72 pt, not A4', async () => {
    const jpeg = runConvert(['-size', '600x300', 'gradient:red-blue', '-units', 'PixelsPerInch', '-density', '300', '-quality', '85', 'jpg:-']);
    const { file } = await toPdf(jpeg);
    const size = pageSize(file);
    expect(size.width).toBeCloseTo(144, 1);
    expect(size.height).toBeCloseTo(72, 1);
    const plain = runConvert(['-size', '600x300', 'gradient:red-blue', '-quality', '85', 'jpg:-']);
    const noDensity = pageSize((await toPdf(plain)).file);
    expect(noDensity.width).toBeCloseTo(600, 1);
    expect(noDensity.height).toBeCloseTo(300, 1);
  });

  it.each([2, 3, 4, 5, 6, 7, 8] as const)('EXIF orientation %i is a matrix on the picture: same stream, upright render', async (orientation) => {
    // A smooth picture that differs along both axes, so every flip and turn shows and no hard edge makes a renderer's
    // resampling the main difference.
    const base = runConvert(['-size', '96x64', 'gradient:red-blue', '(', '-size', '64x96', 'gradient:white-black', '-rotate', '90', ')', '-compose', 'multiply', '-composite', '-quality', '95', 'jpg:-']);
    const jpeg = withOrientation(base, orientation);
    const { file } = await toPdf(jpeg);
    expect(md5(extractedJpeg(file))).toBe(md5(jpeg));
    const swaps = orientation >= 5;
    const size = pageSize(file);
    expect(size.width).toBeCloseTo(swaps ? 64 : 96, 1);
    expect(size.height).toBeCloseTo(swaps ? 96 : 64, 1);
    const png = path.join(work, `orient-${orientation}`);
    execFileSync(tool('pdftoppm'), ['-png', '-r', String(RENDER_DPI), '-singlefile', file, png]);
    // The outermost pixels are where a renderer anti-aliases the picture's edge, so both sides are shaved by two.
    const rendered = runConvert([`${png}.png`, '-shave', `${RENDER_EDGE_SHAVE}x${RENDER_EDGE_SHAVE}`, 'png:-']);
    const upright = runConvert(['jpg:-', '-auto-orient', '-shave', `${RENDER_EDGE_SHAVE}x${RENDER_EDGE_SHAVE}`, 'png:-'], jpeg);
    expect(psnr(decodeRgba(rendered, 'png').data, decodeRgba(upright, 'png').data)).toBeGreaterThanOrEqual(MIN_RENDER_PSNR_DB);
  });

  it('an arithmetic-coded frame (SOF9) is not passed through: the file is decoded and re-encoded, or refused', async () => {
    const jpeg = Buffer.from(readFileSync(CORPUS));
    jpeg[markerOffset(jpeg, 0xc0) + 1] = 0xc9;
    let produced: Buffer | undefined;
    try {
      produced = (await convertImage(jpeg, 'pdf', {}, 'arith.jpg', 'jpg')).buffer;
    } catch (error) {
      expect(error).toBeInstanceOf(ConversionFailedError);
    }
    if (produced) expect(listImage(write('arith.pdf', produced)).enc).not.toBe('jpeg');
  });

  it('a truncated scan is not embedded: the library cannot decode it, so the answer is a typed 400', async () => {
    const jpeg = readFileSync(CORPUS);
    const failure = await convertImage(jpeg.subarray(0, Math.floor(jpeg.length / 2)), 'pdf', {}, 'cut.jpg', 'jpg').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/^Invalid image: it could not be decoded/);
  });

  it('a corrupt SOF (component count that does not match its length) is refused with a typed error', async () => {
    const jpeg = Buffer.from(readFileSync(CORPUS));
    jpeg[markerOffset(jpeg, 0xc0) + 9] = 2; // component count
    const failure = await convertImage(jpeg, 'pdf', {}, 'bad.jpg', 'jpg').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/^Invalid image: the header could not be decoded/);
  });

  it('a header that declares 20000 x 20000 pixels answers the pixel limit (413) before anything is decoded', async () => {
    const jpeg = Buffer.from(readFileSync(CORPUS));
    const sof = markerOffset(jpeg, 0xc0);
    jpeg.writeUInt16BE(20_000, sof + 5);
    jpeg.writeUInt16BE(20_000, sof + 7);
    const failure = await convertImage(jpeg, 'pdf', {}, 'huge.jpg', 'jpg').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(InputPixelLimitError);
    expect(failure).toMatchObject({ status: 413, width: 20_000, height: 20_000 });
  });

  it('other sources are unchanged: a PNG still becomes an embedded raster, not a JPEG stream', async () => {
    const png = await sharp(readFileSync(CORPUS)).png().toBuffer();
    const result = await convertImage(png, 'pdf', {}, 'photo.png', 'png');
    const file = write('from-png.pdf', result.buffer);
    expect(listImage(file).enc).not.toBe('jpeg');
  });
});

function psnr(a: Uint8Array, b: Uint8Array): number {
  expect(a.length).toBe(b.length);
  let squared = 0;
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c += 1) squared += (a[i + c] - b[i + c]) ** 2;
  const mse = squared / ((a.length / 4) * 3);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}
