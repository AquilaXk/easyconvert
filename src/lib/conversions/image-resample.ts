import sharp from 'sharp';
import { type ConversionOptions, UnsupportedOptionError } from '../types';

/**
 * Resampling choices. Averaging gamma-encoded sRGB values darkens fine, high-contrast detail (a 1-pixel
 * black/white checkerboard halves to 128 instead of the 188 that equal light energy gives) and fringes alpha
 * edges, so a strong downscale runs in linear light: the picture is converted to scRGB (linear, 32-bit float),
 * resized with the chosen kernel (sharp premultiplies alpha around the resize), and converted back.
 */

/** Kernels a request may name; `lanczos3` is the default. */
export const RESAMPLE_KERNELS = ['lanczos3', 'lanczos2', 'mitchell', 'cubic', 'nearest', 'mks2021'] as const;
export type ResampleKernel = (typeof RESAMPLE_KERNELS)[number];
export const DEFAULT_KERNEL: ResampleKernel = 'lanczos3';

/** A downscale at or below this factor in either axis resamples in linear light; milder scales change little. */
export const LINEAR_LIGHT_MAX_SCALE = 0.5;

const KERNEL_SET: ReadonlySet<string> = new Set(RESAMPLE_KERNELS);

/** The kernel the request names, or the default. An unknown kernel, or one this libvips lacks, is a 400. */
export function resolveKernel(options: Pick<ConversionOptions, 'kernel'>): ResampleKernel {
  const requested = options.kernel ?? DEFAULT_KERNEL;
  if (!KERNEL_SET.has(requested)) {
    throw new UnsupportedOptionError(`kernel "${String(requested)}" is not supported; use one of ${RESAMPLE_KERNELS.join(', ')}`);
  }
  if (!Object.prototype.hasOwnProperty.call(sharp.kernel, requested)) {
    throw new UnsupportedOptionError(`kernel "${requested}" is not available in the installed image library`);
  }
  return requested as ResampleKernel;
}

export function needsLinearLight(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): boolean {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) return false;
  return targetWidth / sourceWidth <= LINEAR_LIGHT_MAX_SCALE || targetHeight / sourceHeight <= LINEAR_LIGHT_MAX_SCALE;
}

/** The linear working space of the pipeline. */
export const LINEAR_PIPELINE_SPACE = 'scrgb';

/**
 * The colourspace to convert back to after a linear-light resize, so a grey source stays grey and a 16-bit
 * source stays 16-bit instead of ending up as 8-bit sRGB.
 */
export function colourspaceAfterLinearResize(space: string | undefined): 'srgb' | 'b-w' | 'grey16' | 'rgb16' {
  if (space === 'b-w' || space === 'grey16' || space === 'rgb16') return space;
  return 'srgb';
}
