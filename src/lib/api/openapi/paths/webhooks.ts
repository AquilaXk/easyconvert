import {
  createPathParameter,
  createProblemResponse,
  requireScope,
} from '../shared';

/** Webhook dead-letter queue and signing secret operations. */
export const webhookPaths = {
  '/api/webhooks/dlq': {
    get: {
      summary: 'List Webhook DLQ Entries',
      description: 'Retrieves the caller\'s failed webhook dispatches stored in the Dead Letter Queue. Requires "convert:read" scope.',
      operationId: 'listWebhookDlq',
      security: requireScope('convert:read'),
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
      security: requireScope('*'),
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
      security: requireScope('convert:read'),
      parameters: [
        createPathParameter('id', 'DLQ entry identifier.'),
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
      security: requireScope('*'),
      parameters: [
        createPathParameter('id', 'DLQ entry identifier.'),
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
      security: requireScope('*'),
      parameters: [
        createPathParameter('id', 'DLQ entry identifier.'),
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
  '/api/v1/webhooks/secrets/rotate': {
    post: {
      summary: 'Rotate Webhook Signing Secret',
      description:
        'Programmatically rotates the signing secret of one webhook target, an endpoint (`endpointId`) or an API key (`apiKeyId`), with dual-signature grace period support, and answers the new secret in plaintext. Requires "convert:write" scope. A signed-in session or a key of the admin scope (`*`) may rotate any secret of its account; any other key may rotate only its own (`apiKeyId` equal to the id of the calling key, no `endpointId`). A named `apiKeyId` must be an active key of the caller\'s account. An account holds at most 25 endpoint secrets (a rotation of an existing one is always allowed), and an endpoint secret expires 90 days after its last rotation. A request that names neither target is rejected; there is no shared default secret.',
      operationId: 'rotateWebhookSecretV1',
      security: requireScope('convert:write'),
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/WebhookSecretRotateRequest',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Secret successfully rotated with dual-signature grace period active.',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/WebhookSecretRotateResponse',
              },
            },
          },
        },
        '400': createProblemResponse('Malformed JSON payload, or neither `endpointId` nor `apiKeyId` was given.'),
        '401': createProblemResponse('Unauthorized'),
        '403': createProblemResponse('The caller is a key without the admin scope that names another key or an endpoint.'),
        '404': createProblemResponse('`apiKeyId` is not an active key of the caller\'s account (unknown, revoked or another account\'s).'),
        '409': createProblemResponse('The account already holds the most endpoint secrets and `endpointId` is a new one.'),
        '422': createProblemResponse('Unprocessable Entity (schema validation failure)'),
        '503': createProblemResponse('The key and account store could not be reached; retry after the `Retry-After` delay.'),
      },
    },
  },
};
