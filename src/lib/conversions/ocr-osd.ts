import sharp from 'sharp';
import { OcrEngineUnavailableError } from '../types';
import { OCR_OEM_LEGACY_ONLY } from './ocr-config';
import type { OcrQuarterTurn } from './ocr-geometry';
import { encodePgm } from './pnm';
import { getSharedOcrWorkerPool } from './ocr-worker-pool';
import { runOsdWithCli } from './ocr-cli';

/**
 * Orientation and script detection (Tesseract's OSD). A page scanned sideways or upside down comes
 * out of recognition as garbage with a low mean word score, while an upright page scores 0.9 and
 * more. So the page is first read as it is, and only a page that reads badly (OSD_SUSPECT_QUALITY)
 * is looked at: the engine reports the turn that would make its text upright and its script, the
 * page is read again turned by that multiple of 90 degrees (and in the script's language when the
 * request named none), and the second reading replaces the first only if it scores higher. A page
 * that reads well therefore costs nothing extra and can never be turned by a wrong reading. The
 * engine's reading and what was done with it are recorded on the result.
 *
 * The reading is taken from a window of the page rather than the whole of it: orientation needs
 * text at a size the engine can classify, and a letter page at 300 dpi scaled down to a small
 * copy loses that (on the golden pages a 1280 px copy read an upside-down page as upright), while
 * a window of OSD_WINDOW_PX at full resolution holds a dozen lines of text at their real size and
 * costs a fraction of the whole page.
 */

/** Data package the engine needs for detection; shipped with the `tesseract-ocr` package. */
export const OSD_LANGUAGE = 'osd';
/** Side of the window the reading is taken from, in pixels of the page as scanned. */
export const OSD_WINDOW_PX = 1024;
/** The page is searched for its densest window on a grid of cells of this many pixels. */
export const OSD_GRID_CELL_PX = 32;
/** A page above this many pixels is scaled down once, before windowing, so one reading never holds a huge page. */
export const OSD_MAX_DECODE_PIXELS = 16_000_000;
/** The densest window must hold at least this share of ink (against the paper) to be worth reading. */
export const OSD_MIN_INK_RATIO = 0.004;
/**
 * The engine's confidence in a turn must reach this for the page to be read again turned. Read off
 * the golden pages rotated by 90, 180 and 270 degrees (tests/ocr-orientation.test.ts): the engine's
 * readings of text at 10 px and above scored 2.2 and more and were right every time, while the
 * readings that were wrong or garbage (pages scanned at 72 dpi, text under 8 px) mostly scored
 * under 2 and at most 3.3. A reading in between is still checked by the second reading below.
 */
export const OSD_MIN_CONFIDENCE = 2;
/**
 * The script only picks the recognition language when its own confidence reaches this: the lowest
 * script confidence of a correctly read Korean or Japanese golden page was 0.17.
 */
export const OSD_MIN_SCRIPT_CONFIDENCE = 0.1;
/**
 * A first reading whose mean word score (weighted by characters) is below this is suspect, and the
 * page is looked at. Upright golden pages score 0.92 and more at every degradation; pages scanned
 * upside down or sideways, or read in the wrong language, score 0.62 and less.
 */
export const OSD_SUSPECT_QUALITY = 0.8;
/** A second reading, with the page turned or in another language, replaces the first only if it scores this much higher. */
export const OSD_MIN_QUALITY_GAIN = 0.05;
/** Wall-clock limit of one detection. */
export const OSD_TIMEOUT_MS = 15_000;

const QUARTER_TURNS: ReadonlySet<number> = new Set([0, 90, 180, 270]);
const FULL_TURN_DEGREES = 360;
const PAPER_LEVEL_MAX = 255;

/** What the engine read: the clockwise turn that makes the text upright, and how sure it is. */
export interface OsdReading {
  rotateDegrees: OcrQuarterTurn;
  orientationConfidence: number;
  script: string;
  scriptConfidence: number;
}

