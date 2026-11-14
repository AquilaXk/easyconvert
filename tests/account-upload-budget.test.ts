import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { DELETE as uploadsDelete, PATCH as uploadsPatch, POST as uploadsPost } from '../src/app/api/v1/uploads/[[...id]]/route';
import { POST as directPost } from '../src/app/api/v1/uploads/direct/route';
import { DELETE as directDelete } from '../src/app/api/v1/uploads/direct/[id]/route';
import { POST as directComplete } from '../src/app/api/v1/uploads/direct/complete/route';
import { PUT as directPart } from '../src/app/api/v1/uploads/direct/part/route';
import { bytesBroughtInToday } from '../src/lib/api-keys/anonymous-upload-budget';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';

// Hand-written from the brief and the policy entries: the open sessions and the declared bytes in flight, by plan.
const FREE_OPEN_UPLOADS = 5;
const PAID_OPEN_UPLOADS = 25;
const FREE_OPEN_BYTES = 2 * 1024 ** 3;
const GIB = 1024 ** 3;
const BASE_URL = 'http://localhost:3000';
const BUDGET_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/upload-budget-exceeded';

interface Account {
  id: string;
  headers: Record<string, string>;
}

async function account(tier: 'free' | 'paid'): Promise<Account> {
  const email = `open_${tier}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@budget.test`;
  const user = userStore.sanitizeUser(await userStore.createUser({ emailVerified: true, email, name: 'open', tier }));
  return { id: user.id, headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` } };
}

function json(path: string, headers: Record<string, string>, body: unknown, method = 'POST'): NextRequest {
  return new NextRequest(`${BASE_URL}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

const NO_PARAMS = { params: Promise.resolve({}) };

/** One way to open an upload session, and the way to end it again. */
interface Route {
  name: string;
  open(headers: Record<string, string>, totalSize: number): Promise<{ response: Response; uploadId?: string }>;
  abort(headers: Record<string, string>, uploadId: string): Promise<Response>;
  /** Sends `content` as the one part of the session and completes it; `initiated` is what the opening answered. */
  finish(headers: Record<string, string>, uploadId: string, initiated: { parts?: Array<{ uploadUrl: string }> }, content: Buffer): Promise<void>;
}

const ROUTES: Route[] = [
  {
    name: 'POST /api/storage/multipart',
    async open(headers, totalSize) {
      const response = await multipartPost(json('/api/storage/multipart?action=initiate', headers, { filename: 'a.csv', totalSize }));
      return { response, uploadId: response.status === 200 ? (await response.clone().json()).uploadId : undefined };
    },
    abort: (headers, uploadId) => multipartPost(json('/api/storage/multipart?action=abort', headers, { uploadId })),
    async finish(headers, uploadId, _initiated, content) {
      const part = await multipartPost(
        new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${uploadId}&partNumber=1`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', ...headers },
          body: new Uint8Array(content),
        })
      );
      expect(part.status).toBe(200);
      const { etag } = await part.json();
      const done = await multipartPost(json('/api/storage/multipart?action=complete', headers, { uploadId, parts: [{ partNumber: 1, etag }] }));
      expect(done.status).toBe(200);
    },
  },
  {
    name: 'POST /api/v1/uploads?action=initiate',
    async open(headers, totalSize) {
      const response = await uploadsPost(json('/api/v1/uploads?action=initiate', headers, { filename: 'a.csv', totalSize }), NO_PARAMS);
      return { response, uploadId: response.status === 200 ? (await response.clone().json()).uploadId : undefined };
    },
    abort: (headers, uploadId) => uploadsPost(json('/api/v1/uploads?action=abort', headers, { uploadId }), NO_PARAMS),
    async finish(headers, uploadId, _initiated, content) {
      const part = await uploadsPost(
        new NextRequest(`${BASE_URL}/api/v1/uploads?action=part&uploadId=${uploadId}&partNumber=1`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', ...headers },
          body: new Uint8Array(content),
        }),
        NO_PARAMS
      );
      expect(part.status).toBe(200);
      const { part: stored } = await part.json();
      const done = await uploadsPost(json('/api/v1/uploads?action=complete', headers, { uploadId, parts: [{ partNumber: 1, etag: stored.etag }] }), NO_PARAMS);
      expect(done.status).toBe(200);
    },
  },
  {
    name: 'POST /api/v1/uploads/direct',
    async open(headers, totalSize) {
      const response = await directPost(json('/api/v1/uploads/direct', headers, { filename: 'a.csv', totalSize }));
      return { response, uploadId: response.status === 200 ? (await response.clone().json()).uploadId : undefined };
    },
    abort: (headers, uploadId) => directDelete(new NextRequest(`${BASE_URL}/api/v1/uploads/direct/${uploadId}`, { method: 'DELETE', headers }), { params: Promise.resolve({ id: uploadId }) }),
    async finish(headers, uploadId, initiated, content) {
      const part = await directPart(
        new NextRequest(initiated.parts![0].uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(content.length) },
          body: new Uint8Array(content),
        })
      );
      expect(part.status).toBe(200);
      const { etag } = await part.json();
      const done = await directComplete(json('/api/v1/uploads/direct/complete', headers, { uploadId, parts: [{ partNumber: 1, etag }] }));
      expect(done.status).toBe(200);
    },
  },
  {
    name: 'POST /api/v1/uploads (resumable)',
    async open(headers, totalSize) {
      const response = await uploadsPost(new NextRequest(`${BASE_URL}/api/v1/uploads`, { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(totalSize), 'Upload-Metadata': `filename ${Buffer.from('a.csv').toString('base64')},filetype ${Buffer.from('text/csv').toString('base64')}`, ...headers } }), NO_PARAMS);
      return { response, uploadId: response.status === 201 ? response.headers.get('Location')!.split('/').pop()! : undefined };
    },
    abort: (headers, uploadId) =>
      uploadsDelete(new NextRequest(`${BASE_URL}/api/v1/uploads/tus/${uploadId}`, { method: 'DELETE', headers: { 'Tus-Resumable': '1.0.0', ...headers } }), { params: Promise.resolve({ id: [uploadId] }) }),
    async finish(headers, uploadId, _initiated, content) {
      const patch = await uploadsPatch(
        new NextRequest(`${BASE_URL}/api/v1/uploads/tus/${uploadId}`, {
          method: 'PATCH',
          headers: { 'Tus-Resumable': '1.0.0', 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0', ...headers },
          body: new Uint8Array(content),
        }),
        { params: Promise.resolve({ id: [uploadId] }) }
      );
      expect(patch.status).toBe(204);
    },
  },
];

const opened: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const end of opened.splice(0)) await end().catch(() => undefined);
});

/** Opens a session of `route` and registers its end for the test's cleanup. */
async function open(route: Route, who: Account, totalSize = 1024): Promise<Response> {
  const { response, uploadId } = await route.open(who.headers, totalSize);
  if (uploadId) opened.push(() => route.abort(who.headers, uploadId));
  return response;
}

const accepted = (response: Response): boolean => response.status === 200 || response.status === 201;

describe.each(ROUTES)('the open uploads of an account on $name', (route) => {
  it('stops a free account at 5 open sessions with a 429 that names the limit and the plan, and an abort makes room for one', async () => {
    const who = await account('free');
    const first = await route.open(who.headers, 1024);
    expect(accepted(first.response)).toBe(true);
    for (let i = 1; i < FREE_OPEN_UPLOADS; i++) expect(accepted(await open(route, who))).toBe(true);

    const refused = await route.open(who.headers, 1024);
    expect(refused.response.status).toBe(429);
    expect(await refused.response.json()).toMatchObject({
      type: BUDGET_PROBLEM_TYPE,
      refusal: 'open-uploads',
      limit: FREE_OPEN_UPLOADS,
      plan: 'free',
      detail: `Up to ${FREE_OPEN_UPLOADS} uploads may be open at once on the free plan. Finish or cancel one, then try again.`,
    });

    expect([200, 204]).toContain((await route.abort(who.headers, first.uploadId!)).status);
    expect(accepted(await open(route, who))).toBe(true);
  });

  it('stops a free account whose open sessions declare more than 2 GiB between them, and an abort gives the bytes back', async () => {
    const who = await account('free');
    const first = await route.open(who.headers, GIB);
    expect(accepted(first.response)).toBe(true);
    expect(accepted(await open(route, who, GIB))).toBe(true);

    const refused = await route.open(who.headers, 1024);
    expect(refused.response.status).toBe(429);
    expect(await refused.response.json()).toMatchObject({
      type: BUDGET_PROBLEM_TYPE,
      refusal: 'open-bytes',
      limitBytes: FREE_OPEN_BYTES,
      plan: 'free',
    });

    await route.abort(who.headers, first.uploadId!);
    expect(accepted(await open(route, who, 1024))).toBe(true);
  });

  it('counts the sessions of one account only', async () => {
    const full = await account('free');
    for (let i = 0; i < FREE_OPEN_UPLOADS; i++) await open(route, full);
    const other = await account('free');
    expect(accepted(await open(route, other))).toBe(true);
  });

  it('charges no byte of the day to the account, whose link imports have a budget of their own', async () => {
    const who = await account('free');
    await open(route, who, GIB);
    expect(await bytesBroughtInToday(who.id)).toBe(0);
  });
});

describe('the plans', () => {
  it('lets a paid account hold 25 open sessions and declare 20 GiB between them', async () => {
    const who = await account('paid');
    const [route] = ROUTES.filter((entry) => entry.name.includes('?action=initiate'));
    for (let i = 0; i < PAID_OPEN_UPLOADS; i++) expect(accepted(await open(route, who)), `session ${i + 1}`).toBe(true);

    const refused = await route.open(who.headers, 1024);
    expect(refused.response.status).toBe(429);
    expect(await refused.response.json()).toMatchObject({ refusal: 'open-uploads', limit: PAID_OPEN_UPLOADS, plan: 'paid' });

    const bytes = await account('paid');
    for (let i = 0; i < 2; i++) expect(accepted(await open(route, bytes, 10 * GIB))).toBe(true);
    const over = await route.open(bytes.headers, 1024);
    expect(await over.response.json()).toMatchObject({ refusal: 'open-bytes', limitBytes: 20 * GIB, plan: 'paid' });
  });
});

describe.each(ROUTES)('a session that is completed frees its room on $name', (route) => {
  const FILE = Buffer.from('a,b\n1,2\n');

  it('and the account is held to its 5 open sessions again after one more', async () => {
    const who = await account('free');
    const first = await route.open(who.headers, FILE.length);
    opened.push(() => route.abort(who.headers, first.uploadId!));
    const initiated = await first.response.json().catch(() => ({}));
    for (let i = 1; i < FREE_OPEN_UPLOADS; i++) await open(route, who, FILE.length);
    expect((await route.open(who.headers, FILE.length)).response.status).toBe(429);

    await route.finish(who.headers, first.uploadId!, initiated, FILE);

    expect(accepted(await open(route, who, FILE.length))).toBe(true);
    expect((await route.open(who.headers, FILE.length)).response.status).toBe(429);
  });
});
