import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { reducesAtEncode } from '../src/lib/conversions/image-depth';
import { SRGB_COLORANTS, buildMatrixProfile } from './helpers/icc-writer';

/**
 * A 16-bit colour PNG sent to JPEG is classified by its 16-bit samples: a continuous-tone picture (a night sky, a radiograph, a developed
 * camera file) has thousands of tones and a flat black background that on 8 bits looks like a graphic, and a graphic has a palette.
 * Oracles: the reduction to 8 bits is the exact nearest level, computed here with BigInt (round-half-up of x * 255 / 65535); the encoder
 * options of the two classes are spelled out here from the encoder documentation of the options (table 3 and no trellis for a photograph,
 * table 2 and no trellis for a graphic, 4:2:0 and optimal Huffman tables for both below quality 90); and the 8-bit route of the same
 * picture is the product's own conversion of an 8-bit PNG that holds exactly those levels.
 */

const SIDE = 128;
const SIXTEEN_BIT_MAX = 65535n;
const EIGHT_BIT_MAX = 255n;

function nearestLevel(sample: number): number {
  return Number((2n * EIGHT_BIT_MAX * BigInt(sample) + SIXTEEN_BIT_MAX) / (2n * SIXTEEN_BIT_MAX));
}

function mix(state: number): number {
  const mixed = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x297a2d39;
  return (mixed ^ (mixed >>> 13)) >>> 0;
}

/** Left half flat black, right half a gradient with noise below the top byte: about 4000 tones in the 128 x 128 sample, 50% flat pairs. */
function nightSky(channels: 3 | 4): Uint16Array {
  const samples = new Uint16Array(SIDE * SIDE * channels);
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      const at = (y * SIDE + x) * channels;
      const lit = x >= SIDE / 2;
      for (let band = 0; band < 3; band += 1) samples[at + band] = lit ? (x * 400 + y * 90 + band * 700 + (mix(at + band) & 0x3ff)) & 0xffff : 0;
      if (channels === 4) samples[at + 3] = 0xffff;
    }
  }
  return samples;
}

/** Flat panels, two edges and a palette of 5 colours at 16 bits: no tone beyond them. */
function interfaceLike(channels: 3 | 4, translucentAt?: number): Uint16Array {
  const palette = [[60000, 60000, 60000], [3000, 20000, 50000], [50000, 8000, 8000], [12000, 12000, 12000], [65535, 65535, 0]];
  const samples = new Uint16Array(SIDE * SIDE * channels);
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      const at = (y * SIDE + x) * channels;
      const colour = palette[(Math.floor(x / 32) + Math.floor(y / 43)) % palette.length];
      samples.set(colour, at);
      if (channels === 4) samples[at + 3] = translucentAt === y * SIDE + x ? 0x9000 : 0xffff;
    }
  }
  return samples;
}

function png16(samples: Uint16Array, channels: 3 | 4): Promise<Buffer> {
  return sharp(samples, { raw: { width: SIDE, height: SIDE, channels } }).toColourspace('rgb16').png().toBuffer();
}

/** The same picture as an 8-bit PNG holding the nearest level of every sample. */
function png8(samples: Uint16Array, channels: 3 | 4): Promise<Buffer> {
  return sharp(Uint8Array.from(samples, nearestLevel), { raw: { width: SIDE, height: SIDE, channels } }).png().toBuffer();
}

const QUALITY = 70;
const COMMON = { quality: QUALITY, chromaSubsampling: '4:2:0', optimiseCoding: true, overshootDeringing: true, trellisQuantisation: false, progressive: false } as const;
const PHOTOGRAPH = { ...COMMON, quantisationTable: 3 } as const;
const GRAPHIC = { ...COMMON, quantisationTable: 2 } as const;

/** The 8-bit levels of `samples` without alpha, as the 8-bit pipeline encodes them. */
function encodeLevels(samples: Uint16Array, channels: 3 | 4, options: typeof PHOTOGRAPH | typeof GRAPHIC): Promise<Buffer> {
  const levels = Uint8Array.from(samples, nearestLevel);
  return sharp(levels, { raw: { width: SIDE, height: SIDE, channels } }).removeAlpha().jpeg(options).toBuffer();
}

