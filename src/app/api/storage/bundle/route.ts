import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { Readable } from 'node:stream';
import { storageProvider as s3Storage } from '@/lib/storage';
import { resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { authErrorHeaders, extractApiKeySecret, extractClientIp, validateApiAccess, type ApiAuthResult } from '@/lib/api-keys/guard';
import { anonymousUserId, isAnonymousUserId } from '@/lib/auth/anonymous-identity';
import type { User, UserTier } from '@/lib/auth/types';
import { CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS, ClientIpError, rateLimitKey } from '@/lib/security/client-ip';
import { DOWNLOAD_SECURITY_HEADERS, attachmentContentDisposition } from '@/lib/api/content-disposition';
import { deliveryTrackedStream } from '@/lib/api/delivery-stream';
import { readBoundedJsonText } from '@/lib/api/json-body-bounds';
import { SMALL_REQUEST_BODY_MAX_BYTES } from '@/lib/api/request-body-limit';
import { acquireSyncSlot, concurrencyLimitResponse } from '@/lib/queue/concurrency-limit';
import { jobDeadlineMs, syncDeadlineMs } from '@/lib/queue/job-deadline';
import { MAX_EXTRACTED_ENTRIES } from '@/lib/tools/tool-names';
import { consumeBundleTicket, createBundleTicket } from '@/lib/storage/bundle-ticket-store';
import { deleteResult, recordServed, resultAvailability } from '@/lib/storage/retention-service';
import { isRetainedKey, type RetentionReason } from '@/lib/storage/result-retention';
import { streamZipReadable, type StreamingZipEntry } from '@/lib/archive/streaming-zip';
import { sanitizeNodeOutputFilename } from '@/lib/queue/graph/node-jobs';
import { JobTimeoutError } from '@/lib/types';

export const dynamic = 'force-dynamic';

const STORAGE_DOWNLOAD_SCOPE = 'storage:download';
const PRIVATE_NO_STORE = 'private, no-store';
const MAX_BUNDLE_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const VERIFICATION_BATCH_CONCURRENCY = 16;

const GONE_MESSAGE =
  'This file was deleted. A result is deleted shortly after it has been downloaded completely, or when nobody downloaded it in time. Convert the file again to get a new one.';
const CAPACITY_GONE_MESSAGE =
  'This file was deleted early because the server ran out of disk space. Convert the file again to get a new one.';

interface BundleFileRequest {
  key: string;
  name: string;
}

interface BundleRequestBody {
  files: BundleFileRequest[];
  archiveName?: string;
}

interface VerifiedBundleFile {
  key: string;
  name: string;
  size: number;
}

function deduplicateFileNames(items: readonly BundleFileRequest[]): string[] {
  const used = new Set<string>();
  return items.map((item, index) => {
    const candidateName = typeof item.name === 'string' && item.name ? item.name : path.basename(item.key);
    const rawLeaf = path.basename(candidateName).trim() || `file_${index + 1}`;
    const sanitized = sanitizeNodeOutputFilename(rawLeaf, `file_${index + 1}`);
    const { name: stem, ext } = path.parse(sanitized);
    let candidate = sanitized;
    for (let copy = 1; used.has(candidate); copy++) {
      candidate = `${stem} (${copy})${ext}`;
    }
    used.add(candidate);
    return candidate;
  });
}

function sanitizeArchiveName(rawName?: string): string {
  if (!rawName || typeof rawName !== 'string') return 'files.zip';
  const leaf = path.basename(rawName.trim());
  const sanitized = sanitizeNodeOutputFilename(leaf, 'files.zip');
  return sanitized.toLowerCase().endsWith('.zip') ? sanitized : `${sanitized}.zip`;
}

interface UnavailableKeyFailure {
  status: 404 | 410;
  body: { success: false; error: string; reason?: RetentionReason };
}

type VerifiedKeyCheck =
  | { ok: true; size: number }
  | { ok: false; kind: 'auth'; response: NextResponse }
  | ({ ok: false; kind: 'unavailable' } & UnavailableKeyFailure);

function checkOwnerAccess(
  auth: ApiAuthResult,
  ownerUserId: string | undefined
): { kind: 'auth'; response: NextResponse } | { kind: 'unavailable'; failure: UnavailableKeyFailure } | null {
  if (!ownerUserId || isAnonymousUserId(ownerUserId)) {
    return null;
  }
  if (auth.user?.id !== ownerUserId) {
    return { kind: 'unavailable', failure: { status: 404, body: { success: false, error: '' } } };
  }
  if (!auth.authorized) {
    return {
      kind: 'auth',
      response: NextResponse.json(
        { success: false, error: auth.error ?? 'Unauthorized' },
        { status: auth.status ?? 401, headers: { 'Cache-Control': PRIVATE_NO_STORE, ...authErrorHeaders(auth) } }
      ),
    };
  }
  return null;
}

async function verifySingleBundleKey(
  key: string,
  auth: ApiAuthResult
): Promise<VerifiedKeyCheck> {
  const notFoundFailure = (): VerifiedKeyCheck => ({
    ok: false,
    kind: 'unavailable',
    status: 404,
    body: { success: false, error: `Object not found for key: "${key}"` },
  });
  const ownership = await resolveObjectOwnership(key);
  if (!ownership.resolved) {
    return notFoundFailure();
  }
  const denied = checkOwnerAccess(auth, ownership.ownerUserId);
  if (denied) {
    if (denied.kind === 'auth') return { ok: false, kind: 'auth', response: denied.response };
    return notFoundFailure();
  }
  const stat = await s3Storage.stat(key);
  const availability = await resultAvailability(key);
  if (availability?.state === 'deleted') {
    if (stat) {
      await deleteResult(s3Storage, key).catch((error: unknown) => {
        console.warn(`[StorageBundle] Could not delete the expired result "${key}"; the sweep tries again:`, error);
      });
    }
    return {
      ok: false,
      kind: 'unavailable',
      status: 410,
      body: {
        success: false,
        error: availability.reason === 'capacity' ? CAPACITY_GONE_MESSAGE : GONE_MESSAGE,
        ...(availability.reason ? { reason: availability.reason } : {}),
      },
    };
  }
  if (!stat) {
    return notFoundFailure();
  }
  return { ok: true, size: stat.size };
}

function badJsonResponse(error: string): NextResponse {
  return NextResponse.json(
    { success: false, error },
    { status: 400, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
  );
}

async function parseBundleRequest(
  req: NextRequest,
  instanceUri: string
): Promise<{ body: BundleRequestBody } | { response: NextResponse }> {
  const read = await readBoundedJsonText(req, SMALL_REQUEST_BODY_MAX_BYTES, instanceUri);
  if ('refusal' in read) {
    read.refusal.headers.set('Cache-Control', PRIVATE_NO_STORE);
    return { response: read.refusal };
  }

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(read.text);
  } catch {
    return { response: badJsonResponse('Invalid JSON request body.') };
  }

  return validateBundleBody(rawBody);
}

function validateBundleBody(rawBody: unknown): { body: BundleRequestBody } | { response: NextResponse } {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return { response: badJsonResponse('The request must contain a non-empty "files" array.') };
  }
  const body = rawBody as BundleRequestBody;
  if (!Array.isArray(body.files) || body.files.length === 0) {
    return { response: badJsonResponse('The request must contain a non-empty "files" array.') };
  }
  if (body.files.length > MAX_EXTRACTED_ENTRIES) {
    return { response: badJsonResponse(`Cannot bundle more than ${MAX_EXTRACTED_ENTRIES} files at once.`) };
  }
  for (const item of body.files) {
    if (!item || typeof item.key !== 'string' || item.key.trim() === '') {
      return { response: badJsonResponse('Every file entry must have a valid storage key.') };
    }
  }
  return { body };
}

