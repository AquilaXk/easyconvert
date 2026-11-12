import { ALL_API_KEY_SCOPES } from '@/lib/api-keys/types';
import { ENGINE_HEADER, ENGINE_USED_HEADER, ENGINE_VERSION_HEADER, FALLBACK_REASON_HEADER, MAX_FALLBACK_REASON_CHARS } from '@/lib/api/engine-trace';
import { CONVERSION_WARNINGS_HEADER } from '@/lib/api/conversion-warnings';
import { DROPPED_STREAMS_HEADER } from '@/lib/api/dropped-streams';
import { FRAME_USED_HEADER, SOURCE_FRAMES_HEADER } from '@/lib/api/frame-headers';
import { formatBytes } from '@/lib/format-bytes';
import { PAID_PLANS_ON_SALE, PLAN_MAX_FILE_BYTES, SINGLE_REQUEST_FILE_MAX_BYTES } from '@/lib/plan-limits';
import { PDFA_VALIDATION_PROBLEM_TYPE, PDF_POSTPROCESS_PROBLEM_TYPE, RATE_LIMITED_PROBLEM_TYPE } from '@/lib/api/problem-details';
import { QUOTA_EXCEEDED_PROBLEM_TYPE, type ConversionRefusalCode } from '@/lib/refusal-codes';
import {
  DEFAULT_MAX_INPUT_PIXELS,
  MAX_INPUT_PIXELS_CEILING,
  MAX_INPUT_PIXELS_ENV,
} from '@/lib/conversions/image-input-limit-config';

/** Assignable API key scopes, including the admin wildcard. */
export const API_KEY_SCOPES = [...ALL_API_KEY_SCOPES, '*'];

/** Response headers describing the frames of a multi-frame image source (animated GIF/WebP/APNG, multi-page TIFF/HEIF). */
export const FRAME_RESPONSE_HEADERS = {
  [SOURCE_FRAMES_HEADER]: {
    description:
      'Number of frames or pages the source image holds. Sent only when the source has more than one. A still output of an animated source uses frame 1 unless `page` selects another; a multi-page source converted to a still target is packaged as a ZIP with one image per page.',
    schema: { type: 'integer', minimum: 2 },
  },
  [FRAME_USED_HEADER]: {
    description: '1-based frame or page a single-image output was taken from. Sent only when one frame was chosen.',
    schema: { type: 'integer', minimum: 1 },
  },
} as const;

/** Response headers naming the engine of a raw binary conversion result. */
export const ENGINE_RESPONSE_HEADERS = {
  [ENGINE_HEADER]: {
    description: 'Id of the engine that converted, as `GET /api/formats` lists it for the pair, for example `libreoffice` or `easyconvert`.',
    schema: { type: 'string' },
  },
  [ENGINE_VERSION_HEADER]: {
    description: 'Version of that engine as installed. Sent only when the program reports one.',
    schema: { type: 'string' },
  },
  [ENGINE_USED_HEADER]: {
    description: 'Engine that produced the raw output, for example `native-ffmpeg` or `internal-fallback`.',
    schema: { type: 'string' },
  },
  [FALLBACK_REASON_HEADER]: {
    description:
      'Why a first-choice engine did not produce the output. Sent only when a fallback happened; redacted, one line, printable ASCII.',
    schema: { type: 'string', maxLength: MAX_FALLBACK_REASON_CHARS },
  },
} as const;

/** Response header listing the input streams a media conversion left out (raw binary responses). */
export const DROPPED_STREAMS_RESPONSE_HEADERS = {
  [DROPPED_STREAMS_HEADER]: {
    description:
      'Streams of the input the output lacks, as comma-separated `kind[#index]:reason` entries, for example `subtitle#3:container_unsupported,chapters:container_unsupported`. Sent only when something was left out; the JSON response lists the same streams as `droppedStreams`.',
    schema: { type: 'string' },
  },
} as const;

/** Response header listing what a document conversion left out (raw binary responses). */
export const CONVERSION_WARNINGS_RESPONSE_HEADERS = {
  [CONVERSION_WARNINGS_HEADER]: {
    description:
      'What the conversion left out of the document, as comma-separated percent-encoded lines, for example an HTML image that is not embedded. Sent only when something was left out; the JSON response lists the same lines as `warnings`.',
    schema: { type: 'string' },
  },
} as const;

