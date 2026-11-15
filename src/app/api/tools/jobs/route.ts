import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { validateApiAccess, authErrorHeaders, reserveConversionUnit, withReservedUnit } from '@/lib/api-keys/guard';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import { fileSizeLimitProblem } from '@/lib/api/file-size-limit';
import { isMultipartBody, readMultipartForm, formText } from '@/lib/api/multipart-body';
import { codedRefusal, createProblemDetailsResponse } from '@/lib/api/problem-details';
import { STORAGE_OBJECT_NOT_FOUND, mayUseStorageKeyAsJobInput } from '@/lib/api-keys/owner-access';
import type { User } from '@/lib/auth/types';
import { storageProvider as s3Storage } from '@/lib/storage';
import { isUploadKey } from '@/lib/storage/key-namespace';
import { sanitizeNodeOutputFilename } from '@/lib/queue/graph/node-jobs';
import { MAX_TOOL_FILES, WEB_TOOLS, type WebTool } from '@/lib/tools/tool-names';
import { resultNameOf } from '@/lib/tools/tool-client';
import { getToolJob, saveToolJob, type StoredToolJobResult, type ToolJobState } from '@/lib/tools/tool-job-store';
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

async function storeToolOutput(
  output: WebToolOutput,
  caller: User,
  toolName: WebTool,
  firstFileName: string,
  options: ReturnType<typeof parseToolOptions>
): Promise<StoredToolJobResult> {
  if (output.kind === 'file') {
    const safeName = sanitizeNodeOutputFilename(output.filename, 'output.bin');
    const storageKey = `conversions/${caller.id}/${crypto.randomUUID()}_${safeName}`;
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
  if (output.kind === 'entries') {
    const entries = await Promise.all(
      output.entries.map(async (entry, index) => {
        const safeName = sanitizeNodeOutputFilename(entry.name, `file_${index + 1}`);
        const storageKey = `conversions/${caller.id}/${crypto.randomUUID()}_${safeName}`;
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
  return {
    kind: 'inspection',
    inspection: output.inspection,
    name: resultNameOf(toolName, firstFileName, options),
  };
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
  try {
    const parsed = (await req.json()) as unknown;
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

  void withReservedUnit(unit.reservationId, async (reserved) => {
    try {
      const current = await getToolJob(jobId);
      if (current?.status === 'cancelled') {
        await cleanupTemporaryUploads(parsed.storedRefs);
        return;
      }
      await saveToolJob({ ...initialState, status: 'running', progress: 25 });
      const files: WebToolFile[] = parsed.inlineFiles
        ? parsed.inlineFiles
        : await Promise.all(
            (parsed.storedRefs ?? []).map(async (ref) => {
              const stored = await s3Storage.getObject(ref.key);
              if (!stored) throw new Error('Input storage object missing.');
              return { name: ref.name, buffer: stored.buffer };
            })
          );
      if (!parsed.inlineFiles) assertToolInput(parsed.toolName, files);
      const output = await runWebTool(parsed.toolName, files, options);
      const afterRun = await getToolJob(jobId);
      if (afterRun?.status === 'cancelled') {
        await cleanupTemporaryUploads(parsed.storedRefs);
        return;
      }
      const storedResult = await storeToolOutput(output, caller, parsed.toolName, files[0]?.name ?? 'output', options);
      await cleanupTemporaryUploads(parsed.storedRefs);
      await saveToolJob({ ...initialState, status: 'completed', progress: 100, result: storedResult });
      await reserved.commit({ from: parsed.toolName, base: 1, processingMs: Date.now() - initialState.createdAt });
    } catch (err: unknown) {
      await cleanupTemporaryUploads(parsed.storedRefs);
      await saveToolJob({
        ...initialState,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
    }
  });

  return NextResponse.json({ success: true, id: jobId, status: 'queued' }, { status: 201 });
});
