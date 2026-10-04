import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type Redis from 'ioredis';
import {
  RedisKeyStore,
  redisKeyStore,
  DEFAULT_RESERVATION_TTL_SECONDS,
  TOKEN_BUCKET_RATE_LIMIT_LUA_SCRIPT,
  RENEW_RESERVATION_LUA_SCRIPT,
} from '../src/lib/api-keys/redis-key-store';
import { validateApiAccess, ANONYMOUS_BURST_LIMIT } from '../src/lib/api-keys/guard';
import { ANONYMOUS_DAILY_LIMIT, getAnonymousDailyLimit } from '../src/lib/api-keys/key-store';
import { createSessionToken } from '../src/lib/auth/session';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import type { User } from '../src/lib/auth/types';
import { middleware } from '../src/middleware';
import { POST as convertHandler } from '../src/app/api/convert/route';
import { POST as multipartHandler } from '../src/app/api/storage/multipart/route';
import { POST as queueJobsHandler } from '../src/app/api/queue/jobs/route';

describe('Phase 1-C: Quota Fail-Closed, Anonymous Protection & CSRF Middleware', () => {
  beforeEach(() => {
    redisKeyStore.resetStore();
    redisUserStore.resetStore();
  });

  describe('Redis Outage Fail-Closed Integrity', () => {
    const brokenRedisClient = {
      eval: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:6379 (Connection refused to Redis cluster)');
      },
      get: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:6379');
      },
      set: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:6379');
      },
      quit: async () => {},
      disconnect: () => {},
    } as unknown as Redis;

    it('fails closed and returns serviceUnavailable on Redis eval failure during reserveQuota', async () => {
      const store = new RedisKeyStore({ redisClient: brokenRedisClient, isolated: true });
      const result = await store.reserveQuota('tenant-enterprise-user', 1);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.serviceUnavailable).toBe(true);
      expect(result.error).toMatch(/temporarily unavailable/i);
    });

    it('fails closed and returns serviceUnavailable on Redis eval failure during deductQuota', async () => {
      const store = new RedisKeyStore({ redisClient: brokenRedisClient, isolated: true });
      const result = await store.deductQuota('tenant-enterprise-user', 1);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.serviceUnavailable).toBe(true);
      expect(result.error).toMatch(/temporarily unavailable/i);
    });

    it('fails closed and throws error on Redis get failure during getQuotaUsage', async () => {
      const store = new RedisKeyStore({ redisClient: brokenRedisClient, isolated: true });
      await expect(store.getQuotaUsage('tenant-enterprise-user')).rejects.toThrow(
        /Distributed quota service is temporarily unavailable/i
      );
    });

    it('fails closed and returns serviceUnavailable on Redis eval failure during checkTokenBucketRateLimit', async () => {
      const store = new RedisKeyStore({ redisClient: brokenRedisClient, isolated: true });
      const result = await store.checkTokenBucketRateLimit('rate:apikey:key-123', {
        capacity: 100,
        refillRate: 10,
      });

      expect(result.allowed).toBe(false);
      expect(result.remainingTokens).toBe(0);
      expect(result.retryAfterMs).toBe(5000);
      expect(result.serviceUnavailable).toBe(true);
    });

    it('enforces boundary conditions and deducts quota correctly in local in-memory fallback', async () => {
      const store = new RedisKeyStore({ isolated: true });
      // Free tier default limit is 25
      const withinLimit = await store.deductQuota('local-user-1', 5);
      expect(withinLimit.allowed).toBe(true);
      expect(withinLimit.remaining).toBe(20);

      const exactBoundary = await store.deductQuota('local-user-1', 20);
      expect(exactBoundary.allowed).toBe(true);
      expect(exactBoundary.remaining).toBe(0);

      const exceeded = await store.deductQuota('local-user-1', 1);
      expect(exceeded.allowed).toBe(false);
      expect(exceeded.remaining).toBe(0);
    });
  });

  describe('Lua Scripts Architecture & Monotonic Time Verification', () => {
    it('executes TOKEN_BUCKET_RATE_LIMIT_LUA_SCRIPT using redis.call("TIME") and calculates accurate tokens and delay', async () => {
      let executedScript = '';
      const redisMock = {
        eval: async (script: string, numKeys: number, key: string, ...args: string[]) => {
          executedScript = script;
          return [1, 9, 0];
        },
      } as unknown as Redis;

      const store = new RedisKeyStore({ redisClient: redisMock, isolated: true });
      const result = await store.checkTokenBucketRateLimit('rate:test-id', {
        capacity: 10,
        refillRate: 2,
        cost: 1,
      });

      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(9);
      expect(result.retryAfterMs).toBe(0);
      expect(executedScript).toContain("redis.call, 'TIME'");
    });

    it('executes RENEW_RESERVATION_LUA_SCRIPT and updates reservation TTL atomically', async () => {
      let evalKey = '';
      let evalTtl = 0;
      const redisMock = {
        eval: async (script: string, numKeys: number, key: string, ttl: number) => {
          evalKey = key;
          evalTtl = ttl;
          return 1;
        },
      } as unknown as Redis;

      const store = new RedisKeyStore({ redisClient: redisMock, isolated: true });
      const success = await store.renewReservation('res_user1_20261004_12345_abcdef', 1200);

      expect(success).toBe(true);
      expect(evalKey).toBe('easyconvert:res:{user1}:res_user1_20261004_12345_abcdef');
      expect(evalTtl).toBe(1200);
    });
  });

  describe('Reservation TTL & Heartbeat Renewal', () => {
    it('configures default reservation TTL to 900 seconds (15 minutes) for long conversions', async () => {
      expect(DEFAULT_RESERVATION_TTL_SECONDS).toBe(900);

      const store = new RedisKeyStore('test-ttl:', true);
      const res = await store.reserveQuota('user-async-worker', 1);

      expect(res.allowed).toBe(true);
      expect(res.reservationId).toBeDefined();

      // Verify renewal
      const renewed = await store.renewReservation(res.reservationId!, 1200);
      expect(renewed).toBe(true);
    });

    it('rejects renewal on unknown or non-existent reservationId', async () => {
      const store = new RedisKeyStore('test-ttl:', true);
      const renewed = await store.renewReservation('res_non_existent_id', 900);
      expect(renewed).toBe(false);
    });
  });

  describe('Anonymous Client Daily Quota & IP Rate Limiting', () => {
    it('verifies anonymous daily limit defaults to 10 conversions per day when unconfigured', () => {
      const original = process.env.ANONYMOUS_DAILY_LIMIT;
      try {
        delete process.env.ANONYMOUS_DAILY_LIMIT;
        expect(getAnonymousDailyLimit()).toBe(10);
      } finally {
        if (original) process.env.ANONYMOUS_DAILY_LIMIT = original;
      }
    });

    it('enforces anonymous daily quota cap per client IP', async () => {
      const original = process.env.ANONYMOUS_DAILY_LIMIT;
      process.env.ANONYMOUS_DAILY_LIMIT = '5';
      try {
        const store = new RedisKeyStore('test-anon:', true);
        store.resetStore();
        const anonUserId = 'anon:198.51.100.99';

        // Reserve up to daily limit (5 units)
        for (let i = 0; i < 5; i++) {
          const res = await store.reserveQuota(anonUserId, 1);
          expect(res.allowed).toBe(true);
          expect(res.remaining).toBe(5 - (i + 1));
        }

        // 6th request must be rejected fail-closed
        const overLimit = await store.reserveQuota(anonUserId, 1);
        expect(overLimit.allowed).toBe(false);
        expect(overLimit.remaining).toBe(0);
      } finally {
        if (original) {
          process.env.ANONYMOUS_DAILY_LIMIT = original;
        } else {
          delete process.env.ANONYMOUS_DAILY_LIMIT;
        }
      }
    });

    it('allows anonymous API access within quota when allowAnonymous is true', async () => {
      const req = new NextRequest('http://localhost:3000/api/convert', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': '203.0.113.88',
        },
      });

      const auth = await validateApiAccess(req, {
        requiredUnits: 1,
        requiredScope: 'convert:write',
        allowAnonymous: true,
      });

      expect(auth.authorized).toBe(true);
      expect(auth.user?.id).toBe('anon:203.0.113.88');
      expect(auth.user?.name).toBe('Anonymous Client');
      expect(auth.reservationId).toBeDefined();
    });

    it('rejects unauthenticated request when allowAnonymous is false', async () => {
      const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': '203.0.113.89',
        },
      });

      const auth = await validateApiAccess(req, {
        requiredUnits: 1,
        requiredScope: 'convert:write',
        allowAnonymous: false,
      });

      expect(auth.authorized).toBe(false);
      expect(auth.status).toBe(401);
      expect(auth.error).toMatch(/Authentication required/i);
    });
  });

  describe('CSRF Protection Middleware (src/middleware.ts)', () => {
    it('blocks cookie-authenticated mutation when Origin and Referer are missing', () => {
      const req = new NextRequest('http://localhost:3000/api/keys', {
        method: 'POST',
        headers: {
          cookie: 'easyconvert_session=valid.session.token',
        },
      });

      const res = middleware(req);
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
    });

    it('blocks cookie-authenticated mutation with cross-origin attacker Origin', async () => {
      const req = new NextRequest('http://localhost:3000/api/keys', {
        method: 'POST',
        headers: {
          cookie: 'easyconvert_session=valid.session.token',
          origin: 'https://evil-attacker.example.com',
        },
      });

      const res = middleware(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.status).toBe(403);
      expect(json.detail).toMatch(/Cross-site request forgery detected: untrusted origin/i);
    });

    it('allows cookie-authenticated mutation when Origin matches Host/NextUrl origin', () => {
      const req = new NextRequest('http://localhost:3000/api/keys', {
        method: 'POST',
        headers: {
          cookie: 'easyconvert_session=valid.session.token',
          origin: 'http://localhost:3000',
          host: 'localhost:3000',
        },
      });

      const res = middleware(req);
      // Middleware returns 200 via NextResponse.next()
      expect(res.status).toBe(200);
    });

    it('allows programmatic API key mutations without Origin header', () => {
      const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: {
          'x-api-key': 'ec_live_abcdef123456',
        },
      });

      const res = middleware(req);
      expect(res.status).toBe(200);
    });

    it('allows safe HTTP GET requests without Origin check', () => {
      const req = new NextRequest('http://localhost:3000/api/queue/jobs', {
        method: 'GET',
        headers: {
          cookie: 'easyconvert_session=valid.session.token',
        },
      });

      const res = middleware(req);
      expect(res.status).toBe(200);
    });
  });

  describe('Multipart Authentication & Tier Limits', () => {
    let testUser: User;

    beforeEach(async () => {
      redisUserStore.resetStore();
      testUser = await redisUserStore.createUser({
        email: 'tier@test.com',
        name: 'Tier Test User',
        password: 'Password123!',
        tier: 'free',
      });
    });

    it('rejects unauthenticated multipart upload initiation with 401', async () => {
      const req = new NextRequest('http://localhost:3000/api/storage/multipart?action=initiate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '198.51.100.99',
        },
        body: JSON.stringify({
          filename: 'document.pdf',
          mimeType: 'application/pdf',
          totalSize: 45 * 1024 * 1024,
        }),
      });

      const res = await multipartHandler(req);
      expect(res.status).toBe(401);
    });

    it('permits authenticated multipart upload initiation within tier limit', async () => {
      const token = createSessionToken(testUser);
      const req = new NextRequest('http://localhost:3000/api/storage/multipart?action=initiate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `easyconvert_session=${token}`,
        },
        body: JSON.stringify({
          filename: 'document.pdf',
          mimeType: 'application/pdf',
          totalSize: 45 * 1024 * 1024, // 45 MiB (< 100 MiB free cap)
        }),
      });

      const res = await multipartHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.uploadId).toBeDefined();
    });

    it('rejects multipart upload exceeding free tier 100MB cap with 413 Payload Too Large', async () => {
      const token = createSessionToken(testUser);
      const req = new NextRequest('http://localhost:3000/api/storage/multipart?action=initiate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `easyconvert_session=${token}`,
        },
        body: JSON.stringify({
          filename: 'giant-video.mp4',
          mimeType: 'video/mp4',
          totalSize: 120 * 1024 * 1024, // 120 MiB (> 100 MiB free cap)
        }),
      });

      const res = await multipartHandler(req);
      expect(res.status).toBe(413);
      const json = await res.json();
      expect(json.status).toBe(413);
      expect(json.detail).toMatch(/exceeds maximum allowed upload size of 104857600 bytes for tier 'free'/i);
    });
  });

  describe('Queue Jobs Anonymous Protection', () => {
    it('accepts anonymous job submission and associates anonymous user id and reservationId', async () => {
      const req = new NextRequest('http://localhost:3000/api/queue/jobs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.150',
        },
        body: JSON.stringify({
          filename: 'test.txt',
          targetFormat: 'pdf',
          inputBufferBase64: Buffer.from('Hello world').toString('base64'),
        }),
      });

      const res = await queueJobsHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.jobId).toBeDefined();
      expect(json.queue).toBeDefined();
    });
  });
});
