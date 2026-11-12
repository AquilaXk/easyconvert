import { JobCreateRequestSchema } from '@/lib/api/contracts';
import {
  CONVERT_FORM_PROPERTIES,
  CONVERT_WEBHOOK_FORM_PROPERTIES,
  CONVERT_OPTIONS_DESCRIPTION,
  IDEMPOTENCY_KEY_PARAMETER,
  PREFER_RESPOND_ASYNC_PARAMETER,
  RAW_RESULT_PARAMETER,
  createPathParameter,
  PDFA_ENGINE_NOTE,
  PDFA_PROBLEM_DESCRIPTION,
  createCodedPdfaProblemResponse,
  createCodedProblemResponse,
  createTooManyRequestsResponse,
  V1_CONVERT_CODES,
  createPdfaProblemResponse,
  INPUT_PIXEL_LIMIT_DESCRIPTION,
  createProblemResponse,
  multipartBody,
  requireScope,
  FRAME_RESPONSE_HEADERS,
  ENGINE_RESPONSE_HEADERS,
  CONVERSION_WARNINGS_RESPONSE_HEADERS,
  DROPPED_STREAMS_RESPONSE_HEADERS,
  CLIENT_CLOSED_DESCRIPTION,
  CONCURRENCY_LIMIT_NOTE,
  JOB_TIMEOUT_DESCRIPTION,
  DECODE_LIMIT_DESCRIPTION,
  LENGTH_REQUIRED_DESCRIPTION,
  PLAN_FILE_LIMIT_DESCRIPTION,
  SINGLE_REQUEST_LIMIT_DESCRIPTION,
  PUBLIC_ACCESS,
} from '../shared';
import { SYNC_CONVERSION_MAX_BYTES } from '@/lib/api/file-size-limit';
import { formatBytes } from '@/lib/format-bytes';
import { ENGINE_UNAVAILABLE_PROBLEM_TYPE } from '@/lib/api/problem-details';
import { ENGINE_IDS } from '@/lib/conversions/engine-ids';

const ENGINE_UNAVAILABLE_DESCRIPTION = `The pair needs a native engine that is not installed on this deployment (problem type \`${ENGINE_UNAVAILABLE_PROBLEM_TYPE}\`; quota reservation rolled back).${PDFA_ENGINE_NOTE}`;
/** A file sent in the request: one request carries at most 64 MiB, so the plan limit is reached only by a stored file. */
const REQUEST_PAYLOAD_LIMIT_DESCRIPTION = `${SINGLE_REQUEST_LIMIT_DESCRIPTION} ${DECODE_LIMIT_DESCRIPTION} The quota reservation is rolled back.`;
const STORED_PAYLOAD_LIMIT_DESCRIPTION = `${PLAN_FILE_LIMIT_DESCRIPTION} Or: ${REQUEST_PAYLOAD_LIMIT_DESCRIPTION}`;

