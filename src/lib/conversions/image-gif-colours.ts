import sharp, { type Sharp } from 'sharp';
import type { ConversionOptions } from '../types';
import { QUANT_ALPHA_THRESHOLD, quantizeImageAsync } from './color-quantizer';
import { encodeGif, GIF_MAX_COLORS, type GifImage } from './gif-writer';
import { metadataOf } from './image-metadata';
import { QUANTIZER_PIXEL_BUDGET } from './image-input-limits';
import { rgbaRaster } from './image-rgba-raster';
import { QUANTIZR_DITHER_LEVEL, QUANTIZR_MAX_PIXELS, quantizePixels, type IndexedPicture } from './png-palette-quantizer';

/**
 * GIFs of a request for fewer than 256 colours whose count the image library cannot write. Its GIF writer takes `colors` only as a bit
 * depth (1, 2, 4 or 8 bits), so 3 colours write 4 entries, 5 to 16 write 16 and 17 to 255 write 256, and an animation written below 8 bits
 * puts the transparent index of a frame past the end of its table (a table of 2 entries with the index 3). Here the picture is first reduced
 * to the colour count (quantizr-pixels, the Oklab quantizer where the program is missing, fails or is past its bound), and the image
 * library or our writer only writes the indices (entry 368 of docs/policy-decisions.md). A pixel is transparent when its alpha is below 128,
 * and the transparent entry is one of the colours asked for.
 */

/** The colour counts the image library writes as asked: its 1, 2, 4 and 8 bit depths. */
const LIBRARY_COLOUR_COUNTS: ReadonlySet<number> = new Set([2, 4, 16, GIF_MAX_COLORS]);

const RGBA_CHANNELS = 4;
const RGB_CHANNELS = 3;
const ALPHA_OFFSET = 3;
const OPAQUE = 255;
const BYTE_BITS = 8;
const MIN_COLOURS = 2;

export interface GifColourRequest {
  /** The most colours of the picture, the transparent entry included (3 to 255 here). */
  colours: number;
  /** Whether the quantizer dithers (the request's default). */
  dither: boolean;
  /**
   * The picture is a frame of an animation whose writer differences it from the one before: an opaque frame then needs one more table entry,
   * the transparent index of the pixels that did not change, so the picture keeps one colour less (not below 2).
   */
  differenced?: boolean;
  signal?: AbortSignal;
}

/** Whether the image library's GIF writer writes exactly `colours` colours for a still picture; the other counts need `encodeExactColourGif`. */
export function libraryWritesColours(colours: number): boolean {
  return LIBRARY_COLOUR_COUNTS.has(colours);
}

/** Alpha of every pixel made 0 (with its colour cleared, so that the transparent pixels are one colour) or 255, in place; whether any pixel is transparent. */
function thresholdAlpha(rgba: Buffer): boolean {
  let transparent = false;
  for (let at = ALPHA_OFFSET; at < rgba.length; at += RGBA_CHANNELS) {
    if (rgba[at] < QUANT_ALPHA_THRESHOLD) {
      rgba.fill(0, at - ALPHA_OFFSET, at + 1);
      transparent = true;
    } else {
      rgba[at] = OPAQUE;
    }
  }
  return transparent;
}

/** The GIF image of the program's answer: its RGBA palette as RGB, the first entry that is not opaque being the transparent index. */
function gifImageOf(picture: IndexedPicture): GifImage {
  const paletteSize = picture.palette.length / RGBA_CHANNELS;
  const palette = new Uint8Array(paletteSize * RGB_CHANNELS);
  let transparentIndex = -1;
  for (let entry = 0; entry < paletteSize; entry += 1) {
    palette.set(picture.palette.subarray(entry * RGBA_CHANNELS, entry * RGBA_CHANNELS + RGB_CHANNELS), entry * RGB_CHANNELS);
    if (transparentIndex < 0 && picture.palette[entry * RGBA_CHANNELS + ALPHA_OFFSET] < QUANT_ALPHA_THRESHOLD) transparentIndex = entry;
  }
  return { width: picture.width, height: picture.height, palette, paletteSize, indices: picture.indices, transparentIndex };
}

/**
 * The picture reduced to `request.colours` colours. The program's palette and (at 0.25) dithering are used where the program answers; the
 * Oklab quantizer answers otherwise, undithered past its dithering bound. `rgba` is overwritten (alpha to 0 or 255).
 */
