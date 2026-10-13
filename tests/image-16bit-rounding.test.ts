import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { decodeRgba, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

/**
 * A 16-bit picture written as JPEG or WebP is reduced to the nearest 8-bit level, as the reference service's engine does, not
 * floored to the high byte (which leaves every sample half a level dark on average). Every block of the fixture holds the 16-bit
 * value 256 * k + 255, whose nearest level is k + 1 while its high byte is k; a lossy encode at the top quality keeps a flat
 * block within a level or two, so the mean of (decoded - k) over the blocks is about 1 for rounding and about 0 for flooring.
 * Oracles: the expected level of each block follows from its 16-bit value by the arithmetic above (written here, not taken
 * from the converter), and the output is decoded by ImageMagick.
 */

const BLOCK = 8;
const BLOCKS_PER_SIDE = 11;
const SIDE = BLOCK * BLOCKS_PER_SIDE;
const FIRST_LEVEL = 10;
const SAMPLE_OFFSET = 255;
const BYTE_SHIFT = 256;

/** The high byte `k` of the block at (bx, by); the 16-bit value is 256 * k + 255. */
function highByte(bx: number, by: number): number {
  return FIRST_LEVEL + by * BLOCKS_PER_SIDE + bx;
}

function sixteenBit(channels: 1 | 3): Uint16Array {
  const samples = new Uint16Array(SIDE * SIDE * channels);
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      const value = highByte(Math.floor(x / BLOCK), Math.floor(y / BLOCK)) * BYTE_SHIFT + SAMPLE_OFFSET;
      for (let c = 0; c < channels; c += 1) samples[(y * SIDE + x) * channels + c] = value;
    }
  }
  return samples;
}

type Variant = 'plain' | 'exif' | 'profile';

async function source(channels: 1 | 3, variant: Variant): Promise<Buffer> {
  let image = sharp(sixteenBit(channels), { raw: { width: SIDE, height: SIDE, channels } }).toColourspace(channels === 1 ? 'grey16' : 'rgb16');
  if (variant === 'exif') image = image.withExif({ IFD0: { Copyright: 'rounding test' } });
  if (variant === 'profile') image = image.withIccProfile('srgb');
  return image.png().toBuffer();
}

/** Mean over the blocks of (decoded level of the block centre - high byte of the block), in 8-bit levels. */
function meanLift(encoded: Buffer, extension: string): number {
  const decoded = decodeRgba(encoded, extension);
  let sum = 0;
  for (let by = 0; by < BLOCKS_PER_SIDE; by += 1) {
    for (let bx = 0; bx < BLOCKS_PER_SIDE; bx += 1) {
      const at = ((by * BLOCK + BLOCK / 2) * decoded.width + bx * BLOCK + BLOCK / 2) * 4;
      sum += (decoded.data[at] + decoded.data[at + 1] + decoded.data[at + 2]) / 3 - highByte(bx, by);
    }
  }
  return sum / (BLOCKS_PER_SIDE * BLOCKS_PER_SIDE);
}

const CASES = [
  ['16-bit RGB without metadata', 3, 'plain'],
  ['16-bit RGB with an EXIF block', 3, 'exif'],
  ['16-bit RGB with an ICC profile', 3, 'profile'],
  ['16-bit grey with an EXIF block', 1, 'exif'],
] as const;

describe.skipIf(SKIP_WITHOUT_MAGICK)('16-bit pictures reduced to the nearest 8-bit level', () => {
  it.each(CASES.flatMap(([name, channels, variant]) => (['jpg', 'webp'] as const).map((target) => [`${name} to ${target}`, channels, variant, target] as const)))(
    '%s',
    async (_name, channels, variant, target) => {
      const out = (await convertImage(await source(channels, variant), target, { quality: 100 }, 'deep.png', 'png')).buffer;
      const lift = meanLift(out, target);
      expect(lift).toBeGreaterThan(0.7);
      expect(lift).toBeLessThan(1.3);
    }
  );
});
