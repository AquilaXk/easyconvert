import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { storageProvider as s3Storage } from '@/lib/storage';
import { detectFormatFromFilename, getFormatByExtension, assertNotSpoofedFile } from '@/lib/registry';
import { assertNotSpoofedFilePath } from '@/lib/security/file-guard';
import { ConversionOptions, JobStatus, PipelineTask } from '@/lib/types';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';

export const dynamic = 'force-dynamic';

const MAX_JOB_PAYLOAD_SIZE = 500 * 1024 * 1024; // 500 MB for asynchronous processing

export async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/jobs';

  // 1. Guard check: Authenticate API key or user session with 'convert:write' scope
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri
    );
  }

  // 2. Phase 1: Atomically reserve quota unit BEFORE enqueueing
  const reservation = await redisKeyStore.reserveQuota(auth.user.id, 1);
  if (!reservation.allowed) {
    return createProblemDetailsResponse(
      429,
      `Daily conversion quota exceeded for tier '${auth.user.tier}'. Please upgrade or wait for the midnight UTC reset.`,
      instanceUri,
      'Too Many Requests'
    );
  }

  const failWithRollback = async (status: number, message: string, title: string = 'Bad Request') => {
    if (reservation.reservationId) {
      await redisKeyStore.rollbackQuota(reservation.reservationId);
    }
    return createProblemDetailsResponse(status, message, instanceUri, title);
  };

  try {
    const contentType = req.headers.get('content-type') || '';
    let originalFilename = '';
    let targetFormat = '';
    let sourceFormatParam: string | undefined;
    let options: ConversionOptions = {};
    let tasks: PipelineTask[] | undefined;
    let storageKey: string | undefined;
    let inputBufferBase64: string | undefined;
    let fileSize = 0;
    let webhookUrl: string | undefined;
    let webhookSecret: string | undefined;
    let uploadedBuffer: Buffer | null = null;
    let fileMeta: { name: string; type: string; size: number } | null = null;

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      targetFormat = ((formData.get('targetFormat') as string) || '').trim();
      sourceFormatParam = ((formData.get('sourceFormat') as string) || '').trim() || undefined;
      storageKey = ((formData.get('storageKey') as string) || '').trim() || undefined;
      webhookUrl = ((formData.get('webhookUrl') as string) || '').trim() || undefined;
      webhookSecret = ((formData.get('webhookSecret') as string) || '').trim() || undefined;

      const optionsRaw = formData.get('options') as string | null;
      if (optionsRaw) {
        try {
          const parsed = JSON.parse(optionsRaw);
          if (parsed && typeof parsed === 'object') {
            options = parsed;
          }
        } catch {
          return await failWithRollback(400, 'Invalid JSON string provided in "options" parameter.');
        }
      }

      const tasksRaw = formData.get('tasks') as string | null;
      if (tasksRaw) {
        try {
          const parsedTasks = JSON.parse(tasksRaw);
          if (Array.isArray(parsedTasks)) {
            tasks = parsedTasks;
          }
        } catch {
          return await failWithRollback(400, 'Invalid JSON string provided in "tasks" parameter.');
        }
      }

      if (file && file instanceof Blob && file.size > 0) {
        if (file.size > MAX_JOB_PAYLOAD_SIZE) {
          return await failWithRollback(400, 'File size exceeds the 500 MB asynchronous payload boundary.', 'Payload Too Large');
        }

        originalFilename = file.name;
        fileSize = file.size;

        const arrayBuffer = await file.arrayBuffer();
        uploadedBuffer = Buffer.from(arrayBuffer);
        fileMeta = {
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
        };
      }
    } else {
      // JSON body
      const body = await req.json().catch(() => ({}));
      originalFilename = (body.filename || body.originalFilename || '').trim();
      targetFormat = (body.targetFormat || '').trim();
      sourceFormatParam = (body.sourceFormat || '').trim() || undefined;
      options = body.options && typeof body.options === 'object' ? body.options : {};
      if (body.tasks && Array.isArray(body.tasks)) {
        tasks = body.tasks;
      }
      storageKey = (body.storageKey || '').trim() || undefined;
      inputBufferBase64 = body.inputBufferBase64;
      fileSize = Number(body.fileSize) || 0;
      webhookUrl = (body.webhookUrl || '').trim() || undefined;
      webhookSecret = (body.webhookSecret || '').trim() || undefined;
    }

    if (tasks && tasks.length > 0 && !targetFormat) {
      targetFormat = (tasks[tasks.length - 1].targetFormat || '').trim();
    }

    if (!originalFilename && storageKey) {
      originalFilename = storageKey.split('/').pop() || 'file';
    }

    if (!targetFormat) {
      return await failWithRollback(400, 'Missing required parameter: "targetFormat".');
    }

    if (!storageKey && !inputBufferBase64 && !uploadedBuffer) {
      return await failWithRollback(
        400,
        'Missing input file data. Please upload a "file" or provide "storageKey" / "inputBufferBase64".'
      );
    }

    // Resolve source format definition
    let sourceDef = sourceFormatParam ? getFormatByExtension(sourceFormatParam) : undefined;
    sourceDef ??= detectFormatFromFilename(originalFilename);

    if (!sourceDef) {
      return await failWithRollback(400, `Could not identify source format for file "${originalFilename}".`);
    }

    // Fail-closed verification against spoofed file extensions using initial-byte MIME magic sniffing
    try {
      if (uploadedBuffer) {
        assertNotSpoofedFile(uploadedBuffer, sourceDef.extension, originalFilename);
      } else if (inputBufferBase64) {
        const decodedBuf = Buffer.from(inputBufferBase64, 'base64');
        assertNotSpoofedFile(decodedBuf, sourceDef.extension, originalFilename);
      } else if (storageKey) {
        const stored = s3Storage.getObject(storageKey);
        if (!stored) {
          return await failWithRollback(400, `Storage object not found for key: "${storageKey}".`, 'Storage Object Not Found');
        }
        if (stored.filePath) {
          if (!fs.existsSync(stored.filePath)) {
            return await failWithRollback(400, `Storage file missing on disk: "${stored.filePath}".`, 'Storage File Missing');
          }
          assertNotSpoofedFilePath(stored.filePath, sourceDef.extension, originalFilename);
        } else if (stored.buffer && stored.buffer.length > 0) {
          assertNotSpoofedFile(stored.buffer, sourceDef.extension, originalFilename);
        } else {
          return await failWithRollback(400, `Storage object for key "${storageKey}" contains empty or unreadable file data.`, 'Empty Storage Object');
        }
      }
    } catch (err: any) {
      return await failWithRollback(400, err.message || 'File spoofing detected.', 'File Spoofing Detected');
    }

    // Persist multipart upload into S3 staging storage only after magic byte validation passes
    if (uploadedBuffer && fileMeta && !storageKey) {
      const init = s3Storage.initiateMultipartUpload(fileMeta.name, fileMeta.type, fileMeta.size);
      s3Storage.uploadPart(init.uploadId, 1, uploadedBuffer);
      const completed = s3Storage.completeMultipartUpload(init.uploadId);
      storageKey = completed.key;
    }

    // Resolve target format definition
    const cleanTarget = targetFormat.toLowerCase().replace(/^\./, '').trim();
    const targetDef = getFormatByExtension(cleanTarget);
    if (!targetDef) {
      return await failWithRollback(400, `Unsupported target format "${targetFormat}".`);
    }

    // Check format compatibility
    if (!sourceDef.targetFormats.includes(cleanTarget) && !sourceDef.targetFormats.includes(targetDef.id)) {
      return await failWithRollback(
        400,
        `Conversion from ${sourceDef.id.toUpperCase()} to ${targetDef.id.toUpperCase()} is not currently supported.`
      );
    }

    // Fall back to API Key configured webhook URL/Secret if not overridden in request
    const effectiveWebhookUrl = webhookUrl || auth.apiKey?.webhookUrl;
    const effectiveWebhookSecret = webhookSecret || auth.apiKey?.webhookSecret;

    // Enqueue conversion job to BullMQ queue
    const job = await conversionQueue.add(
      'convert',
      {
        jobId: '',
        originalFilename,
        sourceFormat: sourceDef.id,
        targetFormat: targetDef.id,
        fileSize,
        storageKey,
        inputBufferBase64,
        options,
        webhookUrl: effectiveWebhookUrl,
        webhookSecret: effectiveWebhookSecret,
        userId: auth.user.id,
        reservationId: reservation.reservationId,
        tasks,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      }
    );

    return NextResponse.json(
      {
        success: true,
        jobId: job.id,
        status: job.state,
        statusUrl: `/api/v1/jobs/${job.id}`,
        createdAt: job.timestamp,
        reservationId: reservation.reservationId,
        sourceFormat: sourceDef.id,
        targetFormat: targetDef.id,
        originalFilename,
      },
      { status: 202 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Job enqueue failure';
    return failWithRollback(500, message, 'Internal Server Error');
  }
}

