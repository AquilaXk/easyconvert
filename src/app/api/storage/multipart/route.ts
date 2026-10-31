import { NextRequest, NextResponse } from 'next/server';
import type { User } from '@/lib/auth/types';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { discardUpload, mayPresignDownload, registerCompletedUpload } from '@/lib/storage/retention-service';
import { MULTIPART_MAX_PARTS, storageProvider } from '@/lib/storage';
import type { IStorageBackend } from '@/lib/storage/oci-storage';
import { isUploadKey } from '@/lib/storage/key-namespace';
import { validateApiAccess, authErrorHeaders, getQuotaUsage } from '@/lib/api-keys/guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { STORAGE_OBJECT_NOT_FOUND, resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { fileSizeLimitProblem, partBodyProblem } from '@/lib/api/file-size-limit';
import { respondOnce } from '@/lib/api/with-idempotency';
import { UPLOAD_PART_MAX_BYTES } from '@/lib/plan-limits';
import { isUnattributedAnonymous, mayUseUploadSession, uploadOwnerOf } from '@/lib/auth/anonymous-identity';
import {
  ANONYMOUS_DAILY_UPLOAD_BYTES,
  ANONYMOUS_OPEN_UPLOADS_MAX,
  OPEN_UPLOAD_IDLE_MS,
  endUploadReservation,
  noteUploadActivity,
  reserveAnonymousUpload,
  type BudgetRefusal,
} from '@/lib/api-keys/anonymous-upload-budget';
import { concurrencyLimitResponse, mayEnqueue } from '@/lib/queue/concurrency-limit';
import { formatBytes } from '@/lib/format-bytes';
import { DOWNLOAD_PRESIGN_MAX_SECONDS, PART_URL_TTL_SECONDS } from '@/lib/storage/presign-limits';
import { PRESIGN_MAX_EXPIRES_SECONDS, PRESIGN_MIN_EXPIRES_SECONDS, SigV4SigningError, assertValidObjectKey } from '@/lib/storage/s3-sigv4';

export const dynamic = 'force-dynamic';

const MAX_PART_BYTES = UPLOAD_PART_MAX_BYTES;
/** The smallest part an object store takes for a part that is not the last (the S3 rule). */
const MIN_PART_BYTES = 5 * 1024 * 1024;
const HTTP_TOO_MANY_REQUESTS = 429;
const QUOTA_EXCEEDED_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/quota-exceeded';
const UPLOAD_BUDGET_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/upload-budget-exceeded';

const PRESIGN_UNSUPPORTED = 'Storage provider does not support presigned URLs or invalid type specified.';
const RETAINED_DOWNLOAD_PRESIGN_REFUSED =
  'A conversion result has no signed download link. Download it from /api/storage/file/<key>.';

/** The session operations the multipart actions need; every shipped backend provides them. */
type MultipartCapableStorage = IStorageBackend &
  Required<Pick<IStorageBackend, 'getUploadSession' | 'getUploadOwner' | 'uploadPartStream' | 'getUploadedParts'>>;

function supportsMultipartSessions(storage: IStorageBackend): storage is MultipartCapableStorage {
  return Boolean(
    storage.getUploadSession && storage.getUploadOwner && storage.uploadPartStream && storage.getUploadedParts
  );
}

/** What every action works with: the request, the storage, the authenticated caller and the problem instance. */
interface ActionContext {
  req: NextRequest;
  storage: MultipartCapableStorage;
  user: User;
  instanceUri: string;
}

type Body = Record<string, unknown>;

function readJson(req: NextRequest): Promise<Body> {
  return req.json().then(
    (body: unknown) => (body && typeof body === 'object' ? (body as Body) : {}),
    () => ({})
  );
}

function badRequest(detail: string, instanceUri: string): NextResponse {
  return createProblemDetailsResponse(400, detail, instanceUri);
}