function hasExplicitAuthCredential(req: NextRequest): boolean {
  return Boolean(
    extractApiKeySecret(req) || req.headers.get('authorization')?.trim() || req.headers.get('x-api-key')?.trim()
  );
}

function authFailureResponse(auth: ApiAuthResult, defaultError: string, defaultStatus: number): NextResponse {
  return NextResponse.json(
    { success: false, error: auth.error ?? defaultError },
    {
      status: auth.status ?? defaultStatus,
      headers: { 'Cache-Control': PRIVATE_NO_STORE, ...authErrorHeaders(auth) },
    }
  );
}

async function authenticateBundleCaller(
  req: NextRequest
): Promise<{ auth: ApiAuthResult; user: User } | { response: NextResponse }> {
  const callerAuth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: STORAGE_DOWNLOAD_SCOPE });
  const hasExplicitCredential = hasExplicitAuthCredential(req);
  if ((hasExplicitCredential || callerAuth.user || callerAuth.status === 503) && !callerAuth.authorized) {
    return { response: authFailureResponse(callerAuth, 'Unauthorized', 401) };
  }
  if (callerAuth.user) {
    return { auth: callerAuth, user: callerAuth.user };
  }

  const anonAuth = await validateApiAccess(req, { requiredUnits: 0, allowAnonymous: true });
  if (!anonAuth.authorized || !anonAuth.user) {
    return { response: authFailureResponse(anonAuth, 'Rate limit exceeded', 429) };
  }
  return { auth: anonAuth, user: anonAuth.user };
}

