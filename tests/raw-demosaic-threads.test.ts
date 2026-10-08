import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import type { BayerSensorData } from '../src/lib/conversions/image';
import {
  DEMOSAIC_PARALLEL_MIN_PIXELS,
  DEMOSAIC_THREADS_MAX,
  demosaicAhdBayerCfa,
  demosaicAmazeBayerCfa,
  type DemosaicOptions,
  type DemosaicResult,
} from '../src/lib/conversions/raw-demosaic';
import { runTilesOnThreads } from '../src/lib/conversions/raw-demosaic-threads';
import type { TileJob } from '../src/lib/conversions/raw-demosaic-tiles';
import { ConversionFailedError, InvalidRawSensorError } from '../src/lib/types';
import { SYNTHETIC_CASES, buildSensor, type DemosaicName } from './raw-demosaic/inputs';
import { GOLDEN_PATH, digestOutput, sha256Of, type GoldenEntry } from './raw-demosaic/golden';
import { skipUnless } from './helpers/strict-skip';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * AHD and AMaZE computed on several threads. The tiles of a frame are independent, so the thread count must not change
 * a single byte: the output is compared with the digests recorded from the implementation that existed before the tile
 * rewrite (the goldens of raw-demosaic-equivalence.test.ts) and with the single-thread run, at 1, 2, 4 and 8 threads.
 * The speed-up is measured against the single-thread run in the same process.
 */
// skip-ok: explicit opt-out (RAW_DEMOSAIC_SKIP_TIMING=1) of the speed-up ratio on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.RAW_DEMOSAIC_SKIP_TIMING === '1';
const GOLDEN: { entries: GoldenEntry[] } = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
const THREAD_COUNTS = [1, 2, 4, 8] as const;
const SEAM_TILE = 16;
const TEST_TIMEOUT_MS = 300_000;
const SPEED_WIDTH = 2000;
const SPEED_HEIGHT = 1500;
const MIN_SPEEDUP_CORES = 2;
/** Speed-up of 4 threads over 1 on four cores (measured about 3.8x for AMaZE and 4.4x for AHD); the floor allows for load. */
const MIN_SPEEDUP = 2.2;
const BUSY_FRACTION = 0.55;
const SPEED_CORES = 4;

const ENGINES: Record<DemosaicName, (sensor: BayerSensorData, options?: DemosaicOptions) => DemosaicResult> = {
  ahd: demosaicAhdBayerCfa,
  amaze: demosaicAmazeBayerCfa,
};

function goldenFor(id: string, method: DemosaicName): GoldenEntry {
  const entry = GOLDEN.entries.find((candidate) => candidate.id === id && candidate.method === method);
  if (!entry) throw new Error(`no golden entry for ${id}/${method}`);
  return entry;
}

/** A smooth mosaic with edges and noise, big enough to give every thread several rows of tiles. */
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

function bytesOf(view: Float32Array): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

describe('threaded output equals the recorded goldens at every thread count', () => {
  const rows = SYNTHETIC_CASES.flatMap((c) => c.methods.map((method) => [c.id, method] as [string, DemosaicName]));

  it.each(rows)('%s / %s', (id, method) => {
    const sensor = buildSensor(SYNTHETIC_CASES.find((c) => c.id === id)!);
    const golden = goldenFor(id, method);
    const recorded = gunzipSync(Buffer.from(golden.rgb8GzBase64, 'base64'));
    expect(sha256Of(recorded)).toBe(golden.rgb8Sha256);
    for (const threads of THREAD_COUNTS) {
      const result = ENGINES[method](sensor, { tileSize: SEAM_TILE, threads });
      const actual = digestOutput(result, id, method);
      // Rows of tiles bound the useful threads: a small mosaic cannot keep eight busy.
      expect(result.threads, `${id} at ${threads}`).toBe(Math.min(threads, Math.ceil(golden.height / SEAM_TILE)));
      expect(actual.floatSha256, `${id}/${method} at ${threads} thread(s)`).toBe(golden.floatSha256);
      expect(actual.rgb8Sha256, `${id}/${method} at ${threads} thread(s)`).toBe(golden.rgb8Sha256);
    }
  });
});

