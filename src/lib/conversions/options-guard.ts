import { UnsupportedOptionError, type ConversionOptions } from '../types';

/** Message of the typed error for options that are not a JSON object. */
export const OPTIONS_NOT_OBJECT_MESSAGE = 'Conversion options must be a JSON object.';

/**
 * Conversion options arrive as parsed request JSON. Only a JSON object is options: null, arrays,
 * numbers, strings and booleans are client errors, never silently spread into `{}` or an
 * index-keyed object.
 */
export function isConversionOptionsObject(value: unknown): value is ConversionOptions {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws UnsupportedOptionError (HTTP 400) unless the options are a JSON object. */
export function assertConversionOptionsObject(value: unknown): asserts value is ConversionOptions {
  if (!isConversionOptionsObject(value)) throw new UnsupportedOptionError(OPTIONS_NOT_OBJECT_MESSAGE);
}
