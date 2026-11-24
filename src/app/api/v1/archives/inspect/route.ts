import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { buildRateLimitHeaders, withRateLimitHeaders } from '@/lib/api/rate-limit';
import { createEngineUnavailableResponse, createProblemDetailsResponse } from '@/lib/api/problem-details';
import { queueErrorResponse } from '@/lib/api/queue-error-response';
import { readJsonObject } from '@/lib/api/json-body';
import { readMultipartForm, releaseMultipartForm } from '@/lib/api/multipart-body';
import { payloadLimitStatus } from '@/lib/api/payload-limit';
import { fileSizeLimitProblem, withinSingleRequest } from '@/lib/api/file-size-limit';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { acquireSyncSlot, concurrencyLimitResponse } from '@/lib/queue/concurrency-limit';
import { jobDeadlineMs, syncDeadlineMs } from '@/lib/queue/job-deadline';
import { dispatchSyncArchiveInspection } from '@/lib/queue/wait-for-job';
import { isQueueOnlyWebMode } from '@/lib/queue/worker-presence';
import { SINGLE_REQUEST_FILE_MAX_BYTES, type PlanCaller } from '@/lib/plan-limits';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { STORAGE_OBJECT_NOT_FOUND, mayUseStorageKeyAsJobInput } from '@/lib/api-keys/owner-access';
import { storageProvider } from '@/lib/storage';
import type { ObjectStat } from '@/lib/storage/types';
import {
  ArchiveEncryptedHeaderError,
  MissingVolumeError,
  ConversionFailedError,
  EngineMissingError,
  RequestAbortedError,
} from '@/lib/types';
import { PROBLEM_TYPE_BASE } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const MIB = 1024 * 1024;

type MultipartArchive =
  | { problem: NextResponse; archiveBuffer?: undefined; inputBytes?: undefined; filename?: undefined; password?: undefined }
  | { problem?: undefined; archiveBuffer: Buffer; inputBytes: number; filename: string; password: string | undefined };

function inspectSizeProblem(
  user: PlanCaller,
  size: number,
  kind: 'uploaded' | 'stored',
  instanceUri: string
): NextResponse | null {
  if (size === 0) {
    return createProblemDetailsResponse(400, 'Archive buffer is empty.', instanceUri, 'Bad Request');
  }
  // Checked before plan limits so > SINGLE_REQUEST_FILE_MAX_BYTES keeps its single-request guidance.
  if (size > SINGLE_REQUEST_FILE_MAX_BYTES) {
    const detail = `The ${kind} archive is ${Math.ceil(size / MIB)} MiB, over the ${SINGLE_REQUEST_FILE_MAX_BYTES / MIB} MiB that an inspection reads. Convert it with a job (POST /api/v1/jobs) instead.`;
    return createProblemDetailsResponse(413, detail, instanceUri, 'Payload Too Large');
  }
  return fileSizeLimitProblem(user, size, instanceUri);
}

/** The archive, its file name and its password from a multipart form, or the problem for a form that is malformed, missing a file, or oversized. */
async function readMultipartArchive(req: NextRequest, user: PlanCaller, instanceUri: string): Promise<MultipartArchive> {
  const multipart = await readMultipartForm(req);
  if (multipart.malformed) {
    return { problem: createProblemDetailsResponse(400, 'Invalid or malformed multipart/form-data body.', instanceUri, 'Bad Request') };
  }
  const formData = multipart.form;
  const fileEntry = formData.get('file');
  if (!fileEntry || typeof fileEntry === 'string' || !(fileEntry instanceof Blob)) {
    return {
      problem: createProblemDetailsResponse(400, 'Missing required "file" in multipart form data.', instanceUri, 'Bad Request'),
    };
  }
  const sizeProblem = inspectSizeProblem(user, fileEntry.size, 'uploaded', instanceUri);
  if (sizeProblem) {
    return { problem: sizeProblem };
  }
  const password = formData.get('password');
  let archiveBuffer: Buffer;
  try {
    archiveBuffer = Buffer.from(await fileEntry.arrayBuffer());
  } catch (err: unknown) {
    if (req.signal.aborted) throw new RequestAbortedError({ cause: err });
    return { problem: createProblemDetailsResponse(400, 'Invalid or malformed multipart/form-data body.', instanceUri, 'Bad Request') };
  }
  return {
    archiveBuffer,
    inputBytes: archiveBuffer.length,
    filename: (fileEntry as File).name,
    password: typeof password === 'string' && password ? password : undefined,
  };
}

type StoredArchive =
  | { problem: NextResponse; buffer?: undefined; storageKey?: undefined; inputBytes?: undefined; filename?: undefined; release?: undefined }
  | { problem?: undefined; buffer?: Buffer; storageKey?: string; inputBytes: number; filename: string; release?: () => Promise<void> | undefined };

