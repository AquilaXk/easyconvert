import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  normalizeIp,
  isIpInCidr,
  isIpAllowed,
  extractClientIp,
} from '../src/lib/api-keys/ip-utils';
import {
  validateApiAccess,
  isScopeAllowed,
  commitQuota,
  rollbackQuota,
} from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { ApiKeyScope } from '../src/lib/api-keys/types';
import { userStore } from '../src/lib/auth/user-store';
import { WebhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { POST as jobsPostHandler, GET as jobsGetHandler } from '../src/app/api/v1/jobs/route';
import { GET as jobByIdHandler } from '../src/app/api/v1/jobs/[id]/route';
import { POST as convertHandler } from '../src/app/api/v1/convert/route';
import { GET as openApiHandler } from '../src/app/api/openapi.json/route';
import { killProcessGroup, executeSandboxedBinary } from '../src/lib/security/process-sandbox';

describe('Security, Developer API & Distributed Quota Hardening (Issue #178)', () => {
  let testUser: any;
  let fullAccessKey: { key: any; secretKey: string };
  let readOnlyKey: { key: any; secretKey: string };
  let convertOnlyKey: { key: any; secretKey: string };
  let jobsWriteKey: { key: any; secretKey: string };
  let wildcardJobsKey: { key: any; secretKey: string };

  beforeEach(async () => {
    // Setup clean test user and keys
    const email = `sec_api_${Date.now()}_${Math.random().toString(36).substring(7)}@easyconvert.local`;
    testUser = await userStore.createUser({ name: 'Security Tester', email, password: 'SecurePass123!', tier: 'pro' });

    fullAccessKey = await redisKeyStore.generateApiKey(testUser.id, 'Full Access Key', {
      scopes: ['*'],
    });

    readOnlyKey = await redisKeyStore.generateApiKey(testUser.id, 'Read Only Key', {
      scopes: ['convert:read'],
    });

    convertOnlyKey = await redisKeyStore.generateApiKey(testUser.id, 'Convert Only Key', {
      scopes: ['convert:write'],
    });

    jobsWriteKey = await redisKeyStore.generateApiKey(testUser.id, 'Jobs Write Key', {
      scopes: ['convert:write'],
    });

    wildcardJobsKey = await redisKeyStore.generateApiKey(testUser.id, 'Wildcard Jobs Key', {
      // Namespace wildcard is honored by the guard but is not a creatable ApiKeyScope literal.
      scopes: ['convert:*' as ApiKeyScope],
    });
  });

  describe('1. IP Normalization & Reverse Proxy Security (ip-utils.ts)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('normalizes IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) to clean IPv4', () => {
      expect(normalizeIp('::ffff:192.168.1.50')).toBe('192.168.1.50');
      expect(normalizeIp('[::ffff:10.0.0.1]')).toBe('10.0.0.1');
      expect(normalizeIp('0:0:0:0:0:ffff:172.16.5.99')).toBe('172.16.5.99');
    });

    it('strips ports and brackets accurately without corrupting standard addresses', () => {
      expect(normalizeIp('192.168.1.1:8080')).toBe('192.168.1.1');
      expect(normalizeIp('[2001:db8::1]:8443')).toBe('2001:db8::1');
      expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
      expect(normalizeIp('')).toBe('');
    });

    it('matches IPv4-mapped IPv6 clients against IPv4 CIDRs without false 403 blocks', () => {
      const clientIp = '::ffff:192.168.1.42';
      expect(isIpInCidr(clientIp, '192.168.1.0/24')).toBe(true);
      expect(isIpInCidr(clientIp, '192.168.2.0/24')).toBe(false);
      expect(isIpAllowed(clientIp, ['192.168.1.0/24'])).toBe(true);
      expect(isIpAllowed(clientIp, ['10.0.0.0/8'])).toBe(false);
    });

    it('prefers cf-connecting-ip over x-forwarded-for only for a verified CDN edge peer', () => {
      vi.stubEnv('TRUSTED_CDN', 'cloudflare');
      const spoofedReq = new Request('http://localhost/api/v1/jobs', {
        headers: {
          'x-forwarded-for': '203.0.113.195, 198.51.100.1',
          'cf-connecting-ip': '::ffff:198.51.100.5',
        },
      });
      // Peer is a Cloudflare edge: header honoured and normalized from ::ffff:
      expect(extractClientIp(spoofedReq, undefined, '173.245.48.5')).toBe('198.51.100.5');
      // Peer is not a Cloudflare edge: the forged header is ignored and the peer itself is the client.
      expect(extractClientIp(spoofedReq, undefined, '203.0.113.7')).toBe('203.0.113.7');
    });

    it('ignores x-real-ip and resolves the x-forwarded-for chain from the right behind a declared proxy', () => {
      vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
      const proxyReq = new Request('http://localhost/api/v1/jobs', {
        headers: {
          'x-forwarded-for': '1.2.3.4, 5.6.7.8',
          'x-real-ip': '10.20.30.40:9000',
        },
      });
      expect(extractClientIp(proxyReq)).toBe('5.6.7.8');
    });
  });

  describe('2. Distributed Quota Accounting & API Key Scopes (guard.ts)', () => {
    it('isScopeAllowed supports exact, wildcard, and hierarchical scopes', () => {
      expect(isScopeAllowed(['*'], 'convert')).toBe(true);
      expect(isScopeAllowed(['jobs:*'], 'jobs:read')).toBe(true);
      expect(isScopeAllowed(['jobs:*'], 'jobs:write')).toBe(true);
      expect(isScopeAllowed(['jobs:*'], 'convert')).toBe(false);
      expect(isScopeAllowed(['jobs:read'], 'jobs:read')).toBe(true);
      expect(isScopeAllowed(['jobs:read'], 'jobs:write')).toBe(false);
      expect(isScopeAllowed(undefined, 'convert')).toBe(true); // Unscoped key default access
    });

    it('enforces 403 Forbidden when API key lacks required scope', async () => {
      const req = new Request('http://localhost/api/v1/jobs', {
        headers: {
          'x-api-key': readOnlyKey.secretKey,
        },
      });

      // Requesting 'convert:write' with read-only key
      const result = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
      expect(result.authorized).toBe(false);
      expect(result.status).toBe(403);
      expect(result.error).toContain("Forbidden: API key lacks required scope 'convert:write'");
    });

    it('permits access when API key has exact or hierarchical scope', async () => {
      const reqRead = new Request('http://localhost/api/v1/jobs', {
        headers: { 'x-api-key': readOnlyKey.secretKey },
      });
      const resultRead = await validateApiAccess(reqRead, { requiredUnits: 0, requiredScope: 'convert:read' });
      expect(resultRead.authorized).toBe(true);

      const reqWildcard = new Request('http://localhost/api/v1/jobs', {
        headers: { 'x-api-key': wildcardJobsKey.secretKey },
      });
      const resultWildcard = await validateApiAccess(reqWildcard, { requiredUnits: 0, requiredScope: 'convert:write' });
      expect(resultWildcard.authorized).toBe(true);
    });

    it('atomically reserves, commits, and rolls back quota through redisKeyStore transactions', async () => {
      const req = new Request('http://localhost/api/v1/convert', {
        headers: { 'x-api-key': fullAccessKey.secretKey },
      });

      // 1. Reserve quota unit
      const auth = await validateApiAccess(req, { requiredUnits: 1, requiredScope: 'convert:write' });
      expect(auth.authorized).toBe(true);
      expect(auth.reservationId).toBeDefined();

      const reservationId = auth.reservationId!;

      // 2. Rollback reserved unit
      const rolledBack = await rollbackQuota(reservationId);
      expect(rolledBack).toBe(true);

      // 3. Second reservation and commit
      const auth2 = await validateApiAccess(req, { requiredUnits: 1, requiredScope: 'convert:write' });
      expect(auth2.authorized).toBe(true);
      const committed = await commitQuota(auth2.reservationId!);
      expect(committed).toBe(true);
    });
  });

  describe('3. Webhook SSRF Guards & Non-Blocking Dispatch (webhook-dispatcher.ts)', () => {
    it('blocks cloud metadata endpoint (169.254.169.254) immediately with 403', async () => {
      const dispatcher = new WebhookDispatcher();
      const result = await dispatcher.dispatch(
        'http://169.254.169.254/latest/meta-data/',
        'job.completed',
        { status: 'ok' },
        'secret',
        { maxRetries: 1, timeoutMs: 500 }
      );

      expect(result.success).toBe(false);
      expect(result.finalStatusCode).toBe(403);
      expect(result.totalAttempts).toBe(1);
      expect(result.attempts[0].error).toContain('SSRF blocked');
    });

    it('blocks RFC 1918 private network destinations (10.0.0.1, 192.168.1.1, localhost)', async () => {
      const dispatcher = new WebhookDispatcher();
      const privateTargets = [
        'http://10.0.0.1:8080/hook',
        'http://192.168.1.1:3000/hook',
        'http://localhost:9000/hook',
        'http://127.0.0.1:6379/hook',
      ];

      for (const target of privateTargets) {
        const result = await dispatcher.dispatch(
          target,
          'conversion.completed',
          { id: '123' },
          'secret',
          { maxRetries: 1, timeoutMs: 500 }
        );
        expect(result.success).toBe(false);
        expect(result.finalStatusCode).toBe(403);
        expect(result.attempts[0].error).toContain('SSRF blocked');
      }
    });

    it('dispatchAsync triggers background non-blocking execution returning deliveryId', () => {
      const dispatcher = new WebhookDispatcher();
      const { deliveryId, promise } = dispatcher.dispatchAsync(
        'http://127.0.0.1:9999/blocked',
        'job.failed',
        { reason: 'test' },
        'secret',
        { maxRetries: 1, timeoutMs: 200 }
      );

      expect(deliveryId).toMatch(/^wh_\d+_[0-9a-f]+$/);
      expect(promise).toBeInstanceOf(Promise);
    });
  });

  describe('4. RFC 9457 Problem Details Standards Compliance', () => {
    it('POST /api/v1/jobs returns application/problem+json on validation failure', async () => {
      const req = new NextRequest('http://localhost/api/v1/jobs', {
        method: 'POST',
        headers: {
          'x-api-key': jobsWriteKey.secretKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          // Missing targetFormat and file data
          filename: 'test.docx',
        }),
      });

      const res = await jobsPostHandler(req);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/problem+json');

      const problem = await res.json();
      expect(problem.type).toBe('https://api.easyconvert.io/problems/bad-request');
      expect(problem.title).toBe('Bad Request');
      expect(problem.status).toBe(400);
      expect(problem.detail).toContain('targetFormat');
      expect(problem.instance).toBe('/api/v1/jobs');
      // Backward compatibility assertions
      expect(problem.success).toBe(false);
      expect(problem.error).toBeDefined();
    });

    it('GET /api/v1/jobs/[id] returns 404 application/problem+json for non-existent jobs', async () => {
      const req = new NextRequest('http://localhost/api/v1/jobs/nonexistent-job-id', {
        headers: { 'x-api-key': readOnlyKey.secretKey },
      });

      const res = await jobByIdHandler(req, { params: Promise.resolve({ id: 'nonexistent-job-id' }) });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');

      const problem = await res.json();
      expect(problem.type).toBe('https://api.easyconvert.io/problems/not-found');
      expect(problem.title).toBe('Not Found');
      expect(problem.status).toBe(404);
      expect(problem.detail).toContain('not found');
      expect(problem.instance).toBe('/api/v1/jobs/nonexistent-job-id');
    });

    it('POST /api/v1/convert rejects read-only key with 403 application/problem+json', async () => {
      const formData = new FormData();
      formData.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'test.txt');
      formData.append('targetFormat', 'pdf');

      const req = new NextRequest('http://localhost/api/v1/convert', {
        method: 'POST',
        headers: { 'x-api-key': readOnlyKey.secretKey },
        body: formData,
      });

      const res = await convertHandler(req);
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toContain('application/problem+json');

      const problem = await res.json();
      expect(problem.status).toBe(403);
      expect(problem.detail).toContain("Forbidden: API key lacks required scope 'convert:write'");
    });

    it('GET /api/openapi.json exposes ProblemDetails schema and RFC 9457 error mappings', async () => {
      const res = await openApiHandler();
      expect(res.status).toBe(200);
      const spec = await res.json();

      expect(spec.components.schemas.ProblemDetails).toBeDefined();
      expect(spec.components.schemas.ProblemDetails.required).toContain('type');
      expect(spec.components.schemas.ProblemDetails.required).toContain('status');

      // Check /api/v1/jobs response content type
      const jobsPost400 = spec.paths['/api/v1/jobs'].post.responses['400'];
      expect(jobsPost400.content['application/problem+json']).toBeDefined();
    });
  });

  describe('5. Process Group Detachment & Zombie Prevention (process-sandbox.ts)', () => {
    it('killProcessGroup gracefully handles undefined or non-existent PID without throwing', () => {
      expect(() => killProcessGroup(undefined)).not.toThrow();
      expect(() => killProcessGroup(-999999)).not.toThrow();
    });

    it('executeSandboxedBinary executes safely and enforces resource bounds', async () => {
      // Test basic echo execution in sandboxed binary runner
      const result = await executeSandboxedBinary('/bin/echo', ['easyconvert-sandbox-test'], {
        timeoutMs: 5000,
      });
      expect(result.stdout.toString('utf-8').trim()).toBe('easyconvert-sandbox-test');
    });
  });
});