function notFound(instanceUri: string): NextResponse {
  return createProblemDetailsResponse(404, STORAGE_OBJECT_NOT_FOUND, instanceUri);
}

/** The reason a presign request's key or expiry cannot be used, or undefined when both are acceptable. */
function presignInputProblem(key: unknown, expiresInSeconds: unknown): string | undefined {
  if (typeof key !== 'string' || key.length === 0) {
    return 'Missing required "key" in presign payload.';
  }
  try {
    assertValidObjectKey(key);
  } catch (err: unknown) {
    if (err instanceof SigV4SigningError) return 'The "key" in the presign payload is not a valid object key.';
    throw err;
  }
  if (
    expiresInSeconds !== undefined &&
    (typeof expiresInSeconds !== 'number' ||
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < PRESIGN_MIN_EXPIRES_SECONDS ||
      expiresInSeconds > PRESIGN_MAX_EXPIRES_SECONDS)
  ) {
    return `"expiresInSeconds" must be an integer between ${PRESIGN_MIN_EXPIRES_SECONDS} and ${PRESIGN_MAX_EXPIRES_SECONDS}.`;
  }
  return undefined;
}

interface PresignUploadPartRequest {
  key: string;
  partNumber: unknown;
  uploadId: unknown;
  expiresInSeconds?: number;
}

/** A part upload URL for a session the caller may use, signed only for that session's key. */
async function presignUploadPart(
  storage: MultipartCapableStorage,
  { key, partNumber, uploadId, expiresInSeconds }: PresignUploadPartRequest,
  userId: string,
  instanceUri: string
): Promise<Response> {
  if (typeof uploadId !== 'string' || !uploadId || typeof partNumber !== 'number') {
    return badRequest('Missing required "uploadId" or "partNumber" for presigned upload URL.', instanceUri);
  }
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MULTIPART_MAX_PARTS) {
    return badRequest(`Invalid "partNumber". Must be an integer between 1 and ${MULTIPART_MAX_PARTS}.`, instanceUri);
  }
  const session = await storage.getUploadSession(uploadId);
  if (!session || !mayUseUploadSession(session.ownerUserId, userId)) {
    return notFound(instanceUri);
  }
  if (key !== session.key) {
    return badRequest('Key does not belong to this multipart upload session.', instanceUri);
  }
  if (!storage.generatePresignedUploadUrl) {
    return badRequest(PRESIGN_UNSUPPORTED, instanceUri);
  }
  const presigned = await storage.generatePresignedUploadUrl(
    key,
    partNumber,
    uploadId,
    Math.min(expiresInSeconds ?? PART_URL_TTL_SECONDS, PART_URL_TTL_SECONDS)
  );
  return NextResponse.json({ success: true, ...presigned });
}

/**
 * A download URL for an object the caller provably owns. A signed URL needs no further authentication, so an
 * unresolved owner (job record unreadable), an ownerless key and another user's key are all answered like a missing
 * object. A result the retention rule tracks gets none: the bucket would answer the client, so the delivery could
 * not be recorded and the result would not be deleted after it (docs/policy-decisions.md, entry 125).
 */
async function presignDownload(
  storage: MultipartCapableStorage,
  key: string,
  expiresInSeconds: number | undefined,
  userId: string,
  instanceUri: string
): Promise<Response> {
  const ownership = await resolveObjectOwnership(key);
  if (!ownership.resolved || ownership.ownerUserId !== userId) {
    return notFound(instanceUri);
  }
  if (!(await mayPresignDownload(key))) {
    return badRequest(RETAINED_DOWNLOAD_PRESIGN_REFUSED, instanceUri);
  }
  if (!storage.generatePresignedDownloadUrl) {
    return badRequest(PRESIGN_UNSUPPORTED, instanceUri);
  }
  const presigned = await storage.generatePresignedDownloadUrl(
    key,
    Math.min(expiresInSeconds ?? DOWNLOAD_PRESIGN_MAX_SECONDS, DOWNLOAD_PRESIGN_MAX_SECONDS)
  );
  return NextResponse.json({ success: true, ...presigned });
}

