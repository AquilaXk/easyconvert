import zlib from 'node:zlib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { buildGrayProfile, buildMatrixProfile, SRGB_COLORANTS } from './helpers/icc-writer';
import { chunksOf, headerOf, scanlinesOf } from './helpers/png-pixels';

/**
 * A 16-bit PNG converted to PNG stays what it was: the colour type and the 16 bits, every sample (judged on the unfiltered rows that
 * `tests/helpers/png-pixels.ts` reads, which shares no code with the encoder), the profile it carries, and a file no larger than the
 * image library's own encoder writes for the same samples. A grey profile used to turn the picture into RGB written through the profile
 * (three times the samples, values moved by up to six steps of 65535), and an RGB profile with a plain gamma curve moved them as well.
 */

const COLOUR_TYPE_GREY = 0;
const COLOUR_TYPE_RGB = 2;
const COLOUR_TYPE_GREY_ALPHA = 4;
const SIXTEEN_BITS = 16;
const SIXTEEN_BIT_MAX = 65535;
const CONVERSION_TIMEOUT_MS = 60_000;
const PNG_SIGNATURE_BYTES = 8;
const IHDR_CHUNK_BYTES = 25;

function grain(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** A smooth ramp with a flat dark margin and a little grain: rows that different filters write best, as a radiograph's do. */
function samples16(width: number, height: number, channels: 1 | 2 | 3): Buffer {
  const random = grain(5);
  const out = Buffer.alloc(width * height * channels * 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const flat = x < width / 8 || y < height / 8;
      for (let c = 0; c < channels; c++) {
        const base = flat ? 0.04 : 0.15 + 0.6 * (x / width) * (0.5 + 0.5 * Math.sin(y / 9 + c));
        const value = c === 1 && channels === 2 ? SIXTEEN_BIT_MAX : Math.round(Math.min(1, base + (random() - 0.5) * 0.01) * SIXTEEN_BIT_MAX);
        out.writeUInt16LE(value, ((y * width + x) * channels + c) * 2);
      }
    }
  }
  return out;
}

const SRGB_PRIMARIES_GAMMA_22 = buildMatrixProfile({
  version: 2,
  ...SRGB_COLORANTS,
  curves: [{ type: 'gamma', gamma: 2.2 }, { type: 'gamma', gamma: 2.2 }, { type: 'gamma', gamma: 2.2 }],
});

interface Picture {
  name: string;
  width: number;
  height: number;
  channels: 1 | 2 | 3;
  colourType: number;
  profile: Buffer;
}

const PICTURES: Picture[] = [
  { name: 'grey with a grey profile', width: 120, height: 80, channels: 1, colourType: COLOUR_TYPE_GREY, profile: buildGrayProfile() },
  { name: 'grey and alpha with a grey profile', width: 120, height: 80, channels: 2, colourType: COLOUR_TYPE_GREY_ALPHA, profile: buildGrayProfile() },
  { name: 'RGB with a gamma 2.2 profile over sRGB primaries', width: 120, height: 80, channels: 3, colourType: COLOUR_TYPE_RGB, profile: SRGB_PRIMARIES_GAMMA_22 },
  // Past the size at which the encoder works on pool threads (256 KiB of samples).
  { name: 'a larger grey picture', width: 400, height: 340, channels: 1, colourType: COLOUR_TYPE_GREY, profile: buildGrayProfile() },
];

/** The `iCCP` chunk of a profile (keyword, 0, method 0, deflated profile). */
function iccpChunk(profile: Buffer): Buffer {
  const data = Buffer.concat([Buffer.from('profile\0\0', 'latin1'), zlib.deflateSync(profile)]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('iCCP', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** The picture as a 16-bit PNG by the library's default encoder, with the profile after the header when asked for (the little-endian samples are the host's). */
async function source(picture: Picture, withProfile: boolean): Promise<Buffer> {
  const { width, height, channels } = picture;
  const samples = samples16(width, height, channels);
  const png = await sharp(new Uint16Array(samples.buffer, samples.byteOffset, samples.length / 2), { raw: { width, height, channels } })
    .toColourspace(channels === 3 ? 'rgb16' : 'grey16')
    .png()
    .toBuffer();
  if (!withProfile) return png;
  const at = PNG_SIGNATURE_BYTES + IHDR_CHUNK_BYTES;
  return Buffer.concat([png.subarray(0, at), iccpChunk(picture.profile), png.subarray(at)]);
}

describe('a 16-bit PNG converted to PNG', () => {
  // The test judges the encoder's own file, so the lossless optimiser that follows a PNG to PNG conversion (entry 232) is out of the run.
  beforeAll(() => {
    vi.stubEnv('OXIPNG_PATH', '/nonexistent/oxipng');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it.each(PICTURES)('$name keeps its colour type, 16 bits, samples and profile, and is no larger than the library encoder writes it', async (picture) => {
    const png = await source(picture, true);
    expect(headerOf(png)).toMatchObject({ bitDepth: SIXTEEN_BITS, colorType: picture.colourType });
    expect(chunksOf(png).some((chunk) => chunk.type === 'iCCP')).toBe(true);

    const result = (await convertFile(png, 'png', 'png', {}, 'deep.png')).buffer;

    expect(headerOf(result)).toMatchObject({ width: picture.width, height: picture.height, bitDepth: SIXTEEN_BITS, colorType: picture.colourType });
    expect(scanlinesOf(result).rows.equals(scanlinesOf(png).rows)).toBe(true);
    const profile = chunksOf(result).find((chunk) => chunk.type === 'iCCP');
    expect(profile).toBeDefined();
    const plain = await source(picture, false);
    expect(result.length).toBeLessThanOrEqual(plain.length + profile!.data.length);
  }, CONVERSION_TIMEOUT_MS);
});
