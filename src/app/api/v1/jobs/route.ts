import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { validateApiAccess, authErrorHeaders, conversionsUsedUp, reserveConversionUnit, withReservedUnit } from '@/lib/api-keys/guard';
import type { ReservedUnit } from '@/lib/api-keys/hand-off';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import type { User } from '@/lib/auth/types';
import type { FormatDefinition } from '@/lib/types';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { mayUseStorageKeyAsJobInput, STORAGE_OBJECT_NOT_FOUND } from '@/lib/api-keys/owner-access';
import { graphInputKeys, withGraphInputsHeld } from '@/lib/queue/graph/input-cleanup';
import { conversionQueue, getQueueForResourceClass } from '@/lib/queue/conversion-queue';
import { handOffConversionJob, trustedInputBytes } from '@/lib/queue/enqueue';
import { stripEngineControls } from '@/lib/conversions/job-time';
import { JobDeadlineError } from '@/lib/queue/job-deadline';
import { concurrencyLimitResponse, mayEnqueue } from '@/lib/queue/concurrency-limit';
import { resolveResourceClass, tierToPriority } from '@/lib/queue/resource-class';
import { generateJobId } from '@/lib/queue/bullmq-engine';
import { storageProvider as s3Storage } from '@/lib/storage';
import { readObjectHeader } from '@/lib/storage/object-header';
import { detectFormatFromFilename, getFormatByExtension } from '@/lib/registry';
import { assertNotSpoofedFile, assertNotSpoofedFilePath, assertNotSpoofedObject, spoofCheckRefusal } from '@/lib/security/file-guard';
import { resolveEffectiveWebhook } from '@/lib/security/ssrf';
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
import { sealGraph } from '@/lib/queue/graph/node-jobs';
import { redactForOutput, redactText } from '@/lib/security/redact';
import { SealingKeyConfigError, SecretSealError } from '@/lib/security/job-secret-seal';
import { checkSubmissionLimits } from '@/lib/jobs/submission-limits';
import { validatePageRangeSyntax } from '@/lib/conversions';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { INLINE_JOB_PAYLOAD_MAX_BYTES, fileTooLargeMessage, maxFileBytes, planOfCaller, type Plan, type PlanCaller } from '@/lib/plan-limits';
import { withinSingleRequest } from '@/lib/api/file-size-limit';
import { graphJobState, graphProcessedOn, listVisibleWork } from '@/lib/queue/user-jobs';
import { graphProgress } from '@/lib/queue/graph/graph-progress';
import { describeStorageError } from '@/lib/api/storage-error-response';
import { QUEUE_UNAVAILABLE_DETAIL, queueRetryAfterHeaders, withQueueErrors } from '@/lib/api/queue-error-response';
import {
  validateOrProblem,
  JobCreateRequestSchema,
  ConversionOptionsSchema,
  PipelineTaskSchema,
  JobGraphSchema,
} from '@/lib/api/contracts';
import { acquireIdempotency, IdempotencyContext, releaseKey, replyUnderKey } from '@/lib/api/with-idempotency';
import { readMultipartForm } from '@/lib/api/multipart-body';
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

interface StoredInputCheck {
  key: string;
  ext: string;
  filename: string;
  /** True for the request's own storage key, whose size fills in a missing file size. */
  primary: boolean;
}

