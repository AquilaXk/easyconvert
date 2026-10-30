import { NextRequest, NextResponse } from 'next/server';
import { storageProvider as s3Storage } from '@/lib/storage';
import { Readable } from 'node:stream';
import { denyUnlessOwner, resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { attachmentContentDisposition } from '@/lib/api/content-disposition';
import { parseByteRange, satisfiedContentRange, unsatisfiedContentRange } from '@/lib/api/http-range';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { deliveryTrackedStream } from '@/lib/api/delivery-stream';
import { deleteResult, isResultDeleted, recordServed } from '@/lib/storage/retention-service';
import { isRetainedKey } from '@/lib/storage/result-retention';

export const dynamic = 'force-dynamic';

const STORAGE_DOWNLOAD_SCOPE = 'storage:download';
/** Outputs can be private to one user and expire with their storage TTL, so no shared cache may keep them. */
const PRIVATE_NO_STORE = 'private, no-store';

const GONE_MESSAGE =
  'This file was deleted. A result is deleted shortly after it has been downloaded completely, or when nobody downloaded it in time. Convert the file again to get a new one.';

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

  const goneResponse = () =>
    NextResponse.json({ success: false, error: GONE_MESSAGE }, { status: 410, headers: { 'Cache-Control': PRIVATE_NO_STORE } });

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
    return (await isResultDeleted(fullKey)) ? goneResponse() : notFound();
  }
  if (await isResultDeleted(resolvedKey)) {
    await deleteResult(s3Storage, resolvedKey);
    return goneResponse();
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
  const last = range.kind === 'partial' ? range.end : stored.size - 1;
  const webStream = isRetainedKey(resolvedKey)
    ? deliveryTrackedStream(nodeStream as Readable, () => noteDelivery(resolvedKey, { first, last, size: stored.size }))
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

/** A result that could not be recorded as delivered is deleted when its undelivered time ends, so the download itself is not failed. */
async function noteDelivery(key: string, range: { first: number; last: number; size: number }): Promise<void> {
  try {
    await recordServed(key, range);
  } catch (error) {
    console.error(`[StorageDownload] Could not record the delivery of "${key}":`, error);
  }
}
