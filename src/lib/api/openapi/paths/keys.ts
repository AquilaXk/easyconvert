import {
  API_KEY_SCOPES,
  createErrorResponse,
  createJsonResponse,
  createPathParameter,
  createProblemResponse,
  requireScope,
} from '../shared';

/** API key management, quota, and metered usage operations. */
export const keyPaths = {
  '/api/keys': {
    get: {
      summary: 'List API Keys',
      description: 'Retrieves developer API keys, granular scopes, expiration dates, and IP whitelist restrictions. Requires admin wildcard (*) scope.',
      operationId: 'listApiKeys',
      security: requireScope('*'),
      responses: {
        '200': { description: 'User API keys list.' },
      },
    },
    post: {
      summary: 'Create API Key',
      description: 'Generates a new API key with custom name, CIDR restrictions, granular scopes, expiration date, and webhook URL. Requires admin wildcard (*) scope.',
      operationId: 'createApiKey',
      security: requireScope('*'),
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
                  items: { type: 'string', enum: API_KEY_SCOPES },
                },
                expiresAt: { type: 'number', description: 'Unix timestamp in milliseconds when the key expires.' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'API key generated; `secretKey` is returned only once.' },
      },
    },
  },
  '/api/keys/{id}': {
    delete: {
      summary: 'Revoke API Key',
      description: 'Revokes an active API key by ID. Requires admin wildcard (*) scope.',
      operationId: 'revokeApiKey',
      security: requireScope('*'),
      parameters: [
        createPathParameter('id', 'API key ID to revoke.'),
      ],
      responses: {
        '200': { description: 'API key successfully revoked.' },
        '404': { description: 'API key not found.' },
      },
    },
    patch: {
      summary: 'Update API Key',
      description: 'Updates the name, IP allowlist, webhook settings, scopes, or expiry of an active API key. Requires admin wildcard (*) scope.',
      operationId: 'updateApiKey',
      security: requireScope('*'),
      parameters: [createPathParameter('id', 'API key ID to update.')],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string', minLength: 1 },
                allowedIps: { type: 'array', items: { type: 'string' } },
                webhookUrl: { type: 'string', format: 'uri' },
                webhookSecret: { type: 'string' },
                scopes: { type: 'array', minItems: 1, items: { type: 'string', enum: API_KEY_SCOPES } },
                expiresAt: { type: 'number', description: 'Future Unix timestamp in milliseconds.' },
              },
            },
          },
        },
      },
      responses: {
        '200': createJsonResponse('API key updated.', {
          success: { type: 'boolean' },
          key: { $ref: '#/components/schemas/ApiKey' },
          message: { type: 'string' },
        }),
        '400': createErrorResponse('Invalid field value.'),
        '401': createErrorResponse('Authentication required.'),
        '403': createErrorResponse('API key lacks the admin wildcard (*) scope.'),
        '404': createErrorResponse('API key not found, inactive, or owned by another user.'),
      },
    },
  },
  '/api/keys/{id}/rotate': {
    post: {
      summary: 'Rotate API Key',
      description:
        'Issues a new secret for an API key. The previous secret keeps working until `graceExpiresAt`. Requires admin wildcard (*) scope.',
      operationId: 'rotateApiKey',
      security: requireScope('*'),
      parameters: [createPathParameter('id', 'API key ID to rotate.')],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                gracePeriodSeconds: { type: 'integer', minimum: 0, maximum: 604800, default: 3600 },
              },
            },
          },
        },
      },
      responses: {
        '200': createJsonResponse('API key rotated; `secretKey` is returned only once.', {
          success: { type: 'boolean' },
          key: { $ref: '#/components/schemas/ApiKey' },
          secretKey: { type: 'string' },
          graceExpiresAt: { type: 'number' },
          warning: { type: 'string' },
          message: { type: 'string' },
        }),
        '400': createErrorResponse('Invalid grace period.'),
        '401': createErrorResponse('Authentication required.'),
        '403': createErrorResponse('API key lacks the admin wildcard (*) scope.'),
        '404': createErrorResponse('API key not found or owned by another user.'),
      },
    },
  },
  '/api/keys/usage': {
    get: {
      summary: 'Get Quota Usage',
      description: 'Retrieves current daily quota usage and limits.',
      operationId: 'getQuotaUsage',
      security: requireScope(),
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
  '/api/v1/usage': {
    get: {
      summary: 'Query Metered Resource Usage Ledger',
      description:
        'Queries append-only metered resource usage events recorded for the authenticated user.',
      operationId: 'getUsageLedgerV1',
      security: requireScope('read:usage'),
      parameters: [
        {
          name: 'from',
          in: 'query',
          required: false,
          description: 'Start of time window (epoch ms timestamp or ISO 8601 string).',
          schema: { type: 'string' },
        },
        {
          name: 'to',
          in: 'query',
          required: false,
          description: 'End of time window (epoch ms timestamp or ISO 8601 string).',
          schema: { type: 'string' },
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          description: 'Maximum number of ledger records to return (1-200, default 50).',
          schema: { type: 'integer', default: 50, minimum: 1, maximum: 200 },
        },
      ],
      responses: {
        '200': {
          description: 'Metered usage entries retrieved successfully.',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/UsageQueryResponse',
              },
            },
          },
        },
        '400': createProblemResponse('Invalid query parameter'),
        '401': createProblemResponse('Unauthorized'),
      },
    },
  },
};
