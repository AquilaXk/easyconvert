import sharp from 'sharp';
import { ConversionFailedError } from '../types';

/**
 * Pixel budget for still-image inputs. The declared canvas is read from the container header before any pixel
 * is decoded, so a tiny file that declares a huge picture is refused instead of exhausting worker memory.
 * Output and animation budgets live in `image-limits.ts`; this module only guards what is read.
 */

/** Environment variable that overrides the default input pixel limit (a whole number of pixels). */
export const MAX_INPUT_PIXELS_ENV = 'EASYCONVERT_MAX_INPUT_PIXELS';

/**
 * Most pixels a still image may declare by default (100 megapixels): a 400 MB raster as 8-bit RGBA. Measured as
 * peak RSS added by a 10000 x 10000 PNG on the sharp encoders: PNG 31 MB, TIFF 66 MB, WebP 480 MB, JPEG 664 MB,
 * which fits the worker budget of docker-compose.yml (10 GiB per container shared by 3 concurrent jobs). It
 * matches the output limit (`MAX_OUTPUT_PIXELS`), so anything accepted can be converted back at its own size,
 * and it covers camera and scanner formats. The per-pixel JavaScript quantizers (Oklab, Riemersma, blue noise)
 * hold far more per pixel (about 2.8 GB at 5000 x 5000) and need their own, tighter budget.
 */
export const DEFAULT_MAX_INPUT_PIXELS = 100_000_000;

/**
 * Hard ceiling for the override: 16383 x 16383 pixels, the largest canvas of a WebP and sharp's own default
 * limit. An operator cannot raise the limit past what the native decoder would accept anyway.
 */
export const MAX_INPUT_PIXELS_CEILING = 268_402_689;

/** HTTP status that a rejected input maps to (RFC 9110 section 15.5.14, Content Too Large). */
export const INPUT_PIXEL_LIMIT_HTTP_STATUS = 413;

/** Message sharp (libvips) raises when its own `limitInputPixels` check fails. */
const NATIVE_PIXEL_LIMIT_MESSAGE = 'Input image exceeds pixel limit';

/**
 * An image that declares more pixels than the input limit, or than the budget of the conversion path it
 * needs (`scope` names that path); the API answers HTTP 413 and states the limit.
 */
export class InputPixelLimitError extends ConversionFailedError {
  readonly status = INPUT_PIXEL_LIMIT_HTTP_STATUS;
  readonly limit: number;
  readonly width?: number;
  readonly height?: number;

  constructor(limit: number, width?: number, height?: number, scope?: string) {
    const declared = width === undefined || height === undefined ? 'more pixels than the limit' : `${width}x${height} pixels (${width * height} pixels)`;
    const bound = scope === undefined ? `the input limit of ${limit} pixels` : `the limit of ${limit} pixels for ${scope}`;
    super(`The input image declares ${declared}, over ${bound}`);
    this.name = 'InputPixelLimitError';
    this.limit = limit;
    this.width = width;
    this.height = height;
  }
}

/** A pixel budget for a conversion path that holds the whole picture in process memory, several times over. */
export interface PixelBudget {
  readonly maxPixels: number;
  /** What the budget protects, for the error message. */
  readonly scope: string;
}

/**
 * Per-pixel JavaScript palette quantizers (Oklab, Riemersma) hold the raster plus Oklab and error-diffusion
 * working arrays. Peak RSS added, measured per path in its own process: 1.27 GB at 4000 x 4000 (83 B/pixel),
 * 2.85 GB at 5000 x 5000, 3.9 GB at 6000 x 6000, 5.2 GB at 8000 x 8000. 16 megapixels keeps one job at about
 * 1.3 GB of the 3.3 GB share that docker-compose.yml gives each of 3 concurrent jobs.
 */
export const QUANTIZER_PIXEL_BUDGET: PixelBudget = { maxPixels: 16_000_000, scope: 'Oklab and Riemersma palette quantization' };

/**
 * Camera RAW sensors are demosaiced and colour-processed as float arrays in process. Peak RSS added by a
 * 16-bit DNG converted to JPEG: 629 MB at 16 MP, 2.4 GB at 62.4 MP (about 40 B/pixel, 40 s). 64 megapixels
 * admits the 61 MP full-frame sensors at about 2.6 GB per job, and nothing larger.
 */
