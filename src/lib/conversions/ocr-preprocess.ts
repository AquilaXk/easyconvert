import sharp, { type Sharp } from 'sharp';
import { OcrPreprocessError } from '../types';
import { oddWindow, sauvolaBinarize } from './ocr-sauvola';
import { estimateSkew, lineHeightFromProfile } from './ocr-text-metrics';
import { identityGeometry, type OcrGeometry, type OcrQuarterTurn } from './ocr-geometry';
import { CliSemaphore } from './ocr-cli';
import { countTextRows, OCR_SMALL_CROP_MAX_HEIGHT_PX } from './ocr-config';
import { encodePbm, encodePgm, encodePpm, isBitonal } from './pnm';
import { measureInk, OCR_BAND_MIN_LINES, type OcrInkProfile } from './ocr-bands';

/**
 * Prepares a page image for recognition: lines of text are levelled (deskew), scaled up to a size
 * the recognizer reads well (rescale), then binarized with Sauvola's adaptive threshold
 * (binarize). Each step can be switched off through OCR_PREPROCESS_STEPS; a step stays on only
 * where it lowers the mean character error rate on the golden pages (tests/fixtures/ocr).
 *
 * Binarization is the one step that can destroy a page: a hard threshold removes the grey levels that
 * carry the shapes of small or blurred strokes and turns speckle into marks. The recognizer
 * thresholds a page itself, so the step only pays where one global threshold cannot work, namely a
 * page whose background is uneven or one the recognizer reads badly. `unevenBackground` measures the
 * first; the caller reads the page unbinarized first and binarizes only when that signal or the
 * reading calls for it, and keeps the binarized reading only if it is the better one (ocr.ts).
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
/** Side in analysis pixels of the cells the page background is sampled in. */
export const OCR_BACKGROUND_CELL_PX = 64;
/** A cell's background is this percentile of its gray levels: ink covers well under a tenth of the cells' pixels at the top. */
export const OCR_BACKGROUND_PERCENTILE = 0.9;
/** The page's background level spread is measured between these percentiles of its cells. */
export const OCR_BACKGROUND_SPREAD_PERCENTILES = { low: 0.05, high: 0.95 } as const;
/** Fewer cells than this cannot show a gradient, however small the page. */
export const OCR_BACKGROUND_MIN_CELLS = 4;
/** The darkest ink is read at this percentile of the page's gray levels. */
export const OCR_INK_LEVEL_PERCENTILE = 0.01;
/**
 * A page whose background level varies by more than this share of the contrast between paper and ink
 * is unevenly lit: one global threshold would put paper on one side of it and ink on the other.
 */
export const OCR_UNEVEN_BACKGROUND_RATIO = 0.25;
const GRAY_CHANNELS = 1;
const RGB_CHANNELS = 3;
const GRAY_LEVELS = 256;
const DEGREES_TO_RADIANS = Math.PI / 180;

export interface OcrPreprocessResult {
  /**
   * The page as a Netpbm image, which the recognizers read without a codec: P4 for a bitonal page,
   * P5 for gray, P6 for colour. It holds the same pixels the steps produced, uncompressed.
   */
  image: Buffer;
  /** Text rows of a page whose source is short enough to be read as a label or line; undefined for taller pages. */
  textRows?: number;
  geometry: OcrGeometry;
  /** Median text line height of the source in pixels, measured along the text, or null when no line was found. */
  lineHeightPx: number | null;
  /** Skew measured on the page in degrees (see SkewEstimate), whether or not it was corrected; 0 when not measured. */
  skewDegrees: number;
  /**
   * How unevenly the page is lit, as the spread of its local background level over the contrast between paper and
   * ink (0 for a flat background); 0 when the page was not measured.
   */
  unevenBackground: number;
  /** Whether the page has text lines large enough for binarization to apply, whatever the steps asked for. */
  binarizable: boolean;
  /**
   * Where the ink of the page sits, as handed to the recognizer, and the height of its text lines in those pixels, for
   * cutting the page into bands (see ocr-bands.ts). Left out for a colour page, a page whose text line height is
   * unknown and a page too short to hold two bands.
   */
  ink?: { profile: OcrInkProfile; lineHeightPx: number };
  applied: { rescale: boolean; deskew: boolean; binarize: boolean };
}

