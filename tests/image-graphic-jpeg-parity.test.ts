import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { interface16, interpolateAt, lineArt16, type Point } from './helpers/graphic-parity';
import { runConvert, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

/**
 * Graphic content (line art, interfaces) against the reference encoders. The reference curves come from the
 * reference tools themselves: ImageMagick's `-quality` for JPEG, decoded by ImageMagick, decoded by an independent decoder. Ours is judged at the reference's quality
 * for the same number of bytes, found by interpolating the reference curve in the logarithm of the size, so a
 * smaller or larger file is not mistaken for a better or worse encoder.
 */

const REQUEST_QUALITIES = [40, 55, 70, 85];
const JPEG_REFERENCE_QUALITIES = Array.from({ length: 20 }, (_, i) => 5 * (i + 1));
const PSNR_SLACK_DB = 0.1;
const BYTE_MAX = 255;

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

function psnr8(decoded: Buffer, source: Buffer): number {
  expect(decoded.length).toBe(source.length);
  let squares = 0;
  for (let i = 0; i < source.length; i += 1) squares += (decoded[i] - source[i]) ** 2;
  return squares === 0 ? Infinity : 10 * Math.log10((BYTE_MAX * BYTE_MAX * source.length) / squares);
}

describe.skipIf(SKIP_WITHOUT_MAGICK)('JPEG of graphic content against ImageMagick at the same size', () => {
  /** 8-bit samples as ImageMagick decodes a file: grey stays one channel, colour three. */
  const decode8 = (file: string, grey: boolean): Buffer => runConvert([file, '-depth', '8', grey ? 'gray:-' : 'rgb:-']);

  const cases: Array<[string, () => Promise<Buffer>, boolean]> = [
    ['16-bit grey line art', lineArt16, true],
    ['16-bit RGB interface', interface16, false],
  ];

  it.each(cases)('%s: PSNR is at least the reference quality for the same bytes at every quality tested', async (label, make, grey) => {
    const png = await make();
    const sourceFile = writeIn('jpeg-source.png', png);
    const source = decode8(sourceFile, grey);
    const reference: Point[] = JPEG_REFERENCE_QUALITIES.map((quality) => {
      const file = path.join(workDir, `ref-${quality}.jpg`);
      runConvert([sourceFile, '-quality', String(quality), file]);
      return { bytes: readFileSync(file).length, value: psnr8(decode8(file, grey), source) };
    });
    for (const quality of REQUEST_QUALITIES) {
      const ours = (await convertImage(png, 'jpg', { quality }, 'g.png', 'png')).buffer;
      const oursPsnr = psnr8(decode8(writeIn(`ours-${quality}.jpg`, ours), grey), source);
      const expected = interpolateAt(reference, ours.length);
      expect(oursPsnr + PSNR_SLACK_DB, `${label} q${quality}: ${ours.length} B, ${oursPsnr.toFixed(2)} dB against ${expected.toFixed(2)} dB`).toBeGreaterThanOrEqual(expected);
    }
  }, 120_000);
});
