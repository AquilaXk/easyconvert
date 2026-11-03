import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eraseAccount, planAccountErasure } from '../scripts/erase-account';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { keyStore } from '../src/lib/api-keys/key-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { enqueueConversionJob } from '../src/lib/queue/enqueue';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import type { WebhookDlqEntry } from '../src/lib/api-keys/types';

/**
 * The account erasure the runbook runs on a deletion request (scripts/erase-account.ts), against the in-process stores and
 * queue: the plan lists every family of records of one account and changes nothing, and the erasure removes them all and
 * nothing of another account.
 */

async function accountWithRecords(label: string) {
  const user = await redisUserStore.createUser({ email: `${label}_${crypto.randomUUID()}@erase.test`, name: label, acceptedTermsVersion: TERMS_VERSION });
  const { key } = await redisKeyStore.generateApiKey(user.id, `${label} key`, { acceptedTermsVersion: TERMS_VERSION });
  await redisKeyStore.deductQuota(user.id, 2);
  const job = await enqueueConversionJob(
    conversionQueue,
    'convert',
    { jobId: '', originalFilename: `${label}.csv`, sourceFormat: 'csv', targetFormat: 'json', fileSize: 4, options: {}, userId: user.id },
    { attempts: 1 },
    { tier: 'free', inputBytes: 4 }
  );
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
  await webhookDispatcher.saveToDlq(letter);
  return { user, keyId: key.id, jobId: job.id };
}

describe('erasing one account', () => {
  beforeEach(() => {
    redisUserStore.resetStore();
    keyStore.resetStore();
  });

  afterEach(async () => {
    for (const job of await conversionQueue.getJobs(['waiting', 'cancelled'])) await conversionQueue.remove(job.id);
  });

  it('lists every family of records of the account and deletes none of them in the plan', async () => {
    const { user, keyId, jobId } = await accountWithRecords('planned');

    const plan = await planAccountErasure(user.email);
    expect(plan).toMatchObject({ userId: user.id, email: user.email, apiKeyIds: [keyId], jobs: [{ id: jobId, state: 'waiting' }], deadLetters: 1 });

    expect(await redisUserStore.findById(user.id)).not.toBeNull();
    expect((await conversionQueue.getJob(jobId))?.state).toBe('waiting');
    expect(await redisKeyStore.listApiKeys(user.id)).toHaveLength(1);
    expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(2);
  });

  it('deletes the account, its keys, jobs, dead letters and counts, and nothing of another account', async () => {
    const erased = await accountWithRecords('erased');
    const kept = await accountWithRecords('kept');

    const plan = await planAccountErasure(erased.user.id);
    expect(await eraseAccount(plan!)).toEqual({ runningJobIds: [] });

    expect(await redisUserStore.findById(erased.user.id)).toBeNull();
    expect(await redisUserStore.findByEmail(erased.user.email)).toBeNull();
    expect(await redisKeyStore.listApiKeys(erased.user.id)).toEqual([]);
    expect(await conversionQueue.getJob(erased.jobId)).toBeUndefined();
    expect(await conversionQueue.getJobsByUser(erased.user.id)).toEqual([]);
    expect(await webhookDispatcher.getDlqEntries(erased.user.id)).toEqual([]);
    expect((await redisKeyStore.getQuotaUsage(erased.user.id)).usedToday).toBe(0);
    expect(await planAccountErasure(erased.user.id)).toBeUndefined();

    expect(await redisUserStore.findById(kept.user.id)).not.toBeNull();
    expect((await redisKeyStore.listApiKeys(kept.user.id)).map((key) => key.id)).toEqual([kept.keyId]);
    expect((await conversionQueue.getJob(kept.jobId))?.state).toBe('waiting');
    expect(await webhookDispatcher.getDlqEntries(kept.user.id)).toHaveLength(1);
    expect((await redisKeyStore.getQuotaUsage(kept.user.id)).usedToday).toBe(2);
    await webhookDispatcher.clearDlq(kept.user.id);
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
