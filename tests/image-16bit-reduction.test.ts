import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SRGB_PROFILE, srgbProfileChunk, textChunk, withChunksAfterHeader, xmpChunk } from './helpers/png-chunks';
import { convertImage } from '../src/lib/conversions/image';
import { decodePlainPngOnce, type DecodedPng } from '../src/lib/conversions/image-decoded-source';
import { roundedToEightBits } from '../src/lib/conversions/image-depth';

/**
 * The reduction of a 16-bit sample to the nearest 8-bit level is exact for every one of the 65536 inputs, and the 16-bit pictures
 * that reach an 8-bit encoder get that same level whether they carry an sRGB profile or not.
 * Oracles: the expected level is computed with rational arithmetic on BigInt (round-half-up of x * 255 / 65535, written here), and the
 * previous reduction (the image library's linear step followed by its high-byte cast) is run as it was, as a second, independent reference.
 */

const SIXTEEN_BIT_VALUES = 65536;
const SIXTEEN_BIT_MAX = 65535n;
const EIGHT_BIT_MAX = 255n;

/** round(x * 255 / 65535), halves up, as an exact fraction: floor((2 * 255 * x + 65535) / (2 * 65535)). */
function nearestLevel(sample: number): number {
  return Number((2n * EIGHT_BIT_MAX * BigInt(sample) + SIXTEEN_BIT_MAX) / (2n * SIXTEEN_BIT_MAX));
}

/** Every 16-bit value once in each band: band b of pixel i holds (i + b * 21845) mod 65536. */
function everyValue(): Uint16Array {
  const samples = new Uint16Array(SIXTEEN_BIT_VALUES * 3);
  for (let i = 0; i < SIXTEEN_BIT_VALUES; i += 1) {
    for (let band = 0; band < 3; band += 1) samples[i * 3 + band] = (i + band * 21845) % SIXTEEN_BIT_VALUES;
  }
  return samples;
}

describe('16-bit to 8-bit reduction', () => {
  it('gives every one of the 65536 inputs, in each band, the exact nearest level', async () => {
    const samples = everyValue();
    const side = 256;
    const reduced = await roundedToEightBits(sharp(samples, { raw: { width: side, height: side, channels: 3 } }).toColourspace('rgb16'), 3)
      .toColourspace('srgb')
      .raw({ depth: 'uchar' })
      .toBuffer();
    expect(reduced.length).toBe(samples.length);
    const wrong: number[] = [];
    for (let at = 0; at < samples.length; at += 1) if (reduced[at] !== nearestLevel(samples[at])) wrong.push(samples[at]);
    expect(wrong.slice(0, 10)).toEqual([]);
  });

  it('gives a plain 16-bit PNG decoded for an 8-bit encoder the exact nearest level of every sample', async () => {
    const samples = everyValue();
    const source = await sharp(samples, { raw: { width: 256, height: 256, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
    const narrow = (await decodePlainPngOnce(sharp(source), undefined, true)) as DecodedPng;
    const wrong: number[] = [];
    for (let at = 0; at < samples.length; at += 1) if (narrow.raster.samples[at] !== nearestLevel(samples[at])) wrong.push(samples[at]);
    expect(wrong.slice(0, 10)).toEqual([]);
  });

  it('gives the same levels when the PNG holds an sRGB profile and text, which the decode must not convert the samples through', async () => {
    const samples = everyValue();
    const plain = await sharp(samples, { raw: { width: 256, height: 256, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
    const source = withChunksAfterHeader(plain, [srgbProfileChunk(), textChunk()]);
    const narrow = (await decodePlainPngOnce(sharp(source), undefined, true)) as DecodedPng;
    expect(narrow).not.toBeNull();
    const wide = (await decodePlainPngOnce(sharp(source))) as DecodedPng;
    const wrong: number[] = [];
    for (let at = 0; at < samples.length; at += 1) {
      if (narrow.raster.samples[at] !== nearestLevel(samples[at]) || wide.raster.samples[at] !== samples[at]) wrong.push(samples[at]);
    }
    expect(wrong.slice(0, 10)).toEqual([]);
  });
});

/** A 16-bit colour picture of noise, which any colour transform through a profile would move by a level on some samples. */
function noisyPicture(side: number): Uint16Array {
  const samples = new Uint16Array(side * side * 3);
  let state = 0x9e3779b9;
  for (let i = 0; i < samples.length; i += 1) {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0;
    samples[i] = ((state >>> 16) ^ (state & 0xffff)) & 0xffff;
  }
  return samples;
}

/** A noisy 8-bit or 16-bit colour picture as a PNG without a profile. */
async function noisyPng(side: number, deep: boolean): Promise<Buffer> {
  const wide = noisyPicture(side);
  const samples = deep ? wide : Uint8Array.from(wide, (sample) => sample >> 8);
  return sharp(samples, { raw: { width: side, height: side, channels: 3 } })
    .toColourspace(deep ? 'rgb16' : 'srgb')
    .png()
    .toBuffer();
}

/**
 * An sRGB profile is not written and changes no pixel: a picture that holds one is written as the same file as the picture that
 * does not. With nothing else in the PNG the pixels are decoded once; with an XMP packet the image library reads the PNG (and
 * must not convert the samples through the profile, which for 16-bit samples goes through a wide-gamut space and moves them).
 */
describe('pictures with an sRGB profile', () => {
  const CASES = [
    ['16-bit', true, ['jpg', 'webp']],
    ['8-bit', false, ['jpg', 'webp', 'avif']],
  ] as const;
  const EXTRAS = [
    ['alone', []],
    ['with text', [textChunk()]],
    ['with an XMP packet', [xmpChunk()]],
  ] as const;
  it.each(
    CASES.flatMap(([depth, deep, targets]) =>
      EXTRAS.flatMap(([extra, chunks]) => targets.map((target) => ({ title: `${depth} picture ${extra}, written to ${target}`, deep, chunks, target })))
    )
  )('$title', async ({ deep, chunks, target }) => {
    const plain = await noisyPng(96, deep);
    const profiled = withChunksAfterHeader(plain, [srgbProfileChunk(), ...chunks]);
    const reference = withChunksAfterHeader(plain, [...chunks]);
    const meta = await sharp(profiled).metadata();
    expect([meta.hasProfile, meta.icc?.length, meta.depth]).toEqual([true, SRGB_PROFILE.length, deep ? 'ushort' : 'uchar']);
    const options = { quality: 100 };
    const fromReference = (await convertImage(reference, target, options, 'noise.png', 'png')).buffer;
    const fromProfiled = (await convertImage(profiled, target, options, 'noise.png', 'png')).buffer;
    expect(fromProfiled.equals(fromReference)).toBe(true);
  });
});