/** The archive stored under `storageKey` (or key metadata in queue-only mode), or the problem for an unauthorized, missing, empty, or oversized key. */
async function readStoredArchive(
  storageKey: unknown,
  user: PlanCaller & { id: string },
  instanceUri: string
): Promise<StoredArchive> {
  if (typeof storageKey !== 'string') {
    return { problem: createProblemDetailsResponse(404, STORAGE_OBJECT_NOT_FOUND, instanceUri, 'Not Found') };
  }
  // Follow the same capability/ownership rule as job inputs; answer unauthorized and missing keys identically.
  let info: ObjectStat | null = null;
  const allowed = await mayUseStorageKeyAsJobInput(storageKey, user.id, async (key) => {
    info = await storageProvider.stat(key);
    return info;
  });
  const stat = info as ObjectStat | null;
  if (!allowed || !stat) {
    return { problem: createProblemDetailsResponse(404, STORAGE_OBJECT_NOT_FOUND, instanceUri, 'Not Found') };
  }
  const sizeProblem = inspectSizeProblem(user, stat.size, 'stored', instanceUri);
  if (sizeProblem) {
    return { problem: sizeProblem };
  }
  if (isQueueOnlyWebMode()) {
    return { storageKey, inputBytes: stat.size, filename: stat.filename };
  }
  const stored = await storageProvider.getObject(storageKey);
  if (!stored) {
    return { problem: createProblemDetailsResponse(404, STORAGE_OBJECT_NOT_FOUND, instanceUri, 'Not Found') };
  }
  let archiveBuffer: Buffer;
  try {
    archiveBuffer = stored.buffer;
  } catch (err) {
    await stored.release?.().catch(() => undefined);
    throw err;
  }
  return {
    buffer: archiveBuffer,
    inputBytes: archiveBuffer.length,
    filename: stored.filename,
    release: () => stored.release?.(),
  };
}

type ParsedInspectInput =
  | { problem: NextResponse; archiveBuffer?: undefined; storageKey?: undefined; inputBytes?: undefined; filename?: undefined; password?: undefined; release?: undefined }
  | { problem?: undefined; archiveBuffer?: Buffer; storageKey?: string; inputBytes: number; filename: string | undefined; password: string | undefined; release?: () => Promise<void> | undefined };

async function readJsonInspectInput(
  req: NextRequest,
  user: PlanCaller & { id: string },
  instanceUri: string
): Promise<ParsedInspectInput> {
  const body = await readJsonObject(req);
  if (!body) {
    return { problem: createProblemDetailsResponse(400, 'Invalid JSON request payload.', instanceUri, 'Bad Request') };
  }
  if (!body.storageKey) {
    return { problem: createProblemDetailsResponse(400, 'JSON inspection request must include a "storageKey".', instanceUri, 'Bad Request') };
  }
  const stored = await readStoredArchive(body.storageKey, user, instanceUri);
  if (stored.problem) return { problem: stored.problem };
  const requestedFilename = typeof body.filename === 'string' && body.filename ? body.filename : undefined;
  return {
    archiveBuffer: stored.buffer,
    storageKey: stored.storageKey,
    inputBytes: stored.inputBytes,
    filename: requestedFilename ?? stored.filename,
    password: typeof body.password === 'string' && body.password ? body.password : undefined,
    release: stored.release,
  };
}

async function readRawInspectInput(
  req: NextRequest,
  user: PlanCaller,
  instanceUri: string
): Promise<ParsedInspectInput> {
  let raw: ArrayBuffer;
  try {
    raw = await req.arrayBuffer();
  } catch (bodyErr: unknown) {
    if (req.signal.aborted) throw new RequestAbortedError({ cause: bodyErr });
    return { problem: createProblemDetailsResponse(400, 'Invalid or truncated archive request body.', instanceUri, 'Bad Request') };
  }
  if (raw.byteLength === 0) {
    return { problem: createProblemDetailsResponse(400, 'Empty archive payload provided for inspection.', instanceUri, 'Bad Request') };
  }
  const sizeProblem = inspectSizeProblem(user, raw.byteLength, 'uploaded', instanceUri);
  if (sizeProblem) {
    return { problem: sizeProblem };
  }
  const archiveBuffer = Buffer.from(raw);
  return {
    archiveBuffer,
    inputBytes: archiveBuffer.length,
    filename: req.headers.get('x-archive-filename') || req.nextUrl.searchParams.get('filename') || undefined,
    password: req.headers.get('x-archive-password') || req.nextUrl.searchParams.get('password') || undefined,
  };
}

