import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { validateApiAccess, authErrorHeaders, reserveConversionUnit, withReservedUnit } from '@/lib/api-keys/guard';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import { fileSizeLimitProblem } from '@/lib/api/file-size-limit';
import { readBoundedJsonText } from '@/lib/api/json-body-bounds';
import { SMALL_REQUEST_BODY_MAX_BYTES } from '@/lib/api/request-body-limit';
import { isMultipartBody, readMultipartForm, formText } from '@/lib/api/multipart-body';
import { codedRefusal, createProblemDetailsResponse } from '@/lib/api/problem-details';
import { STORAGE_OBJECT_NOT_FOUND, mayUseStorageKeyAsJobInput } from '@/lib/api-keys/owner-access';
import type { User } from '@/lib/auth/types';
import { storageProvider as s3Storage } from '@/lib/storage';
import { isUploadKey, resultKey, stagedInputKey } from '@/lib/storage/key-namespace';
import { sanitizeNodeOutputFilename } from '@/lib/queue/graph/node-jobs';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { handOffConversionJob } from '@/lib/queue/enqueue';
import { hasLiveQueueWorker, isQueueOnlyWebMode } from '@/lib/queue/worker-presence';
import { typedFailureProblem } from '@/lib/api/typed-failure-response';
import { MAX_TOOL_FILES, WEB_TOOLS, type WebTool } from '@/lib/tools/tool-names';
import {
  deleteToolJob,
  getToolJob,
  registerLocalToolAbort,
  saveToolJob,
  unregisterLocalToolAbort,
  type StoredToolJobResult,
  type ToolJobState,
} from '@/lib/tools/tool-job-store';
import {
  assertToolInput,
  assertToolUploadMetadata,
  parseToolOptions,
  runWebTool,
  WebToolRefusal,
  type WebToolFile,
  type WebToolOutput,
} from '@/lib/tools/web-tools';
import { saveRetainedResult } from '@/lib/storage/retention-service';

export const dynamic = 'force-dynamic';

interface StoredInputFileRef {
  key: string;
  name: string;
}

interface ParsedToolJobInputs {
  toolName: WebTool;
  rawOptions: string | undefined;
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
  return { toolName, rawOptions: formText(body.form, 'options'), inlineFiles };
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
  return { toolName, rawOptions: serializeRawOptions(payload.options), storedRefs };
}

async function cleanupTemporaryUploads(refs: readonly StoredInputFileRef[] | undefined): Promise<void> {
  if (!refs) return;
  await Promise.all(
    refs
      .filter((ref) => isUploadKey(ref.key))
      .map((ref) => Promise.resolve().then(() => s3Storage.deleteObject(ref.key)).catch(() => undefined))
  );
}

