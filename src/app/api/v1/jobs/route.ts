import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { mayUseStorageKeyAsJobInput, STORAGE_OBJECT_NOT_FOUND } from '@/lib/api-keys/owner-access';
import { conversionQueue, getQueueForResourceClass } from '@/lib/queue/conversion-queue';
import { resolveResourceClass, tierToPriority } from '@/lib/queue/resource-class';
import { generateJobId } from '@/lib/queue/bullmq-engine';
import { storageProvider as s3Storage } from '@/lib/storage';
import { detectFormatFromFilename, getFormatByExtension, assertNotSpoofedFile, FileExtensionSpoofError } from '@/lib/registry';
import { assertNotSpoofedFilePath } from '@/lib/security/file-guard';
import { ConversionOptions, JobStatus, PipelineTask, JobGraph } from '@/lib/types';
import { validateJobGraph, linearTasksToJobGraph, normalizeGraphNodes, JobGraphValidationError } from '@/lib/jobs';
import { graphScheduler } from '@/lib/queue/graph';
import { validateTierPageLimit } from '@/lib/conversions';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { buildRateLimitHeaders } from '@/lib/api/rate-limit';
import {
  validateOrProblem,
  JobCreateRequestSchema,
  ConversionOptionsSchema,
  PipelineTaskSchema,
  JobGraphSchema,
} from '@/lib/api/contracts';
import { acquireIdempotency, IdempotencyContext } from '@/lib/api/with-idempotency';
import { tusEngine } from '@/lib/storage/tus-engine';

export const dynamic = 'force-dynamic';

const MAX_INLINE_PAYLOAD_SIZE = 32 * 1024 * 1024; // 32 MiB ceiling for inline multipart and base64 payloads

const STORAGE_TIER_PAYLOAD_LIMITS: Record<string, number> = {
  free: 1024 * 1024 * 1024, // 1 GiB
  pro: 5 * 1024 * 1024 * 1024, // 5 GiB
  enterprise: 10 * 1024 * 1024 * 1024, // 10 GiB
};

