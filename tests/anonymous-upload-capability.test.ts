import crypto from 'node:crypto';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { DELETE as queueJobDelete } from '../src/app/api/queue/jobs/[id]/route';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import {
  ANONYMOUS_UPLOAD_OWNER,
  anonymousUserId,
  isAnonymousUserId,
  mayUseUploadSession,
} from '../src/lib/auth/anonymous-identity';
import { resetAnonymousUploadBudget } from '../src/lib/api-keys/anonymous-upload-budget';

const BASE_URL = 'http://localhost:3000';
const MIB = 1024 * 1024;
const PART_BYTES = 5 * MIB;

const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  resetAnonymousUploadBudget();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function from(address: string): Record<string, string> {
  return { 'x-forwarded-for': address };
}

async function signedIn(): Promise<Record<string, string>> {
  const email = `cap_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@capability.test`;
  const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'cap', tier: 'free' }));
  return { Cookie: `easyconvert_session=${createSessionToken(user)}` };
}

function multipart(action: string, body: unknown, headers: Record<string, string>): NextRequest {
  return new NextRequest(`${BASE_URL}/api/storage/multipart?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function part(uploadId: string, partNumber: number, bytes: Buffer, headers: Record<string, string>): NextRequest {
  return new NextRequest(
    `${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: new Uint8Array(bytes) }
  );
}

function csvBytes(length: number): Buffer {
  const row = 'a,b,c\n';
  return Buffer.from(row.repeat(Math.ceil(length / row.length))).subarray(0, length);
}

async function open(headers: Record<string, string>, totalSize: number): Promise<{ uploadId: string; key: string }> {
  const res = await multipartPost(multipart('initiate', { filename: 'large.csv', mimeType: 'text/csv', totalSize, partSize: PART_BYTES }, headers));
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  cleanups.push(() => {
    s3Storage.abortMultipartUpload(body.uploadId);
    s3Storage.deleteObject(body.key);
  });
  return body;
}

describe('an anonymous upload is reached by its random id and key, never by the address of the visitor', () => {
  it('lets an IPv6 visitor upload in parts, complete and start the job on the stored file', async () => {
    const visitor = from('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const first = csvBytes(PART_BYTES);
    const second = csvBytes(2048);
    const { uploadId, key } = await open(visitor, first.length + second.length);
    expect(key).toMatch(/^uploads\//);
    expect(key).not.toContain('2001');
    expect(key).not.toContain('anon');

    const receipts = [];
    for (const [index, bytes] of [first, second].entries()) {
      const stored = await multipartPost(part(uploadId, index + 1, bytes, visitor));
      expect(stored.status).toBe(200);
      receipts.push({ partNumber: index + 1, etag: (await stored.json()).etag });
    }
    const done = await multipartPost(multipart('complete', { uploadId, parts: receipts }, visitor));
    expect(done.status).toBe(200);
    expect((await done.json()).key).toBe(key);

    const queued = await queueJobsPost(
      new NextRequest(`${BASE_URL}/api/queue/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...visitor },
        body: JSON.stringify({ filename: 'large.csv', targetFormat: 'json', storageKey: key }),
      })
    );
    const job = await queued.json();
    expect(queued.status, JSON.stringify(job)).toBe(200);
    await queueJobDelete(new NextRequest(`${BASE_URL}/api/queue/jobs/${job.jobId}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id: job.jobId }),
    });
  });

  it('keeps the upload of a visitor whose address changes between the parts', async () => {
    const bytes = csvBytes(4096);
    const { uploadId } = await open(from('203.0.113.10'), bytes.length);

    const stored = await multipartPost(part(uploadId, 1, bytes, from('198.51.100.20')));
    expect(stored.status).toBe(200);
    const done = await multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag: (await stored.json()).etag }] }, from('2001:db8:9::1')));
    expect(done.status).toBe(200);
  });

  it('answers a signed-in caller like a missing session on an anonymous upload', async () => {
    const { uploadId } = await open(from('203.0.113.30'), 4096);
    const account = await signedIn();

    expect((await multipartPost(part(uploadId, 1, csvBytes(4096), account))).status).toBe(404);
    expect((await multipartPost(multipart('abort', { uploadId }, account))).status).toBe(404);
  });

  it('answers a visitor like a missing session on the upload of an account', async () => {
    const account = await signedIn();
    const { uploadId, key } = await open(account, 4096);
    expect(key).toMatch(/^conversions\/[^/]+\//);
    expect(key).not.toContain('anon');

    expect((await multipartPost(part(uploadId, 1, csvBytes(4096), from('203.0.113.31')))).status).toBe(404);
  });
});

describe('the anonymous identity', () => {
  it('builds the id the quota counts from the address bucket and recognizes it', () => {
    expect(anonymousUserId('2001:db8:1:2::/64')).toBe('anon:2001:db8:1:2::/64');
    expect(isAnonymousUserId(anonymousUserId('203.0.113.7'))).toBe(true);
    expect(isAnonymousUserId('user_1')).toBe(false);
    expect(isAnonymousUserId('')).toBe(false);
    expect(isAnonymousUserId(undefined)).toBe(false);
  });

  it('opens an anonymous session to every anonymous caller and to no account, and an account session to its owner only', () => {
    expect(isAnonymousUserId(ANONYMOUS_UPLOAD_OWNER)).toBe(true);
    expect(ANONYMOUS_UPLOAD_OWNER).not.toMatch(/\d/);
    expect(mayUseUploadSession(ANONYMOUS_UPLOAD_OWNER, anonymousUserId('203.0.113.7'))).toBe(true);
    expect(mayUseUploadSession(ANONYMOUS_UPLOAD_OWNER, 'user_1')).toBe(false);
    expect(mayUseUploadSession('user_1', 'user_1')).toBe(true);
    expect(mayUseUploadSession('user_1', 'user_2')).toBe(false);
    expect(mayUseUploadSession('user_1', anonymousUserId('203.0.113.7'))).toBe(false);
    expect(mayUseUploadSession(undefined, anonymousUserId('203.0.113.7'))).toBe(false);
  });
});
