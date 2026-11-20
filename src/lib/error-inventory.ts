import {
  AUTH_ERROR_CODES,
  BILLING_REFUSAL_CODES,
  CONVERSION_REFUSAL_CODES,
  DASHBOARD_REFUSAL_CODES,
  URL_IMPORT_ERROR_CODES,
} from './refusal-codes';

/**
 * The errors page of the API documentation (src/components/api-docs/ErrorsReference.tsx) lists these tables, and the `type` of
 * every problem answer points to an anchor of it (PROBLEM_TYPE_BASE). A table here gives the HTTP statuses; the sentences come
 * from the interface messages (`errors.problems` and one `errors.<area>` namespace per area of codes). A problem name or a code
 * missing from a table does not compile; tests/error-inventory.test.ts reads src for the names, statuses and sentences.
 */

/** The problem types, in the order the page lists them, with the one status each is answered with. */
export const PROBLEM_TYPE_STATUSES = {
  'bad-request': 400,
  unauthorized: 401,
  forbidden: 403,
  'not-found': 404,
  'method-not-allowed': 405,
  'length-required': 411,
  'payload-too-large': 413,
  'unsupported-media-type': 415,
  'unprocessable-entity': 422,
  'option-not-supported': 422,
  'unknown-format': 400,
  'invalid-archive': 422,
  'missing-archive-volume': 422,
  'archive-encrypted-header': 422,
  'graph-without-conversion': 422,
  'task-name-invalid': 422,
  'task-name-duplicate': 422,
  'task-count-exceeded': 422,
  'task-input-unknown': 422,
  'task-graph-cycle': 422,
  'pdf-postprocess-failed': 422,
  'pdfa-validation-failed': 422,
  'byos-invalid-endpoint': 400,
  'byos-provider-unavailable': 400,
  'idempotency-key-reused': 422,
  'idempotency-key-in-flight': 409,
  'idempotency-response-not-kept': 409,
  'rate-limited': 429,
  'quota-exceeded': 429,
  'concurrency-limit': 429,
  'upload-budget-exceeded': 429,
  'client-closed-request': 499,
  'internal-server-error': 500,
  'job-state-corrupt': 500,
  'ocr-asset-integrity-failed': 500,
  'service-unavailable': 503,
  'storage-full': 503,
  'engine-unavailable': 503,
  'part-in-flight': 503,
  'client-ip-trust-unconfigured': 503,
  'job-timeout': 504,
} as const satisfies Record<string, number>;

export type ProblemTypeName = keyof typeof PROBLEM_TYPE_STATUSES;

type StatusesOf<Codes extends readonly string[]> = Readonly<Record<Codes[number], readonly number[]>>;

/** The areas of refusal codes, in the order the page lists them; each is the key of its sentences under `errors`. */
export const CODE_AREAS = ['conversion', 'urlImport', 'auth', 'dashboard', 'billing'] as const;

export type CodeArea = (typeof CODE_AREAS)[number];

/** The statuses each code is answered with: a code that several routes or error classes raise can carry more than one. */
const CODE_STATUSES = {
  conversion: {
    multipart_required: [400, 415],
    file_required: [400],
    empty_file: [400, 422],
    too_few_files: [400],
    too_many_files: [400],
    target_required: [400],
    unknown_format: [400],
    invalid_options: [400],
    spoofed_file: [400],
    unsupported_pair: [400],
    option_not_supported: [400, 422],
    invalid_pages: [400],
    password_required: [422],
    invalid_password: [422],
    unsupported_method: [422],
    encrypted_input: [422],
    missing_volume: [422],
    archive_entry_collision: [422],
    unsafe_archive: [400],
    malformed_input: [400, 422],
    unsupported_input: [400, 422],
    input_over_limit: [400, 413, 422],
    import_budget_exceeded: [429],
    quota_exceeded: [429],
    timeout: [422, 504],
    storage_credential_not_found: [404],
    storage_access_denied: [403],
    storage_endpoint_blocked: [403],
    storage_object_not_found: [404],
    storage_too_many_objects: [413],
    storage_unavailable: [502],
    engine_not_offered: [422],
    engine_version_unavailable: [422],
    metadata_write_unsupported: [422],
    metadata_field_invalid: [422],
    capture_unavailable: [422],
    capture_target_blocked: [422],
    capture_failed: [422],
    pdf_postprocess_failed: [422],
    engine_unavailable: [503],
    conversion_failed: [400, 422, 500],
  } satisfies StatusesOf<typeof CONVERSION_REFUSAL_CODES>,
  urlImport: {
    invalid_json: [400],
    url_required: [400],
    invalid_url: [400],
    invalid_headers: [400],
    unsupported_scheme: [400],
    address_blocked: [403],
    redirect_without_location: [502],
    too_many_redirects: [502],
    invalid_redirect: [502],
    remote_error: [400, 502],
    empty_body: [502],
    file_too_large: [413],
    fetch_failed: [502],
    fetch_timeout: [504],
  } satisfies StatusesOf<typeof URL_IMPORT_ERROR_CODES>,
  auth: {
    invalid_json: [400],
    missing_fields: [400],
    invalid_credentials: [400, 401],
    login_locked: [429],
    client_address_unknown: [400],
    client_ip_unconfigured: [503],
    invalid_email: [400],
    invalid_name: [400],
    password_length: [400],
    terms_not_accepted: [400],
    terms_outdated: [400],
    disposable_email: [400],
    mail_temporarily_unavailable: [503],
    mail_unavailable: [404],
    mail_rate_limited: [429],
    invalid_token: [400],
    oauth_unavailable: [503],
  } satisfies StatusesOf<typeof AUTH_ERROR_CODES>,
  dashboard: {
    admin_scope_required: [403],
    terms_not_accepted: [400],
    terms_outdated: [400],
    invalid_key_settings: [400],
    invalid_grace_period: [400],
    key_limit_reached: [409],
    key_create_failed: [500],
  } satisfies StatusesOf<typeof DASHBOARD_REFUSAL_CODES>,
  billing: {
    billing_unavailable: [503],
    billing_provider_failed: [502],
    billing_hold: [403],
    invalid_product: [400],
    already_subscribed: [409],
    no_subscription: [404],
    invalid_signature: [400],
  } satisfies StatusesOf<typeof BILLING_REFUSAL_CODES>,
} as const;

export interface CodeRow {
  readonly area: CodeArea;
  readonly code: string;
  readonly statuses: readonly number[];
  /** Whether this row owns the anchor: a code several areas raise (`invalid_json`) is anchored once, at its first area. */
  readonly anchored: boolean;
}

/** The codes of every area in page order, with the statuses of each and which row takes the anchor of the code. */
export function codeRows(): CodeRow[] {
  const seen = new Set<string>();
  return CODE_AREAS.flatMap((area) =>
    Object.entries<readonly number[]>(CODE_STATUSES[area]).map(([code, statuses]) => {
      const anchored = !seen.has(code);
      seen.add(code);
      return { area, code, statuses, anchored };
    })
  );
}
