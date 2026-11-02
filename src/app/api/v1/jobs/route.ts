import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { validateApiAccess, authErrorHeaders, conversionsUsedUp, reserveConversionUnit, withReservedUnit, type ReservedUnit } from '@/lib/api-keys/guard';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import type { User } from '@/lib/auth/types';
import type { FormatDefinition } from '@/lib/types';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { mayUseStorageKeyAsJobInput, STORAGE_OBJECT_NOT_FOUND } from '@/lib/api-keys/owner-access';
import { graphInputKeys, initGraphHoldingInputs } from '@/lib/queue/graph/input-cleanup';
import { conversionQueue, getQueueForResourceClass } from '@/lib/queue/conversion-queue';
import { enqueueConversionJob, trustedInputBytes } from '@/lib/queue/enqueue';
import { stripEngineControls } from '@/lib/conversions/job-time';
import { JobDeadlineError } from '@/lib/queue/job-deadline';
import { concurrencyLimitResponse, mayEnqueue } from '@/lib/queue/concurrency-limit';
import { resolveResourceClass, tierToPriority } from '@/lib/queue/resource-class';
import { generateJobId } from '@/lib/queue/bullmq-engine';
import { storageProvider as s3Storage } from '@/lib/storage';
import { readObjectHeader } from '@/lib/storage/object-header';
import { detectFormatFromFilename, getFormatByExtension } from '@/lib/registry';
import { assertNotSpoofedFile, assertNotSpoofedFilePath, assertNotSpoofedObject, spoofCheckRefusal } from '@/lib/security/file-guard';
import { ConversionOptions, JobStatus, PipelineTask, JobGraph, QueueUnavailableError } from '@/lib/types';
import {
  validateJobGraph,
  linearTasksToJobGraph,
  linearGraphOutputFormat,
  normalizeGraphNodes,
  JobGraphValidationError,
} from '@/lib/jobs';
import { graphReservationUnits } from '@/lib/jobs/graph-operations';
import { PROBLEM_TYPE_BASE } from '@/lib/refusal-codes';
import { graphScheduler } from '@/lib/queue/graph';
import { redactForOutput, redactText } from '@/lib/security/redact';
import { SealingKeyConfigError, SecretSealError } from '@/lib/security/job-secret-seal';
import { checkSubmissionLimits } from '@/lib/jobs/submission-limits';
import { validateTierPageLimit } from '@/lib/conversions';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { INLINE_JOB_PAYLOAD_MAX_BYTES, fileTooLargeMessage, maxFileBytes, planOfCaller, type Plan, type PlanCaller } from '@/lib/plan-limits';
import { withinSingleRequest } from '@/lib/api/file-size-limit';
import { describeStorageError } from '@/lib/api/storage-error-response';
import { QUEUE_UNAVAILABLE_DETAIL, queueRetryAfterHeaders, withQueueErrors } from '@/lib/api/queue-error-response';
import {
  validateOrProblem,
  JobCreateRequestSchema,
  ConversionOptionsSchema,
  PipelineTaskSchema,
  JobGraphSchema,
} from '@/lib/api/contracts';
import { acquireIdempotency, IdempotencyContext } from '@/lib/api/with-idempotency';
import { isInlineInputKey } from '@/lib/storage/key-namespace';
import { tusEngine } from '@/lib/storage/tus-engine';

export const dynamic = 'force-dynamic';

/** The problem of a graph whose nodes only import and export files (`graph-without-conversion`). */
const GRAPH_WITHOUT_CONVERSION_PROBLEM_TYPE = `${PROBLEM_TYPE_BASE}graph-without-conversion`;
const GRAPH_WITHOUT_CONVERSION_DETAIL = 'The graph has no conversion: a job needs at least one node that converts, between its imports and its exports.';

/** The refusal of a job whose stored files the caller may not use, or that a graph reads over the limit of the caller's plan; undefined when every stored file passes. */
async function storedInputRefusal(
  storageKey: string | undefined,
  graph: JobGraph | undefined,
  caller: PlanCaller & { id: string }
): Promise<{ status: number; message: string; title: string } | undefined> {
  const graphKeys = graph ? graphInputKeys(normalizeGraphNodes(graph)) : [];
  const keys = new Set(graphKeys);
  if (storageKey) keys.add(storageKey);
  for (const key of keys) {
    if (!isInlineInputKey(key) && !(await mayUseStorageKeyAsJobInput(key, caller.id))) {
      return { status: 404, message: STORAGE_OBJECT_NOT_FOUND, title: 'Not Found' };
    }
  }
  const plan = planOfCaller(caller);
  for (const key of graphKeys) {
    const info = isInlineInputKey(key) ? undefined : await s3Storage.stat(key);
    if (info && info.size > maxFileBytes(plan)) {
      return { status: 413, message: fileTooLargeMessage(plan, info.size), title: 'Payload Too Large' };
    }
  }
  return undefined;
}

