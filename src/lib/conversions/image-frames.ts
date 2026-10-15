import sharp, { type Metadata, type ResizeOptions, type SharpOptions } from 'sharp';
import { ConversionFailedError, InvalidPageRangeError } from '../types';
import { ApngCompositor, parseApng, type ApngAnimation } from './image-apng';
import type { AnimationMetadata, FrameSource, RawFrame } from './image-animation';
import {
  assertAggregatePagePixels,
  assertAnimationBudget,
  assertFrameCount,
  assertOutputPixels,
  COMPOSED_MEMORY,
  orientedMemory,
  RGBA_BYTES_PER_PIXEL,
} from './image-limits';
import { maxInputPixels, resizedDimensions } from './image-input-limits';
import { EXIF_ORIENTATION_NORMAL, orientRgbaFrame, withUprightOrientation } from './image-orientation';
import { resolvePageLimit, resolvePageSelection, type TierPageCapped } from './page-range';

/**
 * Frame and page selection for multi-frame image sources.
 *
 * Documented defaults (reported to callers as `sourceFrameCount` and `frameUsed`):
 *  - Animated sources (GIF, WebP, APNG):
 *      animated target (gif, webp)  -> every frame, its delay and the loop count are kept;
 *      any still target             -> frame 1 (for an APNG whose default image is not part of the
 *                                      animation, that default image); `page` selects another frame.
 *  - Multi-page document sources (TIFF, HEIF image sequences):
 *      tiff target                  -> one multi-page TIFF with every page (or the selected pages);
 *      any other target             -> one image per page in a ZIP (`<name>-p001.<ext>`, the naming the
 *                                      PDF page renderer uses); a single selected page is a plain image.
 *  - `page` and `pages` select pages; when both are given they must agree. `multiPageOutput: 'first'`
 *    reduces any selection to its first page before a keep-everything default applies.
 *  - A page outside 1..N throws InvalidPageRangeError; a document source with more pages than the tier
 *    allows (`maxPages`) or more pixels than the aggregate budget is refused.
 */

/** Targets whose container can hold an animation. */
export const ANIMATED_IMAGE_TARGETS: ReadonlySet<string> = new Set(['gif', 'webp']);

/** Source formats libvips reads as an animation (frames reported through `pages`). */
const ANIMATION_SOURCE_FORMATS: ReadonlySet<string> = new Set(['gif', 'webp']);
/** Source formats libvips reads as a sequence of pages. */
const DOCUMENT_SOURCE_FORMATS: ReadonlySet<string> = new Set(['tiff', 'heif']);

const MULTI_PAGE_TIFF_TARGET = 'tiff';
const FIRST_FRAME = 1;
const SINGLE_FRAME = 1;
const PLAY_ONCE = 1;
const FIRST_QUARTER_TURN_ORIENTATION = 5;

/** The output size a request asks for: validated sides (at least one) and the fit that places the page in them. */
export interface PageResize {
  width?: number;
  height?: number;
  fit?: ResizeOptions['fit'];
}

/** Selection-relevant options. */
export interface FrameOptions extends TierPageCapped {
  page?: number | string | null;
  pages?: string | null;
  multiPageOutput?: 'zip' | 'first';
  stripMetadata?: boolean;
}

/** An animation whose frames are decoded and composed one by one, in order. */
export interface DecodedAnimation extends FrameSource {
  metadata: AnimationMetadata;
}

export interface FrameSelection {
  /** What sharp decodes: the source itself, or one composed APNG frame as raw RGBA. */
  source: Buffer;
  input: SharpOptions;
  /** sharp's own animated pipeline keeps every frame (gif/webp source to gif/webp target). */
  keepsAnimation: boolean;
  /** Frames the caller decodes and assembles itself (oriented animations, APNG). */
  animation?: DecodedAnimation;
  /** Pages to convert one by one and package as a ZIP (or as one PDF). */
  zipPages?: number[];
  /** Pages to convert one by one and merge into one multi-page TIFF. */
  tiffPages?: number[];
  /** Frames and size of the animation that is kept, for output budgets. */
  canvas?: { width: number; height: number; frames: number };
  sourceFrameCount?: number;
  frameUsed?: number;
}

function frameOutOfRange(page: number | string, frames: number): InvalidPageRangeError {
  return new InvalidPageRangeError(`Frame ${String(page)} is out of range: the image has ${frames} frames (1-${frames})`);
}

/**
 * Pages the request asks for, or undefined when it asks for none. `page` and `pages` must agree when both
 * are present; `multiPageOutput: 'first'` keeps only the first selected page (page 1 without a selection).
 */
export function resolveRequestedPages(options: FrameOptions, count: number): number[] | undefined {
  const requested = resolvePageSelection(options.page, options.pages, count, frameOutOfRange);
  if (options.multiPageOutput === 'first') return [requested?.[0] ?? FIRST_FRAME];
  return requested;
}

