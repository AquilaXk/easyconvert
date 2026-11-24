import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { validateApiAccess, authErrorHeaders, reserveConversionUnit, withReservedUnit } from '@/lib/api-keys/guard';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import { fileSizeLimitProblem, withinSingleRequest } from '@/lib/api/file-size-limit';
import { payloadLimitStatus } from '@/lib/api/payload-limit';
import { deadlineErrorResponse } from '@/lib/api/sync-deadline';
import { readBoundedJsonText } from '@/lib/api/json-body-bounds';
import { SMALL_REQUEST_BODY_MAX_BYTES } from '@/lib/api/request-body-limit';
import { isMultipartBody, readMultipartForm, releaseMultipartForm, formText } from '@/lib/api/multipart-body';
import { codedRefusal, createProblemDetailsResponse } from '@/lib/api/problem-details';
import { refusalCodeOf } from '@/lib/refusal-codes';
import { STORAGE_OBJECT_NOT_FOUND, mayUseStorageKeyAsJobInput } from '@/lib/api-keys/owner-access';
import type { User } from '@/lib/auth/types';
import { storageProvider as s3Storage } from '@/lib/storage';
import { isUploadKey, resultKey, stagedInputKey } from '@/lib/storage/key-namespace';
import { JobCancelledError } from '@/lib/queue/bullmq-engine';
import { JobTimeoutError, QueueUnavailableError } from '@/lib/types';
import { sanitizeNodeOutputFilename } from '@/lib/queue/graph/node-jobs';
import { getQueueForResourceClass } from '@/lib/queue/conversion-queue';
import { handOffConversionJob } from '@/lib/queue/enqueue';
import { resolveResourceClass, tierToPriority } from '@/lib/queue/resource-class';
import { webToolResourceFormat } from '@/lib/queue/wait-for-job';
import { concurrencyLimitResponse, mayEnqueue, acquireSyncSlot } from '@/lib/queue/concurrency-limit';
import { conversionDeadlineMs } from '@/lib/queue/job-deadline';
import { readObjectHeader } from '@/lib/storage/object-header';
import { assertNotSpoofedObject } from '@/lib/security/file-guard';
import { hasLiveQueueWorker, isQueueOnlyWebMode } from '@/lib/queue/worker-presence';
import { typedFailureProblem } from '@/lib/api/typed-failure-response';
import { MAX_TOOL_FILES, WEB_TOOLS, type WebTool } from '@/lib/tools/tool-names';
import { loadQueuedToolFiles } from '@/lib/tools/queued-tool-runner';
import {
  attachToolJobInputs,
  cancelToolJob,
  completeToolJob,
  deleteToolJob,
  failToolJob,
  getToolJob,
  registerLocalToolAbort,
  registerLocalToolRun,
  saveToolJob,
  startToolJob,
  toolResultStorageKeys,
  unregisterLocalToolAbort,
  type StoredToolJobResult,
  type ToolJobState,
} from '@/lib/tools/tool-job-store';
import {
  assertToolInput,
  assertToolUploadMetadata,
  expectedToolInputExtension,
  parseToolOptions,
  runWebTool,
  WebToolRefusal,
  type WebToolFile,
  type WebToolOutput,
  type WebToolOptions,
} from '@/lib/tools/web-tools';
import { eraseOwnedFile, saveRetainedResult } from '@/lib/storage/retention-service';

export const dynamic = 'force-dynamic';

interface StoredInputFileRef {
  key: string;
  name: string;
}

interface ParsedToolJobInputs {
  toolName: WebTool;
  rawOptions: string | undefined;
  totalBytes: number;
  inlineFiles?: WebToolFile[];
  storedRefs?: StoredInputFileRef[];
}

