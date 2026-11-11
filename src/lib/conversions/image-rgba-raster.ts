import type { OutputInfo, Sharp } from 'sharp';
import type { ConversionOptions } from '../types';
import { GIF_PHOTO_PIXEL_BUDGET, maxInputPixels, resizedDimensions } from './image-input-limits';
import { metadataOf } from './image-metadata';
import { FIRST_QUARTER_TURN_ORIENTATION } from './image-orientation';
import { withImageThreads, withPipelineThreads } from './image-threads';

/**
 * Pixels from which the RGBA raster of a GIF is read on all the threads the image library may lease (see `imageThreadsFor`): the
 * thread pool of a smaller picture costs about as much as it saves.
 */
export const RASTER_THREADS_MIN_PIXELS = 2_000_000;

/**
 * The picture as 8-bit RGBA, for the palette quantizer. The library's base count of one thread makes this pass (the ICC transform of a
 * developed camera picture, the reduction of 16-bit samples to 8 bits, the alpha plane) the longest step of a large GIF: a large picture
 * is read on the threads an AVIF encode leases, a small one on the two a JPEG pipeline leases (see `pipelineThreadsFor`).
 */
export async function rgbaRaster(pipeline: Sharp): Promise<{ data: Buffer; info: OutputInfo }> {
  const { width = 0, height = 0 } = await metadataOf(pipeline);
  const read = (): Promise<{ data: Buffer; info: OutputInfo }> => pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return width * height >= RASTER_THREADS_MIN_PIXELS ? withImageThreads(read) : withPipelineThreads(read);
}

/** The size a pipeline writes at: its header size, turned upright by its orientation, then the requested resize; read before the picture is decoded. */
export async function writtenSizeOf(pipeline: Sharp, options: ConversionOptions): Promise<{ width: number; height: number } | null> {
  const { width, height, orientation } = await metadataOf(pipeline);
  if (width === undefined || height === undefined) return null;
  const quarterTurn = (orientation ?? 1) >= FIRST_QUARTER_TURN_ORIENTATION;
  const upright = quarterTurn ? { width: height, height: width } : { width, height };
  return resizedDimensions(upright.width, upright.height, options);
}

/**
 * Whether the picture a pipeline writes is small enough for the in-process GIF palette of a photograph. The size is the one
 * after the resize (a small source scaled up holds as many pixels as the scaled picture), and the line is the lower of the
 * budget and the input limit, so a picture the quantizer would refuse is written by the image library instead.
 */
export async function withinQuantizerBudget(pipeline: Sharp, options: ConversionOptions): Promise<boolean> {
  const size = await writtenSizeOf(pipeline, options);
  if (size === null) return true; // no header size to judge: the quantizer asserts the raster it is given
  return size.width * size.height <= Math.min(GIF_PHOTO_PIXEL_BUDGET.maxPixels, maxInputPixels());
}
