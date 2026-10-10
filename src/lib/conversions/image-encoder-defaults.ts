import type { AvifOptions, JpegOptions, WebpOptions } from 'sharp';
import type { ContentClass } from './image-content';

/**
 * Per-codec encoder defaults. One `quality` number means a different thing to each codec, so each has its own
 * default and its own rules for chroma, effort and tuning. An explicit `quality` in the request overrides the
 * default quality only; the other choices still follow the picture. Measured against the reference encoders with
 * `npm run bench:quality` (see bench/README.md).
 */

/** Quality a request that names none gets, per codec. */
export const DEFAULT_QUALITY_BY_CODEC = {
  jpeg: 85,
  webp: 80,
  avif: 60,
} as const;

/** Quality used by the targets that have no entry above (Ultra HDR, animated frames). */
export const FALLBACK_QUALITY = 85;

export const QUALITY_MIN = 1;
export const QUALITY_MAX = 100;

/** JPEG at or above this quality keeps full-resolution chroma; below it 4:2:0 saves bytes on photographs. */
export const JPEG_FULL_CHROMA_QUALITY = 90;
/** AVIF at or above this quality keeps full-resolution chroma. */
export const AVIF_FULL_CHROMA_QUALITY = 80;

export type ChromaSubsampling = '4:4:4' | '4:2:0';
/** Plane layout of an AVIF: monochrome (4:0:0, the AV1 Main profile has it) or one of the chroma subsamplings. */
export type AvifPlaneLayout = ChromaSubsampling | '4:0:0';

/** The encoders that can write an AVIF: the library encoder's command-line tool, or the image library. */
export type AvifEncoder = 'library-cli' | 'image-library';

/** libwebp effort (cwebp -m): 4 is the reference encoder's setting and the project's. */
export const WEBP_EFFORT = 4;

/**
 * Quality metric the AVIF encoder optimises for. SSIM-tuned encodes reach the same PSNR as PSNR-tuned ones in
 * fewer bytes on the benchmark corpus (screenshot: 9.8% against 21.5% behind the reference encoder at effort
 * 3; photographs: equal) and track perceived quality better; sharp 0.35's default perceptual tuning spends
 * roughly 5 dB of PSNR at a given `quality`.
 */
export const AVIF_TUNE = 'ssim';

/** Effort ladder for AVIF, by picture size, in megapixels. Each step down is roughly 3 times faster. */
interface EffortTier {
  /** Largest size, in pixels, this tier covers. */
  maxPixels: number;
  photo: number;
  graphic: number;
}
const MEGAPIXEL = 1_000_000;
/**
 * libaom 3.15 searches several times longer from effort 4 upward (a 39-megapixel RAW took about 3 minutes at the
 * old default effort 4, 20 s at effort 3), so large pictures get fewer search steps. A photograph gains little
 * from effort 4 over 3 (BD-rate against the reference encoder -17% against -22%) for 3 times the time. Graphic
 * content has few distinct blocks and gains the most from a longer search (screenshot behind the reference
 * encoder by 9.8% at effort 3, 5.3% at 4, -1% at 5) and is cheap to encode.
 */
export const AVIF_EFFORT_TIERS: readonly EffortTier[] = [
  { maxPixels: 1 * MEGAPIXEL, photo: 3, graphic: 5 },
  { maxPixels: 4 * MEGAPIXEL, photo: 3, graphic: 4 },
  { maxPixels: 16 * MEGAPIXEL, photo: 3, graphic: 3 },
];
/** Effort for pictures larger than the last tier. */
export const AVIF_EFFORT_HUGE = 2;

/**
 * Effort ladder of the library encoder's tool. Its speed 6 (effort 3) is the AV1 encoder's own default preset and
 * the reference the benchmark compares with: graphic content reaches the reference's BD-rate there (the image
 * library needed effort 5 for the same), while effort 5 takes 4.5 times as long (a 1024 x 640 interface: 420 ms
 * against 94 ms; lineart 406 ms against 86 ms) for 4 to 10% fewer bytes. Large pictures take the same step down
 * as in the image library.
 */
export const AVIF_CLI_EFFORT_TIERS: readonly EffortTier[] = [{ maxPixels: 16 * MEGAPIXEL, photo: 3, graphic: 3 }];

/**
 * Metric the library encoder's tool optimises photographs for. For graphic content it keeps the encoder's own
 * tuning for still images (`iq`, which tracks SSIMULACRA 2): `ssim` loses 2.9% PSNR BD-rate on grey line art against
 * it at speed 6 and gains nothing on interfaces (0.1% SSIM), while on photographs it saves 4 to 10% of the bytes.
 */
