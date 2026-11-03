import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { validateApiAccess, authErrorHeaders, conversionsUsedUp, reserveConversionUnit, withReservedUnit } from '@/lib/api-keys/guard';
import type { ReservedUnit } from '@/lib/api-keys/hand-off';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import type { User } from '@/lib/auth/types';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { handOffConversionJob, trustedInputBytes } from '@/lib/queue/enqueue';
import { stripEngineControls } from '@/lib/conversions/job-time';
import { conversionDeadlineMs, syncDeadlineMs } from '@/lib/queue/job-deadline';
import { acquireSyncSlot, concurrencyLimitResponse } from '@/lib/queue/concurrency-limit';
import { bindJobLimits } from '@/lib/conversions/job-time';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { dispatchConversion } from '@/lib/conversions/dispatch';
import { frameMetadataFields, frameMetadataHeaders } from '@/lib/api/frame-headers';
import { engineTraceFields, engineTraceHeaders } from '@/lib/api/engine-trace';
import { conversionWarningsFields, conversionWarningsHeaders } from '@/lib/api/conversion-warnings';
import { droppedStreamsFields, droppedStreamsHeaders } from '@/lib/api/dropped-streams';
import { payloadLimitStatus } from '@/lib/api/payload-limit';
import { detectFormatFromFilename, getFormatByExtension } from '@/lib/registry';
import { assertNotSpoofedFile, spoofCheckStatus } from '@/lib/security/file-guard';
import { storageProvider } from '@/lib/storage';
import { saveRetainedResult } from '@/lib/storage/retention-service';
import {
  createProblemDetailsResponse,
  createEngineUnavailableResponse,
  createPdfPostprocessResponse,
} from '@/lib/api/problem-details';
import { buildRateLimitHeaders } from '@/lib/api/rate-limit';
import { withinSingleRequest } from '@/lib/api/file-size-limit';
import { describeStorageError, storageErrorResponse } from '@/lib/api/storage-error-response';
import { pipeStreamToStorageMultipart } from '@/lib/streaming/large-payload-streamer';
import { validateOrProblem, ConversionOptionsSchema } from '@/lib/api/contracts';
import { acquireIdempotency, IdempotencyContext } from '@/lib/api/with-idempotency';
import {
  ArchiveEntryCollisionError,
  ConversionFailedError,
  isUnprocessableInputError,
  EngineUnavailableError,
  PdfPostprocessError,
  WorkerOutputMissingError,
  WORKER_OUTPUT_MISSING_DETAIL,
} from '@/lib/types';
import type { FormatDefinition, ConversionOptions } from '@/lib/types';

const ZIP_MIME_TYPE = 'application/zip';

export const dynamic = 'force-dynamic';

const INTERNAL_ERROR_DETAIL = 'Internal conversion error';

const ASYNC_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB auto-handoff threshold

interface ValidatedConvertInput {
  file: File;
  sourceDef: FormatDefinition;
  targetDef: FormatDefinition;
  options: ConversionOptions;
}

/** A validated request whose conversion unit is reserved, with what its answer needs. */
interface ReservedConversion extends ValidatedConvertInput {
  req: NextRequest;
  user: User;
  webhookUrl?: string;
  webhookSecret?: string;
  rateLimitHeaders: Record<string, string>;
  instanceUri: string;
  startTime: number;
  reply: (res: NextResponse | Response) => Promise<NextResponse | Response>;
}

type ParsedConvertForm = { problem: NextResponse; data?: undefined } | { data: ValidatedConvertInput; problem?: undefined };

