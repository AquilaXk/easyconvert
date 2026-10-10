import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { requireOracleTool } from './helpers/differential-oracle';
import { measureSsimPsnr } from './helpers/ffmpeg-measure';
import { bdRatePercent, interface16, lineArt16, type Point } from './helpers/graphic-parity';
import { runConvert, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Graphic content (line art, interfaces) against the reference encoder. The reference curves come from the reference tool
 * itself: ImageMagick's `-quality` for JPEG, which subsamples the chroma below quality 90, as the converter does. Both
 * are decoded by an independent decoder (ffmpeg) and judged as the gate judges them: by BD-rate (Bjontegaard, cubic fit
 * of the log size over the quality) between the two curves encoded at the same qualities, so a smaller or larger file is
 * not mistaken for a better or worse encoder and no single quality point decides.
 */

const QUALITIES = [30, 40, 50, 55, 60, 70, 80, 85];
const SSIM_TO_DB = 10;
/** The parity gate's BD-rate allowance in percent: `bdRateSsim` and `bdRatePsnr` tolerance in bench/rows.ts. */
const BD_RATE_ALLOWANCE_PERCENT = 1.5;

let workDir: string;
beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'graphic-jpeg-parity-'));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeIn(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  writeFileSync(file, bytes);
  return file;
}

describe.skipIf(SKIP_WITHOUT_MAGICK || skipWithoutTools('ffmpeg'))('JPEG of graphic content against ImageMagick over the quality curve', () => {
  const measure = (jpeg: string, name: string, source: string): { psnr: number; ssimDb: number } => {
    const decoded = path.join(workDir, `${name}.png`);
    execFileSync(requireOracleTool('ffmpeg'), ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', jpeg, '-frames:v', '1', decoded]);
    const { ssim, psnr } = measureSsimPsnr(requireOracleTool('ffmpeg'), decoded, source);
    return { psnr, ssimDb: -SSIM_TO_DB * Math.log10(1 - ssim) };
  };

  const cases: Array<[string, () => Promise<Buffer>]> = [
    ['16-bit grey line art', lineArt16],
    ['16-bit RGB interface', interface16],
  ];

  it.each(cases)('%s: needs no more bytes for the same PSNR and SSIM than the reference, by BD-rate', async (label, make) => {
    const png = await make();
    const source = writeIn('jpeg-source.png', png);
    const reference = { psnr: [] as Point[], ssim: [] as Point[] };
    const ours = { psnr: [] as Point[], ssim: [] as Point[] };
    for (const quality of QUALITIES) {
      const referenceFile = path.join(workDir, `ref-${quality}.jpg`);
      runConvert([source, '-quality', String(quality), referenceFile]);
      const measuredReference = measure(referenceFile, `ref-${quality}`, source);
      const referenceBytes = readFileSync(referenceFile).length;
      reference.psnr.push({ bytes: referenceBytes, value: measuredReference.psnr });
      reference.ssim.push({ bytes: referenceBytes, value: measuredReference.ssimDb });

      const converted = (await convertImage(png, 'jpg', { quality }, 'g.png', 'png')).buffer;
      const measuredOurs = measure(writeIn(`ours-${quality}.jpg`, converted), `ours-${quality}`, source);
      ours.psnr.push({ bytes: converted.length, value: measuredOurs.psnr });
      ours.ssim.push({ bytes: converted.length, value: measuredOurs.ssimDb });
    }
    const bdPsnr = bdRatePercent(reference.psnr, ours.psnr);
    const bdSsim = bdRatePercent(reference.ssim, ours.ssim);
    console.info(`${label} JPEG BD-rate against the reference: PSNR ${bdPsnr.toFixed(2)}%, SSIM ${bdSsim.toFixed(2)}%`);
    expect(bdPsnr, `${label}: BD-rate in PSNR ${bdPsnr.toFixed(2)}%`).toBeLessThanOrEqual(BD_RATE_ALLOWANCE_PERCENT);
    expect(bdSsim, `${label}: BD-rate in SSIM (dB) ${bdSsim.toFixed(2)}%`).toBeLessThanOrEqual(BD_RATE_ALLOWANCE_PERCENT);
  }, 240_000);
});