/** The outcome of detection, recorded on the OCR result. */
export interface OcrOrientation {
  /**
   * `not-needed` the page read well, so it was not examined; `applied` the page was read again turned
   * and that scored better; `not-better` the second reading did not score better, so the first
   * stands; `upright` the engine found the page upright (a language chosen from the script is
   * recorded in `languageFromScript`);
   * `low-confidence` the engine wanted a turn but was not sure enough; `too-little-text` there was
   * too little text to read; `disabled` detection was switched off; `unavailable` the engine or its
   * data was not there.
   */
  status:
    | 'not-needed'
    | 'applied'
    | 'not-better'
    | 'upright'
    | 'low-confidence'
    | 'too-little-text'
    | 'disabled'
    | 'unavailable';
  /** Clockwise turn applied to the page before recognition, in degrees. */
  rotationApplied: OcrQuarterTurn;
  /** The engine's confidence in the turn it suggested, when it read the page. */
  confidence?: number;
  /** The turn the engine suggested, whether or not it was applied. */
  suggestedRotation?: OcrQuarterTurn;
  /** The script it read (`Latin`, `Korean`, `Japanese`, ...), with its confidence. */
  script?: string;
  scriptConfidence?: number;
  /** The recognition language chosen from the script, when the request named none. */
  languageFromScript?: string;
}

function malformed(message: string): OcrEngineUnavailableError {
  return new OcrEngineUnavailableError(`Malformed Tesseract OSD output: ${message}`);
}

/**
 * Checks and normalizes one reading, whichever engine produced it: the WebAssembly worker reports
 * numbers, the command line tool prints text that `parseOsdOutput` turns into the same numbers.
 */
export function normalizeOsdReading(raw: {
  rotateDegrees: number;
  orientationConfidence: number;
  script: string;
  scriptConfidence: number;
}): OsdReading {
  if (!QUARTER_TURNS.has(raw.rotateDegrees)) throw malformed(`a turn of ${raw.rotateDegrees} degrees is not a multiple of 90.`);
  for (const value of [raw.orientationConfidence, raw.scriptConfidence]) {
    if (!Number.isFinite(value) || value < 0) throw malformed('a confidence is not a non-negative number.');
  }
  if (raw.script === '') throw malformed('the script is missing.');
  return {
    rotateDegrees: raw.rotateDegrees as OcrQuarterTurn,
    orientationConfidence: raw.orientationConfidence,
    script: raw.script,
    scriptConfidence: raw.scriptConfidence,
  };
}

function field(text: string, label: string): string {
  const match = new RegExp(`^${label}:[ \\t]*(.+)$`, 'm').exec(text);
  if (!match) throw malformed(`the '${label}' line is missing.`);
  return match[1].trim();
}

/** Reads the report `tesseract --psm 0` prints (page number, orientation, rotation, script, confidences). */
export function parseOsdOutput(text: string): OsdReading {
  const orientation = Number(field(text, 'Orientation in degrees'));
  const reading = normalizeOsdReading({
    rotateDegrees: Number(field(text, 'Rotate')),
    orientationConfidence: Number(field(text, 'Orientation confidence')),
    script: field(text, 'Script'),
    scriptConfidence: Number(field(text, 'Script confidence')),
  });
  // The two lines describe the same turn from either side; a report that disagrees with itself is not trusted.
  if ((orientation + reading.rotateDegrees) % FULL_TURN_DEGREES !== 0) {
    throw malformed(`orientation ${orientation} and rotation ${reading.rotateDegrees} do not match.`);
  }
  return reading;
}

interface GrayPixels {
  data: Buffer;
  width: number;
  height: number;
}