async function verifyBundleFiles(
  files: readonly BundleFileRequest[],
  auth: ApiAuthResult
): Promise<{ verifiedFiles: VerifiedBundleFile[]; totalBytes: number } | { response: NextResponse }> {
  const uniqueKeys = [...new Set(files.map((item) => item.key))];
  const verifiedByKey = new Map<string, number>();
  const unavailableKeys: string[] = [];
  let firstUnavailable: UnavailableKeyFailure | undefined;

  for (let start = 0; start < uniqueKeys.length; start += VERIFICATION_BATCH_CONCURRENCY) {
    const batch = uniqueKeys.slice(start, start + VERIFICATION_BATCH_CONCURRENCY);
    const checks = await Promise.all(batch.map((key) => verifySingleBundleKey(key, auth)));
    for (let i = 0; i < batch.length; i++) {
      const result = checks[i];
      if (result.ok) {
        verifiedByKey.set(batch[i], result.size);
        continue;
      }
      if (result.kind === 'auth') {
        return { response: result.response };
      }
      unavailableKeys.push(batch[i]);
      if (!firstUnavailable) {
        firstUnavailable = { status: result.status, body: result.body };
      }
    }
  }

  if (unavailableKeys.length > 0 && firstUnavailable) {
    return {
      response: NextResponse.json(
        { ...firstUnavailable.body, unavailableKeys },
        { status: firstUnavailable.status, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
      ),
    };
  }

  const uniqueNames = deduplicateFileNames(files);
  const verifiedFiles: VerifiedBundleFile[] = [];
  let totalBytes = 0;
  for (let i = 0; i < files.length; i++) {
    const { key } = files[i];
    const size = verifiedByKey.get(key) ?? 0;
    totalBytes += size;
    if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) {
      return {
        response: NextResponse.json(
          { success: false, error: 'Total bundle size exceeds the 2 GiB maximum limit.' },
          { status: 413, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
        ),
      };
    }
    verifiedFiles.push({ key, name: uniqueNames[i], size });
  }
  return { verifiedFiles, totalBytes };
}

/** What the zip entry generator and the stream wrapper of one bundle download share. */
interface BundleStreamState {
  closed: boolean;
  timedOut: boolean;
  activeStreams: Set<Readable>;
}

async function* generateZipEntries(
  req: NextRequest,
  verifiedFiles: readonly VerifiedBundleFile[],
  state: BundleStreamState,
  cleanup: () => void
): AsyncGenerator<StreamingZipEntry, void, undefined> {
  try {
    for (const file of verifiedFiles) {
      if (state.closed || state.timedOut || req.signal?.aborted) return;
      const nodeStream = (await s3Storage.openReadStream(file.key)) as Readable | null;
      if (!nodeStream) {
        throw new Error(`Failed to read stored file "${file.key}" during bundle generation.`);
      }
      if (state.closed || state.timedOut || req.signal?.aborted) {
        nodeStream.destroy();
        return;
      }
      state.activeStreams.add(nodeStream);
      const data = deliveryTrackedStream(nodeStream, file.size, async (sent) => {
        state.activeStreams.delete(nodeStream);
        if (!state.closed && !state.timedOut && !req.signal?.aborted && sent === file.size && isRetainedKey(file.key)) {
          const last = file.size > 0 ? file.size - 1 : 0;
          await recordServed(file.key, { first: 0, last, size: file.size }).catch(() => undefined);
        }
      });
      yield { name: file.name, data, size: file.size };
    }
  } finally {
    cleanup();
  }
}

function createBundleZipResponse(
  req: NextRequest,
  verifiedFiles: readonly VerifiedBundleFile[],
  archiveName: string,
  streamDeadlineMs: number,
  releaseSlotOnce: () => void
): NextResponse {
  const state: BundleStreamState = { closed: false, timedOut: false, activeStreams: new Set<Readable>() };
  let deadlineTimer: NodeJS.Timeout | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let reader!: ReadableStreamDefaultReader<Uint8Array>;

  const clearDeadlineTimer = () => {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
  };
  const destroyAllStreams = () => {
    for (const s of state.activeStreams) {
      s.destroy();
    }
    state.activeStreams.clear();
  };
  const onRequestAbort = () => {
    state.closed = true;
    clearDeadlineTimer();
    destroyAllStreams();
    releaseSlotOnce();
    if (reader) {
      void reader.cancel(req.signal?.reason).catch(() => undefined);
    }
    try {
      streamController?.error(req.signal?.reason ?? new Error('Request aborted'));
    } catch {
      // Stream may already be closed or errored.
    }
  };
  const failOnDeadline = () => {
    if (state.closed) return;
    state.closed = true;
    state.timedOut = true;
    clearDeadlineTimer();
    req.signal?.removeEventListener('abort', onRequestAbort);
    const err = new JobTimeoutError(streamDeadlineMs);
    destroyAllStreams();
    releaseSlotOnce();
    void reader.cancel(err).catch(() => undefined);
    try {
      streamController?.error(err);
    } catch {
      // Stream may already be closed or errored.
    }
  };

  req.signal?.addEventListener('abort', onRequestAbort, { once: true });

  const rawZipStream = streamZipReadable(
    generateZipEntries(req, verifiedFiles, state, () => {
      clearDeadlineTimer();
      req.signal?.removeEventListener('abort', onRequestAbort);
      destroyAllStreams();
    })
  );
  reader = rawZipStream.getReader();
  const guardedZipStream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    async pull(controller) {
      if (state.closed || state.timedOut) return;
      try {
        const next = await reader.read();
        if (state.closed || state.timedOut) return;
        if (next.done) {
          state.closed = true;
          clearDeadlineTimer();
          req.signal?.removeEventListener('abort', onRequestAbort);
          releaseSlotOnce();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (err) {
        const wasClosed = state.closed;
        state.closed = true;
        clearDeadlineTimer();
        req.signal?.removeEventListener('abort', onRequestAbort);
        destroyAllStreams();
        releaseSlotOnce();
        if (!wasClosed) {
          controller.error(err);
        }
      }
    },
    async cancel(reason) {
      state.closed = true;
      clearDeadlineTimer();
      req.signal?.removeEventListener('abort', onRequestAbort);
      destroyAllStreams();
      await reader.cancel(reason).catch(() => undefined);
      releaseSlotOnce();
    },
  });

  deadlineTimer = setTimeout(failOnDeadline, streamDeadlineMs);
  deadlineTimer.unref();
  if (req.signal?.aborted) {
    onRequestAbort();
  }

  return new NextResponse(guardedZipStream as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': attachmentContentDisposition(archiveName),
      'Cache-Control': PRIVATE_NO_STORE,
      ...DOWNLOAD_SECURITY_HEADERS,
      'X-Accel-Buffering': 'no',
    },
  });
}

