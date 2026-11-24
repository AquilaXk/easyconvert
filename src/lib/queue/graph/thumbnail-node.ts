import fs from 'node:fs';
import { getFormatByExtension } from '../../registry';
import { UnsupportedOptionError, type ConversionOptions } from '../../types';
import type { ConversionEnginePort, VfsPayload } from '../engine-port';

/** The longest edge of a thumbnail that names no width or height. */
export const DEFAULT_THUMBNAIL_EDGE_PX = 256;
/** The frame a video thumbnail shows when the task names no time: past the black frames many clips open with. */
const DEFAULT_FRAME_TIME = '00:00:01.000';
const VIDEO_CATEGORY = 'video';
const IMAGE_CATEGORY = 'image';
const PICTURE_FORMAT = 'png';
/** Seconds (`3`, `1.5`) or a clock time (`00:00:03.250`, `1:03`): what ffmpeg takes after `-ss` without an option, a sign or a unit. */
const FRAME_TIME = /^(?:\d{1,5}(?:\.\d{1,6})?|(?:\d{1,2}:)?\d{1,2}:\d{1,2}(?:\.\d{1,6})?)$/;
const MIN_EDGE_PX = 16;
const MAX_EDGE_PX = 7680;

/** What a thumbnail node asks of the engine for one input. */
export interface ThumbnailSource {
  payload: Buffer | VfsPayload;
  srcExt: string;
  /** The options of the conversion to the target. */
  options: ConversionOptions;
  tempFilePaths?: string[];
}

export interface ThumbnailPlan {
  /** The picture of `input` that the target conversion reads, and the options of that conversion. */
  prepare(input: { payload: Buffer | VfsPayload; srcExt: string; name: string }): Promise<ThumbnailSource>;
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
  if (frames[0] !== undefined && !FRAME_TIME.test(frames[0])) {
    throw new UnsupportedOptionError('"thumbnail.at" takes seconds (3 or 1.5) or a time (00:00:03.250).');
  }
  for (const [name, edge] of [['width', thumbnail?.width], ['height', thumbnail?.height]] as const) {
    if (edge !== undefined && !(Number.isInteger(edge) && edge >= MIN_EDGE_PX && edge <= MAX_EDGE_PX)) {
      throw new UnsupportedOptionError(`"thumbnail.${name}" takes a whole number from ${MIN_EDGE_PX} to ${MAX_EDGE_PX}.`);
    }
  }
  const scaling: ConversionOptions = {
    width: thumbnail?.width ?? DEFAULT_THUMBNAIL_EDGE_PX,
    height: thumbnail?.height ?? DEFAULT_THUMBNAIL_EDGE_PX,
    fit: thumbnail?.fit ?? 'inside',
  };
  return {
    async prepare({ payload, srcExt, name }) {
      const category = getFormatByExtension(srcExt)?.category;
      if (category === IMAGE_CATEGORY) {
        return { payload, srcExt, options: { ...scaling, page: thumbnail?.page, multiPageOutput: 'first' } };
      }
      const options: ConversionOptions =
        category === VIDEO_CATEGORY
          ? { thumbnail: { at: [frames[0] ?? DEFAULT_FRAME_TIME], format: PICTURE_FORMAT, accurate: thumbnail?.accurate }, signal }
          : { page: thumbnail?.page, multiPageOutput: 'first', signal };
      const picture = await engine.convert(payload, srcExt, PICTURE_FORMAT, options, name);
      const hasFile = Boolean(picture.filePath && fs.existsSync(picture.filePath));
      return {
        payload: hasFile ? { inputPath: picture.filePath! } : picture.buffer,
        srcExt: PICTURE_FORMAT,
        options: scaling,
        tempFilePaths: picture.filePath ? [picture.filePath] : undefined,
      };
    },
  };
}
