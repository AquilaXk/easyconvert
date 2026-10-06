import { NextRequest, NextResponse } from 'next/server';
import { storageProvider as s3Storage } from '@/lib/storage';
import { Readable } from 'node:stream';
import { denyUnlessOwner, resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { attachmentContentDisposition } from '@/lib/api/content-disposition';
import { parseByteRange, satisfiedContentRange, unsatisfiedContentRange } from '@/lib/api/http-range';
import { storageErrorResponse } from '@/lib/api/storage-error-response';

export const dynamic = 'force-dynamic';

const STORAGE_DOWNLOAD_SCOPE = 'storage:download';
/** Outputs can be private to one user and expire with their storage TTL, so no shared cache may keep them. */
const PRIVATE_NO_STORE = 'private, no-store';

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

  const instanceUri = req.nextUrl?.pathname || '/api/storage/file';
  let resolvedKey = fullKey;
  let stored;
  try {
    stored = await s3Storage.stat(fullKey);
    if (!stored) {
      resolvedKey = rawKey;
      stored = await s3Storage.stat(rawKey);
    }
  } catch (err: unknown) {
    const problem = storageErrorResponse(err, instanceUri);
    if (problem) return problem;
    throw err;
  }
  if (!stored) {
    return notFound();
  }

  const ownership = await resolveObjectOwnership(resolvedKey);
  if (!ownership.resolved) {
    return notFound();
  }
  const denied = await denyUnlessOwner(req, ownership.ownerUserId, STORAGE_DOWNLOAD_SCOPE, notFound);
  if (denied) {
    return denied;
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

  const webStream = Readable.toWeb(nodeStream as Readable);
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
