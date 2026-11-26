import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { authErrorHeaders, reserveConversionUnit, validateApiAccess, withReservedUnit } from '@/lib/api-keys/guard';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import { validateOrProblem } from '@/lib/api/contracts';
import { CaptureOptionsSchema } from '@/lib/api/contracts/task-option-schemas';
import { withinSingleRequest } from '@/lib/api/file-size-limit';
import { readBoundedJsonText } from '@/lib/api/json-body-bounds';
import { codedRefusal, createProblemDetailsResponse, serverFault } from '@/lib/api/problem-details';
import { queueErrorResponse } from '@/lib/api/queue-error-response';
import { SMALL_REQUEST_BODY_MAX_BYTES } from '@/lib/api/request-body-limit';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { deadlineErrorResponse } from '@/lib/api/sync-deadline';
import { typedFailureProblem } from '@/lib/api/typed-failure-response';
import { respondOnce } from '@/lib/api/with-idempotency';
import type { User } from '@/lib/auth/types';
import { CAPTURE_OUTPUT_FORMATS, websiteCaptureEnabled } from '@/lib/capture/capture-enabled';
import { CaptureUnavailableError } from '@/lib/capture/website-capture-errors';
import { isConversionOptionsObject } from '@/lib/conversions/options-guard';
import { captureUrlProblem } from '@/lib/jobs/capture-url';
import { concurrencyLimitResponse, mayEnqueue } from '@/lib/queue/concurrency-limit';
import { getQueueForResourceClass } from '@/lib/queue/conversion-queue';
import { handOffConversionJob } from '@/lib/queue/enqueue';
import { tierToPriority } from '@/lib/queue/resource-class';
import { hasLiveQueueWorker, isQueueOnlyWebMode } from '@/lib/queue/worker-presence';
import { PROBLEM_TYPE_BASE } from '@/lib/refusal-codes';
import { isPrivateOrRestrictedHost } from '@/lib/security/ssrf';
import { ConversionFailedError, EngineMissingError, QueueUnavailableError, type WebsiteCaptureOptions } from '@/lib/types';

export const dynamic = 'force-dynamic';

type CaptureTargetFormat = 'pdf' | 'png' | 'jpg';

const ROUTE_PATH = '/api/capture/jobs';
const ALLOWED_BODY_KEYS: ReadonlySet<string> = new Set(['url', 'targetFormat', 'options']);
const ALLOWED_OPTION_KEYS: ReadonlySet<string> = new Set([
  'viewport',
  'fullPage',
  'waitUntil',
  'delayMs',
  'quality',
  'userAgent',
  'timeoutMs',
  'pdf',
]);
const ALLOWED_VIEWPORT_KEYS: ReadonlySet<string> = new Set(['width', 'height']);
const ALLOWED_PDF_KEYS: ReadonlySet<string> = new Set([
  'paper',
  'width',
  'height',
  'landscape',
  'margin',
  'printBackground',
  'scale',
]);
const CAPTURE_REQUEST_OPTIONS_SCHEMA = {
  $id: 'https://easyconvert.local/schemas/capture-request-options.json',
  type: 'object',
  properties: {
    options: CaptureOptionsSchema,
  },
} as const;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isConversionOptionsObject(value);
}

function unknownKeyPath(record: Record<string, unknown>, allowed: ReadonlySet<string>, prefix: string): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return prefix ? `${prefix}.${key}` : key;
  }
  return null;
}

function findUnknownCaptureOption(raw: Record<string, unknown>): string | null {
  const top = unknownKeyPath(raw, ALLOWED_OPTION_KEYS, 'options');
  if (top) return top;
  if (isPlainRecord(raw.viewport)) {
    const vp = unknownKeyPath(raw.viewport, ALLOWED_VIEWPORT_KEYS, 'options.viewport');
    if (vp) return vp;
  }
  if (isPlainRecord(raw.pdf)) {
    const pdf = unknownKeyPath(raw.pdf, ALLOWED_PDF_KEYS, 'options.pdf');
    if (pdf) return pdf;
  }
  return null;
}

