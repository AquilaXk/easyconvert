import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import {
  IdempotencyStore,
  getIdempotencyStore,
  isValidIdempotencyKey,
  buildScopedKey,
  computeFingerprint,
  compareCodeUnits,
  hashStream,
  AcquireResult,
} from './idempotency';

export const IDEMPOTENCY_KEY_REUSED_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/idempotency-key-reused';
export const IDEMPOTENCY_KEY_IN_FLIGHT_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/idempotency-key-in-flight';

/** How long the lock of a key lasts, which is also the longest a request that crashed holds its key. */
const LOCK_TTL_MS = 60_000;
/** Times a store is asked to record an answer before the lock is kept or released; the record is the same each time, so a repeat of the call is safe. */
const RECORD_ATTEMPTS = 3;
const RECORD_RETRY_DELAY_MS = 50;

function setOwnField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  const src = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(src).sort(compareCodeUnits)) {
    if (Object.hasOwn(src, key)) {
      setOwnField(sorted, key, normalizeJsonValue(src[key]));
    }
  }
  return sorted;
}

/**
 * Extracts non-file fields and hashes file blobs from multipart form data.
 */
async function extractFormDataFingerprint(formData: FormData): Promise<{
  bodyWithoutFile: Record<string, unknown>;
  fileSha256: string;
}> {
  const bodyWithoutFile: Record<string, unknown> = Object.create(null);
  const fileBlobs: { name?: string; type?: string; blob: Blob }[] = [];

  for (const [key, value] of formData.entries()) {
    if (typeof value === 'object' && value && 'stream' in value) {
      const blob = value as Blob;
      const fileObj = value as any;
      const name = typeof fileObj.name === 'string' ? fileObj.name : undefined;
      const type = typeof blob.type === 'string' ? blob.type : undefined;
      fileBlobs.push({ name, type, blob });
      if (key === 'file') {
        setOwnField(bodyWithoutFile, '_file', { name, type, size: blob.size });
      } else {
        setOwnField(bodyWithoutFile, key, { _isBlob: true, name, type, size: blob.size });
      }
    } else if (Object.hasOwn(bodyWithoutFile, key)) {
      const existing = bodyWithoutFile[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        setOwnField(bodyWithoutFile, key, [existing, value]);
      }
    } else {
      setOwnField(bodyWithoutFile, key, value);
    }
  }

  let fileSha256 = '';
  if (fileBlobs.length > 0) {
    const hashes: string[] = [];
    for (const f of fileBlobs) {
      if (f.blob.size > 0) {
        hashes.push(await hashStream(f.blob.stream() as ReadableStream<Uint8Array>));
      } else {
        hashes.push('');
      }
    }
    fileSha256 = hashes.join(':');
  }

  return { bodyWithoutFile, fileSha256 };
}

/**
 * Parses JSON or text request bodies for fingerprinting.
 */
async function extractJsonFingerprint(req: NextRequest | Request): Promise<{
  bodyWithoutFile: unknown;
  fileSha256: string;
}> {
  try {
    const text = await req.text();
    if (!text || text.trim().length === 0) {
      return { bodyWithoutFile: Object.create(null), fileSha256: '' };
    }
    try {
      const parsed = JSON.parse(text);
      return { bodyWithoutFile: normalizeJsonValue(parsed), fileSha256: '' };
    } catch {
      const rawObj: Record<string, unknown> = Object.create(null);
      setOwnField(rawObj, '_raw', text);
      return { bodyWithoutFile: rawObj, fileSha256: '' };
    }
  } catch {
    return { bodyWithoutFile: Object.create(null), fileSha256: '' };
  }
}

/**
 * Extracts the body fields excluding 'file' and hashes the 'file' stream for fingerprinting.
 */
export async function extractFingerprintData(req: NextRequest | Request): Promise<{
  bodyWithoutFile: unknown;
  fileSha256: string;
}> {
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    try {
      const formData = await req.formData();
      return await extractFormDataFingerprint(formData);
    } catch {
      return { bodyWithoutFile: {}, fileSha256: '' };
    }
  }

  return extractJsonFingerprint(req);
}

/**
 * Resolves early responses for mismatched fingerprints, in-flight locks, or cached replays.
 */