/** The page upright and flat on white as 8-bit gray, scaled down once when it is very large. */
async function decodeForDetection(source: Buffer): Promise<GrayPixels> {
  const meta = await sharp(source).metadata();
  const swapped = meta.orientation !== undefined && meta.orientation >= 5;
  const width = (swapped ? meta.height : meta.width) ?? 0;
  const height = (swapped ? meta.width : meta.height) ?? 0;
  let pipeline = sharp(source).rotate().flatten({ background: '#ffffff' }).greyscale();
  if (width * height > OSD_MAX_DECODE_PIXELS) {
    const shrink = Math.sqrt(OSD_MAX_DECODE_PIXELS / (width * height));
    pipeline = pipeline.resize({ width: Math.max(1, Math.floor(width * shrink)), height: Math.max(1, Math.floor(height * shrink)), fit: 'fill' });
  }
  const { data, info } = await pipeline.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Paper level of the grid: its median, so a toned or shaded sheet does not count as ink. */
function medianLevel(levels: Float64Array): number {
  const sorted = Float64Array.from(levels).sort();
  return sorted[sorted.length >> 1];
}

/**
 * The window of the page that holds the most ink, as the PGM the engine reads, or null when even
 * the densest window is nearly blank. Ink is the darkness below the paper level, summed over cells
 * of OSD_GRID_CELL_PX; the window is OSD_WINDOW_PX square (smaller at the page edge) at full resolution.
 */
export async function densestTextWindow(source: Buffer): Promise<{ pgm: Buffer; inkRatio: number } | null> {
  const page = await decodeForDetection(source);
  const cell = OSD_GRID_CELL_PX;
  const gridWidth = Math.ceil(page.width / cell);
  const gridHeight = Math.ceil(page.height / cell);
  const levels = new Float64Array(gridWidth * gridHeight);
  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      let sum = 0;
      let count = 0;
      const y1 = Math.min(page.height, (gy + 1) * cell);
      const x1 = Math.min(page.width, (gx + 1) * cell);
      for (let y = gy * cell; y < y1; y++) {
        for (let x = gx * cell; x < x1; x++) {
          sum += page.data[y * page.width + x];
          count++;
        }
      }
      levels[gy * gridWidth + gx] = sum / count;
    }
  }
  const paper = medianLevel(levels);
  // Integral image of ink, one row and column larger than the grid.
  const stride = gridWidth + 1;
  const integral = new Float64Array(stride * (gridHeight + 1));
  for (let gy = 0; gy < gridHeight; gy++) {
    let row = 0;
    for (let gx = 0; gx < gridWidth; gx++) {
      row += Math.max(0, paper - levels[gy * gridWidth + gx]);
      integral[(gy + 1) * stride + gx + 1] = integral[gy * stride + gx + 1] + row;
    }
  }
  const windowCells = Math.floor(OSD_WINDOW_PX / cell);
  const spanX = Math.min(gridWidth, windowCells);
  const spanY = Math.min(gridHeight, windowCells);
  let best = -1;
  let bestX = 0;
  let bestY = 0;
  for (let gy = 0; gy + spanY <= gridHeight; gy++) {
    for (let gx = 0; gx + spanX <= gridWidth; gx++) {
      const ink =
        integral[(gy + spanY) * stride + gx + spanX] -
        integral[gy * stride + gx + spanX] -
        integral[(gy + spanY) * stride + gx] +
        integral[gy * stride + gx];
      if (ink > best) {
        best = ink;
        bestX = gx;
        bestY = gy;
      }
    }
  }
  const inkRatio = best / (spanX * spanY * PAPER_LEVEL_MAX);
  if (inkRatio < OSD_MIN_INK_RATIO) return null;

  const left = bestX * cell;
  const top = bestY * cell;
  const width = Math.min(OSD_WINDOW_PX, page.width - left);
  const height = Math.min(OSD_WINDOW_PX, page.height - top);
  const window = Buffer.allocUnsafe(width * height);
  for (let y = 0; y < height; y++) {
    page.data.copy(window, y * width, (top + y) * page.width + left, (top + y) * page.width + left + width);
  }
  return { pgm: encodePgm(window, width, height), inkRatio };
}