export async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/jobs';

  // 1. Guard check: Authenticate API key or user session with 'convert:write' scope
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });

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

  const quota = await redisKeyStore.getQuotaUsage(auth.user.id);
  if (quota.remaining <= 0) {
    const exhaustedQuota = { ...quota, remaining: 0 };
    return reply(
      createProblemDetailsResponse(
        429,
        `Daily conversion quota exceeded for tier '${auth.user.tier}'. Please upgrade or wait for the midnight UTC reset.`,
        instanceUri,
        'Daily Quota Exceeded',
        'https://api.easyconvert.io/problems/quota-exceeded',
        buildRateLimitHeaders(exhaustedQuota)
      )
    );
  }

  let reservation: { allowed: boolean; reservationId?: string } | null = null;

  const failWithRollback = async (status: number, message: string, title: string = 'Bad Request') => {
    if (reservation?.reservationId) {
      await redisKeyStore.rollbackQuota(reservation.reservationId);
    }
    return reply(createProblemDetailsResponse(status, message, instanceUri, title));
  };

  try {
    const contentType = req.headers.get('content-type') || '';
    let originalFilename = '';
    let targetFormat = '';
    let sourceFormatParam: string | undefined;
    let options: ConversionOptions = {};
    let tasks: PipelineTask[] | undefined;
    let graph: JobGraph | undefined;
    let storageKey: string | undefined;
    let uploadId: string | undefined;
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
      uploadId = ((formData.get('uploadId') as string) || '').trim() || undefined;
      webhookUrl = ((formData.get('webhookUrl') as string) || '').trim() || undefined;
      webhookSecret = ((formData.get('webhookSecret') as string) || '').trim() || undefined;

      const optionsRaw = formData.get('options') as string | null;
      if (optionsRaw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(optionsRaw);
        } catch {
          return reply(createProblemDetailsResponse(400, 'Invalid JSON string provided in "options" parameter.', instanceUri));
        }
        const optValidation = validateOrProblem(ConversionOptionsSchema, parsed, instanceUri);
        if (!optValidation.ok) {
          return reply(optValidation.response);
        }
        options = (parsed && typeof parsed === 'object' ? parsed : {}) as ConversionOptions;
      }

      const graphRaw = formData.get('graph') as string | null;
      if (graphRaw) {
        try {
          const parsedGraph = JSON.parse(graphRaw);
          if (parsedGraph && typeof parsedGraph === 'object') {
            graph = parsedGraph as JobGraph;
          } else {
            return reply(createProblemDetailsResponse(422, 'Request validation failed: graph must be an object', instanceUri));
          }
        } catch {
          return reply(createProblemDetailsResponse(400, 'Invalid JSON string provided in "graph" parameter.', instanceUri));
        }
        const graphValidation = validateOrProblem(JobGraphSchema, graph, instanceUri);
        if (!graphValidation.ok) {
          return reply(graphValidation.response);
        }
      }

      const tasksRaw = formData.get('tasks') as string | null;
      if (tasksRaw) {
        try {
          const parsedTasks = JSON.parse(tasksRaw);
          if (Array.isArray(parsedTasks)) {
            tasks = parsedTasks;
          } else {
            return reply(createProblemDetailsResponse(
              422,
              'Request validation failed: tasks must be array',
              instanceUri,
              'Unprocessable Entity',
              'https://api.easyconvert.io/problems/unprocessable-entity',
              undefined,
              [{ name: 'tasks', reason: 'must be array' }]
            ));
          }
        } catch {
          return reply(createProblemDetailsResponse(400, 'Invalid JSON string provided in "tasks" parameter.', instanceUri));
        }
        for (let i = 0; i < tasks.length; i++) {
          const taskValidation = validateOrProblem(PipelineTaskSchema, tasks[i], instanceUri);
          if (!taskValidation.ok) {
            return reply(taskValidation.response);
          }
        }
      }

      if (file && file instanceof Blob && file.size > 0) {
        if (file.size > MAX_INLINE_PAYLOAD_SIZE) {
          return reply(
            createProblemDetailsResponse(
              413,
              'File size exceeds the 32 MiB inline payload boundary. For files larger than 32 MiB, use /api/v1/uploads direct multipart or /api/v1/uploads/tus resumable upload.',
              instanceUri,
              'Payload Too Large'
            )
          );
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
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return reply(createProblemDetailsResponse(400, 'Invalid JSON body provided in request.', instanceUri));
      }

      const bodyValidation = validateOrProblem(JobCreateRequestSchema, body, instanceUri);
      if (!bodyValidation.ok) {
        return reply(bodyValidation.response);
      }

      const validBody = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
      originalFilename = (validBody.filename || validBody.originalFilename || '').trim();
      targetFormat = (validBody.targetFormat || '').trim();
      sourceFormatParam = (validBody.sourceFormat || '').trim() || undefined;
      options = validBody.options && typeof validBody.options === 'object' ? validBody.options : {};
      if (validBody.tasks && Array.isArray(validBody.tasks)) {
        tasks = validBody.tasks;
      }
      if (validBody.graph && typeof validBody.graph === 'object') {
        graph = validBody.graph as JobGraph;
      }
      storageKey = (validBody.storageKey || '').trim() || undefined;
      uploadId = (validBody.uploadId || '').trim() || undefined;
      inputBufferBase64 = validBody.inputBufferBase64;
      fileSize = Number(validBody.fileSize) || 0;
      webhookUrl = (validBody.webhookUrl || '').trim() || undefined;
      webhookSecret = (validBody.webhookSecret || '').trim() || undefined;

      if (inputBufferBase64) {
        const approxBytes = Math.floor((inputBufferBase64.length * 3) / 4);
        if (approxBytes > MAX_INLINE_PAYLOAD_SIZE) {
          return reply(
            createProblemDetailsResponse(
              413,
              'Base64 payload exceeds the 32 MiB inline boundary. For files larger than 32 MiB, use /api/v1/uploads direct multipart or /api/v1/uploads/tus resumable upload.',
              instanceUri,
              'Payload Too Large'
            )
          );
        }
      }
    }

    // Normalize page / pages option and validate tier page limits
    if (options) {
      if (!options.pages && options.page) {
        options.pages = String(options.page);
      }
      if (options.pages) {
        try {
          validateTierPageLimit(options.pages, auth.user.tier);
        } catch (err: any) {
          return await failWithRollback(422, err.message, 'Unprocessable Entity');
        }
      }
    }

    if (tasks && Array.isArray(tasks)) {
      let pageRangeError: string | null = null;
      for (const t of tasks) {
        if (t.options) {
          if (!t.options.pages && t.options.page) {
            t.options.pages = String(t.options.page);
          }
          if (t.options.pages) {
            try {
              validateTierPageLimit(t.options.pages, auth.user.tier);
            } catch (err: any) {
              pageRangeError = err.message;
              break;
            }
          }
        }
      }
      if (pageRangeError) {
        return await failWithRollback(422, pageRangeError, 'Unprocessable Entity');
      }
    }

    // Resolve uploadId if provided
    if (uploadId && !storageKey) {
      const tusSession = await tusEngine.getSession(uploadId);
      if (tusSession) {
        if (!tusSession.completed) {
          return await failWithRollback(400, `Upload session "${uploadId}" is not completed yet.`);
        }
        if (tusSession.ownerUserId && tusSession.ownerUserId !== auth.user.id) {
          return await failWithRollback(404, STORAGE_OBJECT_NOT_FOUND, 'Not Found');
        }
        storageKey = tusSession.key;
        if (!originalFilename) {
          originalFilename = tusSession.filename;
        }
        if (!fileSize) {
          fileSize = tusSession.uploadLength;
        }
      } else {
        return await failWithRollback(404, `Upload session "${uploadId}" not found or expired.`, 'Not Found');
      }
    }

    // 1c. Validate JobGraph or adapt legacy tasks into JobGraph
    if (graph) {
      const graphValidation = validateJobGraph(graph, {
        userTier: auth.user.tier,
        sourceFormat: sourceFormatParam,
        sourceFilename: originalFilename,
      });
      if (!graphValidation.valid) {
        return reply(
          createProblemDetailsResponse(
            422,
            `Graph validation failed: ${graphValidation.errors.map((e) => e.message).join(' ')}`,
            instanceUri,
            'Unprocessable Entity',
            'https://api.easyconvert.io/problems/unprocessable-entity',
            undefined,
            graphValidation.errors.map((e) => ({ name: e.path, reason: e.message }))
          )
        );
      }
    } else if (tasks && tasks.length > 0) {
      try {
        graph = linearTasksToJobGraph(
          {
            storageKey,
            sourceFormat: sourceFormatParam,
            filename: originalFilename,
          },
          tasks
        );
      } catch (err) {
        if (!(err instanceof JobGraphValidationError)) {
          throw err;
        }
        return reply(
          createProblemDetailsResponse(
            422,
            err.message,
            instanceUri,
            'Unprocessable Entity',
            'https://api.easyconvert.io/problems/unprocessable-entity',
            undefined,
            err.errors.map((e) => ({ name: e.path, reason: e.message }))
          )
        );
      }
      const graphValidation = validateJobGraph(graph, {
        userTier: auth.user.tier,
        sourceFormat: sourceFormatParam,
        sourceFilename: originalFilename,
      });
      if (!graphValidation.valid) {
        return reply(
          createProblemDetailsResponse(
            422,
            `Pipeline tasks validation failed: ${graphValidation.errors.map((e) => e.message).join(' ')}`,
            instanceUri,
            'Unprocessable Entity',
            'https://api.easyconvert.io/problems/unprocessable-entity',
            undefined,
            graphValidation.errors.map((e) => ({ name: e.path, reason: e.message }))
          )
        );
      }
    }

    if (tasks && tasks.length > 0 && !targetFormat) {
      targetFormat = (tasks[tasks.length - 1].targetFormat || '').trim();
    }

    if (graph && !targetFormat) {
      const graphNodes = normalizeGraphNodes(graph);
      const convertNodes = Object.values(graphNodes).filter((n) => n.op === 'convert') as { targetFormat?: string }[];
      if (convertNodes.length > 0 && convertNodes[convertNodes.length - 1].targetFormat) {
        targetFormat = convertNodes[convertNodes.length - 1].targetFormat!;
      } else {
        const archiveNodes = Object.values(graphNodes).filter((n) => n.op === 'archive.create') as { targetFormat?: string }[];
        if (archiveNodes.length > 0 && archiveNodes[0].targetFormat) {
          targetFormat = archiveNodes[0].targetFormat!;
        }
      }
    }

    if (!storageKey && graph && !inputBufferBase64 && !uploadedBuffer) {
      const graphNodes = normalizeGraphNodes(graph);
      const uploadNode = Object.values(graphNodes).find((n) => n.op === 'import.upload') as { storageKey?: string } | undefined;
      if (uploadNode?.storageKey && !uploadNode.storageKey.startsWith('inline')) {
        storageKey = uploadNode.storageKey;
      }
    }

    if (!originalFilename && storageKey && !storageKey.startsWith('inline')) {
      originalFilename = storageKey.split('/').pop() || 'file';
    }

    const hasImportUrl = graph && Object.values(normalizeGraphNodes(graph)).some((n) => n.op === 'import.url');

    if (!targetFormat) {
      return await failWithRollback(400, 'Missing required parameter: "targetFormat".');
    }

    if (!storageKey && !inputBufferBase64 && !uploadedBuffer && !hasImportUrl) {
      return await failWithRollback(
        400,
        'Missing input file data. Please upload a "file" or provide "uploadId" / "storageKey" / "inputBufferBase64".'
      );
    }

    // Authorize a caller-supplied key before anything reads the object.
    if (storageKey && !storageKey.startsWith('inline') && !(await mayUseStorageKeyAsJobInput(storageKey, auth.user.id))) {
      return await failWithRollback(404, STORAGE_OBJECT_NOT_FOUND, 'Not Found');
    }

    // Resolve source format definition
    let sourceDef = sourceFormatParam ? getFormatByExtension(sourceFormatParam) : undefined;
    sourceDef ??= detectFormatFromFilename(originalFilename);

    if (!sourceDef && hasImportUrl && graph) {
      const graphNodes = normalizeGraphNodes(graph);
      const urlNode = Object.values(graphNodes).find((n) => n.op === 'import.url') as { url?: string } | undefined;
      if (urlNode?.url) {
        try {
          const parsedUrl = new URL(urlNode.url);
          const urlExt = path.extname(parsedUrl.pathname).replace(/^\./, '').toLowerCase();
          sourceDef = getFormatByExtension(urlExt);
          if (!originalFilename) {
            originalFilename = path.basename(parsedUrl.pathname) || 'remote_file';
          }
        } catch {
          // ignore
        }
      }
    }

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
          return await failWithRollback(404, STORAGE_OBJECT_NOT_FOUND, 'Not Found');
        }
        if (!fileSize) {
          fileSize = stored.size;
        }
        const userTier = auth.user.tier || 'free';
        const tierMaxBytes = STORAGE_TIER_PAYLOAD_LIMITS[userTier] || STORAGE_TIER_PAYLOAD_LIMITS.free;
        if (fileSize > tierMaxBytes) {
          return await failWithRollback(
            413,
            `Storage payload size (${fileSize} bytes) exceeds the ${tierMaxBytes} bytes limit for tier '${userTier}'.`,
            'Payload Too Large'
          );
        }
        if (stored.filePath) {
          if (!fs.existsSync(stored.filePath)) {
            console.error(`Storage file missing on disk: "${stored.filePath}"`);
            return await failWithRollback(400, 'Stored object is unavailable.', 'Storage File Missing');
          }
          assertNotSpoofedFilePath(stored.filePath, sourceDef.extension, originalFilename);
        } else {
          if (stored.size > 512 * 1024 * 1024) {
            return await failWithRollback(
              413,
              `Storage object size (${stored.size} bytes) exceeds in-memory buffer limit without a backing file path.`,
              'Payload Too Large'
            );
          }
          if (stored.buffer && stored.buffer.length > 0) {
            assertNotSpoofedFile(stored.buffer, sourceDef.extension, originalFilename);
          } else {
            return await failWithRollback(400, `Storage object for key "${storageKey}" contains empty or unreadable file data.`, 'Empty Storage Object');
          }
        }
      }
    } catch (err: any) {
      if (err instanceof FileExtensionSpoofError) {
        return await failWithRollback(400, err.message, 'File Spoofing Detected');
      }
      console.error(`Storage file verification error: ${err instanceof Error ? err.message : String(err)}`);
      return await failWithRollback(400, 'Stored object is unavailable.', 'Storage File Missing');
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

    // Check format compatibility for direct single conversion (multi-stage tasks and graphs validated above)
    if (!tasks && !graph) {
      if (!sourceDef.targetFormats.includes(cleanTarget) && !sourceDef.targetFormats.includes(targetDef.id)) {
        return await failWithRollback(
          400,
          `Conversion from ${sourceDef.id.toUpperCase()} to ${targetDef.id.toUpperCase()} is not currently supported.`
        );
      }
    }

    // Fall back to API Key configured webhook URL/Secret if not overridden in request
    const effectiveWebhookUrl = webhookUrl || auth.apiKey?.webhookUrl;
    const effectiveWebhookSecret = webhookSecret || auth.apiKey?.webhookSecret;

    if (webhookUrl && !webhookSecret) {
      return await failWithRollback(400, 'webhookSecret is required when webhookUrl is provided.');
    }

    if (effectiveWebhookUrl && !effectiveWebhookSecret) {
      return await failWithRollback(400, 'webhookSecret is required when webhookUrl is provided.');
    }

    // Phase 1: Atomically reserve quota unit BEFORE enqueueing to BullMQ
    reservation = await redisKeyStore.reserveQuota(auth.user.id, 1);
    if (!reservation.allowed) {
      const quota = await redisKeyStore.getQuotaUsage(auth.user.id);
      return reply(
        createProblemDetailsResponse(
          429,
          `Daily conversion quota exceeded for tier '${auth.user.tier}'. Please upgrade or wait for the midnight UTC reset.`,
          instanceUri,
          'Too Many Requests',
          undefined,
          buildRateLimitHeaders({ ...quota, remaining: 0 })
        )
      );
    }

    // Resolve resource class and scheduling priority
    const priority = tierToPriority(auth.user.tier);
    const resClass = resolveResourceClass(sourceDef.id, targetDef.id, fileSize, options);
    const targetQueue = getQueueForResourceClass(resClass);

    // A graph (including legacy linear tasks) runs only through the graph scheduler, which
    // enqueues each node; a separate conversion job would run the pipeline a second time.
    if (graph) {
      graph.nodes = normalizeGraphNodes(graph);
      const graphId = generateJobId();
      const graphState = await graphScheduler.initGraph(graphId, graph as any, {
        ownerUserId: auth.user.id,
        reservationId: reservation.reservationId,
        webhookUrl: effectiveWebhookUrl,
        webhookSecret: effectiveWebhookSecret,
        originalFilename,
        sourceStorageKey: storageKey,
        sourceFormat: sourceDef.id,
        targetFormat: targetDef.id,
        tasks,
      });
      const nodesResponse = Object.fromEntries(
        Object.entries(graphState.nodes).map(([nid, ns]) => [nid, { status: ns.status, outputs: ns.outputs || [] }])
      );
      return reply(
        NextResponse.json(
          {
            success: true,
            jobId: graphId,
            status: graphState.status,
            statusUrl: `/api/v1/jobs/${graphId}`,
            createdAt: graphState.createdAt,
            reservationId: reservation.reservationId,
            sourceFormat: sourceDef.id,
            targetFormat: targetDef.id,
            originalFilename,
            graph: graphState.graph,
            nodes: nodesResponse,
          },
          { status: 202 }
        )
      );
    }

    // Enqueue conversion job to the appropriate resource-class queue
    const job = await targetQueue.add(
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
        resourceClass: resClass,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        priority,
      }
    );

    const successRes = NextResponse.json(
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
    return reply(successRes);
  } catch (error: unknown) {
    if (idempotencyCtx) {
      await idempotencyCtx.abort();
    }
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
      instanceUri,
      undefined,
      auth.problemType,
      authErrorHeaders(auth)
    );
  }

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get('status');
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));

  const validStates: JobStatus[] = ['waiting', 'active', 'completed', 'failed', 'delayed', 'cancelled'];
  const requestedStates = statusParam
    ? (statusParam.split(',').map((s) => s.trim()) as JobStatus[]).filter((s) => validStates.includes(s))
    : validStates;

  // Query indexed jobs strictly belonging to the authenticated user (Tenant Boundary Isolation)
  const userJobs = await conversionQueue.getJobsByUser(
    auth.user.id,
    requestedStates.length > 0 ? requestedStates : validStates,
    limit,
    0
  );

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