export const POST = admittingNewFiles(async function POST(req: NextRequest) {
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

  let parsed: ParsedToolJobInputs | NextResponse;
  try {
    parsed = isMultipartBody(req)
      ? await parseMultipartJobInputs(req, caller, instanceUri)
      : await parseJsonJobInputs(req, caller, instanceUri);
  } catch (err: unknown) {
    if (err instanceof WebToolRefusal) {
      return codedRefusal(err.status, err.code, err.message);
    }
    throw err;
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

  const unit = await reserveConversionUnit(caller, 1);
  if (!unit.reserved) return conversionRefusalResponse(unit.refusal, instanceUri);

  const jobId = crypto.randomUUID();
  const initialState: ToolJobState = {
    id: jobId,
    userId: caller.id,
    tool: parsed.toolName,
    status: 'queued',
    progress: 0,
    createdAt: Date.now(),
  };
  await saveToolJob(initialState);

  const queueOnly = isQueueOnlyWebMode();
  const liveWorker = await hasLiveQueueWorker();

  if (queueOnly || liveWorker) {
    const stagedInlineKeys: string[] = [];
    try {
      await withReservedUnit(unit.reservationId, async (reserved) => {
        if (queueOnly && !liveWorker) {
          const { QueueUnavailableError } = await import('@/lib/types');
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

        const cleanupKeys = [
          ...stagedInlineKeys,
          ...(parsed.storedRefs ?? []).map((ref) => ref.key).filter((key) => isUploadKey(key)),
        ];
        const totalBytes = parsed.inlineFiles
          ? parsed.inlineFiles.reduce((sum, file) => sum + file.buffer.length, 0)
          : (
              await Promise.all(
                storedRefs.map(async (ref) => (await s3Storage.stat(ref.key))?.size ?? 0)
              )
            ).reduce((sum, size) => sum + size, 0);

        const sourceFormat =
          parsed.toolName === 'archive-extract' || parsed.toolName === 'archive-create' ? 'zip' : 'pdf';

        await handOffConversionJob(
          reserved,
          conversionQueue,
          {
            jobId,
            originalFilename: parsed.toolName,
            sourceFormat,
            targetFormat: sourceFormat,
            fileSize: totalBytes,
            options: {},
            userId: caller.id,
            toolJob: {
              tool: parsed.toolName,
              options: (options ?? {}) as Record<string, unknown>,
              storedRefs,
              cleanupUploadKeys: cleanupKeys,
            },
          },
          { jobId },
          { tier: caller.tier, inputBytes: totalBytes }
        );
      });

      return NextResponse.json({ success: true, id: jobId, status: 'queued' }, { status: 201 });
    } catch (err: unknown) {
      await Promise.all(
        stagedInlineKeys.map((key) => Promise.resolve().then(() => s3Storage.deleteObject(key)).catch(() => undefined))
      );
      await deleteToolJob(jobId).catch(() => undefined);
      return typedFailureProblem(err, instanceUri);
    }
  }

  const abortController = registerLocalToolAbort(jobId);
  void withReservedUnit(unit.reservationId, async (reserved) => {
    try {
      const current = await getToolJob(jobId);
      if (current?.status === 'cancelled' || abortController.signal.aborted) {
        await cleanupTemporaryUploads(parsed.storedRefs);
        return;
      }
      await saveToolJob({ ...initialState, status: 'running', progress: 25 });
      const stagedReleases: Array<() => Promise<void> | void> = [];
      let output: WebToolOutput;
      try {
        const files: WebToolFile[] = parsed.inlineFiles
          ? parsed.inlineFiles
          : await Promise.all(
              (parsed.storedRefs ?? []).map(async (ref) => {
                const stored = await s3Storage.getObject(ref.key);
                if (!stored) throw new Error('Input storage object missing.');
                const maybeRelease = (stored as { release?: () => Promise<void> | void }).release;
                if (typeof maybeRelease === 'function') stagedReleases.push(() => maybeRelease.call(stored));
                return { name: ref.name, buffer: stored.buffer };
              })
            );
        if (!parsed.inlineFiles) assertToolInput(parsed.toolName, files);
        output = await runWebTool(parsed.toolName, files, options, abortController.signal);
      } finally {
        await Promise.all(stagedReleases.map((fn) => Promise.resolve().then(fn).catch(() => undefined)));
      }
      const afterRun = await getToolJob(jobId);
      if (afterRun?.status === 'cancelled' || abortController.signal.aborted) {
        await cleanupTemporaryUploads(parsed.storedRefs);
        return;
      }
      const storedResult = await storeToolOutput(output, caller);
      await cleanupTemporaryUploads(parsed.storedRefs);
      await saveToolJob({ ...initialState, status: 'completed', progress: 100, result: storedResult });
      await reserved.commit({ from: parsed.toolName, base: 1, processingMs: Date.now() - initialState.createdAt });
    } catch (err: unknown) {
      await cleanupTemporaryUploads(parsed.storedRefs);
      const current = await getToolJob(jobId);
      if (current?.status === 'cancelled' || abortController.signal.aborted) {
        await saveToolJob({ ...initialState, status: 'cancelled' }).catch(() => undefined);
        return;
      }
      await saveToolJob({
        ...initialState,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
    } finally {
      unregisterLocalToolAbort(jobId);
    }
  });

  return NextResponse.json({ success: true, id: jobId, status: 'queued' }, { status: 201 });
});
