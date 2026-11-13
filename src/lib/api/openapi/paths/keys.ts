import {
  API_KEY_SCOPES,
  createCodedErrorResponse,
  createErrorResponse,
  createJsonResponse,
  createPathParameter,
  createProblemResponse,
  jsonBody,
  requireScope,
} from '../shared';

/** API key management and quota operations. */
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
      requestBody: jsonBody({
        acceptedTermsVersion: {
          type: 'string',
          description: 'Version (effective date) of the terms of service at /terms that the key\'s owner accepted; must be the version in force.',
        },
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
      }, ['acceptedTermsVersion', 'name']),
      responses: {
        '200': { description: 'API key generated; `secretKey` is returned only once.' },
        '400': createCodedErrorResponse(
          'Terms of service not accepted (`terms_not_accepted`) or accepted in an earlier version (`terms_outdated`), or key settings out of range (`invalid_key_settings`).',
          ['terms_not_accepted', 'terms_outdated', 'invalid_key_settings']
        ),
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
      requestBody: jsonBody({
        name: { type: 'string', minLength: 1 },
        allowedIps: { type: 'array', items: { type: 'string' } },
        webhookUrl: { type: 'string', format: 'uri' },
        webhookSecret: { type: 'string' },
        scopes: { type: 'array', minItems: 1, items: { type: 'string', enum: API_KEY_SCOPES } },
        expiresAt: { type: 'number', description: 'Future Unix timestamp in milliseconds.' },
      }),
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
      summary: 'Get Credits',
      description: 'Retrieves the credits counted in the current window (a day for anonymous callers and the free plan, the billing period of a subscription), the credits the window gives, the package credits, and the account\'s newest charges (`charges`: one entry for each charged conversion with its formats, its credits and the credits from the package).',
      operationId: 'getQuotaUsage',
      security: requireScope(),
      responses: {
        '200': {
          description: 'The credits of the account and its newest charges.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  usage: { $ref: '#/components/schemas/QuotaUsage' },
                  charges: {
                    type: 'array',
                    description: 'The newest charges of the account, newest first, at most 50.',
                    items: {
                      type: 'object',
                      properties: {
                        at: { type: 'number', description: 'Unix timestamp in milliseconds.' },
                        from: { type: 'string', description: 'Source format of the conversion; the tool for a tool.' },
                        to: { type: 'string', description: 'Target format of the conversion.' },
                        kind: { type: 'string', enum: ['graph', 'batch'], description: 'Set for the credits of a job graph or of a batch of files.' },
                        base: { type: 'integer', description: 'Credits of the class of the conversion.' },
                        surcharge: { type: 'integer', description: 'Credits added for the started minutes of processing beyond the first.' },
                        credits: { type: 'integer', description: 'Credits charged in all.' },
                        fromPackage: { type: 'integer', description: 'How many of them came from the package credits.' },
                        uncharged: { type: 'integer', description: 'Credits owed that the account no longer had when the conversion ended.' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