/** RFC 9457 problem details response; legacy clients may still request plain JSON. */
export const createProblemResponse = (description: string) => ({
  description,
  content: {
    'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
    'application/json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
  },
});

/**
 * The `code` values `POST /api/v1/convert` puts on the problem of a typed failure (src/lib/api/typed-failure-response.ts), by status: the
 * `refusalCode` of the error class, answered with the status the class declares (400 without one, 503 for a missing tool). A test
 * reads the error classes under src/ and fails when this table and the classes disagree (tests/openapi-convert-contract.test.ts).
 */
export const V1_CONVERT_CODES = {
  400: ['conversion_failed', 'input_over_limit', 'invalid_pages', 'malformed_input', 'option_not_supported', 'spoofed_file', 'unsafe_archive', 'unsupported_input', 'unsupported_pair'],
  422: ['archive_entry_collision', 'conversion_failed', 'empty_file', 'encrypted_input', 'engine_not_offered', 'engine_version_unavailable', 'input_over_limit', 'invalid_password', 'malformed_input', 'missing_volume', 'option_not_supported', 'password_required', 'timeout', 'unsupported_input', 'unsupported_method'],
  503: ['engine_unavailable'],
} as const satisfies Record<number, readonly ConversionRefusalCode[]>;

const CODED_PROBLEM_SCHEMA = (codes: readonly string[]) => ({
  allOf: [
    { $ref: '#/components/schemas/ProblemDetails' },
    {
      type: 'object',
      properties: {
        code: { type: 'string', enum: [...codes], description: 'The cause of the refusal, stable across releases.' },
        engines: { type: 'array', items: { type: 'string' }, description: '`engine_not_offered` only: the ids of the engines that convert the pair, the default first.' },
        engine: { type: 'string', description: '`engine_version_unavailable` only: the engine whose version was named.' },
        installedVersion: { type: 'string', description: '`engine_version_unavailable` only: the version of `engine` that is installed (absent when its program prints none).' },
      },
    },
  ],
});

/** Problem response whose `code` is one of `codes` (the error class that decided the answer names it). */
export const createCodedProblemResponse = (description: string, codes: readonly string[]) => ({
  description,
  content: {
    'application/problem+json': { schema: CODED_PROBLEM_SCHEMA(codes) },
    'application/json': { schema: CODED_PROBLEM_SCHEMA(codes) },
  },
});

/** The same, for a status that can also carry the PDF/A validation problem. */
export const createCodedPdfaProblemResponse = (description: string, codes: readonly string[]) => {
  const schema = { oneOf: [CODED_PROBLEM_SCHEMA(codes), { $ref: '#/components/schemas/PdfaValidationProblem' }] };
  return { description, content: { 'application/problem+json': { schema }, 'application/json': { schema } } };
};

/** Headers of a 429 of the convert routes, as `buildRateLimitHeaders` and the guard send them (src/lib/api/rate-limit.ts). */
export const RATE_LIMIT_RESPONSE_HEADERS = {
  'Retry-After': {
    description: 'Seconds to wait before the request is repeated (RFC 9110 delay-seconds, at least 1). Sent with every 429 except a `quota-exceeded` that leaves some conversions (a batch that needs more than are left); there it is the time to the daily reset at midnight UTC when none is left, and for `concurrency-limit` it is 5.',
    schema: { type: 'integer', minimum: 1 },
  },
  RateLimit: { description: 'The day\'s quota as `limit=<n>, remaining=<n>, reset=<seconds>`. Sent with `quota-exceeded`, and on `POST /api/v1/convert` with every 429 its guard answers.', schema: { type: 'string' } },
  'RateLimit-Limit': { description: 'Conversions the caller\'s tier allows per day.', schema: { type: 'integer' } },
  'RateLimit-Remaining': { description: 'Conversions left today.', schema: { type: 'integer' } },
  'RateLimit-Reset': { description: 'Seconds until the daily quota resets.', schema: { type: 'integer' } },
  'RateLimit-Policy': { description: 'The quota window, for example `10;w=86400;comment="anonymous daily quota"`.', schema: { type: 'string' } },
  'X-RateLimit-Limit': { description: 'Legacy copy of `RateLimit-Limit`.', schema: { type: 'integer' } },
  'X-RateLimit-Remaining': { description: 'Legacy copy of `RateLimit-Remaining`.', schema: { type: 'integer' } },
  'X-RateLimit-Reset': { description: 'Legacy copy of `RateLimit-Reset`.', schema: { type: 'integer' } },
} as const;