/** The validated input of a convert request, or the problem answer for the first thing wrong with it. */
function parseConvertFormData(
  formData: FormData,
  instanceUri: string,
  headers: Record<string, string>
): ParsedConvertForm {
  const badRequest = (detail: string): ParsedConvertForm => ({
    problem: createProblemDetailsResponse(400, detail, instanceUri, 'Bad Request', undefined, headers),
  });
  const file = formData.get('file');

  if (!file || typeof file === 'string' || !(file instanceof Blob)) {
    return badRequest('Missing required "file" or invalid file binary in multipart request.');
  }

  if (file.size === 0) {
    return badRequest('File payload is empty (0 bytes).');
  }

  const targetFormatEntry = formData.get('targetFormat');
  if (!targetFormatEntry || typeof targetFormatEntry !== 'string') {
    return badRequest('Missing required "targetFormat" parameter.');
  }
  const targetFormat = targetFormatEntry.trim();

  const sourceFormatParam = formData.get('sourceFormat');
  let sourceDef = typeof sourceFormatParam === 'string' ? getFormatByExtension(sourceFormatParam) : undefined;
  sourceDef ??= detectFormatFromFilename(file.name);

  if (!sourceDef) {
    return badRequest(`Could not identify source format for file "${file.name}".`);
  }

  const tgt = targetFormat.toLowerCase().replace(/^\./, '').trim();
  const targetDef = getFormatByExtension(tgt);
  if (!targetDef) {
    return badRequest(`Unsupported target format "${targetFormat}".`);
  }

  if (!sourceDef.targetFormats.includes(tgt) && !sourceDef.targetFormats.includes(targetDef.id)) {
    return badRequest(`Conversion from ${sourceDef.id.toUpperCase()} to ${targetDef.id.toUpperCase()} is not currently supported.`);
  }

  let options: ConversionOptions = {};
  const optionsRaw = formData.get('options');
  if (typeof optionsRaw === 'string' && optionsRaw.trim()) {
    try {
      const parsed = JSON.parse(optionsRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return badRequest('The "options" field must be a valid JSON object.');
      }
      options = parsed;
    } catch {
      return badRequest('Invalid JSON string provided in "options" field.');
    }
  }

  return { data: { file: file as File, sourceDef, targetDef, options } };
}

