import { getFormatByExtension } from '../../registry';
import { UnsupportedOptionError, type ConversionOptions } from '../../types';
import type { ConversionEnginePort } from '../engine-port';

/** The longest edge of a thumbnail that names no width or height. */
export const DEFAULT_THUMBNAIL_EDGE_PX = 256;
/** The frame a video thumbnail shows when the task names no time: past the black frames many clips open with. */
const DEFAULT_FRAME_TIME = '00:00:01.000';
const VIDEO_CATEGORY = 'video';
const IMAGE_CATEGORY = 'image';
const PICTURE_FORMAT = 'png';

/** What a thumbnail node asks of the engine for one input. */
export interface ThumbnailSource {
  buffer: Buffer;
  srcExt: string;
  /** The options of the conversion to the target. */
  options: ConversionOptions;
}

export interface ThumbnailPlan {
  /** The picture of `input` that the target conversion reads, and the options of that conversion. */
  prepare(input: { buffer: Buffer; srcExt: string; name: string }): Promise<ThumbnailSource>;
}

/**
 * The plan of a thumbnail node: one picture for each input, of the first page (or the page, or the frame, the task names), within
 * `width` x `height` as `fit` places it. An image goes to the target in one conversion. A video gives its frame through the media
 * engine and any other input (a document, a presentation, a vector drawing) its page through the page renderer, each as a PNG, and
 * that picture is then scaled like any image: the page and frame routes draw at the size of the page, so one scaling step after
 * them gives every source the same sizes, fits and targets (WebP included).
 */
export function thumbnailPlan(
  thumbnail: ConversionOptions['thumbnail'],
  engine: ConversionEnginePort,
  signal: AbortSignal
): ThumbnailPlan {
  const frames = thumbnail?.at ?? [];
  if (frames.length > 1) {
    throw new UnsupportedOptionError(`A thumbnail shows one frame; "thumbnail.at" lists ${frames.length}.`);
  }
  const scaling: ConversionOptions = {
    width: thumbnail?.width ?? DEFAULT_THUMBNAIL_EDGE_PX,
    height: thumbnail?.height ?? DEFAULT_THUMBNAIL_EDGE_PX,
    fit: thumbnail?.fit ?? 'inside',
  };
  return {
    async prepare({ buffer, srcExt, name }) {
      const category = getFormatByExtension(srcExt)?.category;
      if (category === IMAGE_CATEGORY) {
        return { buffer, srcExt, options: { ...scaling, page: thumbnail?.page, multiPageOutput: 'first' } };
      }
      const options: ConversionOptions =
        category === VIDEO_CATEGORY
          ? { thumbnail: { at: [frames[0] ?? DEFAULT_FRAME_TIME], format: PICTURE_FORMAT, accurate: thumbnail?.accurate }, signal }
          : { page: thumbnail?.page, multiPageOutput: 'first', signal };
      const picture = await engine.convert(buffer, srcExt, PICTURE_FORMAT, options, name);
      return { buffer: picture.buffer, srcExt: PICTURE_FORMAT, options: scaling };
    },
  };
}
