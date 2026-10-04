import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { buildRateLimitHeaders } from '@/lib/api/rate-limit';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { inspectArchive } from '@/lib/conversions';
import { storageProvider } from '@/lib/storage';
import {
  ArchiveEncryptedHeaderError,
  MissingVolumeError,
  ConversionFailedError,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/archives/inspect';

  // 1. Guard check: Authenticate
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    let headers = authErrorHeaders(auth);
    if (auth.user) {
      const userQuota = await redisKeyStore.getQuotaUsage(auth.user.id);
      headers = { ...buildRateLimitHeaders(userQuota), ...headers };
    }
    return createProblemDetailsResponse(
      auth.status || 401,
      auth.error || 'Authentication required.',
      instanceUri,
      auth.status === 403 ? 'Forbidden' : 'Unauthorized',
      undefined,
      headers
    );
  }

  // 2. Parse body: Multipart, JSON, or Octet-stream
  const contentType = req.headers.get('content-type') || '';
  let archiveBuffer: Buffer | null = null;
  let filename: string | undefined;
  let password: string | undefined;

  try {
    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const fileEntry = formData.get('file');
      if (!fileEntry || typeof fileEntry === 'string' || !(fileEntry instanceof Blob)) {
        return createProblemDetailsResponse(
          400,
          'Missing required "file" in multipart form data.',
          instanceUri,
          'Bad Request'
        );
      }
      filename = (fileEntry as File).name;
      const arrayBuf = await fileEntry.arrayBuffer();
      archiveBuffer = Buffer.from(arrayBuf);

      const pw = formData.get('password');
      if (typeof pw === 'string' && pw) {
        password = pw;
      }
    } else if (contentType.includes('application/json')) {
      const body = await req.json();
      if (!body || typeof body !== 'object') {
        return createProblemDetailsResponse(
          400,
          'Invalid JSON request payload.',
          instanceUri,
          'Bad Request'
        );
      }
      password = typeof body.password === 'string' ? body.password : undefined;
      filename = typeof body.filename === 'string' ? body.filename : undefined;

      if (body.storageKey) {
        const stored = storageProvider.getObject(body.storageKey);
        if (!stored) {
          return createProblemDetailsResponse(
            404,
            `Storage file not found for key: "${body.storageKey}".`,
            instanceUri,
            'Not Found'
          );
        }
        archiveBuffer = stored.buffer;
        filename = filename || stored.filename;
      } else {
        return createProblemDetailsResponse(
          400,
          'JSON inspection request must include a "storageKey".',
          instanceUri,
          'Bad Request'
        );
      }
    } else {
      // Direct raw binary stream
      const raw = await req.arrayBuffer();
      if (raw.byteLength === 0) {
        return createProblemDetailsResponse(
          400,
          'Empty archive payload provided for inspection.',
          instanceUri,
          'Bad Request'
        );
      }
      archiveBuffer = Buffer.from(raw);
      filename = req.headers.get('x-archive-filename') || req.nextUrl.searchParams.get('filename') || undefined;
      password = req.headers.get('x-archive-password') || req.nextUrl.searchParams.get('password') || undefined;
    }

    if (!archiveBuffer || archiveBuffer.length === 0) {
      return createProblemDetailsResponse(
        400,
        'Archive buffer is empty.',
        instanceUri,
        'Bad Request'
      );
    }

    const inspection = await inspectArchive(archiveBuffer, { filename, password });
    return NextResponse.json({
      success: true,
      ...inspection,
    });
  } catch (err: any) {
    if (err instanceof ArchiveEncryptedHeaderError) {
      return createProblemDetailsResponse(
        422,
        err.message,
        instanceUri,
        'Archive Header Encrypted',
        'https://api.easyconvert.io/problems/archive-encrypted-header'
      );
    }

    if (err instanceof MissingVolumeError) {
      return createProblemDetailsResponse(
        422,
        err.message,
        instanceUri,
        'Missing Archive Volume',
        'https://api.easyconvert.io/problems/missing-archive-volume'
      );
    }

    if (err instanceof ConversionFailedError) {
      return createProblemDetailsResponse(
        422,
        err.message,
        instanceUri,
        'Invalid Archive',
        'https://api.easyconvert.io/problems/invalid-archive'
      );
    }

    return createProblemDetailsResponse(
      500,
      err?.message || 'Failed to inspect archive.',
      instanceUri,
      'Internal Server Error'
    );
  }
}
