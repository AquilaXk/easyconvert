const COMPOUND_ARCHIVE_EXT_PATTERN = /\.(tar\.(?:gz|bz2|bz|xz|7z|lz|lzma|lzo|z|zst))$/i;
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:/;
// Strip ASCII control characters (NUL, CR, LF, etc.) that corrupt headers or ZIP entry validation.
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]/g;

/**
 * Extracts a safe single leaf filename from untrusted header, job-result, or session-storage values.
 * Splits across path separators before removing control characters so newline-prefixed traversals cannot linger.
 */
export function sanitizeDownloadLeafFilename(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const leaf = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = leaf.replace(CONTROL_CHARS_PATTERN, '').replace(WINDOWS_DRIVE_PREFIX, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return undefined;
  return cleaned;
}

/**
 * Extracts the lowercase extension without its leading dot, preserving compound `.tar.*` suffixes
 * before falling back to a single trailing extension.
 */
export function extractDownloadExtension(filename: string): string | undefined {
  const compound = COMPOUND_ARCHIVE_EXT_PATTERN.exec(filename);
  if (compound) return compound[1].toLowerCase();
  const single = /\.([^/.]+)$/.exec(filename);
  return single ? single[1].toLowerCase() : undefined;
}