function singleSource(
  source: Buffer,
  input: SharpOptions,
  sourceFrameCount: number,
  frameUsed: number | undefined
): FrameSelection {
  return { source, input, keepsAnimation: false, sourceFrameCount, frameUsed };
}

/** The one frame an animated source converts to a still image: the requested one, else frame 1. */
function singleFrameOf(requested: number[] | undefined, frames: number): number {
  if (requested === undefined) return FIRST_FRAME;
  if (requested.length !== SINGLE_FRAME) {
    throw new InvalidPageRangeError(
      `Select a single frame of this ${frames}-frame image with the "page" option; ${requested.length} were requested`
    );
  }
  return requested[0];
}

// ---- APNG ------------------------------------------------------------------------------------------------

function apngAnimation(animation: ApngAnimation): DecodedAnimation {
  const compositor = new ApngCompositor(animation);
  return {
    width: animation.width,
    height: animation.height,
    frameCount: animation.frameCount,
    timing: { delaysMs: animation.delaysMs, loop: animation.plays },
    metadata: {},
    async frame(index): Promise<RawFrame> {
      if (index !== compositor.framesDrawn) {
        throw new ConversionFailedError(`Animated PNG frames are composed in order: frame ${index + 1} requested after ${compositor.framesDrawn}`);
      }
      await compositor.advance();
      return { data: compositor.snapshot(), width: animation.width, height: animation.height };
    },
  };
}

async function selectApng(
  buffer: Buffer,
  animation: ApngAnimation,
  targetFormat: string,
  options: FrameOptions
): Promise<FrameSelection> {
  const frames = animation.frameCount;
  const { width, height } = animation;
  assertFrameCount(frames, 'The animated PNG');
  const requested = resolveRequestedPages(options, frames);
  if (requested === undefined && ANIMATED_IMAGE_TARGETS.has(targetFormat)) {
    assertAnimationBudget(width, height, frames, 'The animated PNG', COMPOSED_MEMORY);
    return {
      source: buffer,
      input: {},
      keepsAnimation: false,
      animation: apngAnimation(animation),
      canvas: { width, height, frames },
      sourceFrameCount: frames,
    };
  }
  assertAnimationBudget(width, height, SINGLE_FRAME, 'The animated PNG canvas', COMPOSED_MEMORY);
  if (requested === undefined) {
    // Frame 1 is the default image when an fcTL precedes it; otherwise the default image is not a frame.
    return singleSource(buffer, {}, frames, animation.defaultIsFirstFrame ? FIRST_FRAME : undefined);
  }
  const page = singleFrameOf(requested, frames);
  if (page === FIRST_FRAME && animation.defaultIsFirstFrame) return singleSource(buffer, {}, frames, page);
  const composer = apngAnimation(animation);
  let frame = await composer.frame(0);
  for (let index = 1; index < page; index += 1) frame = await composer.frame(index);
  return singleSource(frame.data, { raw: { width, height, channels: RGBA_BYTES_PER_PIXEL } }, frames, page);
}

// ---- GIF and WebP ----------------------------------------------------------------------------------------

/**
 * Animation of a GIF or WebP decoded once as sharp's stacked "toilet roll" image (which keeps libvips'
 * pixel limit) and oriented frame by frame from the raw pixels. The size is checked against the decoded
 * animation budget before anything is decoded.
 */
function orientedAnimation(buffer: Buffer, meta: Metadata, frames: number, orientation: number, options: FrameOptions): DecodedAnimation {
  const storedWidth = meta.width ?? 0;
  const storedHeight = meta.height ?? 0;
  const swaps = orientation >= FIRST_QUARTER_TURN_ORIENTATION;
  const delaysMs = meta.delay ?? [];
  if (delaysMs.length !== frames) {
    throw new ConversionFailedError(`The image reports ${delaysMs.length} frame delays for ${frames} frames`);
  }
  assertAnimationBudget(storedWidth, storedHeight, frames, 'The oriented animation', orientedMemory(frames));
  const frameBytes = storedWidth * storedHeight * RGBA_BYTES_PER_PIXEL;
  let stack: Buffer | undefined;
  const metadata: AnimationMetadata = {};
  if (options.stripMetadata !== true) {
    if (meta.icc) metadata.icc = meta.icc;
    if (meta.exif) metadata.exif = withUprightOrientation(meta.exif);
  }
  return {
    width: swaps ? storedHeight : storedWidth,
    height: swaps ? storedWidth : storedHeight,
    frameCount: frames,
    timing: { delaysMs, loop: meta.loop ?? PLAY_ONCE },
    metadata,
    async frame(index): Promise<RawFrame> {
      if (!stack) {
        // A kept ICC profile means the pixels stay in the profile space; without it libvips converts to sRGB.
        const decoder = sharp(buffer, { animated: true, limitInputPixels: maxInputPixels() });
        const decoded = await (options.stripMetadata === true ? decoder : decoder.keepIccProfile())
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (decoded.data.length !== frameBytes * frames) {
          throw new ConversionFailedError(`The animation decoded to ${decoded.data.length} bytes, expected ${frames} frames of ${frameBytes} bytes`);
        }
        stack = decoded.data;
      }
      const slice = stack.subarray(index * frameBytes, (index + 1) * frameBytes);
      const oriented = orientRgbaFrame({ data: slice, width: storedWidth, height: storedHeight }, orientation);
      if (index === frames - 1) stack = undefined;
      return oriented;
    },
  };
}