function invalidTicketResponse(): NextResponse {
  return NextResponse.json(
    { success: false, error: 'Bundle download ticket is invalid or expired.' },
    { status: 404, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
  );
}

async function authorizeCredentialedTicketCaller(
  req: NextRequest,
  callerUserId: string,
  hasExplicitCredential: boolean
): Promise<{ auth: ApiAuthResult } | { response: NextResponse }> {
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: STORAGE_DOWNLOAD_SCOPE });
  if (!auth.authorized) {
    if (hasExplicitCredential || auth.status === 503 || Boolean(auth.user)) {
      return { response: authFailureResponse(auth, 'Unauthorized', 401) };
    }
    return { response: invalidTicketResponse() };
  }
  if (auth.user?.id !== callerUserId) {
    return { response: invalidTicketResponse() };
  }
  return { auth };
}

function clientIpErrorResponse(error: ClientIpError): NextResponse {
  const malformed = error.status === 400;
  return NextResponse.json(
    {
      success: false,
      error: malformed
        ? 'Bad Request: malformed client address in forwarding headers.'
        : 'Server misconfiguration: client IP trust settings are invalid.',
    },
    {
      status: error.status,
      headers: malformed
        ? { 'Cache-Control': PRIVATE_NO_STORE }
        : { 'Cache-Control': PRIVATE_NO_STORE, 'Retry-After': String(CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS) },
    }
  );
}

function anonymousTicketAuth(anonUserId: string): ApiAuthResult {
  return {
    authorized: true,
    user: {
      id: anonUserId,
      email: 'anonymous@easyconvert.local',
      name: 'Anonymous Client',
      tier: 'free',
      provider: 'email',
      createdAt: 0,
      updatedAt: 0,
    },
    authMethod: 'session',
  };
}

