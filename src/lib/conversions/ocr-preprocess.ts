import sharp from 'sharp';
import { OcrPreprocessError } from '../types';
import { oddWindow, sauvolaBinarize } from './ocr-sauvola';
import { estimateLineHeight } from './ocr-text-metrics';

/**
 * Prepares a page image for recognition: Sauvola adaptive binarization. Each step can be switched
 * off through OCR_PREPROCESS_STEPS; a step stays on only where it lowers the mean character error
 * rate on the golden pages (tests/fixtures/ocr).
 */

export interface OcrPreprocessSteps {
  readonly binarize: boolean;
}

export const OCR_PREPROCESS_STEPS: OcrPreprocessSteps = {
  binarize: true,
};

/** Pages with more pixels than this are passed on unchanged: the steps hold several page-sized buffers. */
export const OCR_PREPROCESS_MAX_PIXELS = 50_000_000;
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

/** Where the prepared image sits relative to the source, to map recognized boxes back. */
export interface OcrGeometry {
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
}

export interface OcrPreprocessResult {
  /** PNG the recognizer reads. */
  image: Buffer;
  geometry: OcrGeometry;
  /** Median text line height of the source in pixels, or null when no line was found. */
  lineHeightPx: number | null;
  applied: { binarize: boolean };
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
    geometry: { sourceWidth: width, sourceHeight: height, outputWidth: width, outputHeight: height },
    lineHeightPx,
    applied: { binarize: false },
  });
  if (!steps.binarize || width * height > OCR_PREPROCESS_MAX_PIXELS) return unchanged(null);

  const page = await decodeGray(source);
  const analysis = await analysisCopy(page);
  const analysisScale = analysis.width / page.width;
  const rough = await sauvolaBinarize(analysis.data, analysis.width, analysis.height, {
    windowSize: OCR_ANALYSIS_WINDOW_PX,
  });
  const measured = estimateLineHeight(rough, analysis.width, analysis.height);
  const lineHeightPx = measured === null ? null : measured / analysisScale;
  if (lineHeightPx === null || lineHeightPx < OCR_BINARIZE_MIN_LINE_PX) return unchanged(lineHeightPx);

  const binary = await sauvolaBinarize(page.data, page.width, page.height, {
    windowSize: oddWindow(lineHeightPx * SAUVOLA_WINDOW_LINE_FACTOR),
  });
  return {
    image: await encodePng(binary, page.width, page.height),
    geometry: { sourceWidth: page.width, sourceHeight: page.height, outputWidth: page.width, outputHeight: page.height },
    lineHeightPx,
    applied: { binarize: true },
  };
}
