import { QUANTIZR_DITHER_LEVEL, quantizePixels, writeIndexedPng } from './png-palette-quantizer';

/**
 * The palette of a dithered 8-bit ICO, chosen by `quantizr-pixels` (png-palette-quantizer.ts: the program, its sandbox and the dithering level of entry
 * 253) from the icon's RGBA pixels, which the worker decoded, so the program never sees uploaded bytes. The alpha of the pixels takes part in the palette
 * and goes into the indexed PNG of the icon as a tRNS chunk. The icon is at most 256 x 256 pixels, so the program's own pixel bound never applies. The
 * answer is null when the program is not installed or its run fails, and the caller writes the icon with the Oklab quantizer as before (entry 376 of
 * docs/policy-decisions.md has the measurements).
 */

/**
 * The fewest pixels (64 x 64) of an icon given to the program. The program is a separate process, a fixed 6 to 10 ms on the Linux VM, which the Oklab
 * quantizer undercuts on a smaller picture; from this size the program takes the same time or less.
 */
export const ICO_PROGRAM_MIN_PIXELS = 64 * 64;

/** A PNG signature only: the icon's indexed PNG carries no chunk of the source (the Oklab icon never did). */
const NO_EXTRA_CHUNKS = Buffer.from('89504e470d0a1a0a', 'hex');

/** The indexed PNG of the icon, or null when the picture is left to the Oklab quantizer. `rgba` is 8-bit RGBA, four bytes a pixel. */
export async function quantizedIconPng(rgba: Buffer, width: number, height: number, request: { colours: number; signal?: AbortSignal }): Promise<Buffer | null> {
  if (width * height < ICO_PROGRAM_MIN_PIXELS) return null;
  const picture = await quantizePixels(rgba, width, height, { colours: request.colours, dither: QUANTIZR_DITHER_LEVEL, signal: request.signal });
  if (picture === null) return null;
  return writeIndexedPng(picture, NO_EXTRA_CHUNKS, request.signal, false);
}
