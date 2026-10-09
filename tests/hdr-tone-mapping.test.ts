import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ColourTagError, writePngCicp } from '../src/lib/conversions/cicp';
import { convertImage } from '../src/lib/conversions/image';
import { ConversionFailedError, UnsupportedOptionError } from '../src/lib/types';
import { decodeExrWithFfmpeg } from './helpers/ffmpeg-exr';
import { DISPLAY_P3_COLORANTS, SRGB_PARA, buildMatrixProfile } from './helpers/icc-writer';
import { decodeRgba, runConvert } from './helpers/imagemagick';
import { writeRgbOpenExr } from './helpers/openexr-writer';
import { requireOracleTool } from './helpers/differential-oracle';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { HAS_ZSCALE, nitsOfPq, pqOfNits, psnrDb, renderSdrWithZimg } from './helpers/zimg-oracle';

/**
 * HDR to SDR rendering of stills. The tone-mapped pictures are compared with FFmpeg's zscale (zimg) transfer
 * functions and a BT.2390 curve written as a lutrgb expression from the ITU formula; colour management is compared
 * with published matrices; tags are read with ffprobe, avifdec and exiftool.
 */

const work = mkdtempSync(path.join(os.tmpdir(), 'hdr-tone-mapping-'));
let counter = 0;
function file(name: string, data: Buffer): string {
  counter += 1;
  const target = path.join(work, `${counter}-${name}`);
  writeFileSync(target, data);
  return target;
}

const MIN_PSNR_DB = 40;
const BYTE_MAX = 255;

function srgbEncode(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function srgbDecode(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function rgbOf(png: Buffer): Uint8Array {
  const { data } = decodeRgba(png, 'png');
  const out = new Uint8Array((data.length / 4) * 3);
  for (let i = 0; i < data.length / 4; i += 1) out.set([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]], i * 3);
  return out;
}

/** A 16-bit RGB PNG built by ImageMagick from big-endian samples. */
function png16(width: number, height: number, samples: Uint16Array): Buffer {
  const raw = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => raw.writeUInt16BE(v, i * 2));
  const input = file('samples.rgb', raw);
  return runConvert(['-size', `${width}x${height}`, '-depth', '16', '-endian', 'MSB', `rgb:${input}`, '-depth', '16', 'png:-']);
}

/** The 16-bit samples of a PNG, decoded by ImageMagick. */
function samples16(png: Buffer): Uint16Array {
  const raw = runConvert(['png:-', '-depth', '16', '-endian', 'MSB', 'rgb:-'], png);
  return Uint16Array.from({ length: raw.length / 2 }, (_, i) => raw.readUInt16BE(i * 2));
}

function insertIccProfile(png: Buffer, icc: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from('test\0\0', 'latin1'), zlib.deflateSync(icc)]);
  const chunk = Buffer.alloc(12 + body.length);
  chunk.writeUInt32BE(body.length, 0);
  chunk.write('iCCP', 4, 'latin1');
  body.copy(chunk, 8);
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, 8 + body.length)), 8 + body.length);
  const ihdrEnd = 8 + 12 + 13;
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)]);
}

function probe(target: string): Record<string, string> {
  const text = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_primaries,color_transfer,color_space', '-of', 'default=nw=1', target], { encoding: 'utf8' });
  return Object.fromEntries(text.trim().split('\n').map((line) => line.split('=')));
}

// ---------------------------------------------------------------------------------------------------------------

const RAMP_WIDTH = 1000;
const RAMP_PEAK = 10;
const SDR_WHITE_NITS = 100;

function rampExr(peak = RAMP_PEAK): Buffer {
  const rgb = new Float32Array(RAMP_WIDTH * 2 * 3);
  for (let x = 0; x < RAMP_WIDTH; x += 1) {
    const v = (x / (RAMP_WIDTH - 1)) * peak;
    rgb.set([v, v, v], x * 3); // grey row
    rgb.set([v, v / 2, v / 4], (RAMP_WIDTH + x) * 3); // coloured row
  }
  return writeRgbOpenExr(rgb, RAMP_WIDTH, 2, 'half');
}

