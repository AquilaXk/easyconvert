import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertImage, encode16BitTiff } from '../src/lib/conversions/image';
import { hasSrgbPrimaries, isSrgbProfile, srgb16LutsFromProfile } from '../src/lib/conversions/icc-srgb';
import { SRGB_COLORANTS, buildGrayProfile, buildMatrixProfile } from './helpers/icc-writer';

/**
 * A profile that describes sRGB is not worth carrying into an output: it says what a viewer assumes anyway. Oracles: the profile
 * files are produced outside the code under test (the usual 3 kB profile that ships as data with the PDF library, the profiles the
 * image library embeds for `srgb` and `p3`), and exiftool-style identification is replaced by their known identity.
 */

const bytesOf = async (name: 'srgb' | 'p3'): Promise<Buffer> => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#808080' } }).withIccProfile(name).png().toBuffer();
  return (await sharp(png).metadata()).icc as Buffer;
};

describe('sRGB profile detection', () => {
  it('recognises the usual 3 kB sRGB profile and the one the image library embeds', async () => {
    const usual = readFileSync(path.join(__dirname, '..', 'node_modules', 'pdfkit', 'js', 'data', 'sRGB_IEC61966_2_1.icc'));
    expect(isSrgbProfile(usual)).toBe(true);
    expect(hasSrgbPrimaries(usual)).toBe(true);
    expect(srgb16LutsFromProfile(usual)).toBeNull();
    const embedded = await bytesOf('srgb');
    expect(isSrgbProfile(embedded)).toBe(true);
    expect(hasSrgbPrimaries(embedded)).toBe(true);
    expect(srgb16LutsFromProfile(embedded)).toBeNull();
  });

  it('recognises an sRGB-primaries development curve (gamma 2.222) as sRGB primaries without mistaking its tone curve for IEC 61966-2-1 sRGB', () => {
    const gamma222 = { type: 'gamma', gamma: 2.222 } as const;
    const rawDevelopmentProfile = buildMatrixProfile({ version: 2, ...SRGB_COLORANTS, curves: [gamma222, gamma222, gamma222] });
    expect(hasSrgbPrimaries(rawDevelopmentProfile)).toBe(true);
    expect(isSrgbProfile(rawDevelopmentProfile)).toBe(false);
    const luts = srgb16LutsFromProfile(rawDevelopmentProfile);
    expect(luts).not.toBeNull();
    expect(luts![0][0]).toBe(0);
    expect(luts![0][65535]).toBe(65535);
    expect(luts![0][32768]).toBeGreaterThan(32768);
  });

  it('converts a 16-bit TIFF with an sRGB-primaries development curve to 16-bit PNG without lifting shadow zeros via Display P3', async () => {
    const dcrawGamma = { type: 'gamma', gamma: 495 / 256 } as const;
    const rawDevelopmentProfile = buildMatrixProfile({ version: 2, ...SRGB_COLORANTS, curves: [dcrawGamma, dcrawGamma, dcrawGamma] });
    const samples = new Uint16Array([4922, 6085, 0, 8950, 14990, 16059]);
    const tiff = encode16BitTiff(2, 1, samples, rawDevelopmentProfile);

    const pngResult = await convertImage(tiff, 'png', {}, 'canon.tiff', 'tiff');
    const { data, info } = await sharp(pngResult.buffer).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(2);
    expect(info.height).toBe(1);
    const out16 = new Uint16Array(data.buffer, data.byteOffset, data.byteLength >> 1);
    // Shadow blue=0 must stay 0 (the broken double Display P3 + sRGB ICC path lifted it to 457).
    expect(out16[2]).toBe(0);
    expect(Math.abs(out16[0] - 4984)).toBeLessThanOrEqual(2);
    expect(Math.abs(out16[1] - 6584)).toBeLessThanOrEqual(2);
    expect(Math.abs(out16[3] - 10297)).toBeLessThanOrEqual(5);
    expect(Math.abs(out16[4] - 17462)).toBeLessThanOrEqual(5);
    expect(Math.abs(out16[5] - 18661)).toBeLessThanOrEqual(5);
  });

  it('does not take a wider gamut for sRGB', async () => {
    const p3 = await bytesOf('p3');
    expect(isSrgbProfile(p3)).toBe(false);
    expect(hasSrgbPrimaries(p3)).toBe(false);
    expect(srgb16LutsFromProfile(p3)).toBeNull();
  });

  it('does not take bytes that are not a profile for one, nor a profile of another kind', () => {
    expect(isSrgbProfile(Buffer.from('not a profile'))).toBe(false);
    expect(hasSrgbPrimaries(Buffer.from('not a profile'))).toBe(false);
    expect(srgb16LutsFromProfile(Buffer.from('not a profile'))).toBeNull();
    expect(isSrgbProfile(Buffer.alloc(0))).toBe(false);
    expect(hasSrgbPrimaries(Buffer.alloc(0))).toBe(false);
    expect(hasSrgbPrimaries(buildGrayProfile())).toBe(false);
    expect(srgb16LutsFromProfile(buildGrayProfile())).toBeNull();
  });
});