const TOO_MANY_REQUESTS_SCHEMA = {
  allOf: [
    { $ref: '#/components/schemas/ProblemDetails' },
    {
      type: 'object',
      properties: {
        dailyLimit: { type: 'integer', description: '`quota-exceeded` only: conversions the tier allows per day.' },
        remaining: { type: 'integer', description: '`quota-exceeded` only: conversions left today.' },
        requiredUnits: { type: 'integer', description: '`quota-exceeded` only: conversions the request needs.' },
        limit: { type: 'integer', description: '`concurrency-limit` only: conversions the account may have in flight.' },
      },
    },
  ],
};

/** The 429 of a convert route: the three problem types it answers with and the headers each sends. */
export const createTooManyRequestsResponse = (extra: string) => ({
  description:
    `Too Many Requests, by problem type. \`${RATE_LIMITED_PROBLEM_TYPE}\`: the burst limit of the API key, of the client address or of the edge is spent; wait \`Retry-After\` seconds. ` +
    `\`${QUOTA_EXCEEDED_PROBLEM_TYPE}\`: the day's conversions are used up or too few are left (\`dailyLimit\`, \`remaining\`, \`requiredUnits\` in the body, the quota headers, and \`Retry-After\` until the reset when none is left). ` +
    `\`https://api.easyconvert.io/problems/concurrency-limit\`: the account already has the most conversions in flight its tier allows, 5 for anonymous and free callers (\`limit\` in the body, \`Retry-After\` 5); the request takes no quota.${extra}`,
  headers: RATE_LIMIT_RESPONSE_HEADERS,
  content: {
    'application/problem+json': { schema: TOO_MANY_REQUESTS_SCHEMA },
    'application/json': { schema: TOO_MANY_REQUESTS_SCHEMA },
  },
});

/**
 * What a PDF/A request adds to the problems of a convert route: a 422 problem that carries the
 * requested profile and the failed veraPDF rule IDs, and a 503 when veraPDF is not installed.
 */
export const PDFA_PROBLEM_DESCRIPTION =
  `A PDF/A output failed validation (problem type \`${PDFA_VALIDATION_PROBLEM_TYPE}\`, with the requested \`profile\` and the veraPDF \`failedRules\`), ` +
  `or the PDF/A conversion could not complete on the document (problem type \`${PDF_POSTPROCESS_PROBLEM_TYPE}\`).`;
export const PDFA_ENGINE_NOTE = ' A PDF/A request also needs veraPDF, which validates every PDF/A output.';

const PDFA_PROBLEM_SCHEMA = {
  oneOf: [{ $ref: '#/components/schemas/ProblemDetails' }, { $ref: '#/components/schemas/PdfaValidationProblem' }],
};

/** Problem response whose body is a plain problem or the PDF/A validation problem. */
export const createPdfaProblemResponse = (description: string) => ({
  description,
  content: {
    'application/problem+json': { schema: PDFA_PROBLEM_SCHEMA },
    'application/json': { schema: PDFA_PROBLEM_SCHEMA },
  },
});
const PIXELS_PER_MEGAPIXEL = 1_000_000;

/** The most one file may have, by plan, as the API documents it: the free limit, and the paid plans once they are on sale. */
const PLAN_FILE_LIMITS_TEXT = PAID_PLANS_ON_SALE
  ? `${formatBytes(PLAN_MAX_FILE_BYTES.free)} for anonymous callers and the free plan, ${formatBytes(PLAN_MAX_FILE_BYTES.pro)} for Pro, ${formatBytes(PLAN_MAX_FILE_BYTES.enterprise)} for Enterprise`
  : `${formatBytes(PLAN_MAX_FILE_BYTES.free)} for anonymous callers and accounts`;

/** Description of the 413 answer for a file over the limit of the caller's plan. */
export const PLAN_FILE_LIMIT_DESCRIPTION = `Payload Too Large: the file is over the limit of the caller's plan (${PLAN_FILE_LIMITS_TEXT}). The detail states the size and the limit.`;

