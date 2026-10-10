import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { multiply3 } from '../src/lib/conversions/colour-primaries';
import {
  ICC_MAX_BYTES,
  ICC_MAX_CURVE_ENTRIES,
  ICC_MAX_TAGS,
  IccProfileError,
  curveTable,
  iccToLinearBt709,
  readIccProfile,
  type IccMatrixTrcProfile,
} from '../src/lib/conversions/icc-reader';
import { ConversionFailedError } from '../src/lib/types';
import {
  DISPLAY_P3_COLORANTS,
  SRGB_COLORANTS,
  SRGB_PARA,
  buildGrayProfile,
  buildLutOnlyProfile,
  buildMatrixProfile,
  type CurveSpec,
} from './helpers/icc-writer';
import { skipUnless } from './helpers/strict-skip';

/**
 * The reader is checked against littlecms (through Pillow's ImageCms) on real colour conversions, against the
 * Display P3 profile that ships inside the image library, and against the published linear P3 to sRGB matrix.
 * Malformed profiles are built byte by byte.
 */

const ORACLE = path.join(__dirname, 'helpers', 'icc_oracle.py');
const HAS_LCMS = spawnSync('python3', ['-I', '-c', 'from PIL import ImageCms'], { encoding: 'utf8' }).status === 0;

/** CSS Color 4 / color.org: linear Display P3 to linear sRGB. */
const P3_TO_SRGB_PUBLISHED = [1.2249401, -0.2249402, 0, -0.0420569, 1.0420571, 0, -0.0196376, -0.0786361, 1.0982735];

function srgbEncode(linear: number): number {
  const v = Math.min(1, Math.max(0, linear));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

const LEVELS = [0, 32, 64, 96, 128, 160, 192, 224, 255];
const GRID: number[] = [];
for (const r of LEVELS) for (const g of LEVELS) for (const b of LEVELS) GRID.push(r, g, b);

/** Our conversion of 8-bit samples to 8-bit sRGB, plus a mask of the samples that stay inside the sRGB gamut. */
function convertWithReader(profile: IccMatrixTrcProfile): { rgb: number[]; inGamut: boolean[] } {
  const tables = profile.curves.map((curve) => curveTable(curve, 256));
  const matrix = iccToLinearBt709(profile);
  const rgb: number[] = [];
  const inGamut: boolean[] = [];
  for (let i = 0; i < GRID.length; i += 3) {
    const lin = [tables[0][GRID[i]], tables[1][GRID[i + 1]], tables[2][GRID[i + 2]]];
    const out = [0, 1, 2].map((row) => matrix[row * 3] * lin[0] + matrix[row * 3 + 1] * lin[1] + matrix[row * 3 + 2] * lin[2]);
    inGamut.push(out.every((v) => v >= 0.001 && v <= 0.999));
    for (const v of out) rgb.push(Math.round(srgbEncode(v) * 255));
  }
  return { rgb, inGamut };
}

function convertWithLcms(icc: Buffer, dir: string): number[] {
  const file = path.join(dir, `p-${icc.length}-${icc[100]}.icc`);
  writeFileSync(file, icc);
  const out = execFileSync('python3', ['-I', ORACLE, file], { input: Buffer.from(GRID) });
  return Array.from(out);
}

describe.skipIf(skipUnless('python3 with Pillow ImageCms (littlecms)', HAS_LCMS))('matrix/TRC conversion against littlecms', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'icc-reader-'));
  let p3Icc: Buffer;

  beforeAll(async () => {
    const tagged = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .withIccProfile('p3')
      .png()
      .toBuffer();
    p3Icc = (await sharp(tagged).metadata()).icc as Buffer;
  });

  function check(icc: Buffer): void {
    const parsed = readIccProfile(icc);
    expect(parsed.kind).toBe('matrix-trc');
    const ours = convertWithReader(parsed as IccMatrixTrcProfile);
    const reference = convertWithLcms(icc, dir);
    let worst = 0;
    let included = 0;
    let total = 0;
    ours.inGamut.forEach((inside, p) => {
      if (!inside) return;
      included += 1;
      for (let c = 0; c < 3; c += 1) {
        const diff = Math.abs(ours.rgb[p * 3 + c] - reference[p * 3 + c]);
        worst = Math.max(worst, diff);
        total += diff;
      }
    });
    expect(included).toBeGreaterThan(GRID.length / 3 / 4);
    expect(worst).toBeLessThanOrEqual(2);
    expect(total / (included * 3)).toBeLessThanOrEqual(0.6);
  }

  it('the Display P3 profile of the image library', () => check(p3Icc));

  it.each<[string, CurveSpec]>([
    ['sRGB parametric (type 3)', SRGB_PARA],
    ['gamma 2.2 (curv, one entry)', { type: 'gamma', gamma: 2.2 }],
    ['identity (curv, no entries)', { type: 'identity' }],
    ['a 33-point table', { type: 'table', values: Array.from({ length: 33 }, (_, i) => Math.pow(i / 32, 1.8)) }],
    ['parametric type 0 (gamma 2.6)', { type: 'para', fn: 0, params: [2.6] }],
    ['parametric type 1', { type: 'para', fn: 1, params: [2.2, 0.9, 0.1] }],
    ['parametric type 2', { type: 'para', fn: 2, params: [2.2, 0.9, 0.1, 0.02] }],
    ['parametric type 4', { type: 'para', fn: 4, params: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045, 0, 0] }],
  ])('version 4 sRGB colorants with %s', (_name, curve) => {
    check(buildMatrixProfile({ version: 4, ...SRGB_COLORANTS, curves: [curve, curve, curve] }));
  });

  it.each([2, 4] as const)('version %i profile with Display P3 colorants and the sRGB curve', (version) => {
    check(buildMatrixProfile({ version, ...DISPLAY_P3_COLORANTS, curves: [SRGB_PARA, SRGB_PARA, SRGB_PARA] }));
  });

  it('channels may carry different curves', () => {
    check(
      buildMatrixProfile({
        version: 4,
        ...SRGB_COLORANTS,
        curves: [{ type: 'gamma', gamma: 1.8 }, SRGB_PARA, { type: 'para', fn: 0, params: [2.6] }],
      }),
    );
  });
});

