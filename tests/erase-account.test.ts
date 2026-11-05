import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eraseAccount, planAccountErasure } from '../scripts/erase-account';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
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
  return { user, keyId: key.id, credentialId, jobId: job.id, graphId, storedKeys, expiredLetterId: expiredLetter.id };
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
    const { user, keyId, credentialId, jobId, graphId, storedKeys } = await accountWithRecords('planned');

    const plan = await planAccountErasure(user.email);
    expect(plan).toMatchObject({
      userId: user.id,
      email: user.email,
      apiKeyIds: [keyId],
      credentialIds: [credentialId],
      graphIds: [graphId],
      storedKeys,
      deadLetters: 2,
    });
    expect(plan!.jobs.map((job) => job.id)).toEqual(expect.arrayContaining([jobId, `${graphId}:upload`]));

    expect(await redisUserStore.findById(user.id)).not.toBeNull();
    expect((await conversionQueue.getJob(jobId))?.state).toBe('waiting');
    expect(await redisKeyStore.listApiKeys(user.id)).toHaveLength(1);
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
    expect(await credentialsVault.listByUser(kept.user.id)).toEqual([kept.credentialId]);
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

    await eraseAccount(plan!);
    const client = redisKeyStore.getRedisClient()!;
    expect(await Promise.all(plan!.taggedKeys.map((key) => client.exists(key)))).toEqual(plan!.taggedKeys.map(() => 0));
  });

  it('answers no plan for an account that does not exist', async () => {
    expect(await planAccountErasure('nobody@erase.test')).toBeUndefined();
  });
});
