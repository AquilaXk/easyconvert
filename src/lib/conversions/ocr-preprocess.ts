import sharp from 'sharp';
import { OcrPreprocessError } from '../types';
import { oddWindow, sauvolaBinarize } from './ocr-sauvola';
import { estimateSkew, lineHeightFromProfile } from './ocr-text-metrics';
import { identityGeometry, type OcrGeometry } from './ocr-geometry';
import { CliSemaphore } from './ocr-cli';

/**
 * Prepares a page image for recognition: lines of text are levelled (deskew), scaled up to a size
 * the recognizer reads well (rescale), then binarized with Sauvola's adaptive threshold
 * (binarize). Each step can be switched off through OCR_PREPROCESS_STEPS; a step stays on only
 * where it lowers the mean character error rate on the golden pages (tests/fixtures/ocr).
 */

export interface OcrPreprocessSteps {
  readonly rescale: boolean;
  readonly deskew: boolean;
  readonly binarize: boolean;
}

export const OCR_PREPROCESS_STEPS: OcrPreprocessSteps = {
  rescale: true,
  deskew: true,
  binarize: true,
};

/** Pages prepared at once; each holds a few page-sized buffers (up to about 200 MB at the pixel limit). */
export const OCR_PREPROCESS_MAX_CONCURRENCY = 2;
/** Pages allowed to wait for a slot before further requests are rejected. */
export const OCR_PREPROCESS_MAX_QUEUED = 64;
/** Pages with more pixels than this are passed on unchanged: the steps hold several page-sized buffers. */
export const OCR_PREPROCESS_MAX_PIXELS = 50_000_000;
/** Text lines shorter than this are scaled up; the recognizer reads 30 to 40 px lines best. */
export const OCR_MIN_LINE_HEIGHT_PX = 30;
/** Lines are scaled to this height, the middle of the 30 to 40 px range. */
export const OCR_TARGET_LINE_HEIGHT_PX = 35;
/** A page is never enlarged by more than this factor, however small its text. */
export const OCR_MAX_UPSCALE = 4;
/** Skews below this many degrees are left alone; a turn would cost more in resampling than it gains. */
export const OCR_DESKEW_MIN_DEGREES = 0.1;
/** The sharpest row profile must beat the unturned page's by this factor, or the skew is not trusted. */
export const OCR_DESKEW_MIN_IMPROVEMENT = 1.05;
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
const GRAY_CHANNELS = 1;
const GRAY_LEVELS = 256;
const DEGREES_TO_RADIANS = Math.PI / 180;