async function storeToolOutput(output: WebToolOutput, caller: User): Promise<StoredToolJobResult> {
  if (output.kind === 'file') {
    const safeName = sanitizeNodeOutputFilename(output.filename, 'output.bin');
    const storageKey = resultKey(caller.id, `${crypto.randomUUID()}_${safeName}`);
    await saveRetainedResult(s3Storage, storageKey, output.buffer, output.mimeType, safeName);
    return {
      kind: 'file',
      file: {
        name: output.filename,
        size: output.buffer.length,
        key: storageKey,
        url: `/api/storage/file/${encodeURIComponent(storageKey)}`,
      },
    };
  }
  const entries = await Promise.all(
    output.entries.map(async (entry, index) => {
      const safeName = sanitizeNodeOutputFilename(entry.name, `file_${index + 1}`);
      const storageKey = resultKey(caller.id, `${crypto.randomUUID()}_${safeName}`);
      await saveRetainedResult(s3Storage, storageKey, entry.buffer, entry.mimeType, safeName);
      return {
        name: entry.name,
        size: entry.size,
        mimeType: entry.mimeType,
        key: storageKey,
        url: `/api/storage/file/${encodeURIComponent(storageKey)}`,
      };
    })
  );
  return { kind: 'entries', entries };
}

async function parseMultipartJobInputs(
  req: NextRequest,
  caller: User,
  instanceUri: string
): Promise<ParsedToolJobInputs | NextResponse> {
  const body = await readMultipartForm(req);
  if (body.malformed) return codedRefusal(400, 'multipart_required', 'Invalid multipart request.');

  const rawTool = formText(body.form, 'tool') || 'merge';
  const toolName = rawTool as WebTool;
  if (!WEB_TOOLS.includes(toolName)) {
    return codedRefusal(400, 'unsupported_tool', `Unsupported tool: "${rawTool}".`);
  }

  const uploads = body.form.getAll('files').filter((entry): entry is File => entry instanceof Blob);
  if (uploads.length === 0) {
    return codedRefusal(400, 'file_required', 'Missing required "files" in multipart request.');
  }
  for (const upload of uploads) {
    const oversize = fileSizeLimitProblem(caller, upload.size, instanceUri);
    if (oversize) return oversize;
  }
  assertToolUploadMetadata(toolName, uploads);

  const inlineFiles: WebToolFile[] = await Promise.all(
    uploads.map(async (file) => ({ name: file.name, buffer: Buffer.from(await file.arrayBuffer()) }))
  );
  assertToolInput(toolName, inlineFiles);
  const totalBytes = inlineFiles.reduce((sum, file) => sum + file.buffer.length, 0);
  return { toolName, rawOptions: formText(body.form, 'options'), totalBytes, inlineFiles };
}

function serializeRawOptions(options: unknown): string | undefined {
  if (options === undefined) return undefined;
  if (typeof options === 'string') return options;
  return JSON.stringify(options);
}

