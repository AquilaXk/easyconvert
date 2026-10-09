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
/** Effort the other encoders that embed AVIF (vector, office) use: no content analysis is run there. */
export const AVIF_EFFORT = 3;

/**
 * AVIF bit depth for colour sources with more than 8 bits per sample: 12, the most AV1 carries and the depth the
 * reference encoder picks for a 16-bit picture. Flat colours and hard edges survive the RGB to YUV and back
 * rounding only with the extra precision: at 10 bits a screenshot's SSIM stopped near 29.5 dB at any quality
 * (reference 32.3 dB) and the file needed 4% more bytes at equal SSIM; at 12 bits it needs 5.6% fewer.
 */
export const AVIF_DEEP_BITDEPTH = 12;
/**
 * Bit depth for grey sources with more than 8 bits per sample. A grey picture has no colour conversion to round,
 * so 12 bits buys nothing there and, measured over seven qualities on the benchmark's line art, costs 7.7%
 * (BD-rate in SSIM +4.1% against -3.6% at 10 bits).
 */
export const AVIF_DEEP_GREY_BITDEPTH = 10;
export const AVIF_STANDARD_BITDEPTH = 8;

export function avifEffortFor(pixels: number, content: ContentClass): number {
  for (const tier of AVIF_EFFORT_TIERS) {
    if (pixels <= tier.maxPixels) return content === 'graphic' ? tier.graphic : tier.photo;
  }
  return AVIF_EFFORT_HUGE;
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

export type AvifBitdepth = typeof AVIF_STANDARD_BITDEPTH | typeof AVIF_DEEP_GREY_BITDEPTH | typeof AVIF_DEEP_BITDEPTH;

export function avifBitdepthFor(deep: boolean, grey: boolean): AvifBitdepth {
  if (!deep) return AVIF_STANDARD_BITDEPTH;
  return grey ? AVIF_DEEP_GREY_BITDEPTH : AVIF_DEEP_BITDEPTH;
}

export function avifOptionsFor(
  requestedQuality: number | undefined,
  content: ContentClass,
  pixels: number,
  bitdepth: AvifBitdepth
): AvifOptions {
  const quality = clampQuality(requestedQuality, DEFAULT_QUALITY_BY_CODEC.avif);
  return {
    quality,
    effort: avifEffortFor(pixels, content),
    tune: AVIF_TUNE,
    chromaSubsampling: avifChromaFor(quality, content),
    bitdepth,
  };
}
