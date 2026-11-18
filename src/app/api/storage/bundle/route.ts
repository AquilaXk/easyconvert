import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { Readable } from 'node:stream';
import { storageProvider as s3Storage } from '@/lib/storage';
import { resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { authErrorHeaders, validateApiAccess, type ApiAuthResult } from '@/lib/api-keys/guard';
import { isAnonymousUserId } from '@/lib/auth/anonymous-identity';
import { DOWNLOAD_SECURITY_HEADERS, attachmentContentDisposition } from '@/lib/api/content-disposition';
import { deliveryTrackedStream } from '@/lib/api/delivery-stream';
import { acquireSyncSlot, concurrencyLimitResponse } from '@/lib/queue/concurrency-limit';
import { MAX_EXTRACTED_ENTRIES } from '@/lib/tools/tool-names';
import { recordServed, resultAvailability } from '@/lib/storage/retention-service';
import { isRetainedKey } from '@/lib/storage/result-retention';
import { streamZipReadable, type StreamingZipEntry } from '@/lib/archive/streaming-zip';
import { sanitizeNodeOutputFilename } from '@/lib/queue/graph/node-jobs';

export const dynamic = 'force-dynamic';

const STORAGE_DOWNLOAD_SCOPE = 'storage:download';
const PRIVATE_NO_STORE = 'private, no-store';
const MAX_BUNDLE_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const VERIFICATION_BATCH_CONCURRENCY = 16;

interface BundleFileRequest {
  key: string;
  name: string;
}

interface BundleRequestBody {
  files: BundleFileRequest[];
  archiveName?: string;
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
      { status: auth.status ?? 401, headers: authErrorHeaders(auth) }
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
  if (!stat) {
    return { ok: false, response: notFound() };
  }
  const availability = await resultAvailability(key);
  if (availability?.state === 'deleted') {
    return { ok: false, response: notFound() };
  }
  return { ok: true, size: stat.size };
}

export async function POST(req: NextRequest) {
  let body: BundleRequestBody;
  try {
    body = (await req.json()) as BundleRequestBody;
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON request body.' },
      { status: 400, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
    );
  }

  if (!body || !Array.isArray(body.files) || body.files.length === 0) {
    return NextResponse.json(
      { success: false, error: 'The request must contain a non-empty "files" array.' },
      { status: 400, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
    );
  }

  if (body.files.length > MAX_EXTRACTED_ENTRIES) {
    return NextResponse.json(
      { success: false, error: `Cannot bundle more than ${MAX_EXTRACTED_ENTRIES} files at once.` },
      { status: 400, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
    );
  }

  for (const item of body.files) {
    if (!item || typeof item.key !== 'string' || item.key.trim() === '') {
      return NextResponse.json(
        { success: false, error: 'Every file entry must have a valid storage key.' },
        { status: 400, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
      );
    }
  }

  const callerAuth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: STORAGE_DOWNLOAD_SCOPE });
  let releaseSlotRaw: (() => void) | undefined;
  let slotReleased = false;
  const releaseSlotOnce = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseSlotRaw?.();
  };

  if (callerAuth.user) {
    const slot = await acquireSyncSlot(callerAuth.user.id, callerAuth.user.tier);
    if (!slot.granted) {
      return concurrencyLimitResponse(slot.limit, req.nextUrl?.pathname || '/api/storage/bundle');
    }
    releaseSlotRaw = slot.release;
  }

  try {
    const uniqueKeys = [...new Set(body.files.map((item) => item.key))];
    const verifiedByKey = new Map<string, number>();

    for (let start = 0; start < uniqueKeys.length; start += VERIFICATION_BATCH_CONCURRENCY) {
      const batch = uniqueKeys.slice(start, start + VERIFICATION_BATCH_CONCURRENCY);
      const checks = await Promise.all(batch.map((key) => verifySingleBundleKey(key, callerAuth)));
      for (let i = 0; i < batch.length; i++) {
        const result = checks[i];
        if (!result.ok) {
          releaseSlotOnce();
          return result.response;
        }
        verifiedByKey.set(batch[i], result.size);
      }
    }

    const uniqueNames = deduplicateFileNames(body.files);
    const verifiedFiles: Array<{ key: string; name: string; size: number }> = [];
    let totalBytes = 0;
    for (let i = 0; i < body.files.length; i++) {
      const { key } = body.files[i];
      const size = verifiedByKey.get(key) ?? 0;
      totalBytes += size;
      if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) {
        releaseSlotOnce();
        return NextResponse.json(
          { success: false, error: 'Total bundle size exceeds the 2 GiB maximum limit.' },
          { status: 413, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
        );
      }
      verifiedFiles.push({ key, name: uniqueNames[i], size });
    }

    const activeStreams = new Set<Readable>();
    const destroyAllStreams = () => {
      for (const s of activeStreams) {
        s.destroy();
      }
      activeStreams.clear();
    };
    const onRequestAbort = () => {
      destroyAllStreams();
      releaseSlotOnce();
    };
    req.signal?.addEventListener('abort', onRequestAbort, { once: true });

    async function* generateZipEntries(): AsyncGenerator<StreamingZipEntry, void, undefined> {
      try {
        for (const file of verifiedFiles) {
          const nodeStream = (await s3Storage.openReadStream(file.key)) as Readable | null;
          if (!nodeStream) {
            throw new Error(`Failed to read stored file "${file.key}" during bundle generation.`);
          }
          activeStreams.add(nodeStream);
          const data = deliveryTrackedStream(nodeStream, file.size, async (sent) => {
            activeStreams.delete(nodeStream);
            if (sent === file.size && isRetainedKey(file.key)) {
              const last = file.size > 0 ? file.size - 1 : 0;
              await recordServed(file.key, { first: 0, last, size: file.size }).catch(() => undefined);
            }
          });
          yield {
            name: file.name,
            data,
            size: file.size,
          };
        }
      } finally {
        req.signal?.removeEventListener('abort', onRequestAbort);
        destroyAllStreams();
      }
    }

    const archiveName = sanitizeArchiveName(body.archiveName);
    const rawZipStream = streamZipReadable(generateZipEntries());
    const reader = rawZipStream.getReader();
    const guardedZipStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            releaseSlotOnce();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (err) {
          destroyAllStreams();
          releaseSlotOnce();
          controller.error(err);
        }
      },
      async cancel(reason) {
        destroyAllStreams();
        await reader.cancel(reason).catch(() => undefined);
        releaseSlotOnce();
      },
    });

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
  } catch (err) {
    releaseSlotOnce();
    throw err;
  }
}
