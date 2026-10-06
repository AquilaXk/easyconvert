import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { demosaicAhdBayerCfa as referenceAhd, demosaicAmazeBayerCfa as referenceAmaze } from '../src/lib/conversions/image';
import { demosaicAhdBayerCfa, demosaicAmazeBayerCfa } from '../src/lib/conversions/raw-demosaic';
import { OracleToolMissingError } from './helpers/differential-oracle';
import { cropSensor, type RealCropCase } from './raw-demosaic/inputs';
import { IMX477_SAMPLE_PATH, loadImx477Plane } from './raw-demosaic/golden';

/**
 * Speed of the flat-plane AHD and AMaZE against the implementation they replaced (still in image.ts), measured on a
 * 1 MP window of the real imx477 sample on the same machine in the same process, best of REPEATS runs each.
 * The new engine is called the way processFloat32LinearPipeline calls it (float planes only, no 8-bit buffer); the
 * reference always builds its 8-bit buffer.
 *
 * A slow or shared runner can opt out explicitly with RAW_DEMOSAIC_SKIP_TIMING=1; nothing skips silently.
 */
const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
const SKIP_TIMING = process.env.RAW_DEMOSAIC_SKIP_TIMING === '1';
const SAMPLE_PRESENT = existsSync(IMX477_SAMPLE_PATH);
const WINDOW: RealCropCase = { id: 'bench', sample: 'raw-imx477.raw', left: 1500, top: 1000, width: 1024, height: 1024, methods: ['ahd', 'amaze'] };
const REPEATS = 2;
/**
 * Regression floors, below the speedups measured on this window (the replaced code is faster on dark data, which
 * narrows the ratio). The 21 MP frame in tests/raw-demosaic/bench-frame.ts is where the issue targets are measured.
 */
const AHD_MIN_SPEEDUP = 3;
const AMAZE_MIN_SPEEDUP = 2;
const TEST_TIMEOUT_MS = 180_000;

function bestOf<T>(run: () => T): { ms: number; result: T } {
  let best = Infinity;
  let result!: T;
  for (let i = 0; i < REPEATS; i += 1) {
    const start = performance.now();
    result = run();
    best = Math.min(best, performance.now() - start);
  }
  return { ms: best, result };
}

describe('demosaic speed against the replaced implementation', () => {
  it.runIf(STRICT_MODE && !SKIP_TIMING)('has the real imx477 sample (strict mode fails instead of skipping)', () => {
    if (!SAMPLE_PRESENT) throw new OracleToolMissingError('raw-imx477', 'run `npm run fixtures:raw -- raw-imx477`');
    expect(path.basename(IMX477_SAMPLE_PATH)).toBe('raw-imx477.raw');
  });

  it.skipIf(SKIP_TIMING || !SAMPLE_PRESENT)(
    'AHD and AMaZE stay well ahead of the replaced implementation with identical float output',
    () => {
      const imx = loadImx477Plane()!;
      const sensor = cropSensor(imx.plane, imx.width, imx.bayer, WINDOW);
      const cases = [
        { name: 'ahd', reference: referenceAhd, current: demosaicAhdBayerCfa, minSpeedup: AHD_MIN_SPEEDUP },
        { name: 'amaze', reference: referenceAmaze, current: demosaicAmazeBayerCfa, minSpeedup: AMAZE_MIN_SPEEDUP },
      ];
      for (const c of cases) {
        const before = bestOf(() => c.reference(sensor));
        const after = bestOf(() => c.current(sensor, { buildRgb8: false }));
        const speedup = before.ms / after.ms;
        console.log(`${c.name} ${WINDOW.width}x${WINDOW.height}: before ${before.ms.toFixed(0)} ms, after ${after.ms.toFixed(0)} ms, ${speedup.toFixed(1)}x`);
        const beforeBytes = Buffer.from(before.result.floatData!.buffer);
        expect(Buffer.compare(Buffer.from(after.result.floatData.buffer), beforeBytes)).toBe(0);
        expect(speedup).toBeGreaterThanOrEqual(c.minSpeedup);
      }
    },
    TEST_TIMEOUT_MS
  );
});
