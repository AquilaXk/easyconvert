import { NextRequest, NextResponse } from 'next/server';
import { storageProvider as s3Storage } from '@/lib/storage';
import { Readable } from 'node:stream';
import { denyUnlessOwner, resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { attachmentContentDisposition } from '@/lib/api/content-disposition';
import { parseByteRange, satisfiedContentRange, unsatisfiedContentRange } from '@/lib/api/http-range';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { deliveryTrackedStream } from '@/lib/api/delivery-stream';
import { deleteResult, recordServed, resultAvailability } from '@/lib/storage/retention-service';
import { isRetainedKey, type RetentionReason } from '@/lib/storage/result-retention';

export const dynamic = 'force-dynamic';

const STORAGE_DOWNLOAD_SCOPE = 'storage:download';
/** Outputs can be private to one user and expire with their storage TTL, so no shared cache may keep them. */
const PRIVATE_NO_STORE = 'private, no-store';

const GONE_MESSAGE =
  'This file was deleted. A result is deleted shortly after it has been downloaded completely, or when nobody downloaded it in time. Convert the file again to get a new one.';
const CAPACITY_GONE_MESSAGE =
  'This file was deleted early because the server ran out of disk space. Convert the file again to get a new one.';

/**
 * Decodes a still-encoded path key. Next.js already decodes catch-all segments, so a key that
 * legitimately contains `%` (for example `50% off.pdf`) is not valid percent-encoding: it is then
 * used as-is. Ownership is always checked on the key that actually matched a stored object.
 */
function decodeStorageKey(rawKey: string): string | undefined {
  try {
    return decodeURIComponent(rawKey);
  } catch (error) {
    if (error instanceof URIError) {
      return undefined;
    }
    throw error;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
) {
  const { key: keySegments } = await params;
  const rawKey = Array.isArray(keySegments) ? keySegments.join('/') : keySegments;
  const fullKey = decodeStorageKey(rawKey) ?? rawKey;
  // Owned objects answer other callers with this same response, so their existence is not revealed.
  const notFound = () =>
    NextResponse.json(
      { success: false, error: `Object not found for key: "${fullKey}"` },
      { status: 404, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
    );

  const goneResponse = (reason: RetentionReason | undefined) =>
    NextResponse.json(
      { success: false, error: reason === 'capacity' ? CAPACITY_GONE_MESSAGE : GONE_MESSAGE, reason },
      { status: 410, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
    );

  const instanceUri = req.nextUrl?.pathname || '/api/storage/file';
  let resolvedKey = fullKey;
  let stored;
  try {
    stored = await s3Storage.stat(fullKey);
    if (!stored) {
      stored = await s3Storage.stat(rawKey);
      if (stored) resolvedKey = rawKey;
    }
  } catch (err: unknown) {
    const problem = storageErrorResponse(err, instanceUri);
    if (problem) return problem;
    throw err;
  }

  const ownership = await resolveObjectOwnership(resolvedKey);
  if (!ownership.resolved) {
    return notFound();
  }
  const denied = await denyUnlessOwner(req, ownership.ownerUserId, STORAGE_DOWNLOAD_SCOPE, notFound);
  if (denied) {
    return denied;
  }

  // A result the retention rule deleted answers 410 to its owner, also in the moments before the sweep removes the object.
  if (!stored) {
    const availability = await resultAvailability(fullKey);
    return availability?.state === 'deleted' ? goneResponse(availability.reason) : notFound();
  }
  const availability = await resultAvailability(resolvedKey);
  if (availability?.state === 'deleted') {
    await deleteResult(s3Storage, resolvedKey).catch((error: unknown) => {
      console.warn(`[StorageDownload] Could not delete the expired result "${resolvedKey}"; the sweep tries again:`, error);
    });
    return goneResponse(availability.reason);
  }

  const fileHeaders: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': PRIVATE_NO_STORE,
    'X-Content-Type-Options': 'nosniff',
    'ETag': stored.etag,
  };
  const contentHeaders: Record<string, string> = {
    ...fileHeaders,
    'Content-Type': stored.mimeType,
    'Content-Disposition': attachmentContentDisposition(stored.filename),
    // A proxy that buffers the body would take all of it at once, and a slow client would look delivered.
    'X-Accel-Buffering': 'no',
  };

  const range = parseByteRange(req.headers.get('range'), stored.size);
  if (range.kind === 'unsatisfiable') {
    return NextResponse.json(
      { success: false, error: 'Requested range not satisfiable.' },
      {
        status: 416,
        headers: { ...fileHeaders, 'Content-Range': unsatisfiedContentRange(stored.size) },
      }
    );
  }

  const byteRange = range.kind === 'partial' ? { start: range.start, end: range.end } : undefined;
  let nodeStream;
  try {
    nodeStream = await s3Storage.openReadStream(resolvedKey, byteRange);
  } catch (err: unknown) {
    const problem = storageErrorResponse(err, instanceUri);
    if (problem) return problem;
    throw err;
  }
  if (!nodeStream) {
    return notFound();
  }

  const first = range.kind === 'partial' ? range.start : 0;
  const length = range.kind === 'partial' ? range.end - range.start + 1 : stored.size;
  const webStream = isRetainedKey(resolvedKey)
    ? deliveryTrackedStream(nodeStream as Readable, length, (sent) =>
        sent > 0 || sent === length ? noteDelivery(resolvedKey, { first, last: first + sent - 1, size: stored.size }) : Promise.resolve()
      )
    : Readable.toWeb(nodeStream as Readable);
  if (range.kind === 'partial') {
    return new NextResponse(webStream as any, {
      status: 206,
      headers: {
        ...contentHeaders,
        'Content-Range': satisfiedContentRange(range.start, range.end, stored.size),
        'Content-Length': String(range.end - range.start + 1),
      },
    });
  }

  return new NextResponse(webStream as any, {
    status: 200,
    headers: {
      ...contentHeaders,
      'Content-Length': stored.size.toString(),
    },
  });
}

/** Bytes `[first, last]` that were handed to the client; a result whose delivery cannot be recorded is deleted when its undelivered time ends, so the download itself is not failed. */
async function noteDelivery(key: string, range: { first: number; last: number; size: number }): Promise<void> {
  try {
    await recordServed(key, range);
  } catch (error) {
    console.error(`[StorageDownload] Could not record the delivery of "${key}":`, error);
  }
}