/** The reason a requested part size cannot be used, or undefined when it is absent or in range. */
function partSizeProblemOf(partSize: unknown): string | undefined {
  if (partSize === undefined) return undefined;
  if (typeof partSize !== 'number' || !Number.isInteger(partSize) || partSize < MIN_PART_BYTES || partSize > MAX_PART_BYTES) {
    return `"partSize" must be an integer from ${MIN_PART_BYTES} to ${MAX_PART_BYTES} bytes.`;
  }
  return undefined;
}

/**
 * The 429 for a caller whose job could not start now: no conversion left today, or as many in flight as the plan
 * allows. Asked before an upload opens, so a file is not sent only to be refused at the job.
 */
async function jobStartRefusal(user: User, instanceUri: string): Promise<NextResponse | null> {
  if (!isUnattributedAnonymous(user.id)) {
    const quota = await getQuotaUsage(user.id);
    if (quota.remaining < 1) {
      return createProblemDetailsResponse(
        HTTP_TOO_MANY_REQUESTS,
        `The daily limit of ${quota.dailyLimit} conversions is used up. It resets at midnight UTC.`,
        instanceUri,
        'Too Many Requests',
        QUOTA_EXCEEDED_PROBLEM_TYPE
      );
    }
  }
  const room = await mayEnqueue(user.id, user.tier);
  return room.allowed ? null : concurrencyLimitResponse(room.limit, instanceUri);
}

const BUDGET_REFUSAL_DETAIL: Readonly<Record<BudgetRefusal, string>> = {
  'open-uploads': `Up to ${ANONYMOUS_OPEN_UPLOADS_MAX} uploads may be open at once without an account. Finish or cancel one, then try again.`,
  'daily-bytes': `Without an account, uploads may total ${formatBytes(ANONYMOUS_DAILY_UPLOAD_BYTES)} a day. The limit resets at midnight UTC.`,
};

function budgetRefusalResponse(refusal: BudgetRefusal, instanceUri: string): NextResponse {
  return createProblemDetailsResponse(HTTP_TOO_MANY_REQUESTS, BUDGET_REFUSAL_DETAIL[refusal], instanceUri, 'Too Many Requests', UPLOAD_BUDGET_PROBLEM_TYPE);
}

/**
 * Opens an upload session: the declared size is held to the plan limit and the part size to the bounds of a part, a
 * job must be able to start for the caller, and an anonymous caller's budget must have room for the declared size.
 */
async function openSession({ req, storage, user, instanceUri }: ActionContext): Promise<Response> {
  const { filename, mimeType, totalSize, partSize } = await readJson(req);
  if (typeof filename !== 'string' || !filename || typeof totalSize !== 'number' || !Number.isSafeInteger(totalSize)) {
    return badRequest('Missing "filename" or "totalSize" in initiation payload.', instanceUri);
  }
  if (totalSize < 0) return badRequest('totalSize cannot be negative.', instanceUri);
  const tooLarge = fileSizeLimitProblem(user, totalSize, instanceUri);
  if (tooLarge) return tooLarge;
  const partSizeProblem = partSizeProblemOf(partSize);
  if (partSizeProblem) return badRequest(partSizeProblem, instanceUri);
  const blocked = await jobStartRefusal(user, instanceUri);
  if (blocked) return blocked;

  const reserved = await reserveAnonymousUpload(user.id, totalSize, Date.now() + OPEN_UPLOAD_IDLE_MS);
  if ('refusal' in reserved) return budgetRefusalResponse(reserved.refusal, instanceUri);
  let initResult;
  try {
    initResult = await storage.initiateMultipartUpload(
      filename,
      typeof mimeType === 'string' && mimeType ? mimeType : 'application/octet-stream',
      totalSize,
      uploadOwnerOf(user.id),
      partSize as number | undefined
    );
  } catch (error) {
    await reserved.reservation.release();
    throw error;
  }
  await reserved.reservation.bind(initResult.uploadId, initResult.expiresAt);
  return NextResponse.json({ success: true, ...initResult });
}

