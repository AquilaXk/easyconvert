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
        'Enterprise data, media, document, CAD, and RAW conversion platform with asynchronous job queues, zero-heap streaming, and HMAC-signed webhooks.',
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
            'Converts an uploaded file synchronously. Protected by 2-phase quota transactions (reserve -> commit/rollback).',
          operationId: 'convertFileV1',
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
            '401': createProblemResponse('Missing or invalid API key.'),
            '403': createProblemResponse('Access denied due to IP address, CIDR whitelist, or missing scope restriction.'),
            '429': createProblemResponse('Rate limit or daily conversion quota exhausted.'),
            '500': createProblemResponse('Internal engine processing failure (quota reservation rolled back).'),
          },
        },
      },
      '/api/v1/jobs': {
        post: {
          summary: 'Submit Asynchronous Conversion Job',
          description:
            'Enqueues a conversion job to the distributed BullMQ queue with automatic 2-phase quota reservation and optional HMAC-signed webhook callback.',
          operationId: 'createJobV1',
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
                    storageKey: { type: 'string', description: 'Pre-uploaded S3 storage key.' },
                    options: { type: 'string', description: 'JSON-serialized conversion options.' },
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
                    storageKey: { type: 'string', description: 'Pre-uploaded S3 storage key.' },
                    inputBufferBase64: { type: 'string', description: 'Base64-encoded source payload.' },
                    options: { type: 'object', description: 'Conversion configuration options.' },
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
            '401': createProblemResponse('Unauthorized or missing scope.'),
            '429': createProblemResponse('Quota exceeded.'),
          },
        },
        get: {
          summary: 'List Conversion Jobs',
          description: 'Returns asynchronous conversion jobs created by the authenticated user.',
          operationId: 'listJobsV1',
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
          description: 'Polls status, real-time progress, logs, and artifacts of a specific conversion job.',
          operationId: 'getJobStatusV1',
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
          description: 'Retrieves developer API keys, scopes, and IP/CIDR whitelist restrictions.',
          operationId: 'listApiKeys',
          responses: {
            '200': { description: 'User API keys list.' },
          },
        },
        post: {
          summary: 'Create API Key',
          description: 'Generates a new API key with custom name, CIDR restrictions, and webhook URL.',
          operationId: 'createApiKey',
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
                    scopes: { type: 'array', items: { type: 'string' } },
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
            status: { type: 'string', enum: ['waiting', 'active', 'completed', 'failed', 'delayed'] },
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
            logs: { type: 'array', items: { type: 'string' } },
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