export const POST = withinSingleRequest(admittingNewFiles(async function POST(req: NextRequest) {
  const startTime = Date.now();
  const instanceUri = req.nextUrl?.pathname || '/api/v1/convert';

  // 1. Guard check: Authenticate and enforce 'convert:write' scope
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    // The guard only rejects with 429 here for the per-key burst limit (requiredUnits is 0), so the
    // daily-quota headers report the real remaining quota and the burst Retry-After takes precedence.
    let headers = authErrorHeaders(auth);
    if (auth.user) {
      try {
        const userQuota = await redisKeyStore.getQuotaUsage(auth.user.id);
        headers = { ...buildRateLimitHeaders(userQuota), ...headers };
      } catch (quotaError) {
        // The quota headers are a courtesy: the guard's rejection stands without them.
        console.error('[v1/convert] Quota headers left out of a rejection, the quota lookup failed:', quotaError);
      }
    }
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      auth.problemType,
      headers
    );
  }

  // 1b. Idempotency Check
  const rawIdempotencyKey = req.headers.get('idempotency-key');
  let idempotencyCtx: IdempotencyContext | undefined;
  if (rawIdempotencyKey !== null) {
    const precheck = await acquireIdempotency(req, auth.user.id, rawIdempotencyKey, instanceUri);
    if (precheck.response) {
      return precheck.response;
    }
    idempotencyCtx = precheck.context;
  }

  // The answer stands whatever the idempotency store does: a store failure after a conversion was charged must not turn
  // its success into an error the client would retry, and pay for again.
  const reply = async (res: NextResponse | Response) => {
    if (!idempotencyCtx) return res;
    try {
      if (res.status >= 500) {
        await idempotencyCtx.abort();
      } else {
        await idempotencyCtx.complete(res);
      }
    } catch (storeError) {
      console.error('[v1/convert] The idempotency store could not record the answer; it is answered without a replay:', storeError);
    }
    return res;
  };

  // Obtain rate-limiting context and construct IETF RateLimit headers
  const quota = await redisKeyStore.getQuotaUsage(auth.user.id);
  const rateLimitHeaders = buildRateLimitHeaders(quota);

  if (quota.remaining <= 0) return reply(conversionRefusalResponse(conversionsUsedUp(auth.user, quota, 1), instanceUri));

  // At most five conversions in flight (queued plus running) for an anonymous or free caller. The slot is held until
  // the request ends; an asynchronous handoff stays counted through the job it queues.
  let releaseSlot: (() => void) | undefined;
  try {
    const slot = await acquireSyncSlot(auth.user.id, auth.user.tier);
    if (!slot.granted) {
      if (idempotencyCtx) await idempotencyCtx.abort();
      return concurrencyLimitResponse(slot.limit, instanceUri, rateLimitHeaders);
    }
    releaseSlot = slot.release;
    const formData = await req.formData();
    const validation = parseConvertFormData(formData, instanceUri, rateLimitHeaders);
    if (!validation.data) return reply(validation.problem);

    const { file, sourceDef, targetDef, options } = validation.data;

    // Validate conversion options against SSOT JSON Schema contract BEFORE reserving quota
    if (options && Object.keys(options).length > 0) {
      const optionsValidation = validateOrProblem(ConversionOptionsSchema, options, instanceUri);
      if (!optionsValidation.ok) {
        return reply(optionsValidation.response as NextResponse);
      }
    }

    const webhookUrlParam = ((formData.get('webhookUrl') as string) || '').trim() || undefined;
    const webhookSecretParam = ((formData.get('webhookSecret') as string) || '').trim() || undefined;

    if (webhookUrlParam && !webhookSecretParam) {
      return reply(createProblemDetailsResponse(
        400,
        'webhookSecret is required when webhookUrl is provided.',
        instanceUri,
        'Bad Request',
        undefined,
        rateLimitHeaders
      ));
    }

    const effectiveWebhookUrl = webhookUrlParam || auth.apiKey?.webhookUrl;
    const effectiveWebhookSecret = webhookSecretParam || auth.apiKey?.webhookSecret;

    if (effectiveWebhookUrl && !effectiveWebhookSecret) {
      return reply(createProblemDetailsResponse(
        400,
        'webhookSecret is required when webhookUrl is provided.',
        instanceUri,
        'Bad Request',
        undefined,
        rateLimitHeaders
      ));
    }

    // Phase 1: Atomically reserve quota unit BEFORE CPU-intensive conversion
    const unit = await reserveConversionUnit(auth.user);
    if (!unit.reserved) return reply(conversionRefusalResponse(unit.refusal, instanceUri));

    const conversion: ReservedConversion = {
      req,
      user: auth.user,
      file,
      sourceDef,
      targetDef,
      options,
      webhookUrl: effectiveWebhookUrl,
      webhookSecret: effectiveWebhookSecret,
      rateLimitHeaders,
      instanceUri,
      startTime,
      reply,
    };
    return await withReservedUnit(unit.reservationId, (reserved) => convertReserved(conversion, reserved));
  } catch (err: unknown) {
    if (idempotencyCtx) {
      await idempotencyCtx.abort();
    }
    const deadlineProblem = deadlineErrorResponse(err, instanceUri, rateLimitHeaders);
    if (deadlineProblem) return deadlineProblem;
    if (err instanceof EngineUnavailableError) {
      return createEngineUnavailableResponse(err, instanceUri, rateLimitHeaders);
    }
    if (err instanceof PdfPostprocessError) {
      return createPdfPostprocessResponse(err, instanceUri, rateLimitHeaders);
    }
    const storageProblem = storageErrorResponse(err, instanceUri, rateLimitHeaders);
    if (storageProblem) return storageProblem;
    if (err instanceof ArchiveEntryCollisionError) {
      return createProblemDetailsResponse(
        err.status,
        err.message,
        instanceUri,
        'Archive Entry Collision',
        undefined,
        rateLimitHeaders
      );
    }
    const limitStatus = payloadLimitStatus(err);
    if (limitStatus !== null) {
      // A stream decodes past a size limit, an image declares more pixels than allowed, or a WOFF2 passes the codec limits: 413.
      return createProblemDetailsResponse(limitStatus, err instanceof Error ? err.message : String(err), instanceUri, undefined, undefined, rateLimitHeaders);
    }
    if (isUnprocessableInputError(err)) {
      // The file is intact but encrypted, password protected, DRM protected or coded with a method this engine does not
      // decode (an archive's password and method errors included), a DWG release or drawing the DWG reader refuses, or a font FontForge
      // cannot read in full: 422, not the 400 of a malformed input.
      return createProblemDetailsResponse(err.status, err.message, instanceUri, undefined, undefined, rateLimitHeaders);
    }
    if (err instanceof WorkerOutputMissingError) {
      // A server fault, not a verdict on the input: log it, answer 500 without the worker's file name.
      console.error('[v1/convert] Worker output vanished before it was read:', err);
      return createProblemDetailsResponse(
        err.status,
        WORKER_OUTPUT_MISSING_DETAIL,
        instanceUri,
        'Internal Server Error',
        undefined,
        rateLimitHeaders
      );
    }
    if (err instanceof ConversionFailedError) {
      // Typed input rejection (spoofed signature, invalid page range, malformed input): fail closed with 400.
      return createProblemDetailsResponse(400, err.message, instanceUri, 'Bad Request', undefined, rateLimitHeaders);
    }
    // Internal errors can carry sandbox paths: log the real error, answer with a generic detail.
    console.error('[v1/convert] Conversion failed with an internal error:', err);
    return createProblemDetailsResponse(
      500,
      INTERNAL_ERROR_DETAIL,
      instanceUri,
      'Internal Server Error',
      undefined,
      rateLimitHeaders
    );
  } finally {
    releaseSlot?.();
  }
}));

