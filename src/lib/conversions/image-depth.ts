import type { Sharp } from 'sharp';

/**
 * Reduction of 16-bit samples to the 8 bits of a JPEG or WebP. The image library keeps the high byte of every sample, which is
 * a floor: the output is on average half a level too dark (a bias of 0.5/255 that costs 0.2 dB of PSNR on a smooth dark picture
 * and more than 1 dB on a very clean one, before the encoder has done anything). The reference service's engine takes the nearest level
 * (`(quantum + 128) / 257` in its 16-bit build). The library's reduction is a right shift by 8 at the end of the pipeline, so
 * scaling the 16-bit samples by 255 * 256 / 65535 and adding 128 first makes that shift the nearest-level rounding; the sums
 * saturate at 65535, which is level 255. No dithering: it adds noise the encoder then has to code (it lowers PSNR and SSIM at the
 * same size), and the 8-bit target has no deeper plane to carry the error to.
 */

const EIGHT_BIT_MAX = 255;
const SIXTEEN_BIT_MAX = 65535;
const HIGH_BYTE_SHIFT = 256;
const ROUNDING_HALF = HIGH_BYTE_SHIFT / 2;
const NEAREST_LEVEL_SCALE = (EIGHT_BIT_MAX * HIGH_BYTE_SHIFT) / SIXTEEN_BIT_MAX;

/** Targets that write 8 bits per sample from a picture that may have 16: the reduction is rounded for these. */
export const EIGHT_BIT_ONLY_TARGETS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'webp']);

/** The 16-bit pipeline with the samples of all `channels` bands prepared so that the library's high-byte reduction yields the nearest level. */
export function roundedToEightBits(pipeline: Sharp, channels: number): Sharp {
  return pipeline.linear(new Array<number>(channels).fill(NEAREST_LEVEL_SCALE), new Array<number>(channels).fill(ROUNDING_HALF));
}
