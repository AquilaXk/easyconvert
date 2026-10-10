import { limitFromEnvironment } from './spreadsheet-limits';

/** Environment variable that sets the most bytes of embedded media (pictures, video) a deck or document may decode to (a positive whole number). */
export const MAX_DOCUMENT_MEDIA_BYTES_ENV = 'EASYCONVERT_MAX_DOCUMENT_MEDIA_BYTES';

/**
 * Most bytes of embedded media one document may decode to in all, each part counted once however many pictures use
 * it. 1 GiB: the largest upload. Media is held in memory while the document converts, and a deck can name one part
 * from any number of pictures, so a limit per part would let the references multiply the memory.
 */
export const DEFAULT_MAX_DOCUMENT_MEDIA_BYTES = 1024 * 1024 * 1024;

export function maxDocumentMediaBytes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return limitFromEnvironment(MAX_DOCUMENT_MEDIA_BYTES_ENV, DEFAULT_MAX_DOCUMENT_MEDIA_BYTES, env);
}
