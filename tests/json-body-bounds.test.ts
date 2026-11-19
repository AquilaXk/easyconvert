import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { requestBodyVerdict } from '../src/lib/api/request-body-limit';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { POST as queueJobsRoute } from '../src/app/api/queue/jobs/route';
import { POST as toolJobsRoute } from '../src/app/api/tools/jobs/route';
import { POST as v1JobsRoute } from '../src/app/api/v1/jobs/route';

/**
 * A job request may carry its file inline as base64 (at most 32 MiB of file), so its JSON body is that file as base64 and a few
 * fields: 43,690,667 + 65,536 bytes, not the 65 MiB of a file in one request. A JSON body is also read whole into objects, so a body
 * with more than 65,536 objects and arrays is refused (413) before it is parsed: 65 MiB of `{},` is millions of objects.
 */
const MIB = 1024 * 1024;
const INLINE_BASE64_BYTES = Math.ceil((32 * MIB) / 3) * 4;
const ENVELOPE_BYTES = 64 * 1024;
const JSON_TYPE = { 'content-type': 'application/json' };
const BASE_URL = 'http://localhost:3000';
const MANY_OBJECTS = `[${'{},'.repeat(70_000)}{}]`;

let apiKey = '';

beforeAll(async () => {
  const user = await userStore.createUser({ email: `json_bounds_${crypto.randomBytes(6).toString('hex')}@bounds.test`, name: 'Bounds', tier: 'paid' });
  apiKey = (await redisKeyStore.generateApiKey(user.id, 'Bounds Key', { scopes: ['convert:write', 'convert:read'] })).secretKey;
});

function verdict(route: string, length: number) {
  return requestBodyVerdict(new URL(`${BASE_URL}${route}`), new Headers({ ...JSON_TYPE, 'content-length': String(length) }));
}

function post(route: string, body: string): NextRequest {
  return new NextRequest(`${BASE_URL}${route}`, { method: 'POST', headers: { ...JSON_TYPE, Authorization: `Bearer ${apiKey}` }, body });
}

describe('the JSON body of a job request', () => {
  it.each(['/api/queue/jobs', '/api/v1/jobs'])('takes %s up to the inline file as base64 and its fields, and no more', (route) => {
    expect(verdict(route, INLINE_BASE64_BYTES + ENVELOPE_BYTES)).toBeNull();
    expect(verdict(route, INLINE_BASE64_BYTES + ENVELOPE_BYTES + 1)?.status).toBe(413);
    expect(verdict(route, 65 * MIB)?.status).toBe(413);
    const counted = requestBodyVerdict(new URL(`${BASE_URL}${route}`), new Headers(JSON_TYPE));
    expect(counted).toMatchObject({ countUpTo: INLINE_BASE64_BYTES + ENVELOPE_BYTES, status: 413 });
  });

  it('takes the JSON of /api/tools/jobs, which names stored files and carries none, at the small limit', () => {
    expect(verdict('/api/tools/jobs', MIB)).toBeNull();
    expect(verdict('/api/tools/jobs', MIB + 1)?.status).toBe(413);
    expect(requestBodyVerdict(new URL(`${BASE_URL}/api/tools/jobs`), new Headers(JSON_TYPE))).toMatchObject({ countUpTo: MIB, status: 413 });
  });

  it.each([
    ['/api/queue/jobs', queueJobsRoute, `{"filename":"a.csv","targetFormat":"json","options":{"rows":${MANY_OBJECTS}}}`],
    ['/api/v1/jobs', v1JobsRoute, `{"filename":"a.csv","targetFormat":"json","options":{"rows":${MANY_OBJECTS}}}`],
    ['/api/tools/jobs', toolJobsRoute, `{"tool":"merge","files":${MANY_OBJECTS}}`],
  ] as const)('refuses a body of %s with more than 65,536 objects and arrays as 413, before it is parsed', async (route, handler, body) => {
    const res = await handler(post(route, body));
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 413, instance: route });
  });

  it('still reads a body of thirty thousand objects', async () => {
    const options = `{"rows":[${'{},'.repeat(30_000)}{}]}`;
    const res = await queueJobsRoute(post('/api/queue/jobs', `{"filename":"a.csv","targetFormat":"json","options":${options}}`));
    expect(res.status).not.toBe(413);
  });
});