export interface OsdEngines {
  /** Directory holding `osd.traineddata`. */
  tessdataDir: string;
  gzip: boolean;
  /** The native tool, used when the WebAssembly worker fails; absent when it is not installed. */
  cliPath?: string;
}

/** `null` means the engine found too little text to read. */
async function readWithWasm(pgm: Buffer, engines: OsdEngines): Promise<OsdReading | null> {
  const detected = await getSharedOcrWorkerPool().run(
    { langs: OSD_LANGUAGE, langPath: engines.tessdataDir, gzip: engines.gzip, engineMode: OCR_OEM_LEGACY_ONLY, parameters: {} },
    (_recognize, _recognizeWith, detect) => detect(pgm)
  );
  const data = detected.data;
  if (data.orientation_degrees === null || data.orientation_degrees === undefined) return null;
  return normalizeOsdReading({
    rotateDegrees: data.orientation_degrees,
    orientationConfidence: data.orientation_confidence ?? Number.NaN,
    script: data.script ?? '',
    scriptConfidence: data.script_confidence ?? Number.NaN,
  });
}

/**
 * Reads the turn and script of a page from its densest window. WebAssembly first, the native tool
 * when that fails (the same order recognition uses). Returns null when the page holds too little
 * text, and throws OcrEngineUnavailableError (503) when neither engine could read it.
 */
export async function readOrientation(source: Buffer, engines: OsdEngines): Promise<OsdReading | null> {
  const window = await densestTextWindow(source);
  if (window === null) return null;
  try {
    return await readWithWasm(window.pgm, engines);
  } catch (err) {
    if (!engines.cliPath) throw err;
    // Fall back to the native tool below.
  }
  const output = await runOsdWithCli({
    cliPath: engines.cliPath,
    tessdataDir: engines.tessdataDir,
    image: window.pgm,
    timeoutMs: OSD_TIMEOUT_MS,
  });
  return output === null ? null : parseOsdOutput(output);
}

/**
 * Whether to turn the page, and the record of the decision. The turn is applied only when the engine
 * is at least OSD_MIN_CONFIDENCE sure of it.
 */
export function decideOrientation(reading: OsdReading | null): { orientation: OcrOrientation; quarterTurn: OcrQuarterTurn } {
  if (reading === null) return { orientation: { status: 'too-little-text', rotationApplied: 0 }, quarterTurn: 0 };
  const base = {
    confidence: reading.orientationConfidence,
    suggestedRotation: reading.rotateDegrees,
    script: reading.script,
    scriptConfidence: reading.scriptConfidence,
  };
  if (reading.rotateDegrees === 0) return { orientation: { status: 'upright', rotationApplied: 0, ...base }, quarterTurn: 0 };
  if (reading.orientationConfidence < OSD_MIN_CONFIDENCE) {
    return { orientation: { status: 'low-confidence', rotationApplied: 0, ...base }, quarterTurn: 0 };
  }
  return {
    orientation: { status: 'applied', rotationApplied: reading.rotateDegrees, ...base },
    quarterTurn: reading.rotateDegrees,
  };
}

/** Recognition language for a script, for requests that did not name one. */
const LANGUAGE_FOR_SCRIPT: Readonly<Record<string, string>> = {
  Korean: 'kor',
  Japanese: 'jpn',
  HanS: 'chi_sim',
  HanT: 'chi_tra',
};

/**
 * The language the detected script calls for, or null when there is none to pick (Latin text keeps
 * the default), the reading is not trusted, or the script's own confidence is too low.
 */
export function languageForScript(orientation: OcrOrientation): string | null {
  if (orientation.script === undefined || orientation.scriptConfidence === undefined) return null;
  if (orientation.status === 'low-confidence' || orientation.status === 'too-little-text') return null;
  if (orientation.confidence === undefined || orientation.confidence < OSD_MIN_CONFIDENCE) return null;
  if (orientation.scriptConfidence < OSD_MIN_SCRIPT_CONFIDENCE) return null;
  return LANGUAGE_FOR_SCRIPT[orientation.script] ?? null;
}
