/**
 * Constants of the still-image input pixel limit. They live apart from `image-input-limits.ts` so that
 * documentation (the OpenAPI document) can state them without loading the native image decoder.
 */

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
