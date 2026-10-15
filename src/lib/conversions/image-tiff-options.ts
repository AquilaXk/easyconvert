import type { TiffOptions } from 'sharp';
import { type ConversionOptions, UnsupportedOptionError } from '../types';

/** TIFF compression schemes a request may name; JPEG is lossy and is never chosen implicitly. */
export const TIFF_COMPRESSIONS = ['deflate', 'lzw', 'none', 'jpeg'] as const;
export type TiffCompression = (typeof TIFF_COMPRESSIONS)[number];

const TIFF_COMPRESSION_SET: ReadonlySet<string> = new Set(TIFF_COMPRESSIONS);

/** Archival default: Adobe Deflate with horizontal differencing, which is lossless for 8- and 16-bit integer samples. */
export const DEFAULT_TIFF_COMPRESSION: TiffCompression = 'deflate';

/** Quality of the lossy JPEG scheme when the request names it without a `quality`. */
const TIFF_JPEG_DEFAULT_QUALITY = 85;

/**
 * Sharp encoder options for a TIFF target. A `quality` alone never selects JPEG: only
 * `tiffCompression: 'jpeg'` does, and only that scheme reads `quality`.
 */
export function buildTiffOptions(options: Pick<ConversionOptions, 'tiffCompression' | 'quality'>): TiffOptions {
  const requested = options.tiffCompression ?? DEFAULT_TIFF_COMPRESSION;
  if (!TIFF_COMPRESSION_SET.has(requested)) {
    throw new UnsupportedOptionError(
      `tiffCompression "${String(requested)}" is not supported; use one of ${TIFF_COMPRESSIONS.join(', ')}`
    );
  }
  if (requested === 'jpeg') {
    return { compression: 'jpeg', quality: options.quality ?? TIFF_JPEG_DEFAULT_QUALITY };
  }
  if (requested === 'none') {
    return { compression: 'none' };
  }
  return { compression: requested, predictor: 'horizontal' };
}
