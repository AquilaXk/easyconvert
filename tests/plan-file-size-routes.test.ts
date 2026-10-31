import crypto from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { POST as directPost } from '../src/app/api/v1/uploads/direct/route';
import { POST as uploadsPost, OPTIONS as uploadsOptions } from '../src/app/api/v1/uploads/[[...id]]/route';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { POST as legacyJobsPost } from '../src/app/api/queue/jobs/route';
import { storageProvider } from '../src/lib/storage';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { tusEngine } from '../src/lib/storage/tus-engine';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import type { User } from '../src/lib/auth/types';
import { LARGEST_PLAN_FILE_BYTES, PLAN_MAX_FILE_BYTES, SINGLE_REQUEST_BODY_MAX_BYTES } from '../src/lib/plan-limits';

const BASE_URL = 'http://localhost:3000';
const GIB = 1024 * 1024 * 1024;
const PAYLOAD_TOO_LARGE = 413;

type SignedInPlan = 'free' | 'pro' | 'enterprise';

interface PlanCase {
  plan: 'anonymous' | SignedInPlan;
  limit: number;
}

const PLAN_CASES: readonly PlanCase[] = [
  { plan: 'anonymous', limit: PLAN_MAX_FILE_BYTES.anonymous },
  { plan: 'free', limit: PLAN_MAX_FILE_BYTES.free },
  { plan: 'pro', limit: PLAN_MAX_FILE_BYTES.pro },
  { plan: 'enterprise', limit: PLAN_MAX_FILE_BYTES.enterprise },
];
const SIGNED_IN_CASES = PLAN_CASES.filter((c): c is PlanCase & { plan: SignedInPlan } => c.plan !== 'anonymous');

