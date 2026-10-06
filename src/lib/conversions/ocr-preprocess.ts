import sharp from 'sharp';
import { OcrPreprocessError } from '../types';
import { oddWindow, sauvolaBinarize } from './ocr-sauvola';
import { estimateLineHeight } from './ocr-text-metrics';
import { identityGeometry, type OcrGeometry } from './ocr-geometry';

/**
 * Prepares a page image for recognition: text lines are scaled up to a size the recognizer reads
 * well, then binarized with Sauvola's adaptive threshold. Each step can be switched off through
 * OCR_PREPROCESS_STEPS; a step stays on only where it lowers the mean character error rate on the
 * golden pages (tests/fixtures/ocr).
 */

export interface OcrPreprocessSteps {
  readonly rescale: boolean;
  readonly binarize: boolean;
}

export const OCR_PREPROCESS_STEPS: OcrPreprocessSteps = {
  rescale: true,
  binarize: true,
};

/** Pages with more pixels than this are passed on unchanged: the steps hold several page-sized buffers. */
export const OCR_PREPROCESS_MAX_PIXELS = 50_000_000;
/** Text lines shorter than this are scaled up; the recognizer reads 30 to 40 px lines best. */
export const OCR_MIN_LINE_HEIGHT_PX = 30;
/** Lines are scaled to this height, the middle of the 30 to 40 px range. */
export const OCR_TARGET_LINE_HEIGHT_PX = 35;
/** A page is never enlarged by more than this factor, however small its text. */
export const OCR_MAX_UPSCALE = 4;
/** The page is measured on a copy whose longest side is at most this long. */
export const OCR_ANALYSIS_MAX_SIDE_PX = 1600;
/** Sauvola window used while measuring, where the line height is not known yet. */
export const OCR_ANALYSIS_WINDOW_PX = 31;
/** Final Sauvola window as a multiple of the measured line height. */
export const SAUVOLA_WINDOW_LINE_FACTOR = 1.5;
/**
 * Text lines shorter than this are not binarized: at that size a stroke is about a pixel wide and
 * the grey levels from anti-aliasing carry the glyph shapes that a hard threshold removes.
 */
export const OCR_BINARIZE_MIN_LINE_PX = 20;
export const OCR_PNG_COMPRESSION_LEVEL = 3;
/** Resolution recorded in the prepared image, so recognition does not guess it from the pixel size. */
export const OCR_OUTPUT_DPI = 300;
const GRAY_CHANNELS = 1;

export interface OcrPreprocessResult {
  /** PNG the recognizer reads. */
  image: Buffer;
  geometry: OcrGeometry;
  /** Median text line height of the source in pixels, or null when no line was found. */
  lineHeightPx: number | null;
  applied: { rescale: boolean; binarize: boolean };
}

/**
 * Factor (at least 1) that brings text lines of `lineHeightPx` into the recognizer's range. Only
 * enlarges, never beyond OCR_MAX_UPSCALE, and never past the pixel budget.
 */
export function planRescale(lineHeightPx: number | null, width: number, height: number): number {
  if (lineHeightPx === null || lineHeightPx <= 0 || lineHeightPx >= OCR_MIN_LINE_HEIGHT_PX) return 1;
  const budget = Math.sqrt(OCR_PREPROCESS_MAX_PIXELS / (width * height));
  return Math.max(1, Math.min(OCR_TARGET_LINE_HEIGHT_PX / lineHeightPx, OCR_MAX_UPSCALE, budget));
}

interface GrayPage {
  data: Buffer;
  width: number;
  height: number;
}

/** Reads a pipeline's output as one 8-bit gray channel. */
async function toGrayPage(pipeline: sharp.Sharp): Promise<GrayPage> {
  const { data, info } = await pipeline.toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== GRAY_CHANNELS) {
    throw new OcrPreprocessError(`Expected one gray channel, decoded ${info.channels}.`);
  }
  return { data, width: info.width, height: info.height };
}

function decodeGray(source: Buffer): Promise<GrayPage> {
  return toGrayPage(sharp(source).rotate().flatten({ background: '#ffffff' }));
}

