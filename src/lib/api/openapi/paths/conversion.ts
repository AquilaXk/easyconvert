import { JobCreateRequestSchema } from '@/lib/api/contracts';
import {
  CONVERT_FORM_PROPERTIES,
  IDEMPOTENCY_KEY_PARAMETER,
  createPathParameter,
  createProblemResponse,
  multipartBody,
  requireScope,
  FRAME_RESPONSE_HEADERS,
} from '../shared';
import { ENGINE_UNAVAILABLE_PROBLEM_TYPE } from '@/lib/api/problem-details';

const ENGINE_UNAVAILABLE_DESCRIPTION = `The pair needs a native engine that is not installed on this deployment (problem type \`${ENGINE_UNAVAILABLE_PROBLEM_TYPE}\`; quota reservation rolled back).`;

/** Conversion, archive inspection, job, and format catalog operations. */
export const conversionPaths = {
  '/api/v1/archives/inspect': {
    post: {
      summary: 'Inspect Archive Metadata',
      description:
        'Inspects archive structure, entry metadata, and encryption status without extracting uncompressed contents. Supports ZIP, 7z, TAR, RAR, and compressed TAR variants.',
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
      parameters: [IDEMPOTENCY_KEY_PARAMETER],
      requestBody: multipartBody(CONVERT_FORM_PROPERTIES, ['file', 'targetFormat']),
      responses: {
        '200': {
          description: 'Successful conversion returning file metadata or raw binary stream.',
          headers: FRAME_RESPONSE_HEADERS,
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
        '400': createProblemResponse('Invalid input format, missing parameter, or unsupported conversion pair.'),
        '401': createProblemResponse('Missing, expired, or invalid API key.'),
        '403': createProblemResponse('Access denied due to IP address, CIDR whitelist, or missing "convert:write" scope.'),
        '409': createProblemResponse('A request with the same idempotency key is currently in-flight. Retry after delay.'),
        '422': createProblemResponse('An idempotency key was reused with a different request payload or parameters.'),
        '429': createProblemResponse('Rate limit or daily conversion quota exhausted.'),
        '500': createProblemResponse('Internal engine processing failure (quota reservation rolled back).'),
        '503': createProblemResponse(ENGINE_UNAVAILABLE_DESCRIPTION),
      },
    },
  },
  '/api/v1/jobs': {
    post: {
      summary: 'Submit Asynchronous Conversion Job',
      description:
        'Enqueues a conversion job to the distributed BullMQ queue with automatic 2-phase quota reservation and optional HMAC-signed webhook callback. Requires "convert:write" scope.',
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
                  description: 'Source input file binary (up to 500 MB).',
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
                options: { type: 'string', description: 'JSON-serialized conversion options.' },
                tasks: {
                  type: 'string',
                  description: 'JSON-serialized array of sequential pipeline tasks: [{ name, operation, targetFormat, options }].',
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
        '422': createProblemResponse(
          'The graph or pipeline tasks failed validation (for example, a merge with fewer than 2 inputs), or an idempotency key was reused with a different request payload.'
        ),
        '429': createProblemResponse('Daily conversion quota exhausted.'),
        '500': createProblemResponse('Job enqueue failure.'),
      },
    },
    get: {
      summary: 'List Conversion Jobs',
      description: 'Returns asynchronous conversion jobs created by the authenticated user. Requires "convert:read" scope.',
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
          schema: { type: 'integer', default: 50 },
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
      description: 'Polls status, real-time progress, logs, and artifacts of a specific conversion job. Requires "convert:read" scope.',
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
        '409': createProblemResponse('Job has already completed, failed, or cannot be cancelled.'),
      },
    },
  },
  '/api/formats': {
    get: {
      summary: 'List Supported Formats',
      description: 'Returns all supported file formats, categories, and bidirectional conversion targets.',
      operationId: 'getFormats',
      responses: {
        '200': {
          description: 'Dictionary of supported format definitions.',
        },
      },
    },
  },
};
