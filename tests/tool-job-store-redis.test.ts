import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import {
  attachToolJobInputs,
  cancelToolJob,
  completeToolJob,
  deleteToolJob,
  failToolJob,
  getToolJob,
  saveToolJob,
  startToolJob,
  transitionToolJob,
} from '../src/lib/tools/tool-job-store';

const REDIS_URL = process.env.REDIS_URL;

// skip-ok: mode selection. Standard shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('tool-job-store atomic Lua CAS transitions in Redis', () => {
  let originalClient: Redis | null = null;
  let admin: Redis;
  let testClient: Redis;
  const createdIds: string[] = [];
  const createdUsers: string[] = [];

  beforeEach(() => {
    originalClient = redisKeyStore.getRedisClient();
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    testClient = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    redisKeyStore.setRedisClient(testClient);
  });

  afterEach(async () => {
    for (const id of createdIds.splice(0)) {
      await deleteToolJob(id).catch(() => undefined);
    }
    const prefix = redisKeyStore.getPrefix();
    for (const userId of createdUsers.splice(0)) {
      await admin.del(`${prefix}user:tool_jobs:${userId}`).catch(() => undefined);
    }
    redisKeyStore.setRedisClient(originalClient);
    await Promise.all([admin.quit(), testClient.quit()]);
  });

  it('transitions queued -> running -> completed atomically and refuses late cancel or overwrite', async () => {
    const id = `tool_redis_${crypto.randomBytes(6).toString('hex')}`;
    const userId = `user_redis_${crypto.randomBytes(4).toString('hex')}`;
    createdIds.push(id);
    createdUsers.push(userId);

    await saveToolJob({
      id,
      userId,
      tool: 'merge',
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    });

    expect(await attachToolJobInputs(id, [`uploads/${userId}/a.pdf`, `uploads/${userId}/b.pdf`])).toBe(true);
    expect(await startToolJob(id, 25)).toBe(true);
    expect(
      await completeToolJob(id, {
        kind: 'file',
        file: { name: 'merged.pdf', size: 42, key: `conversions/${userId}/merged.pdf`, url: '/api/storage/file/x' },
      })
    ).toBe(true);

    const lateCancel = await cancelToolJob(id);
    expect(lateCancel?.status).toBe('completed');
    expect(lateCancel?.progress).toBe(100);
    expect(await failToolJob(id, 'should not overwrite completed')).toBe(false);
    expect(await startToolJob(id, 25)).toBe(false);

    const stored = await getToolJob(id);
    expect(stored?.status).toBe('completed');
    expect(stored?.inputKeys).toEqual([`uploads/${userId}/a.pdf`, `uploads/${userId}/b.pdf`]);
    const ttl = await admin.ttl(`${redisKeyStore.getPrefix()}tool_job:${id}`);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('never overwrites cancelled with running, completed, failed, or inputKeys, and normalizes empty entries arrays', async () => {
    const id = `tool_redis_cancel_${crypto.randomBytes(6).toString('hex')}`;
    const userId = `user_redis_${crypto.randomBytes(4).toString('hex')}`;
    createdIds.push(id);
    createdUsers.push(userId);

    await saveToolJob({
      id,
      userId,
      tool: 'split',
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    });

    const cancelled = await cancelToolJob(id);
    expect(cancelled?.status).toBe('cancelled');
    expect(await cancelToolJob(id)).toMatchObject({ id, status: 'cancelled' });
    expect(await attachToolJobInputs(id, [`uploads/${userId}/doc.pdf`])).toBe(false);
    expect(await startToolJob(id, 25)).toBe(false);
    expect(await completeToolJob(id, { kind: 'entries', entries: [] })).toBe(false);
    expect(await failToolJob(id, 'boom')).toBe(false);
    expect(await transitionToolJob(id, ['queued', 'running'], { status: 'completed', progress: 100 })).toBeNull();

    const stored = await getToolJob(id);
    expect(stored?.status).toBe('cancelled');
    expect(stored?.result).toBeUndefined();
    expect(stored?.error).toBeUndefined();

    // Empty entries array written via cjson must normalize back to [] on read
    const emptyId = `tool_redis_empty_${crypto.randomBytes(6).toString('hex')}`;
    createdIds.push(emptyId);
    await saveToolJob({
      id: emptyId,
      userId,
      tool: 'archive-extract',
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    });
    expect(await startToolJob(emptyId, 25)).toBe(true);
    expect(await completeToolJob(emptyId, { kind: 'entries', entries: [] })).toBe(true);
    const loadedEmpty = await getToolJob(emptyId);
    expect(loadedEmpty?.result).toEqual({ kind: 'entries', entries: [] });
  });

  it('resolves concurrent cancelToolJob vs completeToolJob atomically in Redis without state corruption', async () => {
    for (let i = 0; i < 8; i += 1) {
      const id = `tool_redis_race_${i}_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `user_redis_race_${i}`;
      createdIds.push(id);
      createdUsers.push(userId);

      await saveToolJob({
        id,
        userId,
        tool: 'merge',
        status: 'queued',
        progress: 0,
        createdAt: Date.now(),
      });
      await startToolJob(id, 25);

      const secondClient = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
      try {
        const resultPayload = {
          kind: 'file' as const,
          file: { name: 'out.pdf', size: 10, key: `conversions/${userId}/out.pdf`, url: '/out' },
        };
        const [cancelRes, completedOk] = await Promise.all([
          cancelToolJob(id),
          (async () => {
            redisKeyStore.setRedisClient(secondClient);
            return completeToolJob(id, resultPayload);
          })(),
        ]);

        const finalState = await getToolJob(id);
        expect(finalState).not.toBeNull();
        if (completedOk) {
          expect(finalState?.status).toBe('completed');
          expect(finalState?.result).toEqual(resultPayload);
          expect(['completed', 'cancelled']).toContain(cancelRes?.status);
        } else {
          expect(finalState?.status).toBe('cancelled');
          expect(finalState?.result).toBeUndefined();
          expect(cancelRes?.status).toBe('cancelled');
        }
      } finally {
        redisKeyStore.setRedisClient(testClient);
        await secondClient.quit();
      }
    }

    expect(await cancelToolJob(`missing_${crypto.randomUUID()}`)).toBeNull();
  });
});