export const POST = withinSingleRequest(admittingNewFiles(async function POST(req: NextRequest) {
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
  if (quota.remaining <= 0) return reply(conversionRefusalResponse(conversionsUsedUp(auth.user, quota, 1), instanceUri));

  const fail = async (
    status: number,
    message: string,
    title: string = 'Bad Request',
    invalidParams?: Array<{ name: string; reason: string }>,
    headers?: Record<string, string>
  ) => reply(createProblemDetailsResponse(status, message, instanceUri, title, undefined, headers, invalidParams));

  try {
    // At most five conversions in flight (queued plus running) for an anonymous or free caller. A refusal is not
    // stored as the answer of the idempotency key: the same request may succeed once a job has finished.
    const room = await mayEnqueue(auth.user.id, auth.user.tier);
    if (!room.allowed) {
      if (idempotencyCtx) await idempotencyCtx.abort();
      return concurrencyLimitResponse(room.limit, instanceUri);
    }
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
        if (file.size > INLINE_JOB_PAYLOAD_MAX_BYTES) {
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
        if (approxBytes > INLINE_JOB_PAYLOAD_MAX_BYTES) {
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
          return await fail(422, err.message, 'Unprocessable Entity');
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
        return await fail(422, pageRangeError, 'Unprocessable Entity');
      }
    }

    // Resolve uploadId if provided
    if (uploadId && !storageKey) {
      const tusSession = await tusEngine.getSession(uploadId);
      if (tusSession) {
        if (!tusSession.completed) {
          return await fail(400, `Upload session "${uploadId}" is not completed yet.`);
        }
        if (tusSession.ownerUserId && tusSession.ownerUserId !== auth.user.id) {
          return await fail(404, STORAGE_OBJECT_NOT_FOUND, 'Not Found');
        }
        storageKey = tusSession.key;
        if (!originalFilename) {
          originalFilename = tusSession.filename;
        }
        if (!fileSize) {
          fileSize = tusSession.uploadLength;
        }
      } else {
        return await fail(404, `Upload session "${uploadId}" not found or expired.`, 'Not Found');
      }
    }

    // 1b'. Refuse what could not be sealed or masked later, before any job exists or is charged.
    const limitProblems = checkSubmissionLimits({ graph, tasks });
    if (limitProblems.length > 0) {
      return await fail(
        400,
        'The graph or tasks exceed the limits for storing job credentials securely.',
        'Bad Request',
        limitProblems.map((p) => ({ name: p.name, reason: p.reason }))
      );
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
      // The job produces the final task's output, which overrides the top-level targetFormat.
      const finalOutputFormat = linearGraphOutputFormat(graphValidation);
      if (finalOutputFormat) {
        targetFormat = finalOutputFormat;
      }
    }

    // A graph that only moves files would cost nothing (policy entry 15), so it is refused before anything is reserved.
    const reservedUnits = unitsToReserve(graph);
    if (graph && reservedUnits === 0) {
      return reply(createProblemDetailsResponse(422, GRAPH_WITHOUT_CONVERSION_DETAIL, instanceUri, 'Unprocessable Entity', GRAPH_WITHOUT_CONVERSION_PROBLEM_TYPE));
    }

    if (tasks && tasks.length > 0 && !targetFormat) {
      targetFormat = (tasks[tasks.length - 1].targetFormat || '').trim();
    }

    if (graph && !targetFormat) {
      targetFormat = graphTargetFormat(graph);
    }

    if (!storageKey && graph && !inputBufferBase64 && !uploadedBuffer) {
      const graphNodes = normalizeGraphNodes(graph);
      const uploadNode = Object.values(graphNodes).find((n) => n.op === 'import.upload') as { storageKey?: string } | undefined;
      if (uploadNode?.storageKey && !isInlineInputKey(uploadNode.storageKey)) {
        storageKey = uploadNode.storageKey;
      }
    }

    if (!originalFilename && storageKey && !isInlineInputKey(storageKey)) {
      originalFilename = storageKey.split('/').pop() || 'file';
    }

    const hasImportUrl = graph && Object.values(normalizeGraphNodes(graph)).some((n) => n.op === 'import.url');

    if (!targetFormat) {
      return await fail(400, 'Missing required parameter: "targetFormat".');
    }

    if (!storageKey && !inputBufferBase64 && !uploadedBuffer && !hasImportUrl) {
      return await fail(
        400,
        'Missing input file data. Please upload a "file" or provide "uploadId" / "storageKey" / "inputBufferBase64".'
      );
    }

    // Authorize a caller-supplied key, and hold every stored file of a graph to the plan limit, before anything reads the object.
    const inputRefusal = await storedInputRefusal(storageKey, graph, auth.user);
    if (inputRefusal) return await fail(inputRefusal.status, inputRefusal.message, inputRefusal.title);

    const callerPlan = planOfCaller(auth.user);

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
      return await fail(400, `Could not identify source format for file "${originalFilename}".`);
    }

    // Fail-closed verification against spoofed file extensions using initial-byte MIME magic sniffing
    try {
      if (uploadedBuffer) {
        assertNotSpoofedFile(uploadedBuffer, sourceDef.extension, originalFilename);
      } else if (inputBufferBase64) {
        const decodedBuf = Buffer.from(inputBufferBase64, 'base64');
        assertNotSpoofedFile(decodedBuf, sourceDef.extension, originalFilename);
      } else if (storageKey) {
        const info = await s3Storage.stat(storageKey);
        if (!info) {
          return await fail(404, STORAGE_OBJECT_NOT_FOUND, 'Not Found');
        }
        if (!fileSize) {
          fileSize = info.size;
        }
        if (info.size > maxFileBytes(callerPlan)) {
          return await fail(413, fileTooLargeMessage(callerPlan, info.size), 'Payload Too Large');
        }
        if (s3Storage.kind === 'remote') {
          // The object lives in the object store: check its first bytes without downloading the rest.
          const header = await readObjectHeader(s3Storage, storageKey);
          if (!header) {
            return await fail(400, 'Stored object is unavailable.', 'Storage File Missing');
          }
          await assertNotSpoofedObject(s3Storage, storageKey, info.size, header, sourceDef.extension, originalFilename);
        } else {
          const stored = await s3Storage.getObject(storageKey);
          if (!stored) {
            return await fail(404, STORAGE_OBJECT_NOT_FOUND, 'Not Found');
          }
          if (stored.filePath) {
            if (!fs.existsSync(stored.filePath)) {
              console.error(`Storage file missing on disk: "${stored.filePath}"`);
              return await fail(400, 'Stored object is unavailable.', 'Storage File Missing');
            }
            assertNotSpoofedFilePath(stored.filePath, sourceDef.extension, originalFilename);
          } else {
            if (stored.size > 512 * 1024 * 1024) {
              return await fail(
                413,
                `Storage object size (${stored.size} bytes) exceeds in-memory buffer limit without a backing file path.`,
                'Payload Too Large'
              );
            }
            if (stored.buffer && stored.buffer.length > 0) {
              assertNotSpoofedFile(stored.buffer, sourceDef.extension, originalFilename);
            } else {
              return await fail(400, `Storage object for key "${storageKey}" contains empty or unreadable file data.`, 'Empty Storage Object');
            }
          }
        }
      }
    } catch (err: any) {
      const refusal = spoofCheckRefusal(err);
      if (refusal) return await fail(refusal.status, err.message, refusal.title);
      const storageProblem = describeStorageError(err);
      if (storageProblem) {
        return await fail(storageProblem.status, storageProblem.detail, storageProblem.title, undefined, storageProblem.headers);
      }
      console.error(`Storage file verification error: ${err instanceof Error ? err.message : String(err)}`);
      return await fail(400, 'Stored object is unavailable.', 'Storage File Missing');
    }

    // Persist multipart upload into S3 staging storage only after magic byte validation passes. A graph reads every input
    // from storage, so an inline base64 input of a graph is stored too, and its import nodes name the stored file.
    if (uploadedBuffer && fileMeta && !storageKey) {
      storageKey = await storeRequestInput(uploadedBuffer, fileMeta);
    } else if (graph && inputBufferBase64 && !storageKey) {
      const decoded = Buffer.from(inputBufferBase64, 'base64');
      storageKey = await storeRequestInput(decoded, { name: originalFilename || 'input', type: sourceDef.mimeType, size: decoded.length });
      inputBufferBase64 = undefined;
    }
    if (graph && storageKey) graph.nodes = withInlineInputStored(normalizeGraphNodes(graph), storageKey);

    // Resolve target format definition
    const cleanTarget = targetFormat.toLowerCase().replace(/^\./, '').trim();
    const targetDef = getFormatByExtension(cleanTarget);
    if (!targetDef) {
      return await fail(400, `Unsupported target format "${targetFormat}".`);
    }

    // Check format compatibility for direct single conversion (multi-stage tasks and graphs validated above)
    if (!tasks && !graph) {
      if (!sourceDef.targetFormats.includes(cleanTarget) && !sourceDef.targetFormats.includes(targetDef.id)) {
        return await fail(
          400,
          `Conversion from ${sourceDef.id.toUpperCase()} to ${targetDef.id.toUpperCase()} is not currently supported.`
        );
      }
    }

    // Fall back to API Key configured webhook URL/Secret if not overridden in request
    const effectiveWebhookUrl = webhookUrl || auth.apiKey?.webhookUrl;
    const effectiveWebhookSecret = webhookSecret || auth.apiKey?.webhookSecret;

    if (webhookUrl && !webhookSecret) {
      return await fail(400, 'webhookSecret is required when webhookUrl is provided.');
    }

    if (effectiveWebhookUrl && !effectiveWebhookSecret) {
      return await fail(400, 'webhookSecret is required when webhookUrl is provided.');
    }

    // Phase 1: Atomically reserve quota BEFORE enqueueing to BullMQ
    const unit = await reserveConversionUnit(auth.user, reservedUnits);
    if (!unit.reserved) return reply(conversionRefusalResponse(unit.refusal, instanceUri));

    const submission: ReservedSubmission = {
      user: auth.user,
      sourceDef,
      targetDef,
      originalFilename,
      fileSize,
      options,
      graph,
      tasks,
      storageKey,
      inputBufferBase64,
      webhookUrl: effectiveWebhookUrl,
      webhookSecret: effectiveWebhookSecret,
    };
    return reply(await withReservedUnit(unit.reservationId, (reserved) => queueReserved(submission, reserved)));
  } catch (error: unknown) {
    if (idempotencyCtx) {
      await idempotencyCtx.abort();
    }
    if (error instanceof SecretSealError && error.code === 'PLAINTEXT_TOO_LARGE') {
      return fail(400, 'A URL or header is too large to store securely.');
    }
    if (error instanceof SealingKeyConfigError) {
      // The detail names server configuration, so it stays in the server log.
      console.error('[Jobs] Job secret sealing is not configured:', error.message);
      return fail(
        503,
        'Job credentials cannot be stored securely right now. Try again later.',
        'Service Unavailable'
      );
    }
    if (error instanceof QueueUnavailableError) {
      // The queue could not store the job: release the quota reservation and let the client retry.
      return fail(503, QUEUE_UNAVAILABLE_DETAIL, 'Service Unavailable', undefined, queueRetryAfterHeaders());
    }
    const storageProblem = describeStorageError(error);
    if (storageProblem) {
      return fail(storageProblem.status, storageProblem.detail, storageProblem.title, undefined, storageProblem.headers);
    }
    if (error instanceof JobDeadlineError) {
      // The detail names a deadline setting, so it stays in the server log.
      console.error('[Jobs] Invalid deadline setting or input:', error);
      return fail(500, 'Internal server error', 'Internal Server Error');
    }
    const message = error instanceof Error ? error.message : 'Job enqueue failure';
    return fail(500, message, 'Internal Server Error');
  }
}));

