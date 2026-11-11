import type { OutputInfo, Sharp } from 'sharp';
import { metadataOf } from './image-metadata';
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
