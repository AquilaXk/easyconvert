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
 * writes the very bytes the pipeline from the PNG would: a colour profile that does something, EXIF, IPTC, a pixel density
 * or an orientation would be lost on the way through raw pixels. Four things a PNG can hold do not disqualify it: text chunks
 * (the encoders write no text), a profile that describes sRGB (it is not written, and converting through it changes no pixel; see
 * `openWithoutSrgbProfile` in image.ts), a background colour (no encoder of the route uses it) and an XMP packet, which the decoded
 * pipeline writes again from its text (`withXmp`, byte for byte when the packet is UTF-8, which `carriesXmp` checks). A print density
 * qualifies the picture for an encoder that writes none (`ignoresDensity`: AVIF), and for one that writes it (JPEG) when the file states
 * it exactly (`pngDensityDpi`: the library reports it rounded, the file's pixels per metre give the figure it would write). When the
 * request strips metadata the output carries no block at all, and neither the packet nor the density matters.
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

/** Whether an XMP packet is text that the decoded pipeline writes again exactly: UTF-8 that survives a round trip through a string. */
function carriesXmp(xmp: Buffer): boolean {
  return Buffer.from(xmp.toString('utf8'), 'utf8').equals(xmp);
}

const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const PNG_DENSITY_UNIT_METRE = 1;
const INCHES_PER_METRE = 39.37007874015748;

/**
 * The print density a PNG states, in dots per inch as its pixels per metre give it (the chunk comes before the data, so only the
 * chunks up to the first data chunk are read): the figure the image library writes into a JPEG made from it. Undefined for a file that
 * states none, states only an aspect ratio (unit 0) or states different densities for the two axes.
 */
export function pngDensityDpi(png: Buffer): number | undefined {
  for (let at = PNG_SIGNATURE_BYTES; at + PNG_CHUNK_OVERHEAD_BYTES <= png.length; at += PNG_CHUNK_OVERHEAD_BYTES + png.readUInt32BE(at)) {
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') return undefined;
    if (type !== 'pHYs') continue;
    const [perMetreX, perMetreY, unit] = [png.readUInt32BE(at + 8), png.readUInt32BE(at + 12), png[at + 16]];
    return unit === PNG_DENSITY_UNIT_METRE && perMetreX === perMetreY ? perMetreX / INCHES_PER_METRE : undefined;
  }
  return undefined;
}

/** What the output of the encoder does with the blocks of a PNG that the decoded pipeline can write again. */
export interface BlockHandling {
  /** The request strips metadata: the output carries no block. */
  strips: boolean;
  /** The encoder writes no print density (an AVIF holds none). */
  ignoresDensity: boolean;
  /** The density the file states, in dots per inch (see `pngDensityDpi`); it must round to the one the library reports. */
  exactDensity?: number;
}

/** No block is written again: the decoded route is for a PNG that holds none that matters. */
const NO_BLOCKS_CARRIED: BlockHandling = { strips: false, ignoresDensity: false };

/** True when the picture is a plain single-frame PNG small enough to hold decoded, given what the encoder does with its blocks. */
export function isPlainPng(meta: Metadata, maxBytes: number = DECODED_SOURCE_MAX_BYTES, blocks: BlockHandling = NO_BLOCKS_CARRIED): boolean {
  if (meta.format !== 'png' || (meta.pages ?? 1) !== 1) return false;
  if (meta.hasProfile && (meta.icc === undefined || !isSrgbProfile(meta.icc))) return false;
  if (meta.exif !== undefined || meta.iptc !== undefined || meta.tifftagPhotoshop !== undefined) return false;
  if (!blocks.strips && meta.xmp !== undefined && !carriesXmp(meta.xmp)) return false;
  const statesDensity = meta.density !== undefined && meta.density !== DEFAULT_DENSITY_PPI;
  const densityCarried = blocks.strips || blocks.ignoresDensity || (blocks.exactDensity !== undefined && Math.round(blocks.exactDensity) === meta.density);
  if (statesDensity && !densityCarried) return false;
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

/** The blocks the output of the PNG route would carry, written again by the decoded pipeline: the XMP packet, and the print density when the encoder writes one. */
function carriedBlocks(decoded: Sharp, meta: Metadata, blocks: BlockHandling): Sharp {
  if (blocks.strips) return decoded;
  const withXmp = meta.xmp === undefined ? decoded : decoded.withXmp(meta.xmp.toString('utf8'));
  const writesDensity = !blocks.ignoresDensity && blocks.exactDensity !== undefined && meta.density !== undefined && meta.density !== DEFAULT_DENSITY_PPI;
  return writesDensity ? withXmp.withDensity(blocks.exactDensity as number) : withXmp;
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
 * while the decode does (an encoder that reads the source file, see image-avif-direct.ts). `blocks` says what the encoder does with the
 * blocks of the PNG (see `BlockHandling`).
 */
export async function decodePlainPngOnce(
  pipeline: Sharp,
  maxBytes: number = DECODED_SOURCE_MAX_BYTES,
  eightBit = false,
  onPlain?: (meta: Metadata) => Promise<void>,
  blocks: BlockHandling = NO_BLOCKS_CARRIED
): Promise<DecodedPng | null> {
  const meta = await metadataOf(pipeline);
  if (!isPlainPng(meta, maxBytes, blocks)) return null;
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
  const alphaIsOpaque = info.channels === 2 || info.channels === 4 ? everySampleIs(samples, info.channels - 1, info.channels, wide ? MAX_16_BIT_SAMPLE : MAX_8_BIT_SAMPLE) : undefined;
  return {
    pipeline: carriedBlocks(sharp(samples, { raw: { width: info.width, height: info.height, channels: info.channels }, limitInputPixels: maxInputPixels() }), meta, blocks),
    alphaIsOpaque,
    raster: { samples, width: info.width, height: info.height, channels: info.channels },
  };
}

/** What `decodePlainPngForTarget` hands on: the decoded picture, and the content class of its 16-bit samples when it was decoded twice. */
export interface DecodedForTarget extends DecodedPng {
  content?: ContentClass;
}

const JPEG_TARGETS: ReadonlySet<string> = new Set(['jpg', 'jpeg']);
/** Targets whose files carry no print density: an AVIF holds none, and its viewers ignore it. */
const DENSITY_FREE_TARGETS: ReadonlySet<string> = new Set(['avif']);
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
  source: Buffer,
  target: { fmt: string; changesPixels: boolean; stripsMetadata: boolean },
  onPlain: ((meta: Metadata) => Promise<void>) | undefined
): Promise<DecodedForTarget | null> {
  const { fmt, changesPixels } = target;
  const isJpeg = JPEG_TARGETS.has(fmt);
  const blocks: BlockHandling = { strips: target.stripsMetadata, ignoresDensity: DENSITY_FREE_TARGETS.has(fmt), exactDensity: pngDensityDpi(source) };
  const decoded = await decodePlainPngOnce(pipeline, undefined, isJpeg && changesPixels, onPlain, blocks);
  if (decoded === null || !isJpeg || changesPixels) return decoded;
  const translucentColour = decoded.alphaIsOpaque === false && decoded.raster.channels === RGBA_CHANNELS && decoded.raster.samples instanceof Uint16Array;
  if (!translucentColour) return decoded;
  const content = classifyRaster(decoded.raster);
  const reduced = await decodePlainPngOnce(pipeline, undefined, true, undefined, blocks);
  return reduced === null ? null : { ...reduced, content };
}
