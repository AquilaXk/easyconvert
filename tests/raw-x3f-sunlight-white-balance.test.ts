import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { decodeCamfBytes, parseCamfMatrices, readX3fDirectory, readX3fHeaderInfo } from '../src/lib/conversions/raw-x3f';
import { requireOracleTool } from './helpers/differential-oracle';
import { rawSamplePath, skipWithoutRawSamples, skipWithoutTools } from './helpers/strict-skip';

/**
 * A Sigma SD15 file names its white balance "Daylight" in the file header, while the calibration block lists the entries of that
 * white balance as "Sunlight" (SunlightWBGain, SunlightCCMatrix). The reader of the open-source x3f tools has a workaround for
 * exactly this (`x3f_get_camf_matrix_for_wb` in `src/x3f_meta.c`: a "Daylight" that finds no entry is looked up as "Sunlight"), and
 * so does this decoder. The real file is read against the full-size picture the camera embedded in it.
 */

const TEST_TIMEOUT_MS = 180_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

const SD15 = 'x3f-sd15';
const SD15_WIDTH = 2640;
const SD15_HEIGHT = 1760;
const GRID_WIDTH = 64;
const GRID_HEIGHT = 44;
const MIN_CORRELATION = 0.95;

describe('a Sigma X3F whose header says Daylight and whose calibration says Sunlight', () => {
  const noSample = skipWithoutRawSamples(SD15);
  const noTools = skipWithoutTools('exiftool');
  const sample = () => readFileSync(rawSamplePath(SD15));

  it.skipIf(noSample)('the Sigma SD15 file has the header and calibration names the workaround is for', () => {
    const file = sample();
    expect(readX3fHeaderInfo(file).whiteBalance).toBe('Daylight');
    const camf = readX3fDirectory(file).find((section) => section.type === 'CAMF');
    const names = [...parseCamfMatrices(decodeCamfBytes(file, camf!)).keys()];
    expect(names).toContain('SunlightWBGain');
    expect(names).toContain('SunlightCCMatrix');
    expect(names).not.toContain('DaylightWBGain');
  });

  for (const target of ['png', 'jpg']) {
    it.skipIf(noSample || noTools)(`the Sigma SD15 file is developed to ${target} and matches the picture the camera embedded`, async () => {
      const file = sample();
      const result = await dispatchConversion(file, 'x3f', target, {}, 'sd15.x3f');
      const meta = await sharp(result.buffer).metadata();
      expect({ width: meta.width, height: meta.height }).toEqual({ width: SD15_WIDTH, height: SD15_HEIGHT });
      const embedded = execFileSync(requireOracleTool('exiftool'), ['-b', '-JpgFromRaw', '-'], { input: file, maxBuffer: 64 * 1024 * 1024 });
      expect(correlation(await lumaGrid(result.buffer), await lumaGrid(embedded))).toBeGreaterThan(MIN_CORRELATION);
    });
  }
});

/** The brightness of a picture on a coarse grid, row by row. */
async function lumaGrid(image: Buffer): Promise<number[]> {
  const eightBit = await sharp(image).removeAlpha().toColourspace('srgb').png().toBuffer();
  const grid = await sharp(eightBit).greyscale().resize(GRID_WIDTH, GRID_HEIGHT, { fit: 'fill', kernel: 'nearest' }).raw().toBuffer();
  return [...grid];
}

/** Pearson correlation of two equally long series. */
function correlation(first: readonly number[], second: readonly number[]): number {
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const [meanFirst, meanSecond] = [mean(first), mean(second)];
  let covariance = 0;
  let varianceFirst = 0;
  let varianceSecond = 0;
  first.forEach((value, index) => {
    const [a, b] = [value - meanFirst, second[index] - meanSecond];
    covariance += a * b;
    varianceFirst += a * a;
    varianceSecond += b * b;
  });
  return covariance / Math.sqrt(varianceFirst * varianceSecond);
}
