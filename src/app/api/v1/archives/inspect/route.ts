import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { buildRateLimitHeaders } from '@/lib/api/rate-limit';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { readJsonObject } from '@/lib/api/json-body';
import { readMultipartForm } from '@/lib/api/multipart-body';
import { payloadLimitStatus } from '@/lib/api/payload-limit';
import { fileSizeLimitProblem, withinSingleRequest } from '@/lib/api/file-size-limit';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { acquireSyncSlot, concurrencyLimitResponse } from '@/lib/queue/concurrency-limit';
import { jobDeadlineMs, syncDeadlineMs } from '@/lib/queue/job-deadline';
import { SINGLE_REQUEST_FILE_MAX_BYTES } from '@/lib/plan-limits';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { STORAGE_OBJECT_NOT_FOUND, resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { inspectArchive } from '@/lib/conversions';
import { storageProvider } from '@/lib/storage';
import {
  ArchiveEncryptedHeaderError,
  MissingVolumeError,
  ConversionFailedError,
  RequestAbortedError,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

const MIB = 1024 * 1024;

type MultipartArchive =
  | { problem: NextResponse; archiveBuffer?: undefined }
  | { problem?: undefined; archiveBuffer: Buffer; filename: string; password: string | undefined };

/** The archive, its file name and its password from a multipart form, or the 400 for a form that is malformed or has no file. */
async function readMultipartArchive(req: NextRequest, instanceUri: string): Promise<MultipartArchive> {
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
  const password = formData.get('password');
  return {
    archiveBuffer: Buffer.from(await fileEntry.arrayBuffer()),
    filename: (fileEntry as File).name,
    password: typeof password === 'string' && password ? password : undefined,
  };
}

type StoredArchive =
  | { problem: NextResponse; buffer?: undefined; filename?: undefined }
  | { problem?: undefined; buffer: Buffer; filename: string };

/** The archive stored under `storageKey`, or the problem for a key `userId` does not own, an object that is missing, or one too large to inspect. */
async function readStoredArchive(storageKey: unknown, userId: string, instanceUri: string): Promise<StoredArchive> {
  // Only the owner of a stored object may read it; every other caller is answered as if it did not exist.
  const ownership = typeof storageKey === 'string' ? await resolveObjectOwnership(storageKey) : ({ resolved: false } as const);
  if (typeof storageKey !== 'string' || !ownership.resolved || ownership.ownerUserId !== userId) {
    return { problem: createProblemDetailsResponse(404, STORAGE_OBJECT_NOT_FOUND, instanceUri, 'Not Found') };
  }
  // The size is asked of the store first: a stored object is read whole, up to the 512 MiB the store allows in memory.
  const info = await storageProvider.stat(storageKey);
  if (info && info.size > SINGLE_REQUEST_FILE_MAX_BYTES) {
    const detail = `The stored archive is ${Math.ceil(info.size / MIB)} MiB, over the ${SINGLE_REQUEST_FILE_MAX_BYTES / MIB} MiB that an inspection reads. Convert it with a job (POST /api/v1/jobs) instead.`;
    return { problem: createProblemDetailsResponse(413, detail, instanceUri, 'Payload Too Large') };
  }
  const stored = info ? await storageProvider.getObject(storageKey) : undefined;
  if (!stored) {
    return { problem: createProblemDetailsResponse(404, `Storage file not found for key: "${storageKey}".`, instanceUri, 'Not Found') };
  }
  return { buffer: stored.buffer, filename: stored.filename };
}

type ParsedInspectInput =
  | { problem: NextResponse; archiveBuffer?: undefined; filename?: undefined; password?: undefined }
  | { problem?: undefined; archiveBuffer: Buffer; filename: string | undefined; password: string | undefined };

async function readJsonInspectInput(req: NextRequest, userId: string, instanceUri: string): Promise<ParsedInspectInput> {
  const body = await readJsonObject(req);
  if (!body) {
    return { problem: createProblemDetailsResponse(400, 'Invalid JSON request payload.', instanceUri, 'Bad Request') };
  }
  if (!body.storageKey) {
    return { problem: createProblemDetailsResponse(400, 'JSON inspection request must include a "storageKey".', instanceUri, 'Bad Request') };
  }
  const stored = await readStoredArchive(body.storageKey, userId, instanceUri);
  if (stored.problem) return { problem: stored.problem };
  const requestedFilename = typeof body.filename === 'string' && body.filename ? body.filename : undefined;
  return {
    archiveBuffer: stored.buffer,
    filename: requestedFilename ?? stored.filename,
    password: typeof body.password === 'string' ? body.password : undefined,
  };
}

async function readRawInspectInput(req: NextRequest, instanceUri: string): Promise<ParsedInspectInput> {
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
  return {
    archiveBuffer: Buffer.from(raw),
    filename: req.headers.get('x-archive-filename') || req.nextUrl.searchParams.get('filename') || undefined,
    password: req.headers.get('x-archive-password') || req.nextUrl.searchParams.get('password') || undefined,
  };
}

async function parseInspectInput(req: NextRequest, userId: string, instanceUri: string): Promise<ParsedInspectInput> {
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    return readMultipartArchive(req, instanceUri);
  }
  if (contentType.includes('application/json')) {
    return readJsonInspectInput(req, userId, instanceUri);
  }
  return readRawInspectInput(req, instanceUri);
}

function inspectErrorResponse(err: unknown, instanceUri: string): NextResponse {
  const deadlineProblem = deadlineErrorResponse(err, instanceUri);
  if (deadlineProblem) return deadlineProblem;
  const storageProblem = storageErrorResponse(err, instanceUri);
  if (storageProblem) return storageProblem;
  if (err instanceof ArchiveEncryptedHeaderError) {
    return createProblemDetailsResponse(
      422,
      err.message,
      instanceUri,
      'Archive Header Encrypted',
      'https://api.easyconvert.io/problems/archive-encrypted-header'
    );
  }
  if (err instanceof MissingVolumeError) {
    return createProblemDetailsResponse(
      422,
      err.message,
      instanceUri,
      'Missing Archive Volume',
      'https://api.easyconvert.io/problems/missing-archive-volume'
    );
  }
  const limitStatus = payloadLimitStatus(err);
  if (limitStatus !== null) {
    return createProblemDetailsResponse(limitStatus, err instanceof Error ? err.message : String(err), instanceUri);
  }
  if (err instanceof ConversionFailedError) {
    return createProblemDetailsResponse(
      422,
      err.message,
      instanceUri,
      'Invalid Archive',
      'https://api.easyconvert.io/problems/invalid-archive'
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

  // At most as many inspections in flight as conversions: the listing runs a 7-Zip process and holds the archive in memory.
  const slot = await acquireSyncSlot(auth.user.id, auth.user.tier);
  if (!slot.granted) return concurrencyLimitResponse(slot.limit, instanceUri);

  try {
    const parsed = await parseInspectInput(req, auth.user.id, instanceUri);
    if (parsed.problem) return parsed.problem;

    const { archiveBuffer, filename, password } = parsed;
    if (archiveBuffer.length === 0) {
      return createProblemDetailsResponse(400, 'Archive buffer is empty.', instanceUri, 'Bad Request');
    }

    const tooLarge = fileSizeLimitProblem(auth.user, archiveBuffer.length, instanceUri);
    if (tooLarge) return tooLarge;

    const deadlineMs = syncDeadlineMs(jobDeadlineMs({ tier: auth.user.tier, family: 'bytes', inputBytes: archiveBuffer.length }));
    const inspection = await runUnderDeadline(req, deadlineMs, (limits) =>
      inspectArchive(archiveBuffer, { filename, password, signal: limits.signal })
    );
    return NextResponse.json({
      success: true,
      ...inspection,
    });
  } catch (err: unknown) {
    return inspectErrorResponse(err, instanceUri);
  } finally {
    slot.release();
  }
});