export function handleAcquireOutcome(
  acquireResult: AcquireResult,
  instanceUri: string
): NextResponse | null {
  if (acquireResult.status === 'mismatched_fingerprint') {
    return createProblemDetailsResponse(
      422,
      'An idempotency key was reused with a different request payload or parameters.',
      instanceUri,
      'Unprocessable Entity',
      IDEMPOTENCY_KEY_REUSED_PROBLEM_TYPE
    );
  }

  if (acquireResult.status === 'in_flight') {
    return createProblemDetailsResponse(
      409,
      'A request with this idempotency key is currently in-flight. Please retry later.',
      instanceUri,
      'Conflict',
      IDEMPOTENCY_KEY_IN_FLIGHT_PROBLEM_TYPE,
      { 'Retry-After': String(acquireResult.retryAfterSeconds || 1) }
    );
  }

  if (acquireResult.status === 'completed') {
    const stored = acquireResult.response;
    const headers = new Headers(stored.headers);
    headers.set('Idempotent-Replayed', 'true');
    const isNullBodyStatus =
      stored.status === 204 || stored.status === 205 || stored.status === 304;
    const responseBody = isNullBodyStatus
      ? null
      : stored.isBase64
        ? Buffer.from(stored.body, 'base64')
        : stored.body;
    return new NextResponse(responseBody, {
      status: stored.status,
      headers,
    });
  }

  return null;
}

/**
 * Stores a successful or client-error response in the idempotency store.
 */
export async function storeCompletedResponse(
  store: IdempotencyStore,
  scopedKey: string,
  fingerprint: string,
  res: NextResponse | Response
): Promise<void> {
  const clonedRes = res.clone();
  const contentType = clonedRes.headers.get('content-type') || '';
  const isBinary =
    !contentType.includes('json') &&
    !contentType.includes('text') &&
    !contentType.includes('problem');

  let bodyStr: string;
  let isBase64 = false;

  if (isBinary) {
    const buf = Buffer.from(await clonedRes.arrayBuffer());
    bodyStr = buf.toString('base64');
    isBase64 = true;
  } else {
    bodyStr = await clonedRes.text();
  }

  const headersRecord: Record<string, string> = {};
  clonedRes.headers.forEach((val, key) => {
    if (key.toLowerCase() !== 'idempotent-replayed') {
      headersRecord[key] = val;
    }
  });

  await store.complete(
    scopedKey,
    fingerprint,
    {
      status: res.status,
      headers: headersRecord,
      body: bodyStr,
      isBase64,
    },
    86400000
  );
}

export interface IdempotencyContext {
  scopedKey: string;
  fingerprint: string;
  store: IdempotencyStore;
  complete: (res: NextResponse | Response) => Promise<void>;
  /** Removes the lock of this call, and nothing else: the lock of a later run that took the key, or a recorded answer, stays. */
  abort: () => Promise<void>;
  /** Marks the lock of this call as kept until it ends, so a repeat that meets it is turned away like one that meets a running request. */
  keepLock: () => Promise<void>;
}

export interface AcquireIdempotencyResult {
  response?: NextResponse | Response;
  context?: IdempotencyContext;
}

export interface AcquireIdempotencyOptions {
  /** The store to lock in; the process-wide one when absent. */
  store?: IdempotencyStore;
  /**
   * The JSON body of `req`, when the caller already read it: it is fingerprinted as it is and the request is not read
   * again. A caller that reduces a body which is not an object to an empty one gives all such bodies one fingerprint,
   * which only matters for an answer that is stored, and a caller does that only for actions that refuse such a body.
   */
  parsedBody?: unknown;
}

/** Acquires idempotency lock or returns early replay/conflict response. */
export async function acquireIdempotency(
  req: NextRequest | Request,
  userId: string,
  rawKey: string,
  instanceUri: string,
  { store, parsedBody }: AcquireIdempotencyOptions = {}
): Promise<AcquireIdempotencyResult> {
  if (!isValidIdempotencyKey(rawKey)) {
    return {
      response: createProblemDetailsResponse(
        400,
        'Idempotency-Key header must contain 1 to 255 printable ASCII characters.',
        instanceUri,
        'Bad Request'
      ),
    };
  }

  const { bodyWithoutFile, fileSha256 } =
    parsedBody === undefined ? await extractFingerprintData(req.clone()) : { bodyWithoutFile: parsedBody, fileSha256: '' };
  const fingerprint = computeFingerprint(req.method, instanceUri, bodyWithoutFile, fileSha256);
  const scopedKey = buildScopedKey(userId, instanceUri, rawKey);
  const activeStore = store || getIdempotencyStore();

  const lockToken = crypto.randomUUID();
  const acquireResult = await activeStore.acquire(scopedKey, fingerprint, LOCK_TTL_MS, lockToken);
  const earlyResponse = handleAcquireOutcome(acquireResult, instanceUri);
  if (earlyResponse) {
    return { response: earlyResponse };
  }

  return {
    context: {
      scopedKey,
      fingerprint,
      store: activeStore,
      complete: async (res: NextResponse | Response) => {
        if (res.status >= 500) {
          await activeStore.releaseLock(scopedKey, lockToken);
        } else {
          await storeCompletedResponse(activeStore, scopedKey, fingerprint, res);
        }
      },
      abort: async () => {
        await activeStore.releaseLock(scopedKey, lockToken);
      },
      keepLock: async () => {
        await activeStore.keepLock(scopedKey, lockToken);
      },
    },
  };
}

