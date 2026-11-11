import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eraseAccount, planAccountErasure } from '../scripts/erase-account';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { RedisKeyStore, redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { keyStore } from '../src/lib/api-keys/key-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { conversionQueue, resourceQueues } from '../src/lib/queue/conversion-queue';
import { enqueueConversionJob } from '../src/lib/queue/enqueue';
import { graphScheduler } from '../src/lib/queue/graph/scheduler';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import { storageProvider } from '../src/lib/storage';
import { credentialsVault } from '../src/lib/storage/credentials-vault';
import { getRetentionLedger } from '../src/lib/storage/retention-ledger';
import { deleteResult, registerCompletedUpload, saveRetainedResult } from '../src/lib/storage/retention-service';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import { consumeAuthToken, issueAuthToken } from '../src/lib/auth/auth-email-token-store';
import type { WebhookDlqEntry } from '../src/lib/api-keys/types';

const createdUsers: string[] = [];

async function accountWithRecords(label: string) {
  const user = await redisUserStore.createUser({ email: `${label}_${crypto.randomUUID()}@erase.test`, name: label, acceptedTermsVersion: TERMS_VERSION });
  createdUsers.push(user.id);
  const { key } = await redisKeyStore.generateApiKey(user.id, `${label} key`, { acceptedTermsVersion: TERMS_VERSION });
  await redisKeyStore.checkTokenBucketRateLimit(`apikey:${key.id}`, { capacity: 1, refillRate: 0, cost: 1 });
  await redisKeyStore.deductQuota(user.id, 2);
  await redisKeyStore.recordUserFile({
    userId: user.id,
    fileName: `${label}.json`,
    fromFormat: 'csv',
    toFormat: 'json',
    size: 4,
    downloadUrl: `/api/storage/file/conversions%2F${user.id}%2F${label}.json`,
    storageKey: `conversions/${user.id}/${label}.json`,
  });
  const credentialId = await credentialsVault.store(user.id, { type: 'http', url: 'https://93.184.215.14/out' });
  const realNow = Date.now();
  const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow - 120_000);
  let expiredCredentialId: string;
  try {
    expiredCredentialId = await credentialsVault.store(
      user.id,
      { type: 'http', url: 'https://93.184.215.14/expired' },
      { ttlSeconds: 60 }
    );
  } finally {
    nowSpy.mockRestore();
  }
  const credentialIds = [credentialId, expiredCredentialId].sort();
  const job = await enqueueConversionJob(
    conversionQueue,
    'convert',
    { jobId: '', originalFilename: `${label}.csv`, sourceFormat: 'csv', targetFormat: 'json', fileSize: 4, options: {}, userId: user.id },
    { attempts: 1 },
    { tier: 'free', inputBytes: 4 }
  );
  await resourceQueues.light.moveToDlq?.(job, 'failed');
  const uploadKey = `conversions/${user.id}/${label}.csv`;
  const graphId = `job_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  await graphScheduler.initGraph(
    graphId,
    sealGraph(graphId, {
      nodes: {
        upload: {
          op: 'import.upload',
          storageKey: uploadKey,
        },
        convert: {
          op: 'convert',
          input: 'upload',
          targetFormat: 'json',
        },
      },
    }),
    { ownerUserId: user.id }
  );
  await storageProvider.saveObject(uploadKey, Buffer.from('a\n1\n'), 'text/csv', `${label}.csv`);
  await registerCompletedUpload(storageProvider, uploadKey);
  const resultKey = `results/${job.id}/0/${label}.json`;
  await saveRetainedResult(storageProvider, resultKey, Buffer.from('[{"a":1}]'), 'application/json', `${label}.json`);
  const graphResultKey = `results/${graphId}/convert/0/${label}.json`;
  await saveRetainedResult(storageProvider, graphResultKey, Buffer.from('[{"a":1}]'), 'application/json', `${label}.json`);
  const goneKey = `conversions/${user.id}/${label}-gone.csv`;
  await saveRetainedResult(storageProvider, goneKey, Buffer.from('gone'), 'text/csv', 'gone.csv');
  await getRetentionLedger().update(goneKey, (current) => current && { ...current, deleteAt: 1 });
  await deleteResult(storageProvider, goneKey);
  const storedKeys = [goneKey, uploadKey, graphResultKey, resultKey].sort();
  const letter: WebhookDlqEntry = {
    id: `dlq_${label}_${crypto.randomBytes(4).toString('hex')}`,
    originalDeliveryId: `wh_${label}`,
    targetUrl: 'https://93.184.215.14/hook',
    event: 'job.failed',
    payload: { jobId: job.id },
    secret: 'whsec_letter',
    failedAt: Date.now(),
    retryCount: 1,
    status: 'failed',
    ownerUserId: user.id,
  };
  const expiredLetter: WebhookDlqEntry = {
    ...letter,
    id: `dlq_${label}_expired_${crypto.randomBytes(4).toString('hex')}`,
    failedAt: 1,
  };
  await webhookDispatcher.saveToDlq(letter);
  await webhookDispatcher.saveToDlq(expiredLetter);
  return { user, keyId: key.id, credentialId, credentialIds, jobId: job.id, graphId, storedKeys, expiredLetterId: expiredLetter.id };
}

describe('erasing one account', () => {
  beforeEach(() => {
    redisUserStore.resetStore();
    keyStore.resetStore();
    credentialsVault.clear();
  });

  afterEach(async () => {
    for (const userId of createdUsers.splice(0)) {
      const plan = await planAccountErasure(userId);
      if (plan) await eraseAccount(plan);
    }
  });

  it('lists every family of records of the account and deletes none of them in the plan', async () => {
    const { user, keyId, credentialId, credentialIds, jobId, graphId, storedKeys } = await accountWithRecords('planned');
    expect((await credentialsVault.list(user.id)).map((c) => c.id)).toEqual([credentialId]);
    expect(await credentialsVault.listByUser(user.id)).toEqual(credentialIds);

    const plan = await planAccountErasure(user.email);
    expect(plan).toMatchObject({
      userId: user.id,
      email: user.email,
      apiKeyIds: [keyId],
      credentialIds,
      graphIds: [graphId],
      storedKeys,
      deadLetters: 2,
    });
    expect(plan!.jobs.map((job) => job.id)).toEqual(expect.arrayContaining([jobId, `${graphId}:upload`]));

    expect(await redisUserStore.findById(user.id)).not.toBeNull();
    expect((await conversionQueue.getJob(jobId))?.state).toBe('waiting');
    expect(await redisKeyStore.listApiKeys(user.id)).toHaveLength(1);
    expect(await credentialsVault.listByUser(user.id)).toEqual(credentialIds);
    expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(2);
    await eraseAccount(plan!);
  });

  it('deletes the account, its keys, jobs, dead letters and counts, and nothing of another account', async () => {
    const erased = await accountWithRecords('erased');
    const kept = await accountWithRecords('kept');

    const plan = await planAccountErasure(erased.user.id);
    expect(await eraseAccount(plan!)).toEqual({ runningJobIds: [] });

    expect(await redisUserStore.findById(erased.user.id)).toBeNull();
    expect(await redisUserStore.findByEmail(erased.user.email)).toBeNull();
    expect(await redisKeyStore.listApiKeys(erased.user.id)).toEqual([]);
    expect((await redisKeyStore.checkTokenBucketRateLimit(`apikey:${erased.keyId}`, { capacity: 1, refillRate: 0, cost: 1 })).allowed).toBe(true);
    expect(await redisKeyStore.listUserFiles(erased.user.id)).toEqual([]);
    expect(await credentialsVault.listByUser(erased.user.id)).toEqual([]);
    expect(await conversionQueue.getJob(erased.jobId)).toBeUndefined();
    expect(await conversionQueue.getJobsByUser(erased.user.id)).toEqual([]);
    expect(await graphScheduler.getGraphState(erased.graphId)).toBeUndefined();
    expect((await resourceQueues.light.getDlqEntries?.())?.some((entry) => entry.jobId === erased.jobId)).toBe(false);
    for (const key of erased.storedKeys) {
      expect(await storageProvider.getObject(key)).toBeUndefined();
      expect(await getRetentionLedger().get(key)).toBeUndefined();
    }
    expect(await webhookDispatcher.getDlqEntries(erased.user.id, { includeExpired: true })).toEqual([]);
    expect((await redisKeyStore.getQuotaUsage(erased.user.id)).usedToday).toBe(0);
    expect(await planAccountErasure(erased.user.id)).toBeUndefined();

    expect(await redisUserStore.findById(kept.user.id)).not.toBeNull();
    expect((await redisKeyStore.listApiKeys(kept.user.id)).map((key) => key.id)).toEqual([kept.keyId]);
    expect((await redisKeyStore.checkTokenBucketRateLimit(`apikey:${kept.keyId}`, { capacity: 1, refillRate: 0, cost: 1 })).allowed).toBe(false);
    expect(await redisKeyStore.listUserFiles(kept.user.id)).toHaveLength(1);
    expect((await credentialsVault.list(kept.user.id)).map((c) => c.id)).toEqual([kept.credentialId]);
    expect(await credentialsVault.listByUser(kept.user.id)).toEqual(kept.credentialIds);
    expect((await conversionQueue.getJob(kept.jobId))?.state).toBe('waiting');
    expect((await graphScheduler.getGraphState(kept.graphId))?.status).toBe('running');
    expect((await resourceQueues.light.getDlqEntries?.())?.some((entry) => entry.jobId === kept.jobId)).toBe(true);
    expect(await webhookDispatcher.getDlqEntries(kept.user.id)).toHaveLength(1);
    expect(await webhookDispatcher.getDlqEntries(kept.user.id, { includeExpired: true })).toHaveLength(2);
    expect(await webhookDispatcher.purgeExpiredDlqEntries()).toBe(1);
    expect((await redisKeyStore.getQuotaUsage(kept.user.id)).usedToday).toBe(2);
    await eraseAccount((await planAccountErasure(kept.user.id))!);
  });

  // skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
  it.skipIf(!process.env.REDIS_URL)('deletes the Redis keys tagged with the account id, its counts among them', async () => {
    const { user } = await accountWithRecords('tagged');
    const plan = await planAccountErasure(user.id);
    expect(plan!.taggedKeys.some((key) => key.includes(`usage:{${user.id}}`))).toBe(true);
    expect(plan!.taggedKeys.some((key) => key.includes(`user_files:{${user.id}}`))).toBe(true);
    expect(plan!.taggedKeys.some((key) => key.includes(`user_file:{${user.id}}:`))).toBe(true);
    expect(plan!.taggedKeys.some((key) => key.includes(`webhook:dlq:owner:{${user.id}}`))).toBe(true);
    expect(plan!.taggedKeys.some((key) => key.includes(`vault:user:{${user.id}}`))).toBe(true);

    await eraseAccount(plan!);
    const client = redisKeyStore.getRedisClient()!;
    expect(await Promise.all(plan!.taggedKeys.map((key) => client.exists(key)))).toEqual(plan!.taggedKeys.map(() => 0));
  });

  it('deletes the password reset and email verification tokens of the account and not those of another', async () => {
    const { user } = await accountWithRecords('mailed');
    const other = await accountWithRecords('other');
    const subject = (record: { id: string; email: string }) => ({ userId: record.id, email: record.email });
    const resetToken = await issueAuthToken('reset', subject(user));
    const verifyToken = await issueAuthToken('verify', subject(user));
    const keptToken = await issueAuthToken('reset', subject(other.user));

    await eraseAccount((await planAccountErasure(user.id))!);

    expect(await consumeAuthToken('reset', resetToken)).toBeNull();
    expect(await consumeAuthToken('verify', verifyToken)).toBeNull();
    expect(await consumeAuthToken('reset', keptToken)).toEqual(subject(other.user));
    await eraseAccount((await planAccountErasure(other.user.id))!);
  });

  it('answers no plan for an account that does not exist', async () => {
    expect(await planAccountErasure('nobody@erase.test')).toBeUndefined();
  });

  it('deletes a key in Redis only for its owner, even when the key is not in local memory', async () => {
    const hashes = new Map<string, Record<string, string>>();
    const sets = new Map<string, Set<string>>();
    const client = {
      hset: async (key: string, fieldOrMap: string | Record<string, string>, value?: string) => {
        const entry = hashes.get(key) ?? {};
        if (typeof fieldOrMap === 'string') entry[fieldOrMap] = value ?? '';
        else Object.assign(entry, fieldOrMap);
        hashes.set(key, entry);
        return 1;
      },
      hgetall: async (key: string) => ({ ...(hashes.get(key) ?? {}) }),
      hdel: async (key: string, field: string) => {
        const entry = hashes.get(key);
        if (!entry || !(field in entry)) return 0;
        delete entry[field];
        return 1;
      },
      sadd: async (key: string, member: string) => {
        const set = sets.get(key) ?? new Set<string>();
        set.add(member);
        sets.set(key, set);
        return 1;
      },
      srem: async (key: string, member: string) => {
        const set = sets.get(key);
        return set?.delete(member) ? 1 : 0;
      },
      del: async (...keys: string[]) => {
        let removed = 0;
        for (const key of keys) {
          if (hashes.delete(key)) removed++;
          if (sets.delete(key)) removed++;
        }
        return removed;
      },
    };

    const writer = new RedisKeyStore({ keyPrefix: 'test:', isolated: true, redisClient: client as never });
    const reader = new RedisKeyStore({ keyPrefix: 'test:', isolated: true });
    await reader.close();

    const { key: localKey } = await writer.generateApiKey('owner_1', 'local', { acceptedTermsVersion: TERMS_VERSION });
    hashes.delete(`test:apikeys:${localKey.id}`);
    hashes.set(`test:rate:apikey:${localKey.id}`, { tokens: '0' });
    writer.setRedisClient(null);
    await writer.checkTokenBucketRateLimit(`apikey:${localKey.id}`, { capacity: 1, refillRate: 0, cost: 1 });
    writer.setRedisClient(client as never);

    expect(await writer.deleteApiKey('other_user', localKey.id)).toBe(false);
    expect(hashes.has(`test:rate:apikey:${localKey.id}`)).toBe(true);
    writer.setRedisClient(null);
    expect((await writer.checkTokenBucketRateLimit(`apikey:${localKey.id}`, { capacity: 1, refillRate: 0, cost: 1 })).allowed).toBe(false);
    writer.setRedisClient(client as never);

    const { key: remoteKey } = await writer.generateApiKey('owner_1', 'remote', { acceptedTermsVersion: TERMS_VERSION });
    hashes.set(`test:rate:apikey:${remoteKey.id}`, { tokens: '0' });
    hashes.set('test:rate:apikey:missing_key', { tokens: '0' });

    await reader.checkTokenBucketRateLimit(`apikey:${remoteKey.id}`, { capacity: 1, refillRate: 0, cost: 1 });
    await reader.checkTokenBucketRateLimit('apikey:missing_key', { capacity: 1, refillRate: 0, cost: 1 });
    reader.setRedisClient(client as never);

    expect(await reader.deleteApiKey('other_user', 'missing_key')).toBe(false);
    expect(hashes.has('test:rate:apikey:missing_key')).toBe(true);
    expect(await reader.deleteApiKey('other_user', remoteKey.id)).toBe(false);
    expect(hashes.has(`test:apikeys:${remoteKey.id}`)).toBe(true);
    expect(hashes.has(`test:rate:apikey:${remoteKey.id}`)).toBe(true);
    expect(sets.get('test:user_keys:owner_1')?.has(remoteKey.id)).toBe(true);

    reader.setRedisClient(null);
    expect((await reader.checkTokenBucketRateLimit('apikey:missing_key', { capacity: 1, refillRate: 0, cost: 1 })).allowed).toBe(false);
    expect((await reader.checkTokenBucketRateLimit(`apikey:${remoteKey.id}`, { capacity: 1, refillRate: 0, cost: 1 })).allowed).toBe(false);

    reader.setRedisClient(client as never);
    expect(await reader.deleteApiKey('owner_1', remoteKey.id)).toBe(true);
    expect(hashes.has(`test:apikeys:${remoteKey.id}`)).toBe(false);
    expect(hashes.has(`test:rate:apikey:${remoteKey.id}`)).toBe(false);
    expect(sets.get('test:user_keys:owner_1')?.has(remoteKey.id)).toBe(false);
    expect(hashes.get('test:apikey_hashes')?.[remoteKey.keyHash]).toBeUndefined();

    reader.setRedisClient(null);
    expect((await reader.checkTokenBucketRateLimit(`apikey:${remoteKey.id}`, { capacity: 1, refillRate: 0, cost: 1 })).allowed).toBe(true);
  });
});
