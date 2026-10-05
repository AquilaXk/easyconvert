import { ConversionFailedError } from '../types';

/**
 * Resource budgets for multi-frame image conversions. They are checked from header metadata before any pixel
 * is decoded, so a tiny file that declares a huge canvas is refused instead of exhausting memory or time.
 */

const BYTES_PER_MIB = 1024 * 1024;

/** Bytes per pixel of the 8-bit RGBA frames an animation is held and transformed as. */
export const RGBA_BYTES_PER_PIXEL = 4;

/** Upper bound for the RGBA bytes of all frames of one decoded or resized animation. */
export const MAX_DECODED_ANIMATION_BYTES = 512 * BYTES_PER_MIB;

/** Upper bound for the pixels of all pages converted from one multi-page image (each page is decoded alone). */
export const MAX_AGGREGATE_PAGE_PIXELS = 400_000_000;

/** Largest output side accepted for `width` and `height` (the JPEG and TIFF container limit). */
export const MAX_OUTPUT_DIMENSION = 65_535;

/** Bytes of `frames` RGBA frames of `width` x `height` pixels. */
export function rgbaBytes(width: number, height: number, frames: number): number {
  return width * height * frames * RGBA_BYTES_PER_PIXEL;
}

/** Throws when the RGBA bytes of `frames` frames of `width` x `height` exceed the decoded animation budget. */
export function assertAnimationBudget(width: number, height: number, frames: number, what: string): void {
  const bytes = rgbaBytes(width, height, frames);
  if (!Number.isFinite(bytes) || bytes > MAX_DECODED_ANIMATION_BYTES) {
    const mib = Number.isFinite(bytes) ? Math.ceil(bytes / BYTES_PER_MIB) : Infinity;
    throw new ConversionFailedError(
      `${what} would hold ${frames} frames of ${width}x${height} pixels (${mib} MiB as RGBA), over the ${
        MAX_DECODED_ANIMATION_BYTES / BYTES_PER_MIB
      } MiB decoded animation limit`
    );
  }
}

/** Throws when converting `pixels` pixels across all selected pages exceeds the aggregate page budget. */
export function assertAggregatePagePixels(pixels: number, pages: number): void {
  if (pixels > MAX_AGGREGATE_PAGE_PIXELS) {
    throw new ConversionFailedError(
      `The ${pages} selected pages hold ${pixels} pixels in total, over the limit of ${MAX_AGGREGATE_PAGE_PIXELS}; select fewer pages with the "page" or "pages" option`
    );
  }
}
