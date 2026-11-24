import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Redis from 'ioredis';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import * as multipartBodyMod from '../src/lib/api/multipart-body';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import {
  buildScopedKey,
  computeFingerprint,
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
  setIdempotencyStore,
  type IdempotencyStore,
} from '../src/lib/api/idempotency';
import { hasExistingIdempotencyRecord, validateIdempotencyKeyHeader } from '../src/lib/api/with-idempotency';
import { userStore } from '../src/lib/auth/user-store';
import { FREE_DAILY_CREDITS } from '../src/lib/plan-limits';
import {
  acquireSyncSlot,
  CONCURRENCY_LIMIT_PROBLEM_TYPE,
  DEFAULT_FREE_CONCURRENCY,
  syncSlotKey,
  syncSlotsInUse,
  type ConversionSlot,
} from '../src/lib/queue/concurrency-limit';
import { QUOTA_EXCEEDED_PROBLEM_TYPE } from '../src/lib/refusal-codes';
import { setDiskProbe } from '../src/lib/storage/retention-service';

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
const ROUTE_URI = '/api/v1/convert';
const ROUTE_URL = `http://localhost${ROUTE_URI}`;
const CSV_A = Buffer.from('name,score\nAlice,100\n');
const CSV_B = Buffer.from('name,score\nAlice,999\n');

function trackedStream(bytes: Uint8Array, failOnRead: boolean): { stream: ReadableStream<Uint8Array>; reads: () => number } {
  let readCount = 0;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        readCount++;
        if (failOnRead) {
          controller.error(new Error('Unexpected request body read'));
          return;
        }
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset));
        offset = bytes.byteLength;
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, reads: () => readCount };
}

async function serializeCsvForm(csvBytes: Buffer, targetFormat = 'json'): Promise<{ contentType: string; bytes: Uint8Array<ArrayBuffer> }> {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(csvBytes)], 'scores.csv', { type: 'text/csv' }));
  form.append('targetFormat', targetFormat);
  const res = new Response(form);
  const contentType = res.headers.get('content-type')!;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { contentType, bytes };
}

async function spendCredits(userId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const reserved = await redisKeyStore.reserveQuota(userId, 1);
    if (!reserved.allowed || !reserved.reservationId) {
      throw new Error(`Failed to reserve test credit ${i + 1}/${count}`);
    }
    await redisKeyStore.commitQuota(reserved.reservationId);
  }
}

