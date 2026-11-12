import {
  ProblemDetailsSchema,
  ConversionOptionsSchema,
  PipelineTaskSchema,
  NamedTaskSchema,
  TaskReportSchema,
  JobGraphSchema,
  JobCreateRequestSchema,
  JobResourceSchema,
  IdempotencyKeyHeaderSchema,
  WebhookSecretRotateRequestSchema,
  WebhookSecretRotateResponseSchema,
  OcrLanguageEntrySchema,
  OcrLanguagesResponseSchema,
  ArchiveInspectResponseSchema,
  PdfWatermarkOptionsSchema,
  PdfProtectOptionsSchema,
  PdfAOptionsSchema,
  PdfSplitOptionsSchema,
  PdfRotateOptionsSchema,
  PdfReorderOptionsSchema,
  PdfOptimizeOptionsSchema,
  PdfaValidationProblemSchema,
  ConversionWarningsProperties,
  DroppedStreamsProperties,
  EngineTraceProperties,
} from '@/lib/api/contracts';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { ENGINE_IDS } from '@/lib/conversions/engine-ids';
import { API_KEY_SCOPES } from './shared';
import { DATA_URI_MAX_BYTES } from '@/lib/api/file-size-limit';
import { formatBytes } from '@/lib/format-bytes';

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
      name: sessionCookieName(),
      description: 'Signed-in web application session. In production the cookie is `__Host-easyconvert_session` (Secure, Path=/, no Domain); a session cookie named `easyconvert_session`, issued before the prefix, is still read until it expires (7 days).',
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
    MetadataReport: {
      type: 'object',
      required: ['schemaVersion', 'File'],
      description:
        'The JSON file a `metadata` task makes (`metadata.json`): the facts a file states, in groups, under the field names ExifTool prints for them. A group holds only what the file states, so a field that is not there is absent, never null. Dates read `YYYY:MM:DD HH:MM:SS` with the zone when the file states one. A rational is its value as a number, and a GPS position is signed decimal degrees and meters. The same bytes give the same report.',
      properties: {
        schemaVersion: { type: 'integer', enum: [1], description: 'The version of this layout.' },
        File: {
          type: 'object',
          required: ['FileName', 'FileSize', 'FileType', 'FileTypeExtension', 'MIMEType', 'Category'],
          description: 'The file: `FileName`, `FileSize` (bytes), `FileType`, `FileTypeExtension`, `MIMEType` and `Category`, and a `Warning` when a part of the file could not be read (the other groups then leave that part out; the task does not fail).',
          additionalProperties: true,
        },
        Image: { type: 'object', additionalProperties: true, description: 'A picture: `ImageWidth`, `ImageHeight`, `ColorSpace`, `ColorComponents`, `BitsPerSample`, `HasAlpha`, `FrameCount` (more than one frame), `Progressive`, `YCbCrSubSampling` and `ICCProfile`.' },
        EXIF: { type: 'object', additionalProperties: true, description: 'EXIF tags of a picture: `Make`, `Model`, `Orientation`, `XResolution`, `YResolution`, `ResolutionUnit`, `Software`, `ModifyDate`, `Artist`, `Copyright`, `ImageDescription`, `ExposureTime`, `FNumber`, `ISO`, `DateTimeOriginal`, `CreateDate`, `FocalLength`, `Flash`, `UserComment`, `LensMake`, `LensModel`, `SerialNumber` and a few more; a tag the layout does not list is left out.' },
        GPS: { type: 'object', additionalProperties: true, description: '`GPSLatitude` and `GPSLongitude` in signed decimal degrees (south and west negative) and `GPSAltitude` in meters (below sea level negative).' },
        XMP: { type: 'object', additionalProperties: true, description: 'XMP properties of a picture: `Title`, `Description`, `Rights`, `Creator` (a list), `Subject` (a list), `Format`, `CreatorTool`, `CreateDate`, `ModifyDate`, `MetadataDate`, `Label` and `Rating`.' },
        PDF: { type: 'object', additionalProperties: true, description: 'A PDF: `PDFVersion`, `PageCount`, `PageWidth` and `PageHeight` of the first page in points, and the information dictionary (`Title`, `Author`, `Subject`, `Keywords`, `Creator`, `Producer`, `CreateDate`, `ModifyDate`). An encrypted PDF reports `Encrypted: true` and nothing behind its password.' },
        Document: { type: 'object', additionalProperties: true, description: 'The properties of an Office Open XML or OpenDocument file: `Title`, `Subject`, `Creator`, `Keywords`, `Description`, `LastModifiedBy`, `CreateDate`, `ModifyDate`, `RevisionNumber`, `Application`, `AppVersion`, `Company`, `Pages`, `Words`, `Characters`.' },
        Media: { type: 'object', additionalProperties: true, description: 'The container of an audio or video file: `Format`, `Duration` (seconds), `BitRate`, `StreamCount` and its tags (`Title`, `Artist`, `Album`, `CreationTime`, ...).' },
        Streams: {
          type: 'array',
          description: 'The streams of an audio or video file, at most 64: `Index`, `Type`, `Codec`, `Profile`, `Width`, `Height`, `FrameRate`, `BitRate`, `ChannelCount`, `SampleRate`, `Language`, `Title`.',
          items: { type: 'object', additionalProperties: true },
        },
      },
    },
    PdfaValidationProblem: {
      description: 'Problem details of a PDF/A output that veraPDF rejected, with the requested profile and the failed rules.',
      allOf: [
        { $ref: '#/components/schemas/ProblemDetails' },
        { type: 'object', required: PdfaValidationProblemSchema.required, properties: PdfaValidationProblemSchema.properties },
      ],
    },
    ConversionOptions: ConversionOptionsSchema,
    PipelineTask: PipelineTaskSchema,
    NamedTask: NamedTaskSchema,
    TaskReport: TaskReportSchema,
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
        dataUri: { type: 'string', description: `The result as a \`data:\` URI, present only for a result of ${formatBytes(DATA_URI_MAX_BYTES)} or less.` },
        downloadUrl: { type: 'string', description: 'Path of the result; send it to `GET /api/storage/file/{key}` with the key.' },
        expiresAt: { type: 'number' },
        ...EngineTraceProperties,
        ...DroppedStreamsProperties,
        ...ConversionWarningsProperties,
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
      description: 'A queue job, or a job graph (listed by its own id; a running graph is `active`, and has no `fileSize` or `result`: its nodes hold the outputs, read through `GET /api/v1/jobs/{id}`).',
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
        tasks: {
          type: 'object',
          description: 'A job submitted as named tasks: the report of each task by name (without the `result` files beyond the first 100 of a task).',
          additionalProperties: { $ref: '#/components/schemas/TaskReport' },
        },
        failedTask: { type: 'string', description: 'A job submitted as named tasks that failed: the name of the task that failed it.' },
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
        acceptedTermsVersion: {
          type: 'string',
          description: 'Version (effective date) of the terms of service in force when the key was created; absent on older keys.',
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
    OcrLanguageEntry: {
      ...OcrLanguageEntrySchema,
      $id: undefined,
    },
    OcrLanguagesResponse: {
      ...OcrLanguagesResponseSchema,
      $id: undefined,
      properties: {
        ...OcrLanguagesResponseSchema.properties,
        languages: {
          type: 'array',
          items: { $ref: '#/components/schemas/OcrLanguageEntry' },
        },
      },
    },
    ArchiveInspectResponse: {
      ...ArchiveInspectResponseSchema,
      $id: undefined,
    },
    Engine: {
      type: 'object',
      required: ['id', 'name', 'installed'],
      properties: {
        id: { type: 'string', enum: [...ENGINE_IDS], description: 'The id a request names in `options.engine`. Stable across releases.' },
        name: { type: 'string', description: 'Display name of the engine.' },
        installed: { type: 'boolean', description: 'Whether the program of the engine is installed on this deployment (the in-process converter always is).' },
        version: { type: 'string', description: 'The one version installed, which `options.engineVersion` may name. Absent when the engine is not installed or its program prints no version.' },
      },
    },
    PairEngine: {
      type: 'object',
      required: ['id', 'name', 'default', 'available'],
      properties: {
        id: { type: 'string', enum: [...ENGINE_IDS] },
        name: { type: 'string' },
        version: { type: 'string', description: 'The installed version of the engine; the only version a request may name.' },
        default: { type: 'boolean', description: 'Whether this engine converts the pair when a request names none. Exactly one engine of a pair is the default, and it is listed first.' },
        available: { type: 'boolean', description: 'Whether the program is installed here. A named engine that is not available answers 503 with the code `engine_unavailable`.' },
      },
    },
    PairEngines: {
      type: 'object',
      required: ['source', 'target', 'engines'],
      properties: {
        source: { type: 'string', description: 'Source format id.' },
        target: { type: 'string', description: 'Target format id.' },
        engines: { type: 'array', items: { $ref: '#/components/schemas/PairEngine' }, description: 'The engines that convert the pair, the default first.' },
      },
    },
    FormatsResponse: {
      type: 'object',
      required: ['success', 'count', 'categories', 'formats', 'engines', 'capture'],
      properties: {
        success: { type: 'boolean', const: true },
        count: { type: 'integer', description: 'Number of formats.' },
        categories: { type: 'array', items: { type: 'object', required: ['id', 'label', 'count'], properties: { id: { type: 'string' }, label: { type: 'string' }, count: { type: 'integer' } } } },
        formats: { type: 'array', items: { type: 'object', description: 'A format with the target formats it converts to.' } },
        engines: { type: 'array', items: { $ref: '#/components/schemas/Engine' }, description: 'Every engine of this deployment with its installed version.' },
        capture: {
          type: 'object',
          required: ['website'],
          description: 'The tasks of this deployment that are not on for every server.',
          properties: {
            website: {
              type: 'object',
              required: ['enabled', 'formats'],
              description: 'The `capture.website` task (`capture/website` in a named-task job). It is off unless the operator sets `CAPTURE_WEBSITE_ENABLED=true`; where `enabled` is false a job that holds it is refused before anything is reserved with a 422 and the code `capture_unavailable`.',
              properties: {
                enabled: { type: 'boolean', description: 'Whether this server captures websites.' },
                formats: { type: 'array', items: { type: 'string' }, description: 'The formats a page is captured as.' },
              },
            },
          },
        },
        pairs: { type: 'array', items: { $ref: '#/components/schemas/PairEngines' }, description: 'Sent only when `source`, `target` or `engine` is set: the engines of each pair they select.' },
      },
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
    PdfSplitOptions: {
      ...PdfSplitOptionsSchema,
    },
    PdfRotateOptions: {
      ...PdfRotateOptionsSchema,
    },
    PdfReorderOptions: {
      ...PdfReorderOptionsSchema,
    },
    PdfOptimizeOptions: {
      ...PdfOptimizeOptionsSchema,
    },
  },
};
