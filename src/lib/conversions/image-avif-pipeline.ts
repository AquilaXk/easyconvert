import type { Sharp } from 'sharp';
import type { ConversionOptions } from '../types';
import { AVIF_ENCODER_LIBRARY_CLI, encodeAvifWithCli, findAvifenc, type AvifCicp } from './avif-cli';
import { CICP_MATRIX_BT2020_NCL, CICP_PRIMARIES_BT2020, CICP_TRANSFER_PQ } from './cicp';
import { withoutOpaqueAlpha, type ContentClass } from './image-content';
import type { DirectAvifSlot } from './image-avif-direct';
import {
  AVIF_CLI_MAX_PIXELS,
  AVIF_HDR_BITDEPTH,
  type AvifEncoder,
  avifEncoderFor,
  avifLibraryOptionsOf,
  avifPolicyFor,
  avifSourceBitsOf,
} from './image-encoder-defaults';
import { SHARP_SIXTEEN_BIT_DEPTH } from './image-depth';
import { resizedDimensions } from './image-input-limits';
import { metadataOf } from './image-metadata';
import { FIRST_QUARTER_TURN_ORIENTATION } from './image-orientation';
import { withImageThreads } from './image-threads';

/** Deflate level of the PNG handed to the AVIF encoder: it is read once and thrown away, so it is written stored (level 0) and the encoder reads it back at memory speed. */
const AVIFENC_INPUT_PNG_COMPRESSION = 0;
/** Colour tags of an HDR AVIF: BT.2020 primaries, PQ transfer and the matching BT.2020 matrix. */
export const PQ_AVIF_CICP: AvifCicp = { primaries: CICP_PRIMARIES_BT2020, transfer: CICP_TRANSFER_PQ, matrix: CICP_MATRIX_BT2020_NCL };

/** What `encodeAvifFromPipeline` returns: the file and the encoder that wrote it. */
export interface EncodedAvif {
  buffer: Buffer;
  encoder: AvifEncoder;
}

/** The pipeline in the colourspace the AVIF encoder is handed: grey stays one band, a deep picture stays 16-bit. */
function pngRasterOf(opaque: Sharp, grey: boolean, deep: boolean): Sharp {
  if (grey) return opaque.toColourspace(deep ? 'grey16' : 'b-w');
  return deep ? opaque.toColourspace('rgb16') : opaque;
}

/**
 * AVIF from the pipeline: pictures with more than 8 bits per sample are encoded at 10 bits (a source of 9 or 10 bits) or 12 bits
 * (more; the 8-bit path would cap the result near 51 dB PSNR whatever the quality), and an alpha channel
 * that is fully opaque is dropped instead of encoded as a second plane. The reference library's encoder writes the
 * file when it is installed (grey sources as monochrome); without it the image library does.
 */
async function encodeAvifFromPipeline(
  pipeline: Sharp,
  options: ConversionOptions,
  contentOf: ContentClass | Promise<ContentClass>,
  keepsGrey: boolean,
  cicp: AvifCicp | undefined,
  alphaIsOpaque: boolean | undefined
): Promise<EncodedAvif> {
  const source = await metadataOf(pipeline);
  const deep = source.depth === SHARP_SIXTEEN_BIT_DEPTH;
  const opaque = await withoutOpaqueAlpha(pipeline, alphaIsOpaque);
  // The metadata describes the input; the encoder sees the upright, resized picture.
  const swapsSides = (source.orientation ?? 1) >= FIRST_QUARTER_TURN_ORIENTATION;
  const upright = swapsSides ? { width: source.height ?? 0, height: source.width ?? 0 } : { width: source.width ?? 0, height: source.height ?? 0 };
  const target = resizedDimensions(upright.width, upright.height, options);
  const grey = (source.space === 'b-w' || source.space === 'grey16') && keepsGrey;
  const avifenc = await findAvifenc();
  const pixels = target.width * target.height;
  const raster = pngRasterOf(opaque, grey, deep);
  // An HDR picture (tagged by CICP) keeps its own route; an untagged deep photograph goes to the command-line encoder
  // whatever its content, so the PNG the encoder reads is written while the content class is still being found.
  const toCommandLine = avifenc !== null && deep && cicp === undefined && pixels <= AVIF_CLI_MAX_PIXELS;
  const pendingPng = toCommandLine ? raster.png({ compressionLevel: AVIFENC_INPUT_PNG_COMPRESSION }).toBuffer() : null;
  const [content, speculativePng] = await Promise.all([contentOf, pendingPng]);
  const encoder = avifEncoderFor(content, grey, pixels, avifenc !== null, deep && cicp === undefined);
  // The bits per sample the source holds (the library reports every depth above 8 as 16-bit); an HDR rendition is delivered at 10.
  const sourceBits = avifSourceBitsOf(deep, source.bitsPerSample);
  const policy = avifPolicyFor(options.quality, content, pixels, cicp === undefined ? sourceBits : Math.min(sourceBits, AVIF_HDR_BITDEPTH), grey, encoder);
  if (avifenc !== null && encoder === AVIF_ENCODER_LIBRARY_CLI) {
    const png = speculativePng ?? (await raster.png({ compressionLevel: AVIFENC_INPUT_PNG_COMPRESSION }).toBuffer());
    const buffer = await encodeAvifWithCli(avifenc, {
      png,
      width: target.width,
      height: target.height,
      quality: policy.quality,
      effort: policy.effort,
      bitdepth: policy.bitdepth,
      layout: policy.layout,
      tune: policy.tune,
      cicp,
      signal: options.signal,
    });
    return { buffer, encoder };
  }
  const prepared = deep ? opaque.toColourspace(grey ? 'grey16' : 'rgb16') : opaque;
  const encode = (): Promise<Buffer> => prepared.avif(avifLibraryOptionsOf(policy)).toBuffer();
  // A photograph is encoded on threads in one tile (the worker's libvips leaves the encoder's auto-tiles off), so its file is the same on any
  // count from two up. An interface stays on one thread: when threads still split the picture into tiles it went from -14.4% to +1.6%
  // BD-rate in PSNR, past the allowance, and it has not been measured on threads in one tile.
  return { buffer: content === 'photo' ? await withImageThreads(encode) : await encode(), encoder };
}

/** What `encodeAvif` needs to write the AVIF of a pipeline. */
export interface AvifJob {
  pipeline: Sharp;
  options: ConversionOptions;
  contentOf: ContentClass | Promise<ContentClass>;
  keepsGrey: boolean;
  cicp: AvifCicp | undefined;
  alphaIsOpaque: boolean | undefined;
  directAvif: DirectAvifSlot;
}

/** The AVIF an encoder already reading the source file wrote, else the one `encodeAvifFromPipeline` writes from the decoded pixels. */
export async function encodeAvif(job: AvifJob): Promise<EncodedAvif> {
  const fromSource = await job.directAvif.finish(job.contentOf);
  if (fromSource !== null) return { buffer: fromSource, encoder: AVIF_ENCODER_LIBRARY_CLI };
  return encodeAvifFromPipeline(job.pipeline, job.options, job.contentOf, job.keepsGrey, job.cicp, job.alphaIsOpaque);
}

