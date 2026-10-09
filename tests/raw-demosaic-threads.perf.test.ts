import { describe, expect, it } from 'vitest';
import os from 'node:os';
import type { BayerSensorData } from '../src/lib/conversions/image';
import { demosaicAhdBayerCfa, demosaicAmazeBayerCfa, type DemosaicOptions, type DemosaicResult } from '../src/lib/conversions/raw-demosaic';
import type { DemosaicName } from './raw-demosaic/inputs';
import { skipUnless } from './helpers/strict-skip';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Speed-up of the tiled demosaic on four threads over one, measured interleaved in this process. It needs the cores to
 * itself, so it lives in the perf suite, which CI runs one file at a time instead of beside the test shards.
 */
// skip-ok: explicit opt-out (RAW_DEMOSAIC_SKIP_TIMING=1) of the speed-up ratio on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.RAW_DEMOSAIC_SKIP_TIMING === '1';
const TEST_TIMEOUT_MS = 300_000;
const SPEED_WIDTH = 2000;
const SPEED_HEIGHT = 1500;
/** Speed-up of 4 threads over 1 on four cores (measured about 3.8x for AMaZE and 4.4x for AHD); the floor allows for load. */
const MIN_SPEEDUP = 2.2;
const BUSY_FRACTION = 0.55;
const SPEED_CORES = 4;

const ENGINES: Record<DemosaicName, (sensor: BayerSensorData, options?: DemosaicOptions) => DemosaicResult> = {
  ahd: demosaicAhdBayerCfa,
  amaze: demosaicAmazeBayerCfa,
};

function mosaic(width: number, height: number, extra: Partial<BayerSensorData> = {}): BayerSensorData {
  const data = new Uint16Array(width * height);
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const edge = x > width * 0.4 && y > height * 0.3 ? 9000 : 0;
      data[y * width + x] = Math.round(20000 + edge + 15000 * Math.sin(x * 0.031) * Math.cos(y * 0.023) + (seed >>> 23) - 256);
    }
  }
  return { width, height, pattern: 'GRBG', data, bitsPerSample: 16, blackLevel: [200, 210, 205, 190], whiteLevel: 65000, whiteBalance: [2, 1, 1.4], applySrgbGamma: true, ...extra };
}

describe.skipIf(SKIP_TIMING || skipUnless('4 CPU cores', os.availableParallelism() >= SPEED_CORES))('speed-up of four threads over one', () => {
  for (const method of ['amaze', 'ahd'] as DemosaicName[]) {
    it(`${method} is at least ${MIN_SPEEDUP}x faster on a ${SPEED_WIDTH}x${SPEED_HEIGHT} frame`, async () => {
      const sensor = mosaic(SPEED_WIDTH, SPEED_HEIGHT);
      const floor = Math.min(MIN_SPEEDUP, SPEED_CORES * BUSY_FRACTION);
      const measurement = await expectNoSlowerThanReference(
        method,
        () => ENGINES[method](sensor, { buildRgb8: false, threads: 1 }),
        () => ENGINES[method](sensor, { buildRgb8: false, threads: SPEED_CORES }),
        { maxRatio: 1 / floor, passes: 3 }
      );
      expect((measurement.largeResult as DemosaicResult).threads).toBe(SPEED_CORES);
    }, TEST_TIMEOUT_MS);
  }
});