/** Stores an input that came in the request body as an upload, and answers its key. */
async function storeRequestInput(buffer: Buffer, file: { name: string; type: string; size: number }): Promise<string> {
  const init = await s3Storage.initiateMultipartUpload(file.name, file.type, file.size);
  await s3Storage.uploadPart(init.uploadId, 1, buffer);
  return (await s3Storage.completeMultipartUpload(init.uploadId)).key;
}

/** The nodes of a graph with each import.upload node that names the request's own input (`inline`) reading `storageKey`. */
function withInlineInputStored(nodes: ReturnType<typeof normalizeGraphNodes>, storageKey: string): ReturnType<typeof normalizeGraphNodes> {
  return Object.fromEntries(
    Object.entries(nodes).map(([id, node]) => [id, node.op === 'import.upload' && isInlineInputKey(String(node.storageKey ?? '')) ? { ...node, storageKey } : node])
  );
}

/**
 * The output format of a graph that names none at the top level: the format of its last convert node, else that of its
 * first archive.create node, else none ('').
 */
function graphTargetFormat(graph: JobGraph): string {
  const nodes = Object.values(normalizeGraphNodes(graph));
  const convertNodes = nodes.filter((n) => n.op === 'convert');
  const lastConvertFormat = convertNodes[convertNodes.length - 1]?.targetFormat;
  if (lastConvertFormat) return lastConvertFormat;
  return nodes.find((n) => n.op === 'archive.create')?.targetFormat ?? '';
}

