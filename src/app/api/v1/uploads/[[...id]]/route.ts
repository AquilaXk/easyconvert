import crypto from 'node:crypto';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { LocalFsStorage, objectStorage, storageProvider } from '@/lib/storage';
import {
  tusEngine,
  TusOffsetMismatchError,
  TusChecksumMismatchError,
  TusInvalidChecksumHeaderError,
  TusUnsupportedChecksumAlgorithmError,
  TusUploadExceededLengthError,
  TusNotFoundError,
  TusInvalidMetadataError,
} from '@/lib/storage/tus-engine';
import { UNKNOWN_FORMAT_PROBLEM_TYPE, UnknownDeclaredFormatError } from '@/lib/storage/declared-format';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { storageErrorResponse } from '@/lib/api/storage-error-response';
import { POST as directPostHandler } from '../direct/route';
import { PUT as directPartPutHandler } from '../direct/part/route';
import { POST as directCompletePostHandler } from '../direct/complete/route';
import { DELETE as directDeleteHandler } from '../direct/[id]/route';

export const dynamic = 'force-dynamic';

const TUS_RESUMABLE_VERSION = '1.0.0';
const TUS_MAX_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB

function checkTusVersion(req: NextRequest): NextResponse | null {
  const clientVersion = req.headers.get('tus-resumable');
  if (clientVersion && clientVersion !== TUS_RESUMABLE_VERSION) {
    const headers = createTusHeaders({ 'Tus-Version': TUS_RESUMABLE_VERSION });
    return new NextResponse('Unsupported TUS version', { status: 412, headers });
  }
  return null;
}

const MIN_PART_SIZE = 5 * 1024 * 1024; // 5 MiB
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB
const MAX_TOTAL_SIZE = 10 * 1024 * 1024 * 1024; // 10 GiB
const MAX_PARTS_COUNT = 10000;
/** Part URLs handed out with an initiate response: at most this many parts, each good for 15 minutes. */
const MAX_PREGENERATED_PART_URLS = 100;
const PART_URL_TTL_SECONDS = 900;
const LOCAL_KEY_RANDOM_BYTES = 8;

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

function createTusHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers();
  headers.set('Tus-Resumable', TUS_RESUMABLE_VERSION);
  for (const [key, value] of Object.entries(extra)) {
    headers.set(key, value);
  }
  return headers;
}

function resolveSessionId(params?: { id?: string[] }): string | null {
  if (!params?.id || !Array.isArray(params.id) || params.id.length === 0) {
    return null;
  }
  if (params.id[0] === 'tus') {
    return params.id.length > 1 ? params.id[1] : null;
  }
  return params.id[0];
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

  // Against an object store the client PUTs each part straight to its presigned object-store URL;
  // only local storage receives parts through this application.
  if (!(objectStorage instanceof LocalFsStorage)) {
    return createProblemDetailsResponse(
      404,
      'Parts are uploaded directly to the object store through the presigned URLs.',
      instanceUri
    );
  }

  const part = await objectStorage.savePartStream(uploadId, partNumber, req.body);
  return NextResponse.json({ success: true, part });
}

