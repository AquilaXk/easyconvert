import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { requireOracleTool } from './helpers/differential-oracle';
import { measureSsimPsnr } from './helpers/ffmpeg-measure';
import { interface16, interpolateAt, type Point } from './helpers/graphic-parity';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Graphic content (line art, interfaces) against the reference encoders. The reference curves come from the
 * reference tools themselves: `avifenc -q` at speed 6, decoded by `avifdec`, SSIM and PSNR measured by ffmpeg, decoded by an independent decoder. Ours is judged at the reference's quality
 * for the same number of bytes, found by interpolating the reference curve in the logarithm of the size, so a
 * smaller or larger file is not mistaken for a better or worse encoder.
 */

const REQUEST_QUALITIES = [40, 55, 70, 85];
const AVIF_REFERENCE_QUALITIES = Array.from({ length: 15 }, (_, i) => 10 + 6 * i);
const AVIF_REFERENCE_SPEED = '6';
const SSIM_TO_DB = 10;
const PSNR_SLACK_DB = 0.1;
const SSIM_SLACK_DB = 0.1;

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

  it('matches the reference SSIM and PSNR for the same bytes at every quality tested', async () => {
    const png = await interface16();
    const source = writeIn('avif-source.png', png);
    const psnrPoints: Point[] = [];
    const ssimPoints: Point[] = [];
    for (const quality of AVIF_REFERENCE_QUALITIES) {
      const file = path.join(workDir, `ref-${quality}.avif`);
      execFileSync(requireOracleTool('avifenc'), ['-q', String(quality), '-s', AVIF_REFERENCE_SPEED, '-j', 'all', source, file], { stdio: 'ignore' });
      const quality8 = measure(avifdec(file, `ref-${quality}`), source);
      const bytes = readFileSync(file).length;
      psnrPoints.push({ bytes, value: quality8.psnr });
      ssimPoints.push({ bytes, value: quality8.ssimDb });
    }
    for (const quality of REQUEST_QUALITIES) {
      const ours = (await convertImage(png, 'avif', { quality }, 'g.png', 'png')).buffer;
      const measured = measure(avifdec(writeIn(`ours-${quality}.avif`, ours), `ours-${quality}`), source);
      const expectedSsim = interpolateAt(ssimPoints, ours.length);
      const expectedPsnr = interpolateAt(psnrPoints, ours.length);
      const note = `q${quality}: ${ours.length} B`;
      expect(measured.ssimDb + SSIM_SLACK_DB, `${note} SSIM ${measured.ssimDb.toFixed(2)} dB against ${expectedSsim.toFixed(2)} dB`).toBeGreaterThanOrEqual(expectedSsim);
      expect(measured.psnr + PSNR_SLACK_DB, `${note} PSNR ${measured.psnr.toFixed(2)} dB against ${expectedPsnr.toFixed(2)} dB`).toBeGreaterThanOrEqual(expectedPsnr);
    }
  }, 240_000);
});
