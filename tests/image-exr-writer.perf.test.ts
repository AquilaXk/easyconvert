import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { float32ToFloat16 } from '../src/lib/conversions/float16';
import { encodeOpenExrAsync } from '../src/lib/conversions/raw-hdr';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Timing-ratio checks moved out of image-exr-writer.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 */

const PERF_WIDTH = 6000;
const PERF_HEIGHT = 4000;
/** The encoder measured about 10x one deflate pass; the per-pixel writer it replaced was about 300x. */
const PERF_MAX_DEFLATE_RATIO = 25;
const PERF_MAX_RATIO = 0.4;
const HALF_BYTES = 2;
const RGB = 3;

describe('a 24-megapixel picture', () => {
  it(`is written within ${PERF_MAX_DEFLATE_RATIO}x the time of deflating its pixels, at no more than 40% of the uncompressed size`, async () => {
    // A natural picture: a photograph stretched to 6000 x 4000, sRGB decoded to linear light.
    const photo = path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg');
    const raster = await sharp(photo).resize(PERF_WIDTH, PERF_HEIGHT, { fit: 'cover', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
    const toLinear = new Float32Array(256);
    for (let i = 0; i < 256; i += 1) toLinear[i] = i / 255 <= 0.04045 ? i / 255 / 12.92 : Math.pow((i / 255 + 0.055) / 1.055, 2.4);
    const linear = new Float32Array(raster.length);
    for (let i = 0; i < raster.length; i += 1) linear[i] = toLinear[raster[i]];
    // Reference: one deflate pass over the same samples as half floats, timed interleaved in this process so a loaded
    // runner slows both alike. ZIP compression is deflate over predicted scanline blocks plus the float conversion.
    const halfSamples = new Uint16Array(linear.length);
    for (let i = 0; i < linear.length; i += 1) halfSamples[i] = float32ToFloat16(linear[i]);
    const halfBytes = Buffer.from(halfSamples.buffer);
    const { largeResult: file } = await expectNoSlowerThanReference(
      '24 MP EXR write',
      () => zlib.deflateSync(halfBytes),
      () => encodeOpenExrAsync(linear, PERF_WIDTH, PERF_HEIGHT, true, 'zip'),
      { maxRatio: PERF_MAX_DEFLATE_RATIO }
    );
    const uncompressed = PERF_WIDTH * PERF_HEIGHT * RGB * HALF_BYTES;
    expect(file.length / uncompressed).toBeLessThanOrEqual(PERF_MAX_RATIO);
  }, 120_000);
});