async function handleInitiateUpload(
  req: NextRequest,
  instanceUri: string,
  userId: string
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

  const pregenLimit = Math.min(totalParts, MAX_PREGENERATED_PART_URLS);

  // Against an object store the session is a signed token that carries the declared size, part
  // size and owner: part URLs exist only for the declared parts and the object's key is unique.
  if (storageProvider.kind === 'remote' && storageProvider.generatePresignedUploadPartUrl) {
    const remoteSession = await storageProvider.initiateMultipartUpload(filename, mimeType, totalSize, userId, chosenPartSize);
    const remoteUrls = await Promise.all(
      Array.from({ length: pregenLimit }, async (_, idx) =>
        storageProvider.generatePresignedUploadPartUrl!(remoteSession.key, remoteSession.uploadId, idx + 1, PART_URL_TTL_SECONDS)
      )
    );
    return NextResponse.json({
      success: true,
      uploadId: remoteSession.uploadId,
      key: remoteSession.key,
      partSize: remoteSession.partSize,
      totalParts: remoteSession.totalParts,
      expiresAt: remoteSession.expiresAt,
      presignedUrls: remoteUrls,
    });
  }

  const safeFilename = path.basename(filename);
  const uniqueKey = `uploads/${Date.now()}_${crypto.randomBytes(LOCAL_KEY_RANDOM_BYTES).toString('hex')}_${safeFilename}`;
  const session = await objectStorage.createMultipart(uniqueKey, {
    contentType: mimeType,
    filename: safeFilename,
  });

  const presignedUrls = await Promise.all(
    Array.from({ length: pregenLimit }, (_, idx) =>
      objectStorage.presignPart(session.key, session.uploadId, idx + 1, PART_URL_TTL_SECONDS)
    )
  );

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

/**
 * Completes an object-store upload against the size declared at initiation. The client's own
 * `expectedSize` never relaxes it, and an assembled object of any other size is deleted.
 */
async function completeRemoteUpload(
  body: CompleteUploadBody,
  instanceUri: string,
  userId: string
): Promise<Response> {
  const { uploadId, key, parts, expectedSize } = body;
  if (typeof uploadId !== 'string' || !uploadId || !Array.isArray(parts) || parts.length === 0) {
    return createProblemDetailsResponse(400, 'Missing "uploadId" or "parts" array in complete payload.', instanceUri);
  }
  const session = await storageProvider.getUploadSession?.(uploadId);
  if (!session || (session.ownerUserId && session.ownerUserId !== userId)) {
    return createProblemDetailsResponse(404, 'Upload session not found or has expired.', instanceUri);
  }
  if (key !== undefined && key !== session.key) {
    return createProblemDetailsResponse(400, '"key" does not belong to this upload session.', instanceUri);
  }
  if (expectedSize !== undefined && expectedSize !== session.totalSize) {
    return createProblemDetailsResponse(400, '"expectedSize" does not match the size declared at initiation.', instanceUri);
  }

  const completed = await storageProvider.completeMultipartUpload(uploadId, parts);
  const stored = await storageProvider.stat(completed.key);
  if (stored?.size !== session.totalSize) {
    await storageProvider.deleteObject(completed.key);
    return createProblemDetailsResponse(
      400,
      `Uploaded size ${stored?.size ?? 'unknown'} bytes does not match the declared totalSize ${session.totalSize} bytes.`,
      instanceUri
    );
  }
  return NextResponse.json({
    success: true,
    location: `/api/storage/file/${encodeURIComponent(completed.key)}`,
    key: completed.key,
    size: stored.size,
    etag: completed.etag,
  });
}

async function handleCompleteUpload(
  req: NextRequest,
  instanceUri: string,
  userId: string
): Promise<Response> {
  const body: CompleteUploadBody = await req.json().catch(() => ({}));
  if (storageProvider.kind === 'remote') {
    return completeRemoteUpload(body, instanceUri, userId);
  }
  const { uploadId, key, parts, expectedSize } = body;

  if (!uploadId || !key || !Array.isArray(parts) || parts.length === 0) {
    return createProblemDetailsResponse(
      400,
      'Missing "uploadId", "key", or "parts" array in complete payload.',
      instanceUri
    );
  }

  const completedObject = await objectStorage.completeMultipart(key, uploadId, parts, expectedSize);

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
  instanceUri: string,
  userId: string
): Promise<Response> {
  const body: AbortUploadBody = await req.json().catch(() => ({}));
  const { uploadId, key } = body;

  if (storageProvider.kind === 'remote') {
    if (typeof uploadId !== 'string' || !uploadId) {
      return createProblemDetailsResponse(400, 'Missing "uploadId" in abort payload.', instanceUri);
    }
    const owner = await storageProvider.getUploadOwner?.(uploadId);
    if (!owner || owner !== userId) {
      return createProblemDetailsResponse(404, 'Upload session not found or has expired.', instanceUri);
    }
    const abortedRemote = (await storageProvider.abortMultipartUpload?.(uploadId)) ?? false;
    return NextResponse.json({ success: true, aborted: abortedRemote });
  }

  if (!uploadId || !key) {
    return createProblemDetailsResponse(400, 'Missing "uploadId" or "key" in abort payload.', instanceUri);
  }

  const aborted = await objectStorage.abortMultipart(key, uploadId);
  return NextResponse.json({ success: true, aborted });
}

export function OPTIONS() {
  const headers = createTusHeaders({
    'Tus-Version': TUS_RESUMABLE_VERSION,
    'Tus-Extension': 'creation,creation-with-upload,termination,expiration,checksum',
    'Tus-Max-Size': String(TUS_MAX_SIZE),
    'Tus-Checksum-Algorithm': 'sha256',
    'Access-Control-Allow-Methods': 'POST, GET, HEAD, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Upload-Offset, Upload-Length, Upload-Metadata, Upload-Checksum, Tus-Resumable, Content-Type, Authorization, X-API-Key',
    'Access-Control-Expose-Headers':
      'Upload-Offset, Upload-Length, Upload-Metadata, Upload-Expires, Tus-Resumable, Tus-Version, Tus-Extension, Tus-Max-Size, Location, X-Storage-Key, EasyConvert-Storage-Key',
  });
  return new NextResponse(null, { status: 204, headers });
}

export async function POST(
  req: NextRequest,
  context: { params?: { id?: string[] } } = {}
) {
  if (context.params?.id?.[0] === 'direct') {
    if (context.params.id[1] === 'complete') {
      return directCompletePostHandler(req);
    }
    return directPostHandler(req);
  }

  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads';
  const sessionId = resolveSessionId(context.params);

  // If a session ID is provided in POST, reject as invalid TUS method
  if (sessionId) {
    return createProblemDetailsResponse(405, 'POST on existing upload resource is not supported. Use PATCH.', instanceUri);
  }

  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');

  // 1. Guard check: Authenticate API key or user session with 'convert:write' scope
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

  // Handle direct multipart upload actions if 'action' query param is provided
  if (action) {
    try {
      switch (action) {
        case 'part':
          return await handlePartUpload(req, searchParams, instanceUri);
        case 'initiate':
          return await handleInitiateUpload(req, instanceUri, auth.user.id);
        case 'complete':
          return await handleCompleteUpload(req, instanceUri, auth.user.id);
        case 'abort':
          return await handleAbortUpload(req, instanceUri, auth.user.id);
        default:
          return createProblemDetailsResponse(400, `Unsupported action "${action}".`, instanceUri);
      }
    } catch (err: any) {
      const storageProblem = storageErrorResponse(err, instanceUri);
      if (storageProblem) return storageProblem;
      return createProblemDetailsResponse(400, err?.message || 'Error executing upload operation', instanceUri);
    }
  }

  // Otherwise, handle TUS 1.0 creation / creation-with-upload
  const versionMismatch = checkTusVersion(req);
  if (versionMismatch) return versionMismatch;

  const uploadLengthHeader = req.headers.get('upload-length');
  if (!uploadLengthHeader) {
    return createProblemDetailsResponse(400, 'Missing required "Upload-Length" header.', instanceUri, undefined, undefined, {
      'Tus-Resumable': TUS_RESUMABLE_VERSION,
    });
  }

  const uploadLength = Number.parseInt(uploadLengthHeader, 10);
  if (!Number.isFinite(uploadLength) || uploadLength < 0) {
    return createProblemDetailsResponse(400, 'Invalid "Upload-Length" header value.', instanceUri, undefined, undefined, {
      'Tus-Resumable': TUS_RESUMABLE_VERSION,
    });
  }

  if (uploadLength > TUS_MAX_SIZE) {
    return createProblemDetailsResponse(
      413,
      `Upload-Length exceeds maximum size of ${TUS_MAX_SIZE} bytes.`,
      instanceUri,
      undefined,
      undefined,
      { 'Tus-Resumable': TUS_RESUMABLE_VERSION }
    );
  }

  const metadataHeader = req.headers.get('upload-metadata') || undefined;

  try {
    const session = await tusEngine.createSession({
      uploadLength,
      metadataHeader,
      ownerUserId: auth.user.id,
    });

    const isTusSubpath = req.nextUrl?.pathname?.includes('/api/v1/uploads/tus');
    const basePath = isTusSubpath ? '/api/v1/uploads/tus' : '/api/v1/uploads';
    const location = `${basePath}/${session.id}`;

    let currentOffset = 0;
    let completedStorageKey: string | null = null;

    // Check for creation-with-upload: body present in POST
    const hasBody =
      req.body !== null &&
      (req.headers.has('upload-checksum') ||
        req.headers.get('content-type')?.includes('application/offset+octet-stream') ||
        (req.headers.get('content-length') && req.headers.get('content-length') !== '0'));

    if (hasBody && req.body) {
      const checksumHeader = req.headers.get('upload-checksum');
      try {
        const chunkResult = await tusEngine.appendChunk(session.id, 0, req.body, checksumHeader);
        currentOffset = chunkResult.newOffset;
        if (chunkResult.isComplete) {
          completedStorageKey = chunkResult.session.key;
        }
      } catch (err: any) {
        await tusEngine.terminateSession(session.id);
        if (err instanceof TusChecksumMismatchError) {
          return new NextResponse('Checksum Mismatch', { status: 460, headers: createTusHeaders() });
        }
        if (err instanceof TusInvalidChecksumHeaderError || err instanceof TusUnsupportedChecksumAlgorithmError) {
          return createProblemDetailsResponse(400, err.message, instanceUri, undefined, undefined, {
            'Tus-Resumable': TUS_RESUMABLE_VERSION,
          });
        }
        if (err instanceof TusUploadExceededLengthError) {
          return createProblemDetailsResponse(400, err.message, instanceUri, undefined, undefined, {
            'Tus-Resumable': TUS_RESUMABLE_VERSION,
          });
        }
        if (err instanceof UnknownDeclaredFormatError) {
          return createProblemDetailsResponse(400, err.message, instanceUri, 'Unknown Format', UNKNOWN_FORMAT_PROBLEM_TYPE, {
            'Tus-Resumable': TUS_RESUMABLE_VERSION,
          });
        }
        const storageProblem = storageErrorResponse(err, instanceUri, { 'Tus-Resumable': TUS_RESUMABLE_VERSION });
        if (storageProblem) return storageProblem;
        return createProblemDetailsResponse(
          400,
          err?.message || 'Error processing creation-with-upload chunk',
          instanceUri,
          undefined,
          undefined,
          { 'Tus-Resumable': TUS_RESUMABLE_VERSION }
        );
      }
    }

    const headers = createTusHeaders({
      Location: location,
      'Upload-Offset': String(currentOffset),
      'Upload-Expires': new Date(session.expiresAt).toUTCString(),
    });

    if (completedStorageKey) {
      headers.set('EasyConvert-Storage-Key', completedStorageKey);
      headers.set('X-Storage-Key', completedStorageKey);
    }

    return new NextResponse(null, { status: 201, headers });
  } catch (err: any) {
    if (err instanceof TusInvalidMetadataError) {
      return createProblemDetailsResponse(400, err.message, instanceUri, undefined, undefined, {
        'Tus-Resumable': TUS_RESUMABLE_VERSION,
      });
    }
    const storageProblem = storageErrorResponse(err, instanceUri, { 'Tus-Resumable': TUS_RESUMABLE_VERSION });
    if (storageProblem) return storageProblem;
    return createProblemDetailsResponse(
      500,
      err?.message || 'Failed to initialize TUS upload session',
      instanceUri,
      undefined,
      undefined,
      { 'Tus-Resumable': TUS_RESUMABLE_VERSION }
    );
  }
}

export async function HEAD(
  req: NextRequest,
  context: { params?: { id?: string[] } } = {}
) {
  const versionMismatch = checkTusVersion(req);
  if (versionMismatch) return versionMismatch;

  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads';
  const sessionId = resolveSessionId(context.params);

  if (!sessionId) {
    return createProblemDetailsResponse(404, 'TUS upload session ID required in request path.', instanceUri, undefined, undefined, {
      'Tus-Resumable': TUS_RESUMABLE_VERSION,
    });
  }

  // Guard check: Require authenticated access
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:read' });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      auth.problemType,
      { 'Tus-Resumable': TUS_RESUMABLE_VERSION, ...authErrorHeaders(auth) }
    );
  }

  const session = await tusEngine.getSession(sessionId);
  if (!session) {
    return new NextResponse('Upload Not Found', {
      status: 404,
      headers: createTusHeaders(),
    });
  }

  // User ownership check: protect resource identification fail-closed
  if (session.ownerUserId && session.ownerUserId !== auth.user.id) {
    return new NextResponse('Upload Not Found', {
      status: 404,
      headers: createTusHeaders(),
    });
  }

  const headers = createTusHeaders({
    'Upload-Offset': String(session.uploadOffset),
    'Upload-Length': String(session.uploadLength),
    'Upload-Expires': new Date(session.expiresAt).toUTCString(),
    'Cache-Control': 'no-store',
  });
  if (session.metadata) {
    headers.set('Upload-Metadata', session.metadata);
  }

  return new NextResponse(null, { status: 200, headers });
}

