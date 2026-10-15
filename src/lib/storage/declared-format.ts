import path from 'node:path';
import { FORMAT_REGISTRY, getFormatByExtension } from '../registry';

/** Problem type returned with HTTP 400 when an upload does not name a format the platform knows. */
export const UNKNOWN_FORMAT_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/unknown-format';

const GENERIC_MIME_TYPE = 'application/octet-stream';

/**
 * An upload names no format the registry knows, so there is nothing its content can be checked
 * against. Callers answer HTTP 400; guessing a format (for example a generic "bin") would let any
 * bytes through under a made-up declaration.
 */
export class UnknownDeclaredFormatError extends Error {
  readonly code = 'UNKNOWN_DECLARED_FORMAT';
  readonly statusCode = 400;

  constructor(filename: string | undefined, mimeType: string | undefined) {
    const name = filename ? `"${filename}"` : 'the upload';
    const type = mimeType && mimeType !== GENERIC_MIME_TYPE ? ` (content type "${mimeType}")` : '';
    super(
      `Cannot determine a supported format for ${name}${type}. ` +
        'Give the file a supported extension or a specific content type.'
    );
    this.name = 'UnknownDeclaredFormatError';
  }
}

/**
 * The registered format id a file declares, from its extension first and then its MIME type.
 * Throws UnknownDeclaredFormatError when neither names a format in the registry.
 */
export function resolveDeclaredFormat(filename: string | undefined, mimeType: string | undefined): string {
  const extension = filename ? path.extname(filename).replace(/^\./, '').toLowerCase().trim() : '';
  if (extension && getFormatByExtension(extension)) {
    return extension;
  }

  const bareMime = mimeType?.split(';')[0].toLowerCase().trim();
  if (bareMime && bareMime !== GENERIC_MIME_TYPE) {
    const byMime = Object.values(FORMAT_REGISTRY).find((format) => format.mimeType === bareMime);
    if (byMime) {
      return byMime.extension;
    }
  }

  throw new UnknownDeclaredFormatError(filename, mimeType);
}
