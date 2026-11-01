/**
 * Why `/api/fetch-url` refused to import a file from a link: the stable `code` of its error answers, next to the English
 * `error` text API callers read. The interface words each code in the page's language.
 */
export const URL_IMPORT_ERROR_CODES = [
  'url_required',
  'invalid_url',
  'unsupported_scheme',
  'address_blocked',
  'redirect_without_location',
  'too_many_redirects',
  'invalid_redirect',
  'remote_error',
  'empty_body',
  'file_too_large',
  'fetch_failed',
] as const;

export type UrlImportErrorCode = (typeof URL_IMPORT_ERROR_CODES)[number];

/** The code of an error answer of `/api/fetch-url`, or undefined when the answer names none this build knows. */
export function urlImportErrorCode(payload: unknown): UrlImportErrorCode | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const code = (payload as Record<string, unknown>).code;
  return URL_IMPORT_ERROR_CODES.find((known) => known === code);
}