export const AVIF_CLI_PHOTO_TUNE = 'ssim';
/** Effort the other encoders that embed AVIF (vector, office) use: no content analysis is run there. */
export const AVIF_EFFORT = 3;

/**
 * Bit depth of AVIF output for sources with more than 8 bits per sample (colour, grey and HDR alike): 10, the most
 * the AV1 Main profile carries. The AVIF Baseline profile is AV1 Main, and decoders such as Android 14's only
 * guarantee Baseline, so 12-bit (AV1 Professional) output would be unreadable on part of the audience. The 8-bit
 * path would cap a deep picture near 51 dB PSNR whatever the quality; HDR output (PQ or HLG, BT.2020) is delivered
 * at 10 bits for the same reason.
 */
export const AVIF_DEEP_BITDEPTH = 10;
export const AVIF_STANDARD_BITDEPTH = 8;

/**
 * Largest picture, in pixels, the library's command-line encoder is given; larger pictures go to the image library.
 * Resident memory of one run, measured: 37 bytes per pixel for 8-bit RGB at speeds 2, 3 and 6 (591 MB at 16
 * megapixels, 1.32 GB at 36) and 45 bytes per pixel for 16-bit RGB written as 10-bit 4:4:4 (2.87 GB at 64
 * megapixels). 48 megapixels (an 8000 x 6000 frame) keeps one run near 2.2 GB of the 3.3 GB that docker-compose.yml
 * gives each of 3 concurrent jobs, with the raster and the PNG this process holds on top.
 */
export const AVIF_CLI_MAX_PIXELS = 48_000_000;

/**
 * Which encoder writes an AVIF. The library's command-line encoder takes grey and graphic content (screenshots,
 * line art) and wins on both quality and speed there. Colour photographs stay on the in-process image library:
 * measured against it, the CLI's encoder gain on a photograph was about 2x in encode time but the fixed cost of
 * the process, the PNG hand-off and the temp files outweighed it (speed ratio 1.97 and 1.69, at parity), with
 * no change in photo BD-rate. Pictures above `AVIF_CLI_MAX_PIXELS` also stay on the image library, which encoded
 * them before the tool existed, so no picture size is refused that was accepted earlier.
 */
export function avifEncoderFor(content: ContentClass, grey: boolean, pixels: number, toolAvailable: boolean): AvifEncoder {
  if (!toolAvailable || pixels > AVIF_CLI_MAX_PIXELS) return 'image-library';
  return grey || content === 'graphic' ? 'library-cli' : 'image-library';
}

export function avifEffortFor(pixels: number, content: ContentClass, encoder: AvifEncoder = 'image-library'): number {
  const tiers = encoder === 'library-cli' ? AVIF_CLI_EFFORT_TIERS : AVIF_EFFORT_TIERS;
  for (const tier of tiers) {
    if (pixels <= tier.maxPixels) return content === 'graphic' ? tier.graphic : tier.photo;
  }
  return AVIF_EFFORT_HUGE;
}

/** The tuning metric to ask the encoder for, or undefined to keep the tool's own. */
export function avifTuneFor(encoder: AvifEncoder, content: ContentClass): string | undefined {
  if (encoder === 'image-library') return AVIF_TUNE;
  return content === 'photo' ? AVIF_CLI_PHOTO_TUNE : undefined;
}

export function clampQuality(quality: number | undefined, fallback: number): number {
  if (!quality) return fallback;
  return Math.max(QUALITY_MIN, Math.min(QUALITY_MAX, quality));
}

export function jpegChromaFor(quality: number, content: ContentClass): ChromaSubsampling {
  if (quality >= JPEG_FULL_CHROMA_QUALITY) return '4:4:4';
  return content === 'graphic' ? '4:4:4' : '4:2:0';
}

export function avifChromaFor(quality: number, content: ContentClass): ChromaSubsampling {
  if (quality >= AVIF_FULL_CHROMA_QUALITY) return '4:4:4';
  return content === 'graphic' ? '4:4:4' : '4:2:0';
}

/**
 * Layout of the AVIF planes: a grey source is monochrome (a colour layout spends bytes on two chroma planes that
 * carry nothing), anything else follows `avifChromaFor`.
 */
export function avifLayoutFor(grey: boolean, quality: number, content: ContentClass): AvifPlaneLayout {
  return grey ? '4:0:0' : avifChromaFor(quality, content);
}

