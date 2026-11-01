import { NextRequest, NextResponse } from 'next/server';
import type { User } from '@/lib/auth/types';
import type { MultipartUploadComplete } from '@/lib/types';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { discardUpload, mayPresignDownload, registerCompletedUpload, removeUnregistered } from '@/lib/storage/retention-service';
import { MULTIPART_MAX_PARTS, storageProvider } from '@/lib/storage';
import type { IStorageBackend, UploadSessionInfo } from '@/lib/storage/oci-storage';
import { isUploadKey } from '@/lib/storage/key-namespace';
import { validateApiAccess, authErrorHeaders, getQuotaUsage } from '@/lib/api-keys/guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { isNoSuchUploadError, uploadSessionNotFoundResponse } from '@/lib/api/storage-error-response';
import { STORAGE_OBJECT_NOT_FOUND, resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { fileSizeLimitProblem, partBodyProblem } from '@/lib/api/file-size-limit';
import { respondOnce } from '@/lib/api/with-idempotency';
import { UPLOAD_PART_MAX_BYTES } from '@/lib/plan-limits';
import { isAnonymousUserId, isUnattributedAnonymous, mayUseUploadSession, uploadOwnerOf } from '@/lib/auth/anonymous-identity';
import {
  ANONYMOUS_DAILY_UPLOAD_BYTES,
  ANONYMOUS_OPEN_UPLOADS_MAX,
  OPEN_UPLOAD_IDLE_MS,
  endUploadReservation,
  reserveAnonymousUpload,
  resumeUploadReservation,
  type BudgetRefusal,
} from '@/lib/api-keys/anonymous-upload-budget';
import { forgetUploadParts, receivePart } from '@/lib/storage/part-admission';
import { declaredPartBytes, partFailureResponse, uploadErrorResponse, uploadUnavailableResponse } from '@/lib/api/part-response';
import { isUploadIdShape } from '@/lib/storage/upload-id';
import { digestOfPartList, recallUploadCompletion, rememberUploadCompletion } from '@/lib/storage/upload-completion';
import { concurrencyLimitResponse, mayEnqueue } from '@/lib/queue/concurrency-limit';
import { formatBytes } from '@/lib/format-bytes';
import { DOWNLOAD_PRESIGN_MAX_SECONDS, PART_URL_TTL_SECONDS } from '@/lib/storage/presign-limits';
import { PRESIGN_MAX_EXPIRES_SECONDS, PRESIGN_MIN_EXPIRES_SECONDS, SigV4SigningError, assertValidObjectKey } from '@/lib/storage/s3-sigv4';

export const dynamic = 'force-dynamic';

const MAX_PART_BYTES = UPLOAD_PART_MAX_BYTES;
/** The smallest part an object store takes for a part that is not the last (the S3 rule). */
const MIN_PART_BYTES = 5 * 1024 * 1024;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVICE_UNAVAILABLE = 503;
const QUOTA_EXCEEDED_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/quota-exceeded';
const UPLOAD_BUDGET_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/upload-budget-exceeded';
const TRUST_UNCONFIGURED_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/client-ip-trust-unconfigured';
const UNATTRIBUTED_UPLOAD_DETAIL =
  'Uploads without an account are off until this server can tell visitors apart: set TRUSTED_PROXIES to the proxies in front of it. Sign in to upload meanwhile.';
const ANONYMOUS_PRESIGN_REFUSED =
  'An upload without an account sends its parts through action=chunk, which holds them to the size it declared; it gets no signed part link.';

/** The detail of a failure the caller may not send again; the error itself, which can name a host or a path, stays in the log. */
const FAILURE_DETAIL = 'Storage operation error';
const UNRECORDED_UPLOAD_DETAIL = 'The upload could not be recorded, so it cannot be converted. Upload the file again.';

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
  /** The JSON body of the request, read once for the action and its idempotency key; empty for a part, whose body is its bytes. */
  body: Body;
}

type Body = Record<string, unknown>;

/**
 * The JSON body of `req` as an object, or an empty one: a body that is not an object names no field any action reads.
 * All such bodies then share one idempotency fingerprint, which no answer is stored under, since every action refuses them.
 */
