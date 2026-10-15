import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Timing-ratio checks moved out of image-avif-fidelity.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 */

const RGB_CHANNELS = 3;
const BYTE_MAX = 255;

/**
 * Throughput. The libaom bundled with sharp 0.35 takes about eight times longer from encoder effort 4
 * (sharp's default) than from effort 3 on a photographic raster, which pushed a 39-megapixel camera RAW
 * past three minutes. The bound sits between the two: about 2 s of encoding at effort 3 on an idle
 * machine, about 18 s at effort 4.
 */
describe('AVIF encoder throughput', () => {
  const SIDE = 2000;
  const NOISE_MASK = 7;
  const LCG_MULTIPLIER = 1103515245;
  const LCG_INCREMENT = 12345;
  const LCG_MASK = 0x7fffffff;
  const LCG_SHIFT = 16;
  const AVIF_PASSES = 1;
  const TEST_TIMEOUT_MS = 120_000;

  /** Smooth gradients with low-amplitude noise, the statistics of a camera picture. */
  function photographicRgb(): Buffer {
    const rgb = Buffer.alloc(SIDE * SIDE * RGB_CHANNELS);
    let seed = LCG_INCREMENT;
    for (let y = 0; y < SIDE; y++) {
      for (let x = 0; x < SIDE; x++) {
        const at = (y * SIDE + x) * RGB_CHANNELS;
        seed = (seed * LCG_MULTIPLIER + LCG_INCREMENT) & LCG_MASK;
        const noise = (seed >> LCG_SHIFT) & NOISE_MASK;
        rgb[at] = ((x * BYTE_MAX) / SIDE + noise + 40 * Math.sin(y / 37)) & BYTE_MAX;
        rgb[at + 1] = ((y * BYTE_MAX) / SIDE + noise + 30 * Math.sin(x / 53)) & BYTE_MAX;
        rgb[at + 2] = ((x + y) / 16 + noise * 2) & BYTE_MAX;
      }
    }
    return rgb;
  }

  it('encodes a 4-megapixel photographic raster about as fast as the encoder library does with its own defaults', async () => {
    const raw = photographicRgb();
    const rawOptions = { raw: { width: SIDE, height: SIDE, channels: RGB_CHANNELS } } as const;
    const png = await sharp(raw, rawOptions).png().toBuffer();
    // Reference: the same pixels through the library's default AVIF encode, measured in this process, interleaved
    // with the conversion (tests/helpers/timing.ts). A converter that picked a far slower encoder effort would
    // take several times as long; the machine's speed cancels out.
    const { largeResult } = await expectNoSlowerThanReference(
      'AVIF encode',
      () => sharp(raw, rawOptions).avif().toBuffer(),
      () => convertFile(png, 'png', 'avif', {}, 'photo.png'),
      { passes: AVIF_PASSES }
    );
    const meta = await sharp(largeResult.buffer).metadata();
    expect({ width: meta.width, height: meta.height, format: meta.format }).toEqual({ width: SIDE, height: SIDE, format: 'heif' });
  }, TEST_TIMEOUT_MS);
});
