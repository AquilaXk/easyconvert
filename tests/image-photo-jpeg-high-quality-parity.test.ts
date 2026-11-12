import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { requireOracleTool } from './helpers/differential-oracle';
import { measureSsimPsnr } from './helpers/ffmpeg-measure';
import { bdRatePercent, type Point } from './helpers/graphic-parity';
import { runConvert, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Photographs at the qualities where chroma is 4:4:4 (88 is the last 4:2:0 point of the curve) against the reference
 * encoder, by BD-rate over the four qualities the benchmark's high-quality measurement uses. With table 3 at 90 and above
 * the two benchmark photographs were 7% and 12% behind in PSNR (34 public photographs: +15%); the table of the JPEG
 * specification, which the reference writes, puts them at its curve or ahead of it. The allowance is the parity gate's.
 */

const QUALITIES = [88, 90, 93, 96];
const SSIM_TO_DB = 10;
/** The parity gate's BD-rate allowance in percent: `bdRateSsim` and `bdRatePsnr` tolerance in bench/rows.ts. */
const BD_RATE_ALLOWANCE_PERCENT = 1.5;
const CORPUS = path.join(__dirname, '..', 'bench', 'corpus');

let workDir: string;
beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'photo-jpeg-high-quality-'));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeIn(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  writeFileSync(file, bytes);
  return file;
}

describe.skipIf(SKIP_WITHOUT_MAGICK || skipWithoutTools('ffmpeg'))('JPEG of photographs from quality 88 to 96 against ImageMagick', () => {
  const measure = (jpeg: string, name: string, source: string): { psnr: number; ssimDb: number } => {
    const decoded = path.join(workDir, `${name}.png`);
    execFileSync(requireOracleTool('ffmpeg'), ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', jpeg, '-frames:v', '1', decoded]);
    const { ssim, psnr } = measureSsimPsnr(requireOracleTool('ffmpeg'), decoded, source);
    return { psnr, ssimDb: -SSIM_TO_DB * Math.log10(1 - ssim) };
  };

  it.each([
    ['photo-a.jpg', 'jpg'],
    ['photo-b.png', 'png'],
  ] as const)('%s: needs no more bytes for the same PSNR and SSIM than the reference, by BD-rate', async (name, format) => {
    const original = readFileSync(path.join(CORPUS, name));
    const source = writeIn('source.png', await sharp(original).png().toBuffer());
    const reference = { psnr: [] as Point[], ssim: [] as Point[] };
    const ours = { psnr: [] as Point[], ssim: [] as Point[] };
    for (const quality of QUALITIES) {
      const referenceFile = path.join(workDir, `ref-${quality}.jpg`);
      runConvert([source, '-quality', String(quality), referenceFile]);
      const measuredReference = measure(referenceFile, `ref-${quality}`, source);
      const referenceBytes = readFileSync(referenceFile).length;
      reference.psnr.push({ bytes: referenceBytes, value: measuredReference.psnr });
      reference.ssim.push({ bytes: referenceBytes, value: measuredReference.ssimDb });

      const converted = (await convertImage(original, 'jpg', { quality }, name, format)).buffer;
      const measuredOurs = measure(writeIn(`ours-${quality}.jpg`, converted), `ours-${quality}`, source);
      ours.psnr.push({ bytes: converted.length, value: measuredOurs.psnr });
      ours.ssim.push({ bytes: converted.length, value: measuredOurs.ssimDb });
    }
    const bdPsnr = bdRatePercent(reference.psnr, ours.psnr);
    const bdSsim = bdRatePercent(reference.ssim, ours.ssim);
    console.info(`${name} JPEG BD-rate from quality 88 to 96 against the reference: PSNR ${bdPsnr.toFixed(2)}%, SSIM ${bdSsim.toFixed(2)}%`);
    expect(bdPsnr, `${name}: BD-rate in PSNR ${bdPsnr.toFixed(2)}%`).toBeLessThanOrEqual(BD_RATE_ALLOWANCE_PERCENT);
    expect(bdSsim, `${name}: BD-rate in SSIM (dB) ${bdSsim.toFixed(2)}%`).toBeLessThanOrEqual(BD_RATE_ALLOWANCE_PERCENT);
  }, 240_000);
});
