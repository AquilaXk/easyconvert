import sharp from 'sharp';
import type { DecodedRgba } from './imagemagick';

export type { DecodedRgba };

/** Decodes any picture the image library reads to 8-bit RGBA, with no resize and no colour management. */
export async function decodeRgba(bytes: Buffer): Promise<DecodedRgba> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** Largest difference between two samples of equal-sized pictures, or Infinity for pictures of different sizes. */
export function maxSampleDifference(a: DecodedRgba, b: DecodedRgba): number {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) return Infinity;
  let largest = 0;
  for (let i = 0; i < a.data.length; i += 1) largest = Math.max(largest, Math.abs(a.data[i] - b.data[i]));
  return largest;
}

/** The pixels of `expected` (row by row) as the 8-bit RGBA bytes `decodeRgba` returns. */
export function rgbaBytes(pixels: ReadonlyArray<{ r: number; g: number; b: number; a: number }>): Buffer {
  return Buffer.from(pixels.flatMap((p) => [p.r, p.g, p.b, p.a]));
}

/** The 16-bit samples of a picture, row by row, converted to the 16-bit colour space of `space` first (sharp would otherwise reduce them). */
export async function sixteenBitSamples(bytes: Buffer, space: 'grey16' | 'rgb16'): Promise<number[]> {
  const { data } = await sharp(bytes).toColourspace(space).raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  return Array.from(new Uint16Array(data.buffer, data.byteOffset, data.length / Uint16Array.BYTES_PER_ELEMENT));
}