/** Conversion, archive inspection, job, and format catalog operations. */
export const conversionPaths = {
  '/api/v1/archives/inspect': {
    post: {
      summary: 'Inspect Archive Metadata',
      description:
        'Inspects archive structure, entry metadata, and encryption status without extracting uncompressed contents. Supports ZIP, 7z, TAR, RAR, lzip, lzop, and compressed TAR variants.',
      operationId: 'inspectArchiveV1',
      security: requireScope('convert:write'),
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: {
                file: {
                  type: 'string',
                  format: 'binary',
                  description: 'Archive file binary to inspect.',
                },
                password: {
                  type: 'string',
                  description: 'Optional password for encrypted headers or entries.',
                },
              },
            },
          },
          'application/json': {
            schema: {
              type: 'object',
              required: ['storageKey'],
              properties: {
                storageKey: {
                  type: 'string',
                  description: 'Storage key of previously uploaded archive.',
                },
                filename: {
                  type: 'string',
                  description: 'Optional filename hint.',
                },
                password: {
                  type: 'string',
                  description: 'Optional password for encrypted headers.',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Archive successfully inspected.',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ArchiveInspectResponse',
              },
            },
          },
        },
        '400': createProblemResponse('Bad request or missing required parameters.'),
        '401': createProblemResponse('Unauthorized: API key or session required.'),
        '403': createProblemResponse('Forbidden: Insufficient scope or quota exhausted.'),
        '411': createProblemResponse(LENGTH_REQUIRED_DESCRIPTION),
        '413': createProblemResponse(STORED_PAYLOAD_LIMIT_DESCRIPTION),
        '422': createProblemResponse('Unprocessable Entity: Header encrypted, missing volume, or invalid archive.'),
        '500': createProblemResponse('Internal server error.'),
      },
    },
  },
  '/api/v1/convert': {
    post: {
      summary: 'Synchronous File Conversion',
      description:
        'Converts an uploaded file synchronously. Protected by 2-phase quota transactions (reserve -> commit/rollback). Requires "convert:write" scope.',
      operationId: 'convertFileV1',
      security: requireScope('convert:write'),
      parameters: [IDEMPOTENCY_KEY_PARAMETER, PREFER_RESPOND_ASYNC_PARAMETER, RAW_RESULT_PARAMETER],
      requestBody: multipartBody({ ...CONVERT_FORM_PROPERTIES, ...CONVERT_WEBHOOK_FORM_PROPERTIES }, ['file', 'targetFormat']),
      responses: {
        '200': {
          description: 'Successful conversion returning file metadata or raw binary stream.',
          headers: { ...FRAME_RESPONSE_HEADERS, ...ENGINE_RESPONSE_HEADERS, ...DROPPED_STREAMS_RESPONSE_HEADERS, ...CONVERSION_WARNINGS_RESPONSE_HEADERS },
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ConversionResponse',
              },
            },
            'application/octet-stream': {
              schema: {
                type: 'string',
                format: 'binary',
              },
            },
          },
        },
        '202': {
          description: `The file is over ${formatBytes(SYNC_CONVERSION_MAX_BYTES)}, or the request sent \`Prefer: respond-async\`: the conversion is queued as a job. Poll \`statusUrl\` (also in the \`Location\` header) for its result.`,
          headers: { Location: { description: 'Path of the job status.', schema: { type: 'string', example: '/api/v1/jobs/job_1720000000000_abc123' } } },
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  status: { type: 'string', example: 'accepted' },
                  jobId: { type: 'string', example: 'job_1720000000000_abc123' },
                  statusUrl: { type: 'string', example: '/api/v1/jobs/job_1720000000000_abc123' },
                  sourceFormat: { type: 'string' },
                  targetFormat: { type: 'string' },
                  originalFilename: { type: 'string' },
                  fileSize: { type: 'integer' },
                  createdAt: { type: 'number' },
                },
              },
            },
          },
        },
        '400': createCodedProblemResponse('Invalid input format, missing parameter, a text field such as `options` sent as a file, an unsupported conversion pair, or a body declared `multipart/form-data` that cannot be parsed.', V1_CONVERT_CODES[400]),
        '401': createProblemResponse('Missing, expired, or invalid API key.'),
        '403': createProblemResponse('Access denied due to IP address, CIDR whitelist, or missing "convert:write" scope.'),
        '409': createProblemResponse('A request with the same idempotency key is currently in-flight. Retry after delay.'),
        '422': createCodedPdfaProblemResponse(
          'The request is understood and refused. Problem type `https://api.easyconvert.io/problems/idempotency-key-reused`: an idempotency key was reused with a different request payload or parameters. ' +
            'Problem type `https://api.easyconvert.io/problems/unprocessable-entity`, or `.../option-not-supported` for an option that is planned and not yet supported: `options` fail the contract (the fields in `invalidParams`). ' +
            'Or the file is intact but the engine cannot convert it: the document is encrypted, password protected or DRM protected so its text cannot be read, an archive uses a method no engine here decodes, a CAD or font file the readers refuse, an audio file with no samples, or the conversion overran its CPU limit; these name the cause in `code`. ' +
            'An archive whose entry names collide when unpacked is also a 422, titled "Archive Entry Collision", with the `code` "archive_entry_collision". ' +
            'An `options.engine` that the pair does not list (or an engine id nobody knows, or `engineVersion` without an engine) is a 422 with the `code` "engine_not_offered" and the engines the pair lists in `engines`; an `options.engineVersion` other than the installed one is a 422 with the `code` "engine_version_unavailable" and the installed version in `installedVersion`. Both are answered before anything is reserved. ' +
            PDFA_PROBLEM_DESCRIPTION,
          V1_CONVERT_CODES[422]
        ),
        '411': createProblemResponse(LENGTH_REQUIRED_DESCRIPTION),
        '413': createProblemResponse(`${REQUEST_PAYLOAD_LIMIT_DESCRIPTION} Or: ${INPUT_PIXEL_LIMIT_DESCRIPTION}`),
        '415': createProblemResponse('The body is not `multipart/form-data`.'),
        '429': createTooManyRequestsResponse(''),
        '500': createProblemResponse('Internal engine processing failure (quota reservation rolled back).'),
        '499': createProblemResponse(CLIENT_CLOSED_DESCRIPTION),
        '503': createCodedProblemResponse(`The quota store is offline (problem type \`https://api.easyconvert.io/problems/service-unavailable\`, no \`code\`, \`Retry-After\` 5). Or, with the \`code\` "engine_unavailable" and \`Retry-After\` 5: ${ENGINE_UNAVAILABLE_DESCRIPTION}`, V1_CONVERT_CODES[503]),
        '504': createProblemResponse(JOB_TIMEOUT_DESCRIPTION),
      },
    },
  },
  '/api/v1/ocr/languages': {
    get: {
      summary: 'List OCR Languages',
      description:
        'Lists every language the OCR engine has published data for, with its short code, script, text direction and whether this server has the data installed (read from the configured language data directories once at start). Request a language with `ocrLanguage` by its `code` or `traineddata`; join up to `maxLanguagesPerRequest` with `+`. Requires "convert:read" scope. The answer may be cached for a few minutes.',
      operationId: 'listOcrLanguagesV1',
      security: requireScope('convert:read'),
      responses: {
        '200': {
          description: 'The OCR languages.',
          headers: {
            'Cache-Control': {
              description: 'Private cache lifetime; the installed set changes only when the server restarts.',
              schema: { type: 'string', example: 'private, max-age=300' },
            },
          },
          content: { 'application/json': { schema: { $ref: '#/components/schemas/OcrLanguagesResponse' } } },
        },
        '401': createProblemResponse('Missing, expired, or invalid API key.'),
        '403': createProblemResponse('Access denied due to IP address, CIDR whitelist, or missing "convert:read" scope.'),
      },
    },
  },
  '/api/v1/jobs': {
    post: {
      summary: 'Submit Asynchronous Conversion Job',
      description:
        'Enqueues a conversion job to the distributed Redis-backed job queue with automatic 2-phase quota reservation and optional HMAC-signed webhook callback. Requires "convert:write" scope.',
      operationId: 'createJobV1',
      security: requireScope('convert:write'),
      parameters: [IDEMPOTENCY_KEY_PARAMETER],
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['targetFormat'],
              properties: {
                file: {
                  type: 'string',
                  format: 'binary',
                  description: 'Source input file binary, up to 32 MiB in the request. A larger file is uploaded through `/api/v1/uploads` and named by `storageKey`.',
                },
                targetFormat: {
                  type: 'string',
                  description: 'Target format extension. With `tasks`, the final task determines the output format.',
                },
                sourceFormat: { type: 'string', description: 'Source format extension.' },
                storageKey: {
                  type: 'string',
                  description: 'Key of an object from the multipart upload API (`uploads/...`), or an output owned by the caller (`conversions/{userId}/...`, `results/{jobId}/...`). Any other key returns 404.',
                },
                options: { type: 'string', description: CONVERT_OPTIONS_DESCRIPTION },
                tasks: {
                  type: 'string',
                  description: 'JSON-serialized array of sequential pipeline tasks: [{ name, operation, targetFormat, options }], or a JSON-serialized object of named tasks (a task graph) keyed by task name, as `tasks` of the JSON body.',
                },
                webhookUrl: { type: 'string', format: 'uri', description: 'Destination URL for job events.' },
                webhookSecret: { type: 'string', description: 'Secret used for HMAC-SHA256 signature.' },
              },
            },
          },
          'application/json': {
            schema: {
              ...JobCreateRequestSchema,
              $id: undefined,
            },
          },
        },
      },
      responses: {
        '202': {
          description: 'Job successfully accepted and enqueued.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  jobId: { type: 'string', example: 'job_1720000000000_abc123' },
                  status: { type: 'string', example: 'waiting' },
                  statusUrl: { type: 'string', example: '/api/v1/jobs/job_1720000000000_abc123' },
                  createdAt: { type: 'number', example: 1720000000000 },
                  reservationId: { type: 'string' },
                  sourceFormat: { type: 'string', example: 'pdf' },
                  targetFormat: {
                    type: 'string',
                    example: 'jpg',
                    description: 'Format of the job output. For a task pipeline, the output format of the final task.',
                  },
                  originalFilename: { type: 'string' },
                  tasks: {
                    type: 'object',
                    description: 'A job submitted as named tasks: the report of each task by name (all `waiting` or `active` when the job is accepted).',
                    additionalProperties: { $ref: '#/components/schemas/TaskReport' },
                  },
                },
              },
            },
          },
        },
        '400': createProblemResponse('Bad request or parameter validation failure.'),
        '401': createProblemResponse('Missing, expired, or invalid API key.'),
        '403': createProblemResponse('Access denied due to IP address or missing "convert:write" scope.'),
        '404': createProblemResponse('Storage object not found, or not usable by the caller as an input.'),
        '409': createProblemResponse('A request with the same idempotency key is currently in-flight. Retry after delay.'),
        '411': createProblemResponse(LENGTH_REQUIRED_DESCRIPTION),
        '422': createProblemResponse(
          'The graph or pipeline tasks failed validation (for example, a merge with fewer than 2 inputs), an idempotency key was reused with a different request payload, or the graph has no conversion (problem type `https://api.easyconvert.io/problems/graph-without-conversion`): a graph that only imports and exports files is refused before anything is reserved. Named tasks are refused with a problem type of their own when the cause is a task name (`task-name-invalid`: not a lowercase letter then lowercase letters, digits, `-` or `_`, up to 64 characters; `task-name-duplicate`: the same name twice in the object), the count (`task-count-exceeded`: more than 8 tasks on the free plan, 24 on pro, 32 on the largest plan), an `input` that names no task (`task-input-unknown`) or tasks that read each other in a loop (`task-graph-cycle`); `invalidParams` names each task (`tasks.convert-1.input`). Any other fault of the tasks (a field the operation does not take, a missing `output_format`, a conversion the formats do not allow) is the generic `unprocessable-entity`, also with `invalidParams` by task. Nothing is reserved or charged for a refused request. ' +
            'Or an `engine` that the conversion does not list (the `code` "engine_not_offered", with the engines it lists in `engines`) or an `engineVersion` that is not installed (the `code` "engine_version_unavailable", with `installedVersion`), in the job\'s `options` in a pipeline task or in a named task. In a graph, the engine ids and versions are checked here and the pair of each node when the node runs, which fails that node with the same code.'
        ),
        '429': createProblemResponse(
          'The day has fewer conversions left than the job needs (problem type `https://api.easyconvert.io/problems/quota-exceeded`, with `dailyLimit`, `remaining` and `requiredUnits`). A graph needs one unit for each input declared by a node that makes one output of each input (`convert`, `ocr`, `optimize`, `thumbnail`, `metadata.write`, `media.package`, `watermark` and the `pdf.*` page operations) and one for each `merge`, `metadata`, `archive.create` or `archive.extract` node. A node whose inputs hold more files than it declares (an unpacked archive) takes the rest of its units when it starts, and fails with the refusal code `quota_exceeded` when the day has too few left.' +
            CONCURRENCY_LIMIT_NOTE
        ),
        '500': createProblemResponse('Job enqueue failure.'),
      },
    },
    get: {
      summary: 'List Conversion Jobs',
      description:
        'Returns the asynchronous conversion jobs and job graphs of the authenticated user, newest first, at most `limit`. A graph is listed once, under its own id (`GET /api/v1/jobs/{id}` answers for it, with its nodes); the node jobs it queues are not listed. A running graph reports the status `active`, and answers to the `waiting` and `active` filters. Requires "convert:read" scope.',
      operationId: 'listJobsV1',
      security: requireScope('convert:read'),
      parameters: [
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: { type: 'string', example: 'waiting,active,completed' },
          description: 'Filter by job states (comma-separated).',
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', default: 50, minimum: 1, maximum: 100 },
        },
      ],
      responses: {
        '200': {
          description: 'List of jobs.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  total: { type: 'integer' },
                  jobs: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/JobSummary' },
                  },
                },
              },
            },
          },
        },
        '401': createProblemResponse('Unauthorized.'),
      },
    },
  },
  '/api/v1/jobs/{id}': {
    get: {
      summary: 'Get Job Status and Details',
      description: 'Polls status, real-time progress, logs, and artifacts of a specific conversion job. A job submitted as named tasks reports each task under its name in `tasks`: its `status`, for an `export/url` task without a `url` the `result` with the `downloadUrl` of each file it kept, and for a task that did not complete its `error` (a `code` and a `message`; a task that did not run because a task it reads failed is `failed` with the code `dependency_failed` and the failed task in `error.task`). The job `status` is `failed` when a task failed, and `failedTask` names it. Requires "convert:read" scope.',
      operationId: 'getJobStatusV1',
      security: requireScope('convert:read'),
      parameters: [
        createPathParameter('id', 'Conversion job identifier.'),
      ],
      responses: {
        '200': {
          description: 'Job details.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/JobDetails' },
            },
          },
        },
        '401': createProblemResponse('Unauthorized.'),
        '403': createProblemResponse('Access denied.'),
        '404': createProblemResponse('Job not found.'),
      },
    },
    delete: {
      summary: 'Cancel Asynchronous Conversion Job',
      description:
        'Cancels a waiting, delayed, or active conversion job, aborting worker processing and rolling back reserved quota units. Requires "convert:write" scope.',
      operationId: 'cancelJobV1',
      security: requireScope('convert:write'),
      parameters: [
        createPathParameter('id', 'Conversion job identifier.'),
      ],
      responses: {
        '200': {
          description: 'Job cancellation acknowledged and quota reservation rolled back.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  jobId: { type: 'string' },
                  status: { type: 'string', example: 'cancelled' },
                  message: { type: 'string' },
                  quotaRollback: { type: 'boolean' },
                },
              },
            },
          },
        },
        '400': createProblemResponse('Missing or invalid job identifier.'),
        '401': createProblemResponse('Unauthorized.'),
        '403': createProblemResponse('Access denied.'),
        '404': createProblemResponse('Job not found.'),
        '409': createProblemResponse('Job has already completed, failed, or cannot be cancelled, or it is one node of a graph job (`graphId` names the graph, which is cancelled as a whole).'),
      },
    },
  },
  '/api/formats': {
    get: {
      summary: 'List Supported Formats and Engines',
      description:
        'Returns all supported file formats, categories, and conversion targets, and the engines of this deployment with their installed versions. ' +
        'With `source`, `target` or `engine` it also lists, for each pair they select, the engines that convert it: the id to send as `options.engine`, the installed version to send as `options.engineVersion`, whether the engine is the default for the pair (the one that runs when a request names none) and whether its program is installed. ' +
        'Only the engines a pair really has are listed; a pair that one program or the in-process converter alone converts lists that one.',
      operationId: 'getFormats',
      security: PUBLIC_ACCESS,
      parameters: [
        { name: 'source', in: 'query', required: false, schema: { type: 'string', example: 'docx' }, description: 'Source format extension: lists the engines of each target of this format.' },
        { name: 'target', in: 'query', required: false, schema: { type: 'string', example: 'pdf' }, description: 'Target format extension: with `source`, one pair; alone, every source that converts to it.' },
        { name: 'engine', in: 'query', required: false, schema: { type: 'string', enum: [...ENGINE_IDS] }, description: 'Keeps the pairs that list this engine.' },
      ],
      responses: {
        '200': {
          description: 'Dictionary of supported format definitions, the engines of the deployment and, when asked, the engines of each selected pair.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/FormatsResponse' } } },
        },
        '400': createProblemResponse('A `source`, `target` or `engine` that names no format or engine (an unknown engine answers with the known ids in `engines`).'),
      },
    },
  },
};