function authorizeAnonymousTicketCaller(req: NextRequest, callerUserId: string): { auth: ApiAuthResult } | { response: NextResponse } {
  let clientIp: string;
  try {
    clientIp = extractClientIp(req);
  } catch (error) {
    if (!(error instanceof ClientIpError)) throw error;
    return { response: clientIpErrorResponse(error) };
  }

  const anonUserId = anonymousUserId(rateLimitKey(clientIp));
  if (anonUserId !== callerUserId) {
    return { response: invalidTicketResponse() };
  }
  return { auth: anonymousTicketAuth(anonUserId) };
}

async function authorizeBundleTicketCaller(
  req: NextRequest,
  callerUserId: string
): Promise<{ auth: ApiAuthResult } | { response: NextResponse }> {
  const hasExplicitCredential = hasExplicitAuthCredential(req);
  if (hasExplicitCredential || !isAnonymousUserId(callerUserId)) {
    return authorizeCredentialedTicketCaller(req, callerUserId, hasExplicitCredential);
  }
  return authorizeAnonymousTicketCaller(req, callerUserId);
}

interface RunBundleInput {
  req: NextRequest;
  files: readonly BundleFileRequest[];
  archiveName: string;
  callerUserId: string;
  callerTier: UserTier;
  verifyAuth: ApiAuthResult;
  prepareOnly: boolean;
}

async function runBundleWithSlot({
  req,
  files,
  archiveName,
  callerUserId,
  callerTier,
  verifyAuth,
  prepareOnly,
}: RunBundleInput): Promise<NextResponse> {
  const instanceUri = req.nextUrl?.pathname || '/api/storage/bundle';
  let releaseSlotRaw: (() => void) | undefined;
  let slotReleased = false;
  const releaseSlotOnce = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseSlotRaw?.();
  };

  const slot = await acquireSyncSlot(callerUserId, callerTier);
  if (!slot.granted) {
    return concurrencyLimitResponse(slot.limit, instanceUri);
  }
  releaseSlotRaw = slot.release;

  try {
    const verified = await verifyBundleFiles(files, verifyAuth);
    if ('response' in verified) {
      releaseSlotOnce();
      return verified.response;
    }
    if (prepareOnly) {
      const ticket = await createBundleTicket({
        files: verified.verifiedFiles.map(({ key, name }) => ({ key, name })),
        archiveName,
        callerUserId,
        callerTier,
      });
      releaseSlotOnce();
      return NextResponse.json(
        { success: true, downloadUrl: `/api/storage/bundle?ticket=${ticket}` },
        { status: 200, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
      );
    }
    const streamDeadlineMs = syncDeadlineMs(
      jobDeadlineMs({ tier: callerTier, family: 'bytes', inputBytes: verified.totalBytes })
    );
    return createBundleZipResponse(req, verified.verifiedFiles, archiveName, streamDeadlineMs, releaseSlotOnce);
  } catch (err) {
    releaseSlotOnce();
    throw err;
  }
}

export async function GET(req: NextRequest) {
  const ticket = req.nextUrl?.searchParams?.get('ticket') ?? '';
  const record = await consumeBundleTicket(ticket);
  if (!record) {
    return invalidTicketResponse();
  }

  const verifiedCaller = await authorizeBundleTicketCaller(req, record.callerUserId);
  if ('response' in verifiedCaller) {
    return verifiedCaller.response;
  }

  return runBundleWithSlot({
    req,
    files: record.files,
    archiveName: record.archiveName,
    callerUserId: record.callerUserId,
    callerTier: record.callerTier,
    verifyAuth: verifiedCaller.auth,
    prepareOnly: false,
  });
}

export async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/storage/bundle';
  const parsed = await parseBundleRequest(req, instanceUri);
  if ('response' in parsed) {
    return parsed.response;
  }

  const caller = await authenticateBundleCaller(req);
  if ('response' in caller) {
    return caller.response;
  }

  const prepareOnly = req.nextUrl?.searchParams?.get('prepare') === '1';
  const archiveName = sanitizeArchiveName(parsed.body.archiveName);
  return runBundleWithSlot({
    req,
    files: parsed.body.files,
    archiveName,
    callerUserId: caller.user.id,
    callerTier: caller.user.tier,
    verifyAuth: caller.auth,
    prepareOnly,
  });
}