export interface OcrPreprocessResult {
  /** PNG the recognizer reads. */
  image: Buffer;
  geometry: OcrGeometry;
  /** Median text line height of the source in pixels, measured along the text, or null when no line was found. */
  lineHeightPx: number | null;
  /** Skew measured on the page in degrees (see SkewEstimate), whether or not it was corrected; 0 when not measured. */
  skewDegrees: number;
  applied: { rescale: boolean; deskew: boolean; binarize: boolean };
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

/** Pixels of the bounding box of a `width` x `height` image turned by `degrees`. */
export function turnedPixelCount(width: number, height: number, degrees: number): number {
  const sin = Math.abs(Math.sin(degrees * DEGREES_TO_RADIANS));
  const cos = Math.abs(Math.cos(degrees * DEGREES_TO_RADIANS));
  return Math.ceil(width * cos + height * sin) * Math.ceil(width * sin + height * cos);
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

function fromGray(page: GrayPage): sharp.Sharp {
  return sharp(page.data, { raw: { width: page.width, height: page.height, channels: GRAY_CHANNELS } });
}

function decodeGray(source: Buffer): Promise<GrayPage> {
  return toGrayPage(sharp(source).rotate().flatten({ background: '#ffffff' }));
}

async function analysisCopy(page: GrayPage): Promise<GrayPage> {
  const longest = Math.max(page.width, page.height);
  if (longest <= OCR_ANALYSIS_MAX_SIDE_PX) return page;
  return toGrayPage(
    fromGray(page).resize({
      width: Math.round((page.width * OCR_ANALYSIS_MAX_SIDE_PX) / longest),
      height: Math.round((page.height * OCR_ANALYSIS_MAX_SIDE_PX) / longest),
      fit: 'fill',
    })
  );
}

/** Most common gray level: the paper, which fills the corners a turn uncovers. */
function paperLevel(page: GrayPage): number {
  const histogram = new Uint32Array(GRAY_LEVELS);
  for (let i = 0; i < page.data.length; i++) histogram[page.data[i]]++;
  let paper = 0;
  for (let level = 1; level < GRAY_LEVELS; level++) {
    if (histogram[level] > histogram[paper]) paper = level;
  }
  return paper;
}

/** Sauvola window for text lines of the given height, or null where the lines are too small to binarize. */
function sauvolaWindowFor(lineHeightPx: number | null): number | null {
  if (lineHeightPx === null || lineHeightPx < OCR_BINARIZE_MIN_LINE_PX) return null;
  return oddWindow(lineHeightPx * SAUVOLA_WINDOW_LINE_FACTOR);
}

/** Enlarges with a Lanczos kernel, which keeps stroke edges sharp better than bilinear or bicubic. */
function enlarge(page: GrayPage, scale: number): Promise<GrayPage> {
  return toGrayPage(
    fromGray(page).resize({
      width: Math.round(page.width * scale),
      height: Math.round(page.height * scale),
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
  );
}

/** Turns the page clockwise about its centre on a canvas that holds the whole result. */
function turn(page: GrayPage, degrees: number, paper: number): Promise<GrayPage> {
  return toGrayPage(fromGray(page).rotate(degrees, { background: { r: paper, g: paper, b: paper, alpha: 1 } }));
}

/**
 * No resolution is written into the PNG: with a 300 dpi hint the WebAssembly engine read the golden
 * pages at a mean 2.7% character error rate, without it at 0.6% (Korean layout analysis
 * suffered most), so the recognizer estimates the resolution itself as it does for any image.
 */
async function encodePng(pixels: Uint8Array, width: number, height: number): Promise<Buffer> {
  return sharp(pixels, { raw: { width, height, channels: GRAY_CHANNELS } })
    .png({ compressionLevel: OCR_PNG_COMPRESSION_LEVEL })
    .toBuffer();
}

const preparationSlots = new CliSemaphore(OCR_PREPROCESS_MAX_CONCURRENCY, OCR_PREPROCESS_MAX_QUEUED, 'page preparations');

/**
 * Decodes the page, measures its text and applies the enabled steps. The page is decoded upright
 * (EXIF orientation applied). A page above OCR_PREPROCESS_MAX_PIXELS is only re-encoded. At most
 * OCR_PREPROCESS_MAX_CONCURRENCY pages are prepared at once; beyond OCR_PREPROCESS_MAX_QUEUED
 * waiting pages a request is rejected with OcrEngineUnavailableError (503).
 */
export function preprocessOcrImage(
  source: Buffer,
  steps: OcrPreprocessSteps = OCR_PREPROCESS_STEPS
): Promise<OcrPreprocessResult> {
  return preparationSlots.run(() => prepare(source, steps));
}

async function prepare(source: Buffer, steps: OcrPreprocessSteps): Promise<OcrPreprocessResult> {
  const meta = await sharp(source).metadata();
  const swapped = meta.orientation !== undefined && meta.orientation >= 5;
  const width = (swapped ? meta.height : meta.width) ?? 0;
  const height = (swapped ? meta.width : meta.height) ?? 0;
  const unchanged = async (lineHeightPx: number | null, skewDegrees: number): Promise<OcrPreprocessResult> => ({
    image: await sharp(source).rotate().png().toBuffer(),
    geometry: identityGeometry(width, height),
    lineHeightPx,
    skewDegrees,
    applied: { rescale: false, deskew: false, binarize: false },
  });
  const enabled = steps.rescale || steps.deskew || steps.binarize;
  if (!enabled || width * height > OCR_PREPROCESS_MAX_PIXELS) return unchanged(null, 0);

  // Only the current page is referenced, so the previous stage's buffer can be freed.
  const held = { page: await decodeGray(source) };
  const sourceWidth = held.page.width;
  const sourceHeight = held.page.height;
  const analysis = await analysisCopy(held.page);
  const analysisScale = analysis.width / sourceWidth;
  const rough = await sauvolaBinarize(analysis.data, analysis.width, analysis.height, {
    windowSize: OCR_ANALYSIS_WINDOW_PX,
  });
  // The skew is always measured: line heights are read off the levelled row profile, because a
  // skewed page's lines run into each other when projected along its rows.
  const skew = await estimateSkew(rough, analysis.width, analysis.height);
  const measured = lineHeightFromProfile(skew.profile);
  const lineHeightPx = measured === null ? null : measured / analysisScale;
  const paper = steps.deskew ? paperLevel(analysis) : 0;

  const scale = steps.rescale ? planRescale(lineHeightPx, sourceWidth, sourceHeight) : 1;
  if (scale > 1) held.page = await enlarge(held.page, scale);
  const scaledWidth = held.page.width;
  const scaledHeight = held.page.height;

  const trusted = Math.abs(skew.degrees) >= OCR_DESKEW_MIN_DEGREES && skew.improvement >= OCR_DESKEW_MIN_IMPROVEMENT;
  const turned =
    steps.deskew && trusted && turnedPixelCount(scaledWidth, scaledHeight, skew.degrees) <= OCR_PREPROCESS_MAX_PIXELS;
  if (turned) held.page = await turn(held.page, skew.degrees, paper);

  const scaledLineHeight = lineHeightPx === null ? null : lineHeightPx * scale;
  const binarizeWindow = steps.binarize ? sauvolaWindowFor(scaledLineHeight) : null;
  if (scale === 1 && !turned && binarizeWindow === null) return unchanged(lineHeightPx, skew.degrees);

  const pixels =
    binarizeWindow === null
      ? held.page.data
      : await sauvolaBinarize(held.page.data, held.page.width, held.page.height, { windowSize: binarizeWindow });
  return {
    image: await encodePng(pixels, held.page.width, held.page.height),
    geometry: {
      sourceWidth,
      sourceHeight,
      scaledWidth,
      scaledHeight,
      outputWidth: held.page.width,
      outputHeight: held.page.height,
      rotationDegrees: turned ? skew.degrees : 0,
    },
    lineHeightPx,
    skewDegrees: skew.degrees,
    applied: { rescale: scale > 1, deskew: turned, binarize: binarizeWindow !== null },
  };
}
