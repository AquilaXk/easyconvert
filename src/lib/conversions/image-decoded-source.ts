import sharp, { type Metadata, type Sharp } from 'sharp';
import { classifyRaster, type ContentClass, type Raster } from './image-content';
import { isSrgbProfile } from './icc-srgb';
import { roundedToEightBits } from './image-depth';
import { maxInputPixels } from './image-input-limits';
import { metadataOf } from './image-metadata';

/**
 * A PNG that the lossy encoders read more than once is decoded once. The content class (a thumbnail), the check for an
 * opaque alpha plane and the encoder each pull the picture through the PNG decoder, which inflates every row again
 * each time; a PNG cannot be decoded at a reduced size the way a JPEG can, so the thumbnail costs as much as the
 * encoder's own read. Decoded once into memory, the analyses and the encoder read the pixels from there.
 *
 * Only a PNG with nothing the output keeps besides pixels qualifies, so the pipeline that continues from the decoded pixels
 * writes the very bytes the pipeline from the PNG would: a colour profile that does something, EXIF, XMP, IPTC, a pixel density
 * or an orientation would be lost on the way through raw pixels. Two things a PNG can hold never reach the output of the encoders
 * that read the decoded pixels (JPEG and AVIF) and do not disqualify it: text chunks (the encoders write no text), and a profile
 * that describes sRGB (it is not written, and converting through it changes no pixel; see `openWithoutSrgbProfile` in image.ts).
 */

/** Largest decoded picture, in bytes, held in memory this way; a larger PNG is still read by the encoder from the PNG. */
export const DECODED_SOURCE_MAX_BYTES = 128 * 1024 * 1024;

const SIXTEEN_BIT_DEPTH = 'ushort';
const EIGHT_BIT_DEPTH = 'uchar';
const BYTES_PER_16_BIT_SAMPLE = 2;
const MAX_8_BIT_SAMPLE = 0xff;
/** Density libvips reports for a PNG that carries none (72 pixels per inch). */
const DEFAULT_DENSITY_PPI = 72;
const UPRIGHT_ORIENTATION = 1;
/** Colourspaces a raw buffer keeps exactly: libvips reads 1 and 2 bands as grey and 3 and 4 as colour. */
const RAW_EXACT_SPACES: ReadonlySet<string> = new Set(['srgb', 'b-w', 'rgb16', 'grey16']);

function decodedBytes(meta: Metadata): number {
  const sampleBytes = meta.depth === SIXTEEN_BIT_DEPTH ? BYTES_PER_16_BIT_SAMPLE : 1;
  return meta.width * meta.height * meta.channels * sampleBytes;
}

/** True when the picture is a plain single-frame PNG small enough to hold decoded. */
export function isPlainPng(meta: Metadata, maxBytes: number = DECODED_SOURCE_MAX_BYTES): boolean {
  if (meta.format !== 'png' || (meta.pages ?? 1) !== 1) return false;
  if (meta.hasProfile && (meta.icc === undefined || !isSrgbProfile(meta.icc))) return false;
  if (meta.exif !== undefined || meta.xmp !== undefined || meta.iptc !== undefined) return false;
  if (meta.background !== undefined || meta.tifftagPhotoshop !== undefined) return false;
  if (meta.density !== undefined && meta.density !== DEFAULT_DENSITY_PPI) return false;
  if (meta.orientation !== undefined && meta.orientation !== UPRIGHT_ORIENTATION) return false;
  if (meta.depth !== EIGHT_BIT_DEPTH && meta.depth !== SIXTEEN_BIT_DEPTH) return false;
  if (!RAW_EXACT_SPACES.has(meta.space)) return false;
  // Converting an 8-bit grey picture to grey for the raw output discards its alpha band.
  if (meta.space === 'b-w' && meta.hasAlpha === true) return false;
  return decodedBytes(meta) <= maxBytes;
}

/** The 16-bit samples of a raw buffer; a typed array needs an even offset, so a buffer that starts on an odd one is copied. */
function samples16Of(data: Buffer): Uint16Array {
  const aligned = data.byteOffset % BYTES_PER_16_BIT_SAMPLE === 0 ? data : Buffer.from(data);
  return new Uint16Array(aligned.buffer, aligned.byteOffset, aligned.length / BYTES_PER_16_BIT_SAMPLE);
}

/** The pipeline over the decoded pixels of a PNG, and what the decode already established about them. */
export interface DecodedPng {
  pipeline: Sharp;
  /**
   * Whether every alpha sample is the maximum (true), some is not (false), or the picture has no alpha plane (undefined).
   * Valid for the pipeline as decoded: a resize can move a sample off the maximum, so it does not describe a resized one.
   */
  alphaIsOpaque: boolean | undefined;
  /** The decoded samples the pipeline reads, for analyses that need no native call. */
  raster: Raster;
}

/** Bytes of a word the scan below reads at a time. */
const WORD_BYTES = 4;

/**
 * True when every alpha sample of interleaved `samples` is the maximum, which is every bit of its bytes set. The alpha samples are
 * the last of a pixel, and a pixel is one word (8-bit colour with alpha, 16-bit grey with alpha) or two (16-bit colour with alpha), so the
 * last word of every pixel is ANDed into one accumulator and its alpha bytes are read at the end: no branch and no early exit per
 * sample, which is 0.15 ms where a loop over the samples took 0.4 to 0.6 ms for a 1 to 1.5 megapixel picture. The accumulator is read
 * back through a byte view, so the bytes are in memory order whatever the byte order of the machine is.
 */
