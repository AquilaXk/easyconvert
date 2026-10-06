import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { dispatchConversion } from '@/lib/conversions/dispatch';
import { detectFormatFromFilename, getFormatByExtension, assertNotSpoofedFile } from '@/lib/registry';
import { storageProvider } from '@/lib/storage';
import {
  createProblemDetailsResponse,
  createEngineUnavailableResponse,
  createPdfaValidationResponse,
} from '@/lib/api/problem-details';
import { buildRateLimitHeaders } from '@/lib/api/rate-limit';
import { pipeStreamToStorageMultipart } from '@/lib/streaming/large-payload-streamer';
import { validateOrProblem, ConversionOptionsSchema } from '@/lib/api/contracts';
import { acquireIdempotency, IdempotencyContext } from '@/lib/api/with-idempotency';
import { ArchiveEntryCollisionError, ConversionFailedError, EngineUnavailableError, PdfAValidationError } from '@/lib/types';
import type { FormatDefinition, ConversionOptions } from '@/lib/types';

export const dynamic = 'force-dynamic';

const INTERNAL_ERROR_DETAIL = 'Internal conversion error';

const ASYNC_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB auto-handoff threshold
const MAX_PROGRAMMATIC_FILE_SIZE = 500 * 1024 * 1024; // 500 MB max payload for async handoff

interface ValidatedConvertInput {
  file: File;
  sourceDef: FormatDefinition;
  targetDef: FormatDefinition;
  options: ConversionOptions;
}

