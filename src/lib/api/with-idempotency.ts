import { NextRequest, NextResponse } from 'next/server';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import {
  IdempotencyStore,
  getIdempotencyStore,
  isValidIdempotencyKey,
  buildScopedKey,
  computeFingerprint,
  hashStream,
  AcquireResult,
} from './idempotency';

export const IDEMPOTENCY_KEY_REUSED_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/idempotency-key-reused';
export const IDEMPOTENCY_KEY_IN_FLIGHT_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/idempotency-key-in-flight';

/**
 * Extracts non-file fields and hashes file blobs from multipart form data.
 */
async function extractFormDataFingerprint(formData: FormData): Promise<{
  bodyWithoutFile: Record<string, unknown>;
  fileSha256: string;
}> {
  const bodyWithoutFile: Record<string, unknown> = {};
  const fileBlobs: { name?: string; type?: string; blob: Blob }[] = [];

  for (const [key, value] of formData.entries()) {
    if (typeof value === 'object' && value && 'stream' in value) {
      const blob = value as Blob;
      const fileObj = value as any;
      const name = typeof fileObj.name === 'string' ? fileObj.name : undefined;
      const type = typeof blob.type === 'string' ? blob.type : undefined;
      fileBlobs.push({ name, type, blob });
      if (key === 'file') {
        bodyWithoutFile._file = { name, type, size: blob.size };
      } else {
        bodyWithoutFile[key] = { _isBlob: true, name, type, size: blob.size };
      }
    } else if (key in bodyWithoutFile) {
      const existing = bodyWithoutFile[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        bodyWithoutFile[key] = [existing, value];
      }
    } else {
      bodyWithoutFile[key] = value;
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
      return { bodyWithoutFile: {}, fileSha256: '' };
    }
    try {
      const parsed = JSON.parse(text);
      return { bodyWithoutFile: parsed, fileSha256: '' };
    } catch {
      return { bodyWithoutFile: { _raw: text }, fileSha256: '' };
    }
  } catch {
    return { bodyWithoutFile: {}, fileSha256: '' };
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
  abort: () => Promise<void>;
  renewLock?: (ttlMs?: number) => Promise<boolean>;
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

  const acquireResult = await activeStore.acquire(scopedKey, fingerprint, 60000);
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
          await activeStore.delete(scopedKey);
        } else {
          await storeCompletedResponse(activeStore, scopedKey, fingerprint, res);
        }
      },
      abort: async () => {
        await activeStore.delete(scopedKey);
      },
      renewLock: async (ttlMs: number = 60000) => {
        if (activeStore.renewLock) {
          return activeStore.renewLock(scopedKey, ttlMs);
        }
        return false;
      },
    },
  };
}

/** What `respondOnce` does with the lock of a key when the store cannot record the answer the handler gave. */
export type AfterFailedRecord = 'keep-lock' | 'release';

export interface RespondOnceOptions extends Pick<AcquireIdempotencyOptions, 'parsedBody'> {
  /**
   * `keep-lock` for an action that creates something a second run would create again (a job, an upload session): the
   * lock stays, so a repeat gets 409 until it expires (a minute), never a second run. `release` for an action whose
   * repeat finds the state the first run left and answers from it, as `complete` does: the next repeat runs the action
   * and gets that answer.
   */
  afterFailedRecord: AfterFailedRecord;
}

/**
 * Runs `handler` once per `Idempotency-Key` of `scopeUserId` on this route. A repeat of the same request gets the first
 * answer, so a client may send it again after a network error and learns what the first one created; a repeat while the
 * first runs gets 409 with `Retry-After`. Only a success is kept: after a refusal the same request may be sent again.
 * Without the header the handler just runs.
 *
 * Once the handler returned, its answer is returned even when the store cannot record it, and `afterFailedRecord` says
 * what happens to the lock. A handler that threw, or answered with a refusal, releases the key. A release that fails is
 * logged; the lock then ends when its time runs out. A release leaves a recorded answer alone, so a good replay is never
 * deleted; it cannot tell this call's lock from the equal lock of a second run that took the key after a lock outlived
 * its minute, and removes that one too.
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
    await releaseQuietly(context, instanceUri);
    throw error;
  }
  if (!res.ok) {
    await releaseQuietly(context, instanceUri);
    return res;
  }
  try {
    await context.complete(res);
  } catch (error) {
    console.warn(`[idempotency] Could not record the answer of ${instanceUri}; the answer is returned without a replay:`, error);
    if (afterFailedRecord === 'release') await releaseQuietly(context, instanceUri);
  }
  return res;
}

/**
 * Releases the lock of a key, whatever the store does: the answer or the error the caller is about to give must not
 * change. A key that already holds a recorded answer is left as it is: the store took the answer and only its reply was
 * lost, so the record is the replay.
 */
async function releaseQuietly(context: IdempotencyContext, instanceUri: string): Promise<void> {
  try {
    const held = context.store.getRecord ? await context.store.getRecord(context.scopedKey) : null;
    if (held?.status !== 'completed') await context.abort();
  } catch (error) {
    console.warn(`[idempotency] Could not release the idempotency key of ${instanceUri}; it ends when its lock expires:`, error);
  }
}
