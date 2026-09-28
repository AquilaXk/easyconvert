import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { keyStore } from '@/lib/api-keys/key-store';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { convertFile } from '@/lib/conversions';
import { detectFormatFromFilename, getFormatByExtension, assertNotSpoofedFile } from '@/lib/registry';
import { storageProvider } from '@/lib/storage';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { buildRateLimitHeaders } from '@/lib/api/rate-limit';
import type { FormatDefinition, ConversionOptions } from '@/lib/types';

export const dynamic = 'force-dynamic';

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

  // 1. Guard check: Authenticate and enforce 'convert' scope
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert' });
  if (!auth.authorized || !auth.user) {
    let headers: Record<string, string> | undefined;
    if (auth.user) {
      const userQuota = await redisKeyStore.getQuotaUsage(auth.user.id);
      headers = buildRateLimitHeaders(auth.status === 429 ? { ...userQuota, remaining: 0 } : userQuota);
    }
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      auth.status === 429 ? 'Too Many Requests' : undefined,
      auth.status === 429 ? 'https://api.easyconvert.io/problems/quota-exceeded' : undefined,
      headers
    );
  }

  // Obtain rate-limiting context and construct IETF RateLimit headers
  const quota = await redisKeyStore.getQuotaUsage(auth.user.id);
  const rateLimitHeaders = buildRateLimitHeaders(quota);

  // 2. Phase 1: Atomically reserve quota unit BEFORE CPU-intensive conversion (prevents TOCTOU races)
  const reservation = await redisKeyStore.reserveQuota(auth.user.id, 1);
  if (!reservation.allowed) {
    const exhaustedQuota = { ...quota, remaining: 0 };
    return createProblemDetailsResponse(
      429,
      `Daily conversion quota exceeded for tier '${auth.user.tier}'. Please upgrade or wait for the midnight UTC reset.`,
      instanceUri,
      'Too Many Requests',
      undefined,
      buildRateLimitHeaders(exhaustedQuota)
    );
  }

  try {
    const formData = await req.formData();
    const validation = parseConvertFormData(formData);
    if (validation.error || !validation.data) {
      if (reservation.reservationId) {
        await redisKeyStore.rollbackQuota(reservation.reservationId);
      }
      return createProblemDetailsResponse(
        validation.status ?? 400,
        validation.error || 'Invalid request parameters.',
        instanceUri,
        'Bad Request',
        undefined,
        rateLimitHeaders
      );
    }

    const { file, sourceDef, targetDef, options } = validation.data;

    const arrayBuffer = await file.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // Fail-closed verification against spoofed file extensions using initial-byte MIME magic sniffing
    try {
      assertNotSpoofedFile(inputBuffer, sourceDef.extension, file.name);
    } catch (err: any) {
      if (reservation.reservationId) {
        await redisKeyStore.rollbackQuota(reservation.reservationId);
      }
      return createProblemDetailsResponse(
        400,
        err.message || 'File spoofing detected.',
        instanceUri,
        'Bad Request',
        undefined,
        rateLimitHeaders
      );
    }

    // Check for RFC 7240 Prefer: respond-async or file size > 10MB auto-handoff
    const preferHeader = req.headers.get('prefer') || '';
    const isPreferAsync = preferHeader.toLowerCase().includes('respond-async');
    const isOverSizeThreshold = file.size > ASYNC_THRESHOLD_BYTES;

    if (isPreferAsync || isOverSizeThreshold) {
      // Asynchronous handoff: persist input payload and enqueue to distributed job queue
      const init = storageProvider.initiateMultipartUpload(
        file.name,
        file.type || 'application/octet-stream',
        file.size
      );
      storageProvider.uploadPart(init.uploadId, 1, inputBuffer);
      const completed = storageProvider.completeMultipartUpload(init.uploadId);
      const storageKey = completed.key;

      const effectiveWebhookUrl = auth.apiKey?.webhookUrl;
      const effectiveWebhookSecret = auth.apiKey?.webhookSecret;

      const job = await conversionQueue.add(
        'convert',
        {
          jobId: '',
          originalFilename: file.name,
          sourceFormat: sourceDef.id,
          targetFormat: targetDef.id,
          fileSize: file.size,
          storageKey,
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

      return NextResponse.json(
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
      );
    }

    // Synchronous execution path for payloads <= 10MB without respond-async preference
    // Convert
    const conversionResult = await convertFile(
      inputBuffer,
      sourceDef.id,
      targetDef.id,
      options,
      file.name
    );

    // 3. Phase 2: Commit reserved quota unit upon SUCCESSFUL conversion
    if (reservation.reservationId) {
      await redisKeyStore.commitQuota(reservation.reservationId);
    }

    const durationMs = Date.now() - startTime;
    const outputBuffer = conversionResult.buffer;
    const base64Data = outputBuffer.toString('base64');
    const dataUri = `data:${conversionResult.mimeType};base64,${base64Data}`;

    // Record in user's file conversion history
    const baseName = file.name.replace(/\.[^/.]+$/, '');
    const outFileName = `${baseName}.${targetDef.extension || targetDef.id}`;
    const storageKey = `conversions/${auth.user.id}/${Date.now()}_${outFileName}`;
    storageProvider.saveObject(storageKey, outputBuffer, conversionResult.mimeType, outFileName, 3600 * 1000);
    const downloadUrl = `/api/storage/file/${encodeURIComponent(storageKey)}`;

    const userFile = await keyStore.recordUserFile({
      userId: auth.user.id,
      fileName: outFileName,
      fromFormat: sourceDef.id,
      toFormat: targetDef.id,
      size: outputBuffer.length,
      downloadUrl,
    });

    // Check if raw binary is requested
    const wantsRaw = req.headers.get('accept') === 'application/octet-stream' || req.nextUrl.searchParams.get('raw') === 'true';
    if (wantsRaw) {
      return new NextResponse(new Uint8Array(outputBuffer), {
        status: 200,
        headers: {
          'Content-Type': conversionResult.mimeType,
          'Content-Disposition': `attachment; filename="${outFileName}"`,
          'X-Conversion-Time-Ms': durationMs.toString(),
          'X-File-Id': userFile.id,
          ...rateLimitHeaders,
        },
      });
    }

    return NextResponse.json(
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
    );
  } catch (err: unknown) {
    if (reservation.reservationId) {
      await redisKeyStore.rollbackQuota(reservation.reservationId);
    }
    const message = err instanceof Error ? err.message : 'Internal programmatic conversion error';
    return createProblemDetailsResponse(
      500,
      message,
      instanceUri,
      'Internal Server Error',
      undefined,
      rateLimitHeaders
    );
  }
}
