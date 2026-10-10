import sharp, { type Metadata, type Sharp } from 'sharp';
import type { Raster } from './image-content';
import { maxInputPixels } from './image-input-limits';

/**
 * A PNG that the lossy encoders read more than once is decoded once. The content class (a thumbnail), the check for an
 * opaque alpha plane and the encoder each pull the picture through the PNG decoder, which inflates every row again
 * each time; a PNG cannot be decoded at a reduced size the way a JPEG can, so the thumbnail costs as much as the
 * encoder's own read. Decoded once into memory, the analyses and the encoder read the pixels from there.
 *
 * Only a PNG with nothing besides pixels qualifies, so the pipeline that continues from the decoded pixels writes the
 * very bytes the pipeline from the PNG would: a colour profile, EXIF, XMP, IPTC, a pixel density, text blocks or an
 * orientation would be lost on the way through raw pixels.
 */

/** Largest decoded picture, in bytes, held in memory this way; a larger PNG is still read by the encoder from the PNG. */
export const DECODED_SOURCE_MAX_BYTES = 128 * 1024 * 1024;

const SIXTEEN_BIT_DEPTH = 'ushort';
const EIGHT_BIT_DEPTH = 'uchar';
const BYTES_PER_16_BIT_SAMPLE = 2;
const MAX_8_BIT_SAMPLE = 0xff;
const MAX_16_BIT_SAMPLE = 0xffff;
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
  if (meta.hasProfile || meta.icc !== undefined || meta.exif !== undefined || meta.xmp !== undefined || meta.iptc !== undefined) return false;
  if (meta.comments !== undefined || meta.background !== undefined || meta.tifftagPhotoshop !== undefined) return false;
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

/** True when every `stride`-th sample from `first` is `maximum`; the alpha plane of interleaved samples. */
function everySampleIs(samples: Uint8Array | Uint16Array, first: number, stride: number, maximum: number): boolean {
  for (let at = first; at < samples.length; at += stride) {
    if (samples[at] !== maximum) return false;
  }
  return true;
}

/**
 * The pipeline over the decoded pixels of `pipeline` when its source is a plain PNG, or null when it is not (the caller
 * keeps `pipeline`). The decode runs under the input pixel limit the pipeline was opened with; a decode failure
 * reaches the caller as the library's own error, as it would from the first read of the picture.
 */
export async function decodePlainPngOnce(pipeline: Sharp, maxBytes: number = DECODED_SOURCE_MAX_BYTES): Promise<DecodedPng | null> {
  const meta = await pipeline.metadata();
  if (!isPlainPng(meta, maxBytes)) return null;
  const deep = meta.depth === SIXTEEN_BIT_DEPTH;
  // Written in the colourspace the PNG is in: left to itself the raw output turns a grey picture into three colour bands.
  const { data, info } = await pipeline
    .clone()
    .toColourspace(meta.space)
    .raw({ depth: deep ? SIXTEEN_BIT_DEPTH : EIGHT_BIT_DEPTH })
    .toBuffer({ resolveWithObject: true });
  // The library takes the sample depth of a raw input from the typed array that holds it.
  const samples = deep ? samples16Of(data) : data;
  const alphaIsOpaque = info.channels === 2 || info.channels === 4 ? everySampleIs(samples, info.channels - 1, info.channels, deep ? MAX_16_BIT_SAMPLE : MAX_8_BIT_SAMPLE) : undefined;
  return {
    pipeline: sharp(samples, { raw: { width: info.width, height: info.height, channels: info.channels }, limitInputPixels: maxInputPixels() }),
    alphaIsOpaque,
    raster: { samples, width: info.width, height: info.height, channels: info.channels },
  };
}