/** The graph the scheduler runs; the request's graph is the same document under the job-graph type. */
type SchedulerJobGraph = Parameters<typeof initGraphHoldingInputs>[2];

/** A validated job submission whose conversion unit is reserved. */
interface ReservedSubmission {
  user: User;
  sourceDef: FormatDefinition;
  targetDef: FormatDefinition;
  originalFilename: string;
  fileSize: number;
  options: ConversionOptions;
  graph?: JobGraph;
  tasks?: PipelineTask[];
  storageKey?: string;
  inputBufferBase64?: string;
  webhookUrl?: string;
  webhookSecret?: string;
}

/**
 * The units a submission reserves: one for a job, and for a graph what its conversions are charged by the same rule
 * (`graphReservationUnits`), so a graph is admitted only when the caller has a unit for every conversion in it; its settle
 * charges what the conversions produced and refunds the rest.
 */
function unitsToReserve(graph: JobGraph | undefined): number {
  return graph ? graphReservationUnits(normalizeGraphNodes(graph)) : 1;
}

/**
 * Queues a submission whose unit is reserved: as a graph when it has one, else as one conversion job on the queue of its
 * resource class. The graph or the job owns the unit once it is queued, and commits it or gives it back when it ends.
 */
async function queueReserved(submission: ReservedSubmission, unit: ReservedUnit): Promise<NextResponse> {
  const { user, sourceDef, targetDef, originalFilename, fileSize, options, graph, storageKey, inputBufferBase64 } = submission;
  const answered = { sourceFormat: sourceDef.id, targetFormat: targetDef.id, originalFilename };

  // A graph (including legacy linear tasks) runs only through the graph scheduler, which
  // enqueues each node; a separate conversion job would run the pipeline a second time.
  if (graph) {
    graph.nodes = normalizeGraphNodes(graph);
    const graphId = generateJobId();
    let reservationId: string | undefined;
    const graphState = await unit.handOff((id) => {
      reservationId = id;
      return initGraphHoldingInputs(graphScheduler, graphId, graph as unknown as SchedulerJobGraph, {
        ownerUserId: user.id,
        reservationId: id,
        webhookUrl: submission.webhookUrl,
        webhookSecret: submission.webhookSecret,
        originalFilename,
        sourceStorageKey: storageKey,
        sourceFormat: sourceDef.id,
        targetFormat: targetDef.id,
        tasks: submission.tasks,
      });
    });
    const nodesResponse = Object.fromEntries(
      Object.entries(graphState.nodes).map(([nid, ns]) => [nid, { status: ns.status, outputs: ns.outputs || [] }])
    );
    return NextResponse.json(
      {
        success: true,
        jobId: graphId,
        status: graphState.status,
        statusUrl: `/api/v1/jobs/${graphId}`,
        createdAt: graphState.createdAt,
        reservationId,
        ...answered,
        graph: redactForOutput(graphState.graph),
        nodes: nodesResponse,
      },
      { status: 202 }
    );
  }

  // Resolve resource class and scheduling priority
  const resClass = resolveResourceClass(sourceDef.id, targetDef.id, fileSize, options);
  const inputBytes = await trustedInputBytes({ storageKey, inputBufferBase64 }, s3Storage);
  let reservationId: string | undefined;
  // Enqueue conversion job to the appropriate resource-class queue
  const job = await unit.handOff((id) => {
    reservationId = id;
    return enqueueConversionJob(
      getQueueForResourceClass(resClass),
      'convert',
      {
        jobId: '',
        originalFilename,
        sourceFormat: sourceDef.id,
        targetFormat: targetDef.id,
        fileSize,
        storageKey,
        inputBufferBase64,
        options: stripEngineControls(options),
        webhookUrl: submission.webhookUrl,
        webhookSecret: submission.webhookSecret,
        userId: user.id,
        reservationId: id,
        resourceClass: resClass,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        priority: tierToPriority(user.tier),
      },
      { tier: user.tier, inputBytes }
    );
  });

  return NextResponse.json(
    {
      success: true,
      jobId: job.id,
      status: job.state,
      statusUrl: `/api/v1/jobs/${job.id}`,
      createdAt: job.timestamp,
      reservationId,
      ...answered,
    },
    { status: 202 }
  );
}

export async function GET(req: NextRequest) {
  return withQueueErrors(req.nextUrl?.pathname || '/api/v1/jobs', () => listJobs(req));
}

async function listJobs(req: NextRequest) {
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
      failedReason: j.failedReason === undefined ? undefined : redactText(j.failedReason),
      failedCode: j.failedCode,
      failedStatus: j.failedStatus,
      result: j.returnvalue,
    })),
  });
}