/** Hands a large or `respond-async` conversion to the queue: its job owns the unit once queued, and commits it or gives it back. */
async function queueReserved(c: ReservedConversion, unit: ReservedUnit): Promise<NextResponse | Response> {
  const { file, sourceDef, targetDef, options, user, rateLimitHeaders, instanceUri, reply } = c;
  // Asynchronous zero-heap streaming handoff: pipe stream directly to storage multipart upload
  let uploadedStorageKey: string;
  try {
    const streamResult = await pipeStreamToStorageMultipart(file.stream(), {
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      expectedTotalSize: file.size,
      sourceExtension: sourceDef.extension,
      storage: storageProvider,
    });
    uploadedStorageKey = streamResult.storageKey;
  } catch (err: unknown) {
    const storageProblem = describeStorageError(err);
    if (storageProblem) {
      return reply(createProblemDetailsResponse(
        storageProblem.status,
        storageProblem.detail,
        instanceUri,
        storageProblem.title,
        undefined,
        { ...rateLimitHeaders, ...storageProblem.headers }
      ));
    }
    return reply(createProblemDetailsResponse(
      400,
      (err instanceof Error && err.message) || 'File upload or validation failed.',
      instanceUri,
      'Bad Request',
      undefined,
      rateLimitHeaders
    ));
  }

  const inputBytes = await trustedInputBytes({ storageKey: uploadedStorageKey }, storageProvider);
  const job = await handOffConversionJob(
    unit,
    conversionQueue,
    {
      jobId: '',
      originalFilename: file.name,
      sourceFormat: sourceDef.id,
      targetFormat: targetDef.id,
      fileSize: file.size,
      storageKey: uploadedStorageKey,
      options: stripEngineControls(options),
      webhookUrl: c.webhookUrl,
      webhookSecret: c.webhookSecret,
      userId: user.id,
    },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    },
    { tier: user.tier, inputBytes }
  );

  return reply(NextResponse.json(
    {
      success: true,
      status: 'accepted',
      jobId: job.id,
      statusUrl: `/api/v1/jobs/${job.id}`,
      location: `/api/v1/jobs/${job.id}`,
      message: 'Conversion job accepted for asynchronous processing.',
      sourceFormat: sourceDef.id,
      targetFormat: targetDef.id,
      originalFilename: file.name,
      fileSize: file.size,
      createdAt: job.timestamp,
    },
    {
      status: 202,
      headers: {
        Location: `/api/v1/jobs/${job.id}`,
        'Preference-Applied': 'respond-async',
        ...rateLimitHeaders,
      },
    }
  ));
}

/**
 * Converts a request whose unit is reserved. A synchronous conversion is charged once its result is stored, recorded and
 * its answer built, the last step that can fail, so no error answers a charged conversion.
 */
