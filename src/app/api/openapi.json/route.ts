import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const createProblemResponse = (description: string) => ({
  description,
  content: {
    'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
    'application/json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
  },
});

export async function GET() {
  const openApiSpec = {
    openapi: '3.1.0',
    info: {
      title: 'EasyConvert Enterprise REST API',
      version: '1.0.0',
      description:
        'Enterprise data, media, document, CAD, and RAW conversion platform with asynchronous job queues, zero-heap streaming, dead-letter webhook queues, and granular RBAC scopes.',
      contact: {
        name: 'EasyConvert Engineering',
        url: 'https://github.com/AquilaXk/easyconvert',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        url: '/',
        description: 'Current Environment Origin',
      },
    ],
    security: [
      { ApiKeyAuth: [] },
      { BearerAuth: [] },
    ],
    paths: {
      '/api/v1/convert': {
        post: {
          summary: 'Synchronous File Conversion',
          description:
            'Converts an uploaded file synchronously. Protected by 2-phase quota transactions (reserve -> commit/rollback). Requires "convert:write" scope.',
          operationId: 'convertFileV1',
          security: [
            { ApiKeyAuth: ['convert:write'] },
            { BearerAuth: ['convert:write'] },
          ],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file', 'targetFormat'],
                  properties: {
                    file: {
                      type: 'string',
                      format: 'binary',
                      description: 'Source input file binary (up to 100 MB).',
                    },
                    targetFormat: {
                      type: 'string',
                      description: 'Target format extension or identifier (e.g., "pdf", "step", "webp").',
                    },
                    sourceFormat: {
                      type: 'string',
                      description: 'Explicit source format override. If omitted, inferred from filename.',
                    },
                    options: {
                      type: 'string',
                      description: 'JSON-serialized conversion options (e.g. quality, resolution, delimiter).',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Successful conversion returning file metadata or raw binary stream.',
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
            '429': createProblemResponse('Rate limit or daily conversion quota exhausted.'),
            '500': createProblemResponse('Internal engine processing failure (quota reservation rolled back).'),
          },
        },
      },
      '/api/v1/jobs': {
        post: {
          summary: 'Submit Asynchronous Conversion Job',
          description:
            'Enqueues a conversion job to the distributed BullMQ queue with automatic 2-phase quota reservation and optional HMAC-signed webhook callback. Requires "convert:write" scope.',
          operationId: 'createJobV1',
          security: [
            { ApiKeyAuth: ['convert:write'] },
            { BearerAuth: ['convert:write'] },
          ],
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
                    targetFormat: { type: 'string', description: 'Target format extension.' },
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
                  type: 'object',
                  required: ['targetFormat'],
                  properties: {
                    filename: { type: 'string', description: 'Original filename.' },
                    targetFormat: { type: 'string', description: 'Target format extension.' },
                    sourceFormat: { type: 'string', description: 'Source format extension.' },
                    storageKey: {
                      type: 'string',
                      description: 'Key of an object from the multipart upload API (`uploads/...`), or an output owned by the caller (`conversions/{userId}/...`, `results/{jobId}/...`). Any other key returns 404.',
                    },
                    inputBufferBase64: { type: 'string', description: 'Base64-encoded source payload.' },
                    options: { type: 'object', description: 'Conversion configuration options.' },
                    tasks: {
                      type: 'array',
                      description: 'Array of sequential pipeline tasks for multi-stage conversion execution.',
                      items: { $ref: '#/components/schemas/PipelineTask' },
                    },
                    webhookUrl: { type: 'string', format: 'uri' },
                    webhookSecret: { type: 'string' },
                  },
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
                    },
                  },
                },
              },
            },
            '400': createProblemResponse('Bad request or parameter validation failure.'),
            '401': createProblemResponse('Missing, expired, or invalid API key.'),
            '403': createProblemResponse('Access denied due to IP address or missing "convert:write" scope.'),
            '404': createProblemResponse('Storage object not found, or not usable by the caller as an input.'),
            '429': createProblemResponse('Daily conversion quota exhausted.'),
            '500': createProblemResponse('Job enqueue failure.'),
          },
        },
        get: {
          summary: 'List Conversion Jobs',
          description: 'Returns asynchronous conversion jobs created by the authenticated user. Requires "convert:read" scope.',
          operationId: 'listJobsV1',
          security: [
            { ApiKeyAuth: ['convert:read'] },
            { BearerAuth: ['convert:read'] },
          ],
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
          security: [
            { ApiKeyAuth: ['convert:read'] },
            { BearerAuth: ['convert:read'] },
          ],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Conversion job identifier.',
            },
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
          security: [
            { ApiKeyAuth: ['convert:write'] },
            { BearerAuth: ['convert:write'] },
          ],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Conversion job identifier.',
            },
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
      '/api/storage/file/{key}': {
        get: {
          summary: 'Download Stored File',
          description:
            'Downloads a stored file by the key in a `downloadUrl`. Outputs owned by a user (`conversions/{userId}/...` keys and results of jobs created with credentials) are served only to that user through a session or an API key with the "storage:download" scope; any other caller gets 404 so keys cannot be probed. Anonymous job results keep capability-URL access. Every file response is sent with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. A single byte range is supported; multi-range requests return the full file.',
          operationId: 'downloadStoredFile',
          security: [
            { ApiKeyAuth: ['storage:download'] },
            { BearerAuth: ['storage:download'] },
            {},
          ],
          parameters: [
            {
              name: 'key',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'URL-encoded storage key, as returned in `downloadUrl`.',
            },
            {
              name: 'Range',
              in: 'header',
              required: false,
              schema: { type: 'string', example: 'bytes=0-1023' },
              description: 'One RFC 9110 byte range: `bytes=first-last`, `bytes=first-`, or suffix `bytes=-length`.',
            },
          ],
          responses: {
            '200': {
              description: 'Full file content.',
              headers: {
                'Content-Disposition': {
                  schema: { type: 'string' },
                  description: 'Attachment with an ASCII `filename` and a UTF-8 `filename*`.',
                },
                ETag: { schema: { type: 'string' } },
                'Cache-Control': { schema: { type: 'string', example: 'private, no-store' } },
              },
              content: {
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              },
            },
            '206': {
              description: 'Requested byte range.',
              headers: {
                'Content-Range': { schema: { type: 'string', example: 'bytes 0-1023/4096' } },
              },
              content: {
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              },
            },
            '403': {
              description: 'The owner\'s API key lacks the "storage:download" scope.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '404': {
              description: 'Object not found, expired, owned by another user, or a job result whose job cannot be read.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '416': {
              description: 'Malformed or unsatisfiable range.',
              headers: {
                'Content-Range': { schema: { type: 'string', example: 'bytes */4096' } },
              },
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '429': {
              description: 'The owner\'s API key exceeded its burst rate limit; see `Retry-After`.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
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
      '/api/keys': {
        get: {
          summary: 'List API Keys',
          description: 'Retrieves developer API keys, granular scopes, expiration dates, and IP whitelist restrictions. Requires admin wildcard (*) scope.',
          operationId: 'listApiKeys',
          security: [
            { ApiKeyAuth: ['*'] },
            { BearerAuth: ['*'] },
          ],
          responses: {
            '200': { description: 'User API keys list.' },
          },
        },
        post: {
          summary: 'Create API Key',
          description: 'Generates a new API key with custom name, CIDR restrictions, granular scopes, expiration date, and webhook URL. Requires admin wildcard (*) scope.',
          operationId: 'createApiKey',
          security: [
            { ApiKeyAuth: ['*'] },
            { BearerAuth: ['*'] },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', example: 'Production Microservice Key' },
                    allowedIps: {
                      type: 'array',
                      items: { type: 'string' },
                      example: ['192.168.1.0/24', '10.0.0.1'],
                    },
                    webhookUrl: { type: 'string', format: 'uri' },
                    webhookSecret: { type: 'string' },
                    scopes: {
                      type: 'array',
                      items: { type: 'string', enum: ['convert:read', 'convert:write', 'storage:download', '*'] },
                    },
                    expiresAt: { type: 'number', description: 'Unix timestamp in milliseconds when the key expires.' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'API Key generated.' },
          },
        },
      },
      '/api/keys/{id}': {
        delete: {
          summary: 'Revoke API Key',
          description: 'Revokes an active API key by ID. Requires admin wildcard (*) scope.',
          operationId: 'revokeApiKey',
          security: [
            { ApiKeyAuth: ['*'] },
            { BearerAuth: ['*'] },
          ],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'API key ID to revoke.',
            },
          ],
          responses: {
            '200': { description: 'API key successfully revoked.' },
            '404': { description: 'API key not found.' },
          },
        },
      },
      '/api/keys/usage': {
        get: {
          summary: 'Get Quota Usage',
          description: 'Retrieves current daily quota usage and limits.',
          operationId: 'getQuotaUsage',
          security: [
            { ApiKeyAuth: [] },
            { BearerAuth: [] },
          ],
          responses: {
            '200': {
              description: 'Daily conversion quota usage details.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      usage: { $ref: '#/components/schemas/QuotaUsage' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/webhooks/dlq': {
        get: {
          summary: 'List Webhook DLQ Entries',
          description: 'Retrieves the caller\'s failed webhook dispatches stored in the Dead Letter Queue. Requires "convert:read" scope.',
          operationId: 'listWebhookDlq',
          security: [
            { ApiKeyAuth: ['convert:read'] },
            { BearerAuth: ['convert:read'] },
          ],
          responses: {
            '200': {
              description: 'List of dead-lettered webhook entries.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      total: { type: 'integer' },
                      entries: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/WebhookDlqEntry' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        delete: {
          summary: 'Clear Webhook DLQ',
          description: 'Purges the caller\'s entries from the Webhook Dead Letter Queue. Requires admin wildcard (*) scope.',
          operationId: 'clearWebhookDlq',
          security: [
            { ApiKeyAuth: ['*'] },
            { BearerAuth: ['*'] },
          ],
          responses: {
            '200': {
              description: 'DLQ purged successfully.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/webhooks/dlq/{id}': {
        get: {
          summary: 'Get Webhook DLQ Entry',
          description: 'Inspects one of the caller\'s failed webhook payloads and delivery attempt details. Entries owned by other users return 404. Requires "convert:read" scope.',
          operationId: 'getWebhookDlqEntry',
          security: [
            { ApiKeyAuth: ['convert:read'] },
            { BearerAuth: ['convert:read'] },
          ],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'DLQ entry identifier.',
            },
          ],
          responses: {
            '200': {
              description: 'DLQ entry details.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      entry: { $ref: '#/components/schemas/WebhookDlqEntry' },
                    },
                  },
                },
              },
            },
            '404': { description: 'Entry not found.' },
          },
        },
        delete: {
          summary: 'Delete Webhook DLQ Entry',
          description: 'Removes one of the caller\'s failed webhook entries from the DLQ. Entries owned by other users return 404. Requires admin wildcard (*) scope.',
          operationId: 'deleteWebhookDlqEntry',
          security: [
            { ApiKeyAuth: ['*'] },
            { BearerAuth: ['*'] },
          ],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': { description: 'Entry deleted.' },
            '404': { description: 'Entry not found.' },
          },
        },
      },
      '/api/webhooks/dlq/{id}/replay': {
        post: {
          summary: 'Replay Dead-Lettered Webhook',
          description: 'Triggers a 1-click manual re-dispatch of one of the caller\'s dead-lettered webhooks with fresh HMAC signature. Entries owned by other users return 404. Requires admin wildcard (*) scope.',
          operationId: 'replayWebhookDlq',
          security: [
            { ApiKeyAuth: ['*'] },
            { BearerAuth: ['*'] },
          ],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Replay attempt result.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      deliveryId: { type: 'string' },
                      url: { type: 'string' },
                      event: { type: 'string' },
                      statusCode: { type: 'integer' },
                      attempts: { type: 'integer' },
                      durationMs: { type: 'number' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
            '404': { description: 'DLQ entry not found.' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'Standard X-API-Key authentication header.',
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Authorization header using Bearer ec_live_... API key.',
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Detailed error description' },
          },
        },
        ProblemDetails: {
          type: 'object',
          required: ['type', 'title', 'status', 'detail', 'instance'],
          properties: {
            type: { type: 'string', format: 'uri', example: 'https://api.easyconvert.io/problems/bad-request' },
            title: { type: 'string', example: 'Bad Request' },
            status: { type: 'integer', example: 400 },
            detail: { type: 'string', example: 'Invalid parameter provided.' },
            instance: { type: 'string', example: '/api/v1/jobs' },
            invalidParams: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  reason: { type: 'string' },
                },
              },
            },
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Invalid parameter provided.' },
          },
        },
        ConversionResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            fileId: { type: 'string' },
            fileName: { type: 'string' },
            sourceFormat: { type: 'string' },
            targetFormat: { type: 'string' },
            mimeType: { type: 'string' },
            size: { type: 'integer' },
            durationMs: { type: 'number' },
            dataUri: { type: 'string' },
            expiresAt: { type: 'number' },
          },
        },
        JobSummary: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            status: { type: 'string', enum: ['waiting', 'active', 'completed', 'failed', 'delayed', 'cancelled'] },
            progress: { type: 'number' },
            sourceFormat: { type: 'string' },
            targetFormat: { type: 'string' },
            originalFilename: { type: 'string' },
            fileSize: { type: 'number' },
            createdAt: { type: 'number' },
            processedOn: { type: 'number' },
            finishedOn: { type: 'number' },
            failedReason: { type: 'string' },
          },
        },
        JobDetails: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            jobId: { type: 'string' },
            status: { type: 'string' },
            progress: { type: 'number' },
            sourceFormat: { type: 'string' },
            targetFormat: { type: 'string' },
            originalFilename: { type: 'string' },
            fileSize: { type: 'number' },
            createdAt: { type: 'number' },
            processedOn: { type: 'number' },
            finishedOn: { type: 'number' },
            attemptsMade: { type: 'integer' },
            failedReason: { type: 'string' },
            result: { type: 'object' },
            tasks: {
              type: 'array',
              items: { $ref: '#/components/schemas/PipelineTask' },
            },
            logs: { type: 'array', items: { type: 'string' } },
          },
        },
        PipelineTask: {
          type: 'object',
          required: ['operation', 'targetFormat'],
          properties: {
            name: { type: 'string', description: 'Task stage identifier or label.' },
            operation: {
              type: 'string',
              enum: ['convert', 'transform', 'optimize', 'watermark'],
              description: 'Pipeline stage operation.',
            },
            targetFormat: { type: 'string', description: 'Target format extension for this stage.' },
            options: { type: 'object', description: 'Stage-specific transformation or conversion options.' },
          },
        },
        ApiKey: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            userId: { type: 'string' },
            name: { type: 'string' },
            prefix: { type: 'string' },
            createdAt: { type: 'number' },
            lastUsedAt: { type: 'number' },
            expiresAt: { type: 'number' },
            status: { type: 'string', enum: ['active', 'revoked'] },
            allowedIps: { type: 'array', items: { type: 'string' } },
            webhookUrl: { type: 'string' },
            hasWebhookSecret: { type: 'boolean', description: 'Whether a webhook signing secret is configured; the secret itself is never returned.' },
            scopes: {
              type: 'array',
              items: { type: 'string', enum: ['convert:read', 'convert:write', 'storage:download', '*'] },
            },
          },
        },
        WebhookDlqEntry: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            originalDeliveryId: { type: 'string' },
            targetUrl: { type: 'string' },
            event: { type: 'string' },
            payload: { type: 'object' },
            failedAt: { type: 'number' },
            finalStatusCode: { type: 'integer' },
            errorMessage: { type: 'string' },
            retryCount: { type: 'integer' },
            status: { type: 'string', enum: ['failed', 'replayed'] },
            replayedAt: { type: 'number' },
            ownerUserId: { type: 'string', description: 'User who owns the webhook; only the owner can see or manage the entry.' },
            ownerKeyId: { type: 'string', description: 'API key whose settings produced the webhook, when known.' },
          },
        },
        QuotaUsage: {
          type: 'object',
          properties: {
            tier: { type: 'string', example: 'pro' },
            dailyLimit: { type: 'integer', example: 500 },
            usedToday: { type: 'integer', example: 42 },
            remaining: { type: 'integer', example: 458 },
            resetAt: { type: 'number', description: 'Unix timestamp in milliseconds for midnight UTC reset.' },
          },
        },
      },
    },
  };

  return NextResponse.json(openApiSpec, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
