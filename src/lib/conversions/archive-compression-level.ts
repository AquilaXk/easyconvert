import { UnsupportedOptionError } from '../types';

/** Lowest `compressionLevel` an archive request may carry: store without compressing. */
export const ARCHIVE_COMPRESSION_LEVEL_MIN = 0;
/** Highest `compressionLevel` an archive request may carry. */
export const ARCHIVE_COMPRESSION_LEVEL_MAX = 9;
/** Level every archive writer uses when the request names none. */
export const ARCHIVE_COMPRESSION_LEVEL_DEFAULT = 6;

/**
 * The level an archive writer runs at: the default when the option is absent, the value itself when it is an integer
 * in range. Anything else is refused (HTTP 400), never clamped.
 */
export function resolveArchiveCompressionLevel(value: unknown): number {
  if (value === undefined || value === null) return ARCHIVE_COMPRESSION_LEVEL_DEFAULT;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < ARCHIVE_COMPRESSION_LEVEL_MIN ||
    value > ARCHIVE_COMPRESSION_LEVEL_MAX
  ) {
    throw new UnsupportedOptionError(
      `Option "compressionLevel" must be an integer from ${ARCHIVE_COMPRESSION_LEVEL_MIN} to ${ARCHIVE_COMPRESSION_LEVEL_MAX}; got ${JSON.stringify(value) ?? typeof value}.`
    );
  }
  return value;
}