describe('a 16-bit colour PNG sent to JPEG', () => {
  it.each([3, 4] as const)('is written with the photograph options when its 16-bit samples show continuous tone (%i bands)', async (channels) => {
    const samples = nightSky(channels);
    const out = (await convertImage(await png16(samples, channels), 'jpg', { quality: QUALITY }, 'sky.png', 'png')).buffer;
    expect(out.equals(await encodeLevels(samples, channels, PHOTOGRAPH))).toBe(true);
    expect(out.equals(await encodeLevels(samples, channels, GRAPHIC))).toBe(false);
  });

  it.each([3, 4] as const)('is written with the graphic options when its 16-bit samples are a palette (%i bands)', async (channels) => {
    const samples = interfaceLike(channels);
    const out = (await convertImage(await png16(samples, channels), 'jpg', { quality: QUALITY }, 'ui.png', 'png')).buffer;
    expect(out.equals(await encodeLevels(samples, channels, GRAPHIC))).toBe(true);
  });

  it.each([3, 4] as const)('gives the bytes of the 8-bit PNG that holds the nearest levels of its samples (%i bands, palette)', async (channels) => {
    const samples = interfaceLike(channels);
    const fromDeep = (await convertImage(await png16(samples, channels), 'jpg', { quality: QUALITY }, 'ui.png', 'png')).buffer;
    const fromLevels = (await convertImage(await png8(samples, channels), 'jpg', { quality: QUALITY }, 'ui8.png', 'png')).buffer;
    expect(fromDeep.equals(fromLevels)).toBe(true);
  });

  it('flattens a translucent pixel as the 8-bit picture does: the same bytes as the 8-bit PNG of the nearest levels', async () => {
    const samples = interfaceLike(4, 5 * SIDE + 7);
    const fromDeep = (await convertImage(await png16(samples, 4), 'jpg', { quality: QUALITY }, 'ui.png', 'png')).buffer;
    const fromLevels = (await convertImage(await png8(samples, 4), 'jpg', { quality: QUALITY }, 'ui8.png', 'png')).buffer;
    expect(fromDeep.equals(fromLevels)).toBe(true);
  });

  it('treats an alpha sample whose nearest level is the maximum as opaque, as before', async () => {
    const samples = interfaceLike(4);
    for (let at = 3; at < samples.length; at += 4) samples[at] = 0xff80;
    const fromDeep = (await convertImage(await png16(samples, 4), 'jpg', { quality: QUALITY }, 'ui.png', 'png')).buffer;
    const fromLevels = (await convertImage(await png8(samples, 4), 'jpg', { quality: QUALITY }, 'ui8.png', 'png')).buffer;
    expect(fromDeep.equals(fromLevels)).toBe(true);
  });

  it('keeps the 8-bit route when the picture is resized: the 16-bit samples are reduced first, as before', async () => {
    const samples = interfaceLike(3);
    const options = { quality: QUALITY, width: 96 };
    const fromDeep = (await convertImage(await png16(samples, 3), 'jpg', options, 'ui.png', 'png')).buffer;
    const fromLevels = (await convertImage(await png8(samples, 3), 'jpg', options, 'ui8.png', 'png')).buffer;
    expect(fromDeep.equals(fromLevels)).toBe(true);
  });

  it('keeps the 8-bit route when a background is flattened onto: the 16-bit samples are reduced first, as before', async () => {
    const samples = interfaceLike(4, 9 * SIDE + 3);
    const options = { quality: QUALITY, background: '#336699' };
    const fromDeep = (await convertImage(await png16(samples, 4), 'jpg', options, 'ui.png', 'png')).buffer;
    const fromLevels = (await convertImage(await png8(samples, 4), 'jpg', options, 'ui8.png', 'png')).buffer;
    expect(fromDeep.equals(fromLevels)).toBe(true);
  });
});

describe('reducesAtEncode', () => {
  const deepColour = { depth: 'ushort', space: 'rgb16', hasAlpha: false } as const;

  it.each([
    ['a 16-bit colour picture for JPEG', 'jpg', deepColour, false, false, true],
    ['a 16-bit grey picture for JPEG', 'jpg', { depth: 'ushort', space: 'grey16', hasAlpha: false }, false, false, true],
    ['a 16-bit colour picture with an opaque alpha plane that is dropped, for JPEG', 'jpg', { ...deepColour, hasAlpha: true }, false, true, true],
    ['a 16-bit colour picture with an alpha plane that is not dropped, for JPEG', 'jpg', { ...deepColour, hasAlpha: true }, false, false, false],
    ['a 16-bit grey picture with an opaque alpha plane that is dropped: its one-band form is converted first, so it keeps the 8-bit pipeline', 'jpg', { depth: 'ushort', space: 'grey16', hasAlpha: true }, false, true, false],
    ['a 16-bit colour picture to flatten onto a background, for JPEG', 'jpg', deepColour, true, false, false],
    ['an 8-bit picture', 'jpg', { depth: 'uchar', space: 'srgb', hasAlpha: false }, false, false, false],
    ['a header that is not asked for (a target that writes more than 8 bits)', 'png', undefined, false, false, false],
    ['a 16-bit colour picture with an alpha plane for WebP, which takes the plane along', 'webp', { ...deepColour, hasAlpha: true }, false, false, true],
    ['a 16-bit colour picture with an alpha plane and a background for WebP', 'webp', { ...deepColour, hasAlpha: true }, true, false, true],
  ] as const)('%s', (_name, fmt, meta, hasBackground, dropsOpaqueAlpha, expected) => {
    expect(reducesAtEncode(fmt, meta as never, hasBackground, dropsOpaqueAlpha)).toBe(expected);
  });

  it('does not reduce at the end a picture whose profile has sRGB primaries and another tone curve: the transform to sRGB works on 8 bits', () => {
    const gamma222 = { type: 'gamma', gamma: 2.222 } as const;
    const developmentProfile = buildMatrixProfile({ version: 2, ...SRGB_COLORANTS, curves: [gamma222, gamma222, gamma222] });
    expect(reducesAtEncode('jpg', { ...deepColour, icc: developmentProfile } as never, false, false)).toBe(false);
    expect(reducesAtEncode('webp', { ...deepColour, icc: developmentProfile } as never, false, false)).toBe(false);
  });

  it('reduces at the end a picture whose profile is sRGB itself or has other primaries: the profile is applied or kept, not converted', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#808080' } }).withIccProfile('p3').png().toBuffer();
    const p3 = (await sharp(png).metadata()).icc as Buffer;
    expect(reducesAtEncode('jpg', { ...deepColour, icc: p3 } as never, false, false)).toBe(true);
  });
});
