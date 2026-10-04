import { NextRequest, NextResponse } from 'next/server';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { s3Storage } from '@/lib/storage/s3-storage';
import { verifySigV4QueryUrl } from '@/lib/storage/sigv4-presigner';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads/direct/part';
  const { searchParams } = req.nextUrl;

  const uploadId = searchParams.get('uploadId');
  const partNumberStr = searchParams.get('partNumber');

  if (!uploadId || !partNumberStr) {
    return createProblemDetailsResponse(
      400,
      'Missing required "uploadId" or "partNumber" query parameter.',
      instanceUri,
      'Bad Request'
    );
  }

  const partNumber = Number.parseInt(partNumberStr, 10);
  if (!Number.isFinite(partNumber) || partNumber < 1 || partNumber > 10000) {
    return createProblemDetailsResponse(
      400,
      'Invalid "partNumber". Must be an integer between 1 and 10000.',
      instanceUri,
      'Bad Request'
    );
  }

  // 1. Session lookup
  const session = s3Storage.getUploadSession(uploadId);
  if (!session) {
    return createProblemDetailsResponse(
      404,
      `Upload session "${uploadId}" not found or expired.`,
      instanceUri,
      'Not Found'
    );
  }

  if (searchParams.has('key') && searchParams.get('key') !== session.key) {
    return createProblemDetailsResponse(
      403,
      'Key mismatch for this upload session.',
      instanceUri,
      'Forbidden'
    );
  }

  const key = searchParams.get('key') || session.key;

  // 2. Presigned Signature Verification (SigV4 query parameters or HMAC token)
  const hasSigV4 = searchParams.has('X-Amz-Signature');
  if (hasSigV4) {
    const headersRecord: Record<string, string> = {};
    req.headers.forEach((val, keyName) => {
      headersRecord[keyName] = val;
    });
    const sigv4 = verifySigV4QueryUrl(req.url, {
      secretAccessKey: s3Storage.getSigningSecret(),
      expectedMethod: 'PUT',
      headers: headersRecord,
    });
    if (!sigv4.valid) {
      return createProblemDetailsResponse(
        403,
        sigv4.reason || 'Invalid or expired SigV4 presigned signature.',
        instanceUri,
        'Forbidden'
      );
    }
  } else {
    const signature = searchParams.get('signature');
    const expiresAtStr = searchParams.get('expiresAt') || searchParams.get('expires');

    if (!signature || !expiresAtStr) {
      return createProblemDetailsResponse(
        403,
        'Missing presigned signature or authorization parameters.',
        instanceUri,
        'Forbidden'
      );
    }

    const expiresAt = Number.parseInt(expiresAtStr, 10);
    if (!Number.isFinite(expiresAt)) {
      return createProblemDetailsResponse(
        403,
        'Invalid "expiresAt" parameter.',
        instanceUri,
        'Forbidden'
      );
    }

    const validHmac = s3Storage.verifyPresignedSignature(
      'PUT',
      key,
      expiresAt,
      signature,
      uploadId,
      partNumber
    );

    if (!validHmac) {
      return createProblemDetailsResponse(
        403,
        'Invalid or expired presigned HMAC signature.',
        instanceUri,
        'Forbidden'
      );
    }
  }

  // 3. Spool chunk to disk via zero-heap streaming
  if (!req.body) {
    return createProblemDetailsResponse(
      400,
      'Empty part payload body.',
      instanceUri,
      'Bad Request'
    );
  }

  try {
    const part = await s3Storage.uploadPartStream(uploadId, partNumber, req.body);
    const headers = new Headers();
    headers.set('ETag', part.etag);
    headers.set('Content-Type', 'application/json');

    return new NextResponse(
      JSON.stringify({
        success: true,
        partNumber: part.partNumber,
        size: part.size,
        etag: part.etag,
      }),
      {
        status: 200,
        headers,
      }
    );
  } catch (err: any) {
    const statusCode = err?.statusCode || 400;
    return createProblemDetailsResponse(
      statusCode,
      err?.message || 'Failed to stream chunk to storage.',
      instanceUri
    );
  }
}