/** An `Idempotency-Key` makes the opening safe to send again: a repeat answers with the session the first one opened. */
function initiateUpload(context: ActionContext): Promise<Response> {
  return respondOnce(context.req, uploadOwnerOf(context.user.id), context.instanceUri, () => openSession(context));
}

/** The session `uploadId` names when the caller may use it. */
async function usableSession(storage: MultipartCapableStorage, uploadId: unknown, userId: string) {
  if (typeof uploadId !== 'string' || !uploadId) return undefined;
  const session = await storage.getUploadSession(uploadId);
  return session && mayUseUploadSession(session.ownerUserId, userId) ? session : undefined;
}

function parsePartNumber(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const partNumber = Number(raw);
  return partNumber >= 1 && partNumber <= MULTIPART_MAX_PARTS ? partNumber : undefined;
}

/** The status and sentence of a failed part write: the store's own status, 413 for a bound the stream passed. */
function partFailure(error: unknown): { status: number; detail: string } {
  const detail = error instanceof Error && error.message ? error.message : 'Error processing multipart chunk';
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number') return { status, detail };
  return { status: detail.includes('exceeds') ? 413 : 400, detail };
}

/** Stores one part, held to the largest part and to what the declared size leaves after the other parts. */
async function storePart({ req, storage, user, instanceUri }: ActionContext): Promise<Response> {
  const { searchParams } = req.nextUrl;
  const uploadId = req.headers.get('x-upload-id') || searchParams.get('uploadId');
  const partNumberRaw = req.headers.get('x-part-number') || searchParams.get('partNumber');
  if (!uploadId || !partNumberRaw) return badRequest('Missing "uploadId" or "partNumber" headers.', instanceUri);
  const lengthProblem = partBodyProblem(req, instanceUri);
  if (lengthProblem) return lengthProblem;

  const session = await usableSession(storage, uploadId, user.id);
  if (!session) return notFound(instanceUri);
  const partNumber = parsePartNumber(partNumberRaw);
  if (partNumber === undefined) return badRequest(`Invalid part number: ${partNumberRaw}`, instanceUri);
  if (!req.body) return badRequest('Chunk payload is empty (0 bytes).', instanceUri);

  let otherPartsBytes = 0;
  for (const stored of (await storage.getUploadedParts(uploadId)) ?? []) {
    if (stored.partNumber !== partNumber) otherPartsBytes += stored.size;
  }
  const declaredLength = req.headers.get('content-length');
  if (declaredLength !== null && otherPartsBytes + Number(declaredLength) > session.totalSize) {
    return createProblemDetailsResponse(
      413,
      `This part would bring the upload to ${otherPartsBytes + Number(declaredLength)} bytes, past the ${session.totalSize} bytes it declared.`,
      instanceUri
    );
  }
  try {
    const partResult = await storage.uploadPartStream(uploadId, partNumber, req.body, MAX_PART_BYTES, session.totalSize, otherPartsBytes);
    await noteUploadActivity(uploadId);
    return NextResponse.json({ success: true, ...partResult });
  } catch (error: unknown) {
    const storageProblem = storageErrorResponse(error, instanceUri);
    if (storageProblem) return storageProblem;
    const failure = partFailure(error);
    return createProblemDetailsResponse(failure.status, failure.detail, instanceUri);
  }
}

interface StoredPart {
  partNumber: number;
  etag: string;
  size: number;
}

type PartSelection = { parts: Array<{ partNumber: number; etag: string }> } | { problem: string };

function sameEtag(a: string, b: string): boolean {
  return a.replace(/"/g, '') === b.replace(/"/g, '');
}

