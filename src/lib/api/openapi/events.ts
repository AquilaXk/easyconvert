/**
 * Outbound webhook events (OpenAPI 3.1 `webhooks`). Only events the platform actually
 * dispatches are listed; each request carries the signature headers in `webhookHeaders`.
 */

const webhookHeaders = [
  {
    name: 'Webhook-Id',
    in: 'header',
    required: true,
    schema: { type: 'string' },
    description: 'Delivery identifier; kept unchanged on retries and manual replays so receivers can deduplicate.',
  },
  {
    name: 'Webhook-Timestamp',
    in: 'header',
    required: true,
    schema: { type: 'string', pattern: '^[0-9]+$' },
    description: 'Unix time in seconds at signing.',
  },
  {
    name: 'Webhook-Signature',
    in: 'header',
    required: true,
    schema: { type: 'string', example: 'v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=' },
    description:
      'Space-separated `v1,<base64>` signatures of HMAC-SHA256 over `{Webhook-Id}.{Webhook-Timestamp}.{body}`. During a secret rotation grace period the previous secret adds a second signature.',
  },
  {
    name: 'X-EasyConvert-Signature',
    in: 'header',
    required: true,
    deprecated: true,
    schema: { type: 'string', pattern: '^sha256=[0-9a-f]{64}$' },
    description: 'Legacy `sha256=<hex>` HMAC-SHA256 over `{X-EasyConvert-Timestamp}.{body}` with the primary secret.',
  },
  {
    name: 'X-EasyConvert-Timestamp',
    in: 'header',
    required: true,
    deprecated: true,
    schema: { type: 'string', pattern: '^[0-9]+$' },
  },
  {
    name: 'X-EasyConvert-Event',
    in: 'header',
    required: true,
    deprecated: true,
    schema: { type: 'string' },
  },
  {
    name: 'X-EasyConvert-Delivery',
    in: 'header',
    required: true,
    deprecated: true,
    schema: { type: 'string' },
  },
];

const envelope = (event: string, dataSchema: Record<string, unknown>) => ({
  type: 'object',
  required: ['id', 'event', 'timestamp', 'data'],
  properties: {
    id: { type: 'string', description: 'Same value as `Webhook-Id`.' },
    event: { type: 'string', const: event },
    timestamp: { type: 'integer', description: 'Same value as `Webhook-Timestamp`.' },
    data: dataSchema,
  },
});

const deliveryResponses = {
  '2XX': { description: 'Delivery accepted.' },
  '410': { description: 'Endpoint gone; delivery stops without retry.' },
  default: {
    description:
      'Any other status is retried with exponential backoff (408, 429, and 5xx; `Retry-After` is honored) or dead-lettered (other 4xx).',
  },
};

const createEvent = (event: string, summary: string, dataSchema: Record<string, unknown>) => ({
  post: {
    summary,
    operationId: `webhook_${event.replace('.', '_')}`,
    parameters: webhookHeaders,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: envelope(event, dataSchema) } },
    },
    responses: deliveryResponses,
  },
});

const graphResultSchema = (status: string) => ({
  type: 'object',
  required: ['jobId', 'graphId', 'status', 'nodes'],
  properties: {
    jobId: { type: 'string' },
    graphId: { type: 'string' },
    status: { type: 'string', const: status },
    error: { type: 'string' },
    nodes: { type: 'object', additionalProperties: true, description: 'Per-node state keyed by node ID.' },
  },
});

export const webhookEvents = {
  'job.completed': createEvent('job.completed', 'Conversion job completed', {
    type: 'object',
    required: ['jobId', 'status', 'resultKey', 'downloadUrl', 'filename', 'mimeType', 'size', 'durationMs'],
    properties: {
      jobId: { type: 'string' },
      status: { type: 'string', const: 'completed' },
      resultKey: { type: 'string' },
      downloadUrl: { type: 'string' },
      filename: { type: 'string' },
      mimeType: { type: 'string' },
      size: { type: 'integer' },
      durationMs: { type: 'number' },
      ocrExtracted: { type: 'boolean' },
    },
  }),
  'job.failed': createEvent('job.failed', 'Conversion job failed', {
    type: 'object',
    required: ['jobId', 'error'],
    properties: {
      jobId: { type: 'string' },
      error: { type: 'string' },
      originalFilename: { type: 'string' },
    },
  }),
  'graph.completed': createEvent('graph.completed', 'Job graph completed', graphResultSchema('completed')),
  'graph.failed': createEvent('graph.failed', 'Job graph failed', graphResultSchema('failed')),
  'key.expiring_soon': createEvent('key.expiring_soon', 'API key expires within seven days', {
    type: 'object',
    required: ['keyId', 'keyName', 'prefix', 'expiresAt', 'daysRemaining'],
    properties: {
      keyId: { type: 'string' },
      keyName: { type: 'string' },
      prefix: { type: 'string' },
      expiresAt: { type: 'number', description: 'Unix time in milliseconds.' },
      daysRemaining: { type: 'integer', minimum: 1 },
    },
  }),
};
