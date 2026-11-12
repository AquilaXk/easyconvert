import { FORMAT_REGISTRY } from './registry';
import type { FormatDefinition } from './types';

/** The first format of the registry for each media type: several formats share one (`image/jpeg`), and the registry lists the usual one first. */
const FORMAT_BY_MIME_TYPE = new Map<string, FormatDefinition>();
for (const format of Object.values(FORMAT_REGISTRY)) {
  if (!FORMAT_BY_MIME_TYPE.has(format.mimeType)) FORMAT_BY_MIME_TYPE.set(format.mimeType, format);
}

/** The format of a media type (`image/jpeg`), without parameters or case; undefined for a type the registry does not list. */
export function getFormatByMimeType(mimeType: string): FormatDefinition | undefined {
  return FORMAT_BY_MIME_TYPE.get(mimeType.split(';')[0].trim().toLowerCase());
}
