import zlib from 'node:zlib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { buildGrayProfile } from './helpers/icc-writer';
import { chunksOf, headerOf, scanlinesOf } from './helpers/png-pixels';

/**
 * An 8-bit grey PNG converted to PNG stays grey, with the profile it carries and every sample (judged on the unfiltered rows that
 * `tests/helpers/png-pixels.ts` reads). The image library used to write it as RGB, where a grey profile cannot be kept.
 */

const COLOUR_TYPE_GREY = 0;
const COLOUR_TYPE_GREY_ALPHA = 4;
const EIGHT_BITS = 8;
const PNG_SIGNATURE_BYTES = 8;
const IHDR_CHUNK_BYTES = 25;
const CONVERSION_TIMEOUT_MS = 60_000;

/** A ramp with a little deterministic grain, so that rows differ and the filters have work to do. */
function samples8(width: number, height: number, channels: 1 | 2): Buffer {
  const out = Buffer.alloc(width * height * channels);
  let state = 7;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const at = (y * width + x) * channels;
      out[at] = Math.min(255, Math.round((x / width) * 200 + (y % 7) * 3 + (state >>> 28)));
      if (channels === 2) out[at + 1] = 255 - ((x + y) % 200);
    }
  }
  return out;
}

function iccpChunk(profile: Buffer): Buffer {
  const data = Buffer.concat([Buffer.from('profile\0\0', 'latin1'), zlib.deflateSync(profile)]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('iCCP', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

async function greyPng(width: number, height: number, channels: 1 | 2, profile: Buffer | null): Promise<Buffer> {
  const png = await sharp(samples8(width, height, channels), { raw: { width, height, channels } }).toColourspace('b-w').png().toBuffer();
  if (profile === null) return png;
  const at = PNG_SIGNATURE_BYTES + IHDR_CHUNK_BYTES;
  return Buffer.concat([png.subarray(0, at), iccpChunk(profile), png.subarray(at)]);
}

const CASES = [
  { name: 'grey with a grey profile', channels: 1 as const, colourType: COLOUR_TYPE_GREY, profile: buildGrayProfile() },
  { name: 'grey and alpha with a grey profile', channels: 2 as const, colourType: COLOUR_TYPE_GREY_ALPHA, profile: buildGrayProfile() },
  { name: 'grey with no profile', channels: 1 as const, colourType: COLOUR_TYPE_GREY, profile: null },
  { name: 'grey and alpha with no profile', channels: 2 as const, colourType: COLOUR_TYPE_GREY_ALPHA, profile: null },
];

describe('an 8-bit grey PNG converted to PNG', () => {
  // The test judges the encoder's own file, so the lossless optimiser that follows (entry 232) is out of the run.
  beforeAll(() => {
    vi.stubEnv('OXIPNG_PATH', '/nonexistent/oxipng');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it.each(CASES)('$name stays grey, keeps its profile and its samples', async ({ channels, colourType, profile }) => {
    const png = await greyPng(160, 90, channels, profile);
    expect(headerOf(png)).toMatchObject({ bitDepth: EIGHT_BITS, colorType: colourType });

    const result = (await convertFile(png, 'png', 'png', {}, 'grey.png')).buffer;

    expect(headerOf(result)).toMatchObject({ width: 160, height: 90, bitDepth: EIGHT_BITS, colorType: colourType });
    expect(scanlinesOf(result).rows.equals(scanlinesOf(png).rows)).toBe(true);
    const kept = chunksOf(result).find((chunk) => chunk.type === 'iCCP');
    expect(kept !== undefined).toBe(profile !== null);
  }, CONVERSION_TIMEOUT_MS);

  it('stays grey from a grey TIFF, as a PNG with no profile', async () => {
    const tiff = await sharp(samples8(160, 90, 1), { raw: { width: 160, height: 90, channels: 1 } }).toColourspace('b-w').tiff({ compression: 'none' }).toBuffer();
    const result = (await convertFile(tiff, 'tiff', 'png', {}, 'grey.tiff')).buffer;
    expect(headerOf(result)).toMatchObject({ bitDepth: EIGHT_BITS, colorType: COLOUR_TYPE_GREY });
    expect(scanlinesOf(result).rows.equals(samples8(160, 90, 1))).toBe(true);
  }, CONVERSION_TIMEOUT_MS);
});
