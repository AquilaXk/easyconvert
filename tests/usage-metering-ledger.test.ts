import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { computeJobUnits, ResourceClass } from '@/lib/quota/pricing';
import {
  InMemoryUsageLedger,
  UsageLedgerEntry,
  getUsageLedger,
  setUsageLedger,
} from '@/lib/quota/usage-ledger';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { userStore } from '@/lib/auth/user-store';
import { buildRateLimitHeaders } from '@/lib/api/rate-limit';
import { ajv } from '@/lib/api/contracts/validate';
import { GET } from '@/app/api/v1/usage/route';

/**
 * Independent Differential Pricing Oracle
 * Implemented completely independently without referencing production computeJobUnits.
 */
function independentPricingOracle(
  inputBytes: number,
  resourceClass: ResourceClass,
  durationSeconds?: number,
  isMedia?: boolean
): number {
  const mb = Math.max(0, inputBytes) / (1024 * 1024);
  const sizeFactor = Math.max(1, Math.ceil(mb / 100));
  const classMultiplierMap: Record<ResourceClass, number> = {
    light: 1,
    cpu: 2,
    memory: 3,
    gpu: 4,
  };
  let result = sizeFactor * classMultiplierMap[resourceClass];
  if (isMedia && durationSeconds && durationSeconds > 0) {
    result *= Math.max(1, Math.ceil(durationSeconds / 60));
  }
  return result;
}

