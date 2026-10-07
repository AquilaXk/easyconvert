import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';

/**
 * The daily-quota headers of a rejected /api/v1/convert request are a courtesy. When the quota
 * service cannot answer, the request must still get the rejection the guard decided on (here the
 * per-key burst 429 with its Retry-After), not an unhandled error that Next.js turns into a 500.
 */

const BASE_URL = 'http://localhost:3000';
const HTTP_TOO_MANY_REQUESTS = 429;
// Free-tier burst capacity (src/lib/api-keys/guard.ts API_KEY_BURST_LIMITS), decided in #242.
const FREE_BURST_CAPACITY = 20;
const BURST_RETRY_AFTER_SECONDS = '1';
// Fixed clock so the bucket does not refill while the test drains it.
const FIXED_NOW = new Date('2026-10-07T12:00:00.000Z');
const QUOTA_UNAVAILABLE = 'Distributed quota service is temporarily unavailable';

describe('POST /api/v1/convert rejection while the quota lookup fails', () => {
  let secretKey: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    const email = `quota_header_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@quota-header.test`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'Quota Header', tier: 'free' }));
    secretKey = (await redisKeyStore.generateApiKey(user.id, 'quota header key', { scopes: ['*'] })).secretKey;
    for (let i = 0; i < FREE_BURST_CAPACITY; i++) {
      const drained = await validateApiAccess(new NextRequest(`${BASE_URL}/api/v1/jobs`, { headers: { Authorization: `Bearer ${secretKey}` } }), 0);
      expect(drained.authorized).toBe(true);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function convertRequest(): NextRequest {
    const form = new FormData();
    form.append('file', new File(['a,b\n1,2\n'], 'a.csv', { type: 'text/csv' }));
    form.append('targetFormat', 'json');
    return new NextRequest(`${BASE_URL}/api/v1/convert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}` },
      body: form,
    });
  }

  it('keeps the burst 429 and its Retry-After when the quota lookup throws', async () => {
    const lookup = vi.spyOn(redisKeyStore, 'getQuotaUsage').mockRejectedValue(new Error(QUOTA_UNAVAILABLE));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await v1ConvertRoute(convertRequest());

    expect(lookup).toHaveBeenCalled();
    expect(res.status).toBe(HTTP_TOO_MANY_REQUESTS);
    expect(res.headers.get('retry-after')).toBe(BURST_RETRY_AFTER_SECONDS);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const problem = await res.json();
    expect(problem.status).toBe(HTTP_TOO_MANY_REQUESTS);
    expect(JSON.stringify(problem)).not.toContain(QUOTA_UNAVAILABLE);
  });

  it('still adds the daily-quota headers to the burst 429 when the lookup works', async () => {
    const res = await v1ConvertRoute(convertRequest());
    expect(res.status).toBe(HTTP_TOO_MANY_REQUESTS);
    expect(res.headers.get('retry-after')).toBe(BURST_RETRY_AFTER_SECONDS);
    expect(res.headers.get('ratelimit-limit')).not.toBeNull();
  });
});