/** The ink of a gray page for cutting it into bands, or nothing when the page cannot be cut into two. */
function bandInk(
  gray: Uint8Array,
  width: number,
  height: number,
  lineHeightPx: number | null
): OcrPreprocessResult['ink'] {
  if (lineHeightPx === null || height < 2 * OCR_BAND_MIN_LINES * lineHeightPx) return undefined;
  return { profile: measureInk(gray, width, height), lineHeightPx };
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
async function toGrayPage(pipeline: Sharp): Promise<GrayPage> {
  const { data, info } = await pipeline.toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== GRAY_CHANNELS) {
    throw new OcrPreprocessError(`Expected one gray channel, decoded ${info.channels}.`);
  }
  return { data, width: info.width, height: info.height };
}

function fromGray(page: GrayPage): Sharp {
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
      // A side far shorter than the other would round to 0; keep at least one pixel.
      width: Math.max(1, Math.round((page.width * OCR_ANALYSIS_MAX_SIDE_PX) / longest)),
      height: Math.max(1, Math.round((page.height * OCR_ANALYSIS_MAX_SIDE_PX) / longest)),
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

function percentileOfHistogram(histogram: Uint32Array, total: number, fraction: number): number {
  const target = Math.max(1, Math.ceil(total * fraction));
  let seen = 0;
  for (let level = 0; level < GRAY_LEVELS; level++) {
    seen += histogram[level];
    if (seen >= target) return level;
  }
  return GRAY_LEVELS - 1;
}

/**
 * How unevenly a page is lit: the page is cut into cells, each cell's background is its brightest
 * level (a high percentile, since ink is a minority of a cell), and the spread of those levels
 * (5th to 95th percentile of the cells) is returned as a share of the contrast between the page's paper (the
 * median cell) and its darkest ink. A uniformly lit page, however noisy, scores near 0; a ramp or a
 * vignette scores high. Pages with too few cells or no contrast score 0.
 */
export function measureUnevenBackground(page: GrayPage): number {
  const cellsAcross = Math.floor(page.width / OCR_BACKGROUND_CELL_PX);
  const cellsDown = Math.floor(page.height / OCR_BACKGROUND_CELL_PX);
  if (cellsAcross * cellsDown < OCR_BACKGROUND_MIN_CELLS) return 0;
  const levels: number[] = [];
  const pageHistogram = new Uint32Array(GRAY_LEVELS);
  const cellHistogram = new Uint32Array(GRAY_LEVELS);
  for (let cy = 0; cy < cellsDown; cy++) {
    for (let cx = 0; cx < cellsAcross; cx++) {
      cellHistogram.fill(0);
      for (let y = cy * OCR_BACKGROUND_CELL_PX; y < (cy + 1) * OCR_BACKGROUND_CELL_PX; y++) {
        const row = y * page.width + cx * OCR_BACKGROUND_CELL_PX;
        for (let x = 0; x < OCR_BACKGROUND_CELL_PX; x++) cellHistogram[page.data[row + x]]++;
      }
      const cellPixels = OCR_BACKGROUND_CELL_PX * OCR_BACKGROUND_CELL_PX;
      levels.push(percentileOfHistogram(cellHistogram, cellPixels, OCR_BACKGROUND_PERCENTILE));
      for (let level = 0; level < GRAY_LEVELS; level++) pageHistogram[level] += cellHistogram[level];
    }
  }
  levels.sort((a, b) => a - b);
  const at = (fraction: number): number => levels[Math.min(levels.length - 1, Math.floor(levels.length * fraction))];
  const paper = at(0.5);
  const ink = percentileOfHistogram(pageHistogram, levels.length * OCR_BACKGROUND_CELL_PX * OCR_BACKGROUND_CELL_PX, OCR_INK_LEVEL_PERCENTILE);
  const contrast = paper - ink;
  if (contrast <= 0) return 0;
  return (at(OCR_BACKGROUND_SPREAD_PERCENTILES.high) - at(OCR_BACKGROUND_SPREAD_PERCENTILES.low)) / contrast;
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
 * No resolution is written into the image: with a 300 dpi hint the WebAssembly engine read the
 * golden pages at a mean 2.7% character error rate, without it at 0.6% (Korean layout analysis
 * suffered most), so the recognizer estimates the resolution itself. A Netpbm header has no
 * resolution field, so that holds by construction.
 */
function encodeGrayPage(pixels: Uint8Array, width: number, height: number): Buffer {
  return isBitonal(pixels) ? encodePbm(pixels, width, height) : encodePgm(pixels, width, height);
}

interface DecodedPage {
  data: Buffer;
  width: number;
  height: number;
  channels: typeof GRAY_CHANNELS | typeof RGB_CHANNELS;
}

/** Decodes the page upright (EXIF orientation applied) and flat on white, as 8-bit gray or RGB samples. */
async function decodeUprightPage(source: Buffer): Promise<DecodedPage> {
  const { space } = await sharp(source).metadata();
  const gray = space === 'b-w' || space === 'grey16';
  const { data, info } = await sharp(source)
    .rotate()
    .flatten({ background: '#ffffff' })
    .toColourspace(gray ? 'b-w' : 'srgb')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== GRAY_CHANNELS && info.channels !== RGB_CHANNELS) {
    throw new OcrPreprocessError(`Expected a gray or RGB page, decoded ${info.channels} channels.`);
  }
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function encodeDecodedPage(page: DecodedPage): Buffer {
  if (page.channels === RGB_CHANNELS) return encodePpm(page.data, page.width, page.height);
  return encodeGrayPage(page.data, page.width, page.height);
}

/** Text rows of a short page, counted on its gray pixels; undefined for a taller page. */
async function smallCropTextRows(page: DecodedPage, sourceHeight: number): Promise<number | undefined> {
  if (sourceHeight > OCR_SMALL_CROP_MAX_HEIGHT_PX) return undefined;
  const gray =
    page.channels === GRAY_CHANNELS
      ? page.data
      : await sharp(page.data, { raw: { width: page.width, height: page.height, channels: page.channels } })
          .greyscale()
          .raw()
          .toBuffer();
  return countTextRows(new Uint8Array(gray.buffer, gray.byteOffset, gray.length), page.width, page.height);
}

/** Geometry of a page that was only turned by quarters: no rescale, no levelling. */
function quarterTurnGeometry(
  sourceWidth: number,
  sourceHeight: number,
  turnedWidth: number,
  turnedHeight: number,
  quarterTurn: OcrQuarterTurn
): OcrGeometry {
  if (quarterTurn === 0) return identityGeometry(sourceWidth, sourceHeight);
  return {
    sourceWidth,
    sourceHeight,
    quarterTurnDegrees: quarterTurn,
    scaledWidth: turnedWidth,
    scaledHeight: turnedHeight,
    outputWidth: turnedWidth,
    outputHeight: turnedHeight,
    rotationDegrees: 0,
  };
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
  steps: OcrPreprocessSteps = OCR_PREPROCESS_STEPS,
  quarterTurn: OcrQuarterTurn = 0
): Promise<OcrPreprocessResult> {
  return preparationSlots.run(() => prepare(source, steps, quarterTurn));
}

/**
 * Turns an 8-bit page clockwise by a multiple of 90 degrees. Exact: every pixel moves, none is
 * resampled, and the page keeps its channels.
 */
async function turnByQuarters(page: DecodedPage, degrees: OcrQuarterTurn): Promise<DecodedPage> {
  if (degrees === 0) return page;
  const { data, info } = await sharp(page.data, {
    raw: { width: page.width, height: page.height, channels: page.channels },
  })
    .rotate(degrees)
    // A turned gray page comes back as three channels unless it is asked for as gray.
    .toColourspace(page.channels === GRAY_CHANNELS ? 'b-w' : 'srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== page.channels) {
    throw new OcrPreprocessError(`Turning the page changed its channels from ${page.channels} to ${info.channels}.`);
  }
  return { data, width: info.width, height: info.height, channels: page.channels };
}

async function prepare(
  source: Buffer,
  steps: OcrPreprocessSteps,
  quarterTurn: OcrQuarterTurn
): Promise<OcrPreprocessResult> {
  const meta = await sharp(source).metadata();
  const swapped = meta.orientation !== undefined && meta.orientation >= 5;
  const width = (swapped ? meta.height : meta.width) ?? 0;
  const height = (swapped ? meta.width : meta.height) ?? 0;
  const unchanged = async (
    lineHeightPx: number | null,
    skewDegrees: number,
    unevenBackground = 0,
    binarizable = false
  ): Promise<OcrPreprocessResult> => {
    const page = await turnByQuarters(await decodeUprightPage(source), quarterTurn);
    return {
      image: encodeDecodedPage(page),
      textRows: await smallCropTextRows(page, page.height),
      geometry: quarterTurnGeometry(width, height, page.width, page.height, quarterTurn),
      lineHeightPx,
      skewDegrees,
      unevenBackground,
      binarizable,
      ink: page.channels === GRAY_CHANNELS ? bandInk(page.data, page.width, page.height, lineHeightPx) : undefined,
      applied: { rescale: false, deskew: false, binarize: false },
    };
  };
  const enabled = steps.rescale || steps.deskew || steps.binarize;
  if (!enabled || width * height > OCR_PREPROCESS_MAX_PIXELS) return unchanged(null, 0);

  // Only the current page is referenced, so the previous stage's buffer can be freed.
  const held = { page: await decodeGray(source) };
  const sourceWidth = held.page.width;
  const sourceHeight = held.page.height;
  if (quarterTurn !== 0) {
    const turnedPage = await turnByQuarters({ ...held.page, channels: GRAY_CHANNELS }, quarterTurn);
    held.page = { data: turnedPage.data, width: turnedPage.width, height: turnedPage.height };
  }
  const analysis = await analysisCopy(held.page);
  const analysisScale = analysis.width / held.page.width;
  const unevenBackground = measureUnevenBackground(analysis);
  const rough = await sauvolaBinarize(analysis.data, analysis.width, analysis.height, {
    windowSize: OCR_ANALYSIS_WINDOW_PX,
  });
  // The skew is always measured: line heights are read off the levelled row profile, because a
  // skewed page's lines run into each other when projected along its rows.
  const skew = await estimateSkew(rough, analysis.width, analysis.height);
  const measured = lineHeightFromProfile(skew.profile);
  const lineHeightPx = measured === null ? null : measured / analysisScale;
  const paper = steps.deskew ? paperLevel(analysis) : 0;

  const scale = steps.rescale ? planRescale(lineHeightPx, held.page.width, held.page.height) : 1;
  if (scale > 1) held.page = await enlarge(held.page, scale);
  const scaledWidth = held.page.width;
  const scaledHeight = held.page.height;

  const trusted = Math.abs(skew.degrees) >= OCR_DESKEW_MIN_DEGREES && skew.improvement >= OCR_DESKEW_MIN_IMPROVEMENT;
  const turned =
    steps.deskew && trusted && turnedPixelCount(scaledWidth, scaledHeight, skew.degrees) <= OCR_PREPROCESS_MAX_PIXELS;
  if (turned) held.page = await turn(held.page, skew.degrees, paper);

  const scaledLineHeight = lineHeightPx === null ? null : lineHeightPx * scale;
  const binarizableWindow = sauvolaWindowFor(scaledLineHeight);
  const binarizeWindow = steps.binarize ? binarizableWindow : null;
  if (scale === 1 && !turned && binarizeWindow === null) {
    return unchanged(lineHeightPx, skew.degrees, unevenBackground, binarizableWindow !== null);
  }

  const pixels =
    binarizeWindow === null
      ? held.page.data
      : await sauvolaBinarize(held.page.data, held.page.width, held.page.height, { windowSize: binarizeWindow });
  const finalPage: DecodedPage = {
    data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length),
    width: held.page.width,
    height: held.page.height,
    channels: GRAY_CHANNELS,
  };
  return {
    image: encodeGrayPage(pixels, held.page.width, held.page.height),
    // A label is judged by its height as submitted, before it is enlarged; after a quarter turn that is its width.
    textRows: await smallCropTextRows(finalPage, quarterTurn === 90 || quarterTurn === 270 ? sourceWidth : sourceHeight),
    geometry: {
      sourceWidth,
      sourceHeight,
      ...(quarterTurn === 0 ? {} : { quarterTurnDegrees: quarterTurn }),
      scaledWidth,
      scaledHeight,
      outputWidth: held.page.width,
      outputHeight: held.page.height,
      rotationDegrees: turned ? skew.degrees : 0,
    },
    lineHeightPx,
    skewDegrees: skew.degrees,
    unevenBackground,
    binarizable: binarizableWindow !== null,
    ink: bandInk(pixels, held.page.width, held.page.height, scaledLineHeight),
    applied: { rescale: scale > 1, deskew: turned, binarize: binarizeWindow !== null },
  };
}
