import sharp from 'sharp';
import { ConversionFailedError, InvalidPageRangeError } from '../types';
import { decodeApngFrames, parseApng, type ApngInfo } from './image-apng';
import type { AnimationTiming, RawFrame } from './image-animation';
import { parsePageRanges } from './page-range';

/**
 * Frame and page selection for multi-frame image sources.
 *
 * Documented defaults (reported to callers as `sourceFrameCount` and `frameUsed`):
 *  - Animated sources (GIF, WebP, APNG):
 *      animated target (gif, webp)  -> every frame, its delay and the loop count are kept;
 *      any still target             -> frame 1; `page` selects another frame.
 *  - Multi-page document sources (TIFF, HEIF image sequences):
 *      tiff target                  -> every page is kept in one multi-page TIFF;
 *      any other target             -> one image per page in a ZIP (`<name>-p001.<ext>`, the naming the
 *                                      PDF page renderer uses); `page`/`pages` select pages, a single
 *                                      selected page is returned as a plain image.
 *  - `page` outside 1..N throws InvalidPageRangeError.
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
const EXIF_ORIENTATION_NORMAL = 1;
const PLAY_ONCE = 1;
const ALL_PAGES = -1;

/** Selection-relevant options. */
export interface FrameOptions {
  page?: number | string;
  pages?: string;
  multiPageOutput?: 'zip' | 'first';
}

/** An animation whose frames are decoded one by one so the caller can transform them before encoding. */
export interface DecodedAnimation {
  frameCount: number;
  timing: AnimationTiming;
  /** Decodes frame `index` (0-based) as RGBA, with EXIF orientation applied where the source has one. */
  loadFrame(index: number): Promise<RawFrame>;
}

export interface FrameSelection {
  /** What sharp decodes: the source itself, or one APNG frame as raw RGBA. */
  source: Buffer;
  input: sharp.SharpOptions;
  /** sharp's own animated pipeline keeps every frame (gif/webp source to gif/webp target). */
  keepsAnimation: boolean;
  /** Frames the caller decodes and assembles itself (oriented animations, APNG). */
  animation?: DecodedAnimation;
  /** Pages to convert one by one and package as a ZIP. */
  zipPages?: number[];
  sourceFrameCount?: number;
  frameUsed?: number;
}

function outOfRange(page: number | string, frames: number): InvalidPageRangeError {
  return new InvalidPageRangeError(`Frame ${String(page)} is out of range: the image has ${frames} frames (1-${frames})`);
}

function parseSinglePage(page: number | string, frames: number): number {
  const requested = Number(page);
  if (!Number.isInteger(requested) || requested < 1 || requested > frames) throw outOfRange(page, frames);
  return requested;
}

/** Pages the request asks for (`page`, else `pages`), or undefined when it asks for none. */
function requestedPages(options: FrameOptions, frames: number): number[] | undefined {
  if (options.page !== undefined) return [parseSinglePage(options.page, frames)];
  if (options.pages !== undefined) return parsePageRanges(options.pages, frames);
  return undefined;
}

function singleSource(
  source: Buffer,
  input: sharp.SharpOptions,
  sourceFrameCount: number,
  frameUsed: number
): FrameSelection {
  return { source, input, keepsAnimation: false, sourceFrameCount, frameUsed };
}

function timingOf(meta: sharp.Metadata, frames: number): AnimationTiming {
  const delaysMs = meta.delay ?? [];
  if (delaysMs.length !== frames) {
    throw new ConversionFailedError(`The image reports ${delaysMs.length} frame delays for ${frames} frames`);
  }
  return { delaysMs, loop: meta.loop ?? PLAY_ONCE };
}

/** Animation of a GIF or WebP whose frames are decoded page by page (used when sharp cannot orient them in bulk). */
function decodedSharpAnimation(buffer: Buffer, meta: sharp.Metadata, frames: number): DecodedAnimation {
  return {
    frameCount: frames,
    timing: timingOf(meta, frames),
    async loadFrame(index) {
      const { data, info } = await sharp(buffer, { page: index })
        .rotate()
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height };
    },
  };
}

function decodedApngAnimation(buffer: Buffer, apng: ApngInfo): DecodedAnimation {
  let decoded: Promise<RawFrame[]> | undefined;
  return {
    frameCount: apng.frameCount,
    timing: { delaysMs: apng.delaysMs, loop: apng.plays },
    async loadFrame(index) {
      decoded ??= decodeApngFrames(buffer, apng);
      return (await decoded)[index];
    },
  };
}