/**
 * Effort is the image library's scale, 0 the fastest encode and 9 the slowest; the AV1 encoder's speed preset runs
 * the other way (0 slowest), and the library maps one to the other as `speed = 9 - effort`. Effort 3 is speed 6.
 */
export const AVIF_EFFORT_SPEED_SUM = 9;

/** The encoder speed preset (0 slowest) for an effort of the policy's ladder. */
export function avifSpeedFor(effort: number): number {
  return AVIF_EFFORT_SPEED_SUM - effort;
}

/**
 * mozjpeg quantisation table for graphic content: 2, the table tuned for MS-SSIM. The default (3) and the trellis
 * are tuned for PSNR-HVS-M on photographs, which weighs error on hard edges lightly; on line art and interfaces
 * they zero the high-frequency coefficients that make up the edges.
 */
export const GRAPHIC_JPEG_QUANTISATION_TABLE = 2;

export function jpegOptionsFor(requestedQuality: number | undefined, content: ContentClass): JpegOptions {
  const quality = clampQuality(requestedQuality, DEFAULT_QUALITY_BY_CODEC.jpeg);
  const chromaSubsampling = jpegChromaFor(quality, content);
  // mozjpeg turns on trellis quantisation, overshoot deringing and scan optimisation (and keeps optimal Huffman tables).
  if (content === 'photo') return { quality, mozjpeg: true, chromaSubsampling };
  // Measured on line art: trellis quantisation costs 5 to 6 dB of PSNR at the same quality number; without it,
  // with table 2, the file is 10% smaller than the reference encoder's at equal PSNR, where it was 9% larger.
  // Overshoot deringing stays on: switching it off costs 1.5 dB on text and rules.
  return { quality, mozjpeg: true, chromaSubsampling, trellisQuantisation: false, quantisationTable: GRAPHIC_JPEG_QUANTISATION_TABLE };
}

export function webpOptionsFor(requestedQuality: number | undefined, content: ContentClass): WebpOptions {
  const quality = clampQuality(requestedQuality, DEFAULT_QUALITY_BY_CODEC.webp);
  // Sharp YUV keeps coloured edges crisp, which matters for text and line art; on photographs it costs
  // bytes for no gain in PSNR or SSIM (+1 to +2.6% BD-rate), so it is applied to graphic content only.
  return { quality, effort: WEBP_EFFORT, smartSubsample: content === 'graphic' };
}

export type AvifBitdepth = typeof AVIF_STANDARD_BITDEPTH | typeof AVIF_DEEP_BITDEPTH;

/** 8 bits for 8-bit sources, 10 for anything deeper: the AV1 Main profile has no more. */
export function avifBitdepthFor(deep: boolean): AvifBitdepth {
  return deep ? AVIF_DEEP_BITDEPTH : AVIF_STANDARD_BITDEPTH;
}

/** Every choice the AVIF encoders share, whichever of them runs: the library encoder and the image library read the same policy. */
export interface AvifPolicy {
  encoder: AvifEncoder;
  quality: number;
  effort: number;
  bitdepth: AvifBitdepth;
  /** Chroma subsampling of a colour picture. */
  chroma: ChromaSubsampling;
  /** Plane layout actually written: monochrome for a grey picture, otherwise `chroma`. */
  layout: AvifPlaneLayout;
  /** Tuning metric, or undefined for the encoder's own. */
  tune: string | undefined;
}

export function avifPolicyFor(
  requestedQuality: number | undefined,
  content: ContentClass,
  pixels: number,
  deep: boolean,
  grey: boolean,
  encoder: AvifEncoder
): AvifPolicy {
  const quality = clampQuality(requestedQuality, DEFAULT_QUALITY_BY_CODEC.avif);
  return {
    encoder,
    quality,
    effort: avifEffortFor(pixels, content, encoder),
    bitdepth: avifBitdepthFor(deep),
    chroma: avifChromaFor(quality, content),
    layout: avifLayoutFor(grey, quality, content),
    tune: avifTuneFor(encoder, content),
  };
}

/** The image library's options for the policy; it cannot write monochrome, so a grey picture is encoded as colour there. */
export function avifLibraryOptionsOf(policy: AvifPolicy): AvifOptions {
  return {
    quality: policy.quality,
    effort: policy.effort,
    tune: AVIF_TUNE,
    chromaSubsampling: policy.chroma,
    bitdepth: policy.bitdepth,
  };
}
