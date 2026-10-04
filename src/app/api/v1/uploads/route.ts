import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { localFsStorage, StoragePresignedUrlResult } from '@/lib/storage';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';

export const dynamic = 'force-dynamic';

const MIN_PART_SIZE = 5 * 1024 * 1024; // 5 MiB (S3 and POSIX standard minimum)
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB
const MAX_TOTAL_SIZE = 10 * 1024 * 1024 * 1024; // 10 GiB
const MAX_PARTS_COUNT = 10000;

interface InitiateUploadBody {
  filename: string;
  mimeType?: string;
  totalSize: number;
  partSize?: number;
}

interface CompleteUploadBody {
  uploadId: string;
  key: string;
  parts: Array<{ partNumber: number; etag: string }>;
  expectedSize?: number;
}

interface AbortUploadBody {
  uploadId: string;
  key: string;
}

function computeChosenPartSize(totalSize: number, requestedPartSize?: number): number {
  let chosen = requestedPartSize || MIN_PART_SIZE;
  if (totalSize < MIN_PART_SIZE) {
    chosen = Math.max(1, totalSize);
  } else if (chosen < MIN_PART_SIZE) {
    chosen = MIN_PART_SIZE;
  }
  if (chosen > MAX_PART_SIZE) {
    chosen = MAX_PART_SIZE;
  }
  return chosen;
}

async function handlePartUpload(
  req: NextRequest,
  searchParams: URLSearchParams,
  instanceUri: string
): Promise<Response> {
  const uploadId = searchParams.get('uploadId');
  const partNumberStr = searchParams.get('partNumber');

  if (!uploadId || !partNumberStr) {
    return createProblemDetailsResponse(400, 'Missing "uploadId" or "partNumber" query parameter.', instanceUri);
  }

  const partNumber = Number.parseInt(partNumberStr, 10);
  if (!Number.isFinite(partNumber) || partNumber < 1) {
    return createProblemDetailsResponse(400, 'Invalid "partNumber". Must be a positive integer.', instanceUri);
  }

  if (!req.body) {
    return createProblemDetailsResponse(400, 'Empty part payload body.', instanceUri);
  }

  const part = await localFsStorage.savePartStream(uploadId, partNumber, req.body);
  return NextResponse.json({ success: true, part });
}

async function handleInitiateUpload(
  req: NextRequest,
  instanceUri: string
): Promise<Response> {
  const body: InitiateUploadBody = await req.json().catch(() => ({}));
  const { filename, mimeType = 'application/octet-stream', totalSize } = body;

  if (!filename || typeof filename !== 'string' || filename.trim().length === 0) {
    return createProblemDetailsResponse(400, 'Missing or invalid "filename" in request body.', instanceUri);
  }

  if (typeof totalSize !== 'number' || !Number.isFinite(totalSize) || totalSize < 0) {
    return createProblemDetailsResponse(400, 'Missing or invalid "totalSize" in request body.', instanceUri);
  }

  if (totalSize > MAX_TOTAL_SIZE) {
    return createProblemDetailsResponse(
      413,
      `totalSize ${totalSize} exceeds maximum allowed upload size ${MAX_TOTAL_SIZE} bytes.`,
      instanceUri
    );
  }

  const chosenPartSize = computeChosenPartSize(totalSize, body.partSize);
  const totalParts = Math.max(1, Math.ceil(totalSize / chosenPartSize));
  if (totalParts > MAX_PARTS_COUNT) {
    return createProblemDetailsResponse(
      400,
      `Total parts count ${totalParts} exceeds limit of ${MAX_PARTS_COUNT}. Please increase partSize.`,
      instanceUri
    );
  }

  const safeFilename = path.basename(filename);
  const session = await localFsStorage.createMultipart(`uploads/${safeFilename}`, {
    contentType: mimeType,
    filename: safeFilename,
  });

  const pregenLimit = Math.min(totalParts, 100);
  const presignedPromises = Array.from({ length: pregenLimit }, (_, idx) =>
    localFsStorage.presignPart(session.key, session.uploadId, idx + 1, 86400)
  );
  const presignedUrls = await Promise.all(presignedPromises);

  return NextResponse.json({
    success: true,
    uploadId: session.uploadId,
    key: session.key,
    partSize: chosenPartSize,
    totalParts,
    expiresAt: session.expiresAt,
    presignedUrls,
  });
}

async function handleCompleteUpload(
  req: NextRequest,
  instanceUri: string
): Promise<Response> {
  const body: CompleteUploadBody = await req.json().catch(() => ({}));
  const { uploadId, key, parts, expectedSize } = body;

  if (!uploadId || !key || !Array.isArray(parts) || parts.length === 0) {
    return createProblemDetailsResponse(
      400,
      'Missing "uploadId", "key", or "parts" array in complete payload.',
      instanceUri
    );
  }

  const completedObject = await localFsStorage.completeMultipart(key, uploadId, parts, expectedSize);

  return NextResponse.json({
    success: true,
    location: `/api/storage/file/${encodeURIComponent(completedObject.key)}`,
    key: completedObject.key,
    size: completedObject.size,
    etag: completedObject.etag,
  });
}

async function handleAbortUpload(
  req: NextRequest,
  instanceUri: string
): Promise<Response> {
  const body: AbortUploadBody = await req.json().catch(() => ({}));
  const { uploadId, key } = body;

  if (!uploadId || !key) {
    return createProblemDetailsResponse(400, 'Missing "uploadId" or "key" in abort payload.', instanceUri);
  }

  const aborted = await localFsStorage.abortMultipart(key, uploadId);
  return NextResponse.json({ success: true, aborted });
}

export async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads';
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'initiate';

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

  try {
    switch (action) {
      case 'part':
        return await handlePartUpload(req, searchParams, instanceUri);
      case 'initiate':
        return await handleInitiateUpload(req, instanceUri);
      case 'complete':
        return await handleCompleteUpload(req, instanceUri);
      case 'abort':
        return await handleAbortUpload(req, instanceUri);
      default:
        return createProblemDetailsResponse(400, `Unsupported action "${action}".`, instanceUri);
    }
  } catch (err: any) {
    return createProblemDetailsResponse(400, err?.message || 'Error executing upload operation', instanceUri);
  }
}