function parseConvertFormData(formData: FormData): { error?: string; status?: number; data?: ValidatedConvertInput } {
  const file = formData.get('file');

  if (!file || typeof file === 'string' || !(file instanceof Blob)) {
    return { error: 'Missing required "file" or invalid file binary in multipart request.', status: 400 };
  }

  if (file.size === 0) {
    return { error: 'File payload is empty (0 bytes).', status: 400 };
  }

  if (file.size > MAX_PROGRAMMATIC_FILE_SIZE) {
    return { error: 'File size exceeds the 500 MB asynchronous payload boundary.', status: 400 };
  }

  const targetFormatEntry = formData.get('targetFormat');
  if (!targetFormatEntry || typeof targetFormatEntry !== 'string') {
    return { error: 'Missing required "targetFormat" parameter.', status: 400 };
  }
  const targetFormat = targetFormatEntry.trim();

  const sourceFormatParam = formData.get('sourceFormat');
  let sourceDef = typeof sourceFormatParam === 'string' ? getFormatByExtension(sourceFormatParam) : undefined;
  sourceDef ??= detectFormatFromFilename(file.name);

  if (!sourceDef) {
    return { error: `Could not identify source format for file "${file.name}".`, status: 400 };
  }

  const tgt = targetFormat.toLowerCase().replace(/^\./, '').trim();
  const targetDef = getFormatByExtension(tgt);
  if (!targetDef) {
    return { error: `Unsupported target format "${targetFormat}".`, status: 400 };
  }

  if (!sourceDef.targetFormats.includes(tgt) && !sourceDef.targetFormats.includes(targetDef.id)) {
    return {
      error: `Conversion from ${sourceDef.id.toUpperCase()} to ${targetDef.id.toUpperCase()} is not currently supported.`,
      status: 400,
    };
  }

  let options: ConversionOptions = {};
  const optionsRaw = formData.get('options');
  if (typeof optionsRaw === 'string' && optionsRaw.trim()) {
    try {
      const parsed = JSON.parse(optionsRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'The "options" field must be a valid JSON object.', status: 400 };
      }
      options = parsed;
    } catch {
      return { error: 'Invalid JSON string provided in "options" field.', status: 400 };
    }
  }

  return { data: { file: file as File, sourceDef, targetDef, options } };
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  const instanceUri = req.nextUrl?.pathname || '/api/v1/convert';

  // 1. Guard check: Authenticate and enforce 'convert:write' scope
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    // The guard only rejects with 429 here for the per-key burst limit (requiredUnits is 0), so the
    // daily-quota headers report the real remaining quota and the burst Retry-After takes precedence.
    let headers = authErrorHeaders(auth);
    if (auth.user) {
      const userQuota = await redisKeyStore.getQuotaUsage(auth.user.id);
      headers = { ...buildRateLimitHeaders(userQuota), ...headers };
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

  const reply = async (res: NextResponse | Response) => {
    if (idempotencyCtx) {
      if (res.status >= 500) {
        await idempotencyCtx.abort();
      } else {
        await idempotencyCtx.complete(res);
      }
    }
    return res;
  };

  // Obtain rate-limiting context and construct IETF RateLimit headers
  const quota = await redisKeyStore.getQuotaUsage(auth.user.id);
  const rateLimitHeaders = buildRateLimitHeaders(quota);

  if (quota.remaining <= 0) {
    const exhaustedQuota = { ...quota, remaining: 0 };
    return reply(createProblemDetailsResponse(
      429,
      `Daily conversion quota exceeded for tier '${auth.user.tier}'. Please upgrade or wait for the midnight UTC reset.`,
      instanceUri,
      'Too Many Requests',
      undefined,
      buildRateLimitHeaders(exhaustedQuota)
    ));
  }

  let reservation: { allowed: boolean; reservationId?: string } | null = null;

  try {
    const formData = await req.formData();
    const validation = parseConvertFormData(formData);
    if (validation.error || !validation.data) {
      return reply(createProblemDetailsResponse(
        validation.status ?? 400,
        validation.error || 'Invalid request parameters.',
        instanceUri,
        'Bad Request',
        undefined,
        rateLimitHeaders
      ));
    }

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
    reservation = await redisKeyStore.reserveQuota(auth.user.id, 1);
    if (!reservation.allowed) {
      const exhaustedQuota = { ...quota, remaining: 0 };
      return reply(createProblemDetailsResponse(
        429,
        `Daily conversion quota exceeded for tier '${auth.user.tier}'. Please upgrade or wait for the midnight UTC reset.`,
        instanceUri,
        'Too Many Requests',
        undefined,
        buildRateLimitHeaders(exhaustedQuota)
      ));
    }

    // Check for RFC 7240 Prefer: respond-async or file size > 10MB auto-handoff BEFORE calling file.arrayBuffer()
    const preferHeader = req.headers.get('prefer') || '';
    const isPreferAsync = preferHeader.toLowerCase().includes('respond-async');
    const isOverSizeThreshold = file.size > ASYNC_THRESHOLD_BYTES;

    if (isPreferAsync || isOverSizeThreshold) {
      // Asynchronous zero-heap streaming handoff: pipe stream directly to storage multipart upload
      let uploadedStorageKey: string;
      try {
        const stream = typeof (file as any).stream === 'function'
          ? (file as any).stream()
          : file;
        const streamResult = await pipeStreamToStorageMultipart(stream, {
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          expectedTotalSize: file.size,
          sourceExtension: sourceDef.extension,
          storage: storageProvider,
        });
        uploadedStorageKey = streamResult.storageKey;
      } catch (err: any) {
        if (reservation?.reservationId) {
          await redisKeyStore.rollbackQuota(reservation.reservationId);
        }
        return reply(createProblemDetailsResponse(
          400,
          err.message || 'File upload or validation failed.',
          instanceUri,
          'Bad Request',
          undefined,
          rateLimitHeaders
        ));
      }

      const job = await conversionQueue.add(
        'convert',
        {
          jobId: '',
          originalFilename: file.name,
          sourceFormat: sourceDef.id,
          targetFormat: targetDef.id,
          fileSize: file.size,
          storageKey: uploadedStorageKey,
          options,
          webhookUrl: effectiveWebhookUrl,
          webhookSecret: effectiveWebhookSecret,
          userId: auth.user.id,
          reservationId: reservation.reservationId,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        }
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

    // Synchronous execution path for payloads <= 10MB without respond-async preference
    const arrayBuffer = await file.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // Fail-closed verification against spoofed file extensions using initial-byte MIME magic sniffing
    try {
      assertNotSpoofedFile(inputBuffer, sourceDef.extension, file.name);
    } catch (err: any) {
      if (reservation?.reservationId) {
        await redisKeyStore.rollbackQuota(reservation.reservationId);
      }
      return reply(createProblemDetailsResponse(
        400,
        err.message || 'File spoofing detected.',
        instanceUri,
        'Bad Request',
        undefined,
        rateLimitHeaders
      ));
    }

    // Convert through the shared dispatcher (native engines first, in-process where valid)
    const conversionResult = await dispatchConversion(
      inputBuffer,
      sourceDef.id,
      targetDef.id,
      options,
      file.name
    );

    // 3. Phase 2: Commit reserved quota unit upon SUCCESSFUL conversion
    if (reservation?.reservationId) {
      await redisKeyStore.commitQuota(reservation.reservationId);
    }

    const durationMs = Date.now() - startTime;
    const outputBuffer = conversionResult.buffer;

    // Record in user's file conversion history
    const baseName = file.name.replace(/\.[^/.]+$/, '');
    const outFileName = `${baseName}.${targetDef.extension || targetDef.id}`;
    const storageKey = `conversions/${auth.user.id}/${Date.now()}_${outFileName}`;
    storageProvider.saveObject(storageKey, outputBuffer, conversionResult.mimeType, outFileName, 3600 * 1000);
    const downloadUrl = `/api/storage/file/${encodeURIComponent(storageKey)}`;

    const userFile = await redisKeyStore.recordUserFile({
      userId: auth.user.id,
      fileName: outFileName,
      fromFormat: sourceDef.id,
      toFormat: targetDef.id,
      size: outputBuffer.length,
      downloadUrl,
    });

    // Check if raw binary is requested (Zero-Heap: skip base64 serialization completely)
    const wantsRaw = req.headers.get('accept') === 'application/octet-stream' || req.nextUrl.searchParams.get('raw') === 'true';
    if (wantsRaw) {
      return reply(new NextResponse(new Uint8Array(outputBuffer), {
        status: 200,
        headers: {
          'Content-Type': conversionResult.mimeType,
          'Content-Disposition': `attachment; filename="${outFileName}"`,
          'X-Conversion-Time-Ms': durationMs.toString(),
          'X-File-Id': userFile.id,
          ...rateLimitHeaders,
        },
      }));
    }

    // Zero-Heap optimization: only generate Base64 data URI if output payload <= 5MB
    const MAX_DATA_URI_PAYLOAD_BYTES = 5 * 1024 * 1024;
    let dataUri: string | undefined;
    if (outputBuffer.length <= MAX_DATA_URI_PAYLOAD_BYTES) {
      const base64Data = outputBuffer.toString('base64');
      dataUri = `data:${conversionResult.mimeType};base64,${base64Data}`;
    }

    return reply(NextResponse.json(
      {
        success: true,
        fileId: userFile.id,
        fileName: outFileName,
        sourceFormat: sourceDef.id,
        targetFormat: targetDef.id,
        mimeType: conversionResult.mimeType,
        size: outputBuffer.length,
        durationMs,
        dataUri,
        downloadUrl,
        expiresAt: userFile.expiresAt,
      },
      {
        status: 200,
        headers: rateLimitHeaders,
      }
    ));
  } catch (err: unknown) {
    if (idempotencyCtx) {
      await idempotencyCtx.abort();
    }
    if (reservation?.reservationId) {
      await redisKeyStore.rollbackQuota(reservation.reservationId);
    }
    if (err instanceof EngineUnavailableError) {
      return createEngineUnavailableResponse(err, instanceUri, rateLimitHeaders);
    }
    if (err instanceof PdfAValidationError) {
      return createPdfaValidationResponse(err, instanceUri, rateLimitHeaders);
    }
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
  }
}