describe.each([
  { name: 'InMemoryIdempotencyStore', isRedis: false },
  { name: 'RedisIdempotencyStore', isRedis: true },
])('POST /api/v1/convert pre-body idempotency gates: $name', ({ isRedis }) => {
  let store: IdempotencyStore;
  let redisClient: Redis | null = null;
  let userId = '';
  let apiKeySecret = '';
  const createdScopedKeys: string[] = [];

  function trackKey(key: string): string {
    createdScopedKeys.push(buildScopedKey(userId, ROUTE_URI, key));
    return key;
  }

  async function buildStreamMultipartRequest(
    key: string | null,
    csvBytes: Buffer,
    options: { failOnRead?: boolean } = {}
  ): Promise<{ req: NextRequest; reads: () => number }> {
    const { contentType, bytes } = await serializeCsvForm(csvBytes);
    const { stream, reads } = trackedStream(bytes, options.failOnRead ?? false);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKeySecret}`,
      'Content-Type': contentType,
    };
    if (key !== null) headers['Idempotency-Key'] = key;
    const req = new NextRequest(ROUTE_URL, {
      method: 'POST',
      headers,
      body: stream,
      duplex: 'half',
    });
    return { req, reads };
  }

  function buildJsonRequest(
    key: string | null,
    payload: unknown,
    options: { failOnRead?: boolean } = {}
  ): { req: NextRequest; reads: () => number } {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const { stream, reads } = trackedStream(bytes, options.failOnRead ?? false);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKeySecret}`,
      'Content-Type': 'application/json',
    };
    if (key !== null) headers['Idempotency-Key'] = key;
    const req = new NextRequest(ROUTE_URL, {
      method: 'POST',
      headers,
      body: stream,
      duplex: 'half',
    });
    return { req, reads };
  }

  beforeEach(async (ctx) => {
    createdScopedKeys.length = 0;
    if (isRedis) {
      const redisUrl = process.env.REDIS_URL || DEFAULT_REDIS_URL;
      redisClient = new Redis(redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
      redisClient.on('error', () => undefined);
      try {
        await redisClient.connect();
        await redisClient.ping();
      } catch (err) {
        redisClient.disconnect();
        redisClient = null;
        if (process.env.ORACLE_STRICT_MODE === '1' || process.env.REDIS_URL) {
          throw new Error(`Redis is required for RedisIdempotencyStore variant at ${redisUrl}: ${String(err)}`);
        }
        ctx.skip();
        return;
      }
      store = new RedisIdempotencyStore({ redisClient });
    } else {
      store = new InMemoryIdempotencyStore();
    }

    setIdempotencyStore(store);
    setDiskProbe(async () => 0);

    const user = await userStore.createUser({
      emailVerified: true,
      email: `v1-gates-${Date.now()}-${crypto.randomBytes(6).toString('hex')}@easyconvert.local`,
      name: 'V1 Gate Tester',
      tier: 'free',
    });
    userId = user.id;
    const generated = await redisKeyStore.generateApiKey(userId, 'Gate Key', {
      scopes: ['convert:write', 'convert:read'],
    });
    apiKeySecret = generated.secretKey;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setIdempotencyStore(null);
    setDiskProbe(undefined);
    if (redisClient) {
      if (createdScopedKeys.length > 0) {
        await redisClient.del(...createdScopedKeys).catch(() => undefined);
      }
      await redisClient.quit().catch(() => undefined);
      redisClient = null;
    }
  });

  it('refuses exhausted quota (429) with 0 body reads and allows retry with same key once quota is restored', async () => {
    const key = trackKey(`quota-${crypto.randomUUID()}`);
    let exhausted = true;
    const realGetQuota = redisKeyStore.getQuotaUsage.bind(redisKeyStore);
    vi.spyOn(redisKeyStore, 'getQuotaUsage').mockImplementation(async (id) => {
      const quota = await realGetQuota(id);
      return exhausted ? { ...quota, remaining: 0 } : quota;
    });

    const first = await buildStreamMultipartRequest(key, CSV_A, { failOnRead: true });
    const refused = await v1ConvertPost(first.req);
    expect(refused.status).toBe(429);
    expect(first.reads()).toBe(0);
    const problem = await refused.json();
    expect(problem.type).toBe(QUOTA_EXCEEDED_PROBLEM_TYPE);

    exhausted = false;
    const retry = await buildStreamMultipartRequest(key, CSV_A);
    const accepted = await v1ConvertPost(retry.req);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('idempotent-replayed')).toBeNull();
    expect(retry.reads()).toBeGreaterThan(0);
  });

  it('refuses saturated sync concurrency slots (429) with 0 body reads and accepts retry with same key once freed', async () => {
    const key = trackKey(`slots-${crypto.randomUUID()}`);
    const held: ConversionSlot[] = [];
    try {
      for (let i = 0; i < DEFAULT_FREE_CONCURRENCY; i++) {
        const slot = await acquireSyncSlot(userId, 'free');
        expect(slot.granted).toBe(true);
        held.push(slot);
      }

      const saturated = await buildStreamMultipartRequest(key, CSV_A, { failOnRead: true });
      const refused = await v1ConvertPost(saturated.req);
      expect(refused.status).toBe(429);
      expect(saturated.reads()).toBe(0);
      const problem = await refused.json();
      expect(problem.type).toBe(CONCURRENCY_LIMIT_PROBLEM_TYPE);
      expect(problem.limit).toBe(DEFAULT_FREE_CONCURRENCY);
    } finally {
      for (const slot of held) {
        if (slot.granted) slot.release();
      }
      const keyStoreRedis = redisKeyStore.getRedisClient();
      if (keyStoreRedis) {
        await vi.waitFor(async () => {
          expect(await keyStoreRedis.zcard(syncSlotKey(userId))).toBe(0);
        });
      }
    }

    const retry = await buildStreamMultipartRequest(key, CSV_A);
    const accepted = await v1ConvertPost(retry.req);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('idempotent-replayed')).toBeNull();
  });

  it('refuses non-multipart Content-Type (415) with 0 body reads, replays 415 identically, and returns 422 on multipart reuse', async () => {
    const key = trackKey(`non-mp-${crypto.randomUUID()}`);

    const first = buildJsonRequest(key, { targetFormat: 'json' }, { failOnRead: true });
    const res1 = await v1ConvertPost(first.req);
    expect(res1.status).toBe(415);
    expect(first.reads()).toBe(0);

    const second = buildJsonRequest(key, { different: 'json-never-read' }, { failOnRead: true });
    const res2 = await v1ConvertPost(second.req);
    expect(res2.status).toBe(415);
    expect(res2.headers.get('idempotent-replayed')).toBe('true');
    expect(second.reads()).toBe(0);

    const third = await buildStreamMultipartRequest(key, CSV_A);
    const res3 = await v1ConvertPost(third.req);
    expect(res3.status).toBe(422);
    const problem = await res3.json();
    expect(problem.type).toBe('https://convert.aquilaxk.site/api-docs/errors#idempotency-key-reused');
  });

  it.each(['', 'bad\x01key'])('rejects invalid Idempotency-Key %j with 400 and 0 body reads', async (badKey) => {
    const built = await buildStreamMultipartRequest(badKey, CSV_A, { failOnRead: true });
    const res = await v1ConvertPost(built.req);
    expect(res.status).toBe(400);
    expect(built.reads()).toBe(0);
    const problem = await res.json();
    expect(problem.detail).toContain('Idempotency-Key');
  });

  it('replays 200 after the caller spends their last credit and refuses altered bytes with 422', async () => {
    const key = trackKey(`last-credit-${crypto.randomUUID()}`);
    await spendCredits(userId, FREE_DAILY_CREDITS - 1);
    expect((await redisKeyStore.getQuotaUsage(userId)).remaining).toBe(1);

    const first = await buildStreamMultipartRequest(key, CSV_A);
    const res1 = await v1ConvertPost(first.req);
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.success).toBe(true);
    expect((await redisKeyStore.getQuotaUsage(userId)).remaining).toBe(0);

    const replay = await buildStreamMultipartRequest(key, CSV_A);
    const res2 = await v1ConvertPost(replay.req);
    expect(res2.status).toBe(200);
    expect(res2.headers.get('idempotent-replayed')).toBe('true');
    const body2 = await res2.json();
    expect(body2.fileId).toBe(body1.fileId);

    const altered = await buildStreamMultipartRequest(key, CSV_B);
    const res3 = await v1ConvertPost(altered.req);
    expect(res3.status).toBe(422);
    const problem = await res3.json();
    expect(problem.type).toBe('https://convert.aquilaxk.site/api-docs/errors#idempotency-key-reused');
  });

  it('parses multipart FormData at most once during a valid Idempotency-Key conversion', async () => {
    const key = trackKey(`single-parse-${crypto.randomUUID()}`);
    const formDataSpy = vi.spyOn(Request.prototype, 'formData');
    const readSpy = vi.spyOn(multipartBodyMod, 'readMultipartForm');

    const first = await buildStreamMultipartRequest(key, CSV_A);
    const res1 = await v1ConvertPost(first.req);
    expect(res1.status).toBe(200);
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(syncSlotsInUse()).toBe(0);
  });

  it('replays 409 in-flight even when quota is 0 and sync slots are saturated', async () => {
    const key = trackKey(`inflight-${crypto.randomUUID()}`);
    const scopedKey = buildScopedKey(userId, ROUTE_URI, key);
    const { contentType, bytes } = await serializeCsvForm(CSV_A);
    const probeForm = await new Request(ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bytes,
    }).formData();
    const file = probeForm.get('file') as File;
    const fileSha256 = crypto.createHash('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex');
    const fingerprint = computeFingerprint(
      'POST',
      ROUTE_URI,
      {
        _file: { name: file.name, type: file.type, size: file.size },
        targetFormat: 'json',
      },
      fileSha256,
      false
    );

    const acquired = await store.acquire(scopedKey, fingerprint, 60_000, 'active-lock-token');
    expect(acquired.status).toBe('acquired');

    const realGetQuota = redisKeyStore.getQuotaUsage.bind(redisKeyStore);
    vi.spyOn(redisKeyStore, 'getQuotaUsage').mockImplementation(async (id) => ({
      ...(await realGetQuota(id)),
      remaining: 0,
    }));

    const held: ConversionSlot[] = [];
    try {
      for (let i = 0; i < DEFAULT_FREE_CONCURRENCY; i++) {
        const slot = await acquireSyncSlot(userId, 'free');
        expect(slot.granted).toBe(true);
        held.push(slot);
      }

      const duplicate = await buildStreamMultipartRequest(key, CSV_A);
      const res = await v1ConvertPost(duplicate.req);
      expect(res.status).toBe(409);
      expect(res.headers.get('retry-after')).toBe('1');
    } finally {
      for (const slot of held) {
        if (slot.granted) slot.release();
      }
      const keyStoreRedis = redisKeyStore.getRedisClient();
      if (keyStoreRedis) {
        await vi.waitFor(async () => {
          expect(await keyStoreRedis.zcard(syncSlotKey(userId))).toBe(0);
        });
      }
    }
  });

  it('releases acquired sync slots when an aborted multipart body throws during read', async () => {
    const key = trackKey(`aborted-${crypto.randomUUID()}`);
    const controller = new AbortController();
    const { contentType } = await serializeCsvForm(CSV_A);
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(streamController) {
          controller.abort();
          streamController.error(new Error('client disconnected'));
        },
      },
      { highWaterMark: 0 }
    );
    const req = new NextRequest(ROUTE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKeySecret}`,
        'Content-Type': contentType,
        'Idempotency-Key': key,
      },
      body: stream,
      duplex: 'half',
      signal: controller.signal,
    });

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await v1ConvertPost(req);
    expect(res.status).toBe(499);
    expect(syncSlotsInUse()).toBe(0);
    const keyStoreRedis = redisKeyStore.getRedisClient();
    if (keyStoreRedis) {
      await vi.waitFor(async () => {
        expect(await keyStoreRedis.zcard(syncSlotKey(userId))).toBe(0);
      });
    }
    expect(await hasExistingIdempotencyRecord(userId, ROUTE_URI, key, store)).toBe(false);
  });

  it('releases the key if an existing record expires before acquire while quota is 0 or slots are full', async () => {
    const key = trackKey(`expired-race-${crypto.randomUUID()}`);
    const getRecordSpy = vi.spyOn(store as Required<Pick<IdempotencyStore, 'getRecord'>>, 'getRecord').mockResolvedValueOnce({
      status: 'completed',
      fingerprint: 'stale-fp',
      createdAt: Date.now() - 100_000,
    });

    let exhausted = true;
    const realGetQuota = redisKeyStore.getQuotaUsage.bind(redisKeyStore);
    vi.spyOn(redisKeyStore, 'getQuotaUsage').mockImplementation(async (id) => {
      const quota = await realGetQuota(id);
      return exhausted ? { ...quota, remaining: 0 } : quota;
    });

    const first = await buildStreamMultipartRequest(key, CSV_A);
    const res1 = await v1ConvertPost(first.req);
    expect(getRecordSpy).toHaveBeenCalledTimes(1);
    expect(res1.status).toBe(429);
    expect(await hasExistingIdempotencyRecord(userId, ROUTE_URI, key, store)).toBe(false);

    exhausted = false;
    const second = await buildStreamMultipartRequest(key, CSV_A);
    const res2 = await v1ConvertPost(second.req);
    expect(res2.status).toBe(200);
    expect(res2.headers.get('idempotent-replayed')).toBeNull();
  });
});

describe('idempotency header and record helpers', () => {
  it('validates Idempotency-Key syntax without touching a request body', async () => {
    expect(validateIdempotencyKeyHeader('valid-key_123', ROUTE_URI)).toBeNull();
    const badEmpty = validateIdempotencyKeyHeader('', ROUTE_URI);
    expect(badEmpty?.status).toBe(400);
    expect((await badEmpty?.json()).detail).toContain('Idempotency-Key');
    const badCtrl = validateIdempotencyKeyHeader('bad\x7fkey', ROUTE_URI);
    expect(badCtrl?.status).toBe(400);
  });

  it('hasExistingIdempotencyRecord returns false when a store omits getRecord', async () => {
    const minimalStore: IdempotencyStore = {
      acquire: async () => ({ status: 'acquired' }),
      complete: async () => true,
      releaseLock: async () => true,
      keepLock: async () => true,
    };
    expect(await hasExistingIdempotencyRecord('u1', ROUTE_URI, 'k1', minimalStore)).toBe(false);
  });
});
