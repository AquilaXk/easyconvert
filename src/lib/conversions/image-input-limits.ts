import sharp, { type Sharp, type SharpOptions } from 'sharp';
import { ConversionFailedError } from '../types';
import {
  DEFAULT_MAX_INPUT_PIXELS,
  INPUT_PIXEL_LIMIT_HTTP_STATUS,
  MAX_INPUT_PIXELS_CEILING,
  MAX_INPUT_PIXELS_ENV,
} from './image-input-limit-config';

/**
 * Pixel budget for still-image inputs. The declared canvas is read from the container header before any pixel
 * is decoded, so a tiny file that declares a huge picture is refused instead of exhausting worker memory.
 * The limit itself and its rationale are in `image-input-limit-config.ts`.
 */

export { DEFAULT_MAX_INPUT_PIXELS, INPUT_PIXEL_LIMIT_HTTP_STATUS, MAX_INPUT_PIXELS_CEILING, MAX_INPUT_PIXELS_ENV };

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
 * HDR tone mapping holds the decoded samples (2 B each), the luminance array (4 B each) and the rendition, about
 * 30 B per pixel. 36 megapixels (the OpenEXR decoder's limit) keeps a job near 1.1 GB.
 */
export const HDR_TONE_MAP_PIXEL_BUDGET: PixelBudget = { maxPixels: 36_000_000, scope: 'HDR tone mapping' };

/** A whole number of pixels in plain decimal digits: no sign, exponent, fraction or radix prefix. */
const DECIMAL_PIXEL_COUNT = /^\d{1,64}$/;

/** Override values already parsed (by their exact text), so each is parsed and, when malformed, reported once. */
const parsedOverrides = new Map<string, number>();

function parseOverride(raw: string): number {
  const text = raw.trim();
  const value = DECIMAL_PIXEL_COUNT.test(text) ? Number(text) : 0;
  if (value >= 1) return Math.min(value, MAX_INPUT_PIXELS_CEILING);
  console.warn(
    `${MAX_INPUT_PIXELS_ENV}=${JSON.stringify(raw)} is not a positive whole number of pixels; using the default of ${DEFAULT_MAX_INPUT_PIXELS} pixels.`
  );
  return DEFAULT_MAX_INPUT_PIXELS;
}

/**
 * The input pixel limit in force: the default, or `EASYCONVERT_MAX_INPUT_PIXELS` when it holds a positive
 * whole number of pixels in decimal digits. A larger value is lowered to the ceiling. A malformed value is
 * reported once in the log and replaced by the default, so a typo never disables the guard and never fails
 * every request.
 */
export function maxInputPixels(env: Record<string, string | undefined> = process.env): number {
  const raw = env[MAX_INPUT_PIXELS_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_INPUT_PIXELS;
  let value = parsedOverrides.get(raw);
  if (value === undefined) {
    value = parseOverride(raw);
    parsedOverrides.set(raw, value);
  }
  return value;
}

/** True when `pixels` is over `limit`; a count that is not a finite number is over every limit. */
function exceeds(pixels: number, limit: number): boolean {
  return !Number.isFinite(pixels) || pixels > limit;
}

/** Throws `InputPixelLimitError` when `width` x `height` pixels exceed the input limit. */
export function assertInputPixels(width: number, height: number): void {
  const limit = maxInputPixels();
  if (exceeds(width * height, limit)) {
    throw new InputPixelLimitError(limit, width, height);
  }
}

/** The resize request of a conversion: the requested sides and how the picture is fitted to them. */
export interface ResizeRequest {
  width?: number | string;
  height?: number | string;
  fit?: string;
}

/**
 * The size a `width` x `height` picture has after the resize `request` (sharp's rules for `fit`: `fill`, `cover`
 * and `contain` give the requested box, `inside` and `outside` keep the aspect ratio inside or outside it, and
 * a single side scales the other). Lets a budget be checked from the header before the picture is decoded.
 */
export function resizedDimensions(width: number, height: number, request: ResizeRequest): { width: number; height: number } {
  const wanted = { width: Number(request.width) || undefined, height: Number(request.height) || undefined };
  if (wanted.width === undefined && wanted.height === undefined) return { width, height };
  if (wanted.width !== undefined && wanted.height !== undefined) {
    if (request.fit !== 'inside' && request.fit !== 'outside') return { width: wanted.width, height: wanted.height };
    const choose = request.fit === 'inside' ? Math.min : Math.max;
    const scale = choose(wanted.width / width, wanted.height / height);
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  }
  const scale = wanted.width !== undefined ? wanted.width / width : (wanted.height as number) / height;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Throws `InputPixelLimitError` when `width` x `height` pixels exceed `budget` (or a lower input limit). */
export function assertPixelBudget(width: number, height: number, budget: PixelBudget): void {
  const limit = Math.min(budget.maxPixels, maxInputPixels());
  if (exceeds(width * height, limit)) {
    throw new InputPixelLimitError(limit, width, height, budget.scope);
  }
}

/**
 * Opens an image for decoding with sharp's own pixel check set from the same limit, so the native decoder
 * enforces it even where the header could not be read in advance.
 */
export function openLimitedSharp(input: Buffer, options: SharpOptions = {}): Sharp {
  return sharp(input, { ...options, limitInputPixels: maxInputPixels() });
}

/**
 * Reads the declared dimensions from the container header (no pixel is decoded) and throws
 * `InputPixelLimitError` when they exceed the input limit. A header sharp cannot read is refused with a
 * `ConversionFailedError`: a lenient decoder (pdfkit, pdf-lib) may accept bytes that libvips rejects, so an
 * unreadable header proves nothing about the size.
 */
export async function assertEncodedImageWithinLimit(input: Buffer, budget?: PixelBudget, options: SharpOptions = {}): Promise<void> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    const meta = await sharp(input, { ...options, limitInputPixels: false }).metadata();
    ({ width, height } = meta);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConversionFailedError(`Invalid image: the header could not be decoded (${reason}).`);
  }
  if (width === undefined || height === undefined) {
    throw new ConversionFailedError('Invalid image: the header declares no dimensions.');
  }
  assertInputPixels(width, height);
  if (budget) assertPixelBudget(width, height, budget);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8]);

/** True for the two formats pdfkit and pdf-lib decode themselves, recognised by their magic bytes. */
export function isPngOrJpeg(input: Buffer): boolean {
  return input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || input.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE);
}

/**
 * For an image that is about to be embedded in a document: PNG and JPEG are decoded by the document writer
 * itself, so their header must be readable and within the limit. Any other bytes are refused by the writer, so
 * they need no check here.
 */
export async function assertEmbeddableImageWithinLimit(input: Buffer): Promise<void> {
  if (isPngOrJpeg(input)) await assertEncodedImageWithinLimit(input);
}

/** Checks the declared dimensions of an encoded image, then opens it for decoding under the same limit. */
export async function openInputImage(input: Buffer, options: SharpOptions = {}): Promise<Sharp> {
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
