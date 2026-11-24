import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { Readable } from 'node:stream';
import { storageProvider as s3Storage } from '@/lib/storage';
import { resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { authErrorHeaders, extractApiKeySecret, validateApiAccess, type ApiAuthResult } from '@/lib/api-keys/guard';
import { isAnonymousUserId } from '@/lib/auth/anonymous-identity';
import type { User } from '@/lib/auth/types';
import { DOWNLOAD_SECURITY_HEADERS, attachmentContentDisposition } from '@/lib/api/content-disposition';
import { deliveryTrackedStream } from '@/lib/api/delivery-stream';
import { readBoundedJsonText } from '@/lib/api/json-body-bounds';
import { SMALL_REQUEST_BODY_MAX_BYTES } from '@/lib/api/request-body-limit';
import { acquireSyncSlot, concurrencyLimitResponse } from '@/lib/queue/concurrency-limit';
import { jobDeadlineMs, syncDeadlineMs } from '@/lib/queue/job-deadline';
import { MAX_EXTRACTED_ENTRIES } from '@/lib/tools/tool-names';
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

function buildNotFoundResponse(key: string): NextResponse {
  return NextResponse.json(
    { success: false, error: `Object not found for key: "${key}"` },
    { status: 404, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
  );
}

function buildGoneResponse(reason: RetentionReason | undefined): NextResponse {
  return NextResponse.json(
    { success: false, error: reason === 'capacity' ? CAPACITY_GONE_MESSAGE : GONE_MESSAGE, reason },
    { status: 410, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
  );
}

function sanitizeArchiveName(rawName?: string): string {
  if (!rawName || typeof rawName !== 'string') return 'files.zip';
  const leaf = path.basename(rawName.trim());
  const sanitized = sanitizeNodeOutputFilename(leaf, 'files.zip');
  return sanitized.toLowerCase().endsWith('.zip') ? sanitized : `${sanitized}.zip`;
}

type VerifiedKeyCheck =
  | { ok: true; size: number }
  | { ok: false; response: NextResponse };

function checkOwnerAccess(
  auth: ApiAuthResult,
  ownerUserId: string | undefined,
  notFound: () => NextResponse
): NextResponse | null {
  if (!ownerUserId || isAnonymousUserId(ownerUserId)) {
    return null;
  }
  if (auth.user?.id !== ownerUserId) {
    return notFound();
  }
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: auth.error ?? 'Unauthorized' },
      { status: auth.status ?? 401, headers: { 'Cache-Control': PRIVATE_NO_STORE, ...authErrorHeaders(auth) } }
    );
  }
  return null;
}

async function verifySingleBundleKey(
  key: string,
  auth: ApiAuthResult
): Promise<VerifiedKeyCheck> {
  const notFound = () => buildNotFoundResponse(key);
  const ownership = await resolveObjectOwnership(key);
  if (!ownership.resolved) {
    return { ok: false, response: notFound() };
  }
  const denied = checkOwnerAccess(auth, ownership.ownerUserId, notFound);
  if (denied) {
    return { ok: false, response: denied };
  }
  const stat = await s3Storage.stat(key);
  const availability = await resultAvailability(key);
  if (availability?.state === 'deleted') {
    if (stat) {
      await deleteResult(s3Storage, key).catch((error: unknown) => {
        console.warn(`[StorageBundle] Could not delete the expired result "${key}"; the sweep tries again:`, error);
      });
    }
    return { ok: false, response: buildGoneResponse(availability.reason) };
  }
  if (!stat) {
    return { ok: false, response: notFound() };
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

async function authenticateBundleCaller(
  req: NextRequest
): Promise<{ auth: ApiAuthResult; user: User } | { response: NextResponse }> {
  const callerAuth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: STORAGE_DOWNLOAD_SCOPE });
  const hasExplicitCredential = Boolean(
    extractApiKeySecret(req) || req.headers.get('authorization')?.trim() || req.headers.get('x-api-key')?.trim()
  );
  if ((hasExplicitCredential || callerAuth.user || callerAuth.status === 503) && !callerAuth.authorized) {
    return {
      response: NextResponse.json(
        { success: false, error: callerAuth.error ?? 'Unauthorized' },
        {
          status: callerAuth.status ?? 401,
          headers: { 'Cache-Control': PRIVATE_NO_STORE, ...authErrorHeaders(callerAuth) },
        }
      ),
    };
  }
  if (callerAuth.user) {
    return { auth: callerAuth, user: callerAuth.user };
  }

  const anonAuth = await validateApiAccess(req, { requiredUnits: 0, allowAnonymous: true });
  if (!anonAuth.authorized || !anonAuth.user) {
    return {
      response: NextResponse.json(
        { success: false, error: anonAuth.error ?? 'Rate limit exceeded' },
        {
          status: anonAuth.status ?? 429,
          headers: { 'Cache-Control': PRIVATE_NO_STORE, ...authErrorHeaders(anonAuth) },
        }
      ),
    };
  }
  return { auth: anonAuth, user: anonAuth.user };
}

