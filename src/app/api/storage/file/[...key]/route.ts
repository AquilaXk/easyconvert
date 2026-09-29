import { NextRequest, NextResponse } from 'next/server';
import { storageProvider as s3Storage } from '@/lib/storage';
import { conversionQueue } from '@/lib/queue/conversion-queue';
import { denyUnlessOwner } from '@/lib/api-keys/owner-access';
import { attachmentContentDisposition } from '@/lib/api/content-disposition';

export const dynamic = 'force-dynamic';

const STORAGE_DOWNLOAD_SCOPE = 'storage:download';
/** `conversions/<userId>/...`: synchronous API outputs, owned by that user. */
const USER_CONVERSION_KEY_PATTERN = /^conversions\/([^/]+)\//;
/** `results/<jobId>/...`: queue job outputs, owned by the job's user when the job has one. */
const JOB_RESULT_KEY_PATTERN = /^results\/([^/]+)\//;
/** Outputs can be private to one user and expire with their storage TTL, so no shared cache may keep them. */
const PRIVATE_NO_STORE = 'private, no-store';

/**
 * Resolves the user that owns a stored object from its key namespace.
 * A job result whose job record no longer exists (cleaned up, or lost with an in-memory queue)
 * cannot be tied to a user any more, so it keeps capability-URL access like an anonymous
 * job result until the object's storage TTL removes it.
 * Every other key (anonymous uploads) has no owner.
 */
async function resolveObjectOwner(key: string): Promise<string | undefined> {
  const userConversion = USER_CONVERSION_KEY_PATTERN.exec(key);
  if (userConversion) {
    return userConversion[1];
  }

  const jobResult = JOB_RESULT_KEY_PATTERN.exec(key);
  if (jobResult) {
    const job = await conversionQueue.getJob(jobResult[1]);
    return job?.data?.userId;
  }

  return undefined;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { key: string[] } }
) {
  const rawKey = Array.isArray(params.key) ? params.key.join('/') : params.key;
  const fullKey = decodeURIComponent(rawKey);
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

  const denied = await denyUnlessOwner(
    req,
    await resolveObjectOwner(resolvedKey),
    STORAGE_DOWNLOAD_SCOPE,
    notFound
  );
  if (denied) {
    return denied;
  }

  const fileHeaders: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': PRIVATE_NO_STORE,
    'X-Content-Type-Options': 'nosniff',
    'ETag': stored.etag,
    'Content-Type': stored.mimeType,
    'Content-Disposition': attachmentContentDisposition(stored.filename),
  };

  // Support HTTP Range requests
  const range = req.headers.get('range');
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stored.size - 1;
    const chunkSize = end - start + 1;
    const chunkBuffer = stored.buffer.subarray(start, end + 1);

    return new NextResponse(new Uint8Array(chunkBuffer), {
      status: 206,
      headers: {
        ...fileHeaders,
        'Content-Range': `bytes ${start}-${end}/${stored.size}`,
        'Content-Length': chunkSize.toString(),
      },
    });
  }

  return new NextResponse(new Uint8Array(stored.buffer), {
    status: 200,
    headers: {
      ...fileHeaders,
      'Content-Length': stored.size.toString(),
    },
  });
}
