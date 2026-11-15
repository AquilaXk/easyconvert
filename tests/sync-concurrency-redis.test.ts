import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  acquireSyncSlot,
  mayEnqueue,
  setSyncSlotRedisClient,
  syncSlotKey,
  concurrencyLimitFor,
  type ConversionSlot,
} from '../src/lib/queue/concurrency-limit';
import type Redis from 'ioredis';

describe('Redis ZSET Sync Concurrency Lease', () => {
  const userId = 'usr_sync_test_123';
  const tier = 'free'; // limit is 5

  class MockRedisZset {
    private sets = new Map<string, Map<string, number>>();

    async eval(
      script: string,
      numKeys: number,
      key: string,
      nowStr: string,
      expiresAtStr: string,
      slotId: string,
      limitStr: string,
      queuedStr: string
    ): Promise<number> {
      const now = Number(nowStr);
      const expiresAt = Number(expiresAtStr);
      const limit = Number(limitStr);
      const queued = Number(queuedStr) || 0;

      let zset = this.sets.get(key);
      if (!zset) {
        zset = new Map();
        this.sets.set(key, zset);
      }

      // Expire old
      for (const [member, score] of zset.entries()) {
        if (score < now) {
          zset.delete(member);
        }
      }

      if (zset.size + queued >= limit) {
        return 0;
      }

      zset.set(slotId, expiresAt);
      return 1;
    }

    async zrem(key: string, member: string): Promise<number> {
      const zset = this.sets.get(key);
      if (!zset) return 0;
      const deleted = zset.delete(member) ? 1 : 0;
      return deleted;
    }

    async zremrangebyscore(key: string, min: string, max: number | string): Promise<number> {
      const zset = this.sets.get(key);
      if (!zset) return 0;
      const maxScore = Number(max);
      let removed = 0;
      for (const [member, score] of zset.entries()) {
        if (score <= maxScore) {
          zset.delete(member);
          removed++;
        }
      }
      return removed;
    }

    async zcard(key: string): Promise<number> {
      return this.sets.get(key)?.size ?? 0;
    }
  }

  let mockRedis: MockRedisZset;

  beforeEach(() => {
    mockRedis = new MockRedisZset();
    setSyncSlotRedisClient(mockRedis as unknown as Redis);
  });

  afterEach(() => {
    setSyncSlotRedisClient(null);
  });

  it('grants slots up to the concurrency limit and rejects further attempts', async () => {
    const limit = concurrencyLimitFor(tier);
    const slots: ConversionSlot[] = [];

    for (let i = 0; i < limit; i++) {
      const slot = await acquireSyncSlot(userId, tier);
      expect(slot.granted).toBe(true);
      slots.push(slot);
    }

    // 6th attempt exceeds limit of 5
    const rejected = await acquireSyncSlot(userId, tier);
    expect(rejected.granted).toBe(false);
    if (!rejected.granted) {
      expect(rejected.limit).toBe(limit);
    }

    // Releasing one slot frees up capacity
    if (slots[0].granted) {
      slots[0].release();
    }

    const reAttempt = await acquireSyncSlot(userId, tier);
    expect(reAttempt.granted).toBe(true);
    if (reAttempt.granted) {
      slots.push(reAttempt);
    }

    // Clean up
    for (const s of slots) {
      if (s.granted) s.release();
    }
    expect(await mockRedis.zcard(syncSlotKey(userId))).toBe(0);
  });

  it('reflects active sync slots in mayEnqueue', async () => {
    const limit = concurrencyLimitFor(tier);
    const slots: ConversionSlot[] = [];

    for (let i = 0; i < limit; i++) {
      const slot = await acquireSyncSlot(userId, tier);
      slots.push(slot);
    }

    const enqueueCheck = await mayEnqueue(userId, tier);
    expect(enqueueCheck.allowed).toBe(false);

    if (slots[0].granted) slots[0].release();

    const allowedCheck = await mayEnqueue(userId, tier);
    expect(allowedCheck.allowed).toBe(true);

    for (const s of slots) {
      if (s.granted) s.release();
    }
  });

  it('falls back gracefully to in-memory slots when Redis client is unconfigured', async () => {
    setSyncSlotRedisClient(null);
    const anonUser = 'usr_anon_mem_fallback_' + Date.now();
    const limit = concurrencyLimitFor('free');

    const slots: ConversionSlot[] = [];
    for (let i = 0; i < limit; i++) {
      const slot = await acquireSyncSlot(anonUser, 'free');
      expect(slot.granted).toBe(true);
      slots.push(slot);
    }

    const over = await acquireSyncSlot(anonUser, 'free');
    expect(over.granted).toBe(false);

    for (const s of slots) {
      if (s.granted) s.release();
    }
  });
});
