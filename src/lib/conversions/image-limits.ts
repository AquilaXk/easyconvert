import { ConversionFailedError, UnsupportedOptionError } from '../types';

/**
 * Resource budgets for multi-frame image conversions. They are checked from header metadata before any pixel
 * is decoded, so a tiny file that declares a huge canvas is refused instead of exhausting memory or time.
 */

const BYTES_PER_MIB = 1024 * 1024;

/** Bytes per pixel of the 8-bit RGBA frames an animation is held and transformed as. */
export const RGBA_BYTES_PER_PIXEL = 4;

/** Upper bound for the RGBA bytes of all frames of one decoded or resized animation. */
export const MAX_DECODED_ANIMATION_BYTES = 512 * BYTES_PER_MIB;

/** Most frames an animation may have; each frame is decoded, transformed and encoded on its own. */
export const MAX_ANIMATION_FRAMES = 4096;

/**
 * Copies of a stacked animation alive at once while it is decoded: libvips holds the decoded stack and
 * sharp copies it out as raw pixels. Measured on a 10-frame 2500 x 2500 animation.
 */
export const STACK_DECODE_COPIES = 2;

/**
 * Frame-sized buffers alive at once while a stacked animation is converted, besides the stack: the oriented
 * or resized copy of the current frame, the encoder's working copies and buffers freed but not yet collected.
 */
export const STACKED_WORKING_COPIES = 4;

/**
 * Frame-sized buffers alive at once while frames are composed one by one: the canvas, the decoded frame, the
 * decoder's own image, the encoder's copies and buffers freed but not yet collected. Measured as VmHWM above
 * the pre-conversion baseline on 5000 x 5000 (546 to 578 MiB) and 4000 x 4000 (355 to 384 MiB) animated
 * PNGs of two frames: between 5.5 and 6 frames' worth, rounded up.
 */
export const COMPOSED_WORKING_COPIES = 7;

/**
 * Frame-sized buffers alive at once, besides the stack, while an oriented animation is converted. Orienting
 * decodes the stack through the raw-pixel path and then turns and encodes frame by frame, so freed
 * intermediates pile up before they are collected. Measured as VmHWM above the baseline on 2000 x 2000 x 10
 * (490 to 534 MiB), 2000 x 2000 x 14 (617), 3000 x 3000 x 5 (685) and 2000 x 2000 x 6 noise (473): the
 * stack plus about 22 frames' worth at its worst. Oriented animations of 3000 x 3000 and up are refused.
 */
export const ORIENTED_WORKING_COPIES = 22;

/** How many frame-sized buffers a conversion keeps in memory at the same time. */
export interface AnimationMemory {
  /** Frames held for the whole conversion (all of them for a stacked animation, none when streamed). */
  residentFrames: number;
  /** Frame-sized working buffers on top of the resident frames. */
  workingCopies: number;
}

/** Memory shape of an animation decoded as one stack of `frames` frames. */
export const stackedMemory = (frames: number): AnimationMemory => ({
  residentFrames: frames * STACK_DECODE_COPIES,
  workingCopies: STACKED_WORKING_COPIES,
});

/** Memory shape of an oriented animation of `frames` frames: the stack stays resident while frames are turned. */
export const orientedMemory = (frames: number): AnimationMemory => ({
  residentFrames: frames,
  workingCopies: ORIENTED_WORKING_COPIES,
});

/** Memory shape of frames that are composed and encoded one at a time. */
export const COMPOSED_MEMORY: AnimationMemory = { residentFrames: 0, workingCopies: COMPOSED_WORKING_COPIES };

/** Upper bound for the pixels of all pages converted from one multi-page image (each page is decoded alone). */
export const MAX_AGGREGATE_PAGE_PIXELS = 400_000_000;

/** Largest output side accepted for `width` and `height` (the JPEG and TIFF container limit). */
export const MAX_OUTPUT_DIMENSION = 65_535;

/** Most pixels one resized output picture may hold (400 MB as RGBA). */
export const MAX_OUTPUT_PIXELS = 100_000_000;

/**
 * A requested output width or height. Undefined, null, 0 and '' mean "not requested"; anything else must be a
 * whole number from 1 to the largest output side. Shared by every engine that resizes, so raster and vector
 * sources validate the request the same way.
 */
export function outputSideOf(value: unknown, name: 'width' | 'height'): number | undefined {
  if (value === undefined || value === null || value === 0 || value === '') return undefined;
  const side = Number(value);
  if (!Number.isInteger(side) || side < 1 || side > MAX_OUTPUT_DIMENSION) {
    throw new UnsupportedOptionError(`Unsupported ${name} ${JSON.stringify(value)}: use a whole number from 1 to ${MAX_OUTPUT_DIMENSION}`);
  }
  return side;
}

/** Throws when a resized output of `width` x `height` pixels would hold more pixels than the output limit. */
export function assertOutputPixels(width: number, height: number): void {
  const pixels = width * height;
  if (!(pixels <= MAX_OUTPUT_PIXELS)) {
    throw new ConversionFailedError(
      `The resized image would be ${width}x${height} pixels (${pixels} pixels), over the limit of ${MAX_OUTPUT_PIXELS} pixels`
    );
  }
}

/** Bytes of `frames` RGBA frames of `width` x `height` pixels. */
export function rgbaBytes(width: number, height: number, frames: number): number {
  return width * height * frames * RGBA_BYTES_PER_PIXEL;
}

/** Throws when an animation has more frames than the frame limit allows. */
export function assertFrameCount(frames: number, what: string): void {
  if (frames > MAX_ANIMATION_FRAMES) {
    throw new ConversionFailedError(`${what} has ${frames} frames, over the limit of ${MAX_ANIMATION_FRAMES} frames`);
  }
}

/**
 * Throws when `frames` frames of `width` x `height` pixels exceed the decoded animation budget: either their
 * RGBA bytes in total (the work to do), or the frame-sized buffers `memory` keeps alive at once (the peak).
 */
export function assertAnimationBudget(
  width: number,
  height: number,
  frames: number,
  what: string,
  memory: AnimationMemory = stackedMemory(frames)
): void {
  assertFrameCount(frames, what);
  const total = rgbaBytes(width, height, frames);
  const peak = rgbaBytes(width, height, memory.residentFrames + memory.workingCopies);
  const worst = Math.max(total, peak);
  if (!Number.isFinite(worst) || worst > MAX_DECODED_ANIMATION_BYTES) {
    const mib = Number.isFinite(worst) ? Math.ceil(worst / BYTES_PER_MIB) : Infinity;
    throw new ConversionFailedError(
      `${what} would hold ${frames} frames of ${width}x${height} pixels (${mib} MiB as RGBA at its peak), over the ${
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
