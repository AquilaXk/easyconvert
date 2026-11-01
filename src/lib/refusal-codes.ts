/**
 * The stable `code` that a route of the web application puts next to the English `error` of a refusal, one per cause. API
 * callers read the English text; the interface words the code in the page's language (src/components/i18n/error-wording.ts).
 */

/** Why `/api/fetch-url` refused to import a file from a link. */
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
 * The code of a conversion failure, by the `name` of the error a conversion threw. Every error class sets its name as a
 * literal, so the name survives minification, and it is the `failedCode` a queued job records, so the queue words a failed
 * job by the same table. A subclass is listed by its own name; a name that is not listed has no code.
 */
export const CONVERSION_REFUSAL_CODE_BY_ERROR = {
  FileExtensionSpoofError: 'spoofed_file',
  UnsupportedTargetError: 'unsupported_pair',
  UnsupportedOptionError: 'option_not_supported',
  InvalidPageRangeError: 'invalid_pages',
  ArchivePasswordRequiredError: 'password_required',
  PdfPasswordRequiredError: 'password_required',
  InvalidArchivePasswordError: 'invalid_password',
  UnsupportedArchiveMethodError: 'unsupported_method',
  EncryptedOfficeDocumentError: 'encrypted_input',
  PdfPermissionDeniedError: 'encrypted_input',
  ArchiveEncryptedHeaderError: 'encrypted_input',
  MissingVolumeError: 'missing_volume',
  ArchiveEntryCollisionError: 'archive_entry_collision',
  UnsafeArchiveError: 'unsafe_archive',
  UnreadableArchiveError: 'malformed_input',
  UnopenableArchiveError: 'malformed_input',
  CorruptStreamError: 'malformed_input',
  CompoundFileStructureError: 'malformed_input',
  DataParseError: 'malformed_input',
  DataEncodingError: 'malformed_input',
  MediaProbeError: 'malformed_input',
  UnprocessableFontInputError: 'malformed_input',
  UnprocessableMediaInputError: 'unsupported_input',
  UnsupportedMediaCodecError: 'unsupported_input',
  RefusedMediaInputError: 'unsupported_input',
  UnprocessableCadInputError: 'unsupported_input',
  UnsupportedDwgVersionError: 'unsupported_input',
  EmptyAudioInputError: 'empty_file',
  PayloadLimitError: 'input_over_limit',
  SheetLimitError: 'input_over_limit',
  DecompressionLimitError: 'input_over_limit',
  ShapingLimitError: 'input_over_limit',
  DataLimitExceededError: 'input_over_limit',
  CadExpansionLimitError: 'input_over_limit',
  JobTimeoutError: 'timeout',
  CpuTaskTimeoutError: 'timeout',
  EngineMissingError: 'engine_unavailable',
  EngineUnavailableError: 'engine_unavailable',
  OcrEngineUnavailableError: 'engine_unavailable',
  OcrLanguageUnavailableError: 'engine_unavailable',
  CadGeometryUnavailableError: 'engine_unavailable',
  ArchiveEncryptionUnavailableError: 'engine_unavailable',
  ComplexScriptRequiresNativeEngineError: 'engine_unavailable',
  SandboxUnavailableError: 'engine_unavailable',
  CpuPoolOverloadedError: 'engine_unavailable',
  QueueUnavailableError: 'engine_unavailable',
  ConversionFailedError: 'conversion_failed',
} as const;

/** Why `/api/convert` refused the request itself, before any conversion ran. */
const REQUEST_REFUSAL_CODES = ['file_required', 'empty_file', 'target_required', 'unknown_format', 'invalid_options'] as const;

export type ConversionRefusalCode =
  | (typeof REQUEST_REFUSAL_CODES)[number]
  | (typeof CONVERSION_REFUSAL_CODE_BY_ERROR)[keyof typeof CONVERSION_REFUSAL_CODE_BY_ERROR];

/** Why `/api/convert` refused a file: the request itself, or the conversion it started. */
export const CONVERSION_REFUSAL_CODES: readonly ConversionRefusalCode[] = [
  ...new Set<ConversionRefusalCode>([...REQUEST_REFUSAL_CODES, ...Object.values(CONVERSION_REFUSAL_CODE_BY_ERROR)]),
];

/** The code a conversion error names by its `name`, or undefined for an error the table does not list. */
export function conversionRefusalCodeOf(errorName: unknown): ConversionRefusalCode | undefined {
  return typeof errorName === 'string' && Object.hasOwn(CONVERSION_REFUSAL_CODE_BY_ERROR, errorName)
    ? CONVERSION_REFUSAL_CODE_BY_ERROR[errorName as keyof typeof CONVERSION_REFUSAL_CODE_BY_ERROR]
    : undefined;
}

/** The `code` of an error answer when it is one of `codes`; undefined for an answer without one this build knows. */
export function knownCode<C extends string>(codes: readonly C[], payload: unknown): C | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const code = (payload as Record<string, unknown>).code;
  return codes.find((known) => known === code);
}
