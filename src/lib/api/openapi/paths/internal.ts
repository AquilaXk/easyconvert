import {
  CONVERT_FORM_PROPERTIES,
  CONVERT_OPTIONS_DESCRIPTION,
  PDFA_ENGINE_NOTE,
  PDFA_PROBLEM_DESCRIPTION,
  createPdfaProblemResponse,
  INPUT_PIXEL_LIMIT_DESCRIPTION,
  PUBLIC_ACCESS,
  SESSION_ONLY,
  createCodedErrorResponse,
  createErrorResponse,
  createJsonResponse,
  createPathParameter,
  createProblemResponse,
  multipartBody,
  requireScope,
  FRAME_RESPONSE_HEADERS,
  CONVERSION_WARNINGS_RESPONSE_HEADERS,
  DROPPED_STREAMS_RESPONSE_HEADERS,
  CLIENT_CLOSED_DESCRIPTION,
  CONCURRENCY_LIMIT_NOTE,
  JOB_TIMEOUT_DESCRIPTION,
  DECODE_LIMIT_DESCRIPTION,
  LENGTH_REQUIRED_DESCRIPTION,
  PLAN_FILE_LIMIT_DESCRIPTION,
  WEB_SINGLE_REQUEST_LIMIT_DESCRIPTION,
} from '../shared';
import { ENGINE_UNAVAILABLE_PROBLEM_TYPE } from '@/lib/api/problem-details';
import { formatBytes } from '@/lib/format-bytes';
import { INLINE_JOB_PAYLOAD_MAX_BYTES, SINGLE_REQUEST_FILE_MAX_BYTES } from '@/lib/plan-limits';
import type { ConversionRefusalCode, UrlImportErrorCode } from '@/lib/refusal-codes';

/**
 * The codes `POST /api/convert` answers with, by status: the request's own, and the `refusalCode` of the error a conversion
 * threw, which the route answers 422 for an intact file it cannot read or an archive it cannot open, and 400 for any other
 * conversion error (src/app/api/convert/route.ts).
 */
const CONVERT_CODES = {
  400: [
    'file_required', 'empty_file', 'target_required', 'unknown_format', 'invalid_options', 'unsupported_pair', 'spoofed_file',
    'option_not_supported', 'invalid_pages', 'malformed_input', 'unsafe_archive', 'unsupported_input', 'input_over_limit', 'timeout',
    'engine_unavailable', 'conversion_failed',
  ],
  422: [
    'invalid_pages', 'encrypted_input', 'password_required', 'invalid_password', 'unsupported_method', 'unsupported_input',
    'malformed_input', 'empty_file', 'archive_entry_collision', 'missing_volume',
  ],
} as const satisfies Record<number, readonly ConversionRefusalCode[]>;

/** The codes `POST /api/fetch-url` answers with, by status (src/app/api/fetch-url/route.ts). */
const URL_IMPORT_CODES = {
  400: ['invalid_json', 'url_required', 'invalid_url', 'unsupported_scheme', 'remote_error'],
  502: ['redirect_without_location', 'too_many_redirects', 'invalid_redirect', 'fetch_failed', 'remote_error', 'empty_body'],
} as const satisfies Record<number, readonly UrlImportErrorCode[]>;

/**
 * Routes that serve the web application. They are documented for completeness and
 * marked `x-internal` so generated SDKs and public reference docs leave them out.
 */

const INTERNAL = { 'x-internal': true };

const ENGINE_UNAVAILABLE_DESCRIPTION = `The pair needs a native engine that is not installed on this deployment (problem type \`${ENGINE_UNAVAILABLE_PROBLEM_TYPE}\`).${PDFA_ENGINE_NOTE}`;
const PAYLOAD_LIMIT_DESCRIPTION = `${WEB_SINGLE_REQUEST_LIMIT_DESCRIPTION} ${DECODE_LIMIT_DESCRIPTION}`;

const ANONYMOUS_OR_SCOPE = (scope: string) => [...requireScope(scope), {}];