function readJson(req: Request): Promise<Body> {
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
    return uploadSessionNotFoundResponse(instanceUri);
  }
  if (isAnonymousUserId(session.ownerUserId)) {
    return createProblemDetailsResponse(HTTP_FORBIDDEN, ANONYMOUS_PRESIGN_REFUSED, instanceUri);
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
 * The 503 for an anonymous caller while no client can be attributed: every visitor would share one budget, which one
 * of them could use up for all, so anonymous uploads stay off until the proxies are declared (docs/client-ip-trust.md).
 */
function unattributedUploadRefusal(instanceUri: string): NextResponse {
  return createProblemDetailsResponse(HTTP_SERVICE_UNAVAILABLE, UNATTRIBUTED_UPLOAD_DETAIL, instanceUri, 'Service Unavailable', TRUST_UNCONFIGURED_PROBLEM_TYPE);
}

/**
 * Opens an upload session: the declared size is held to the plan limit and the part size to the bounds of a part, a
 * job must be able to start for the caller, and an anonymous caller's budget must have room for the declared size.
 */
async function openSession({ storage, user, instanceUri, body }: ActionContext): Promise<Response> {
  if (isUnattributedAnonymous(user.id)) return unattributedUploadRefusal(instanceUri);
  const { filename, mimeType, totalSize, partSize } = body;
  if (typeof filename !== 'string' || !filename || typeof totalSize !== 'number' || !Number.isSafeInteger(totalSize)) {
    return badRequest('Missing "filename" or "totalSize" in initiation payload.', instanceUri);
  }
  if (totalSize < 1) return badRequest('"totalSize" must be at least 1 byte.', instanceUri);
  const tooLarge = fileSizeLimitProblem(user, totalSize, instanceUri);
  if (tooLarge) return tooLarge;
  const partSizeProblem = partSizeProblemOf(partSize);
  if (partSizeProblem) return badRequest(partSizeProblem, instanceUri);
  const blocked = await jobStartRefusal(user, instanceUri);
  if (blocked) return blocked;

  const reserved = await reserveAnonymousUpload(user.id, totalSize, Date.now() + OPEN_UPLOAD_IDLE_MS);
  if ('refusal' in reserved) return budgetRefusalResponse(reserved.refusal, instanceUri);
  let uploadId: string | undefined;
  try {
    const initResult = await storage.initiateMultipartUpload(
      filename,
      typeof mimeType === 'string' && mimeType ? mimeType : 'application/octet-stream',
      totalSize,
      uploadOwnerOf(user.id),
      partSize as number | undefined
    );
    uploadId = initResult.uploadId;
    await reserved.reservation.bind(initResult.uploadId, initResult.expiresAt);
    return NextResponse.json({ success: true, ...initResult });
  } catch (error) {
    // Nothing the failed opening made stays: the session is aborted and the budget given back, each whatever the other
    // does, and the answer names the opening's own error. A session whose abort failed ends when it expires.
    try {
      if (uploadId) await storage.abortMultipartUpload(uploadId);
    } catch (abortError) {
      console.warn('[multipart] Could not abort the session of a failed opening; it ends when it expires:', abortError);
    } finally {
      await reserved.reservation.release().catch((releaseError: unknown) => {
        console.warn('[multipart] Could not give back the budget of a failed opening; it returns when the reservation expires:', releaseError);
      });
    }
    throw error;
  }
}

/**
 * An `Idempotency-Key` makes a request that creates something safe to send again: a repeat answers with what the first
 * one created. Keys are scoped to the caller: an account, or the address bucket of an anonymous caller, so a key
 * another visitor chose never answers with this visitor's upload.
 */
function onceForCaller(context: ActionContext, handler: (context: ActionContext) => Promise<Response>): Promise<Response> {
  return respondOnce(context.req, context.user.id, context.instanceUri, () => handler(context), { parsedBody: context.body, afterFailedRecord: 'keep-lock' });
}

function initiateUpload(context: ActionContext): Promise<Response> {
  return onceForCaller(context, openSession);
}

/** A session with the owner it recorded, which every session the caller may use has. */
type OwnedSession = UploadSessionInfo & { ownerUserId: string };

/** The session `uploadId` names when the caller may use it. */
async function usableSession(storage: MultipartCapableStorage, uploadId: unknown, userId: string): Promise<OwnedSession | undefined> {
  if (typeof uploadId !== 'string' || !uploadId) return undefined;
  const session = await storage.getUploadSession(uploadId);
  return session?.ownerUserId && mayUseUploadSession(session.ownerUserId, userId) ? { ...session, ownerUserId: session.ownerUserId } : undefined;
}

function parsePartNumber(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const partNumber = Number(raw);
  return partNumber >= 1 && partNumber <= MULTIPART_MAX_PARTS ? partNumber : undefined;
}

/** Actions that change an open session and may be sent again: a part, the completion, the abort. */
const RETRYABLE_ACTIONS: ReadonlySet<string> = new Set(['chunk', 'complete', 'abort']);

/**
 * The answer to a request that failed with an error no HTTP status was given to: the store or the budget could not be
 * reached, so it is worth sending again (503), except on the actions that create something new (500).
 */
function unexpectedFailure(error: unknown, action: string, instanceUri: string): NextResponse {
  console.error(`[multipart] ${action} failed:`, error);
  return RETRYABLE_ACTIONS.has(action) ? uploadUnavailableResponse(instanceUri) : createProblemDetailsResponse(500, FAILURE_DETAIL, instanceUri);
}

/**
 * Keeps a session counted as open while its parts arrive, or refuses a part of an idle session past the most open ones.
 * A budget that cannot be reached does not refuse the part: its bytes were reserved when the session opened.
 */
async function openSessionRefusal(uploadId: string, instanceUri: string): Promise<NextResponse | null> {
  try {
    const refusal = await resumeUploadReservation(uploadId);
    return refusal ? budgetRefusalResponse(refusal, instanceUri) : null;
  } catch (error) {
    console.warn(`[multipart] Could not note the activity of an upload; the part is taken:`, error);
    return null;
  }
}

/** Stores one part, held to the largest part and to what the declared size leaves after the other parts, stored and on the way. */
async function storePart({ req, storage, user, instanceUri }: ActionContext): Promise<Response> {
  const { searchParams } = req.nextUrl;
  const uploadId = req.headers.get('x-upload-id') || searchParams.get('uploadId');
  const partNumberRaw = req.headers.get('x-part-number') || searchParams.get('partNumber');
  if (!uploadId || !partNumberRaw) return badRequest('Missing "uploadId" or "partNumber" headers.', instanceUri);
  const lengthProblem = partBodyProblem(req, instanceUri);
  if (lengthProblem) return lengthProblem;

  const session = await usableSession(storage, uploadId, user.id);
  if (!session) return uploadSessionNotFoundResponse(instanceUri);
  const partNumber = parsePartNumber(partNumberRaw);
  if (partNumber === undefined) return badRequest(`Invalid part number: ${partNumberRaw}`, instanceUri);
  if (!req.body) return badRequest('Chunk payload is empty (0 bytes).', instanceUri);
  const budgetRefusal = await openSessionRefusal(uploadId, instanceUri);
  if (budgetRefusal) return budgetRefusal;

  try {
    const partResult = await receivePart(
      storage,
      { uploadId, partNumber, declaredBytes: declaredPartBytes(req.headers), totalSize: session.totalSize, maxPartBytes: MAX_PART_BYTES },
      req.body
    );
    return NextResponse.json({ success: true, ...partResult });
  } catch (error: unknown) {
    return partFailureResponse(error, instanceUri);
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
 * The answer the completion of `uploadId` gave, for a repeat that finds the store has consumed the session: the receipt
 * kept at completion, for the owner the session recorded, for a repeat that lists the same parts as the first request
 * (an object store answers a repeat of a completion the same way), and while the file it names is stored. It needs no
 * idempotency store, so it answers also when that store could not keep the first answer. A receipt that cannot be read
 * is not a missing one: the repeat is answered 503 with `Retry-After`, and the session does not look gone.
 */
async function answerOfCompletedUpload(storage: MultipartCapableStorage, uploadId: string, userId: string, parts: unknown, instanceUri: string): Promise<Response | undefined> {
  if (!isUploadIdShape(uploadId)) return undefined;
  let completion;
  try {
    completion = await recallUploadCompletion(uploadId);
  } catch (error) {
    console.error('[multipart] Could not read the receipt of a completed upload:', error);
    return uploadUnavailableResponse(instanceUri);
  }
  if (!completion || !mayUseUploadSession(completion.ownerUserId, userId) || completion.partsDigest !== digestOfPartList(parts)) return undefined;
  if (!(await storage.stat(completion.result.key))) return undefined;
  return NextResponse.json({ success: true, ...completion.result });
}

/** Keeps the answer of a completion for a repeat. A receipt that cannot be written costs only that repeat, not the completion. */
async function keepAnswerOfCompletion(uploadId: string, ownerUserId: string, parts: unknown, result: MultipartUploadComplete): Promise<void> {
  try {
    await rememberUploadCompletion(uploadId, { ownerUserId, partsDigest: digestOfPartList(parts), result });
  } catch (error) {
    console.warn('[multipart] Could not keep the receipt of a completed upload; a repeat of its completion finds no session:', error);
  }
}

/**
 * Completes a session whose parts hold exactly its declared size, from exactly the parts it checked, and records the
 * upload, so that a job reading it holds it, before its budget is closed. The completion is the same action when it is
 * sent again: a session the store already consumed answers with the first completion's answer.
 */
async function finishSession(context: ActionContext): Promise<Response> {
  const { storage, user, instanceUri, body } = context;
  const { uploadId, parts } = body;
  if (typeof uploadId !== 'string' || !uploadId) return badRequest('Missing required "uploadId" in complete request.', instanceUri);
  const answerOfEndedSession = async () => (await answerOfCompletedUpload(storage, uploadId, user.id, parts, instanceUri)) ?? uploadSessionNotFoundResponse(instanceUri);
  const session = await usableSession(storage, uploadId, user.id);
  if (!session) return answerOfEndedSession();
  try {
    return await completeOpenSession(storage, session, parts, instanceUri);
  } catch (error) {
    // An object store keeps handing out a session until it expires, so a repeat finds it ended only when the store says so.
    if (isNoSuchUploadError(error)) return answerOfEndedSession();
    throw error;
  }
}

async function completeOpenSession(storage: MultipartCapableStorage, session: OwnedSession, parts: unknown, instanceUri: string): Promise<Response> {
  const { uploadId } = session;
  const selection = selectCompletionParts(parts, (await storage.getUploadedParts(uploadId)) ?? [], session.totalSize);
  if ('problem' in selection) return badRequest(selection.problem, instanceUri);
  const completeResult = await storage.completeMultipartUpload(uploadId, selection.parts);
  // The store consumed the session, so from here every answer is final: a repeat would find no session to complete.
  forgetUploadParts(uploadId);
  // A part can be replaced between the listing above and the completion, so the assembled size is checked again.
  if (completeResult.size !== session.totalSize) {
    await removeUnregistered(storage, completeResult.key);
    await closeReservation(uploadId, 'aborted');
    return badRequest(`The assembled upload holds ${completeResult.size} bytes, but the upload declared ${session.totalSize} bytes.`, instanceUri);
  }
  try {
    await registerCompletedUpload(storage, completeResult.key);
  } catch (error) {
    console.error('[multipart] Could not record a completed upload, which was removed:', error);
    await closeReservation(uploadId, 'aborted');
    return createProblemDetailsResponse(500, UNRECORDED_UPLOAD_DETAIL, instanceUri);
  }
  await keepAnswerOfCompletion(uploadId, session.ownerUserId, parts, completeResult);
  await closeReservation(uploadId, 'completed');
  return NextResponse.json({ success: true, ...completeResult });
}

/**
 * An `Idempotency-Key` lets a client whose answer was lost ask again which file the completion stored. The key is scoped
 * to the upload and the owner its session records, not to the address bucket: an anonymous visitor holds the upload by
 * its id, and keeps getting the first answer when its address moves to another bucket. A repeat is authorised by the key
 * value alone, which only the client that sent the first request knows, as the upload id is.
 */
async function completeUpload(context: ActionContext): Promise<Response> {
  const { uploadId } = context.body;
  if (!isUploadIdShape(uploadId)) return finishSession(context);
  return respondOnce(context.req, `${uploadOwnerOf(context.user.id)}:${uploadId}`, context.instanceUri, () => finishSession(context), {
    parsedBody: context.body,
    afterFailedRecord: 'release',
  });
}

/**
 * Ends the budget reservation of a session the store already closed. A budget that cannot be reached does not change the
 * answer: the reservation then ends when it expires, which returns the bytes of a completed upload too.
 */
async function closeReservation(uploadId: string, outcome: 'completed' | 'aborted'): Promise<void> {
  await endUploadReservation(uploadId, outcome).catch((error: unknown) => {
    console.warn(`[multipart] Could not close the budget of the ${outcome} upload; it ends when the reservation expires:`, error);
  });
}

/**
 * Aborts a session and gives its budget back. The abort is answered once the store took it: a budget that cannot be
 * reached then keeps the bytes until the session's reservation expires, which returns them.
 */
async function abortUpload({ storage, user, instanceUri, body }: ActionContext): Promise<Response> {
  const { uploadId } = body;
  if (typeof uploadId !== 'string' || !uploadId) return badRequest('Missing "uploadId"', instanceUri);
  if (!mayUseUploadSession(await storage.getUploadOwner(uploadId), user.id)) return uploadSessionNotFoundResponse(instanceUri);
  let aborted = false;
  try {
    aborted = await storage.abortMultipartUpload(uploadId);
    return NextResponse.json({ success: aborted });
  } finally {
    forgetUploadParts(uploadId);
    if (aborted) await closeReservation(uploadId, 'aborted');
  }
}

/** Whether `userId` may delete the stored upload `key`: an upload by its key, an account's file by its owner only. */
async function mayDiscard(storage: MultipartCapableStorage, key: string, userId: string): Promise<boolean> {
  if (!(await storage.stat(key))) return false;
  const ownership = await resolveObjectOwnership(key);
  if (!ownership.resolved) return false;
  return ownership.ownerUserId === undefined ? isUploadKey(key) : ownership.ownerUserId === userId;
}

/** Deletes a completed upload the client gave up (a failure after `complete`), unless a conversion reads it. */
async function discardCompletedUpload({ storage, user, instanceUri, body }: ActionContext): Promise<Response> {
  const { key } = body;
  if (typeof key !== 'string' || !key) return badRequest('Missing required "key" in discard request.', instanceUri);
  if (!(await mayDiscard(storage, key, user.id))) return notFound(instanceUri);
  if (!(await discardUpload(storage, key))) {
    return createProblemDetailsResponse(409, 'A conversion is reading this upload; it is deleted after the conversion ends.', instanceUri);
  }
  return NextResponse.json({ success: true });
}

async function presign({ storage, user, instanceUri, body }: ActionContext): Promise<Response> {
  const { type = 'upload', key, partNumber, uploadId, expiresInSeconds } = body;
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

interface ActionSpec {
  run: (context: ActionContext) => Promise<Response>;
  /** The body of the request is the bytes of a part, which the action streams: the dispatcher leaves it unread. */
  streamsBody?: boolean;
}

const ACTIONS: ReadonlyMap<string, ActionSpec> = new Map([
  ['initiate', { run: initiateUpload }],
  ['chunk', { run: storePart, streamsBody: true }],
  ['complete', { run: completeUpload }],
  ['abort', { run: abortUpload }],
  ['discard', { run: discardCompletedUpload }],
  ['presign', { run: presign }],
]);

function actionOf(req: NextRequest): string {
  return req.nextUrl?.searchParams.get('action') || 'initiate';
}

/** Only starting an upload takes new disk space; parts, completion and abort of a running one go on. */
function isNewMultipartUpload(req: NextRequest): boolean {
  return actionOf(req) === 'initiate';
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
  const spec = ACTIONS.get(action);
  if (!spec) return badRequest(`Unknown multipart action: "${action}"`, instanceUri);
  try {
    return await spec.run({ req, storage: storageProvider, user: auth.user, instanceUri, body: spec.streamsBody ? {} : await readJson(req) });
  } catch (error: unknown) {
    return uploadErrorResponse(error, instanceUri, action) ?? unexpectedFailure(error, action, instanceUri);
  }
}, isNewMultipartUpload);