async function verifyBundleFiles(
  files: readonly BundleFileRequest[],
  auth: ApiAuthResult
): Promise<{ verifiedFiles: VerifiedBundleFile[]; totalBytes: number } | { response: NextResponse }> {
  const uniqueKeys = [...new Set(files.map((item) => item.key))];
  const verifiedByKey = new Map<string, number>();

  for (let start = 0; start < uniqueKeys.length; start += VERIFICATION_BATCH_CONCURRENCY) {
    const batch = uniqueKeys.slice(start, start + VERIFICATION_BATCH_CONCURRENCY);
    const checks = await Promise.all(batch.map((key) => verifySingleBundleKey(key, auth)));
    for (let i = 0; i < batch.length; i++) {
      const result = checks[i];
      if (!result.ok) {
        return { response: result.response };
      }
      verifiedByKey.set(batch[i], result.size);
    }
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

function createBundleZipResponse(
  req: NextRequest,
  verifiedFiles: readonly VerifiedBundleFile[],
  archiveName: string,
  streamDeadlineMs: number,
  releaseSlotOnce: () => void
): NextResponse {
  const activeStreams = new Set<Readable>();
  let streamClosed = false;
  let streamTimedOut = false;
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
    for (const s of activeStreams) {
      s.destroy();
    }
    activeStreams.clear();
  };
  const onRequestAbort = () => {
    streamClosed = true;
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
    if (streamClosed) return;
    streamClosed = true;
    streamTimedOut = true;
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

  async function* generateZipEntries(): AsyncGenerator<StreamingZipEntry, void, undefined> {
    try {
      for (const file of verifiedFiles) {
        if (streamClosed || streamTimedOut || req.signal?.aborted) return;
        const nodeStream = (await s3Storage.openReadStream(file.key)) as Readable | null;
        if (!nodeStream) {
          throw new Error(`Failed to read stored file "${file.key}" during bundle generation.`);
        }
        if (streamClosed || streamTimedOut || req.signal?.aborted) {
          nodeStream.destroy();
          return;
        }
        activeStreams.add(nodeStream);
        const data = deliveryTrackedStream(nodeStream, file.size, async (sent) => {
          activeStreams.delete(nodeStream);
          if (!streamClosed && !streamTimedOut && !req.signal?.aborted && sent === file.size && isRetainedKey(file.key)) {
            const last = file.size > 0 ? file.size - 1 : 0;
            await recordServed(file.key, { first: 0, last, size: file.size }).catch(() => undefined);
          }
        });
        yield { name: file.name, data, size: file.size };
      }
    } finally {
      clearDeadlineTimer();
      req.signal?.removeEventListener('abort', onRequestAbort);
      destroyAllStreams();
    }
  }

  const rawZipStream = streamZipReadable(generateZipEntries());
  reader = rawZipStream.getReader();
  const guardedZipStream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    async pull(controller) {
      if (streamClosed || streamTimedOut) return;
      try {
        const next = await reader.read();
        if (streamClosed || streamTimedOut) return;
        if (next.done) {
          streamClosed = true;
          clearDeadlineTimer();
          req.signal?.removeEventListener('abort', onRequestAbort);
          releaseSlotOnce();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (err) {
        const wasClosed = streamClosed;
        streamClosed = true;
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
      streamClosed = true;
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

  let releaseSlotRaw: (() => void) | undefined;
  let slotReleased = false;
  const releaseSlotOnce = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseSlotRaw?.();
  };

  const slot = await acquireSyncSlot(caller.user.id, caller.user.tier);
  if (!slot.granted) {
    return concurrencyLimitResponse(slot.limit, instanceUri);
  }
  releaseSlotRaw = slot.release;

  try {
    const verified = await verifyBundleFiles(parsed.body.files, caller.auth);
    if ('response' in verified) {
      releaseSlotOnce();
      return verified.response;
    }
    const streamDeadlineMs = syncDeadlineMs(
      jobDeadlineMs({ tier: caller.user.tier, family: 'bytes', inputBytes: verified.totalBytes })
    );
    const archiveName = sanitizeArchiveName(parsed.body.archiveName);
    return createBundleZipResponse(req, verified.verifiedFiles, archiveName, streamDeadlineMs, releaseSlotOnce);
  } catch (err) {
    releaseSlotOnce();
    throw err;
  }
}
