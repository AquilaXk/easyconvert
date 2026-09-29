import { NextRequest, NextResponse } from 'next/server';
import { storageProvider as s3Storage } from '@/lib/storage';
import { denyUnlessOwner, resolveObjectOwnership } from '@/lib/api-keys/owner-access';
import { attachmentContentDisposition } from '@/lib/api/content-disposition';
import { parseByteRange, satisfiedContentRange, unsatisfiedContentRange } from '@/lib/api/http-range';

export const dynamic = 'force-dynamic';

const STORAGE_DOWNLOAD_SCOPE = 'storage:download';
/** Outputs can be private to one user and expire with their storage TTL, so no shared cache may keep them. */
const PRIVATE_NO_STORE = 'private, no-store';

/** Decodes the request path key, or returns undefined when its percent-encoding is malformed. */
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
  { params }: { params: { key: string[] } }
) {
  const rawKey = Array.isArray(params.key) ? params.key.join('/') : params.key;
  const fullKey = decodeStorageKey(rawKey);
  if (fullKey === undefined) {
    return NextResponse.json(
      { success: false, error: 'Malformed storage key.' },
      { status: 400, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
    );
  }
  // Owned objects answer other callers with this same response, so their existence is not revealed.
  const notFound = () =>
    NextResponse.json(
      { success: false, error: `Object not found for key: "${fullKey}"` },
      { status: 404, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
    );

  let resolvedKey = fullKey;
  let stored = s3Storage.getObject(fullKey);
  if (!stored) {
    resolvedKey = rawKey;
    stored = s3Storage.getObject(rawKey);
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
  if (range.kind === 'partial') {
    const chunkBuffer = stored.buffer.subarray(range.start, range.end + 1);
    return new NextResponse(new Uint8Array(chunkBuffer), {
      status: 206,
      headers: {
        ...contentHeaders,
        'Content-Range': satisfiedContentRange(range.start, range.end, stored.size),
        'Content-Length': String(range.end - range.start + 1),
      },
    });
  }

  return new NextResponse(new Uint8Array(stored.buffer), {
    status: 200,
    headers: {
      ...contentHeaders,
      'Content-Length': stored.size.toString(),
    },
  });
}