export async function GET(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/jobs';

  // Guard check: Authenticate API key or user session with 'convert:read' scope
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:read' });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri
    );
  }

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get('status');
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));

  const validStates: JobStatus[] = ['waiting', 'active', 'completed', 'failed', 'delayed'];
  const requestedStates = statusParam
    ? (statusParam.split(',').map((s) => s.trim()) as JobStatus[]).filter((s) => validStates.includes(s))
    : validStates;

  const allJobs = await conversionQueue.getJobs(requestedStates.length > 0 ? requestedStates : validStates);

  // Filter jobs strictly belonging to the authenticated user (Tenant Boundary Isolation)
  const userJobs = allJobs
    .filter((j) => j.data?.userId === auth.user?.id)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);

  return NextResponse.json({
    success: true,
    total: userJobs.length,
    jobs: userJobs.map((j) => ({
      jobId: j.id,
      status: j.state,
      progress: j.progress,
      sourceFormat: j.data?.sourceFormat,
      targetFormat: j.data?.targetFormat,
      originalFilename: j.data?.originalFilename,
      fileSize: j.data?.fileSize,
      createdAt: j.timestamp,
      processedOn: j.processedOn,
      finishedOn: j.finishedOn,
      failedReason: j.failedReason,
      result: j.returnvalue,
    })),
  });
}