describe('colorants', () => {
  it('Display P3 maps to linear Rec. 709 with the published matrix', () => {
    const profile = readIccProfile(buildMatrixProfile({ version: 4, ...DISPLAY_P3_COLORANTS, curves: [SRGB_PARA, SRGB_PARA, SRGB_PARA] })) as IccMatrixTrcProfile;
    const matrix = iccToLinearBt709(profile);
    P3_TO_SRGB_PUBLISHED.forEach((value, i) => expect(matrix[i]).toBeCloseTo(value, 2));
  });

  it('sRGB colorants map to the identity', () => {
    const profile = readIccProfile(buildMatrixProfile({ version: 2, ...SRGB_COLORANTS, curves: [SRGB_PARA, SRGB_PARA, SRGB_PARA] })) as IccMatrixTrcProfile;
    const matrix = iccToLinearBt709(profile);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((value, i) => expect(matrix[i]).toBeCloseTo(value, 3));
    expect(multiply3(matrix, [1, 0, 0, 0, 1, 0, 0, 0, 1])).toEqual(matrix);
  });
});

describe('profiles that are not matrix/TRC', () => {
  it('a lookup-table RGB profile is reported as another kind, not rejected', () => {
    expect(readIccProfile(buildLutOnlyProfile())).toMatchObject({ kind: 'other', colourSpace: 'RGB ', reason: expect.stringContaining('lookup-table') });
  });

  it('a grey profile is reported with its colour space', () => {
    expect(readIccProfile(buildGrayProfile())).toMatchObject({ kind: 'other', colourSpace: 'GRAY' });
  });
});

describe('malformed profiles fail with a typed error', () => {
  const valid = buildMatrixProfile({ version: 4, ...SRGB_COLORANTS, curves: [SRGB_PARA, SRGB_PARA, SRGB_PARA] });

  function failure(buf: Buffer): Error {
    try {
      readIccProfile(buf);
    } catch (error) {
      return error as Error;
    }
    throw new Error('the profile was accepted');
  }

  it.each<[string, (b: Buffer) => Buffer, RegExp]>([
    ['a signature other than acsp', (b) => Buffer.concat([b.subarray(0, 36), Buffer.from('nope'), b.subarray(40)]), /missing the "acsp" file signature/],
    ['a major version of 7', (b) => Buffer.from(b).fill(7, 8, 9), /unsupported major version 7/],
    ['fewer bytes than a header', (b) => b.subarray(0, 100), /shorter than a profile header/],
    ['a declared size past the data', (b) => Buffer.from(b).fill(0xff, 0, 1), /declares \d+ bytes but only \d+ are present/],
    ['a tag count over the limit', (b) => { const c = Buffer.from(b); c.writeUInt32BE(ICC_MAX_TAGS + 1, 128); return c; }, new RegExp(`declares ${ICC_MAX_TAGS + 1} tags`)],
    ['a tag table cut short', (b) => { const c = Buffer.from(b); c.writeUInt32BE(ICC_MAX_TAGS, 128); c.writeUInt32BE(300, 0); return c.subarray(0, 300); }, /tag table is truncated/],
    ['a tag outside the profile', (b) => { const c = Buffer.from(b); c.writeUInt32BE(b.length + 100, 128 + 4 + 8 * 12 + 4); return c; }, /lies outside the profile/],
    ['more bytes than the limit', () => { const c = Buffer.alloc(ICC_MAX_BYTES + 1); return c; }, new RegExp(`exceed the ${ICC_MAX_BYTES} byte limit`)],
    ['a missing curve tag', (b) => { const c = Buffer.from(b); c.write('zzzz', 128 + 4 + 8 * 12, 'latin1'); return c; }, /lacks bTRC/],
  ])('%s', (_name, mutate, message) => {
    const error = failure(mutate(valid));
    expect(error).toBeInstanceOf(IccProfileError);
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error.message).toMatch(message);
  });

  it('a curve table over the entry limit and an unknown parametric function are refused', () => {
    const big = buildMatrixProfile({ version: 4, ...SRGB_COLORANTS, curves: [{ type: 'identity' }, SRGB_PARA, SRGB_PARA] });
    const at = big.indexOf(Buffer.from('curv'));
    big.writeUInt32BE(ICC_MAX_CURVE_ENTRIES + 1, at + 8);
    expect(failure(big).message).toMatch(new RegExp(`has ${ICC_MAX_CURVE_ENTRIES + 1} entries`));

    const bad = Buffer.from(valid);
    const para = bad.indexOf(Buffer.from('para'));
    bad.writeUInt16BE(9, para + 8);
    expect(failure(bad).message).toMatch(/uses parametric function 9/);
  });
});