/** What `respondOnce` does with the lock of a key when the store cannot record the answer the handler gave. */
export type AfterFailedRecord = 'keep-lock' | 'release';

export interface RespondOnceOptions extends Pick<AcquireIdempotencyOptions, 'parsedBody'> {
  /**
   * `keep-lock` for an action that creates something a second run would create again (a job, an upload session): the
   * lock stays, and a repeat gets the same 409 and one-second `Retry-After` as a repeat that meets a running request.
   * The lock bounds the repeats for the minute it lasts; a repeat sent after that runs the action again. `release` for an action whose repeat finds the
   * state the first run left and answers from it, as `complete` does: the next repeat runs the action and gets that
   * answer.
   */
  afterFailedRecord: AfterFailedRecord;
}

/**
 * Runs `handler` once per `Idempotency-Key` of `scopeUserId` on this route (IETF Idempotency-Key header draft). A repeat
 * of the same request gets the first answer, so a client may send it again after a network error and learns what the
 * first one created; a repeat while the first runs gets 409 with `Retry-After`. Only a success is kept: after a refusal
 * the same request may be sent again. Without the header the handler just runs.
 *
 * Once the handler returned, its answer is returned even when the store cannot record it. The store is asked three
 * times, and `afterFailedRecord` says what happens to the lock when all fail. A handler that threw, or answered with a
 * refusal, releases the key. A release removes only the lock this call took (compare-and-delete on a random value, as
 * the Redis lock pattern does), so a call that outlived its lock never removes the lock of the run that took the key
 * after it, and a recorded answer is never removed. A release that fails is logged; the lock then ends when its time
 * runs out.
 */
export async function respondOnce(
  req: NextRequest | Request,
  scopeUserId: string,
  instanceUri: string,
  handler: () => Promise<Response>,
  { parsedBody, afterFailedRecord }: RespondOnceOptions
): Promise<Response> {
  const rawKey = req.headers.get('idempotency-key');
  if (rawKey === null) return handler();
  const { response, context } = await acquireIdempotency(req, scopeUserId, rawKey, instanceUri, { parsedBody });
  if (!context) return response as Response;
  let res: Response;
  try {
    res = await handler();
  } catch (error) {
    await settleLock(context, 'release', instanceUri);
    throw error;
  }
  if (!res.ok) {
    await settleLock(context, 'release', instanceUri);
    return res;
  }
  if (!(await recordAnswer(context, res, instanceUri))) await settleLock(context, afterFailedRecord, instanceUri);
  return res;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Asks the store to record `res` up to RECORD_ATTEMPTS times; false, with the last error logged, when none took it. */
async function recordAnswer(context: IdempotencyContext, res: Response, instanceUri: string): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt++) {
    try {
      await context.complete(res);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < RECORD_ATTEMPTS) await delay(RECORD_RETRY_DELAY_MS * attempt);
    }
  }
  console.warn(`[idempotency] Could not record the answer of ${instanceUri}; the answer is returned without a replay:`, lastError);
  return false;
}

/** Releases or keeps the lock of this call, whatever the store does: the answer or the error the caller is about to give must not change. */
async function settleLock(context: IdempotencyContext, how: AfterFailedRecord, instanceUri: string): Promise<void> {
  try {
    await (how === 'release' ? context.abort() : context.keepLock());
  } catch (error) {
    const outcome = how === 'release' ? 'release the idempotency key' : 'mark the idempotency key as kept';
    console.warn(`[idempotency] Could not ${outcome} of ${instanceUri}; it ends when its lock expires:`, error);
  }
}
