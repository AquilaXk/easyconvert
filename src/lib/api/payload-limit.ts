import { InputPixelLimitError } from '../conversions/image-input-limits';
import { Woff2LimitError } from '../conversions/font-woff2-primitives';
import { PayloadLimitError } from '../types';

/** HTTP status of a WOFF2 file or font past the limits of the codec. */
const WOFF2_LIMIT_STATUS = 413;

/**
 * The HTTP status of an error that reports a size limit: a stream that decodes past a byte limit, an image that
 * declares more pixels than allowed, a WOFF2 past the limits of the codec. These answer 413 whichever route
 * catches them, ahead of the generic 400 or 422 of a ConversionFailedError. Null for every other error.
 */
export function payloadLimitStatus(error: unknown): number | null {
  if (error instanceof PayloadLimitError || error instanceof InputPixelLimitError) return error.status;
  if (error instanceof Woff2LimitError) return WOFF2_LIMIT_STATUS;
  return null;
}