/** The stored part a listed one names, or the reason it cannot be used. */
function listedPart(listed: unknown, byNumber: ReadonlyMap<number, StoredPart>): StoredPart | string {
  const entry = listed as { partNumber?: unknown; etag?: unknown } | null;
  const partNumber = entry?.partNumber;
  if (typeof partNumber !== 'number' || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > MULTIPART_MAX_PARTS) {
    return 'Invalid part number in parts list.';
  }
  const stored = byNumber.get(partNumber);
  if (!stored) return `Missing part number ${partNumber} in multipart upload session.`;
  if (typeof entry?.etag === 'string' && entry.etag && !sameEtag(entry.etag, stored.etag)) {
    return `ETag mismatch for part number ${partNumber}.`;
  }
  return stored;
}

/**
 * The parts an upload is completed from: the listed ones, or every stored one when the request lists none. They must be
 * numbered 1, 2, 3 and so on in order, each once, and hold exactly the size declared when the session opened.
 */
function selectCompletionParts(requested: unknown, stored: readonly StoredPart[], totalSize: number): PartSelection {
  const byNumber = new Map(stored.map((part) => [part.partNumber, part] as const));
  let chosen: StoredPart[];
  if (requested === undefined) {
    chosen = [...stored].sort((a, b) => a.partNumber - b.partNumber);
  } else {
    if (!Array.isArray(requested) || requested.length === 0) return { problem: 'Missing or empty "parts" array in complete request.' };
    chosen = [];
    for (const listed of requested) {
      const part = listedPart(listed, byNumber);
      if (typeof part === 'string') return { problem: part };
      chosen.push(part);
    }
  }
  if (chosen.length === 0) return { problem: 'The upload has no part to complete.' };
  const outOfPlace = chosen.findIndex((part, index) => part.partNumber !== index + 1);
  if (outOfPlace >= 0) {
    return { problem: `The parts must be numbered 1, 2, 3 and so on in order, each once; position ${outOfPlace + 1} holds part ${chosen[outOfPlace].partNumber}.` };
  }
  const size = chosen.reduce((sum, part) => sum + part.size, 0);
  if (size !== totalSize) return { problem: `The parts hold ${size} bytes, but the upload declared ${totalSize} bytes.` };
  return { parts: chosen.map(({ partNumber, etag }) => ({ partNumber, etag })) };
}

/**
 * Completes a session whose parts hold exactly its declared size, from exactly the parts it checked, and starts the clock
 * of the upload nobody converts yet.
 */
async function completeUpload({ req, storage, user, instanceUri }: ActionContext): Promise<Response> {
  const { uploadId, parts } = await readJson(req);
  if (typeof uploadId !== 'string' || !uploadId) return badRequest('Missing required "uploadId" in complete request.', instanceUri);
  const session = await usableSession(storage, uploadId, user.id);
  if (!session) return notFound(instanceUri);

  const selection = selectCompletionParts(parts, (await storage.getUploadedParts(uploadId)) ?? [], session.totalSize);
  if ('problem' in selection) return badRequest(selection.problem, instanceUri);
  const completeResult = await storage.completeMultipartUpload(uploadId, selection.parts);
  // A part can be replaced between the listing above and the completion, so the assembled size is checked again.
  if (completeResult.size !== session.totalSize) {
    await storage.deleteObject(completeResult.key);
    return badRequest(`The assembled upload holds ${completeResult.size} bytes, but the upload declared ${session.totalSize} bytes.`, instanceUri);
  }
  await endUploadReservation(uploadId, 'completed');
  await registerCompletedUpload(storage, completeResult.key);
  return NextResponse.json({ success: true, ...completeResult });
}

async function abortUpload({ req, storage, user, instanceUri }: ActionContext): Promise<Response> {
  const { uploadId } = await readJson(req);
  if (typeof uploadId !== 'string' || !uploadId) return badRequest('Missing "uploadId"', instanceUri);
  if (!mayUseUploadSession(await storage.getUploadOwner(uploadId), user.id)) return notFound(instanceUri);
  const aborted = await storage.abortMultipartUpload(uploadId);
  if (aborted) await endUploadReservation(uploadId, 'aborted');
  return NextResponse.json({ success: aborted });
}