export async function PATCH(
  req: NextRequest,
  context: { params?: { id?: string[] } } = {}
) {
  const versionMismatch = checkTusVersion(req);
  if (versionMismatch) return versionMismatch;

  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads';
  const sessionId = resolveSessionId(context.params);

  if (!sessionId) {
    return createProblemDetailsResponse(404, 'TUS upload session ID required in request path.', instanceUri, undefined, undefined, {
      'Tus-Resumable': TUS_RESUMABLE_VERSION,
    });
  }

  // Guard check: Authenticate API key or user session with 'convert:write' scope
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      auth.problemType,
      { 'Tus-Resumable': TUS_RESUMABLE_VERSION, ...authErrorHeaders(auth) }
    );
  }

  const session = await tusEngine.getSession(sessionId);
  if (!session) {
    return new NextResponse('Upload Not Found', { status: 404, headers: createTusHeaders() });
  }

  // User ownership check: protect resource identification fail-closed
  if (session.ownerUserId && session.ownerUserId !== auth.user.id) {
    return new NextResponse('Upload Not Found', { status: 404, headers: createTusHeaders() });
  }

  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/offset+octet-stream')) {
    return new NextResponse('Content-Type must be application/offset+octet-stream', {
      status: 415,
      headers: createTusHeaders(),
    });
  }

  const offsetHeader = req.headers.get('upload-offset');
  if (offsetHeader === null) {
    return createProblemDetailsResponse(400, 'Missing required "Upload-Offset" header.', instanceUri, undefined, undefined, {
      'Tus-Resumable': TUS_RESUMABLE_VERSION,
    });
  }

  const clientOffset = Number.parseInt(offsetHeader, 10);
  if (!Number.isFinite(clientOffset) || clientOffset < 0) {
    return createProblemDetailsResponse(400, 'Invalid "Upload-Offset" header value.', instanceUri, undefined, undefined, {
      'Tus-Resumable': TUS_RESUMABLE_VERSION,
    });
  }

  const checksumHeader = req.headers.get('upload-checksum');

  if (!req.body) {
    return createProblemDetailsResponse(400, 'Empty PATCH payload body.', instanceUri, undefined, undefined, {
      'Tus-Resumable': TUS_RESUMABLE_VERSION,
    });
  }

  try {
    const result = await tusEngine.appendChunk(sessionId, clientOffset, req.body, checksumHeader);

    const headers = createTusHeaders({
      'Upload-Offset': String(result.newOffset),
      'Upload-Expires': new Date(result.session.expiresAt).toUTCString(),
    });

    if (result.isComplete) {
      headers.set('EasyConvert-Storage-Key', result.session.key);
      headers.set('X-Storage-Key', result.session.key);
    }

    return new NextResponse(null, { status: 204, headers });
  } catch (err: any) {
    if (err instanceof TusOffsetMismatchError) {
      const headers = createTusHeaders({ 'Upload-Offset': String(err.expectedOffset) });
      return new NextResponse('Offset Mismatch', { status: 409, headers });
    }
    if (err instanceof TusChecksumMismatchError) {
      return new NextResponse('Checksum Mismatch', { status: 460, headers: createTusHeaders() });
    }
    if (err instanceof TusNotFoundError) {
      return new NextResponse('Upload Not Found', { status: 404, headers: createTusHeaders() });
    }
    if (err instanceof TusInvalidChecksumHeaderError || err instanceof TusUnsupportedChecksumAlgorithmError) {
      return createProblemDetailsResponse(400, err.message, instanceUri, undefined, undefined, {
        'Tus-Resumable': TUS_RESUMABLE_VERSION,
      });
    }
    if (err instanceof TusUploadExceededLengthError) {
      return createProblemDetailsResponse(400, err.message, instanceUri, undefined, undefined, {
        'Tus-Resumable': TUS_RESUMABLE_VERSION,
      });
    }
    if (err instanceof UnknownDeclaredFormatError) {
      return createProblemDetailsResponse(400, err.message, instanceUri, 'Unknown Format', UNKNOWN_FORMAT_PROBLEM_TYPE, {
        'Tus-Resumable': TUS_RESUMABLE_VERSION,
      });
    }
    const storageProblem = storageErrorResponse(err, instanceUri, { 'Tus-Resumable': TUS_RESUMABLE_VERSION });
    if (storageProblem) return storageProblem;
    return createProblemDetailsResponse(400, err?.message || 'Error processing TUS chunk upload', instanceUri, undefined, undefined, {
      'Tus-Resumable': TUS_RESUMABLE_VERSION,
    });
  }
}

