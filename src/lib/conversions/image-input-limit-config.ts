import { ConversionFailedError } from '../types';
import type { ConversionRefusalCode } from '../refusal-codes';

/** Environment variable that overrides the default input pixel limit (a whole number of pixels). */
export const MAX_INPUT_PIXELS_ENV = 'EASYCONVERT_MAX_INPUT_PIXELS';

/**
 * Most pixels a still image may declare by default (100 megapixels): a 400 MB raster as 8-bit RGBA, and about
 * the largest picture the common encoders convert inside a job's share of the worker memory. Peak RSS added by
 * a 10000 x 10000 PNG, measured per target: PNG 31 MB, TIFF 66 MB, WebP 480 MB, JPEG 664 MB, against the
 * 10 GiB per worker container that docker-compose.yml shares between 3 concurrent jobs. It admits every
 * camera and scanner format in use (medium-format backs reach 100 MP). The per-pixel JavaScript paths hold far
 * more per pixel and have tighter budgets of their own (`QUANTIZER_PIXEL_BUDGET` and the others).
 */
export const DEFAULT_MAX_INPUT_PIXELS = 100_000_000;

/**
 * Hard ceiling for the override: 16383 x 16383 pixels, the largest canvas of a WebP and sharp's own default
 * limit. An operator cannot raise the limit past what the native decoder would accept anyway.
 */
export const MAX_INPUT_PIXELS_CEILING = 268_402_689;

/** HTTP status that a rejected input maps to (RFC 9110 section 15.5.14, Content Too Large). */
export const INPUT_PIXEL_LIMIT_HTTP_STATUS = 413;

export class InputPixelLimitError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'input_over_limit';
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

const DECIMAL_PIXEL_COUNT = /^\d{1,64}$/;
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

export function maxInputPixels(env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}): number {
  const raw = env[MAX_INPUT_PIXELS_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_INPUT_PIXELS;
  let value = parsedOverrides.get(raw);
  if (value === undefined) {
    value = parseOverride(raw);
    parsedOverrides.set(raw, value);
  }
  return value;
}