function selectAnimationFrames(
  buffer: Buffer,
  meta: Metadata,
  frames: number,
  targetFormat: string,
  options: FrameOptions
): FrameSelection {
  assertFrameCount(frames, 'The animation');
  const requested = resolveRequestedPages(options, frames);
  if (requested === undefined && ANIMATED_IMAGE_TARGETS.has(targetFormat)) {
    const orientation = meta.orientation ?? EXIF_ORIENTATION_NORMAL;
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (orientation !== EXIF_ORIENTATION_NORMAL) {
      const animation = orientedAnimation(buffer, meta, frames, orientation, options);
      return {
        source: buffer,
        input: {},
        keepsAnimation: false,
        animation,
        canvas: { width: animation.width, height: animation.height, frames },
        sourceFrameCount: frames,
      };
    }
    assertAnimationBudget(width, height, frames, 'The animation');
    return {
      source: buffer,
      input: { animated: true },
      keepsAnimation: true,
      canvas: { width, height, frames },
      sourceFrameCount: frames,
    };
  }
  const page = singleFrameOf(requested, frames);
  return singleSource(buffer, { page: page - 1 }, frames, page);
}

// ---- TIFF and HEIF pages -----------------------------------------------------------------------------------

async function selectDocumentPages(
  buffer: Buffer,
  pageCount: number,
  targetFormat: string,
  options: FrameOptions,
  resize: PageResize | null
): Promise<FrameSelection> {
  const cap = resolvePageLimit(options);
  const requested = resolveRequestedPages(options, pageCount);
  const pages = requested ?? Array.from({ length: pageCount }, (_unused, index) => index + 1);
  if (pages.length > cap) {
    throw new InvalidPageRangeError(
      `This image has ${pages.length} pages to convert, over the limit of ${cap} pages per request; select pages with the "page" or "pages" option`
    );
  }
  if (pages.length === SINGLE_FRAME) return singleSource(buffer, { page: pages[0] - 1 }, pageCount, pages[0]);
  // Every page is decoded at its source size and encoded at its resized size: charge the larger of the two.
  let pixels = 0;
  for (const page of pages) {
    const pageMeta = await sharp(buffer, { page: page - 1, limitInputPixels: maxInputPixels() }).metadata();
    const sourceWidth = pageMeta.width ?? 0;
    const sourceHeight = pageMeta.height ?? 0;
    const resized = sourceWidth > 0 && sourceHeight > 0 ? resizedDimensions(sourceWidth, sourceHeight, resize ?? {}) : { width: 0, height: 0 };
    if (resize) assertOutputPixels(resized.width, resized.height);
    pixels += Math.max(sourceWidth * sourceHeight, resized.width * resized.height);
  }
  assertAggregatePagePixels(pixels, pages.length);
  const selection: FrameSelection = { source: buffer, input: {}, keepsAnimation: false, sourceFrameCount: pageCount };
  if (targetFormat === MULTI_PAGE_TIFF_TARGET) selection.tiffPages = pages;
  else selection.zipPages = pages;
  return selection;
}

/**
 * Decides which frames or pages of `buffer` the conversion to `targetFormat` decodes. Single-frame sources
 * are returned untouched (`page` is not interpreted for them). `resize` is the output size the request asks
 * for, which a multi-page document is charged for against the aggregate page budget.
 */
export async function selectFrames(
  buffer: Buffer,
  targetFormat: string,
  options: FrameOptions,
  resize: PageResize | null = null
): Promise<FrameSelection> {
  const untouched: FrameSelection = { source: buffer, input: {}, keepsAnimation: false };
  const apng = parseApng(buffer);
  if (apng) return selectApng(buffer, apng, targetFormat, options);

  const meta = await sharp(buffer, { limitInputPixels: maxInputPixels() }).metadata();
  const frames = meta.pages ?? SINGLE_FRAME;
  if (frames <= SINGLE_FRAME || meta.format === undefined) return untouched;
  if (ANIMATION_SOURCE_FORMATS.has(meta.format)) {
    return selectAnimationFrames(buffer, meta, frames, targetFormat, options);
  }
  if (DOCUMENT_SOURCE_FORMATS.has(meta.format)) {
    return selectDocumentPages(buffer, frames, targetFormat, options, resize);
  }
  return untouched;
}
