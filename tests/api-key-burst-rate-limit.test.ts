import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { buildRateLimitHeaders } from '../src/lib/api/rate-limit';
import { GET as listJobsRoute, POST as createJobRoute } from '../src/app/api/v1/jobs/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { GET as keyUsageRoute } from '../src/app/api/keys/usage/route';
import type { ApiKeyScope } from '../src/lib/api-keys/types';
import type { UserTier } from '../src/lib/auth/types';

// Decided per-tier burst design for #242 (authored independently of the guard constants).
const FREE_BURST_CAPACITY = 20;
const PRO_BURST_CAPACITY = 100;
const FREE_DAILY_LIMIT = 25;
// One missing token at 2 tokens/s (free) or 20 tokens/s (pro) is < 1 s, so Retry-After rounds up to 1 s.
const EXPECTED_BURST_RETRY_AFTER_SECONDS = 1;
// Fixed clock: 12:00:00 UTC is exactly 12 h (43,200 s) before the next UTC-midnight quota reset.
const FIXED_NOW = new Date('2026-09-29T12:00:00.000Z');
const SECONDS_UNTIL_UTC_MIDNIGHT = 43_200;
const BASE_URL = 'http://localhost:3000';

async function createUser(tier: UserTier) {
  const email = `burst_${tier}_${Date.now()}_${Math.random().toString(36).slice(2)}@burst.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: `Burst ${tier}`, tier }));
}

async function createKey(userId: string, scopes: ApiKeyScope[] = ['*']) {
  return redisKeyStore.generateApiKey(userId, 'burst key', { scopes });
}

function keyRequest(path: string, secretKey: string, init: { method?: string; body?: BodyInit } = {}): NextRequest {
  return new NextRequest(`${BASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${secretKey}` },
    body: init.body,
  });
}

async function drainBucket(secretKey: string, capacity: number): Promise<number> {
  let authorizedCount = 0;
  for (let i = 0; i < capacity; i++) {
    const auth = await validateApiAccess(keyRequest('/api/v1/jobs', secretKey), 0);
    if (auth.authorized) authorizedCount++;
  }
  return authorizedCount;
}

describe('Per-key burst rate limit and Retry-After (#242)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('guard token bucket', () => {
    it('allows exactly the free-tier burst capacity, then returns 429 with retryAfterSeconds', async () => {
      const user = await createUser('free');
      const { secretKey } = await createKey(user.id);

      expect(await drainBucket(secretKey, FREE_BURST_CAPACITY)).toBe(FREE_BURST_CAPACITY);

      const limited = await validateApiAccess(keyRequest('/api/v1/jobs', secretKey), 0);
      expect(limited.authorized).toBe(false);
      expect(limited.status).toBe(429);
      expect(limited.error).toContain('Rate limit exceeded');
      expect(limited.retryAfterSeconds).toBe(EXPECTED_BURST_RETRY_AFTER_SECONDS);
      expect(authErrorHeaders(limited)).toEqual({ 'Retry-After': String(EXPECTED_BURST_RETRY_AFTER_SECONDS) });

      vi.setSystemTime(FIXED_NOW.getTime() + 1_000);
      const refilled = await validateApiAccess(keyRequest('/api/v1/jobs', secretKey), 0);
      expect(refilled.authorized).toBe(true);
      expect(refilled.apiKey?.userId).toBe(user.id);
    });

    it('sizes the bucket by tier (pro allows 100 before limiting)', async () => {
      const user = await createUser('pro');
      const { secretKey } = await createKey(user.id);

      expect(await drainBucket(secretKey, PRO_BURST_CAPACITY)).toBe(PRO_BURST_CAPACITY);

      const limited = await validateApiAccess(keyRequest('/api/v1/jobs', secretKey), 0);
      expect(limited.status).toBe(429);
      expect(limited.retryAfterSeconds).toBe(EXPECTED_BURST_RETRY_AFTER_SECONDS);
    });

    it('keeps buckets per key, and does not burst-limit session callers', async () => {
      const user = await createUser('free');
      const first = await createKey(user.id);
      const second = await createKey(user.id);

      await drainBucket(first.secretKey, FREE_BURST_CAPACITY);
      expect((await validateApiAccess(keyRequest('/api/v1/jobs', first.secretKey), 0)).status).toBe(429);

      const other = await validateApiAccess(keyRequest('/api/v1/jobs', second.secretKey), 0);
      expect(other.authorized).toBe(true);
      expect(other.apiKey?.id).toBe(second.key.id);

      const cookie = `easyconvert_session=${createSessionToken(user)}`;
      const sessionResults: Array<number | undefined> = [];
      for (let i = 0; i < FREE_BURST_CAPACITY + 5; i++) {
        const auth = await validateApiAccess(
          new NextRequest(`${BASE_URL}/api/v1/jobs`, { headers: { Cookie: cookie } }),
          0
        );
        sessionResults.push(auth.authorized ? 200 : auth.status);
      }
      expect(sessionResults.filter((s) => s !== 200)).toEqual([]);
    });

    it('authErrorHeaders emits Retry-After only when a retry delay is known', () => {
      expect(authErrorHeaders({ retryAfterSeconds: 7 })).toEqual({ 'Retry-After': '7' });
      expect(authErrorHeaders({})).toEqual({});
    });
  });

  describe('route responses carry Retry-After on burst 429', () => {
    it('GET /api/v1/jobs returns problem+json 429 with Retry-After', async () => {
      const user = await createUser('free');
      const { secretKey } = await createKey(user.id, ['convert:read']);
      await drainBucket(secretKey, FREE_BURST_CAPACITY);

      const res = await listJobsRoute(keyRequest('/api/v1/jobs', secretKey));
      expect(res.status).toBe(429);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expect(res.headers.get('retry-after')).toBe(String(EXPECTED_BURST_RETRY_AFTER_SECONDS));
    });

    it('GET /api/keys/usage returns 429 with Retry-After', async () => {
      const user = await createUser('free');
      const { secretKey } = await createKey(user.id, ['convert:read']);
      await drainBucket(secretKey, FREE_BURST_CAPACITY);

      const res = await keyUsageRoute(keyRequest('/api/keys/usage', secretKey));
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe(String(EXPECTED_BURST_RETRY_AFTER_SECONDS));
      const body = await res.json();
      expect(body.error).toContain('Rate limit exceeded');
    });

    it('POST /api/v1/convert uses the burst delay, not the daily reset, and reports the real daily remaining', async () => {
      const user = await createUser('free');
      const { secretKey } = await createKey(user.id, ['convert:write']);
      await drainBucket(secretKey, FREE_BURST_CAPACITY);

      const res = await v1ConvertRoute(keyRequest('/api/v1/convert', secretKey, { method: 'POST' }));
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe(String(EXPECTED_BURST_RETRY_AFTER_SECONDS));
      expect(res.headers.get('ratelimit-remaining')).toBe(String(FREE_DAILY_LIMIT));
    });
  });

  describe('daily quota 429 carries Retry-After until the UTC-midnight reset', () => {
    it('buildRateLimitHeaders adds Retry-After only when the quota is exhausted', () => {
      const now = FIXED_NOW.getTime();
      const base = { tier: 'free' as const, dailyLimit: FREE_DAILY_LIMIT };

      const exhausted = buildRateLimitHeaders({ ...base, usedToday: 25, remaining: 0, resetAt: now + 90_500 });
      expect(exhausted['Retry-After']).toBe('91');
      expect(exhausted['RateLimit-Reset']).toBe('91');

      const resetInPast = buildRateLimitHeaders({ ...base, usedToday: 25, remaining: 0, resetAt: now - 5_000 });
      expect(resetInPast['Retry-After']).toBe('1');

      const available = buildRateLimitHeaders({ ...base, usedToday: 22, remaining: 3, resetAt: now + 90_500 });
      expect(Object.keys(available)).not.toContain('Retry-After');
      expect(available['RateLimit-Remaining']).toBe('3');
    });

    it('POST /api/v1/jobs and POST /api/v1/convert send Retry-After on daily quota exhaustion', async () => {
      const user = await createUser('free');
      const { secretKey } = await createKey(user.id, ['convert:write']);
      await redisKeyStore.recordUsage(user.id, FREE_DAILY_LIMIT);

      const jobsRes = await createJobRoute(keyRequest('/api/v1/jobs', secretKey, { method: 'POST' }));
      expect(jobsRes.status).toBe(429);
      const jobsBody = await jobsRes.json();
      expect(jobsBody.detail).toContain('Daily conversion quota exceeded');
      expect(jobsRes.headers.get('retry-after')).toBe(String(SECONDS_UNTIL_UTC_MIDNIGHT));

      const convertRes = await v1ConvertRoute(keyRequest('/api/v1/convert', secretKey, { method: 'POST' }));
      expect(convertRes.status).toBe(429);
      expect(convertRes.headers.get('retry-after')).toBe(String(SECONDS_UNTIL_UTC_MIDNIGHT));
      expect(convertRes.headers.get('ratelimit-remaining')).toBe('0');
    });
  });
});