/** Every distinct stored object a job reads as an upload (its own key and the `import.upload` nodes of its graph), each with the format its own name declares. */
function collectStoredInputChecks(input: {
  storageKey: string | undefined;
  graph: JobGraph | undefined;
  sourceDef: { extension: string };
  originalFilename: string;
  hasInlineBytes: boolean;
}): StoredInputCheck[] {
  const checks: StoredInputCheck[] = [];
  const seen = new Set<string>();
  const push = (key: string, ext: string, filename: string, primary: boolean) => {
    const dedupeKey = `${key}\0${ext}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    checks.push({ key, ext, filename, primary });
  };

  if (input.storageKey && !isInlineInputKey(input.storageKey) && !input.hasInlineBytes) {
    push(input.storageKey, input.sourceDef.extension, input.originalFilename, true);
  }
  if (input.graph) {
    for (const node of Object.values(normalizeGraphNodes(input.graph))) {
      if (node.op !== 'import.upload') continue;
      const nodeKey = typeof node.storageKey === 'string' ? node.storageKey.trim() : '';
      if (!nodeKey || isInlineInputKey(nodeKey)) continue;
      const nodeFilename = path.basename(nodeKey) || input.originalFilename;
      const nodeDef = detectFormatFromFilename(nodeFilename) ?? input.sourceDef;
      push(nodeKey, nodeDef.extension, nodeFilename, false);
    }
  }
  return checks;
}

type StoredInputVerdict = { size: number } | { refusal: { status: number; message: string; title: string } };

/** Checks that a stored upload exists, fits the plan, and starts with the bytes its extension declares. A spoofed file throws. */
async function verifyStoredInput(check: StoredInputCheck, plan: ReturnType<typeof planOfCaller>): Promise<StoredInputVerdict> {
  const refuse = (status: number, message: string, title: string): StoredInputVerdict => ({ refusal: { status, message, title } });
  const info = await s3Storage.stat(check.key);
  if (!info) return refuse(404, STORAGE_OBJECT_NOT_FOUND, 'Not Found');
  if (info.size > maxFileBytes(plan)) return refuse(413, fileTooLargeMessage(plan, info.size), 'Payload Too Large');
  if (s3Storage.kind === 'remote') {
    // The object lives in the object store: check its first bytes without downloading the rest.
    const header = await readObjectHeader(s3Storage, check.key);
    if (!header) return refuse(400, 'Stored object is unavailable.', 'Storage File Missing');
    await assertNotSpoofedObject(s3Storage, check.key, info.size, header, check.ext, check.filename);
    return { size: info.size };
  }
  const stored = await s3Storage.getObject(check.key);
  if (!stored) return refuse(404, STORAGE_OBJECT_NOT_FOUND, 'Not Found');
  if (stored.filePath) {
    if (!fs.existsSync(stored.filePath)) {
      console.error(`Storage file missing on disk: "${stored.filePath}"`);
      return refuse(400, 'Stored object is unavailable.', 'Storage File Missing');
    }
    assertNotSpoofedFilePath(stored.filePath, check.ext, check.filename);
    return { size: info.size };
  }
  if (stored.size > 512 * 1024 * 1024) {
    return refuse(413, `Storage object size (${stored.size} bytes) exceeds in-memory buffer limit without a backing file path.`, 'Payload Too Large');
  }
  if (!stored.buffer || stored.buffer.length === 0) {
    return refuse(400, `Storage object for key "${check.key}" contains empty or unreadable file data.`, 'Empty Storage Object');
  }
  assertNotSpoofedFile(stored.buffer, check.ext, check.filename);
  return { size: info.size };
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

  // Only a success is kept under the key, and the answer stands whatever the idempotency store does: a store failure after
  // a conversion was charged must not turn its success into an error the client would retry, and pay for again.
  const reply = (res: NextResponse | Response) => replyUnderKey(idempotencyCtx, res, instanceUri);

  const quota = await redisKeyStore.getQuotaUsage(auth.user.id);
  if (quota.remaining <= 0) return reply(conversionRefusalResponse(conversionsUsedUp(auth.user, quota, 1), instanceUri));

  const fail = async (
    status: number,
    message: string,
    title: string = 'Bad Request',
    invalidParams?: Array<{ name: string; reason: string }>,
    headers?: Record<string, string>,
    extensions?: Record<string, unknown>
  ) => reply(createProblemDetailsResponse(status, message, instanceUri, title, undefined, headers, invalidParams, extensions));

  try {
    // At most five conversions in flight (queued plus running) for an anonymous or free caller. A refusal is not
    // stored as the answer of the idempotency key: the same request may succeed once a job has finished.
    const room = await mayEnqueue(auth.user.id, auth.user.tier);
    if (!room.allowed) {
      await releaseKey(idempotencyCtx, instanceUri);
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
      const parsedMultipart = await readMultipartForm(req);
      if (parsedMultipart.malformed) {
        return await fail(400, 'Invalid or malformed multipart/form-data body.');
      }
      const formData = parsedMultipart.form;
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

    const resolvedWebhook = resolveEffectiveWebhook(webhookUrl, webhookSecret, auth.apiKey?.webhookUrl, auth.apiKey?.webhookSecret, auth.apiKey?.id);
    if (resolvedWebhook.error) return await fail(400, resolvedWebhook.error);
    const { webhookUrl: effectiveWebhookUrl, webhookSecret: effectiveWebhookSecret, webhookKeyId } = resolvedWebhook;

    // Normalize page / pages option and validate the page range syntax
    if (options) {
      if (!options.pages && options.page) {
        options.pages = String(options.page);
      }
      if (options.pages) {
        try {
          validatePageRangeSyntax(options.pages);
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
              validatePageRangeSyntax(t.options.pages);
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
      targetFormat = graphTargetFormat(graph, sourceFormatParam, originalFilename);
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
      }
      if (inputBufferBase64) {
        const decodedBuf = Buffer.from(inputBufferBase64, 'base64');
        assertNotSpoofedFile(decodedBuf, sourceDef.extension, originalFilename);
      }

      const storedChecks = collectStoredInputChecks({
        storageKey,
        graph,
        sourceDef,
        originalFilename,
        hasInlineBytes: Boolean(uploadedBuffer || inputBufferBase64),
      });

      for (const check of storedChecks) {
        const result = await verifyStoredInput(check, callerPlan);
        if ('refusal' in result) {
          return await fail(result.refusal.status, result.refusal.message, result.refusal.title);
        }
        if (check.primary && !fileSize) {
          fileSize = result.size;
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
      input: { storageKey, uploadedBuffer, fileMeta, inputBufferBase64 },
      webhookUrl: effectiveWebhookUrl,
      webhookSecret: effectiveWebhookSecret,
      webhookKeyId,
    };
    return reply(await withReservedUnit(unit.reservationId, (reserved) => queueReserved(submission, reserved)));
  } catch (error: unknown) {
    await releaseKey(idempotencyCtx, instanceUri);
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

/** The input of a submission as the request gave it: a key it named, a multipart file, or base64 in the body. */
interface SubmittedInput {
  storageKey: string | undefined;
  uploadedBuffer: Buffer | null;
  fileMeta: { name: string; type: string; size: number } | null;
  inputBufferBase64: string | undefined;
}

/**
 * The input a job or graph reads: a key it named, or the input sent in the request body, stored. A multipart file is always
 * stored; an inline base64 input is stored only for a graph, which reads every input from storage, and a single job keeps it
 * in its data. Only a submission that passed every check and holds its units gets here, so a refused request stores nothing.
 */
async function storedRequestInput(
  input: SubmittedInput,
  graph: JobGraph | undefined,
  file: { filename: string; mimeType: string }
): Promise<{ storageKey?: string; inputBufferBase64?: string }> {
  const { storageKey, uploadedBuffer, fileMeta, inputBufferBase64 } = input;
  if (storageKey) return { storageKey, inputBufferBase64 };
  if (uploadedBuffer && fileMeta) return { storageKey: await storeRequestInput(uploadedBuffer, fileMeta), inputBufferBase64 };
  if (!graph || !inputBufferBase64) return { inputBufferBase64 };
  const decoded = Buffer.from(inputBufferBase64, 'base64');
  return { storageKey: await storeRequestInput(decoded, { name: file.filename || 'input', type: file.mimeType, size: decoded.length }) };
}

/** The nodes of a graph with each import.upload node that names the request's own input (`inline`) reading `storageKey`. */
function withInlineInputStored(nodes: ReturnType<typeof normalizeGraphNodes>, storageKey: string): ReturnType<typeof normalizeGraphNodes> {
  return Object.fromEntries(
    Object.entries(nodes).map(([id, node]) => [id, node.op === 'import.upload' && isInlineInputKey(String(node.storageKey ?? '')) ? { ...node, storageKey } : node])
  );
}

const PDF_GRAPH_NODE_OPS = new Set([
  'ocr',
  'pdf.watermark',
  'pdf.protect',
  'pdf.unlock',
  'pdf.extract-pages',
  'pdf.delete-pages',
  'pdf.reorder-pages',
  'pdf.rotate-pages',
]);

function resolveGraphFallbackFormat(
  nodes: ReturnType<typeof normalizeGraphNodes>[string][],
  sourceFormat?: string,
  filename = ''
): string {
  if (sourceFormat) return sourceFormat;
  const fromName = detectFormatFromFilename(filename)?.id;
  if (fromName) return fromName;
  for (const node of nodes) {
    if (node.op === 'import.upload' && typeof node.storageKey === 'string') {
      const detected = detectFormatFromFilename(node.storageKey)?.id;
      if (detected) return detected;
    } else if (node.op === 'import.url' && typeof node.url === 'string') {
      try {
        const detected = detectFormatFromFilename(new URL(node.url).pathname)?.id;
        if (detected) return detected;
      } catch {
        // ignore invalid url
      }
    }
  }
  return '';
}

function fixedNodeTargetFormat(nodes: ReturnType<typeof normalizeGraphNodes>[string][]): string {
  const convertNodes = nodes.filter((n) => n.op === 'convert');
  const lastConvert = convertNodes[convertNodes.length - 1]?.targetFormat;
  if (lastConvert) return lastConvert;
  const direct = nodes.find((n) => n.op === 'archive.create' || n.op === 'merge')?.targetFormat;
  if (direct) return direct;
  const thumb = nodes.find((n) => n.op === 'thumbnail');
  if (thumb) return thumb.targetFormat ?? thumb.options?.thumbnail?.format ?? 'jpg';
  if (nodes.some((n) => n.op === 'pdf.split-pages' || n.op === 'media.package')) return 'zip';
  if (nodes.some((n) => PDF_GRAPH_NODE_OPS.has(n.op))) return 'pdf';
  return '';
}

/**
 * The output format of a graph that names none at the top level: the format of its last convert node, else that of its
 * archive.create, merge, thumbnail, PDF/packaging, optimize/watermark, or archive.extract node, else none ('').
 */
function graphTargetFormat(graph: JobGraph, fallbackFormat?: string, filename = ''): string {
  const nodes = Object.values(normalizeGraphNodes(graph));
  const fixed = fixedNodeTargetFormat(nodes);
  if (fixed) return fixed;
  const fallback = resolveGraphFallbackFormat(nodes, fallbackFormat, filename);
  if (nodes.some((n) => n.op === 'optimize' || n.op === 'watermark')) return fallback;
  if (nodes.some((n) => n.op === 'archive.extract')) return fallback || 'zip';
  return '';
}

/** The graph the scheduler runs; the request's graph is the same document under the job-graph type. */
type SchedulerJobGraph = Parameters<typeof sealGraph>[1];

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
  input: SubmittedInput;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookKeyId?: string;
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
  const { user, sourceDef, targetDef, originalFilename, fileSize, options, graph } = submission;
  const answered = { sourceFormat: sourceDef.id, targetFormat: targetDef.id, originalFilename };
  const { storageKey, inputBufferBase64 } = await storedRequestInput(submission.input, graph, { filename: originalFilename, mimeType: sourceDef.mimeType });

  // A graph (including legacy linear tasks) runs only through the graph scheduler, which
  // enqueues each node; a separate conversion job would run the pipeline a second time.
  if (graph) {
    graph.nodes = storageKey ? withInlineInputStored(normalizeGraphNodes(graph), storageKey) : normalizeGraphNodes(graph);
    const graphId = generateJobId();
    // Sealed before the hand-off, so a secret that cannot be sealed gives the unit back at once.
    const sealedGraph = sealGraph(graphId, graph as unknown as SchedulerJobGraph);
    const graphState = await withGraphInputsHeld(graphId, graph.nodes, () =>
      unit.handOff({
        start: (reservationId) =>
          graphScheduler.initGraph(graphId, sealedGraph, {
            ownerUserId: user.id,
            reservationId,
            webhookUrl: submission.webhookUrl,
            webhookSecret: submission.webhookSecret,
            webhookKeyId: submission.webhookKeyId,
            originalFilename,
            sourceStorageKey: storageKey,
            sourceFormat: sourceDef.id,
            targetFormat: targetDef.id,
            tasks: submission.tasks,
          }),
        recover: () => graphScheduler.recoverStart(graphId),
      })
    );
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
        reservationId: graphState.reservationId,
        ...answered,
        graph: redactForOutput(graphState.graph),
        nodes: nodesResponse,
      },
      { status: 202 }
    );
  }

  // Resolve resource class and scheduling priority from the size of the input as the server knows it: the `fileSize` of a JSON body is
  // the client's own figure (absent, or any number), and only stands in when the input cannot be sized.
  const inputBytes = await trustedInputBytes({ storageKey, inputBufferBase64 }, s3Storage);
  const routedBytes = inputBytes ?? fileSize;
  const resClass = resolveResourceClass(sourceDef.id, targetDef.id, routedBytes, options);
  // Enqueue conversion job to the appropriate resource-class queue
  const job = await handOffConversionJob(
    unit,
    getQueueForResourceClass(resClass),
    {
      jobId: '',
      originalFilename,
      sourceFormat: sourceDef.id,
      targetFormat: targetDef.id,
      fileSize: routedBytes,
      storageKey,
      inputBufferBase64,
      options: stripEngineControls(options),
      webhookUrl: submission.webhookUrl,
      webhookSecret: submission.webhookSecret,
      webhookKeyId: submission.webhookKeyId,
      userId: user.id,
      resourceClass: resClass,
    },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      priority: tierToPriority(user.tier),
    },
    { tier: user.tier, inputBytes }
  );

  return NextResponse.json(
    {
      success: true,
      jobId: job.id,
      status: job.state,
      statusUrl: `/api/v1/jobs/${job.id}`,
      createdAt: job.timestamp,
      reservationId: job.data.reservationId,
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

  // Query indexed jobs and graphs strictly belonging to the authenticated user (Tenant Boundary Isolation)
  const userWork = await listVisibleWork(auth.user.id, requestedStates.length > 0 ? requestedStates : validStates, limit);

  return NextResponse.json({
    success: true,
    total: userWork.length,
    jobs: userWork.map((work) => {
      if (work.kind === 'graph') {
        const g = work.graph;
        return {
          jobId: g.graphId,
          status: graphJobState(g.status),
          progress: graphProgress(g),
          sourceFormat: g.sourceFormat,
          targetFormat: g.targetFormat,
          originalFilename: g.originalFilename,
          createdAt: g.createdAt,
          processedOn: graphProcessedOn(g),
          finishedOn: g.finishedAt,
          failedReason: g.failedReason === undefined ? undefined : redactText(g.failedReason),
        };
      }
      const j = work.job;
      return {
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
      };
    }),
  });
}