export async function quantizeGifPicture(rgba: Buffer, width: number, height: number, request: GifColourRequest): Promise<GifImage> {
  const transparent = thresholdAlpha(rgba);
  const colours = request.differenced && !transparent && request.colours > MIN_COLOURS ? request.colours - 1 : request.colours;
  const pixels = width * height;
  if (pixels <= QUANTIZR_MAX_PIXELS) {
    const picture = await quantizePixels(rgba, width, height, { colours, dither: request.dither ? QUANTIZR_DITHER_LEVEL : 0, signal: request.signal });
    if (picture !== null) return gifImageOf(picture);
  }
  const dither = request.dither && pixels <= QUANTIZER_PIXEL_BUDGET.maxPixels ? 'floyd-steinberg' : 'none';
  const indexed = await quantizeImageAsync(rgba, width, height, colours, { dither, transparency: 'threshold', signal: request.signal });
  return { width, height, ...indexed };
}

/** A still picture of the pipeline written with exactly the colours asked for (see the top of the file); its pixel budget is checked by the caller. */
export async function encodeExactColourGif(pipeline: Sharp, options: ConversionOptions, colours: number): Promise<Buffer> {
  const { data, info } = await rgbaRaster(pipeline);
  return encodeGif(await quantizeGifPicture(data, info.width, info.height, { colours, dither: options.dither !== false, signal: options.signal }));
}

/** The RGBA pixels of an indexed picture (little-endian hosts: one 32-bit word a pixel). */
function rasterOfPicture(image: GifImage): Buffer {
  const lookup = new Uint32Array(1 << BYTE_BITS);
  for (let entry = 0; entry < image.paletteSize; entry += 1) {
    const at = entry * RGB_CHANNELS;
    const alpha = entry === image.transparentIndex ? 0 : OPAQUE;
    lookup[entry] = (image.palette[at] | (image.palette[at + 1] << 8) | (image.palette[at + 2] << 16) | (alpha << 24)) >>> 0;
  }
  const words = new Uint32Array(image.indices.length);
  for (let pixel = 0; pixel < words.length; pixel += 1) words[pixel] = lookup[image.indices[pixel]];
  return Buffer.from(words.buffer);
}

/**
 * The frames of an animation, stacked from top to bottom, reduced to `request.colours` colours as RGBA. They share one palette when the
 * stack is within the dithering bound of the Oklab quantizer (the displayed colours then never exceed the count, whatever the writer
 * leaves of the previous frame), and have one each beyond it. `stack` is overwritten.
 */
export async function quantizeGifFrames(
  stack: Buffer,
  width: number,
  frameHeight: number,
  frames: number,
  request: GifColourRequest,
  sharedPaletteMaxPixels: number = QUANTIZER_PIXEL_BUDGET.maxPixels
): Promise<Buffer> {
  if (width * frameHeight * frames <= sharedPaletteMaxPixels) {
    return rasterOfPicture(await quantizeGifPicture(stack, width, frameHeight * frames, request));
  }
  const frameBytes = width * frameHeight * RGBA_CHANNELS;
  const out = Buffer.alloc(stack.length);
  for (let frame = 0; frame < frames; frame += 1) {
    const slice = stack.subarray(frame * frameBytes, (frame + 1) * frameBytes);
    out.set(rasterOfPicture(await quantizeGifPicture(slice, width, frameHeight, request)), frame * frameBytes);
  }
  return out;
}

/**
 * The animation of the pipeline (its frames stacked, as the image library holds them) with at most `colours` colours. The image library
 * writes the frames, with the delays and the loop count of the source and its frame differencing, from pixels that already hold no more
 * colours than asked.
 */
export async function encodeColourLimitedAnimation(pipeline: Sharp, options: ConversionOptions, colours: number): Promise<Buffer> {
  const header = await metadataOf(pipeline);
  const { data, info } = await rgbaRaster(pipeline);
  const frameHeight = info.pageHeight ?? info.height;
  const frames = info.height / frameHeight;
  const stack = await quantizeGifFrames(data, info.width, frameHeight, frames, { colours, dither: options.dither !== false, differenced: frames > 1, signal: options.signal });
  return sharp(stack, { raw: { width: info.width, height: info.height, channels: RGBA_CHANNELS, pageHeight: frameHeight } })
    .gif({ dither: 0, delay: header.delay, loop: header.loop })
    .toBuffer();
}
