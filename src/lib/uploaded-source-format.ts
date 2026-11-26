import { detectFormatFromFilename, FORMAT_REGISTRY, getFormatByExtension } from './registry';

const COMPOUND_FORMAT_EXTENSIONS: readonly string[] = Object.keys(FORMAT_REGISTRY)
  .filter((key) => key.includes('.'))
  .sort((a, b) => b.length - a.length);

/**
 * Resolves uploaded/remote input source format definition, supporting both explicit format overrides
 * and compound tarball suffixes like `.tar.bz2` without altering `detectFormatFromFilename` compatibility.
 */
export function detectUploadedSourceFormat(
  filename: string,
  explicitSource?: string
): ReturnType<typeof getFormatByExtension> {
  const named = explicitSource ? getFormatByExtension(explicitSource) : undefined;
  if (named) return named;
  const lower = filename.toLowerCase();
  for (const compound of COMPOUND_FORMAT_EXTENSIONS) {
    if (lower.endsWith(`.${compound}`)) {
      return FORMAT_REGISTRY[compound];
    }
  }
  return detectFormatFromFilename(filename);
}
