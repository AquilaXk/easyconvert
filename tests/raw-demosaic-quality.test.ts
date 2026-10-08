import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  demosaicAhdBayerCfa as referenceAhd,
  demosaicAmazeBayerCfa as referenceAmaze,
  type BayerSensorData,
} from '../src/lib/conversions/image';
import { demosaicAhdBayerCfa, demosaicAmazeBayerCfa, type DemosaicResult } from '../src/lib/conversions/raw-demosaic';
import { OracleToolMissingError, getOracleToolPath } from './helpers/differential-oracle';
import { readTiff16 } from './raw-demosaic/tiff16';

/**
 * Image quality of the in-process AHD and AMaZE against LibRaw's own interpolators, run through dcraw_emu on a real
 * 21 MP Leaf Aptus 22 sensor frame (tests/fixtures/raw/.cache/mos.mos, `npm run fixtures:raw -- mos`):
 *   -q 3 is LibRaw AHD, -q 4 is LibRaw DCB.
 * dcraw_emu -disinterp writes the scaled mosaic that its interpolators receive, so both sides demosaic the same samples
 * (black level subtracted, scaled to 16 bits, no white balance, camera colour space, linear). PSNR is measured on the
 * interior of the window, away from the borders where the interpolators differ in edge handling, and must be no worse
 * than the implementation that was live before the flat-plane rewrite.
 */
const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
const DCRAW_EMU = getOracleToolPath('dcraw_emu');
const SAMPLE = path.join(__dirname, 'fixtures', 'raw', '.cache', 'mos.mos');
const CHECKS_ENABLED = DCRAW_EMU !== null && existsSync(SAMPLE);

const WINDOW_LEFT = 1792;
const WINDOW_TOP = 1536;
const WINDOW_WIDTH = 512;
const WINDOW_HEIGHT = 384;
/** Extra mosaic around the compared window so that the interior never sees a mirrored border. */
const MARGIN = 16;
const FULL_SCALE = 65535;
const CHANNELS = 3;
const PSNR_TOLERANCE_DB = 0.001;
/** Measured PSNR of the pre-rewrite implementation against each LibRaw interpolator is 41.5 to 43.7 dB; the floor keeps 3 dB of headroom. */
const MIN_PSNR_DB = 38;
const DCRAW_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 300_000;
const COMMON_ARGS = ['-4', '-T', '-t', '0', '-o', '0', '-r', '1', '1', '1', '1', '-H', '0'];

function runDcraw(args: string[]): void {
  execFileSync(DCRAW_EMU!, [...args, SAMPLE], { stdio: 'pipe', timeout: DCRAW_TIMEOUT_MS });
}

/** PSNR in dB of our float output (scaled to 16 bits) against a 16-bit interleaved reference, peak = brightest reference sample. */
function interiorPsnr(ours: DemosaicResult, reference: Uint16Array, refWidth: number): number {
  let sum = 0;
  let count = 0;
  let peak = 0;
  for (let y = 0; y < WINDOW_HEIGHT; y += 1) {
    for (let x = 0; x < WINDOW_WIDTH; x += 1) {
      for (let c = 0; c < CHANNELS; c += 1) {
        const mine = Math.round(ours.floatData[((y + MARGIN) * ours.width + x + MARGIN) * CHANNELS + c] * FULL_SCALE);
        const theirs = reference[(y * refWidth + x) * CHANNELS + c];
        sum += (mine - theirs) * (mine - theirs);
        peak = Math.max(peak, theirs);
        count += 1;
      }
    }
  }
  return 10 * Math.log10((peak * peak) / (sum / count));
}

describe('demosaic quality against LibRaw interpolators', () => {
  it.runIf(STRICT_MODE)('has dcraw_emu and the real sample (strict mode fails instead of skipping)', () => {
    if (!CHECKS_ENABLED) {
      throw new OracleToolMissingError('dcraw_emu', `needs dcraw_emu and ${SAMPLE} (dcraw_emu=${DCRAW_EMU}, sample=${existsSync(SAMPLE)})`);
    }
    expect(path.basename(DCRAW_EMU!)).toBe('dcraw_emu');
  });

  // skip-ok: a strict-mode test in this file fails (instead of skipping) when dcraw_emu, raw-identify or the samples are missing.
  it.skipIf(!CHECKS_ENABLED)(
    'AHD and AMaZE are no worse than before against LibRaw AHD (-q 3) and DCB (-q 4)',
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'demosaic-quality-'));
      try {
        const mosaicFile = path.join(dir, 'mosaic.tiff');
        runDcraw(['-disinterp', ...COMMON_ARGS, '-B', String(WINDOW_LEFT - MARGIN), String(WINDOW_TOP - MARGIN), String(WINDOW_WIDTH + 2 * MARGIN), String(WINDOW_HEIGHT + 2 * MARGIN), '-Z', mosaicFile]);
        const mosaic = readTiff16(mosaicFile);
        expect({ width: mosaic.width, height: mosaic.height }).toEqual({ width: WINDOW_WIDTH + 2 * MARGIN, height: WINDOW_HEIGHT + 2 * MARGIN });
        // The interpolation step is skipped: every pixel holds its own CFA channel and zeros in the other two.
        const cfa = new Uint16Array(mosaic.width * mosaic.height);
        for (let i = 0; i < cfa.length; i += 1) {
          cfa[i] = Math.max(mosaic.data[i * CHANNELS], mosaic.data[i * CHANNELS + 1], mosaic.data[i * CHANNELS + 2]);
        }
        const sensor: BayerSensorData = {
          width: mosaic.width,
          height: mosaic.height,
          pattern: 'RGGB',
          data: cfa,
          bitsPerSample: 16,
          blackLevel: 0,
          whiteLevel: FULL_SCALE,
        };
        const outputs = {
          ahd: { now: demosaicAhdBayerCfa(sensor), before: referenceAhd(sensor) },
          amaze: { now: demosaicAmazeBayerCfa(sensor), before: referenceAmaze(sensor) },
        };
        for (const quality of [3, 4]) {
          const referenceFile = path.join(dir, `q${quality}.tiff`);
          runDcraw(['-q', String(quality), ...COMMON_ARGS, '-B', String(WINDOW_LEFT), String(WINDOW_TOP), String(WINDOW_WIDTH), String(WINDOW_HEIGHT), '-Z', referenceFile]);
          const reference = readTiff16(referenceFile);
          expect({ width: reference.width, height: reference.height }).toEqual({ width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
          for (const method of ['ahd', 'amaze'] as const) {
            const now = interiorPsnr(outputs[method].now, reference.data, reference.width);
            const before = interiorPsnr(outputs[method].before as DemosaicResult, reference.data, reference.width);
            console.log(`PSNR vs dcraw_emu -q ${quality}: ${method} now ${now.toFixed(3)} dB, before ${before.toFixed(3)} dB`);
            expect(now).toBeGreaterThan(MIN_PSNR_DB);
            expect(now).toBeGreaterThanOrEqual(before - PSNR_TOLERANCE_DB);
            // Real 16-bit data: the float output must also be bit-identical to the replaced implementation.
            expect(Buffer.compare(Buffer.from(outputs[method].now.floatData.buffer), Buffer.from(outputs[method].before.floatData!.buffer))).toBe(0);
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );
});