const HEALTH_COMPONENT_SCHEMA = {
  type: 'object',
  required: ['status', 'required'],
  properties: {
    status: { type: 'string', enum: ['ok', 'failed', 'not_configured'] },
    required: {
      type: 'boolean',
      description: 'True for components whose failure makes the service unhealthy (redis, storage); false for advisory native tools.',
    },
    reason: { type: 'string', enum: ['timeout', 'unreachable', 'missing', 'not_writable', 'misconfigured'] },
    driver: { type: 'string', enum: ['local', 'oci', 's3'], description: 'Storage only: the configured driver.' },
  },
};

const healthResponse = (description: string) =>
  createJsonResponse(description, {
    status: { type: 'string', enum: ['healthy', 'unhealthy'] },
    checkedAt: { type: 'string', format: 'date-time', description: 'Admin view only: when the probes ran.' },
    components: {
      type: 'object',
      description: 'Admin view only: one entry per probed component (redis, storage and each native tool).',
      additionalProperties: HEALTH_COMPONENT_SCHEMA,
    },
  });

const binaryResponse = (description: string, mediaType = 'application/octet-stream') => ({
  description,
  content: { [mediaType]: { schema: { type: 'string', format: 'binary' } } },
});

const credentialsBody = (extra: Record<string, unknown> = {}) => ({
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8, maxLength: 1024 },
          ...extra,
        },
      },
    },
  },
});

const sessionCookieHeader = {
  'Set-Cookie': { schema: { type: 'string' }, description: 'HttpOnly session cookie.' },
};

const sessionUserResponse = (description: string) => ({
  ...createJsonResponse(description, {
    success: { type: 'boolean' },
    user: { type: 'object' },
    token: { type: 'string' },
  }),
  headers: sessionCookieHeader,
});

const redirectResponse = (description: string) => ({
  description,
  headers: { Location: { schema: { type: 'string' } } },
});

const openApiDocumentResponse = {
  '200': {
    description: 'OpenAPI 3.1 document.',
    content: { 'application/json': { schema: { type: 'object' } } },
  },
};

/** The 429 of `/api/fetch-url`: a problem that names the refusal of the byte budget and the bytes it is about. */
const linkImportBudgetResponse = (description: string) => {
  const schema = {
    allOf: [
      { $ref: '#/components/schemas/ProblemDetails' },
      {
        type: 'object',
        properties: {
          refusal: { type: 'string', enum: ['daily-bytes', 'larger-than-left'], description: 'Which bound of the byte budget refused the import.' },
          limitBytes: { type: 'integer', description: 'The bytes the caller may bring in each UTC day.' },
          leftBytes: { type: 'integer', description: 'With `larger-than-left`: the bytes the day had left.' },
          plan: { type: 'string', description: 'The plan of an account.' },
        },
      },
    ],
  };
  return { description, content: { 'application/problem+json': { schema }, 'application/json': { schema } } };
};