async function parseInspectInput(
  req: NextRequest,
  user: PlanCaller & { id: string },
  instanceUri: string
): Promise<ParsedInspectInput> {
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    return readMultipartArchive(req, user, instanceUri);
  }
  if (contentType.includes('application/json')) {
    return readJsonInspectInput(req, user, instanceUri);
  }
  return readRawInspectInput(req, user, instanceUri);
}

function inspectErrorResponse(err: unknown, instanceUri: string): NextResponse {
  const deadlineProblem = deadlineErrorResponse(err, instanceUri);
  if (deadlineProblem) return deadlineProblem;
  const storageProblem = storageErrorResponse(err, instanceUri);
  if (storageProblem) return storageProblem;
  const queueProblem = queueErrorResponse(err, instanceUri);
  if (queueProblem) return queueProblem;
  if (err instanceof EngineMissingError) {
    return createEngineUnavailableResponse(err, instanceUri);
  }
  if (err instanceof ArchiveEncryptedHeaderError) {
    return createProblemDetailsResponse(
      422,
      err.message,
      instanceUri,
      'Archive Header Encrypted',
      `${PROBLEM_TYPE_BASE}archive-encrypted-header`
    );
  }
  if (err instanceof MissingVolumeError) {
    return createProblemDetailsResponse(
      422,
      err.message,
      instanceUri,
      'Missing Archive Volume',
      `${PROBLEM_TYPE_BASE}missing-archive-volume`
    );
  }
  const limitStatus = payloadLimitStatus(err);
  if (limitStatus !== null) {
    return createProblemDetailsResponse(limitStatus, err instanceof Error ? err.message : String(err), instanceUri);
  }
  if (err instanceof ConversionFailedError) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 500) {
      console.error('[archives/inspect] Worker fault:', err);
      return createProblemDetailsResponse(500, 'Failed to inspect archive.', instanceUri, 'Internal Server Error');
    }
    return createProblemDetailsResponse(
      422,
      err.message,
      instanceUri,
      'Invalid Archive',
      `${PROBLEM_TYPE_BASE}invalid-archive`
    );
  }
  console.error('[archives/inspect] Unexpected failure:', err);
  return createProblemDetailsResponse(500, 'Failed to inspect archive.', instanceUri, 'Internal Server Error');
}

export const POST = withinSingleRequest(async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/archives/inspect';

  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    let headers = authErrorHeaders(auth);
    if (auth.user) {
      const userQuota = await redisKeyStore.getQuotaUsage(auth.user.id);
      headers = { ...buildRateLimitHeaders(userQuota), ...headers };
    }
    return createProblemDetailsResponse(
      auth.status || 401,
      auth.error || 'Authentication required.',
      instanceUri,
      auth.status === 403 ? 'Forbidden' : 'Unauthorized',
      undefined,
      headers
    );
  }

  return withRateLimitHeaders(await postInspectAuthorized(req, instanceUri, auth.user), auth.rateLimit);
});

async function postInspectAuthorized(req: NextRequest, instanceUri: string, user: NonNullable<Awaited<ReturnType<typeof validateApiAccess>>['user']>) {
  // At most as many inspections in flight as conversions: the listing runs a 7-Zip process and holds the archive in memory.
  const slot = await acquireSyncSlot(user.id, user.tier);
  if (!slot.granted) return concurrencyLimitResponse(slot.limit, instanceUri);

  let parsed: ParsedInspectInput | undefined;
  try {
    parsed = await parseInspectInput(req, user, instanceUri);
    if (parsed.problem) return parsed.problem;

    const { archiveBuffer, storageKey, inputBytes, filename, password } = parsed;
    if (inputBytes === 0 || (archiveBuffer && archiveBuffer.length === 0)) {
      return createProblemDetailsResponse(400, 'Archive buffer is empty.', instanceUri, 'Bad Request');
    }

    const tooLarge = fileSizeLimitProblem(user, inputBytes, instanceUri);
    if (tooLarge) return tooLarge;

    const deadlineMs = syncDeadlineMs(jobDeadlineMs({ tier: user.tier, family: 'bytes', inputBytes }));
    const inspection = await runUnderDeadline(req, deadlineMs, (limits) =>
      dispatchSyncArchiveInspection({
        archiveBuffer,
        storageKey,
        inputBytes,
        filename,
        password,
        userId: user.id,
        tier: user.tier,
        signal: limits.signal,
        deadlineAt: limits.deadlineAt,
      })
    );
    return NextResponse.json({
      success: true,
      ...inspection,
    });
  } catch (err: unknown) {
    return inspectErrorResponse(err, instanceUri);
  } finally {
    await parsed?.release?.()?.catch(() => undefined);
    slot.release();
    await releaseMultipartForm(req);
  }
}
