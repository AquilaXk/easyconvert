import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { hasSrgbPrimaries, isSrgbProfile } from '../src/lib/conversions/icc-srgb';
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
    const embedded = await bytesOf('srgb');
    expect(isSrgbProfile(embedded)).toBe(true);
    expect(hasSrgbPrimaries(embedded)).toBe(true);
  });

  it('recognises an sRGB-primaries development curve (gamma 2.222) as sRGB primaries without mistaking its tone curve for IEC 61966-2-1 sRGB', () => {
    const gamma222 = { type: 'gamma', gamma: 2.222 } as const;
    const rawDevelopmentProfile = buildMatrixProfile({ version: 2, ...SRGB_COLORANTS, curves: [gamma222, gamma222, gamma222] });
    expect(hasSrgbPrimaries(rawDevelopmentProfile)).toBe(true);
    expect(isSrgbProfile(rawDevelopmentProfile)).toBe(false);
  });

  it('does not take a wider gamut for sRGB', async () => {
    const p3 = await bytesOf('p3');
    expect(isSrgbProfile(p3)).toBe(false);
    expect(hasSrgbPrimaries(p3)).toBe(false);
  });

  it('does not take bytes that are not a profile for one, nor a profile of another kind', () => {
    expect(isSrgbProfile(Buffer.from('not a profile'))).toBe(false);
    expect(hasSrgbPrimaries(Buffer.from('not a profile'))).toBe(false);
    expect(isSrgbProfile(Buffer.alloc(0))).toBe(false);
    expect(hasSrgbPrimaries(Buffer.alloc(0))).toBe(false);
    expect(hasSrgbPrimaries(buildGrayProfile())).toBe(false);
  });
});
