import { NextRequest, NextResponse } from 'next/server';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { partBodyProblem } from '@/lib/api/file-size-limit';
import { MULTIPART_MAX_PART_BYTES, storageProvider } from '@/lib/storage';
import { receivePart } from '@/lib/storage/part-admission';
import { declaredPartBytes, partFailureResponse } from '@/lib/api/part-response';
import type { IStorageBackend } from '@/lib/storage/oci-storage';
import { verifySigV4QueryUrl } from '@/lib/storage/sigv4-presigner';
import { LOCAL_EMULATION_ACCESS_KEY_ID, LOCAL_EMULATION_REGION } from '@/lib/storage/storage-config';

export const dynamic = 'force-dynamic';

const SINGLE_VALUE_QUERY_PARAMS = [
  'uploadId',
  'partNumber',
  'key',
  'signature',
  'expiresAt',
  'expires',
  'X-Amz-Algorithm',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-SignedHeaders',
  'X-Amz-Signature',
] as const;

/** A backend that receives parts on this application and verifies the URLs it issued itself. */
type PartReceivingStorage = IStorageBackend &
  Required<
    Pick<IStorageBackend, 'getUploadSession' | 'getUploadedParts' | 'getSigningSecret' | 'verifyPresignedSignature' | 'uploadPartStream'>
  >;

function receivesParts(storage: IStorageBackend): storage is PartReceivingStorage {
  return (
    storage.kind === 'local' &&
    Boolean(
      storage.getUploadSession &&
        storage.getUploadedParts &&
        storage.getSigningSecret &&
        storage.verifyPresignedSignature &&
        storage.uploadPartStream
    )
  );
}

export async function PUT(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads/direct/part';
  const { searchParams } = req.nextUrl;

  for (const paramName of SINGLE_VALUE_QUERY_PARAMS) {
    if (searchParams.getAll(paramName).length > 1) {
      return createProblemDetailsResponse(
        400,
        `Duplicate "${paramName}" query parameter is not permitted.`,
        instanceUri,
        'Bad Request'
      );
    }
  }

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

  const partNumber = /^\d+$/.test(partNumberStr) ? Number.parseInt(partNumberStr, 10) : Number.NaN;
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return createProblemDetailsResponse(
      400,
      'Invalid "partNumber". Must be an integer between 1 and 10000.',
      instanceUri,
      'Bad Request'
    );
  }

  const lengthProblem = partBodyProblem(req, instanceUri);
  if (lengthProblem) return lengthProblem;

  // Against an object store the client PUTs each part straight to the presigned object-store URL;
  // this route only exists to receive the parts of local storage.
  if (!receivesParts(storageProvider)) {
    return createProblemDetailsResponse(
      404,
      'Parts are uploaded directly to the object store through the presigned URLs.',
      instanceUri,
      'Not Found'
    );
  }
  const storage: PartReceivingStorage = storageProvider;

  // 1. Session lookup
  const session = await storage.getUploadSession(uploadId);
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
      secretAccessKey: storage.getSigningSecret(),
      expectedMethod: 'PUT',
      headers: headersRecord,
    });
    if (
      !sigv4.valid ||
      sigv4.accessKeyId !== LOCAL_EMULATION_ACCESS_KEY_ID ||
      sigv4.region !== LOCAL_EMULATION_REGION ||
      sigv4.service !== 's3'
    ) {
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

    const validHmac = storage.verifyPresignedSignature(
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
    // The part may hold what the declared total leaves after the other parts, stored and on the way, and at most a part.
    const part = await receivePart(
      storage,
      { uploadId, partNumber, declaredBytes: declaredPartBytes(req.headers), totalSize: session.totalSize, maxPartBytes: MULTIPART_MAX_PART_BYTES },
      req.body
    );
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
  } catch (error: unknown) {
    return partFailureResponse(error, instanceUri);
  }
}