async function convertReserved(c: ReservedConversion, unit: ReservedUnit): Promise<NextResponse | Response> {
  const { req, user, file, sourceDef, targetDef, options, rateLimitHeaders, instanceUri, startTime, reply } = c;

  // Check for RFC 7240 Prefer: respond-async or file size > 10MB auto-handoff BEFORE calling file.arrayBuffer()
  const preferHeader = req.headers.get('prefer') || '';
  const isPreferAsync = preferHeader.toLowerCase().includes('respond-async');
  if (isPreferAsync || file.size > ASYNC_THRESHOLD_BYTES) return queueReserved(c, unit);

  // Synchronous execution path for payloads <= 10MB without respond-async preference
  const inputBuffer = Buffer.from(await file.arrayBuffer());

  // Fail-closed verification against spoofed file extensions using initial-byte MIME magic sniffing
  try {
    assertNotSpoofedFile(inputBuffer, sourceDef.extension, file.name);
  } catch (err: unknown) {
    return reply(createProblemDetailsResponse(
      spoofCheckStatus(err),
      (err instanceof Error && err.message) || 'File spoofing detected.',
      instanceUri,
      undefined,
      undefined,
      rateLimitHeaders
    ));
  }

  // Convert through the shared dispatcher (native engines first, in-process where valid)
  const deadlineMs = syncDeadlineMs(
    conversionDeadlineMs({
      tier: user.tier,
      sourceFormat: sourceDef.id,
      targetFormat: targetDef.id,
      inputBytes: inputBuffer.length,
    })
  );
  const conversionResult = await runUnderDeadline(req, deadlineMs, (limits) =>
    dispatchConversion(
      inputBuffer,
      sourceDef.id,
      targetDef.id,
      bindJobLimits(options, limits),
      file.name
    )
  );

  const durationMs = Date.now() - startTime;
  const outputBuffer = conversionResult.buffer;

  // Store the result before the quota unit is committed: a storage outage fails the request and
  // rolls the reservation back, so the user is not charged for a result they cannot download.
  const baseName = file.name.replace(/\.[^/.]+$/, '');
  // Multi-page results (one image per page) come back as a ZIP whatever the requested target is.
  const outExtension = conversionResult.mimeType === ZIP_MIME_TYPE ? 'zip' : targetDef.extension || targetDef.id;
  const outFileName = `${baseName}.${outExtension}`;
  const storageKey = `conversions/${user.id}/${Date.now()}_${outFileName}`;
  await saveRetainedResult(storageProvider, storageKey, outputBuffer, conversionResult.mimeType, outFileName);

  // Record in user's file conversion history
  const stored = { storageKey, downloadUrl: `/api/storage/file/${encodeURIComponent(storageKey)}` };

  const userFile = await redisKeyStore.recordUserFile({
    userId: user.id,
    fileName: outFileName,
    fromFormat: sourceDef.id,
    toFormat: targetDef.id,
    size: outputBuffer.length,
    ...stored,
  });

  const answer = answerOfConversion(req, {
    conversionResult,
    outFileName,
    durationMs,
    fileId: userFile.id,
    expiresAt: userFile.expiresAt,
    downloadUrl: stored.downloadUrl,
    sourceFormat: sourceDef.id,
    targetFormat: targetDef.id,
    rateLimitHeaders,
  });
  // 3. Phase 2: Commit reserved quota unit upon SUCCESSFUL conversion; `reply` answers whatever the idempotency store does.
  await unit.commit();
  return reply(answer);
}

interface ConversionAnswer {
  conversionResult: Awaited<ReturnType<typeof dispatchConversion>>;
  outFileName: string;
  durationMs: number;
  fileId: string;
  expiresAt?: number;
  downloadUrl: string;
  sourceFormat: string;
  targetFormat: string;
  rateLimitHeaders: Record<string, string>;
}

/** Zero-Heap optimization: only generate Base64 data URI if output payload <= 5MB */
const MAX_DATA_URI_PAYLOAD_BYTES = 5 * 1024 * 1024;

/** The answer of a finished synchronous conversion: the raw bytes when asked for, else JSON with a data URI for a small result. */
function answerOfConversion(req: NextRequest, a: ConversionAnswer): NextResponse {
  const { conversionResult, rateLimitHeaders } = a;
  const outputBuffer = conversionResult.buffer;
  // Check if raw binary is requested (Zero-Heap: skip base64 serialization completely)
  const wantsRaw = req.headers.get('accept') === 'application/octet-stream' || req.nextUrl.searchParams.get('raw') === 'true';
  if (wantsRaw) {
    return new NextResponse(new Uint8Array(outputBuffer), {
      status: 200,
      headers: {
        'Content-Type': conversionResult.mimeType,
        'Content-Disposition': `attachment; filename="${a.outFileName}"`,
        'X-Conversion-Time-Ms': a.durationMs.toString(),
        'X-File-Id': a.fileId,
        ...frameMetadataHeaders(conversionResult),
        ...engineTraceHeaders(conversionResult),
        ...droppedStreamsHeaders(conversionResult),
        ...conversionWarningsHeaders(conversionResult),
        ...rateLimitHeaders,
      },
    });
  }

  const dataUri =
    outputBuffer.length <= MAX_DATA_URI_PAYLOAD_BYTES ? `data:${conversionResult.mimeType};base64,${outputBuffer.toString('base64')}` : undefined;

  return NextResponse.json(
    {
      success: true,
      fileId: a.fileId,
      fileName: a.outFileName,
      sourceFormat: a.sourceFormat,
      targetFormat: a.targetFormat,
      mimeType: conversionResult.mimeType,
      size: outputBuffer.length,
      durationMs: a.durationMs,
      dataUri,
      downloadUrl: a.downloadUrl,
      expiresAt: a.expiresAt,
      ...frameMetadataFields(conversionResult),
      ...engineTraceFields(conversionResult),
      ...droppedStreamsFields(conversionResult),
      ...conversionWarningsFields(conversionResult),
    },
    {
      status: 200,
      headers: rateLimitHeaders,
    }
  );
}
