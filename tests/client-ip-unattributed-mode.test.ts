import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { getUnattributedBurstLimit, validateApiAccess } from '../src/lib/api-keys/guard';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import {
  LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL,
  resetLoginRateLimiterStore,
} from '../src/lib/auth/login-rate-limiter';
import { POST as loginHandler } from '../src/app/api/auth/login/route';

// Hand-written scenario sizes: more attempts than the per-IP login limit (10) and the anonymous daily limit (2).
const FAILED_LOGINS_ACROSS_USERS = 12;
const PER_IP_LOGIN_LIMIT = 10;
const ANON_DAILY_LIMIT = 2;
const ANON_REQUESTS = 6;
const PER_CLIENT_HAMMER_REQUESTS = 25;

function login(email: string, headers: Record<string, string> = {}): Promise<Response> {
  return loginHandler(
    new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email, password: 'WrongPassword!' }),
    })
  );
}

function anonymousRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/convert', { method: 'POST', headers });
}

describe('unattributed mode must not let one client degrade everyone else', () => {
  beforeEach(() => {
    redisKeyStore.resetStore();
    redisUserStore.resetStore();
    resetLoginRateLimiterStore();
    vi.stubEnv('TRUSTED_PROXIES', '');
    vi.stubEnv('TRUSTED_CDN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('login throttling', () => {
    it('failed logins for different emails never trip a shared per-IP counter', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < FAILED_LOGINS_ACROSS_USERS; i++) {
        statuses.push((await login(`victim${i}@example.com`)).status);
      }
      expect(statuses).toEqual(new Array(FAILED_LOGINS_ACROSS_USERS).fill(401));
      // A different user is still not locked out.
      expect((await login('bystander@example.com')).status).toBe(401);
    });

    it('keeps the per-email counter and lockout in unattributed mode', async () => {
      for (let i = 0; i < LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL; i++) {
        expect((await login('target@example.com')).status).toBe(401);
      }
      const locked = await login('target@example.com');
      expect(locked.status).toBe(429);
      expect((await locked.json()).detail).toContain('Too many failed login attempts');
      expect((await login('someone-else@example.com')).status).toBe(401);
    });

    it('still applies the per-IP counter when the client is attributed', async () => {
      vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
      const headers = { 'x-forwarded-for': '198.51.100.7' };
      const statuses: number[] = [];
      for (let i = 0; i < FAILED_LOGINS_ACROSS_USERS; i++) {
        statuses.push((await login(`victim${i}@example.com`, headers)).status);
      }
      expect(statuses.slice(0, PER_IP_LOGIN_LIMIT)).toEqual(new Array(PER_IP_LOGIN_LIMIT).fill(401));
      expect(statuses.slice(PER_IP_LOGIN_LIMIT)).toEqual([429, 429]);
    });
  });

  describe('anonymous access', () => {
    it('answers 503 with Retry-After when an unattributed burst setting is malformed', async () => {
      vi.stubEnv('ANONYMOUS_UNATTRIBUTED_BURST_CAPACITY', 'abc');
      const auth = await validateApiAccess(anonymousRequest(), { requiredUnits: 1, allowAnonymous: true });
      expect(auth.authorized).toBe(false);
      expect(auth.status).toBe(503);
      expect(auth.retryAfterSeconds).toBeGreaterThan(0);
      expect(auth.error).not.toContain('abc');
    });

    it('does not share a daily quota across all unattributed clients', async () => {
      vi.stubEnv('ANONYMOUS_DAILY_LIMIT', String(ANON_DAILY_LIMIT));
      for (let i = 0; i < ANON_REQUESTS; i++) {
        const auth = await validateApiAccess(anonymousRequest({ 'x-forwarded-for': `203.0.113.${i + 1}` }), {
          requiredUnits: 1,
          allowAnonymous: true,
        });
        expect(auth.authorized).toBe(true);
        expect(auth.user?.id).toBe('anon:unattributed');
        expect(auth.reservationId).toBeUndefined();
      }
    });

    it('sizes the shared unattributed bucket for site-wide traffic, not for one client', async () => {
      // Per-client sizing: 3 burst, 1/s. One client sending well past it must not exhaust the shared identity.
      vi.stubEnv('ANONYMOUS_BURST_CAPACITY', '3');
      vi.stubEnv('ANONYMOUS_BURST_REFILL_RATE', '1');
      const hammer: Array<number | undefined> = [];
      for (let i = 0; i < PER_CLIENT_HAMMER_REQUESTS; i++) {
        const auth = await validateApiAccess(anonymousRequest({ 'x-forwarded-for': '203.0.113.9' }), {
          requiredUnits: 1,
          allowAnonymous: true,
        });
        hammer.push(auth.authorized ? 200 : auth.status);
      }
      expect(hammer).toEqual(new Array(PER_CLIENT_HAMMER_REQUESTS).fill(200));
      // A different unattributed caller, still below the shared limit, is not throttled.
      const bystander = await validateApiAccess(anonymousRequest({ 'x-forwarded-for': '203.0.113.10' }), {
        requiredUnits: 1,
        allowAnonymous: true,
      });
      expect(bystander.authorized).toBe(true);
      expect(bystander.user?.id).toBe('anon:unattributed');
    });

    it('defaults the shared unattributed limits to the edge shared bucket (600 burst, 100/s)', () => {
      expect(getUnattributedBurstLimit()).toEqual({ capacity: 600, refillRate: 100 });
    });

    it('still trips the burst limiter when a flood exceeds the shared unattributed limit', async () => {
      vi.stubEnv('ANONYMOUS_UNATTRIBUTED_BURST_CAPACITY', '3');
      vi.stubEnv('ANONYMOUS_UNATTRIBUTED_BURST_REFILL_RATE', '1');
      const results: Array<number | undefined> = [];
      for (let i = 0; i < 5; i++) {
        const auth = await validateApiAccess(anonymousRequest(), { requiredUnits: 1, allowAnonymous: true });
        results.push(auth.authorized ? 200 : auth.status);
      }
      expect(results).toEqual([200, 200, 200, 429, 429]);
    });

    it('keeps per-client burst sizing for attributed clients', async () => {
      vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
      vi.stubEnv('ANONYMOUS_BURST_CAPACITY', '3');
      vi.stubEnv('ANONYMOUS_BURST_REFILL_RATE', '1');
      const results: Array<number | undefined> = [];
      for (let i = 0; i < 5; i++) {
        const auth = await validateApiAccess(anonymousRequest({ 'x-forwarded-for': '198.51.100.7' }), {
          requiredUnits: 1,
          allowAnonymous: true,
        });
        results.push(auth.authorized ? 200 : auth.status);
      }
      expect(results).toEqual([200, 200, 200, 429, 429]);
    });

    it('enforces the daily quota per attributed client', async () => {
      vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
      vi.stubEnv('ANONYMOUS_DAILY_LIMIT', String(ANON_DAILY_LIMIT));
      const statuses: Array<number | undefined> = [];
      for (let i = 0; i < ANON_DAILY_LIMIT + 1; i++) {
        const auth = await validateApiAccess(anonymousRequest({ 'x-forwarded-for': '198.51.100.7' }), {
          requiredUnits: 1,
          allowAnonymous: true,
        });
        statuses.push(auth.authorized ? 200 : auth.status);
      }
      expect(statuses).toEqual([200, 200, 429]);
      const other = await validateApiAccess(anonymousRequest({ 'x-forwarded-for': '198.51.100.8' }), {
        requiredUnits: 1,
        allowAnonymous: true,
      });
      expect(other.authorized).toBe(true);
    });
  });
});
