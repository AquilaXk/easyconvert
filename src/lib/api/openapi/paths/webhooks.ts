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
        'Programmatically rotates a webhook signing secret with dual-signature grace period support. Requires "convert:write" scope.',
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
        '400': createProblemResponse('Malformed JSON payload'),
        '401': createProblemResponse('Unauthorized'),
        '422': createProblemResponse('Unprocessable Entity (schema validation failure)'),
      },
    },
  },
};
