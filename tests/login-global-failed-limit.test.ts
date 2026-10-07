import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import {
  LOGIN_GLOBAL_MAX_FAILED_ATTEMPTS,
  LOGIN_GLOBAL_WINDOW_SECONDS,
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginAttempts,
  resetLoginRateLimiterStore,
} from '../src/lib/auth/login-rate-limiter';
import { POST as loginHandler } from '../src/app/api/auth/login/route';

// Hand-written expectations from the brief: 300 failures per 5 minutes across all accounts.
const EXPECTED_GLOBAL_THRESHOLD = 300;
const EXPECTED_GLOBAL_WINDOW_SECONDS = 300;
const EMAIL_LOCKOUT_ATTEMPTS = 5;
const ATTRIBUTED_IP = '198.51.100.7';
const FAKE_REDIS_TTL_SECONDS = 42;

async function failAcrossAccounts(ip: string | null, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await recordFailedLogin(ip, `victim${i}@example.com`);
  }
}

function login(email: string, headers: Record<string, string> = {}): Promise<Response> {
  return loginHandler(
    new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email, password: 'WrongPassword!' }),
    })
  );
}

/** Minimal Redis double covering the commands the limiter uses (get, ttl, pipeline incr/expire/exec, del). */
function createFakeRedis() {
  const values = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    values,
    ttls,
    get: async (key: string) => (values.has(key) ? String(values.get(key)) : null),
    ttl: async (key: string) => ttls.get(key) ?? -1,
    del: async (...keys: string[]) => {
      for (const key of keys) values.delete(key);
      return keys.length;
    },
    pipeline() {
      const ops: Array<() => void> = [];
      const pipe = {
        incr(key: string) {
          ops.push(() => values.set(key, (values.get(key) ?? 0) + 1));
          return pipe;
        },
        expire(key: string, seconds: number) {
          ops.push(() => ttls.set(key, seconds));
          return pipe;
        },
        exec: async () => {
          for (const op of ops) op();
          return [];
        },
      };
      return pipe;
    },
  };
}

describe('global failed-login counter for unattributed clients', () => {
  beforeEach(() => {
    resetLoginRateLimiterStore();
    vi.stubEnv('TRUSTED_PROXIES', '');
    vi.stubEnv('TRUSTED_CDN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('uses the documented threshold and window', () => {
    expect(LOGIN_GLOBAL_MAX_FAILED_ATTEMPTS).toBe(EXPECTED_GLOBAL_THRESHOLD);
    expect(LOGIN_GLOBAL_WINDOW_SECONDS).toBe(EXPECTED_GLOBAL_WINDOW_SECONDS);
  });

  it('blocks every unattributed login once the global failure threshold is reached', async () => {
    await failAcrossAccounts(null, EXPECTED_GLOBAL_THRESHOLD - 1);
    expect(await checkLoginRateLimit(null, 'fresh@example.com')).toEqual({ allowed: true, retryAfterSeconds: 0 });

    await recordFailedLogin(null, 'last@example.com');
    const blocked = await checkLoginRateLimit(null, 'fresh@example.com');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('global');
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(EXPECTED_GLOBAL_WINDOW_SECONDS);
  });

  it('answers the login route with 429 and Retry-After when the global counter is tripped', async () => {
    await failAcrossAccounts(null, EXPECTED_GLOBAL_THRESHOLD);
    const response = await login('fresh@example.com');
    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(EXPECTED_GLOBAL_WINDOW_SECONDS);
    expect((await response.json()).retryAfterSeconds).toBe(retryAfter);
  });

  it('does not apply the global counter to attributed clients', async () => {
    await failAcrossAccounts(null, EXPECTED_GLOBAL_THRESHOLD);
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const response = await login('fresh@example.com', { 'x-forwarded-for': ATTRIBUTED_IP });
    expect(response.status).toBe(401);
  });

  it('does not count attributed failures toward the global counter', async () => {
    await failAcrossAccounts(ATTRIBUTED_IP, EXPECTED_GLOBAL_THRESHOLD);
    expect((await checkLoginRateLimit(null, 'fresh@example.com')).allowed).toBe(true);
  });

  it('keeps the per-email lockout reason ahead of the global counter', async () => {
    for (let i = 0; i < EMAIL_LOCKOUT_ATTEMPTS; i++) await recordFailedLogin(null, 'target@example.com');
    const result = await checkLoginRateLimit(null, 'target@example.com');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('email');
  });

  it('is not cleared by a successful login of one account', async () => {
    await failAcrossAccounts(null, EXPECTED_GLOBAL_THRESHOLD);
    await resetLoginAttempts(null, 'victim0@example.com');
    expect((await checkLoginRateLimit(null, 'fresh@example.com')).reason).toBe('global');
  });

  describe('with the Redis adapter', () => {
    it('stores one windowed global counter and blocks at the threshold', async () => {
      const redis = createFakeRedis();
      vi.spyOn(redisUserStore, 'getRedisClient').mockReturnValue(redis as never);
      const globalKey = `${redisUserStore.getKeyPrefix()}login_attempts:global`;

      await failAcrossAccounts(null, EXPECTED_GLOBAL_THRESHOLD);

      expect(redis.values.get(globalKey)).toBe(EXPECTED_GLOBAL_THRESHOLD);
      expect(redis.ttls.get(globalKey)).toBe(EXPECTED_GLOBAL_WINDOW_SECONDS);
      expect([...redis.values.keys()].some((key) => key.includes('login_attempts:ip:'))).toBe(false);

      redis.ttls.set(globalKey, FAKE_REDIS_TTL_SECONDS);
      expect(await checkLoginRateLimit(null, 'fresh@example.com')).toEqual({
        allowed: false,
        retryAfterSeconds: FAKE_REDIS_TTL_SECONDS,
        reason: 'global',
      });
    });

    it('does not touch the global counter for attributed clients', async () => {
      const redis = createFakeRedis();
      vi.spyOn(redisUserStore, 'getRedisClient').mockReturnValue(redis as never);
      await recordFailedLogin(ATTRIBUTED_IP, 'victim@example.com');
      const globalKey = `${redisUserStore.getKeyPrefix()}login_attempts:global`;
      expect(redis.values.has(globalKey)).toBe(false);
    });
  });
});
