import type { Metadata, Sharp } from 'sharp';
import { hasSrgbPrimaries, isSrgbProfile } from './icc-srgb';

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

/** Sample depth of the 16-bit integer images libvips reports as `ushort`. */
export const SHARP_SIXTEEN_BIT_DEPTH = 'ushort';

/** Targets that write 8 bits per sample from a picture that may have 16: the reduction is rounded for these. */
export const EIGHT_BIT_ONLY_TARGETS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'webp']);

/**
 * The 16-bit pipeline with the samples of all `channels` bands prepared so that the library's high-byte reduction yields the nearest level.
 *
 * The output colour space is set to the 16-bit one the pipeline is already in, so that the pipeline does no conversion to sRGB of its own
 * and the encoder (`vips_foreign_save` casts to 8 bits with the same shift, `libvips/foreign/foreign.c` 1639 to 1647) does the reduction. The
 * conversion is what must not run for a picture that keeps its ICC profile: sharp copies the profile into memory owned by an intermediate
 * image before the geometry steps (`GetProfile`, `src/common.cc` 633 to 643, called at `src/pipeline.cc` 371) and sets it again on the result
 * of the conversion without a destructor (`SetProfile`, `src/common.cc` 648 to 654, called at `src/pipeline.cc` 889 to 891, sharp 0.35.5).
 * After a rotation or flip of a 16-bit picture the profile read back from the file is the right length with other bytes. The same pipeline
 * with the colour space set to 16 bits never reaches that call.
 */
export function roundedToEightBits(pipeline: Sharp, channels: number): Sharp {
  return pipeline
    .linear(new Array<number>(channels).fill(NEAREST_LEVEL_SCALE), new Array<number>(channels).fill(ROUNDING_HALF))
    .toColourspace('rgb16');
}

/** The 8-bit level nearest to a 16-bit sample, the level `roundedToEightBits` gives it. */
function nearestLevelOf(sample: number): number {
  return Math.floor((sample * EIGHT_BIT_MAX) / SIXTEEN_BIT_MAX + 0.5);
}

/** The nearest 8-bit level of each 16-bit value of a lookup table. */
export function nearestLevelLut(lut: Uint16Array): Uint8Array {
  const levels = new Uint8Array(lut.length);
  for (let value = 0; value < lut.length; value += 1) levels[value] = nearestLevelOf(lut[value]);
  return levels;
}

/**
 * Whether a picture is kept at 16 bits until the end of the pipeline and reduced there with rounding (see `roundedToEightBits`): it
 * has more than 8 bits per sample for an 8-bit target and no non-sRGB development curve that an ICC transform would turn into
 * 8-bit sRGB. WebP takes its alpha plane along; JPEG has none, so a picture with an alpha plane is reduced at the end only when the
 * plane is dropped as opaque (a colour picture: a grey one is converted to its one-band form first), and never when a background is
 * flattened onto it, which works on 8 bits. `meta` is the header of the pipeline, undefined for a target that writes more than 8 bits.
 */
export function reducesAtEncode(fmt: string, meta: Metadata | undefined, hasBackground: boolean, dropsOpaqueAlpha: boolean): boolean {
  if (meta?.depth !== SHARP_SIXTEEN_BIT_DEPTH) return false;
  if (meta.icc !== undefined && hasSrgbPrimaries(meta.icc) && !isSrgbProfile(meta.icc)) return false;
  if (fmt === 'webp') return true;
  const dropsAlpha = meta.hasAlpha !== true || (dropsOpaqueAlpha && meta.space === 'rgb16');
  return dropsAlpha && !hasBackground;
}
