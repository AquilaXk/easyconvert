/**
 * Times one AHD or AMaZE run on a full real sensor frame and prints a JSON line (milliseconds, peak RSS, SHA-256 of the
 * float and 8-bit outputs). Not a test: it takes up to two minutes for the replaced implementation.
 *
 *   npm run fixtures:raw -- mos
 *   npx tsx tests/raw-demosaic/bench-frame.ts <reference|current> <ahd|amaze> [--no-rgb8] [--tile N]
 *
 * The frame is the 21.4 MP (4008x5344) Leaf Aptus 22 sample. dcraw_emu -disinterp supplies the scaled mosaic, so no
 * code of this repository decodes it. Run each engine in its own process to get an honest RSS peak.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demosaicAhdBayerCfa as referenceAhd, demosaicAmazeBayerCfa as referenceAmaze, type BayerSensorData } from '../../src/lib/conversions/image';
import { demosaicAhdBayerCfa, demosaicAmazeBayerCfa } from '../../src/lib/conversions/raw-demosaic';
import { readTiff16 } from './tiff16';
import { getOracleToolPath } from '../helpers/differential-oracle';

const SAMPLE = path.join(__dirname, '..', 'fixtures', 'raw', '.cache', 'mos.mos');
const FULL_SCALE = 65535;
const BYTES_PER_MB = 1048576;
const CHANNELS = 3;

function mosaicFromDcraw(): { cfa: Uint16Array; width: number; height: number } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'demosaic-bench-'));
  try {
    const out = path.join(dir, 'mosaic.tiff');
    const dcraw = getOracleToolPath('dcraw_emu');
    if (!dcraw) throw new Error('dcraw_emu is required to build the benchmark mosaic');
    execFileSync(dcraw, ['-disinterp', '-4', '-T', '-t', '0', '-o', '0', '-r', '1', '1', '1', '1', '-H', '0', '-Z', out, SAMPLE], { stdio: 'pipe' });
    const tiff = readTiff16(out);
    const cfa = new Uint16Array(tiff.width * tiff.height);
    for (let i = 0; i < cfa.length; i += 1) {
      cfa[i] = Math.max(tiff.data[i * CHANNELS], tiff.data[i * CHANNELS + 1], tiff.data[i * CHANNELS + 2]);
    }
    return { cfa, width: tiff.width, height: tiff.height };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  const [engine, method, ...flags] = process.argv.slice(2);
  if ((engine !== 'reference' && engine !== 'current') || (method !== 'ahd' && method !== 'amaze')) {
    throw new Error('usage: bench-frame.ts <reference|current> <ahd|amaze> [--no-rgb8] [--tile N]');
  }
  const tileAt = flags.indexOf('--tile');
  const options = { buildRgb8: !flags.includes('--no-rgb8'), tileSize: tileAt >= 0 ? Number(flags[tileAt + 1]) : undefined };
  const { cfa, width, height } = mosaicFromDcraw();
  const sensor: BayerSensorData = { width, height, pattern: 'RGGB', data: cfa, bitsPerSample: 16, blackLevel: 0, whiteLevel: FULL_SCALE, whiteBalance: [2, 1, 1.5], applySrgbGamma: true };
  const start = performance.now();
  let result;
  if (engine === 'reference') {
    result = method === 'ahd' ? referenceAhd(sensor) : referenceAmaze(sensor);
  } else {
    result = method === 'ahd' ? demosaicAhdBayerCfa(sensor, options) : demosaicAmazeBayerCfa(sensor, options);
  }
  const ms = performance.now() - start;
  // The run is synchronous and its buffers are still live here, so the resident size now is its peak.
  const peak = process.memoryUsage().rss;
  const floats = result.floatData!;
  console.log(
    JSON.stringify({
      engine,
      method,
      megapixels: +((width * height) / 1e6).toFixed(2),
      options,
      ms: Math.round(ms),
      peakRssMb: Math.round(peak / BYTES_PER_MB),
      floatSha256: createHash('sha256').update(new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength)).digest('hex'),
      rgb8Sha256: options.buildRgb8 ? createHash('sha256').update(result.data).digest('hex') : null,
    })
  );
}

main();