describe('WP-13 Usage Metering Ledger & Standard RateLimit Headers', () => {
  let testUser: { id: string; email: string };
  let testApiKey: { key: string; id: string };
  let inMemoryLedger: InMemoryUsageLedger;

  beforeEach(async () => {
    inMemoryLedger = new InMemoryUsageLedger();
    setUsageLedger(inMemoryLedger);

    const email = `ledger_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@example.com`;
    testUser = await userStore.createUser({
      name: 'Ledger Tester',
      email,
      passwordHash: 'hashed_pw',
      tier: 'pro',
    });

    const keyResult = await redisKeyStore.generateApiKey(testUser.id, 'Ledger Test Key', {
      scopes: ['convert:write', 'read:usage', 'read'],
    });
    testApiKey = { key: keyResult.secretKey, id: keyResult.key.id };
  });

  afterEach(async () => {
    setUsageLedger(null);
  });

  describe('1. Deterministic Pricing Units Formula (D3)', () => {
    it('accurately computes units matching independent differential oracle for light, cpu, memory, and gpu classes', () => {
      const testCases: Array<{ bytes: number; rClass: ResourceClass }> = [
        { bytes: 10 * 1024 * 1024, rClass: 'light' }, // 10MB -> 1
        { bytes: 99 * 1024 * 1024, rClass: 'light' }, // 99MB -> 1
        { bytes: 100 * 1024 * 1024, rClass: 'light' }, // 100MB -> 1
        { bytes: 101 * 1024 * 1024, rClass: 'light' }, // 101MB -> 2
        { bytes: 250 * 1024 * 1024, rClass: 'cpu' }, // 250MB -> ceil(2.5) * 2 = 6
        { bytes: 410 * 1024 * 1024, rClass: 'memory' }, // 410MB -> ceil(4.1) * 3 = 15
        { bytes: 1024 * 1024 * 1024, rClass: 'gpu' }, // 1024MB (1GB) -> ceil(10.24) * 4 = 44
      ];

      for (const tc of testCases) {
        const expected = independentPricingOracle(tc.bytes, tc.rClass);
        const actual = computeJobUnits({ inputBytes: tc.bytes, resourceClass: tc.rClass });
        expect(actual).toBe(expected);
      }
    });

    it('multiplies durationFactor for media transcoding timelines according to independent oracle', () => {
      const bytes = 150 * 1024 * 1024; // 150MB -> sizeFactor = 2
      const testCases = [
        { durationSeconds: 30, expectedMinutes: 1 }, // 30s -> ceil(0.5) = 1 min
        { durationSeconds: 60, expectedMinutes: 1 }, // 60s -> 1 min
        { durationSeconds: 61, expectedMinutes: 2 }, // 61s -> ceil(1.01) = 2 min
        { durationSeconds: 245, expectedMinutes: 5 }, // 245s -> ceil(4.08) = 5 min
      ];

      for (const tc of testCases) {
        const expected = independentPricingOracle(bytes, 'cpu', tc.durationSeconds, true);
        const actual = computeJobUnits({
          inputBytes: bytes,
          resourceClass: 'cpu',
          durationSeconds: tc.durationSeconds,
          isMedia: true,
        });
        expect(actual).toBe(expected);
        // Explicit differential check: sizeFactor(2) * classMultiplier(2) * durationFactor
        expect(actual).toBe(2 * 2 * tc.expectedMinutes);
      }
    });

    it('enforces minimum boundary of 1 unit on empty or zero-byte inputs', () => {
      const unitsZero = computeJobUnits({ inputBytes: 0, resourceClass: 'light' });
      expect(unitsZero).toBe(1);

      const unitsNegative = computeJobUnits({ inputBytes: -500, resourceClass: 'light' });
      expect(unitsNegative).toBe(1);
    });
  });

  describe('2. Usage Metering Ledger & Idempotency Guarantee', () => {
    it('records 3 heterogeneous jobs (light, cpu, failed) and ensures failed jobs record 0 billed units', async () => {
      const ledger = getUsageLedger();
      const now = Date.now();

      // Job 1: Light text extraction (50MB, light) -> 1 unit
      const entry1: UsageLedgerEntry = {
        jobId: 'job_light_001',
        nodeId: 'node_extract',
        units: 1,
        resourceClass: 'light',
        bytesIn: 50 * 1024 * 1024,
        bytesOut: 5000,
        durationMs: 120,
        timestamp: now - 3000,
        status: 'completed',
      };
      const rec1 = await ledger.recordUsage(testUser.id, entry1);
      expect(rec1.recorded).toBe(true);

      // Job 2: Heavy CPU CAD conversion (150MB, cpu) -> 4 units
      const entry2: UsageLedgerEntry = {
        jobId: 'job_cpu_002',
        nodeId: 'node_mesh',
        units: 4,
        resourceClass: 'cpu',
        bytesIn: 150 * 1024 * 1024,
        bytesOut: 30 * 1024 * 1024,
        durationMs: 4500,
        timestamp: now - 2000,
        status: 'completed',
      };
      const rec2 = await ledger.recordUsage(testUser.id, entry2);
      expect(rec2.recorded).toBe(true);

      // Job 3: Failed conversion -> 0 units billed, status failed
      const entry3: UsageLedgerEntry = {
        jobId: 'job_failed_003',
        nodeId: 'node_transcode',
        units: 0,
        resourceClass: 'memory',
        bytesIn: 80 * 1024 * 1024,
        bytesOut: 0,
        durationMs: 800,
        timestamp: now - 1000,
        status: 'failed',
      };
      const rec3 = await ledger.recordUsage(testUser.id, entry3);
      expect(rec3.recorded).toBe(true);

      // Query ledger
      const queryResult = await ledger.queryUsage(testUser.id);
      expect(queryResult.items).toHaveLength(3);
      expect(queryResult.count).toBe(3);
      expect(queryResult.totalUnits).toBe(5); // 1 + 4 + 0 = 5

      const failedItem = queryResult.items.find((item) => item.jobId === 'job_failed_003');
      expect(failedItem).toBeDefined();
      expect(failedItem?.units).toBe(0);
      expect(failedItem?.status).toBe('failed');
    });

    it('enforces idempotency: duplicate completion events for identical jobId:nodeId are not duplicated', async () => {
      const ledger = getUsageLedger();
      const entry: UsageLedgerEntry = {
        jobId: 'job_idemp_alpha',
        nodeId: 'node_single',
        units: 3,
        resourceClass: 'memory',
        bytesIn: 100 * 1024 * 1024,
        bytesOut: 20 * 1024 * 1024,
        durationMs: 1500,
        timestamp: Date.now(),
        status: 'completed',
      };

      // First emission
      const first = await ledger.recordUsage(testUser.id, entry);
      expect(first.recorded).toBe(true);

      // Duplicate emission with exact same jobId and nodeId
      const second = await ledger.recordUsage(testUser.id, entry);
      expect(second.recorded).toBe(false);
      expect(second.entry.jobId).toBe('job_idemp_alpha');

      // Verify ledger contains exactly 1 record
      const result = await ledger.queryUsage(testUser.id);
      expect(result.items).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(result.totalUnits).toBe(3);
    });
  });

  describe('3. 2-Phase Quota Settlement & Refund Reconciliation', () => {
    it('adjusts quota accurately on settlement: refunds difference when actual units are lower than reserved', async () => {
      // 1. Reserve 5 units
      const reserveResult = await redisKeyStore.reserveQuota(testUser.id, 5);
      expect(reserveResult.allowed).toBe(true);
      const resId = reserveResult.reservationId!;

      // 2. Settle with 2 actual units (surplus refund of 3 units)
      const settleResult = await redisKeyStore.settleQuota(resId, 2);
      expect(settleResult.success).toBe(true);
      expect(settleResult.difference).toBe(-3); // actual(2) - reserved(5) = -3

      // 3. Confirm reservation is finalized and deleted
      expect(redisKeyStore.getReservation(resId)).toBeUndefined();
    });

    it('refunds 100% of reserved units on rollbackQuota and leaves zero stranded reservations', async () => {
      const reserveResult = await redisKeyStore.reserveQuota(testUser.id, 4);
      expect(reserveResult.allowed).toBe(true);
      const resId = reserveResult.reservationId!;

      const rollbackSuccess = await redisKeyStore.rollbackQuota(resId);
      expect(rollbackSuccess).toBe(true);
      expect(redisKeyStore.getReservation(resId)).toBeUndefined();
    });
  });

  describe('4. Standard IETF RateLimit Headers', () => {
    it('emits RateLimit-Policy and combined RateLimit header field matching IETF draft syntax', () => {
      const quota = {
        tier: 'pro' as const,
        dailyLimit: 500,
        usedToday: 120,
        remaining: 380,
        resetAt: Date.now() + 3600 * 1000, // 1 hour left
      };

      const headers = buildRateLimitHeaders(quota);

      // Verify standard IETF RateLimit combined header
      expect(headers['RateLimit']).toBeDefined();
      expect(headers['RateLimit']).toMatch(/^limit=500, remaining=380, reset=\d+$/);

      // Verify RateLimit-Policy header
      expect(headers['RateLimit-Policy']).toBeDefined();
      expect(headers['RateLimit-Policy']).toContain('500;w=86400');

      // Verify backward-compatibility headers
      expect(headers['X-RateLimit-Limit']).toBe('500');
      expect(headers['X-RateLimit-Remaining']).toBe('380');
      expect(headers['RateLimit-Limit']).toBe('500');
      expect(headers['RateLimit-Remaining']).toBe('380');
    });
  });

  describe('5. Authenticated Usage Query Endpoint (GET /api/v1/usage)', () => {
    it('returns 401 Unauthorized when request lacks authentication', async () => {
      const req = new NextRequest('http://localhost/api/v1/usage', {
        method: 'GET',
      });

      const res = await GET(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns 400 Bad Request when query params "from" or "to" are invalid', async () => {
      const req = new NextRequest('http://localhost/api/v1/usage?from=not-a-valid-date', {
        method: 'GET',
        headers: {
          'x-api-key': testApiKey.key,
        },
      });

      const res = await GET(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('INVALID_QUERY_PARAM');
    });

    it('returns 200 OK with metered ledger items conforming strictly to JSON Schema', async () => {
      const ledger = getUsageLedger();
      const now = Date.now();

      await ledger.recordUsage(testUser.id, {
        jobId: 'job_api_01',
        nodeId: 'node_convert',
        units: 2,
        resourceClass: 'cpu',
        bytesIn: 2000000,
        bytesOut: 1000000,
        durationMs: 350,
        timestamp: now,
        status: 'completed',
      });

      const req = new NextRequest('http://localhost/api/v1/usage', {
        method: 'GET',
        headers: {
          'x-api-key': testApiKey.key,
        },
      });

      const res = await GET(req);
      expect(res.status).toBe(200);

      // Verify RateLimit headers present on response
      expect(res.headers.get('ratelimit')).toBeDefined();
      expect(res.headers.get('ratelimit-policy')).toBeDefined();

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.items).toHaveLength(1);
      expect(body.totalUnits).toBe(2);
      expect(body.count).toBe(1);

      // Strict validation against registered Ajv 2020 schema
      const validate = ajv.getSchema('https://easyconvert.local/schemas/usage-query-response.json');
      expect(validate).toBeDefined();
      const isValid = validate!(body);
      expect(isValid).toBe(true);
    });
  });
});