async function selectApngFrames(
  buffer: Buffer,
  apng: ApngInfo,
  targetFormat: string,
  options: FrameOptions
): Promise<FrameSelection> {
  const frames = apng.frameCount;
  const requested = requestedPages(options, frames);
  if (requested === undefined && ANIMATED_IMAGE_TARGETS.has(targetFormat)) {
    return {
      source: buffer,
      input: {},
      keepsAnimation: false,
          animation: decodedApngAnimation(buffer, apng),
      sourceFrameCount: frames,
    };
  }
  const page = singleFrameOf(requested, frames);
  if (page === FIRST_FRAME && apng.defaultImageIsFirstFrame) {
    return singleSource(buffer, {}, frames, page);
  }
  const frame = await decodedApngAnimation(buffer, apng).loadFrame(page - 1);
  return singleSource(frame.data, { raw: { width: frame.width, height: frame.height, channels: 4 } }, frames, page);
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

function selectAnimationFrames(
  buffer: Buffer,
  meta: sharp.Metadata,
  frames: number,
  targetFormat: string,
  options: FrameOptions
): FrameSelection {
  const requested = requestedPages(options, frames);
  if (requested === undefined && ANIMATED_IMAGE_TARGETS.has(targetFormat)) {
    const needsOrientation = meta.orientation !== undefined && meta.orientation !== EXIF_ORIENTATION_NORMAL;
    if (needsOrientation) {
      return {
        source: buffer,
        input: {},
        keepsAnimation: false,
              animation: decodedSharpAnimation(buffer, meta, frames),
        sourceFrameCount: frames,
      };
    }
    return {
      source: buffer,
      input: { animated: true },
      keepsAnimation: true,
          sourceFrameCount: frames,
    };
  }
  const page = singleFrameOf(requested, frames);
  return singleSource(buffer, { page: page - 1 }, frames, page);
}

function selectDocumentPages(
  buffer: Buffer,
  meta: sharp.Metadata,
  pageCount: number,
  targetFormat: string,
  options: FrameOptions
): FrameSelection {
  const requested = requestedPages(options, pageCount);
  if (requested === undefined && targetFormat === MULTI_PAGE_TIFF_TARGET) {
    if (meta.orientation !== undefined && meta.orientation !== EXIF_ORIENTATION_NORMAL) {
      throw new ConversionFailedError(
        `This ${pageCount}-page image carries EXIF orientation ${meta.orientation}, which cannot be applied to every page of one TIFF; select pages with the "page" option`
      );
    }
    return {
      source: buffer,
      input: { pages: ALL_PAGES },
      keepsAnimation: false,
      sourceFrameCount: pageCount,
    };
  }
  const pages = requested ?? Array.from({ length: pageCount }, (_unused, index) => index + 1);
  if (pages.length === SINGLE_FRAME || options.multiPageOutput === 'first') {
    return singleSource(buffer, { page: pages[0] - 1 }, pageCount, pages[0]);
  }
  return {
    source: buffer,
    input: {},
    keepsAnimation: false,
      zipPages: pages,
    sourceFrameCount: pageCount,
  };
}

/**
 * Decides which frames or pages of `buffer` the conversion to `targetFormat` decodes. Single-frame sources
 * are returned untouched (`page` is not interpreted for them).
 */
export async function selectFrames(buffer: Buffer, targetFormat: string, options: FrameOptions): Promise<FrameSelection> {
  const untouched: FrameSelection = { source: buffer, input: {}, keepsAnimation: false };
  const apng = parseApng(buffer);
  if (apng) return selectApngFrames(buffer, apng, targetFormat, options);

  const meta = await sharp(buffer).metadata();
  const frames = meta.pages ?? SINGLE_FRAME;
  if (frames <= SINGLE_FRAME || meta.format === undefined) return untouched;
  if (ANIMATION_SOURCE_FORMATS.has(meta.format)) {
    return selectAnimationFrames(buffer, meta, frames, targetFormat, options);
  }
  if (DOCUMENT_SOURCE_FORMATS.has(meta.format)) {
    return selectDocumentPages(buffer, meta, frames, targetFormat, options);
  }
  return untouched;
}