const ROUTE_CONTEXT = { params: Promise.resolve({}) };

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createUser(tier: SignedInPlan): Promise<User> {
  const email = `${tier}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@plan-size.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: tier, tier }));
}

async function headersFor(plan: PlanCase['plan'], extra: Record<string, string> = {}): Promise<Record<string, string>> {
  if (plan === 'anonymous') return extra;
  const user = await createUser(plan);
  return { Cookie: `easyconvert_session=${createSessionToken(user)}`, ...extra };
}

/** A File that claims `size` bytes, since no test can send gigabytes. */
function claimedFile(name: string, size: number): File {
  const file = new File([], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/** A multipart request whose form holds one file of the claimed size and the given text fields. */
function formRequest(
  path: string,
  headers: Record<string, string>,
  file: { field: string; name: string; size: number },
  fields: Record<string, string> = {}
): NextRequest {
  const req = new NextRequest(`${BASE_URL}${path}`, { method: 'POST', headers });
  const form = new FormData();
  form.append(file.field, claimedFile(file.name, file.size));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  Object.defineProperty(req, 'formData', { value: async () => form });
  return req;
}

function jsonRequest(path: string, headers: Record<string, string>, body: unknown): NextRequest {
  return new NextRequest(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** The 413 of a file over the plan limit: the size and the limit, and no plan offered while none is on sale. */
async function expectTooLarge(res: Response): Promise<void> {
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(PAYLOAD_TOO_LARGE);
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  expect(body).toMatchObject({ status: PAYLOAD_TOO_LARGE, title: 'Payload Too Large', success: false });
  expect(body.detail).toMatch(/exceeds the \d+ GiB limit for /);
  expect(body.detail).not.toContain('allows files up to');
}

describe('the routes that take a file in one request reach no plan limit', () => {
  it('carry at most 64 MiB, which every plan allows, so their 413 is the one of the request size', () => {
    for (const planCase of PLAN_CASES) expect(SINGLE_REQUEST_BODY_MAX_BYTES).toBeLessThan(planCase.limit);
  });

  it.each([
    ['/api/convert', convertPost, 'file'],
    ['/api/convert/batch', batchPost, 'files'],
  ] as const)('%s does not refuse a form file on the plan limit', async (path, post, field) => {
    const res = await post(formRequest(path, {}, { field, name: 'a.csv', size: PLAN_MAX_FILE_BYTES.anonymous + 1 }));
    expect(res.status).not.toBe(PAYLOAD_TOO_LARGE);
  });

  it('/api/v1/convert does not refuse a form file on the plan limit', async () => {
    const headers = await headersFor('free');
    const res = await v1ConvertPost(formRequest('/api/v1/convert', headers, { field: 'file', name: 'a.png', size: PLAN_MAX_FILE_BYTES.free + 1 }, { targetFormat: 'nope' }));
    expect(res.status).not.toBe(PAYLOAD_TOO_LARGE);
  });
});

describe('/api/storage/multipart sizes an upload by the plan limit', () => {
  it.each(SIGNED_IN_CASES)('refuses an initiate one byte past the $plan limit and opens one at the limit', async (planCase) => {
    const headers = await headersFor(planCase.plan, { 'Content-Type': 'application/json' });
    const initiate = (totalSize: number) =>
      multipartPost(
        new NextRequest(`${BASE_URL}/api/storage/multipart?action=initiate`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ filename: 'archive.zip', mimeType: 'application/zip', totalSize }),
        })
      );

    await expectTooLarge(await initiate(planCase.limit + 1));

    const accepted = await initiate(planCase.limit);
    expect(accepted.status).toBe(200);
    const { uploadId } = await accepted.json();
    cleanups.push(() => {
      s3Storage.abortMultipartUpload(uploadId);
    });
  });

  it('refuses a part that would bring the stored bytes past the declared size before it reads the part', async () => {
    const headers = await headersFor('free', { 'Content-Type': 'application/json' });
    const init = await multipartPost(
      new NextRequest(`${BASE_URL}/api/storage/multipart?action=initiate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename: 'archive.zip', totalSize: 1024 }),
      })
    );
    const { uploadId } = await init.json();
    cleanups.push(() => {
      s3Storage.abortMultipartUpload(uploadId);
    });
    vi.spyOn(s3Storage, 'getUploadedParts').mockReturnValue([{ partNumber: 1, etag: 'e', size: 1014 }]);

    const part = await multipartPost(
      new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk`, {
        method: 'POST',
        headers: { ...headers, 'x-upload-id': uploadId, 'x-part-number': '2', 'content-length': '11' },
        body: Buffer.from('x'),
      })
    );
    expect(part.status).toBe(PAYLOAD_TOO_LARGE);
    expect((await part.json()).detail).toBe('This part would bring the upload to 1025 bytes, past the 1024 bytes it declared.');
  });
});

describe('/api/v1/uploads/direct sizes an upload by the plan limit', () => {
  it.each(SIGNED_IN_CASES)('refuses a total one byte past the $plan limit', async (planCase) => {
    const headers = await headersFor(planCase.plan);
    const res = await directPost(
      jsonRequest('/api/v1/uploads/direct', headers, { filename: 'big.bin', totalSize: planCase.limit + 1 })
    );
    await expectTooLarge(res);
  });

  it.each(SIGNED_IN_CASES)('does not refuse a total of exactly the $plan limit on size', async (planCase) => {
    const headers = await headersFor(planCase.plan);
    const res = await directPost(
      jsonRequest('/api/v1/uploads/direct', headers, { filename: 'big.bin', totalSize: planCase.limit })
    );
    expect(res.status).not.toBe(PAYLOAD_TOO_LARGE);
  });
});

describe('/api/v1/uploads (multipart sessions and resumable uploads) size an upload by the plan limit', () => {
  it.each(SIGNED_IN_CASES)('refuses an initiate one byte past the $plan limit', async (planCase) => {
    const headers = await headersFor(planCase.plan);
    const res = await uploadsPost(
      jsonRequest('/api/v1/uploads?action=initiate', headers, { filename: 'big.bin', totalSize: planCase.limit + 1 }),
      ROUTE_CONTEXT
    );
    await expectTooLarge(res);
  });

  const tusCreate = (headers: Record<string, string>, length: number) =>
    uploadsPost(
      new NextRequest(`${BASE_URL}/api/v1/uploads`, {
        method: 'POST',
        headers: { ...headers, 'Tus-Resumable': '1.0.0', 'Upload-Length': String(length), 'Upload-Metadata': 'filename YS5iaW4=' },
      }),
      ROUTE_CONTEXT
    );

  it.each(SIGNED_IN_CASES)('refuses a resumable upload one byte past the $plan limit and creates one at the limit', async (planCase) => {
    const headers = await headersFor(planCase.plan);

    const over = await tusCreate(headers, planCase.limit + 1);
    await expectTooLarge(over);
    expect(over.headers.get('tus-resumable')).toBe('1.0.0');

    const created = await tusCreate(headers, planCase.limit);
    expect(created.status).toBe(201);
    const sessionId = created.headers.get('location')?.split('/').pop();
    expect(sessionId).toBeTruthy();
    cleanups.push(() => tusEngine.terminateSession(sessionId!));
  });

  it('advertises the largest plan limit as the ceiling of a resumable upload', () => {
    expect(uploadsOptions().headers.get('Tus-Max-Size')).toBe(String(LARGEST_PLAN_FILE_BYTES));
    expect(tusEngine.maxUploadSize).toBe(LARGEST_PLAN_FILE_BYTES);
  });
});

describe('job routes size a stored input by the plan limit', () => {
  async function storeFor(user: User): Promise<string> {
    const key = `uploads/plan-size_${crypto.randomBytes(6).toString('hex')}.csv`;
    storageProvider.saveObject(key, Buffer.from('a,b\n1,2\n'), 'text/csv', 'a.csv', 60_000, user.id);
    cleanups.push(() => {
      storageProvider.deleteObject(key);
    });
    return key;
  }

  it.each(SIGNED_IN_CASES)('refuses a stored input one byte past the $plan limit on /api/v1/jobs', async (planCase) => {
    const user = await createUser(planCase.plan);
    const key = await storeFor(user);
    const real = await storageProvider.stat(key);
    vi.spyOn(storageProvider, 'stat').mockResolvedValue({ ...real!, size: planCase.limit + 1 });

    const res = await v1JobsPost(
      jsonRequest('/api/v1/jobs', { Cookie: `easyconvert_session=${createSessionToken(user)}` }, { originalFilename: 'a.csv', targetFormat: 'json', storageKey: key })
    );
    await expectTooLarge(res);
  });

  it.each(SIGNED_IN_CASES)('refuses a stored input one byte past the $plan limit on /api/queue/jobs', async (planCase) => {
    const user = await createUser(planCase.plan);
    const key = await storeFor(user);
    const real = await storageProvider.stat(key);
    vi.spyOn(storageProvider, 'stat').mockResolvedValue({ ...real!, size: planCase.limit + 1 });

    const res = await legacyJobsPost(
      jsonRequest('/api/queue/jobs', { Cookie: `easyconvert_session=${createSessionToken(user)}` }, { filename: 'a.csv', targetFormat: 'json', storageKey: key })
    );
    await expectTooLarge(res);
  });

  it.each(SIGNED_IN_CASES)('queues a stored input of exactly the $plan limit on /api/v1/jobs', async (planCase) => {
    const user = await createUser(planCase.plan);
    const key = await storeFor(user);
    const real = await storageProvider.stat(key);
    vi.spyOn(storageProvider, 'stat').mockResolvedValue({ ...real!, size: planCase.limit });

    const res = await v1JobsPost(
      jsonRequest('/api/v1/jobs', { Cookie: `easyconvert_session=${createSessionToken(user)}` }, { originalFilename: 'a.csv', targetFormat: 'json', storageKey: key })
    );
    expect(res.status).not.toBe(PAYLOAD_TOO_LARGE);
  });
});