export const RAW_SENSOR_PIXEL_BUDGET: PixelBudget = { maxPixels: 64_000_000, scope: 'camera RAW sensor decoding' };

/**
 * Ultra HDR reconstruction decodes the SDR base and the gain map and expands them to a float radiance array.
 * Peak RSS added: 235 MB at 16 MP for PNG output (15 B/pixel), 446 MB for EXR output (29 B/pixel). 64
 * megapixels keeps the worst target near 1.9 GB per job.
 */
export const HDR_FLOAT_PIXEL_BUDGET: PixelBudget = { maxPixels: 64_000_000, scope: 'Ultra HDR float reconstruction' };

/**
 * The input pixel limit in force: the default, or `EASYCONVERT_MAX_INPUT_PIXELS` when set to a whole number
 * of pixels. A larger value is lowered to the ceiling; a value that is not a positive whole number throws,
 * so a typo cannot silently disable the guard.
 */
export function maxInputPixels(env: Record<string, string | undefined> = process.env): number {
  const raw = env[MAX_INPUT_PIXELS_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_INPUT_PIXELS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${MAX_INPUT_PIXELS_ENV} must be a positive whole number of pixels, got ${JSON.stringify(raw)}`);
  }
  return Math.min(value, MAX_INPUT_PIXELS_CEILING);
}

/** Throws `InputPixelLimitError` when `width` x `height` pixels exceed the input limit. */
export function assertInputPixels(width: number, height: number): void {
  const limit = maxInputPixels();
  if (!(width * height <= limit)) {
    throw new InputPixelLimitError(limit, width, height);
  }
}

/** Throws `InputPixelLimitError` when `width` x `height` pixels exceed `budget` (or a lower input limit). */
export function assertPixelBudget(width: number, height: number, budget: PixelBudget): void {
  const limit = Math.min(budget.maxPixels, maxInputPixels());
  if (!(width * height <= limit)) {
    throw new InputPixelLimitError(limit, width, height, budget.scope);
  }
}

/**
 * Opens an image for decoding with sharp's own pixel check set from the same limit, so the native decoder
 * enforces it even where the header could not be read in advance.
 */
export function openLimitedSharp(input: Buffer, options: sharp.SharpOptions = {}): sharp.Sharp {
  return sharp(input, { ...options, limitInputPixels: maxInputPixels() });
}

/**
 * Reads the declared dimensions from the container header (no pixel is decoded) and throws
 * `InputPixelLimitError` when they exceed the input limit. A header sharp cannot read is left to the decode
 * that follows, which reports it as malformed input.
 */
export async function assertEncodedImageWithinLimit(input: Buffer, budget?: PixelBudget, options: sharp.SharpOptions = {}): Promise<void> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    const meta = await sharp(input, { ...options, limitInputPixels: false }).metadata();
    ({ width, height } = meta);
  } catch {
    return;
  }
  if (width !== undefined && height !== undefined) {
    assertInputPixels(width, height);
    if (budget) assertPixelBudget(width, height, budget);
  }
}

/** Checks the declared dimensions of an encoded image, then opens it for decoding under the same limit. */
export async function openInputImage(input: Buffer, options: sharp.SharpOptions = {}): Promise<sharp.Sharp> {
  await assertEncodedImageWithinLimit(input, undefined, options);
  return openLimitedSharp(input, options);
}

/** Turns sharp's untyped pixel-limit failure into `InputPixelLimitError`; any other error is returned as is. */
export function asInputPixelLimitError(error: unknown): unknown {
  if (error instanceof Error && error.message.includes(NATIVE_PIXEL_LIMIT_MESSAGE)) {
    return new InputPixelLimitError(maxInputPixels());
  }
  return error;
}

/** For `catch` blocks that tolerate a broken image: rethrows a pixel-limit rejection (typed or native) and ignores the rest. */
export function rethrowInputPixelLimit(error: unknown): void {
  const mapped = asInputPixelLimitError(error);
  if (mapped instanceof InputPixelLimitError) throw mapped;
}
