import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders, ApiAuthResult } from '@/lib/api-keys/guard';
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

export interface WithIdempotencyOptions {
  requiredScope?: string;
  store?: IdempotencyStore;
}

export type IdempotentRouteHandler = (
  req: NextRequest,
  authOrContext?: any
) => Promise<NextResponse | Response>;

/**
 * Extracts non-file fields and hashes file blobs from multipart form data.
 */
async function extractFormDataFingerprint(formData: FormData): Promise<{
  bodyWithoutFile: Record<string, unknown>;
  fileSha256: string;
}> {
  const bodyWithoutFile: Record<string, unknown> = {};
  let fileBlob: Blob | null = null;

  for (const [key, value] of formData.entries()) {
    if (key === 'file' && typeof value === 'object' && value && 'stream' in value) {
      fileBlob = value as Blob;
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
  if (fileBlob && fileBlob.size > 0) {
    fileSha256 = await hashStream(fileBlob.stream() as ReadableStream<Uint8Array>);
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
    const responseBody = stored.isBase64
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
}

export interface AcquireIdempotencyResult {
  response?: NextResponse | Response;
  context?: IdempotencyContext;
}

/**
 * Acquires idempotency lock or returns early replay/conflict response.
 */
export async function acquireIdempotency(
  req: NextRequest | Request,
  userId: string,
  rawKey: string,
  instanceUri: string,
  store?: IdempotencyStore
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

  const cloned = req.clone();
  const { bodyWithoutFile, fileSha256 } = await extractFingerprintData(cloned);
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
    },
  };
}

/**
 * Next.js Route Handler wrapper enforcing IETF Idempotency-Key HTTP semantics.
 */
export function withIdempotency(
  handler: IdempotentRouteHandler,
  options?: WithIdempotencyOptions
): (req: NextRequest, context?: any) => Promise<NextResponse | Response> {
  return async function wrappedRouteHandler(
    req: NextRequest,
    context?: any
  ): Promise<NextResponse | Response> {
    const rawKey = req.headers.get('idempotency-key');
    if (rawKey === null) {
      return handler(req, context);
    }

    const instanceUri = req.nextUrl?.pathname || new URL(req.url).pathname;

    const auth: ApiAuthResult =
      context && typeof context === 'object' && 'authorized' in context
        ? context
        : await validateApiAccess(req, {
            requiredUnits: 0,
            requiredScope: options?.requiredScope ?? 'convert:write',
          });

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

    const acquired = await acquireIdempotency(
      req,
      auth.user.id,
      rawKey,
      instanceUri,
      options?.store
    );

    if (acquired.response) {
      return acquired.response;
    }

    const ctx = acquired.context!;
    try {
      const res = await handler(req, auth);
      await ctx.complete(res);
      return res;
    } catch (err) {
      await ctx.abort();
      throw err;
    }
  };
}
