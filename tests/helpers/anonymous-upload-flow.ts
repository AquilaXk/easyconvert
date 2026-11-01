import { afterEach, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as multipartPost } from '../../src/app/api/storage/multipart/route';
import { s3Storage } from '../../src/lib/storage/s3-storage';

/** The requests of a visitor's upload through `/api/storage/multipart`, made by the real route. */

export const BASE_URL = 'http://localhost:3000';
export const UNAVAILABLE_DETAIL = 'A service this upload needs is temporarily unavailable. Retry the request shortly.';

/** What a test made on the server and must remove, run after the test. */
export const cleanups: Array<() => Promise<void> | void> = [];

/** Declares the proxies that attribute a request to an address, and runs the cleanups after each test. Call it once at the top of a test file. */
export function installUploadFlowHooks(): void {
  beforeEach(() => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
}

export function from(address: string): Record<string, string> {
  return { 'x-forwarded-for': address };
}

export function multipart(action: string, body: unknown, headers: Record<string, string>): NextRequest {
  return new NextRequest(`${BASE_URL}/api/storage/multipart?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export async function initiate(headers: Record<string, string>, totalSize: number): Promise<Response> {
  const res = await multipartPost(multipart('initiate', { filename: 'big.csv', totalSize }, headers));
  if (res.status === 200) {
    const { uploadId } = await res.clone().json();
    cleanups.push(async () => {
      await s3Storage.abortMultipartUpload(uploadId);
    });
  }
  return res;
}

export function part(uploadId: string, bytes: Buffer, headers: Record<string, string>): NextRequest {
  return new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(uploadId)}&partNumber=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body: new Uint8Array(bytes),
  });
}

/** An upload of one part, opened and sent but not completed. */
export async function stagedUpload(address: string): Promise<{ visitor: Record<string, string>; uploadId: string; etag: string; bytes: Buffer }> {
  const visitor = from(address);
  const bytes = Buffer.from('a,b\n1,2\n');
  const { uploadId } = await (await initiate(visitor, bytes.length)).json();
  const { etag } = await (await multipartPost(part(uploadId, bytes, visitor))).json();
  return { visitor, uploadId, etag, bytes };
}
