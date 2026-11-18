/**
 * CORS helpers for public `/api/v1/*` routes and TUS upload preflights.
 * Adapted from Hono CORS middleware (`honojs/hono`, commit `a8ae5b1d6e8502ce61cd9e7b853d8107e377fc7b`,
 * `src/middleware/cors/index.ts#L63-L164`, MIT License).
 */
import { NextResponse } from 'next/server';
import { LARGEST_PLAN_FILE_BYTES } from '@/lib/plan-limits';

export const V1_CORS_ALLOW_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const V1_CORS_ALLOW_METHODS_HEADER = V1_CORS_ALLOW_METHODS.join(', ');

export const V1_CORS_ALLOW_HEADERS = [
  'Authorization',
  'X-API-Key',
  'Content-Type',
  'Accept',
  'Idempotency-Key',
  'Tus-Resumable',
  'Upload-Length',
  'Upload-Offset',
  'Upload-Metadata',
  'Upload-Defer-Length',
  'Upload-Concat',
  'Upload-Checksum',
] as const;
export const V1_CORS_ALLOW_HEADERS_HEADER = V1_CORS_ALLOW_HEADERS.join(', ');

export const V1_CORS_EXPOSE_HEADERS = [
  'RateLimit',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'RateLimit-Policy',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'Retry-After',
  'Idempotency-Replayed',
  'Location',
  'Upload-Offset',
  'Upload-Length',
  'Upload-Metadata',
  'Upload-Expires',
  'Tus-Resumable',
  'Tus-Version',
  'Tus-Extension',
  'Tus-Max-Size',
  'ETag',
  'Content-Disposition',
  'X-Storage-Key',
  'EasyConvert-Storage-Key',
] as const;
export const V1_CORS_EXPOSE_HEADERS_HEADER = V1_CORS_EXPOSE_HEADERS.join(', ');

export const V1_CORS_MAX_AGE_SECONDS = '86400';

export const V1_TUS_RESUMABLE_VERSION = '1.0.0';

export const V1_TUS_CAPABILITY_HEADERS: Readonly<Record<string, string>> = {
  'Tus-Resumable': V1_TUS_RESUMABLE_VERSION,
  'Tus-Version': V1_TUS_RESUMABLE_VERSION,
  'Tus-Extension': 'creation,creation-with-upload,termination,expiration,checksum',
  'Tus-Max-Size': String(LARGEST_PLAN_FILE_BYTES),
  'Tus-Checksum-Algorithm': 'sha256',
};

export function isV1ApiPath(pathname: string): boolean {
  return pathname === '/api/v1' || pathname.startsWith('/api/v1/');
}

export function isV1TusUploadPath(pathname: string): boolean {
  return (
    pathname === '/api/v1/uploads' ||
    (pathname.startsWith('/api/v1/uploads/') && !pathname.startsWith('/api/v1/uploads/direct'))
  );
}

/**
 * Sets wildcard CORS headers for Bearer/API-key requests without `Access-Control-Allow-Credentials`
 * (RFC 6454 forbids credentials alongside wildcard origins).
 */
export function applyV1CorsHeaders<T extends Response>(response: T): T {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Expose-Headers', V1_CORS_EXPOSE_HEADERS_HEADER);
  response.headers.delete('Access-Control-Allow-Credentials');
  return response;
}

/** Builds a 204 CORS preflight response for `/api/v1/*`, preserving TUS headers on `/api/v1/uploads*`. */
export function createV1PreflightResponse(pathname: string): NextResponse {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', V1_CORS_EXPOSE_HEADERS_HEADER);
  headers.set('Access-Control-Max-Age', V1_CORS_MAX_AGE_SECONDS);
  headers.set('Access-Control-Allow-Methods', V1_CORS_ALLOW_METHODS_HEADER);
  headers.set('Access-Control-Allow-Headers', V1_CORS_ALLOW_HEADERS_HEADER);

  if (isV1TusUploadPath(pathname)) {
    for (const [key, value] of Object.entries(V1_TUS_CAPABILITY_HEADERS)) {
      headers.set(key, value);
    }
  }

  headers.delete('Content-Length');
  headers.delete('Content-Type');
  return new NextResponse(null, { status: 204, statusText: 'No Content', headers });
}
