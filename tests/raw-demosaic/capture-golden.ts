/**
 * Records tests/fixtures/raw/demosaic-golden.json from the in-place AHD and AMaZE functions of
 * src/lib/conversions/image.ts, the implementation that was live before the flat-plane rewrite
 * (it stays in image.ts as the reference). Run with `npx tsx tests/raw-demosaic/capture-golden.ts`.
 *
 * The golden is an output of the OLD code. Never regenerate it from the rewritten engine.
 */
import { writeFileSync } from 'node:fs';
import { demosaicAhdBayerCfa, demosaicAmazeBayerCfa, type BayerSensorData } from '../../src/lib/conversions/image';
import { REAL_CROP_CASES, SYNTHETIC_CASES, buildSensor, cropSensor, type DemosaicName } from './inputs';
import { GOLDEN_PATH, digestOutput, loadImx477Plane, type GoldenEntry } from './golden';

function main(): void {
  const entries: GoldenEntry[] = [];
  const run = (id: string, method: DemosaicName, sensor: BayerSensorData) => {
    const result = method === 'ahd' ? demosaicAhdBayerCfa(sensor) : demosaicAmazeBayerCfa(sensor);
    entries.push(digestOutput(result, id, method));
  };
  for (const c of SYNTHETIC_CASES) {
    for (const method of c.methods) run(c.id, method, buildSensor(c));
  }
  const imx = loadImx477Plane();
  if (!imx) throw new Error('raw-imx477 sample missing: run `npm run fixtures:raw -- raw-imx477`');
  for (const crop of REAL_CROP_CASES) {
    for (const method of crop.methods) run(crop.id, method, cropSensor(imx.plane, imx.width, imx.bayer, crop));
  }
  writeFileSync(GOLDEN_PATH, `${JSON.stringify({ source: 'recorded from the pre-rewrite demosaicAhdBayerCfa / demosaicAmazeBayerCfa in image.ts', entries }, null, 1)}\n`);
  console.log(`wrote ${entries.length} golden entries to ${GOLDEN_PATH}`);
}

main();