/** Whether `userId` may delete the stored upload `key`: an upload by its key, an account's file by its owner only. */
async function mayDiscard(storage: MultipartCapableStorage, key: string, userId: string): Promise<boolean> {
  if (!(await storage.stat(key))) return false;
  const ownership = await resolveObjectOwnership(key);
  if (!ownership.resolved) return false;
  return ownership.ownerUserId === undefined ? isUploadKey(key) : ownership.ownerUserId === userId;
}

/** Deletes a completed upload the client gave up (a failure after `complete`), unless a conversion reads it. */
async function discardCompletedUpload({ req, storage, user, instanceUri }: ActionContext): Promise<Response> {
  const { key } = await readJson(req);
  if (typeof key !== 'string' || !key) return badRequest('Missing required "key" in discard request.', instanceUri);
  if (!(await mayDiscard(storage, key, user.id))) return notFound(instanceUri);
  if (!(await discardUpload(storage, key))) {
    return createProblemDetailsResponse(409, 'A conversion is reading this upload; it is deleted after the conversion ends.', instanceUri);
  }
  return NextResponse.json({ success: true });
}

async function presign({ req, storage, user, instanceUri }: ActionContext): Promise<Response> {
  const { type = 'upload', key, partNumber, uploadId, expiresInSeconds } = await readJson(req);
  const inputProblem = presignInputProblem(key, expiresInSeconds);
  if (inputProblem) return badRequest(inputProblem, instanceUri);
  const validKey = key as string;
  const expiry = expiresInSeconds as number | undefined;
  if (type === 'upload') {
    return presignUploadPart(storage, { key: validKey, partNumber, uploadId, expiresInSeconds: expiry }, user.id, instanceUri);
  }
  if (type === 'download') return presignDownload(storage, validKey, expiry, user.id, instanceUri);
  return badRequest(PRESIGN_UNSUPPORTED, instanceUri);
}

const ACTIONS: ReadonlyMap<string, (context: ActionContext) => Promise<Response>> = new Map([
  ['initiate', initiateUpload],
  ['chunk', storePart],
  ['complete', completeUpload],
  ['abort', abortUpload],
  ['discard', discardCompletedUpload],
  ['presign', presign],
]);

function actionOf(req: NextRequest): string {
  return req.nextUrl?.searchParams.get('action') || 'initiate';
}

/** Only starting an upload takes new disk space; parts, completion and abort of a running one go on. */
function isNewMultipartUpload(req: NextRequest): boolean {
  return actionOf(req) === 'initiate';
}

function internalProblem(error: unknown, instanceUri: string): NextResponse {
  const storageProblem = storageErrorResponse(error, instanceUri);
  if (storageProblem) return storageProblem;
  console.error('Storage operation error:', error);
  const safeMessage =
    error instanceof Error && !error.message.includes('/') && !error.message.includes('\\') ? error.message : 'Storage operation error';
  return createProblemDetailsResponse(500, safeMessage, instanceUri);
}

export const POST = admittingNewFiles(async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/storage/multipart';
  const action = actionOf(req);

  // An anonymous visitor may upload in parts like a signed-in one: the burst limit of the address applies to every
  // request, its budget to every new session, and its session is reached by its random id (entry 137).
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
  if (!supportsMultipartSessions(storageProvider)) {
    return createProblemDetailsResponse(501, 'The configured storage provider does not support multipart upload sessions.', instanceUri);
  }
  const handler = ACTIONS.get(action);
  if (!handler) return badRequest(`Unknown multipart action: "${action}"`, instanceUri);
  try {
    return await handler({ req, storage: storageProvider, user: auth.user, instanceUri });
  } catch (error: unknown) {
    return internalProblem(error, instanceUri);
  }
}, isNewMultipartUpload);