export function alphaIsOpaquePlane(samples: Uint8Array | Uint16Array, channels: number): boolean {
  const sampleBytes = samples.BYTES_PER_ELEMENT;
  const pixelBytes = channels * sampleBytes;
  if (pixelBytes % WORD_BYTES !== 0) throw new RangeError(`a pixel of ${pixelBytes} bytes is not a whole number of words`);
  // A typed array of words starts on a word; the decoded buffers do, a copy is made for one that does not.
  const bytesOf = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const aligned = samples.byteOffset % WORD_BYTES === 0 ? bytesOf : new Uint8Array(bytesOf);
  const words = new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / WORD_BYTES);
  const wordsPerPixel = pixelBytes / WORD_BYTES;
  let all = -1;
  for (let at = wordsPerPixel - 1; at < words.length; at += wordsPerPixel) all &= words[at];
  const accumulated = new Uint32Array(1);
  accumulated[0] = all;
  const bytes = new Uint8Array(accumulated.buffer);
  for (let at = WORD_BYTES - sampleBytes; at < WORD_BYTES; at += 1) {
    if (bytes[at] !== MAX_8_BIT_SAMPLE) return false;
  }
  return true;
}

/**
 * The pipeline over the decoded pixels of `pipeline` when its source is a plain PNG, or null when it is not (the caller
 * keeps `pipeline`). The decode runs under the input pixel limit the pipeline was opened with; a decode failure
 * reaches the caller as the library's own error, as it would from the first read of the picture.
 *
 * An encoder that writes 8 bits per sample (`eightBit`) is given a 16-bit colour picture reduced to 8 bits by the decode
 * itself, to the nearest level of every sample (see image-depth.ts), which is what the encoder would take from the 16-bit
 * samples: the samples held are half as many bytes, the alpha check reads bytes, and the encoder has no reduction left to do. A grey picture keeps its
 * 16 bits (the library's grey reduction is not the high byte, and drops a grey picture's alpha band).
 *
 * `onPlain` is called with the picture's metadata once the picture qualifies and before it is decoded, for work that can run
 * while the decode does (an encoder that reads the source file, see image-avif-direct.ts).
 */
export async function decodePlainPngOnce(
  pipeline: Sharp,
  maxBytes: number = DECODED_SOURCE_MAX_BYTES,
  eightBit = false,
  onPlain?: (meta: Metadata) => Promise<void>
): Promise<DecodedPng | null> {
  const meta = await metadataOf(pipeline);
  if (!isPlainPng(meta, maxBytes)) return null;
  await onPlain?.(meta);
  const deep = meta.depth === SIXTEEN_BIT_DEPTH;
  const narrow = deep && eightBit && meta.space === 'rgb16';
  // Written in the colourspace the PNG is in: left to itself the raw output turns a grey picture into three colour bands.
  // The raw output carries no profile, and the decode must not convert the samples through an sRGB profile the PNG holds.
  const decoder = meta.hasProfile ? pipeline.clone().keepIccProfile() : pipeline.clone();
  const { data, info } = await (narrow ? roundedToEightBits(decoder, meta.channels) : decoder)
    .toColourspace(narrow ? 'srgb' : meta.space)
    .raw({ depth: deep && !narrow ? SIXTEEN_BIT_DEPTH : EIGHT_BIT_DEPTH })
    .toBuffer({ resolveWithObject: true });
  // The library takes the sample depth of a raw input from the typed array that holds it.
  const wide = deep && !narrow;
  const samples = wide ? samples16Of(data) : data;
  const alphaIsOpaque = info.channels === 2 || info.channels === 4 ? alphaIsOpaquePlane(samples, info.channels) : undefined;
  return {
    pipeline: sharp(samples, { raw: { width: info.width, height: info.height, channels: info.channels }, limitInputPixels: maxInputPixels() }),
    alphaIsOpaque,
    raster: { samples, width: info.width, height: info.height, channels: info.channels },
  };
}

/** What `decodePlainPngForTarget` hands on: the decoded picture, and the content class of its 16-bit samples when it was decoded twice. */
export interface DecodedForTarget extends DecodedPng {
  content?: ContentClass;
}

const JPEG_TARGETS: ReadonlySet<string> = new Set(['jpg', 'jpeg']);
const RGBA_CHANNELS = 4;

/**
 * `decodePlainPngOnce` for the encoder of `fmt`. An 8-bit encoder is given a 16-bit colour picture reduced to 8 bits by the decode
 * when the pixels change before the encode (`changesPixels`: a resize or a background to flatten onto work on the 8-bit levels).
 * Otherwise a JPEG is written from the 16-bit samples, which the content class reads: the tones of a continuous-tone picture
 * (a night sky, a radiograph) tell it from a graphic, and on 8 bits they are gone. A picture with a translucent sample is flattened
 * on 8 bits all the same: it is decoded again reduced, and keeps the content class of its 16-bit samples.
 */
export async function decodePlainPngForTarget(
  pipeline: Sharp,
  fmt: string,
  changesPixels: boolean,
  onPlain: ((meta: Metadata) => Promise<void>) | undefined
): Promise<DecodedForTarget | null> {
  const isJpeg = JPEG_TARGETS.has(fmt);
  const decoded = await decodePlainPngOnce(pipeline, undefined, isJpeg && changesPixels, onPlain);
  const translucentColour = decoded !== null && decoded.alphaIsOpaque === false && decoded.raster.channels === RGBA_CHANNELS && decoded.raster.samples instanceof Uint16Array;
  if (decoded === null || !isJpeg || changesPixels || !translucentColour) return decoded;
  const content = classifyRaster(decoded.raster);
  const reduced = await decodePlainPngOnce(pipeline, undefined, true);
  return reduced === null ? null : { ...reduced, content };
}
