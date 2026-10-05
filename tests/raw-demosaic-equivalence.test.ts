import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { demosaicAhdBayerCfa, demosaicAmazeBayerCfa, type BayerSensorData } from '../src/lib/conversions/image';
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
 * flat-plane rewrite (tests/fixtures/raw/demosaic-golden.json, captured by tests/raw-demosaic/capture-golden.ts).
 * The inputs are closed-form synthetic mosaics plus a crop of the real Raspberry Pi imx477 sample.
 */
const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
const GOLDEN: { entries: GoldenEntry[] } = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
const SAMPLE_PRESENT = existsSync(IMX477_SAMPLE_PATH);

const DEMOSAICERS: Record<DemosaicName, (sensor: BayerSensorData) => ReturnType<typeof demosaicAhdBayerCfa>> = {
  ahd: demosaicAhdBayerCfa,
  amaze: demosaicAmazeBayerCfa,
};

function goldenFor(id: string, method: DemosaicName): GoldenEntry {
  const entry = GOLDEN.entries.find((candidate) => candidate.id === id && candidate.method === method);
  if (!entry) throw new Error(`no golden entry for ${id}/${method}`);
  return entry;
}

function expectMatchesGolden(id: string, method: DemosaicName, sensor: BayerSensorData): void {
  const golden = goldenFor(id, method);
  const actual = digestOutput(DEMOSAICERS[method](sensor), id, method);
  expect({ width: actual.width, height: actual.height }).toEqual({ width: golden.width, height: golden.height });
  expect(actual.floatSha256).toBe(golden.floatSha256);
  expect(actual.rgb8Sha256).toBe(golden.rgb8Sha256);
  expect(sha256Of(gunzipSync(Buffer.from(golden.rgb8GzBase64, 'base64')))).toBe(golden.rgb8Sha256);
}

describe('AHD / AMaZE output equals the pre-rewrite golden', () => {
  const syntheticRows = SYNTHETIC_CASES.flatMap((c) => c.methods.map((method) => [c.id, method] as [string, DemosaicName]));

  it.each(syntheticRows)('%s %s', (id, method) => {
    const c = SYNTHETIC_CASES.find((candidate) => candidate.id === id)!;
    expectMatchesGolden(id, method, buildSensor(c));
  });

  it.runIf(STRICT_MODE)('has the real imx477 sample (strict mode fails instead of skipping)', () => {
    if (!SAMPLE_PRESENT) throw new OracleToolMissingError('raw-imx477', 'run `npm run fixtures:raw -- raw-imx477`');
    expect(path.basename(IMX477_SAMPLE_PATH)).toBe('raw-imx477.raw');
  });

  const realRows = REAL_CROP_CASES.flatMap((c) => c.methods.map((method) => [c.id, method] as [string, DemosaicName]));
  describe.skipIf(!SAMPLE_PRESENT)('real imx477 crops', () => {
    it.each(realRows)('%s %s', (id, method) => {
      const crop = REAL_CROP_CASES.find((candidate) => candidate.id === id)!;
      const imx = loadImx477Plane()!;
      expectMatchesGolden(id, method, cropSensor(imx.plane, imx.width, imx.bayer, crop));
    });
  });
});
