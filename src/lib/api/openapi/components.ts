import {
  ProblemDetailsSchema,
  ConversionOptionsSchema,
  PipelineTaskSchema,
  JobGraphSchema,
  JobCreateRequestSchema,
  JobResourceSchema,
  IdempotencyKeyHeaderSchema,
  WebhookSecretRotateRequestSchema,
  WebhookSecretRotateResponseSchema,
  UsageLedgerEntrySchema,
  UsageQueryResponseSchema,
  ArchiveInspectResponseSchema,
  PdfWatermarkOptionsSchema,
  PdfProtectOptionsSchema,
  PdfAOptionsSchema,
  PdfaValidationProblemSchema,
  DroppedStreamsProperties,
  EngineTraceProperties,
} from '@/lib/api/contracts';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { API_KEY_SCOPES } from './shared';

/** Reusable security schemes and schemas; contract schemas come from the contracts SSOT. */
export const components = {
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
    SessionCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: SESSION_COOKIE_NAME,
      description: 'Signed-in web application session.',
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
    ProblemDetails: ProblemDetailsSchema,
    PdfaValidationProblem: {
      description: 'Problem details of a PDF/A output that veraPDF rejected, with the requested profile and the failed rules.',
      allOf: [
        { $ref: '#/components/schemas/ProblemDetails' },
        { type: 'object', required: PdfaValidationProblemSchema.required, properties: PdfaValidationProblemSchema.properties },
      ],
    },
    ConversionOptions: ConversionOptionsSchema,
    PipelineTask: PipelineTaskSchema,
    JobGraph: JobGraphSchema,
    JobCreateRequest: JobCreateRequestSchema,
    JobResource: JobResourceSchema,
    IdempotencyKeyHeader: IdempotencyKeyHeaderSchema,
    JobDetails: {
      ...JobResourceSchema,
      $id: 'https://easyconvert.local/schemas/job-details.json',
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
        ...EngineTraceProperties,
        ...DroppedStreamsProperties,
        sourceFrameCount: {
          type: 'integer',
          minimum: 2,
          description: 'Frames or pages the source image holds; present only for multi-frame sources.',
        },
        frameUsed: {
          type: 'integer',
          minimum: 1,
          description: '1-based frame or page a single-image output was taken from; present only when one was chosen.',
        },
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
        failedCode: { type: 'string' },
        failedStatus: { type: 'integer' },
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
          items: { type: 'string', enum: API_KEY_SCOPES },
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
    WebhookSecretRotateRequest: {
      ...WebhookSecretRotateRequestSchema,
      $id: undefined,
    },
    WebhookSecretRotateResponse: {
      ...WebhookSecretRotateResponseSchema,
      $id: undefined,
    },
    UsageLedgerEntry: {
      ...UsageLedgerEntrySchema,
      $id: undefined,
    },
    UsageQueryResponse: {
      ...UsageQueryResponseSchema,
      $id: undefined,
      properties: {
        ...UsageQueryResponseSchema.properties,
        items: {
          type: 'array',
          items: {
            $ref: '#/components/schemas/UsageLedgerEntry',
          },
        },
      },
    },
    ArchiveInspectResponse: {
      ...ArchiveInspectResponseSchema,
      $id: undefined,
    },
    PdfWatermarkOptions: {
      ...PdfWatermarkOptionsSchema,
      $id: undefined,
    },
    PdfProtectOptions: {
      ...PdfProtectOptionsSchema,
      $id: undefined,
    },
    PdfAOptions: {
      ...PdfAOptionsSchema,
      $id: undefined,
    },
  },
};