export async function PUT(
  req: NextRequest,
  context: { params?: { id?: string[] } } = {}
) {
  if (context.params?.id?.[0] === 'direct' && context.params.id[1] === 'part') {
    return directPartPutHandler(req);
  }
  return new NextResponse('Method Not Allowed', { status: 405 });
}

export async function DELETE(
  req: NextRequest,
  context: { params?: { id?: string[] } } = {}
) {
  if (context.params?.id?.[0] === 'direct' && context.params.id[1]) {
    return directDeleteHandler(req, { params: { id: context.params.id[1] } });
  }

  const versionMismatch = checkTusVersion(req);
  if (versionMismatch) return versionMismatch;

  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads';
  const sessionId = resolveSessionId(context.params);

  if (!sessionId) {
    return createProblemDetailsResponse(404, 'TUS upload session ID required in request path.', instanceUri, undefined, undefined, {
      'Tus-Resumable': TUS_RESUMABLE_VERSION,
    });
  }

  // Guard check: Authenticate API key or user session with 'convert:write' scope
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      auth.problemType,
      { 'Tus-Resumable': TUS_RESUMABLE_VERSION, ...authErrorHeaders(auth) }
    );
  }

  const session = await tusEngine.getSession(sessionId);
  if (!session) {
    return new NextResponse('Upload Not Found', { status: 404, headers: createTusHeaders() });
  }

  // User ownership check
  if (session.ownerUserId && session.ownerUserId !== auth.user.id) {
    return new NextResponse('Upload Not Found', { status: 404, headers: createTusHeaders() });
  }

  const deleted = await tusEngine.terminateSession(sessionId);
  if (!deleted) {
    return new NextResponse('Upload Not Found', { status: 404, headers: createTusHeaders() });
  }

  return new NextResponse(null, { status: 204, headers: createTusHeaders() });
}
