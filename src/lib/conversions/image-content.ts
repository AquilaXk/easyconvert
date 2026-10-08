import type { Sharp } from 'sharp';

/**
 * Cheap content analysis for the lossy encoders. Screenshots, line art and rendered text have large flat areas
 * and hard coloured edges: chroma subsampling smears those edges and the AV1/WebP palette and intra-block tools
 * pay off at a higher effort. Photographs are noisy and smooth, so subsampled chroma costs little there.
 */

export type ContentClass = 'graphic' | 'photo';

/** Longest side of the thumbnail the classifier reads; 128 x 128 pixels bound the work whatever the input size. */
export const CLASSIFIER_SIDE = 128;
/**
 * Share of horizontally adjacent thumbnail pixels with the same colour above which an image is graphic. The
 * thumbnail is taken by nearest-neighbour sampling, so noise and gradients make neighbours differ: measured on
 * the benchmark corpus the photographs score 0.00 to 0.04 and the screenshot and the line drawing 0.55 to 0.93.
 */
export const GRAPHIC_FLAT_PAIR_SHARE = 0.4;
const RGB_CHANNELS = 3;

/** Share of adjacent same-colour pixel pairs in a packed RGB thumbnail; 0 for a thumbnail of one column. */
export function flatPairShare(rgb: Uint8Array, width: number, height: number): number {
  if (width < 2 || height < 1) return 0;
  let flat = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * RGB_CHANNELS;
    for (let x = 1; x < width; x += 1) {
      const a = row + x * RGB_CHANNELS;
      if (rgb[a] === rgb[a - 3] && rgb[a + 1] === rgb[a - 2] && rgb[a + 2] === rgb[a - 1]) flat += 1;
    }
  }
  return flat / ((width - 1) * height);
}

/** Classifies the picture the pipeline will encode from a nearest-neighbour thumbnail of it. */
export async function classifyContent(pipeline: Sharp): Promise<ContentClass> {
  const { data, info } = await pipeline
    .clone()
    .resize({ width: CLASSIFIER_SIDE, height: CLASSIFIER_SIDE, fit: 'inside', kernel: 'nearest', withoutEnlargement: true })
    .removeAlpha()
    .toColourspace('srgb')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== RGB_CHANNELS) return 'photo';
  return flatPairShare(data, info.width, info.height) >= GRAPHIC_FLAT_PAIR_SHARE ? 'graphic' : 'photo';
}

/**
 * Drops an alpha channel on which every pixel is fully opaque: it carries no information, and the encoders that
 * keep alpha as a separate plane (AVIF, lossy WebP) spend a few hundred bytes on it. A picture with any
 * transparent or translucent pixel keeps its channel untouched.
 */
export async function withoutOpaqueAlpha(pipeline: Sharp): Promise<Sharp> {
  const meta = await pipeline.metadata();
  if (!meta.hasAlpha) return pipeline;
  const { isOpaque } = await pipeline.clone().stats();
  return isOpaque ? pipeline.removeAlpha() : pipeline;
}