describe.skipIf(skipWithoutTools('ffmpeg', 'ffprobe', 'identify') || skipUnless('ffmpeg with zscale and lutrgb', HAS_ZSCALE))('EXR to SDR', () => {
  const exr = rampExr();
  const decoded = decodeExrWithFfmpeg(exr);

  it('renders a 0 to 10 ramp with BT.2390 by default, within 40 dB of the zscale reference', async () => {
    const result = await convertImage(exr, 'png', {}, 'ramp.exr', 'exr');
    const nits = decoded.rgb.map((v) => v * SDR_WHITE_NITS);
    const peak = nits.reduce((m, v) => Math.max(m, v), 0);
    const reference = renderSdrWithZimg(nits, RAMP_WIDTH, 2, 'linear-nits', 'bt709', peak);
    expect(peak).toBeCloseTo(1000, 3);
    expect(psnrDb(rgbOf(result.buffer), reference)).toBeGreaterThanOrEqual(MIN_PSNR_DB);
    expect(result.metadata).toEqual({ toneMap: { mode: 'bt2390', sourcePeakNits: peak, sourcePeakOrigin: 'content', targetPeakNits: 100, compressed: true } });
  });

  it('keeps highlights apart that a clip merges', async () => {
    const mapped = rgbOf((await convertImage(exr, 'png', {}, 'ramp.exr', 'exr')).buffer);
    // grey row: input 1.0 (x = 99) and input 5.0 (x = 499) both clip to 255 but stay different under BT.2390
    expect(mapped[499 * 3]).toBeGreaterThan(mapped[99 * 3]);
    expect(mapped[499 * 3]).toBeLessThan(BYTE_MAX);
  });

  it('clip turns everything above 1.0 into 255 and encodes the rest as sRGB', async () => {
    const mapped = rgbOf((await convertImage(exr, 'png', { toneMap: 'clip' }, 'ramp.exr', 'exr')).buffer);
    for (let x = 0; x < RAMP_WIDTH; x += 1) {
      const v = decoded.rgb[x * 3];
      if (v > 1) {
        expect(Array.from(mapped.subarray(x * 3, x * 3 + 3))).toEqual([BYTE_MAX, BYTE_MAX, BYTE_MAX]);
      } else {
        expect(Math.abs(mapped[x * 3] - Math.round(srgbEncode(v) * BYTE_MAX))).toBeLessThanOrEqual(1);
      }
    }
  });

  it('a picture inside the SDR range is only clipped, so the default changes nothing for it', async () => {
    const rgb = Float32Array.from([0.02, 0.25, 0.5, 0.75, 0.9, 1, 0.1, 0.4, 0.8, 0, 0.3, 0.6]);
    const exrSoft = writeRgbOpenExr(rgb, 4, 1, 'half');
    const half = decodeExrWithFfmpeg(exrSoft).rgb;
    const result = await convertImage(exrSoft, 'png', {}, 'soft.exr', 'exr');
    const mapped = rgbOf(result.buffer);
    half.forEach((v, i) => expect(Math.abs(mapped[i] - Math.round(srgbEncode(v) * BYTE_MAX))).toBeLessThanOrEqual(1));
    expect(result.metadata).toMatchObject({ toneMap: { compressed: false } });
  });

  it('refuses toneMap "none" for an SDR target and an unknown mode, with typed errors', async () => {
    const refused = await convertImage(exr, 'jpg', { toneMap: 'none' }, 'ramp.exr', 'exr').then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(UnsupportedOptionError);
    expect((refused as Error).message).toMatch(/toneMap "none" keeps HDR/);
    const unknown = await convertImage(exr, 'png', { toneMap: 'filmic' as never }, 'ramp.exr', 'exr').then(
      () => null,
      (error: unknown) => error,
    );
    expect(unknown).toBeInstanceOf(UnsupportedOptionError);
    expect((unknown as Error).message).toMatch(/toneMap "filmic" is not supported; use one of none, clip, bt2390/);
  });

  it('toneMap "none" writes a 10-bit AVIF tagged BT.2020 and PQ whose samples are the PQ encoding of the radiance', async () => {
    const result = await convertImage(exr, 'avif', { toneMap: 'none', quality: 100 }, 'ramp.exr', 'exr');
    const target = file('hdr.avif', result.buffer);
    expect(probe(target)).toMatchObject({ color_primaries: 'bt2020', color_transfer: 'smpte2084' });
    const info = execFileSync(requireOracleTool('avifdec'), ['--info', target], { encoding: 'utf8' });
    expect(info).toMatch(/Color Primaries\s*:\s*9\b/);
    expect(info).toMatch(/Transfer Char\.\s*:\s*16\b/);
    expect(info).toMatch(/Bit Depth\s*:\s*10/);
    // no tone mapping happened, so the only fact reported is which AVIF encoder wrote the file
    expect(result.metadata).toEqual({ avifEncoder: expect.stringMatching(/^(library-cli|image-library)$/) });
    // grey row, 1000 nits at the right edge: PQ(1000) in 10-bit codes
    const decodedPng = file('hdr.png', execFileSync(requireOracleTool('avifdec'), ['-d', '16', target, path.join(work, 'hdr-out.png')]) && readFileSync(path.join(work, 'hdr-out.png')));
    const codes = samples16(readFileSync(decodedPng));
    const edge = (RAMP_WIDTH - 1) * 3;
    expect(codes[edge] / 65535).toBeCloseTo(pqOfNits(1000), 2);
    const mid = 499 * 3;
    expect(codes[mid] / 65535).toBeCloseTo(pqOfNits(decoded.rgb[mid] * SDR_WHITE_NITS), 2);
  });

  it('toneMap "none" writes a 16-bit PNG with a cICP chunk for BT.2020 PQ', async () => {
    const result = await convertImage(exr, 'png', { toneMap: 'none' }, 'ramp.exr', 'exr');
    const target = file('hdr-pq.png', result.buffer);
    const tags = execFileSync(requireOracleTool('exiftool'), ['-s3', '-PNG-cICP:ColorPrimaries', '-PNG-cICP:TransferCharacteristics', target], { encoding: 'utf8' });
    expect(tags).toMatch(/BT\.2020/);
    expect(tags).toMatch(/SMPTE ST 2084/);
    const codes = samples16(result.buffer);
    const mid = 499 * 3;
    expect(codes[mid] / 65535).toBeCloseTo(pqOfNits(decoded.rgb[mid] * SDR_WHITE_NITS), 3);
  });
});

