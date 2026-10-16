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

/** The 16-bit pipeline with the samples of all `channels` bands prepared so that the library's high-byte reduction yields the nearest level. */
export function roundedToEightBits(pipeline: Sharp, channels: number): Sharp {
  return pipeline.linear(new Array<number>(channels).fill(NEAREST_LEVEL_SCALE), new Array<number>(channels).fill(ROUNDING_HALF));
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