async function parseJsonJobInputs(
  req: NextRequest,
  caller: User,
  instanceUri: string
): Promise<ParsedToolJobInputs | NextResponse> {
  let payload: Record<string, unknown>;
  const read = await readBoundedJsonText(req, SMALL_REQUEST_BODY_MAX_BYTES, instanceUri);
  if ('refusal' in read) return read.refusal;
  try {
    const parsed = JSON.parse(read.text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return codedRefusal(400, 'invalid_json', 'Expected a JSON object.');
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return codedRefusal(400, 'invalid_json', 'Invalid JSON request body.');
  }

  const rawTool = typeof payload.tool === 'string' && payload.tool ? payload.tool : 'merge';
  const toolName = rawTool as WebTool;
  if (!WEB_TOOLS.includes(toolName)) {
    return codedRefusal(400, 'unsupported_tool', `Unsupported tool: "${rawTool}".`);
  }

  if (!Array.isArray(payload.files) || payload.files.length === 0) {
    return codedRefusal(400, 'file_required', 'Missing required "files" array.');
  }
  if (payload.files.length > MAX_TOOL_FILES) {
    return codedRefusal(400, 'too_many_files', `At most ${MAX_TOOL_FILES} files may be submitted.`);
  }

  const storedRefs: StoredInputFileRef[] = [];
  const metadataCheck: Array<{ name: string; size: number }> = [];
  for (const rawItem of payload.files) {
    if (!rawItem || typeof rawItem !== 'object') {
      return codedRefusal(400, 'file_required', 'Each entry in "files" must include "key" and "name".');
    }
    const { key, name } = rawItem as { key?: unknown; name?: unknown };
    if (typeof key !== 'string' || !key.trim() || typeof name !== 'string' || !name.trim()) {
      return codedRefusal(400, 'file_required', 'Each entry in "files" must include non-empty "key" and "name".');
    }
    if (!(await mayUseStorageKeyAsJobInput(key, caller.id))) {
      return createProblemDetailsResponse(404, STORAGE_OBJECT_NOT_FOUND, instanceUri);
    }
    const stat = await s3Storage.stat(key);
    if (!stat) {
      return createProblemDetailsResponse(404, STORAGE_OBJECT_NOT_FOUND, instanceUri);
    }
    const oversize = fileSizeLimitProblem(caller, stat.size, instanceUri);
    if (oversize) return oversize;
    storedRefs.push({ key, name });
    metadataCheck.push({ name, size: stat.size });
  }
  assertToolUploadMetadata(toolName, metadataCheck);
  for (let i = 0; i < storedRefs.length; i += 1) {
    const item = metadataCheck[i];
    const ext = expectedToolInputExtension(toolName, item.name);
    if (ext === undefined) continue;
    const ref = storedRefs[i];
    const header = await readObjectHeader(s3Storage, ref.key);
    if (!header || header.length === 0) {
      return codedRefusal(400, 'empty_file', `The file "${item.name}" is empty.`);
    }
    try {
      await assertNotSpoofedObject(s3Storage, ref.key, item.size, header, ext, item.name);
    } catch (error) {
      throw new WebToolRefusal(400, 'spoofed_file', error instanceof Error ? error.message : 'The file does not match its extension.');
    }
  }
  const totalBytes = metadataCheck.reduce((sum, item) => sum + item.size, 0);
  return { toolName, rawOptions: serializeRawOptions(payload.options), totalBytes, storedRefs };
}

async function cleanupTemporaryUploads(refs: readonly StoredInputFileRef[] | undefined): Promise<void> {
  if (!refs) return;
  await Promise.all(
    refs
      .filter((ref) => isUploadKey(ref.key))
      .map((ref) => Promise.resolve().then(() => s3Storage.deleteObject(ref.key)).catch(() => undefined))
  );
}

interface QueuedToolDispatchInput {
  caller: User;
  jobId: string;
  initialState: ToolJobState;
  parsed: ParsedToolJobInputs;
  options: WebToolOptions;
  reservationId: string | undefined;
  queueOnly: boolean;
  liveWorker: boolean;
  instanceUri: string;
}

async function dispatchQueuedToolJob(input: QueuedToolDispatchInput): Promise<NextResponse> {
  const { caller, jobId, initialState, parsed, options, reservationId, queueOnly, liveWorker, instanceUri } = input;
  const stagedInlineKeys: string[] = [];
  try {
    await withReservedUnit(reservationId, async (reserved) => {
      if (queueOnly && !liveWorker) {
        throw new QueueUnavailableError('worker-pool', 'No live conversion worker is available to process queued tool jobs.');
      }

      const storedRefs: StoredInputFileRef[] = parsed.storedRefs
        ? [...parsed.storedRefs]
        : await Promise.all(
            (parsed.inlineFiles ?? []).map(async (file, index) => {
              const safeName = sanitizeNodeOutputFilename(file.name, `input_${index + 1}.bin`);
              const key = stagedInputKey(caller.id, `tool_${jobId}_${index}_${safeName}`);
              await s3Storage.saveObject(key, file.buffer, 'application/octet-stream', safeName);
              stagedInlineKeys.push(key);
              return { key, name: file.name };
            })
          );

      if (stagedInlineKeys.length > 0 || (parsed.storedRefs && parsed.storedRefs.length > 0)) {
        const updated = await attachToolJobInputs(jobId, storedRefs.map((ref) => ref.key));
        if (!updated) {
          throw new JobCancelledError('Tool job was cancelled or deleted before enqueue.');
        }
      }

      const cleanupKeys = [
        ...stagedInlineKeys,
        ...(parsed.storedRefs ?? []).map((ref) => ref.key).filter((key) => isUploadKey(key)),
      ];
      const totalBytes = parsed.totalBytes;
      const sourceFormat = webToolResourceFormat(parsed.toolName);
      const resClass = resolveResourceClass(sourceFormat, sourceFormat, totalBytes, {});
      const targetQueue = getQueueForResourceClass(resClass);

      await handOffConversionJob(
        reserved,
        targetQueue,
        {
          jobId,
          originalFilename: parsed.toolName,
          sourceFormat,
          targetFormat: sourceFormat,
          fileSize: totalBytes,
          options: {},
          userId: caller.id,
          resourceClass: resClass,
          toolJob: {
            tool: parsed.toolName,
            options: (options ?? {}) as Record<string, unknown>,
            storedRefs,
            cleanupUploadKeys: cleanupKeys,
          },
        },
        { jobId, priority: tierToPriority(caller.tier) },
        { tier: caller.tier, inputBytes: totalBytes }
      );
    });

    return NextResponse.json({ success: true, id: jobId, status: 'queued' }, { status: 201 });
  } catch (err: unknown) {
    await Promise.all(stagedInlineKeys.map((key) => Promise.resolve().then(() => s3Storage.deleteObject(key)).catch(() => undefined)));
    if (!(err instanceof JobCancelledError)) {
      await deleteToolJob(jobId).catch(() => undefined);
    }
    return typedFailureProblem(err, instanceUri);
  }
}

interface LocalToolRunInput {
  caller: User;
  jobId: string;
  initialState: ToolJobState;
  parsed: ParsedToolJobInputs;
  options: WebToolOptions;
  reservationId: string | undefined;
  releaseSlot: () => void;
}

async function discardToolOutputs(result: StoredToolJobResult): Promise<void> {
  await Promise.all(
    toolResultStorageKeys(result).map((key) => eraseOwnedFile(s3Storage, key).catch(() => undefined))
  );
}

function launchLocalToolJob(input: LocalToolRunInput): void {
  const { caller, jobId, initialState, parsed, options, reservationId, releaseSlot } = input;
  const abortController = registerLocalToolAbort(jobId, caller.id);
  const runPromise = withReservedUnit(reservationId, async (reserved) => {
    let deadlineTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      if (abortController.signal.aborted) {
        await cancelToolJob(jobId).catch(() => undefined);
        await cleanupTemporaryUploads(parsed.storedRefs);
        return;
      }
      if (!(await startToolJob(jobId, 25))) {
        await cleanupTemporaryUploads(parsed.storedRefs);
        return;
      }
      let output: WebToolOutput;
      try {
        const files: WebToolFile[] = parsed.inlineFiles
          ? parsed.inlineFiles
          : await loadQueuedToolFiles(s3Storage, parsed.storedRefs ?? []);
        if (!parsed.inlineFiles) assertToolInput(parsed.toolName, files);
        const totalBytes = files.reduce((sum, file) => sum + file.buffer.length, 0);
        const sourceFormat = webToolResourceFormat(parsed.toolName);
        const deadlineMs = conversionDeadlineMs({ tier: caller.tier, sourceFormat, targetFormat: sourceFormat, inputBytes: totalBytes });
        deadlineTimer = setTimeout(() => {
          timedOut = true;
          abortController.abort(new JobTimeoutError(deadlineMs));
        }, deadlineMs);
        deadlineTimer.unref();
        output = await runWebTool(parsed.toolName, files, options, abortController.signal);
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
      const afterRun = await getToolJob(jobId);
      if (!afterRun || afterRun.status === 'cancelled' || (abortController.signal.aborted && !timedOut)) {
        await cleanupTemporaryUploads(parsed.storedRefs);
        return;
      }
      const storedResult = await storeToolOutput(output, caller);
      const saved =
        !(abortController.signal.aborted && !timedOut) && (await completeToolJob(jobId, storedResult));
      if (!saved) {
        await discardToolOutputs(storedResult);
        await cleanupTemporaryUploads(parsed.storedRefs);
        return;
      }
      await cleanupTemporaryUploads(parsed.storedRefs);
      await reserved.commit({ from: parsed.toolName, base: 1, processingMs: Date.now() - initialState.createdAt });
    } catch (err: unknown) {
      await cleanupTemporaryUploads(parsed.storedRefs);
      if (!timedOut && abortController.signal.aborted) {
        await cancelToolJob(jobId).catch(() => undefined);
        return;
      }
      await failToolJob(jobId, err instanceof Error ? err.message : String(err)).catch(() => undefined);
    } finally {
      unregisterLocalToolAbort(jobId);
      releaseSlot();
    }
  });
  registerLocalToolRun(jobId, caller.id, runPromise);
}

function toolJobInputErrorResponse(err: unknown, instanceUri: string): NextResponse {
  if (err instanceof WebToolRefusal) {
    return codedRefusal(err.status, err.code, err.message);
  }
  const deadlineProblem = deadlineErrorResponse(err, instanceUri);
  if (deadlineProblem) return deadlineProblem;
  const limitStatus = payloadLimitStatus(err);
  if (limitStatus !== null) {
    return createProblemDetailsResponse(limitStatus, err instanceof Error ? err.message : String(err), instanceUri, undefined, undefined, undefined, undefined, {
      code: refusalCodeOf(err),
    });
  }
  throw err;
}

export const POST = withinSingleRequest(admittingNewFiles(async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/tools/jobs';
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write', allowAnonymous: true });
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
  const caller = auth.user;
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!isMultipartBody(req) && !contentType.includes('application/json')) {
    return codedRefusal(415, 'unsupported_media_type', 'Expected application/json or multipart/form-data.');
  }

  try {
    let parsed: ParsedToolJobInputs | NextResponse;
    try {
      parsed = isMultipartBody(req)
        ? await parseMultipartJobInputs(req, caller, instanceUri)
        : await parseJsonJobInputs(req, caller, instanceUri);
    } catch (err: unknown) {
      return toolJobInputErrorResponse(err, instanceUri);
    }
    if (parsed instanceof NextResponse) return parsed;

    let options: ReturnType<typeof parseToolOptions>;
    try {
      options = parseToolOptions(parsed.toolName, parsed.rawOptions);
    } catch (err: unknown) {
      if (err instanceof WebToolRefusal) {
        return codedRefusal(err.status, err.code, err.message);
      }
      throw err;
    }

    const queueOnly = isQueueOnlyWebMode();
    const liveWorker = await hasLiveQueueWorker();
    let releaseSlotOnce: (() => void) | undefined;
    if (queueOnly || liveWorker) {
      const room = await mayEnqueue(caller.id, caller.tier);
      if (!room.allowed) return concurrencyLimitResponse(room.limit, instanceUri);
    } else {
      const sourceFormat = webToolResourceFormat(parsed.toolName);
      const localLeaseMs =
        conversionDeadlineMs({
          tier: caller.tier,
          sourceFormat,
          targetFormat: sourceFormat,
          inputBytes: parsed.totalBytes,
        }) + 15_000;
      const slot = await acquireSyncSlot(caller.id, caller.tier, localLeaseMs);
      if (!slot.granted) return concurrencyLimitResponse(slot.limit, instanceUri);
      let released = false;
      releaseSlotOnce = () => {
        if (released) return;
        released = true;
        slot.release();
      };
    }

    const unit = await reserveConversionUnit(caller, 1);
    if (!unit.reserved) {
      releaseSlotOnce?.();
      return conversionRefusalResponse(unit.refusal, instanceUri);
    }

    const jobId = crypto.randomUUID();
    const initialInputKeys = parsed.storedRefs?.map((ref) => ref.key);
    const initialState: ToolJobState = {
      id: jobId,
      userId: caller.id,
      tool: parsed.toolName,
      status: 'queued',
      progress: 0,
      ...(initialInputKeys && initialInputKeys.length > 0 ? { inputKeys: initialInputKeys } : {}),
      createdAt: Date.now(),
    };
    try {
      await saveToolJob(initialState);
    } catch (err) {
      releaseSlotOnce?.();
      await withReservedUnit(unit.reservationId, async () => {
        throw err;
      });
    }

    if (queueOnly || liveWorker) {
      releaseSlotOnce?.();
      return await dispatchQueuedToolJob({
        caller,
        jobId,
        initialState,
        parsed,
        options,
        reservationId: unit.reservationId,
        queueOnly,
        liveWorker,
        instanceUri,
      });
    }

    launchLocalToolJob({
      caller,
      jobId,
      initialState,
      parsed,
      options,
      reservationId: unit.reservationId,
      releaseSlot: releaseSlotOnce ?? (() => undefined),
    });
    return NextResponse.json({ success: true, id: jobId, status: 'queued' }, { status: 201 });
  } finally {
    await releaseMultipartForm(req);
  }
}));