async function analysisCopy(page: GrayPage): Promise<GrayPage> {
  const longest = Math.max(page.width, page.height);
  if (longest <= OCR_ANALYSIS_MAX_SIDE_PX) return page;
  return toGrayPage(
    sharp(page.data, { raw: { width: page.width, height: page.height, channels: GRAY_CHANNELS } }).resize({
      width: Math.round((page.width * OCR_ANALYSIS_MAX_SIDE_PX) / longest),
      height: Math.round((page.height * OCR_ANALYSIS_MAX_SIDE_PX) / longest),
      fit: 'fill',
    })
  );
}

/** Sauvola window for text lines of the given height, or null where the lines are too small to binarize. */
function sauvolaWindowFor(lineHeightPx: number | null): number | null {
  if (lineHeightPx === null || lineHeightPx < OCR_BINARIZE_MIN_LINE_PX) return null;
  return oddWindow(lineHeightPx * SAUVOLA_WINDOW_LINE_FACTOR);
}

/** Enlarges with a Lanczos kernel, which keeps stroke edges sharp better than bilinear or bicubic. */
function enlarge(page: GrayPage, scale: number): Promise<GrayPage> {
  return toGrayPage(
    sharp(page.data, { raw: { width: page.width, height: page.height, channels: GRAY_CHANNELS } }).resize({
      width: Math.round(page.width * scale),
      height: Math.round(page.height * scale),
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
  );
}

async function encodePng(pixels: Uint8Array, width: number, height: number): Promise<Buffer> {
  return sharp(pixels, { raw: { width, height, channels: GRAY_CHANNELS } })
    .png({ compressionLevel: OCR_PNG_COMPRESSION_LEVEL })
    .withMetadata({ density: OCR_OUTPUT_DPI })
    .toBuffer();
}

/**
 * Decodes the page, measures its text and applies the enabled steps. The page is decoded upright
 * (EXIF orientation applied). A page above OCR_PREPROCESS_MAX_PIXELS is only re-encoded.
 */
export async function preprocessOcrImage(
  source: Buffer,
  steps: OcrPreprocessSteps = OCR_PREPROCESS_STEPS
): Promise<OcrPreprocessResult> {
  const meta = await sharp(source).metadata();
  const swapped = meta.orientation !== undefined && meta.orientation >= 5;
  const width = (swapped ? meta.height : meta.width) ?? 0;
  const height = (swapped ? meta.width : meta.height) ?? 0;
  const unchanged = async (lineHeightPx: number | null): Promise<OcrPreprocessResult> => ({
    image: await sharp(source).rotate().png().toBuffer(),
    geometry: identityGeometry(width, height),
    lineHeightPx,
    applied: { rescale: false, binarize: false },
  });
  const enabled = steps.rescale || steps.binarize;
  if (!enabled || width * height > OCR_PREPROCESS_MAX_PIXELS) return unchanged(null);

  const gray = await decodeGray(source);
  const analysis = await analysisCopy(gray);
  const analysisScale = analysis.width / gray.width;
  const rough = await sauvolaBinarize(analysis.data, analysis.width, analysis.height, {
    windowSize: OCR_ANALYSIS_WINDOW_PX,
  });
  const measured = estimateLineHeight(rough, analysis.width, analysis.height);
  const lineHeightPx = measured === null ? null : measured / analysisScale;

  const scale = steps.rescale ? planRescale(lineHeightPx, gray.width, gray.height) : 1;
  const page = scale > 1 ? await enlarge(gray, scale) : gray;
  const binarizeWindow = steps.binarize ? sauvolaWindowFor(lineHeightPx === null ? null : lineHeightPx * scale) : null;
  if (scale === 1 && binarizeWindow === null) return unchanged(lineHeightPx);

  const binarize = binarizeWindow !== null;
  const pixels =
    binarizeWindow === null
      ? page.data
      : await sauvolaBinarize(page.data, page.width, page.height, { windowSize: binarizeWindow });
  return {
    image: await encodePng(pixels, page.width, page.height),
    geometry: {
      sourceWidth: gray.width,
      sourceHeight: gray.height,
      outputWidth: page.width,
      outputHeight: page.height,
    },
    lineHeightPx,
    applied: { rescale: scale > 1, binarize },
  };
}
