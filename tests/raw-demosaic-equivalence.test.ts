import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { BayerSensorData } from '../src/lib/conversions/image';
import { demosaicAhdBayerCfa, demosaicAmazeBayerCfa, type DemosaicResult } from '../src/lib/conversions/raw-demosaic';
import { legacyDemosaicAhdBayerCfa, legacyDemosaicAmazeBayerCfa } from './raw-demosaic/legacy-demosaic';
import { OracleToolMissingError } from './helpers/differential-oracle';
import {
  REAL_CROP_CASES,
  SYNTHETIC_CASES,
  buildSensor,
  cropSensor,
  type DemosaicName,
} from './raw-demosaic/inputs';
import { GOLDEN_PATH, IMX477_SAMPLE_PATH, digestOutput, loadImx477Plane, sha256Of, type GoldenEntry } from './raw-demosaic/golden';

/**
 * AHD and AMaZE output pinned against digests recorded from the implementation that was live before the
 * flat-plane rewrite (tests/fixtures/raw/demosaic-golden.json, captured by tests/raw-demosaic/capture-golden.ts from
 * the in-place functions of image.ts). The inputs are closed-form synthetic mosaics plus a crop of the real
 * Raspberry Pi imx477 sample. Every case also runs with tiny tiles so that each pixel is computed near a tile seam.
 *
 * Stated equivalence: the float output must hash identically. The tolerance branch below exists only for runtimes whose
 * Math.pow / Math.cbrt differ from the recording runtime in the last bit: it still requires every 8-bit sample to be
 * within MAX_LSB of the recorded buffer and at most MAX_MISMATCH_FRACTION of the samples to differ at all.
 */
const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
const GOLDEN: { entries: GoldenEntry[] } = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
const SAMPLE_PRESENT = existsSync(IMX477_SAMPLE_PATH);
const MAX_LSB = 1;
const MAX_MISMATCH_FRACTION = 1e-4;
const SEAM_TILE = 16;
const DEFAULT_TILE = undefined;

const DEMOSAICERS: Record<DemosaicName, (sensor: BayerSensorData, options?: { tileSize?: number }) => DemosaicResult> = {
  ahd: demosaicAhdBayerCfa,
  amaze: demosaicAmazeBayerCfa,
};

function goldenFor(id: string, method: DemosaicName): GoldenEntry {
  const entry = GOLDEN.entries.find((candidate) => candidate.id === id && candidate.method === method);
  if (!entry) throw new Error(`no golden entry for ${id}/${method}`);
  return entry;
}

function expectMatchesGolden(id: string, method: DemosaicName, sensor: BayerSensorData, tileSize: number | undefined): void {
  const golden = goldenFor(id, method);
  const result = DEMOSAICERS[method](sensor, { tileSize });
  const actual = digestOutput(result, id, method);
  expect({ width: actual.width, height: actual.height }).toEqual({ width: golden.width, height: golden.height });
  const recorded = gunzipSync(Buffer.from(golden.rgb8GzBase64, 'base64'));
  expect(sha256Of(recorded)).toBe(golden.rgb8Sha256);
  if (actual.floatSha256 === golden.floatSha256 && actual.rgb8Sha256 === golden.rgb8Sha256) return;
  expect(result.data.length).toBe(recorded.length);
  let worst = 0;
  let differing = 0;
  for (let i = 0; i < recorded.length; i += 1) {
    const delta = Math.abs(result.data[i] - recorded[i]);
    if (delta > 0) differing += 1;
    worst = Math.max(worst, delta);
  }
  expect(worst).toBeLessThanOrEqual(MAX_LSB);
  expect(differing / recorded.length).toBeLessThanOrEqual(MAX_MISMATCH_FRACTION);
}

describe('AHD / AMaZE output equals the pre-rewrite golden', () => {
  const syntheticRows = SYNTHETIC_CASES.flatMap((c) =>
    c.methods.flatMap((method) => [DEFAULT_TILE, SEAM_TILE].map((tile) => [c.id, method, tile] as [string, DemosaicName, number | undefined]))
  );

  it.each(syntheticRows)('%s %s tile=%s', (id, method, tile) => {
    const c = SYNTHETIC_CASES.find((candidate) => candidate.id === id)!;
    expectMatchesGolden(id, method, buildSensor(c), tile);
  });

  it.runIf(STRICT_MODE)('has the real imx477 sample (strict mode fails instead of skipping)', () => {
    if (!SAMPLE_PRESENT) throw new OracleToolMissingError('raw-imx477', 'run `npm run fixtures:raw -- raw-imx477`');
    expect(path.basename(IMX477_SAMPLE_PATH)).toBe('raw-imx477.raw');
  });

  const realRows = REAL_CROP_CASES.flatMap((c) =>
    c.methods.flatMap((method) => [DEFAULT_TILE, SEAM_TILE].map((tile) => [c.id, method, tile] as [string, DemosaicName, number | undefined]))
  );
  // skip-ok: a strict-mode test in this file fails (instead of skipping) when dcraw_emu, raw-identify or the samples are missing.
  describe.skipIf(!SAMPLE_PRESENT)('real imx477 crops', () => {
    it.each(realRows)('%s %s tile=%s', (id, method, tile) => {
      const crop = REAL_CROP_CASES.find((candidate) => candidate.id === id)!;
      const imx = loadImx477Plane()!;
      expectMatchesGolden(id, method, cropSensor(imx.plane, imx.width, imx.bayer, crop), tile);
    });
  });
});

describe('the preserved pre-rewrite implementation still reproduces the goldens', () => {
  // The speed and quality suites use it as their reference, so it must stay what the goldens were recorded from.
  const legacy: Record<DemosaicName, (sensor: BayerSensorData) => { data: Buffer; floatData?: Float32Array; width: number; height: number }> = {
    ahd: legacyDemosaicAhdBayerCfa,
    amaze: legacyDemosaicAmazeBayerCfa,
  };
  const rows = SYNTHETIC_CASES.flatMap((c) => c.methods.map((method) => [c.id, method] as [string, DemosaicName]));

  it.each(rows)('%s %s', (id, method) => {
    const c = SYNTHETIC_CASES.find((candidate) => candidate.id === id)!;
    const golden = goldenFor(id, method);
    const actual = digestOutput(legacy[method](buildSensor(c)), id, method);
    expect(actual.floatSha256).toBe(golden.floatSha256);
    expect(actual.rgb8Sha256).toBe(golden.rgb8Sha256);
  });
});