/** Description of the 413 answer of a public route for a request body past what one request may carry. */
export const SINGLE_REQUEST_LIMIT_DESCRIPTION = `Payload Too Large: the request body is over ${formatBytes(SINGLE_REQUEST_FILE_MAX_BYTES)} of file and form fields. A larger file is uploaded in parts through \`/api/v1/uploads\` and converted by \`POST /api/v1/jobs\` on the stored file.`;

/** The same answer of a route of the web application, which names its own upload flow. */
export const WEB_SINGLE_REQUEST_LIMIT_DESCRIPTION = `Payload Too Large: the request body is over ${formatBytes(SINGLE_REQUEST_FILE_MAX_BYTES)} of file and form fields. The web application uploads a larger file in parts through \`/api/storage/multipart\` and converts it by \`POST /api/queue/jobs\` on the stored key.`;

/** Description of the 413 answer for a file that would decode past a size limit of the engines. */
/** The 411 of a route that takes a file, for a body sent in chunks without a length (docs/policy-decisions.md, entry 137). */
export const LENGTH_REQUIRED_DESCRIPTION =
  'Length Required: a request that carries a file declares its `Content-Length`; a body sent in chunks without one is refused.';
export const DECODE_LIMIT_DESCRIPTION =
  'Or: the file would decode past a size limit: a compressed stream or table larger than 64 MiB, more than 256 MiB of decoded data in one document, or more text blocks or character mappings than the engine allows.';

/** Description of the 413 answer for a picture that declares more pixels than the input limit. */
export const INPUT_PIXEL_LIMIT_DESCRIPTION = `Payload Too Large: an image (or an image inside the document) declares more than ${
  DEFAULT_MAX_INPUT_PIXELS / PIXELS_PER_MEGAPIXEL
} megapixels by default, or a lower limit of a conversion path that holds the whole picture in memory. The detail states the limit. Operators can change the default with ${MAX_INPUT_PIXELS_ENV} (at most ${MAX_INPUT_PIXELS_CEILING} pixels).`;

/** Plain `{ success: false, error }` response used by routes that predate problem details. */
export const createErrorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
});

/**
 * A `{ success: false, code, error }` response of a route of the web application: the English `error` for API callers and one
 * stable `code` per cause (src/lib/refusal-codes.ts), which the interface words in the page's language.
 */
export const createCodedErrorResponse = (description: string, codes: readonly string[]) => ({
  description,
  content: {
    'application/json': {
      schema: {
        allOf: [
          { $ref: '#/components/schemas/ErrorResponse' },
          { type: 'object', properties: { code: { type: 'string', enum: [...codes], description: 'The cause of the refusal, stable across releases.' } } },
        ],
      },
    },
  },
});

/** JSON response with an inline object schema. */
export const createJsonResponse = (description: string, properties: Record<string, unknown>) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', properties } } },
});

export const createPathParameter = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description,
});

/** Security requirement accepted by both API key and bearer authentication. */
export const requireScope = (...scopes: string[]) => [
  { ApiKeyAuth: scopes },
  { BearerAuth: scopes },
];

export const SESSION_ONLY = [{ SessionCookie: [] }];
export const PUBLIC_ACCESS: Record<string, string[]>[] = [];

export const IDEMPOTENCY_KEY_PARAMETER = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description: 'Optional 1-255 character printable ASCII idempotency key for safe retries.',
  schema: { $ref: '#/components/schemas/IdempotencyKeyHeader' },
};

/** `Prefer: respond-async` of `POST /api/v1/convert`: queue the conversion as a job instead of answering with the result. */
export const PREFER_RESPOND_ASYNC_PARAMETER = {
  name: 'Prefer',
  in: 'header',
  required: false,
  description:
    'Send `respond-async` to have the conversion queued as a job and answered at once with 202 and `Preference-Applied: respond-async`, whatever the size of the file. Without it a file over the synchronous limit is queued too. Other preferences are ignored.',
  schema: { type: 'string', example: 'respond-async' },
};

/** `?raw=true` of `POST /api/v1/convert`: answer a finished synchronous conversion with the bytes of the result. */
export const RAW_RESULT_PARAMETER = {
  name: 'raw',
  in: 'query',
  required: false,
  description:
    'Set to `true` (or send `Accept: application/octet-stream`) to answer a finished synchronous conversion with the bytes of the result (its own content type, and its file name in `Content-Disposition`) instead of JSON. A queued conversion (202) answers JSON either way.',
  schema: { type: 'boolean', default: false },
};

