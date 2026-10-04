import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import {
  tusEngine,
  TusOffsetMismatchError,
  TusChecksumMismatchError,
  TusNotFoundError,
} from '@/lib/storage/tus-engine';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';

export const dynamic = 'force-dynamic';

const TUS_RESUMABLE_VERSION = '1.0.0';
const TUS_MAX_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB

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
  return params.id[0];
}

export async function OPTIONS() {
  const headers = createTusHeaders({
    'Tus-Version': TUS_RESUMABLE_VERSION,
    'Tus-Extension': 'creation,termination,checksum,expiration',
    'Tus-Max-Size': String(TUS_MAX_SIZE),
    'Tus-Checksum-Algorithm': 'sha256,sha1',
    'Access-Control-Allow-Methods': 'POST, GET, HEAD, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Upload-Offset, Upload-Length, Upload-Metadata, Upload-Checksum, Tus-Resumable, Content-Type, Authorization, X-API-Key',
    'Access-Control-Expose-Headers':
      'Upload-Offset, Upload-Length, Upload-Metadata, Upload-Expires, Tus-Resumable, Tus-Version, Tus-Extension, Tus-Max-Size, Location, X-Storage-Key',
  });
  return new NextResponse(null, { status: 204, headers });
}

export async function POST(
  req: NextRequest,
  context: { params?: { id?: string[] } } = {}
) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads/tus';
  const sessionId = resolveSessionId(context.params);

  // If a session ID is provided in POST, reject as invalid TUS method
  if (sessionId) {
    return createProblemDetailsResponse(405, 'POST on existing upload resource is not supported. Use PATCH.', instanceUri);
  }

  // 1. Guard check: Authenticate API key or user session
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

  const clientVersion = req.headers.get('tus-resumable');
  if (clientVersion && clientVersion !== TUS_RESUMABLE_VERSION) {
    const headers = createTusHeaders({ 'Tus-Version': TUS_RESUMABLE_VERSION });
    return new NextResponse('Unsupported TUS version', { status: 412, headers });
  }

  const uploadLengthHeader = req.headers.get('upload-length');
  if (!uploadLengthHeader) {
    return createProblemDetailsResponse(400, 'Missing required "Upload-Length" header.', instanceUri);
  }

  const uploadLength = parseInt(uploadLengthHeader, 10);
  if (!Number.isFinite(uploadLength) || uploadLength < 0) {
    return createProblemDetailsResponse(400, 'Invalid "Upload-Length" header value.', instanceUri);
  }

  if (uploadLength > TUS_MAX_SIZE) {
    return createProblemDetailsResponse(413, `Upload-Length exceeds maximum size of ${TUS_MAX_SIZE} bytes.`, instanceUri);
  }

  const metadataHeader = req.headers.get('upload-metadata') || undefined;

  try {
    const session = await tusEngine.createSession({
      uploadLength,
      metadataHeader,
      ownerUserId: auth.user.id,
    });

    const location = `/api/v1/uploads/tus/${session.id}`;
    const headers = createTusHeaders({
      Location: location,
      'Upload-Expires': new Date(session.expiresAt).toUTCString(),
    });

    return new NextResponse(null, { status: 201, headers });
  } catch (err: any) {
    return createProblemDetailsResponse(500, err?.message || 'Failed to initialize TUS upload session', instanceUri);
  }
}

export async function HEAD(
  req: NextRequest,
  context: { params?: { id?: string[] } } = {}
) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads/tus';
  const sessionId = resolveSessionId(context.params);

  if (!sessionId) {
    return createProblemDetailsResponse(404, 'TUS upload session ID required in request path.', instanceUri);
  }

  const session = await tusEngine.getSession(sessionId);
  if (!session) {
    return new NextResponse('Upload Not Found', {
      status: 404,
      headers: createTusHeaders(),
    });
  }

  const headers = createTusHeaders({
    'Upload-Offset': String(session.uploadOffset),
    'Upload-Length': String(session.uploadLength),
    'Upload-Metadata': session.metadata,
    'Upload-Expires': new Date(session.expiresAt).toUTCString(),
    'Cache-Control': 'no-store',
  });

  return new NextResponse(null, { status: 200, headers });
}

export async function PATCH(
  req: NextRequest,
  context: { params?: { id?: string[] } } = {}
) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads/tus';
  const sessionId = resolveSessionId(context.params);

  if (!sessionId) {
    return createProblemDetailsResponse(404, 'TUS upload session ID required in request path.', instanceUri);
  }

  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('application/offset+octet-stream')) {
    return new NextResponse('Content-Type must be application/offset+octet-stream', {
      status: 415,
      headers: createTusHeaders(),
    });
  }

  const offsetHeader = req.headers.get('upload-offset');
  if (offsetHeader === null) {
    return createProblemDetailsResponse(400, 'Missing required "Upload-Offset" header.', instanceUri);
  }

  const clientOffset = parseInt(offsetHeader, 10);
  if (!Number.isFinite(clientOffset) || clientOffset < 0) {
    return createProblemDetailsResponse(400, 'Invalid "Upload-Offset" header value.', instanceUri);
  }

  const checksumHeader = req.headers.get('upload-checksum');

  if (!req.body) {
    return createProblemDetailsResponse(400, 'Empty PATCH payload body.', instanceUri);
  }

  try {
    const result = await tusEngine.appendChunk(sessionId, clientOffset, req.body, checksumHeader);

    const headers = createTusHeaders({
      'Upload-Offset': String(result.newOffset),
      'Upload-Expires': new Date(result.session.expiresAt).toUTCString(),
    });

    if (result.isComplete) {
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
    return createProblemDetailsResponse(400, err?.message || 'Error processing TUS chunk upload', instanceUri);
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params?: { id?: string[] } } = {}
) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/uploads/tus';
  const sessionId = resolveSessionId(context.params);

  if (!sessionId) {
    return createProblemDetailsResponse(404, 'TUS upload session ID required in request path.', instanceUri);
  }

  const deleted = await tusEngine.terminateSession(sessionId);
  if (!deleted) {
    return new NextResponse('Upload Not Found', { status: 404, headers: createTusHeaders() });
  }

  return new NextResponse(null, { status: 204, headers: createTusHeaders() });
}