// ---------------------------------------------------------------------------------------------------------------

const STILL_W = 48;
const STILL_H = 32;

/** PQ or HLG signals: a gradient field whose brightest sample is `topSignal`. */
function hdrSignals(topSignal: number, grey = false): Uint16Array {
  const out = new Uint16Array(STILL_W * STILL_H * 3);
  for (let y = 0; y < STILL_H; y += 1) {
    for (let x = 0; x < STILL_W; x += 1) {
      const i = (y * STILL_W + x) * 3;
      out[i] = Math.round((x / (STILL_W - 1)) * topSignal * 65535);
      out[i + 1] = grey ? out[i] : Math.round((y / (STILL_H - 1)) * topSignal * 0.9 * 65535);
      out[i + 2] = grey ? out[i] : Math.round((1 - x / (STILL_W - 1)) * topSignal * 0.7 * 65535);
    }
  }
  return out;
}

describe.skipIf(skipWithoutTools('ffmpeg', 'ffprobe', 'identify') || skipUnless('ffmpeg with zscale and lutrgb', HAS_ZSCALE))('PQ and HLG tagged pictures to SDR', () => {
  it.each([
    ['PQ', 16, 'pq' as const, pqOfNits(1000)],
    ['HLG', 18, 'hlg' as const, 1],
  ])('a %s PNG (BT.2020) is tone mapped like the zscale reference', async (_name, transfer, input, top) => {
    // zscale applies the HLG OOTF to each component separately, so the HLG reference is a grey ramp, where that
    // equals the BT.2100 luminance form; HLG colours are checked against worked values in hdr-tonemap.test.ts.
    const tagged = writePngCicp(png16(STILL_W, STILL_H, hdrSignals(top, input === 'hlg')), { primaries: 9, transfer, matrix: 0, fullRange: true });
    const signals = samples16(tagged);
    const floats = Float32Array.from(signals, (v) => v / 65535);
    let sourcePeak = 1000;
    if (input === 'pq') sourcePeak = floats.reduce((m, v) => Math.max(m, nitsOfPq(v)), 0);
    const reference = renderSdrWithZimg(floats, STILL_W, STILL_H, input, 'bt2020', sourcePeak);
    const result = await convertImage(tagged, 'png', {}, 'hdr.png', 'png');
    expect(psnrDb(rgbOf(result.buffer), reference)).toBeGreaterThanOrEqual(MIN_PSNR_DB);
    expect(result.metadata).toMatchObject({ toneMap: { mode: 'bt2390', compressed: true, sourcePeakOrigin: input === 'hlg' ? 'hlg-reference' : 'content' } });
  });

  it('toneMap "clip" cuts a PQ picture at SDR white instead of compressing it', async () => {
    const tagged = writePngCicp(png16(STILL_W, STILL_H, hdrSignals(pqOfNits(1000))), { primaries: 9, transfer: 16, matrix: 0, fullRange: true });
    const clipped = rgbOf((await convertImage(tagged, 'png', { toneMap: 'clip' }, 'hdr.png', 'png')).buffer);
    const mapped = rgbOf((await convertImage(tagged, 'png', {}, 'hdr.png', 'png')).buffer);
    const lastRed = ((STILL_H - 1) * STILL_W + STILL_W - 1) * 3;
    expect(clipped[lastRed]).toBe(BYTE_MAX);
    // the green channel of the brightest column keeps a gradient only under bt2390
    const column = (rgb: Uint8Array): Set<number> => new Set(Array.from({ length: STILL_H }, (_, y) => rgb[(y * STILL_W + STILL_W - 1) * 3 + 1]));
    expect(column(mapped).size).toBeGreaterThan(column(clipped).size);
  });

  it('an AVIF written by the reference encoder with nclx 9/16 is tone mapped the same way', async () => {
    const source = file('pq.png', png16(STILL_W, STILL_H, hdrSignals(pqOfNits(1000))));
    const avif = path.join(work, 'pq.avif');
    execFileSync(requireOracleTool('avifenc'), ['-l', '-d', '10', '--cicp', '9/16/0', '--range', 'f', source, avif], { stdio: 'pipe' });
    const decodedPng = path.join(work, 'pq-decoded.png');
    execFileSync(requireOracleTool('avifdec'), ['-d', '16', avif, decodedPng], { stdio: 'pipe' });
    const floats = Float32Array.from(samples16(readFileSync(decodedPng)), (v) => v / 65535);
    const sourcePeak = floats.reduce((m, v) => Math.max(m, nitsOfPq(v)), 0);
    const reference = renderSdrWithZimg(floats, STILL_W, STILL_H, 'pq', 'bt2020', sourcePeak);
    const result = await convertImage(readFileSync(avif), 'jpg', { quality: 95 }, 'hdr.avif', 'avif');
    const rendered = Uint8Array.from(rgbOf(await sharp(result.buffer).png().toBuffer()));
    expect(psnrDb(rendered, reference)).toBeGreaterThanOrEqual(MIN_PSNR_DB - 4);
  });

  it('a PQ picture to a PQ AVIF keeps its tag and values; to toneMap "none" JPEG it is refused', async () => {
    const tagged = writePngCicp(png16(STILL_W, STILL_H, hdrSignals(pqOfNits(1000))), { primaries: 9, transfer: 16, matrix: 0, fullRange: true });
    const out = await convertImage(tagged, 'avif', { toneMap: 'none', quality: 100 }, 'hdr.png', 'png');
    const samePath = file('same.avif', out.buffer);
    expect(probe(samePath)).toMatchObject({ color_primaries: 'bt2020', color_transfer: 'smpte2084' });
    // HDR AVIF is 10-bit, the depth every deep AVIF this converter writes is capped at (AV1 Main profile).
    expect(execFileSync(requireOracleTool('avifdec'), ['--info', samePath], { encoding: 'utf8' })).toMatch(/Bit Depth\s*:\s*10/);
    await expect(convertImage(tagged, 'jpg', { toneMap: 'none' }, 'hdr.png', 'png')).rejects.toThrow(/toneMap "none" keeps HDR/);
  });

  it('a PQ picture in unsupported primaries is a typed 400, not a guess', async () => {
    const tagged = writePngCicp(png16(STILL_W, STILL_H, hdrSignals(0.5)), { primaries: 5, transfer: 16, matrix: 0, fullRange: true });
    const failure = await convertImage(tagged, 'png', {}, 'hdr.png', 'png').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ColourTagError);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/Unsupported colour primaries 5/);
  });

  it('a PQ picture to EXR keeps the radiance: linear Rec. 709, 1.0 at 100 cd/m2', async () => {
    const tagged = writePngCicp(png16(STILL_W, STILL_H, hdrSignals(0.5)), { primaries: 9, transfer: 16, matrix: 0, fullRange: true });
    const exr = (await convertImage(tagged, 'exr', { outputDepth: 32 }, 'hdr.png', 'png')).buffer;
    const radiance = decodeExrWithFfmpeg(exr).rgb;
    const signals = samples16(tagged);
    // ITU-R BT.2087 table: linear BT.2020 to linear BT.709
    const to709 = [1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187];
    let worst = 0;
    for (let p = 0; p < STILL_W * STILL_H; p += 1) {
      const nits = [0, 1, 2].map((c) => nitsOfPq(signals[p * 3 + c] / 65535));
      for (let row = 0; row < 3; row += 1) {
        const expected = (to709[row * 3] * nits[0] + to709[row * 3 + 1] * nits[1] + to709[row * 3 + 2] * nits[2]) / 100;
        worst = Math.max(worst, Math.abs(radiance[p * 3 + row] - expected) / Math.max(1, Math.abs(expected)));
      }
    }
    expect(worst).toBeLessThan(2e-3);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** Lindbloom's linear sRGB from XYZ relative to D50 (Bradford adapted). */
const XYZ_D50_TO_SRGB = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914, 1.4052427];
const P3_COLORANT_MATRIX = [
  DISPLAY_P3_COLORANTS.red[0], DISPLAY_P3_COLORANTS.green[0], DISPLAY_P3_COLORANTS.blue[0],
  DISPLAY_P3_COLORANTS.red[1], DISPLAY_P3_COLORANTS.green[1], DISPLAY_P3_COLORANTS.blue[1],
  DISPLAY_P3_COLORANTS.red[2], DISPLAY_P3_COLORANTS.green[2], DISPLAY_P3_COLORANTS.blue[2],
];

function p3ToLinearSrgb(rgb8: number[]): number[] {
  const lin = rgb8.map((v) => srgbDecode(v / BYTE_MAX));
  const xyz = [0, 1, 2].map((r) => P3_COLORANT_MATRIX[r * 3] * lin[0] + P3_COLORANT_MATRIX[r * 3 + 1] * lin[1] + P3_COLORANT_MATRIX[r * 3 + 2] * lin[2]);
  return [0, 1, 2].map((r) => XYZ_D50_TO_SRGB[r * 3] * xyz[0] + XYZ_D50_TO_SRGB[r * 3 + 1] * xyz[1] + XYZ_D50_TO_SRGB[r * 3 + 2] * xyz[2]);
}

describe.skipIf(skipWithoutTools('ffmpeg', 'ffprobe'))('SDR to EXR colour management', () => {
  const levels = [0, 51, 102, 153, 204, 255];
  const colours: number[][] = [];
  for (const r of levels) for (const g of levels) for (const b of levels) colours.push([r, g, b]);

  async function gridPng(): Promise<Buffer> {
    const raw = Buffer.from(colours.flat());
    return sharp(raw, { raw: { width: colours.length, height: 1, channels: 3 } }).png().toBuffer();
  }

  it('a Display P3 profile is applied: linear values match the matrix math within 1e-3', async () => {
    const icc = buildMatrixProfile({ version: 4, ...DISPLAY_P3_COLORANTS, curves: [SRGB_PARA, SRGB_PARA, SRGB_PARA] });
    const tagged = insertIccProfile(await gridPng(), icc);
    const exr = (await convertImage(tagged, 'exr', { outputDepth: 32 }, 'p3.png', 'png')).buffer;
    const linear = decodeExrWithFfmpeg(exr).rgb;
    let worst = 0;
    colours.forEach((colour, p) => {
      const expected = p3ToLinearSrgb(colour);
      for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(linear[p * 3 + c] - expected[c]));
    });
    expect(worst).toBeLessThanOrEqual(1e-3);
    // saturated P3 green lies outside sRGB: a negative red component survives in float
    const green = colours.findIndex((c) => c[0] === 0 && c[1] === 255 && c[2] === 0);
    expect(linear[green * 3]).toBeLessThan(-0.1);
  });

  it('without a profile or tag the picture is sRGB, as before', async () => {
    const exr = (await convertImage(await gridPng(), 'exr', { outputDepth: 32 }, 'plain.png', 'png')).buffer;
    const linear = decodeExrWithFfmpeg(exr).rgb;
    colours.forEach((colour, p) => {
      for (let c = 0; c < 3; c += 1) expect(Math.abs(linear[p * 3 + c] - srgbDecode(colour[c] / BYTE_MAX))).toBeLessThanOrEqual(1e-6);
    });
  });

  it('a cICP tag for Display P3 with the sRGB transfer is applied too', async () => {
    const tagged = writePngCicp(await gridPng(), { primaries: 12, transfer: 13, matrix: 0, fullRange: true });
    const linear = decodeExrWithFfmpeg((await convertImage(tagged, 'exr', { outputDepth: 32 }, 'p3.png', 'png')).buffer).rgb;
    let worst = 0;
    colours.forEach((colour, p) => {
      const expected = p3ToLinearSrgb(colour);
      for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(linear[p * 3 + c] - expected[c]));
    });
    expect(worst).toBeLessThanOrEqual(2e-3);
  });

  it('a cICP tag with a transfer function the converter does not implement is a typed 400', async () => {
    const tagged = writePngCicp(await gridPng(), { primaries: 1, transfer: 4, matrix: 0, fullRange: true });
    const failure = await convertImage(tagged, 'exr', {}, 'odd.png', 'png').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ColourTagError);
    expect((failure as Error).message).toMatch(/Unsupported transfer characteristics 4/);
  });
});