/** Webhook fields of a conversion that is queued; the same names and meaning as those of `POST /api/v1/jobs`. */
export const CONVERT_WEBHOOK_FORM_PROPERTIES = {
  webhookUrl: {
    type: 'string',
    format: 'uri',
    description:
      'Destination of the HMAC-signed event sent when a queued conversion ends (a file over the synchronous limit, or a request with `Prefer: respond-async`); a synchronous answer sends none. Defaults to the webhook of the API key. A private, loopback or otherwise restricted host is refused with 400.',
  },
  webhookSecret: {
    type: 'string',
    description: 'Secret of the HMAC-SHA256 signature of the event. Required with `webhookUrl`; defaults to the secret of the API key.',
  },
};

type SchemaProperties = Record<string, unknown>;

const objectSchema = (properties: SchemaProperties, required?: string[]) => ({
  type: 'object',
  ...(required ? { required } : {}),
  properties,
});

/** Required multipart/form-data request body with an object schema. */
export const multipartBody = (properties: SchemaProperties, required?: string[]) => ({
  required: true,
  content: { 'multipart/form-data': { schema: objectSchema(properties, required) } },
});

/** Required JSON request body with an object schema. */
export const jsonBody = (properties: SchemaProperties, required?: string[]) => ({
  required: true,
  content: { 'application/json': { schema: objectSchema(properties, required) } },
});

/** Raw binary request body of the given media type. */
export const binaryBody = (mediaType: string, required: boolean) => ({
  required,
  content: { [mediaType]: { schema: { type: 'string', format: 'binary' } } },
});

/** The `options` form field of the convert routes, with the document options spelled out. */
export const CONVERT_OPTIONS_DESCRIPTION =
  'JSON-serialized conversion options (e.g. quality, resolution, delimiter). Document options: ' +
  '`layout` (PDF to TXT: keep the physical layout), `imageDpi` and `jpegQuality` (Office to PDF: opt-in image compression), ' +
  'and `pdfa` or `pdfStandard` (PDF/A output, validated with veraPDF; a request that names no level is answered at pdfa-2b).';

/** Form fields of a single-file conversion request. */
export const CONVERT_FORM_PROPERTIES = {
  file: { type: 'string', format: 'binary', description: `Source input file binary (up to ${PLAN_FILE_LIMITS_TEXT}).` },
  targetFormat: { type: 'string', description: 'Target format extension or identifier (e.g., "pdf", "step", "webp").' },
  sourceFormat: { type: 'string', description: 'Explicit source format override. If omitted, inferred from filename.' },
  options: { type: 'string', description: CONVERT_OPTIONS_DESCRIPTION },
};

/** The 504 of a synchronous conversion that ran past its wall-clock deadline (JOB_DEADLINE_* and SYNC_DEADLINE_MAX_MS settings). */
export const JOB_TIMEOUT_DESCRIPTION =
  'The conversion did not finish within its wall-clock limit (problem type `https://api.easyconvert.io/problems/job-timeout`, with the limit in `timeoutMs` and the asynchronous endpoint in `asyncEndpoint`). A synchronous request is held to 120 s by default, below the limit of the account tier; use `POST /api/v1/jobs` for conversions that need longer. The conversion was stopped, its processes were killed and the quota unit is refunded (only successful conversions are charged); the request still counts toward the rate limit. A queued job that hits its limit fails with `failedCode` "JobTimeoutError" and `failedStatus` 504, is refunded the same way and is not retried.';

/** The 499 of a synchronous conversion whose client closed the connection. */
export const CLIENT_CLOSED_DESCRIPTION =
  'The client closed the connection before the conversion finished (problem type `https://api.easyconvert.io/problems/client-closed-request`). The conversion was aborted and the quota reservation is rolled back; the request still counts toward the rate limit. No client is left to read this answer.';

/** Appended to the 429 of a conversion endpoint: the other reason for a 429 besides the rate limit and the quota. */
export const CONCURRENCY_LIMIT_NOTE =
  ' Or: the account already has the most conversions in flight (queued and running) its tier allows, 5 for anonymous and free callers (problem type `https://api.easyconvert.io/problems/concurrency-limit`, with `Retry-After`); the request takes no quota.';
