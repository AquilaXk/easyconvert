/**
 * The stable `code` that a route of the web application puts next to the English `error` of a refusal, one per cause. API
 * callers read the English text; the interface words the code in the page's language (src/components/i18n/error-wording.ts).
 */

/** Why `/api/fetch-url` refused to import a file from a link. */
export const URL_IMPORT_ERROR_CODES = [
  'invalid_json',
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

/** Why `/api/auth/login` or `/api/auth/register` refused. */
export const AUTH_ERROR_CODES = [
  'invalid_json',
  'missing_fields',
  'invalid_credentials',
  'login_locked',
  'client_address_unknown',
  'client_ip_unconfigured',
  'invalid_email',
  'password_length',
  'account_exists',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/**
 * Why `/api/convert` refused a file or a queued conversion failed: the request itself, or the `refusalCode` the class of the
 * error a conversion threw declares or inherits (`ConversionFailedError` and the classes under it in src/lib/types.ts).
 */
export const CONVERSION_REFUSAL_CODES = [
  'multipart_required',
  'file_required',
  'empty_file',
  'target_required',
  'unknown_format',
  'invalid_options',
  'spoofed_file',
  'unsupported_pair',
  'option_not_supported',
  'invalid_pages',
  'password_required',
  'invalid_password',
  'unsupported_method',
  'encrypted_input',
  'missing_volume',
  'archive_entry_collision',
  'unsafe_archive',
  'malformed_input',
  'unsupported_input',
  'input_over_limit',
  'timeout',
  'engine_unavailable',
  'conversion_failed',
] as const;

export type ConversionRefusalCode = (typeof CONVERSION_REFUSAL_CODES)[number];

/** Whether `value` is one of `codes`: a code of one of the closed lists above, and never an inherited property name. */
export function isCodeOf<const Codes extends readonly string[]>(codes: Codes, value: unknown): value is Codes[number] {
  return typeof value === 'string' && codes.includes(value);
}

/** The code an error names through the `refusalCode` of its class; undefined for an error whose class declares none. */
export function refusalCodeOf(error: unknown): ConversionRefusalCode | undefined {
  const code = error instanceof Error ? (error as Error & { refusalCode?: unknown }).refusalCode : undefined;
  return isCodeOf(CONVERSION_REFUSAL_CODES, code) ? code : undefined;
}

/** The start of every problem `type` URI the API answers with (RFC 9457); the name after it is as stable as a code. */
export const PROBLEM_TYPE_BASE = 'https://api.easyconvert.io/problems/';

/** The problem `type` and title an answer carries by its HTTP status when its route names none; the interface words an untyped answer through it. */
export const DEFAULT_PROBLEM_TYPES: Record<number, { type: string; title: string }> = {
  400: {
    type: 'https://api.easyconvert.io/problems/bad-request',
    title: 'Bad Request',
  },
  401: {
    type: 'https://api.easyconvert.io/problems/unauthorized',
    title: 'Unauthorized',
  },
  403: {
    type: 'https://api.easyconvert.io/problems/forbidden',
    title: 'Forbidden',
  },
  404: {
    type: 'https://api.easyconvert.io/problems/not-found',
    title: 'Not Found',
  },
  405: {
    type: 'https://api.easyconvert.io/problems/method-not-allowed',
    title: 'Method Not Allowed',
  },
  413: {
    type: 'https://api.easyconvert.io/problems/payload-too-large',
    title: 'Payload Too Large',
  },
  415: {
    type: 'https://api.easyconvert.io/problems/unsupported-media-type',
    title: 'Unsupported Media Type',
  },
  422: {
    type: 'https://api.easyconvert.io/problems/unprocessable-entity',
    title: 'Unprocessable Entity',
  },
  429: {
    type: 'https://api.easyconvert.io/problems/quota-exceeded',
    title: 'Too Many Requests',
  },
  500: {
    type: 'https://api.easyconvert.io/problems/internal-server-error',
    title: 'Internal Server Error',
  },
  503: {
    type: 'https://api.easyconvert.io/problems/service-unavailable',
    title: 'Service Unavailable',
  },
};