function pickCaptureOptions(raw: WebsiteCaptureOptions): WebsiteCaptureOptions {
  const clean: WebsiteCaptureOptions = {};
  if (raw.viewport) {
    clean.viewport = {
      ...(raw.viewport.width !== undefined ? { width: raw.viewport.width } : {}),
      ...(raw.viewport.height !== undefined ? { height: raw.viewport.height } : {}),
    };
  }
  if (raw.fullPage !== undefined) clean.fullPage = raw.fullPage;
  if (raw.waitUntil !== undefined) clean.waitUntil = raw.waitUntil;
  if (raw.delayMs !== undefined) clean.delayMs = raw.delayMs;
  if (raw.quality !== undefined) clean.quality = raw.quality;
  if (raw.userAgent !== undefined) clean.userAgent = raw.userAgent;
  if (raw.timeoutMs !== undefined) clean.timeoutMs = raw.timeoutMs;
  if (raw.pdf) {
    clean.pdf = {
      ...(raw.pdf.paper !== undefined ? { paper: raw.pdf.paper } : {}),
      ...(raw.pdf.width !== undefined ? { width: raw.pdf.width } : {}),
      ...(raw.pdf.height !== undefined ? { height: raw.pdf.height } : {}),
      ...(raw.pdf.landscape !== undefined ? { landscape: raw.pdf.landscape } : {}),
      ...(raw.pdf.margin !== undefined ? { margin: raw.pdf.margin } : {}),
      ...(raw.pdf.printBackground !== undefined ? { printBackground: raw.pdf.printBackground } : {}),
      ...(raw.pdf.scale !== undefined ? { scale: raw.pdf.scale } : {}),
    };
  }
  return clean;
}

function parseCaptureTargetFormat(raw: unknown): CaptureTargetFormat | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase().replace(/^\./, '');
  return CAPTURE_OUTPUT_FORMATS.includes(normalized) ? (normalized as CaptureTargetFormat) : null;
}

function validateCaptureOptions(
  rawOptions: unknown,
  instanceUri: string
): { options: WebsiteCaptureOptions } | { refusal: NextResponse } {
  if (rawOptions === undefined) return { options: {} };
  if (!isPlainRecord(rawOptions)) {
    return { refusal: createProblemDetailsResponse(400, 'The "options" field must be a JSON object.', instanceUri) };
  }
  const schemaCheck = validateOrProblem(CAPTURE_REQUEST_OPTIONS_SCHEMA, { options: rawOptions }, instanceUri);
  if (!schemaCheck.ok) {
    return { refusal: schemaCheck.response };
  }
  const unknownKey = findUnknownCaptureOption(rawOptions);
  if (unknownKey) {
    return {
      refusal: createProblemDetailsResponse(
        422,
        `Unsupported capture option "${unknownKey}".`,
        instanceUri,
        'Option Not Supported',
        `${PROBLEM_TYPE_BASE}option-not-supported`,
        undefined,
        [{ name: unknownKey, reason: 'option_not_supported' }],
        { code: 'option_not_supported' }
      ),
    };
  }
  if (typeof rawOptions.userAgent === 'string' && hasControlChar(rawOptions.userAgent)) {
    return {
      refusal: createProblemDetailsResponse(
        422,
        'options.userAgent must not contain control characters.',
        instanceUri,
        'Unprocessable Entity',
        `${PROBLEM_TYPE_BASE}unprocessable-entity`,
        undefined,
        [{ name: 'options.userAgent', reason: 'must not contain control characters' }]
      ),
    };
  }
  return { options: pickCaptureOptions(rawOptions as WebsiteCaptureOptions) };
}

function blockedCaptureUrlRefusal(reason: string, instanceUri: string): Response {
  return createProblemDetailsResponse(
    422,
    reason,
    instanceUri,
    undefined,
    undefined,
    undefined,
    [{ name: 'url', reason }],
    { code: 'capture_target_blocked' }
  );
}

interface ParsedCaptureRequest {
  url: string;
  targetFormat: CaptureTargetFormat;
  options: WebsiteCaptureOptions;
}