describe('thread count does not change a byte', () => {
  const variants: Array<[string, Partial<BayerSensorData>, DemosaicOptions]> = [
    ['plain', {}, {}],
    ['with false-colour suppression', { falseColorSuppression: 2 }, {}],
    ['linear output without an 8-bit buffer', { applySrgbGamma: false }, { buildRgb8: false }],
    ['with a colour matrix', { colorMatrix: [1.2, -0.1, -0.1, -0.2, 1.3, -0.1, 0, -0.3, 1.3] }, {}],
  ];

  for (const method of ['amaze', 'ahd'] as DemosaicName[]) {
    it.each(variants)(`${method}: %s`, (_name, extra, options) => {
      const sensor = mosaic(224, 200, extra);
      const reference = ENGINES[method](sensor, { ...options, tileSize: SEAM_TILE, threads: 1 });
      expect(reference.threads).toBe(1);
      const mismatches: string[] = [];
      for (const threads of [2, 4, 8]) {
        const result = ENGINES[method](sensor, { ...options, tileSize: SEAM_TILE, threads });
        if (result.threads !== threads) mismatches.push(`threads reported ${result.threads} for ${threads}`);
        if (Buffer.compare(bytesOf(result.floatData), bytesOf(reference.floatData)) !== 0) mismatches.push(`float output at ${threads} threads`);
        if (Buffer.compare(result.data, reference.data) !== 0) mismatches.push(`8-bit output at ${threads} threads`);
      }
      expect(mismatches).toEqual([]);
    });
  }
});

describe('thread selection', () => {
  const cores = os.availableParallelism();

  it('runs a frame below the size threshold on the calling thread by default', () => {
    const result = demosaicAmazeBayerCfa(mosaic(400, 300), { buildRgb8: false });
    expect(result.threads).toBe(1);
  });

  it.skipIf(skipUnless('2 or more CPU cores', cores >= MIN_SPEEDUP_CORES))('splits a frame at the threshold across the available cores by default', () => {
    const width = 2000;
    const height = Math.ceil(DEMOSAIC_PARALLEL_MIN_PIXELS / width / 2) * 2;
    const result = demosaicAmazeBayerCfa(mosaic(width, height), { buildRgb8: false });
    expect(result.threads).toBe(Math.min(cores, DEMOSAIC_THREADS_MAX));
  }, TEST_TIMEOUT_MS);

  it('rejects a thread count that is not an integer from 1 to the maximum', () => {
    const sensor = mosaic(64, 64);
    const outcomes = [0, 1.5, -2, DEMOSAIC_THREADS_MAX + 1, Number.NaN].map((threads) => {
      try {
        demosaicAmazeBayerCfa(sensor, { threads });
        return 'accepted';
      } catch (error) {
        return error instanceof InvalidRawSensorError ? 'rejected' : `wrong error ${String(error)}`;
      }
    });
    expect(outcomes).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
  });
});

describe('a failing tile thread', () => {
  it('surfaces its message as a typed error instead of hanging', () => {
    const job = {
      kind: 'amaze',
      width: 32,
      height: 32,
      tile: SEAM_TILE,
      input: null,
      calibration: { black: new Float64Array(4), range: new Float64Array(4).fill(1) },
      layout: { greenParity: 0, redRowParity: 0 },
      out: { width: 32, floatOut: new Float32Array(new SharedArrayBuffer(32 * 32 * 12)), rgb8: null, tables: null, wbR: 1, wbG: 1, wbB: 1, matrix: null, gamma: false, roundToFloat32: false },
      planes: null,
    } as unknown as TileJob;
    let caught: unknown;
    try {
      runTilesOnThreads(job, 2);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConversionFailedError);
    expect((caught as Error).message).toMatch(/A demosaic tile thread failed: .*(null|undefined)/);
  }, TEST_TIMEOUT_MS);
});

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
