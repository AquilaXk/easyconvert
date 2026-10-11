import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { isSrgbProfile } from '../src/lib/conversions/icc-srgb';

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
    expect(isSrgbProfile(await bytesOf('srgb'))).toBe(true);
  });

  it('does not take a wider gamut for sRGB', async () => {
    expect(isSrgbProfile(await bytesOf('p3'))).toBe(false);
  });

  it('does not take bytes that are not a profile for one, nor a profile of another kind', () => {
    expect(isSrgbProfile(Buffer.from('not a profile'))).toBe(false);
    expect(isSrgbProfile(Buffer.alloc(0))).toBe(false);
  });
});
