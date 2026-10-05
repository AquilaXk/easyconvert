import sharp from 'sharp';
import { ConversionFailedError, InvalidPageRangeError } from '../types';

/**
 * Frame selection for multi-frame image sources (animated GIF and WebP, APNG).
 *
 * Policy (documented default): a source with more than one frame is never silently reduced to its first
 * frame.
 *  - Animated targets (gif, webp) keep every frame, the per-frame delays and the loop count.
 *  - Any other target needs the explicit `page` option (1-based frame number). Without it the conversion
 *    throws a ConversionFailedError that names the frame count and the option.
 *  - `page` always selects one frame, also for an animated target (the result is then a still image).
 */

/** Targets whose container can hold an animation. */
export const ANIMATED_IMAGE_TARGETS: ReadonlySet<string> = new Set(['gif', 'webp']);

/** Source formats libvips reads as several frames (reported through `pages`). */
const FRAME_SEQUENCE_SOURCE_FORMATS: ReadonlySet<string> = new Set(['gif', 'webp']);

const SINGLE_FRAME = 1;
const EXIF_ORIENTATION_NORMAL = 1;

const PNG_FORMAT = 'png';
const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const PNG_CHUNK_HEADER_BYTES = 8;
const PNG_CHUNK_TYPE_OFFSET = 4;
const PNG_ACTL_MIN_LENGTH = 4;
const PNG_CHUNK_ANIMATION_CONTROL = 'acTL';
const PNG_CHUNKS_ENDING_ANIMATION_CONTROL: ReadonlySet<string> = new Set(['IDAT', 'IEND']);

export interface FrameSelection {
  /** sharp input options that decode exactly the frames the conversion keeps. */
  input: sharp.SharpOptions;
  /** True when every frame of a multi-frame source is kept, which only animated targets can hold. */
  keepsAnimation: boolean;
}

/**
 * Reads the frame count from an APNG `acTL` chunk, which must precede the first IDAT.
 * Returns 1 for a plain PNG. libvips decodes only the default image of an APNG.
 */
function countApngFrames(buffer: Buffer): number {
  let pos = PNG_SIGNATURE_BYTES;
  while (pos + PNG_CHUNK_OVERHEAD_BYTES <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('latin1', pos + PNG_CHUNK_TYPE_OFFSET, pos + PNG_CHUNK_HEADER_BYTES);
    if (type === PNG_CHUNK_ANIMATION_CONTROL && length >= PNG_ACTL_MIN_LENGTH) {
      return buffer.readUInt32BE(pos + PNG_CHUNK_HEADER_BYTES);
    }
    if (PNG_CHUNKS_ENDING_ANIMATION_CONTROL.has(type)) return SINGLE_FRAME;
    pos += PNG_CHUNK_OVERHEAD_BYTES + length;
  }
  return SINGLE_FRAME;
}

function frameCountOf(buffer: Buffer, meta: sharp.Metadata): number {
  if (meta.format !== undefined && FRAME_SEQUENCE_SOURCE_FORMATS.has(meta.format)) {
    return meta.pages ?? SINGLE_FRAME;
  }
  return meta.format === PNG_FORMAT ? countApngFrames(buffer) : SINGLE_FRAME;
}

function parsePage(page: number | string, frames: number): number {
  const requested = Number(page);
  if (!Number.isInteger(requested) || requested < 1 || requested > frames) {
    throw new InvalidPageRangeError(`Frame ${String(page)} is out of range: the image has ${frames} frames (1-${frames})`);
  }
  return requested;
}

/**
 * Decides which frames of `buffer` the conversion to `targetFormat` decodes. Single-frame sources are
 * returned untouched (`page` is not interpreted for them).
 */
export async function selectFrames(
  buffer: Buffer,
  targetFormat: string,
  page: number | string | undefined
): Promise<FrameSelection> {
  const meta = await sharp(buffer).metadata();
  const frames = frameCountOf(buffer, meta);
  if (frames <= SINGLE_FRAME) return { input: {}, keepsAnimation: false };

  const isApng = meta.format === PNG_FORMAT;

  if (page !== undefined) {
    const requested = parsePage(page, frames);
    if (isApng) {
      if (requested !== SINGLE_FRAME) {
        throw new ConversionFailedError(
          `Frame ${requested} of this animated PNG cannot be decoded: only its default image (frame 1) is readable`
        );
      }
      return { input: {}, keepsAnimation: false };
    }
    return { input: { page: requested - 1 }, keepsAnimation: false };
  }

  if (ANIMATED_IMAGE_TARGETS.has(targetFormat)) {
    if (isApng) {
      throw new ConversionFailedError(
        `This animated PNG has ${frames} frames and only its default image is readable, so its animation cannot be converted to .${targetFormat}`
      );
    }
    if (meta.orientation !== undefined && meta.orientation !== EXIF_ORIENTATION_NORMAL) {
      throw new ConversionFailedError(
        `This ${frames}-frame image carries EXIF orientation ${meta.orientation}, which cannot be applied to every frame of an animation; set the "page" option to convert a single oriented frame`
      );
    }
    return { input: { animated: true }, keepsAnimation: true };
  }

  throw new ConversionFailedError(
    `This image has ${frames} frames but .${targetFormat} holds a single image: set the "page" option to a frame number (1-${frames}), or convert to an animated target (gif, webp)`
  );
}
