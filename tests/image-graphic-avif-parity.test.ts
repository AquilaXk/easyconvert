import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { requireOracleTool } from './helpers/differential-oracle';
import { measureSsimPsnr } from './helpers/ffmpeg-measure';
import { bdRatePercent, interface16, lineArt16, type Point } from './helpers/graphic-parity';
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

describe.skipIf(skipWithoutTools('avifenc', 'avifdec', 'ffmpeg'))('AVIF of 16-bit graphics against avifenc at the same size', () => {
  const avifdec = (file: string, name: string): string => {
    const decoded = path.join(workDir, `${name}.png`);
    execFileSync(requireOracleTool('avifdec'), [file, decoded]);
    return decoded;
  };
  const measure = (decoded: string, source: string): { psnr: number; ssimDb: number } => {
    const { ssim, psnr } = measureSsimPsnr(requireOracleTool('ffmpeg'), decoded, source);
    return { psnr, ssimDb: -SSIM_TO_DB * Math.log10(1 - ssim) };
  };

  /** Runs `body` with the converter's AVIF tool set to `tool`, restoring the environment afterwards. */
  async function withAvifencPath(tool: string, body: () => Promise<void>): Promise<void> {
    const saved = process.env.AVIFENC_PATH;
    process.env.AVIFENC_PATH = tool;
    try {
      await body();
    } finally {
      if (saved === undefined) delete process.env.AVIFENC_PATH;
      else process.env.AVIFENC_PATH = saved;
    }
  }

  /** Encodes `png` at every quality with the reference and with the converter, and gates both BD-rates. */
  async function expectParityWithReference(png: Buffer, name: string, encoder: 'library-cli' | 'image-library'): Promise<void> {
    const source = writeIn(`${name}-source.png`, png);
    const reference = { psnr: [] as Point[], ssim: [] as Point[] };
    const ours = { psnr: [] as Point[], ssim: [] as Point[] };
    for (const quality of QUALITIES) {
      const file = path.join(workDir, `${name}-ref-${quality}.avif`);
      // Product policy keeps AVIF output within AV1 Main profile bit depths (10 bits at most). Left alone, the reference AVIF encoder
      // writes 16-bit sources at 12 bits, which is a different output constraint; compare both encoders at the same bit depth.
      execFileSync(requireOracleTool('avifenc'), ['-d', '10', '-q', String(quality), '-s', AVIF_REFERENCE_SPEED, '-j', 'all', source, file], { stdio: 'ignore' });
      const measuredReference = measure(avifdec(file, `${name}-ref-${quality}`), source);
      const referenceBytes = readFileSync(file).length;
      reference.psnr.push({ bytes: referenceBytes, value: measuredReference.psnr });
      reference.ssim.push({ bytes: referenceBytes, value: measuredReference.ssimDb });

      const result = await convertImage(png, 'avif', { quality }, `${name}.png`, 'png');
      expect(result.metadata, `${name}: encoder that wrote quality ${quality}`).toMatchObject({ avifEncoder: encoder });
      const converted = result.buffer;
      const measuredOurs = measure(avifdec(writeIn(`${name}-ours-${quality}.avif`, converted), `${name}-ours-${quality}`), source);
      ours.psnr.push({ bytes: converted.length, value: measuredOurs.psnr });
      ours.ssim.push({ bytes: converted.length, value: measuredOurs.ssimDb });
    }
    const bdSsim = bdRatePercent(reference.ssim, ours.ssim);
    const bdPsnr = bdRatePercent(reference.psnr, ours.psnr);
    console.info(`${name} AVIF BD-rate against the reference at 10 bits: SSIM ${bdSsim.toFixed(2)}%, PSNR ${bdPsnr.toFixed(2)}%`);
    expect(bdSsim, `${name}: BD-rate in SSIM (dB) ${bdSsim.toFixed(2)}%`).toBeLessThanOrEqual(BD_RATE_ALLOWANCE_PERCENT);
    expect(bdPsnr, `${name}: BD-rate in PSNR ${bdPsnr.toFixed(2)}%`).toBeLessThanOrEqual(BD_RATE_ALLOWANCE_PERCENT);
  }

  // The converter writes graphic AVIF with the same library encoder when it is installed, so these two cases check
  // that the policy (quality, speed, bit depth, chroma, tuning) matches the reference command line, not the encoder itself.
  it('policy parity with the reference command line: an interface needs no more bytes for the same SSIM and PSNR, by BD-rate over the quality curve', async () => {
    await expectParityWithReference(await interface16(), 'interface', 'library-cli');
  }, 480_000);

  it('policy parity with the reference command line: 16-bit grey line art needs no more bytes for the same SSIM and PSNR, by BD-rate over the quality curve', async () => {
    await expectParityWithReference(await lineArt16(), 'line-art', 'library-cli');
  }, 480_000);

  // Without the executable the image library encodes; it must keep the parity it had before the tool was used.
  it('the image library alone (no avifenc installed) needs no more bytes than the reference on an interface, by BD-rate', async () => {
    const png = await interface16();
    await withAvifencPath(path.join(workDir, 'no-such-avifenc'), () => expectParityWithReference(png, 'library-interface', 'image-library'));
  }, 480_000);
});
