import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { isNoiseDominated } from '../src/lib/conversions/image-content';
import { requireOracleTool } from './helpers/differential-oracle';
import { measureSsimPsnr } from './helpers/ffmpeg-measure';
import { bdRatePercent, type Point } from './helpers/graphic-parity';
import { runConvert, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A noise-dominated photograph at the benchmark's qualities (40, 55, 70, 85, 4:2:0) against the reference encoder, by BD-rate. With table 3
 * the noisy public picture (`jxl-noise`) was 5.2% behind in PSNR and the Kodak pictures with added noise 4 to 16% behind; table 2 puts them
 * ahead of the reference in PSNR, SSIM and SSIMULACRA 2 (entry 266). The picture is the benchmark's photograph with Gaussian noise of 25
 * levels added from a fixed hash, so it needs no corpus download. The allowance is the parity gate's.
 */

const QUALITIES = [40, 55, 70, 85];
const SSIM_TO_DB = 10;
/** The parity gate's BD-rate allowance in percent: `bdRateSsim` and `bdRatePsnr` tolerance in bench/rows.ts. */
const BD_RATE_ALLOWANCE_PERCENT = 1.5;
const NOISE_SIGMA = 25;
const MIX_MULTIPLIER = 0x45d9f3b;
const CORPUS = path.join(__dirname, '..', 'bench', 'corpus');

let workDir: string;
beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'noisy-jpeg-'));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeIn(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  writeFileSync(file, bytes);
  return file;
}

/** Uniform in [0, 1) from a position: a murmur-style finalizer, so neighbours are uncorrelated. */
function hashUnit(at: number): number {
  let h = at + 1;
  h = Math.imul(h ^ (h >>> 16), MIX_MULTIPLIER);
  h = Math.imul(h ^ (h >>> 16), MIX_MULTIPLIER);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

/** A sample of Gaussian noise (Box-Muller from two hashes) scaled to `NOISE_SIGMA`. */
function gaussian(at: number): number {
  return NOISE_SIGMA * Math.sqrt(-2 * Math.log(1 - hashUnit(2 * at))) * Math.cos(2 * Math.PI * hashUnit(2 * at + 1));
}

async function noisyPhotograph(): Promise<Buffer> {
  const { data, info } = await sharp(path.join(CORPUS, 'photo-b.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const noisy = Buffer.from(data.map((value, at) => Math.max(0, Math.min(255, Math.round(value + gaussian(at))))));
  return sharp(noisy, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}

describe.skipIf(SKIP_WITHOUT_MAGICK || skipWithoutTools('ffmpeg'))('JPEG of a noise-dominated photograph from quality 40 to 85 against ImageMagick', () => {
  const measure = (jpeg: string, name: string, source: string): { psnr: number; ssimDb: number } => {
    const decoded = path.join(workDir, `${name}.png`);
    execFileSync(requireOracleTool('ffmpeg'), ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', jpeg, '-frames:v', '1', decoded]);
    const { ssim, psnr } = measureSsimPsnr(requireOracleTool('ffmpeg'), decoded, source);
    return { psnr, ssimDb: -SSIM_TO_DB * Math.log10(1 - ssim) };
  };

  it('needs no more bytes for the same PSNR and SSIM than the reference, by BD-rate', async () => {
    const picture = await noisyPhotograph();
    const { data, info } = await sharp(picture).raw().toBuffer({ resolveWithObject: true });
    expect(isNoiseDominated({ samples: new Uint8Array(data), width: info.width, height: info.height, channels: info.channels }), 'the fixture is noise-dominated').toBe(true);
    const source = writeIn('source.png', picture);
    const reference = { psnr: [] as Point[], ssim: [] as Point[] };
    const ours = { psnr: [] as Point[], ssim: [] as Point[] };
    for (const quality of QUALITIES) {
      const referenceFile = path.join(workDir, `ref-${quality}.jpg`);
      runConvert([source, '-quality', String(quality), referenceFile]);
      const measuredReference = measure(referenceFile, `ref-${quality}`, source);
      const referenceBytes = readFileSync(referenceFile).length;
      reference.psnr.push({ bytes: referenceBytes, value: measuredReference.psnr });
      reference.ssim.push({ bytes: referenceBytes, value: measuredReference.ssimDb });

      const converted = (await convertImage(picture, 'jpg', { quality }, 'noisy.png', 'png')).buffer;
      const measuredOurs = measure(writeIn(`ours-${quality}.jpg`, converted), `ours-${quality}`, source);
      ours.psnr.push({ bytes: converted.length, value: measuredOurs.psnr });
      ours.ssim.push({ bytes: converted.length, value: measuredOurs.ssimDb });
    }
    const bdPsnr = bdRatePercent(reference.psnr, ours.psnr);
    const bdSsim = bdRatePercent(reference.ssim, ours.ssim);
    console.info(`noisy photograph JPEG BD-rate from quality 40 to 85 against the reference: PSNR ${bdPsnr.toFixed(2)}%, SSIM ${bdSsim.toFixed(2)}%`);
    expect(bdPsnr, `BD-rate in PSNR ${bdPsnr.toFixed(2)}%`).toBeLessThanOrEqual(BD_RATE_ALLOWANCE_PERCENT);
    expect(bdSsim, `BD-rate in SSIM (dB) ${bdSsim.toFixed(2)}%`).toBeLessThanOrEqual(BD_RATE_ALLOWANCE_PERCENT);
  }, 240_000);
});