async function readCaptureRequest(
  req: NextRequest,
  instanceUri: string
): Promise<{ parsed: ParsedCaptureRequest } | { refusal: Response }> {
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return { refusal: codedRefusal(415, 'unsupported_media_type', 'Expected application/json request body.') };
  }

  const read = await readBoundedJsonText(req, SMALL_REQUEST_BODY_MAX_BYTES, instanceUri);
  if ('refusal' in read) return { refusal: read.refusal };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(read.text);
  } catch {
    return { refusal: createProblemDetailsResponse(400, 'Invalid JSON body provided in request.', instanceUri) };
  }
  if (!isPlainRecord(parsedJson)) {
    return { refusal: createProblemDetailsResponse(400, 'Request body must be a JSON object.', instanceUri) };
  }

  const unknownTopLevel = unknownKeyPath(parsedJson, ALLOWED_BODY_KEYS, '');
  if (unknownTopLevel) {
    return {
      refusal: createProblemDetailsResponse(
        422,
        `Unsupported field "${unknownTopLevel}".`,
        instanceUri,
        undefined,
        undefined,
        undefined,
        [{ name: unknownTopLevel, reason: 'unexpected property' }]
      ),
    };
  }

  const targetFormat = parseCaptureTargetFormat(parsedJson.targetFormat);
  if (!targetFormat) {
    return {
      refusal: createProblemDetailsResponse(
        400,
        'Missing or invalid "targetFormat". Supported website capture formats are pdf, png, and jpg.',
        instanceUri,
        undefined,
        undefined,
        undefined,
        [{ name: 'targetFormat', reason: 'must be one of pdf, png, jpg' }]
      ),
    };
  }

  const urlProblem = captureUrlProblem(parsedJson.url);
  if (urlProblem !== undefined) {
    return { refusal: blockedCaptureUrlRefusal(urlProblem, instanceUri) };
  }

  const parsedUrl = new URL(parsedJson.url as string);
  if (isPrivateOrRestrictedHost(parsedUrl.hostname)) {
    return {
      refusal: blockedCaptureUrlRefusal(
        `The address of ${parsedUrl.origin} is not a public one, so it cannot be captured.`,
        instanceUri
      ),
    };
  }

  const checkedOptions = validateCaptureOptions(parsedJson.options, instanceUri);
  if ('refusal' in checkedOptions) return checkedOptions;

  return {
    parsed: {
      url: parsedJson.url as string,
      targetFormat,
      options: checkedOptions.options,
    },
  };
}

const HTTP_INTERNAL_SERVER_ERROR = 500;

function captureErrorResponse(error: unknown, instanceUri: string): Response {
  const deadlineProblem = deadlineErrorResponse(error, instanceUri);
  if (deadlineProblem) return deadlineProblem;
  const queueProblem = queueErrorResponse(error, instanceUri);
  if (queueProblem) return queueProblem;
  if (error instanceof ConversionFailedError) {
    const response = typedFailureProblem(error, instanceUri);
    if (response.status >= HTTP_INTERNAL_SERVER_ERROR && !(error instanceof EngineMissingError)) {
      console.error('[capture/jobs]', error);
    }
    return response;
  }
  return serverFault('capture/jobs', error, 'Website capture enqueue error');
}

async function startCaptureJob(req: NextRequest, caller: User, instanceUri: string): Promise<Response> {
  try {
    if (!websiteCaptureEnabled()) {
      return typedFailureProblem(new CaptureUnavailableError(), instanceUri);
    }

    const requestResult = await readCaptureRequest(req, instanceUri);
    if ('refusal' in requestResult) return requestResult.refusal;
    const { parsed } = requestResult;

    const room = await mayEnqueue(caller.id, caller.tier);
    if (!room.allowed) return concurrencyLimitResponse(room.limit, instanceUri);

    if (isQueueOnlyWebMode() && !(await hasLiveQueueWorker())) {
      throw new QueueUnavailableError(
        'worker-pool',
        'No live conversion worker is available to process queued website capture jobs.'
      );
    }

    const unit = await reserveConversionUnit(caller, 1);
    if (!unit.reserved) return conversionRefusalResponse(unit.refusal, instanceUri);

    const jobId = crypto.randomUUID();
    const targetQueue = getQueueForResourceClass('memory');

    return await withReservedUnit(unit.reservationId, async (reserved) => {
      const job = await handOffConversionJob(
        reserved,
        targetQueue,
        {
          jobId,
          originalFilename: `capture.${parsed.targetFormat}`,
          sourceFormat: 'html',
          targetFormat: parsed.targetFormat,
          fileSize: 0,
          options: {},
          userId: caller.id,
          resourceClass: 'memory',
          captureJob: {
            url: parsed.url,
            format: parsed.targetFormat,
            options: parsed.options,
          },
        },
        {
          jobId,
          attempts: 1,
          priority: tierToPriority(caller.tier),
        },
        { tier: caller.tier }
      );

      return NextResponse.json(
        {
          success: true,
          jobId: job.id,
          status: job.state,
          progress: job.progress,
          createdAt: job.timestamp,
          queue: targetQueue.name,
        },
        { status: 201 }
      );
    });
  } catch (error: unknown) {
    return captureErrorResponse(error, instanceUri);
  }
}

export const POST = withinSingleRequest(admittingNewFiles(async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || ROUTE_PATH;
  const auth = await validateApiAccess(req, {
    requiredUnits: 0,
    requiredScope: 'convert:write',
    allowAnonymous: true,
  });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      auth.problemType,
      authErrorHeaders(auth)
    );
  }

  return respondOnce(req, auth.user.id, instanceUri, () => startCaptureJob(req, auth.user!, instanceUri), {
    afterFailedRecord: 'keep-lock',
  });
}));
