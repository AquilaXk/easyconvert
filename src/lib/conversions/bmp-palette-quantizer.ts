import type { Sharp } from 'sharp';
import type { ConversionOptions } from '../types';
import { encodeBmp8 } from './bmp';
import { rgbaRaster } from './image-rgba-raster';
import { QUANTIZR_DITHER_LEVEL, quantizePixels, quantizrFits } from './png-palette-quantizer';

/**
 * The palette of a dithered 8-bit BMP, chosen by `quantizr-pixels` (png-palette-quantizer.ts: the program, its sandbox, its pixel bound and the
 * dithering level of entry 253). The picture is decoded by the worker, so the program only sees pixels. The answer is null when the program is not
 * installed, the picture is past its bound or the run fails, and the caller writes the picture with the Oklab quantizer as before. A BMP without
 * dithering is not given to the program: its palette is no better than the Oklab quantizer's there (entry 365).
 */

const RGBA_CHANNELS = 4;
const ALPHA_OFFSET = 3;
const OPAQUE = 255;

export interface Bmp8Request {
  /** The most colours of the palette (2 to 256). */
  colours: number;
  options: ConversionOptions;
}

/** Alpha of every pixel made 255 in place: an 8-bit BMP holds no transparency, so alpha takes no part in the palette. */
function makeOpaque(rgba: Buffer): void {
  for (let at = ALPHA_OFFSET; at < rgba.length; at += RGBA_CHANNELS) rgba[at] = OPAQUE;
}

/** The dithered 8-bit BMP of the pipeline, its palette chosen by the program, or null when the picture is left to the Oklab quantizer. The pipeline is not consumed. */
export async function quantizedBmp8(pipeline: Sharp, request: Bmp8Request): Promise<Buffer | null> {
  if (!(await quantizrFits(pipeline, request.options))) return null;
  const { data, info } = await rgbaRaster(pipeline.clone());
  makeOpaque(data);
  const picture = await quantizePixels(data, info.width, info.height, {
    colours: request.colours,
    dither: QUANTIZR_DITHER_LEVEL,
    signal: request.options.signal,
  });
  if (picture === null) return null;
  const palette = Array.from({ length: picture.palette.length / RGBA_CHANNELS }, (_, entry) => ({
    r: picture.palette[entry * RGBA_CHANNELS],
    g: picture.palette[entry * RGBA_CHANNELS + 1],
    b: picture.palette[entry * RGBA_CHANNELS + 2],
  }));
  return encodeBmp8(picture.indices, palette, info.width, info.height);
}
