import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  extractClientIp,
  isIpInCidr,
  normalizeIp,
  isIpAllowed,
  getTrustedProxies,
  DEFAULT_TRUSTED_PROXIES,
} from '../src/lib/api-keys/ip-utils';
import {
  checkTokenBucketRateLimit,
  redisKeyStore,
} from '../src/lib/api-keys/redis-key-store';
import {
  WebhookDispatcher,
  verifySignatureWithDualSecrets,
  shouldDispatchEvent,
} from '../src/lib/api-keys/webhook-dispatcher';
import { GET as getOpenApiV1Handler } from '../src/app/api/v1/openapi.json/route';
import { GET as getOpenApiHandler } from '../src/app/api/openapi.json/route';

describe('Phase 3: Auth & Developer API Enterprise Hardening', () => {
  beforeEach(() => {
    redisKeyStore.resetStore();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('Trusted Proxy IP Spoofing Defense (Right-to-Left Traversal)', () => {
    it('contains standard RFC 1918 and loopback CIDRs in default trusted proxies', () => {
      expect(DEFAULT_TRUSTED_PROXIES).toContain('127.0.0.1/8');
      expect(DEFAULT_TRUSTED_PROXIES.length).toBeGreaterThan(0);
      expect(getTrustedProxies()).toEqual(expect.arrayContaining(['127.0.0.1/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']));
    });

    it('identifies valid CIDR ranges correctly', () => {
      expect(isIpInCidr('192.168.1.50', '192.168.0.0/16')).toBe(true);
      expect(isIpInCidr('10.200.1.1', '10.0.0.0/8')).toBe(true);
      expect(isIpInCidr('172.20.5.9', '172.16.0.0/12')).toBe(true);
      expect(isIpInCidr('203.0.113.195', '192.168.0.0/16')).toBe(false);
      expect(isIpInCidr('invalid-ip', '10.0.0.0/8')).toBe(false);
    });

    it('peels trusted reverse proxies right-to-left to prevent external spoofing', () => {
      // Attacker at 198.51.100.22 tries to spoof an internal/whitelisted IP 10.0.0.99
      // Header received: '10.0.0.99, 198.51.100.22, 172.16.0.1'
      // The rightmost IP 172.16.0.1 is a trusted proxy. Peeling it gives 198.51.100.22 (untrusted).
      const req = new NextRequest('https://easyconvert.app/api/v1/convert', {
        headers: {
          'x-forwarded-for': '10.0.0.99, 198.51.100.22, 172.16.0.1',
        },
      });

      const resolvedIp = extractClientIp(req, ['172.16.0.0/12', '127.0.0.1/32']);
      expect(resolvedIp).toBe('198.51.100.22');
    });

    it('falls back to leftmost IP if all upstream IPs are untrusted', () => {
      const req = new NextRequest('https://easyconvert.app/api/v1/convert', {
        headers: {
          'x-forwarded-for': '203.0.113.1, 198.51.100.5',
        },
      });

      // Neither 203.0.113.1 nor 198.51.100.5 is trusted. Right-to-left stops immediately at 198.51.100.5.
      const resolvedIp = extractClientIp(req, ['10.0.0.0/8', '127.0.0.1/32']);
      expect(resolvedIp).toBe('198.51.100.5');
    });

    it('honours cf-connecting-ip only for a verified CDN peer, and never reads x-real-ip', () => {
      // Without TRUSTED_CDN the header is attacker-controlled, so nothing can be attributed.
      const cfReq = new NextRequest('https://easyconvert.app/api/v1/convert', {
        headers: {
          'cf-connecting-ip': '203.0.113.42',
        },
      });
      expect(extractClientIp(cfReq, [], '203.0.113.7')).toBe('203.0.113.7');

      vi.stubEnv('TRUSTED_CDN', 'cloudflare');
      // 173.245.48.5 lies in the published Cloudflare range 173.245.48.0/20.
      expect(extractClientIp(cfReq, [], '173.245.48.5')).toBe('203.0.113.42');

      const directReq = new NextRequest('https://easyconvert.app/api/v1/convert', {
        headers: {
          'x-real-ip': '198.51.100.77',
        },
      });
      expect(extractClientIp(directReq, ['10.0.0.0/8'], '10.0.0.9')).toBe('10.0.0.9');
    });

    it('rejects spoofed CF-Connecting-IP and X-Real-IP when direct connecting peer is untrusted', () => {
      // Attacker connecting directly from untrusted public IP 203.0.113.99 trying to spoof internal IP
      const spoofedCf = new NextRequest('https://easyconvert.app/api/v1/convert', {
        headers: {
          'cf-connecting-ip': '10.0.0.1',
        },
      });
      // Pass direct peer IP 203.0.113.99
      const resolvedCf = extractClientIp(spoofedCf, ['127.0.0.1/32', '172.16.0.0/12'], '203.0.113.99');
      expect(resolvedCf).toBe('203.0.113.99');

      const spoofedReal = new NextRequest('https://easyconvert.app/api/v1/convert', {
        headers: {
          'x-real-ip': '192.168.1.50',
        },
      });
      const resolvedReal = extractClientIp(spoofedReal, ['127.0.0.1/32', '172.16.0.0/12'], '198.51.100.200');
      expect(resolvedReal).toBe('198.51.100.200');
    });

    it('ignores CF-Connecting-IP from a trusted private proxy (a proxy is not a verified CDN edge)', () => {
      // Direct peer is trusted reverse proxy (172.16.0.5); the header is client-writable behind it.
      const trustedCf = new NextRequest('https://easyconvert.app/api/v1/convert', {
        headers: {
          'cf-connecting-ip': '203.0.113.42',
          'x-forwarded-for': '198.51.100.9',
        },
      });
      const resolvedCf = extractClientIp(trustedCf, ['172.16.0.0/12'], '172.16.0.5');
      expect(resolvedCf).toBe('198.51.100.9');
    });

    it('normalizes hex-encoded IPv4-mapped IPv6 addresses to standard dotted-quad format', () => {
      expect(normalizeIp('::ffff:c0a8:0101')).toBe('192.168.1.1');
      expect(normalizeIp('::ffff:7f00:0001')).toBe('127.0.0.1');
      expect(normalizeIp('0:0:0:0:0:ffff:0a00:0001')).toBe('10.0.0.1');
      expect(isIpAllowed('::ffff:c0a8:0101', ['192.168.1.0/24'])).toBe(true);
      expect(isIpAllowed('::ffff:c0a8:0101', ['10.0.0.0/8'])).toBe(false);
    });
  });

  describe('Token Bucket Burst Rate Limiter', () => {
    it('allows bursts up to capacity and rejects when exhausted', async () => {
      const identifier = 'burst-user-alpha';
      const options = {
        capacity: 3,
        refillRate: 1, // 1 token per second
      };

      // 1st request -> Allowed (2 tokens left)
      const res1 = await checkTokenBucketRateLimit(identifier, options);
      expect(res1.allowed).toBe(true);
      expect(res1.tokensRemaining).toBe(2);

      // 2nd request -> Allowed (1 token left)
      const res2 = await checkTokenBucketRateLimit(identifier, options);
      expect(res2.allowed).toBe(true);
      expect(res2.tokensRemaining).toBe(1);

      // 3rd request -> Allowed (0 tokens left)
      const res3 = await checkTokenBucketRateLimit(identifier, options);
      expect(res3.allowed).toBe(true);
      expect(res3.tokensRemaining).toBe(0);

      // 4th request -> Rejected (Rate limit exceeded)
      const res4 = await checkTokenBucketRateLimit(identifier, options);
      expect(res4.allowed).toBe(false);
      expect(res4.tokensRemaining).toBe(0);
      expect(res4.resetMs).toBeGreaterThan(0);
    });

    it('refills tokens over time proportionally to refillRate', async () => {
      const identifier = 'burst-user-replenish';
      const options = {
        capacity: 2,
        refillRate: 10, // 10 tokens per second (1 token per 100ms)
      };

      // Consume both tokens
      await checkTokenBucketRateLimit(identifier, options);
      const consumed = await checkTokenBucketRateLimit(identifier, options);
      expect(consumed.tokensRemaining).toBe(0);

      // Rejection immediately
      const rejected = await checkTokenBucketRateLimit(identifier, options);
      expect(rejected.allowed).toBe(false);

      // Wait 150ms to allow replenishment of at least 1 token
      await new Promise((resolve) => setTimeout(resolve, 150));

      const afterWait = await checkTokenBucketRateLimit(identifier, options);
      expect(afterWait.allowed).toBe(true);
      expect(afterWait.tokensRemaining).toBeGreaterThanOrEqual(0);
    });

    it('handles refillRate: 0 gracefully without division by zero or NaN retryAfterMs', async () => {
      const identifier = 'zero-refill-user';
      const options = {
        capacity: 1,
        refillRate: 0,
        cost: 1,
      };

      const res1 = await checkTokenBucketRateLimit(identifier, options);
      expect(res1.allowed).toBe(true);
      expect(res1.tokensRemaining).toBe(0);

      const res2 = await checkTokenBucketRateLimit(identifier, options);
      expect(res2.allowed).toBe(false);
      expect(res2.tokensRemaining).toBe(0);
      expect(Number.isFinite(res2.resetMs)).toBe(true);
      expect(res2.resetMs).toBeGreaterThan(0);
    });
  });

  describe('Webhook Dual Secret Rotation & Event Filtering', () => {
    const payload = JSON.stringify({ event: 'job.completed', jobId: 'job-999', status: 'completed' });
    const primarySecret = 'whsec_primary_active_2026';
    const secondarySecret = 'whsec_secondary_expiring_2025';
    const invalidSecret = 'whsec_invalid_unrelated_key';

    it('accepts signatures generated with the active primary secret', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = WebhookDispatcher.signPayload(payload, primarySecret, timestamp);

      const isValid = verifySignatureWithDualSecrets(
        payload,
        signature,
        timestamp,
        primarySecret,
        secondarySecret
      );
      expect(isValid).toBe(true);
    });

    it('accepts signatures generated with the expiring secondary secret during key rotation', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = WebhookDispatcher.signPayload(payload, secondarySecret, timestamp);

      const isValid = verifySignatureWithDualSecrets(
        payload,
        signature,
        timestamp,
        primarySecret,
        secondarySecret
      );
      expect(isValid).toBe(true);
    });

    it('rejects signatures generated with an invalid secret', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = WebhookDispatcher.signPayload(payload, invalidSecret, timestamp);

      const isValid = verifySignatureWithDualSecrets(
        payload,
        signature,
        timestamp,
        primarySecret,
        secondarySecret
      );
      expect(isValid).toBe(false);
    });

    it('rejects replay attacks where timestamp exceeds tolerance window', () => {
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const signature = WebhookDispatcher.signPayload(payload, primarySecret, expiredTimestamp);

      const isValid = verifySignatureWithDualSecrets(
        payload,
        signature,
        expiredTimestamp,
        primarySecret,
        secondarySecret,
        300 // 5 minute tolerance
      );
      expect(isValid).toBe(false);
    });

    it('filters events accurately based on subscribedEvents list', () => {
      expect(shouldDispatchEvent('job.completed', undefined)).toBe(true);
      expect(shouldDispatchEvent('job.completed', ['*'])).toBe(true);
      expect(shouldDispatchEvent('job.completed', ['job.completed', 'job.failed'])).toBe(true);
      expect(shouldDispatchEvent('job.progress', ['job.completed', 'job.failed'])).toBe(false);
      expect(shouldDispatchEvent('job.failed', ['job.*'])).toBe(true);
      expect(shouldDispatchEvent('quota.warning', ['job.*'])).toBe(false);
    });

    it('skips dispatching if event does not match subscribed events', async () => {
      const dispatcher = new WebhookDispatcher({
        timeoutMs: 1000,
        maxRetries: 1,
      });

      const result = await dispatcher.dispatch(
        'https://example.com/webhook',
        'job.progress' as any,
        { percent: 50 },
        primarySecret,
        {
          timeoutMs: 1000,
          maxRetries: 1,
          subscribedEvents: ['job.completed', 'job.failed'],
        }
      );

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.totalAttempts).toBe(0);
      expect(result.attempts.length).toBe(0);
    });
  });

  describe('OpenAPI 3.1 Specification Serving & Route Parity', () => {
    it('serves OpenAPI 3.1 specification at /api/v1/openapi.json matching /api/openapi.json', async () => {
      const resV1 = await getOpenApiV1Handler();
      expect(resV1.status).toBe(200);
      const specV1 = await resV1.json();

      const resRoot = await getOpenApiHandler();
      expect(resRoot.status).toBe(200);
      const specRoot = await resRoot.json();

      expect(specV1.openapi).toBe('3.1.0');
      expect(specV1.info.title).toContain('EasyConvert');
      expect(specV1.paths['/api/v1/convert']).toBeDefined();
      expect(specV1.paths['/api/v1/jobs']).toBeDefined();
      expect(specV1).toEqual(specRoot);
    });
  });
});
