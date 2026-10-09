import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { requireOracleTool } from './helpers/differential-oracle';
import { measureSsimPsnr } from './helpers/ffmpeg-measure';
import { bdRatePercent, interface16, type Point } from './helpers/graphic-parity';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Graphic content (line art, interfaces) against the reference encoders. The reference curves come from the
 * reference tools themselves: `avifenc -q` at speed 6, decoded by `avifdec`, SSIM and PSNR measured by ffmpeg, decoded by an independent decoder. Ours is judged as the gate judges it: by BD-rate
 * (Bjontegaard, cubic fit of the log size over the quality) between the two curves encoded at the same qualities, so a
 * smaller or larger file is not mistaken for a better or worse encoder and no single quality point decides.
 */

const QUALITIES = [...new Set([40, 55, 70, 85, ...Array.from({ length: 15 }, (_, i) => 10 + 6 * i)])].sort((a, b) => a - b);
const AVIF_REFERENCE_SPEED = '6';
const SSIM_TO_DB = 10;
/** The parity gate's BD-rate allowance in percent: `bdRateSsim` and `bdRatePsnr` tolerance in bench/rows.ts. */
const BD_RATE_ALLOWANCE_PERCENT = 1.5;

let workDir: string;
beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'graphic-avif-parity-'));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeIn(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  writeFileSync(file, bytes);
  return file;
}

describe.skipIf(skipWithoutTools('avifenc', 'avifdec', 'ffmpeg'))('AVIF of a 16-bit interface against avifenc at the same size', () => {
  const avifdec = (file: string, name: string): string => {
    const decoded = path.join(workDir, `${name}.png`);
    execFileSync(requireOracleTool('avifdec'), [file, decoded]);
    return decoded;
  };
  const measure = (decoded: string, source: string): { psnr: number; ssimDb: number } => {
    const { ssim, psnr } = measureSsimPsnr(requireOracleTool('ffmpeg'), decoded, source);
    return { psnr, ssimDb: -SSIM_TO_DB * Math.log10(1 - ssim) };
  };

  it('needs no more bytes than the reference for the same SSIM and PSNR, by BD-rate over the quality curve', async () => {
    const png = await interface16();
    const source = writeIn('avif-source.png', png);
    const reference = { psnr: [] as Point[], ssim: [] as Point[] };
    const ours = { psnr: [] as Point[], ssim: [] as Point[] };
    for (const quality of QUALITIES) {
      const file = path.join(workDir, `ref-${quality}.avif`);
      // Product policy keeps AVIF output within AV1 Main profile bit depths (10 bits at most). Left alone, the reference AVIF encoder
      // writes 16-bit sources at 12 bits, which is a different output constraint; compare both encoders at the same bit depth.
      execFileSync(requireOracleTool('avifenc'), ['-d', '10', '-q', String(quality), '-s', AVIF_REFERENCE_SPEED, '-j', 'all', source, file], { stdio: 'ignore' });
      const measuredReference = measure(avifdec(file, `ref-${quality}`), source);
      const referenceBytes = readFileSync(file).length;
      reference.psnr.push({ bytes: referenceBytes, value: measuredReference.psnr });
      reference.ssim.push({ bytes: referenceBytes, value: measuredReference.ssimDb });

      const converted = (await convertImage(png, 'avif', { quality }, 'g.png', 'png')).buffer;
      const measuredOurs = measure(avifdec(writeIn(`ours-${quality}.avif`, converted), `ours-${quality}`), source);
      ours.psnr.push({ bytes: converted.length, value: measuredOurs.psnr });
      ours.ssim.push({ bytes: converted.length, value: measuredOurs.ssimDb });
    }
    const bdSsim = bdRatePercent(reference.ssim, ours.ssim);
    const bdPsnr = bdRatePercent(reference.psnr, ours.psnr);
    console.info(`AVIF BD-rate against the reference at 10 bits: SSIM ${bdSsim.toFixed(2)}%, PSNR ${bdPsnr.toFixed(2)}%`);
    expect(bdSsim, `BD-rate in SSIM (dB) ${bdSsim.toFixed(2)}%`).toBeLessThanOrEqual(BD_RATE_ALLOWANCE_PERCENT);
    expect(bdPsnr, `BD-rate in PSNR ${bdPsnr.toFixed(2)}%`).toBeLessThanOrEqual(BD_RATE_ALLOWANCE_PERCENT);
  }, 480_000);
});
