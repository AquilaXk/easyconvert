import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { s3Storage } from '@/lib/storage/s3-storage';

export const dynamic = 'force-dynamic';

const MIN_PART_SIZE = 5 * 1024 * 1024; // 5 MiB S3 minimum
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB
const MAX_TOTAL_SIZE = 10 * 1024 * 1024 * 1024; // 10 GiB
const MAX_PARTS_COUNT = 10000;

interface DirectUploadInitiateBody {
  filename?: string;
  mimeType?: string;
  totalSize?: number;
  partSize?: number;
  totalParts?: number;
}

function computeChosenPartSize(totalSize: number, requestedPartSize?: number): number {
  if (requestedPartSize && requestedPartSize > 0) {
    return Math.min(requestedPartSize, MAX_PART_SIZE);
  }
  if (totalSize < MIN_PART_SIZE) {
    return Math.max(1, totalSize);
  }
  return MIN_PART_SIZE;
}

export async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads/direct';

  // 1. Guard check: Authenticate and require 'convert:write' scope
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      auth.problemType,
      authErrorHeaders(auth)
    );
  }

  // 2. Parse request body
  const body: DirectUploadInitiateBody = await req.json().catch(() => ({}));
  const { filename, mimeType = 'application/octet-stream', totalSize } = body;

  if (!filename || typeof filename !== 'string' || filename.trim().length === 0) {
    return createProblemDetailsResponse(
      400,
      'Missing or invalid "filename" in initiation payload.',
      instanceUri,
      'Bad Request'
    );
  }

  if (typeof totalSize !== 'number' || !Number.isFinite(totalSize) || totalSize < 0) {
    return createProblemDetailsResponse(
      400,
      'Missing or invalid "totalSize" in initiation payload.',
      instanceUri,
      'Bad Request'
    );
  }

  if (totalSize > MAX_TOTAL_SIZE) {
    return createProblemDetailsResponse(
      413,
      `Requested total size ${totalSize} bytes exceeds maximum allowed upload size of ${MAX_TOTAL_SIZE} bytes.`,
      instanceUri,
      'Payload Too Large'
    );
  }

  const chosenPartSize = computeChosenPartSize(totalSize, body.partSize);
  const totalParts = Math.max(1, Math.ceil(totalSize / chosenPartSize));

  if (totalParts > MAX_PARTS_COUNT) {
    return createProblemDetailsResponse(
      400,
      `Calculated parts count ${totalParts} exceeds limit of ${MAX_PARTS_COUNT}. Please increase partSize.`,
      instanceUri,
      'Bad Request'
    );
  }

  // 3. Initiate multipart upload session in s3Storage
  const session = s3Storage.initiateMultipartUpload(
    filename,
    mimeType,
    totalSize,
    auth.user.id,
    chosenPartSize
  );

  // 4. Generate presigned part URLs (local storage serves them from this application)
  const parts = Array.from({ length: totalParts }, (_, idx) => {
    const partNumber = idx + 1;
    const presigned = s3Storage.generatePresignedUploadPartUrl(
      session.key,
      session.uploadId,
      partNumber,
      900
    );
    return {
      partNumber,
      uploadUrl: presigned.url,
      expiresAt: presigned.expiresAt,
    };
  });

  return NextResponse.json(
    {
      uploadId: session.uploadId,
      key: session.key,
      partSize: chosenPartSize,
      totalParts,
      expiresAt: session.expiresAt,
      parts,
    },
    { status: 200 }
  );
}