export const internalPaths = {
  '/api/account/files': {
    get: {
      ...INTERNAL,
      summary: 'List Account Files',
      description: 'Lists the caller\'s retained conversion outputs with their remaining lifetime.',
      operationId: 'listAccountFiles',
      security: requireScope('storage:download'),
      responses: {
        '200': createJsonResponse('Retained files.', {
          success: { type: 'boolean' },
          files: { type: 'array', items: { type: 'object' } },
        }),
        '401': createErrorResponse('Authentication required.'),
      },
    },
  },
  '/api/account/files/{id}': {
    delete: {
      ...INTERNAL,
      summary: 'Delete Account File',
      description: 'Deletes one of the caller\'s retained conversion outputs.',
      operationId: 'deleteAccountFile',
      security: requireScope('storage:download'),
      parameters: [createPathParameter('id', 'File record identifier.')],
      responses: {
        '200': createJsonResponse('File deleted.', { success: { type: 'boolean' }, message: { type: 'string' } }),
        '400': createErrorResponse('Missing identifier.'),
        '401': createErrorResponse('Authentication required.'),
        '404': createErrorResponse('File not found or owned by another user.'),
      },
    },
  },
  '/api/auth/google/url': {
    get: {
      ...INTERNAL,
      summary: 'Start OAuth Sign-In',
      description: 'Returns the authorization URL and binds the OAuth state to the browser with an HttpOnly cookie.',
      operationId: 'getOAuthAuthorizationUrl',
      security: PUBLIC_ACCESS,
      responses: {
        '200': {
          ...createJsonResponse('Authorization URL.', { success: { type: 'boolean' }, url: { type: 'string' } }),
          headers: { 'Set-Cookie': { schema: { type: 'string' }, description: 'OAuth state cookie.' } },
        },
        '500': createErrorResponse('OAuth is not configured.'),
      },
    },
  },
  '/api/auth/google/callback': {
    get: {
      ...INTERNAL,
      summary: 'Complete OAuth Sign-In',
      description: 'Verifies the OAuth state cookie, exchanges the code, and redirects to the dashboard with a session cookie, or to `/auth?error=...`.',
      operationId: 'completeOAuthSignIn',
      security: PUBLIC_ACCESS,
      parameters: [
        { name: 'code', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
      ],
      responses: {
        '307': redirectResponse('Redirect to the dashboard on success or to the sign-in page with an error code.'),
      },
    },
  },
  '/api/auth/login': {
    post: {
      ...INTERNAL,
      summary: 'Sign In',
      operationId: 'login',
      security: PUBLIC_ACCESS,
      requestBody: credentialsBody(),
      responses: {
        '200': sessionUserResponse('Signed in.'),
        '400': createCodedErrorResponse('Invalid JSON, missing credentials, or a client address the forwarding headers do not name.', ['invalid_json', 'missing_fields', 'client_address_unknown']),
        '401': createCodedErrorResponse('Invalid email address or password.', ['invalid_credentials']),
        '429': {
          ...createProblemResponse('Too many failed attempts (problem type `rate-limited`, `code` "login_locked", the wait in `retryAfterSeconds`); see `Retry-After`.'),
          headers: { 'Retry-After': { schema: { type: 'integer' } } },
        },
        '500': createErrorResponse('Sign-in failed on the server (fixed `error`, no `code`).'),
        '503': createCodedErrorResponse('The client-IP trust configuration of the server is missing or invalid; see `Retry-After`.', ['client_ip_unconfigured']),
      },
    },
  },
  '/api/auth/logout': {
    post: {
      ...INTERNAL,
      summary: 'Sign Out',
      description: 'Revokes the current session token, if any, and clears the session cookie.',
      operationId: 'logout',
      security: PUBLIC_ACCESS,
      responses: {
        '200': {
          ...createJsonResponse('Signed out.', { success: { type: 'boolean' }, message: { type: 'string' } }),
          headers: sessionCookieHeader,
        },
      },
    },
  },
  '/api/auth/me': {
    get: {
      ...INTERNAL,
      summary: 'Get Current User',
      operationId: 'getCurrentUser',
      security: SESSION_ONLY,
      responses: {
        '200': createJsonResponse('Signed-in user.', { success: { type: 'boolean' }, user: { type: 'object' } }),
        '401': createErrorResponse('Not signed in.'),
      },
    },
  },
  '/api/auth/register': {
    post: {
      ...INTERNAL,
      summary: 'Register Account',
      operationId: 'register',
      security: PUBLIC_ACCESS,
      requestBody: credentialsBody({ name: { type: 'string' } }),
      responses: {
        '200': sessionUserResponse('Account created and signed in.'),
        '400': createCodedErrorResponse('Invalid JSON, email, or password length.', ['invalid_json', 'invalid_email', 'password_length']),
        '409': createCodedErrorResponse('Email address already registered.', ['account_exists']),
        '500': createErrorResponse('Registration failed on the server (fixed `error`, no `code`).'),
      },
    },
  },
  '/api/convert': {
    post: {
      ...INTERNAL,
      summary: 'Convert File (Web Application)',
      description: 'Converts one file and streams the result without retaining it. Anonymous callers use the IP quota.',
      operationId: 'convertFileInternal',
      security: ANONYMOUS_OR_SCOPE('convert:write'),
      requestBody: multipartBody(CONVERT_FORM_PROPERTIES, ['file', 'targetFormat']),
      responses: {
        '200': {
          ...binaryResponse('Converted file.'),
          headers: { ...FRAME_RESPONSE_HEADERS, ...DROPPED_STREAMS_RESPONSE_HEADERS, ...CONVERSION_WARNINGS_RESPONSE_HEADERS },
        },
        '400': createCodedErrorResponse('Invalid input, unsupported conversion, or spoofed file.', CONVERT_CODES[400]),
        '401': createProblemResponse('Authentication required.'),
        '422': {
          description: `Page count exceeds the tier limit, the document or the archive header is encrypted, password protected or DRM protected so its text cannot be read (with a \`code\` such as "password_required" or "encrypted_input"), a part of a multi-volume archive is missing ("missing_volume"), or: ${PDFA_PROBLEM_DESCRIPTION}`,
          content: {
            ...createCodedErrorResponse('', CONVERT_CODES[422]).content,
            'application/problem+json': createPdfaProblemResponse('').content['application/problem+json'],
          },
        },
        '411': createProblemResponse(LENGTH_REQUIRED_DESCRIPTION),
        '413': createProblemResponse(`${PAYLOAD_LIMIT_DESCRIPTION} Or: ${INPUT_PIXEL_LIMIT_DESCRIPTION} A file over the plan limit names \`plan\`, \`sizeBytes\` and \`limitBytes\`; a decode limit has \`code\` "input_over_limit".`),
        '429': createProblemResponse('Quota exhausted.' + CONCURRENCY_LIMIT_NOTE),
        '415': createCodedErrorResponse('The body is not `multipart/form-data`.', ['multipart_required']),
        '500': createErrorResponse('Conversion failed for a reason the server did not classify, answered with the fixed `error` "The conversion failed on the server." and no `code`.'),
        '499': createProblemResponse(CLIENT_CLOSED_DESCRIPTION),
        '503': createProblemResponse(ENGINE_UNAVAILABLE_DESCRIPTION),
        '504': createProblemResponse(JOB_TIMEOUT_DESCRIPTION),
      },
    },
  },
  '/api/convert/batch': {
    post: {
      ...INTERNAL,
      summary: 'Convert Files in Batch (Web Application)',
      description: 'Converts several files and returns them as one ZIP archive.',
      operationId: 'convertBatchInternal',
      security: ANONYMOUS_OR_SCOPE('convert:write'),
      requestBody: multipartBody({
        files: { type: 'array', items: { type: 'string', format: 'binary' }, description: `Up to ${formatBytes(SINGLE_REQUEST_FILE_MAX_BYTES)} in total, the most one request carries.` },
        targetFormats: { type: 'string', description: 'JSON map of filename to target format; `default` applies to the rest.' },
        options: { type: 'string', description: CONVERT_OPTIONS_DESCRIPTION },
      }, ['files']),
      responses: {
        '200': binaryResponse('ZIP archive of converted files.', 'application/zip'),
        '400': {
          description:
            'No files, invalid input, or nothing could be converted. A file the dispatcher rejects (spoofed signature, malformed input) returns a problem document.',
          content: {
            ...createErrorResponse('').content,
            'application/problem+json': createProblemResponse('').content['application/problem+json'],
          },
        },
        '401': createProblemResponse('Authentication required.'),
        '422': createPdfaProblemResponse(`The document is encrypted, password protected or DRM protected so its text cannot be read. ${PDFA_PROBLEM_DESCRIPTION}`),
        '411': createProblemResponse(LENGTH_REQUIRED_DESCRIPTION),
        '413': createProblemResponse(`${PAYLOAD_LIMIT_DESCRIPTION} Or: ${INPUT_PIXEL_LIMIT_DESCRIPTION}`),
        '429': createProblemResponse('Quota exhausted.' + CONCURRENCY_LIMIT_NOTE),
        '500': createErrorResponse('Conversion failed.'),
        '499': createProblemResponse(CLIENT_CLOSED_DESCRIPTION),
        '503': createProblemResponse(ENGINE_UNAVAILABLE_DESCRIPTION),
        '504': createProblemResponse(JOB_TIMEOUT_DESCRIPTION),
      },
    },
  },
  '/api/fetch-url': {
    post: {
      ...INTERNAL,
      summary: 'Fetch Remote File',
      description: 'Downloads a public HTTP(S) file for conversion. Every redirect hop is checked against private address ranges.',
      operationId: 'fetchRemoteFile',
      security: ANONYMOUS_OR_SCOPE('convert:write'),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' } } },
          },
        },
      },
      responses: {
        '200': binaryResponse('Remote file content; `X-Filename` holds the URI-encoded name.'),
        '400': createCodedErrorResponse('A body that is not a JSON object, a missing or invalid URL, or the remote server returned 4xx (its status in `remoteStatus`).', URL_IMPORT_CODES[400]),
        '401': createProblemResponse('Authentication required.'),
        '403': createCodedErrorResponse('URL resolves to a private address.', ['address_blocked']),
        '413': createCodedErrorResponse('Remote file exceeds the 100 MB limit of an import from a link. A file of up to the plan limit is added from the device.', ['file_too_large']),
        '429': linkImportBudgetResponse(
          'The daily byte budget of the caller refuses the import (problem type `https://api.easyconvert.io/problems/upload-budget-exceeded`, with `limitBytes`, and `plan` for an account). `refusal` "daily-bytes": the budget was used up before the import started, or the bytes it read took the day past the budget, which stops it; both last until midnight UTC. `refusal` "larger-than-left": the file declares a length larger than the `leftBytes` the day has left, and is refused before it is read. The bytes an import reads count toward the budget however it ends. A file past the import limit is the 413. Or the caller has no conversion left today (problem type `https://api.easyconvert.io/problems/quota-exceeded`).' +
            CONCURRENCY_LIMIT_NOTE
        ),
        '499': createProblemResponse('The client closed the connection before the import finished (problem type `https://api.easyconvert.io/problems/client-closed-request`). The bytes received until the import stopped count toward the daily byte budget.'),
        '502': createCodedErrorResponse('Redirect failure, remote 5xx (its status in `remoteStatus`), or empty body.', URL_IMPORT_CODES[502]),
        '500': createCodedErrorResponse('The file could not be fetched for a reason the server did not classify (fixed `error`).', ['fetch_failed']),
        '503': createProblemResponse('An anonymous caller while the server cannot tell visitors apart (problem type `https://api.easyconvert.io/problems/client-ip-trust-unconfigured`).'),
        '504': createCodedErrorResponse('The remote did not send the whole file within the synchronous deadline.', ['fetch_timeout']),
      },
    },
  },
  '/api/health': {
    get: {
      ...INTERNAL,
      summary: 'Health Check',
      description:
        'Readiness probe built from live checks: Redis PING (only when Redis is configured) and storage reachability decide the status; a failure of either makes the service unhealthy (503). ' +
        'The native tools soffice, ffmpeg, ffprobe, pdftoppm, pdftotext, tesseract, 7z and dcraw_emu are probed as advisory components: a missing tool fails only the conversions that need it. Results are cached for a few seconds. ' +
        'Anonymous callers receive only `status`. A request with an API key holding the admin wildcard (*) scope also receives the per-component view; the view names components and coarse reasons, never paths, hosts or credentials.',
      operationId: 'getHealth',
      security: ANONYMOUS_OR_SCOPE('*'),
      responses: {
        '200': healthResponse('Redis (when configured) and storage are available.'),
        '401': createProblemResponse('The API key is invalid.'),
        '403': createProblemResponse('The API key lacks the admin wildcard (*) scope.'),
        '503': healthResponse('Redis or storage is unavailable.'),
      },
    },
  },
  '/api/health/conversion': {
    get: {
      ...INTERNAL,
      summary: 'Deploy Smoke Conversion',
      description:
        'The check the deploy runs after a release starts: a one-pixel PPM of the route\'s own, converted to PNG through the conversion dispatcher, so the native engines run in their sandbox. ' +
        'It reads nothing of the request and charges no daily allowance. The host proxy does not forward it; only the loopback port of the web service answers it.',
      operationId: 'getSmokeConversion',
      security: PUBLIC_ACCESS,
      responses: {
        '200': binaryResponse('The one-pixel PNG.', 'image/png'),
        '500': createProblemResponse('The conversion failed on the server.'),
        '504': createProblemResponse('The conversion did not finish within 30 seconds.'),
      },
    },
  },
  '/api/queue/jobs': {
    post: {
      ...INTERNAL,
      summary: 'Enqueue Conversion Job (Web Application)',
      operationId: 'enqueueJobInternal',
      security: ANONYMOUS_OR_SCOPE('convert:write'),
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['targetFormat'],
              properties: {
                file: { type: 'string', format: 'binary' },
                targetFormat: { type: 'string' },
                options: { type: 'string' },
                storageKey: { type: 'string' },
              },
            },
          },
          'application/json': {
            schema: {
              type: 'object',
              required: ['targetFormat'],
              properties: {
                filename: { type: 'string' },
                targetFormat: { type: 'string' },
                options: { type: 'object' },
                storageKey: { type: 'string' },
                inputBufferBase64: { type: 'string' },
                fileSize: { type: 'integer' },
              },
            },
          },
        },
      },
      responses: {
        '200': createJsonResponse('Job enqueued.', {
          success: { type: 'boolean' },
          jobId: { type: 'string' },
          status: { type: 'string' },
          progress: { type: 'number' },
          createdAt: { type: 'number' },
          queue: { type: 'string' },
        }),
        '400': createErrorResponse('Missing target format or invalid input.'),
        '401': createErrorResponse('Authentication required.'),
        '404': createErrorResponse('Storage object not found or not usable by the caller.'),
        '409': createProblemResponse('A request with the same `Idempotency-Key` is still running; send it again after `Retry-After`.'),
        '411': createProblemResponse(LENGTH_REQUIRED_DESCRIPTION),
        '413': createProblemResponse(`${PLAN_FILE_LIMIT_DESCRIPTION} Or: a file in the request (multipart \`file\` or \`inputBufferBase64\`) is over ${formatBytes(INLINE_JOB_PAYLOAD_MAX_BYTES)}; a larger file is uploaded through \`/api/storage/multipart\` and named by \`storageKey\`.`),
        '500': createErrorResponse('Enqueue failed.'),
      },
    },
    get: {
      ...INTERNAL,
      summary: 'List Queue Jobs (Web Application)',
      operationId: 'listJobsInternal',
      security: requireScope('convert:read'),
      parameters: [
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['waiting', 'active', 'completed', 'failed', 'delayed', 'cancelled'] },
        },
      ],
      responses: {
        '200': createJsonResponse('Up to 50 jobs.', {
          success: { type: 'boolean' },
          total: { type: 'integer' },
          jobs: { type: 'array', items: { type: 'object' } },
        }),
        '400': createErrorResponse('Invalid status filter.'),
        '401': createErrorResponse('Authentication required.'),
      },
    },
  },
  '/api/queue/jobs/{id}': {
    get: {
      ...INTERNAL,
      summary: 'Get Queue Job (Web Application)',
      description: 'Returns job state, or a Server-Sent Events stream with `?stream=true` or `Accept: text/event-stream`.',
      operationId: 'getJobInternal',
      security: ANONYMOUS_OR_SCOPE('convert:read'),
      parameters: [
        createPathParameter('id', 'Job identifier.'),
        { name: 'stream', in: 'query', required: false, schema: { type: 'string', enum: ['true'] } },
      ],
      responses: {
        '200': {
          description: 'Job state, or an event stream that closes on a terminal state. A failed job names its cause in `failedRefusalCode` (one of the `code` values of `POST /api/convert`) next to `failedCode`, `failedStatus` and `failedReason`.',
          content: {
            'application/json': { schema: { type: 'object' } },
            'text/event-stream': { schema: { type: 'string' } },
          },
        },
        '404': createErrorResponse('Job not found or owned by another user.'),
      },
    },
    delete: {
      ...INTERNAL,
      summary: 'Cancel Queue Job (Web Application)',
      operationId: 'cancelJobInternal',
      security: ANONYMOUS_OR_SCOPE('convert:write'),
      parameters: [createPathParameter('id', 'Job identifier.')],
      responses: {
        '200': createJsonResponse('Job cancelled.', { success: { type: 'boolean' }, message: { type: 'string' } }),
        '404': createErrorResponse('Job not found or owned by another user.'),
        '409': createErrorResponse('Job can no longer be cancelled, or it is one node of a graph job (`graphId` names the graph, which is cancelled as a whole).'),
      },
    },
  },
  '/api/queue/stats': {
    get: {
      ...INTERNAL,
      summary: 'Get Queue Statistics',
      operationId: 'getQueueStats',
      security: PUBLIC_ACCESS,
      responses: {
        '200': createJsonResponse('Queue counts and process statistics.', {
          success: { type: 'boolean' },
          queue: { type: 'string' },
          counts: { type: 'object' },
          storage: { type: 'object' },
          system: { type: 'object' },
        }),
      },
    },
  },
  '/api/storage/multipart': {
    post: {
      ...INTERNAL,
      summary: 'Legacy Multipart Upload',
      description:
        'Web application upload flow selected by `action`: `initiate` (JSON `filename`, `totalSize`, optional `mimeType` and `partSize` from 5 MiB to 64 MiB, and an optional `Idempotency-Key` header that makes it safe to send again), `chunk` (raw body of at most 64 MiB with `x-upload-id` and `x-part-number`, and a `Content-Length`; parts sent at once are held together to `totalSize`), `complete` (parts numbered 1, 2, 3 and so on, holding exactly `totalSize`, and an optional `Idempotency-Key`), `abort`, `discard` (JSON `key`: deletes a completed upload no job reads), or `presign` (no part link for an upload without an account). The browser sends a file over 64 MiB this way, then starts a job with `POST /api/queue/jobs` on the stored `key`; an upload no job reads is deleted after an hour. An anonymous visitor may use it: its session and its stored key are reached by their random id and key, and it may have 2 uploads open and declare 2 GiB a day. An `Idempotency-Key` is scoped to the account, or to the address bucket of an anonymous visitor. Public clients use `/api/v1/uploads`.',
      operationId: 'legacyMultipartUpload',
      security: ANONYMOUS_OR_SCOPE('convert:write'),
      parameters: [
        {
          name: 'action',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['initiate', 'chunk', 'complete', 'abort', 'discard', 'presign'], default: 'initiate' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { type: 'object' } },
          'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
        },
      },
      responses: {
        '200': createJsonResponse('Action result.', { success: { type: 'boolean' } }),
        '400': createProblemResponse('Unknown action or invalid input.'),
        '401': createProblemResponse('Authentication required.'),
        '403': createProblemResponse('`presign` of a part of an upload without an account.'),
        '404': createProblemResponse('Upload not found, or not usable by the caller.'),
        '409': createProblemResponse('`discard` of an upload a job reads, or a repeat of an `Idempotency-Key` that is still running.'),
        '411': createProblemResponse(LENGTH_REQUIRED_DESCRIPTION),
        '413': createProblemResponse(`${PLAN_FILE_LIMIT_DESCRIPTION} Or: a part is over 64 MiB, or would bring the upload past its \`totalSize\` with the parts stored and on the way.`),
        '429': createProblemResponse('No conversion could start for the caller now (the daily quota or the conversions in progress), or an anonymous visitor has 2 uploads open or has declared 2 GiB today.'),
        '503': createProblemResponse('A part, a completion or an abort could not reach the store or the budget; send it again after `Retry-After`. Or: uploads without an account are off because no proxy is declared (`TRUSTED_PROXIES`).'),
      },
    },
  },
  '/api/openapi.json': {
    get: {
      ...INTERNAL,
      summary: 'Get OpenAPI Document',
      operationId: 'getOpenApiDocument',
      security: PUBLIC_ACCESS,
      responses: openApiDocumentResponse,
    },
  },
  '/api/v1/openapi': {
    get: {
      ...INTERNAL,
      summary: 'Get OpenAPI Document (Alias)',
      operationId: 'getOpenApiDocumentV1',
      security: PUBLIC_ACCESS,
      responses: openApiDocumentResponse,
    },
  },
  '/api/v1/openapi.json': {
    get: {
      ...INTERNAL,
      summary: 'Get OpenAPI Document (JSON Alias)',
      operationId: 'getOpenApiDocumentJsonV1',
      security: PUBLIC_ACCESS,
      responses: openApiDocumentResponse,
    },
  },
};
